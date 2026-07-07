import { describe, expect, test } from "bun:test"
import { createKiroFetch } from "../src/fetch-adapter.js"
import { acpPermissionResponse, KiroAcpTransport, type AcpSessionClient } from "../src/acp-transport.js"
import type { AcpNotificationHandler } from "../src/acp-client.js"
import { ModelCache } from "../src/model-cache.js"
import { ModelResolver } from "../src/model-resolver.js"

function resolver(): ModelResolver {
  const cache = new ModelCache(60)
  cache.update([{ id: "claude-sonnet-4.6" }, { id: "auto" }])
  return new ModelResolver({ cache })
}

class FakeAcpClient implements AcpSessionClient {
  readonly requests: Array<{ method: string; params?: unknown }> = []
  readonly handlers = new Set<AcpNotificationHandler>()
  closed = false
  readonly updates: ReadonlyArray<unknown>
  readonly notificationMethod: "session/notification" | "session/update"

  constructor(
    updates: ReadonlyArray<unknown> = [
      { update: { type: "AgentMessageChunk", content: { type: "text", text: "hello " } } },
      { update: { type: "AgentMessageChunk", content: "world" } },
      { update: { type: "TurnEnd" } },
    ],
    notificationMethod: "session/notification" | "session/update" = "session/notification",
  ) {
    this.updates = updates
    this.notificationMethod = notificationMethod
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push(params === undefined ? { method } : { method, params })
    if (method === "session/new") return { sessionId: "session-1" }
    if (method === "session/prompt") {
      for (const update of this.updates) this.notify(update)
    }
    return {}
  }

  onNotification(handler: AcpNotificationHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  close(): void {
    this.closed = true
  }

  notify(params: unknown): void {
    for (const handler of this.handlers) {
      handler({ jsonrpc: "2.0", method: this.notificationMethod, params })
    }
  }
}

describe("Kiro ACP transport", () => {
  test("selects reject permission option by default and allow option when trusted", () => {
    const params = {
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "reject", kind: "reject_once" },
      ],
    }

    expect(acpPermissionResponse(params)).toEqual({ outcome: { outcome: "selected", optionId: "reject" } })
    expect(acpPermissionResponse(params, true)).toEqual({ outcome: { outcome: "selected", optionId: "allow" } })
  })

  test("runs initialize, session, model selection, prompt, and collects assistant chunks", async () => {
    const client = new FakeAcpClient()
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: new KiroAcpTransport({ client, cwd: "/tmp/project", promptTimeoutMs: 100 }),
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Previous question" },
          { role: "assistant", content: "Previous answer" },
          { role: "user", content: "Say hello" },
        ],
      }),
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.choices[0].message.content).toBe("hello world")
    expect(client.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_model",
      "session/prompt",
    ])
    expect(client.requests[2]?.params).toEqual({ sessionId: "session-1", model: "claude-sonnet-4.6" })
    expect(JSON.stringify(client.requests[3]?.params)).toContain("System:\\nBe concise.")
    expect(JSON.stringify(client.requests[3]?.params)).toContain("user:\\nSay hello")
    expect(client.closed).toBe(false)
  })

  test("skips model selection for auto model", async () => {
    const client = new FakeAcpClient()
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: new KiroAcpTransport({ client, promptTimeoutMs: 100 }),
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(client.requests.map((request) => request.method)).toEqual(["initialize", "session/new", "session/prompt"])
  })

  test("streams ACP assistant chunks as OpenAI-compatible SSE", async () => {
    const client = new FakeAcpClient()
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: new KiroAcpTransport({ client, promptTimeoutMs: 100 }),
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    })
    const body = await response.text()

    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(body).toContain('"content":"hello "')
    expect(body).toContain('"content":"world"')
    expect(body).toContain("data: [DONE]")
  })

  test("cancels ACP session when stream consumer stops before TurnEnd", async () => {
    const client = new FakeAcpClient([{ update: { type: "AgentMessageChunk", content: "partial" } }])
    const transport = new KiroAcpTransport({ client, promptTimeoutMs: 100 })

    for await (const chunk of transport.stream({
      modelId: "claude-sonnet-4.6",
      prompt: "hello",
      history: [],
      tools: [],
      toolResults: [],
      images: [],
      documents: [],
      stream: true,
      metadata: {
        originalModel: "claude-sonnet-4-6",
        normalizedModel: "claude-sonnet-4.6",
        modelSource: "cache",
        hasTools: false,
      },
    })) {
      expect(chunk).toEqual({ type: "text", text: "partial", modelId: "claude-sonnet-4.6" })
      break
    }

    expect(client.requests.at(-1)).toEqual({ method: "session/cancel", params: { sessionId: "session-1" } })
  })

  test("streams Kiro ACP ToolCall notifications as OpenAI-compatible tool calls", async () => {
    const client = new FakeAcpClient([
      {
        update: {
          type: "ToolCall",
          toolCallId: "call-1",
          name: "read_file",
          parameters: { path: "README.md" },
        },
      },
      { update: { type: "TurnEnd" } },
    ])
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: new KiroAcpTransport({ client, promptTimeoutMs: 100 }),
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "read README" }],
        stream: true,
      }),
    })
    const body = await response.text()

    expect(body).toContain('"tool_calls"')
    expect(body).toContain('"id":"call-1"')
    expect(body).toContain('"name":"read_file"')
    expect(body).toContain('\\"README.md\\"')
  })

  test("returns ACP tool calls in non-streaming responses", async () => {
    const client = new FakeAcpClient([
      {
        update: {
          type: "ToolCall",
          toolCallId: "call-1",
          name: "read_file",
          parameters: { path: "README.md" },
        },
      },
      { update: { type: "TurnEnd" } },
    ])
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: new KiroAcpTransport({ client, promptTimeoutMs: 100 }),
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "read README" }],
      }),
    })
    const body = await response.json()

    expect(body.choices[0].message.content).toBeNull()
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({
      id: "call-1",
      type: "function",
      function: {
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
    })
    expect(body.choices[0].finish_reason).toBe("tool_calls")
  })

  test("ignores ACP tool progress updates without invocation payload", async () => {
    const client = new FakeAcpClient([
      {
        update: {
          type: "ToolCall",
          toolCallId: "call-1",
          name: "read_file",
          parameters: { path: "README.md" },
        },
      },
      {
        update: {
          type: "ToolCallUpdate",
          toolCallId: "call-1",
          status: "running",
          content: "Reading README.md",
        },
      },
      {
        update: {
          type: "ToolCallUpdate",
          toolCallId: "call-1",
          status: "completed",
          result: { bytesRead: 42 },
        },
      },
      { update: { type: "TurnEnd" } },
    ])
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: new KiroAcpTransport({ client, promptTimeoutMs: 100 }),
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "read README" }],
        stream: true,
      }),
    })
    const body = await response.text()

    expect(body.match(/"id":"call-1"/g)?.length).toBe(1)
    expect(body).toContain('"id":"call-1"')
    expect(body).toContain('"name":"read_file"')
    expect(body).not.toContain('"name":"tool"')
    expect(body).not.toContain('"arguments":"{}"')
  })

  test("deduplicates ACP tool call updates in non-streaming responses", async () => {
    const client = new FakeAcpClient([
      {
        update: {
          type: "ToolCall",
          toolCallId: "call-1",
          name: "read_file",
          parameters: { path: "README.md" },
        },
      },
      {
        update: {
          type: "ToolCallUpdate",
          toolCallId: "call-1",
          name: "read_file",
          parameters: { path: "CHANGELOG.md" },
        },
      },
      { update: { type: "TurnEnd" } },
    ])
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: new KiroAcpTransport({ client, promptTimeoutMs: 100 }),
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "read README" }],
      }),
    })
    const body = await response.json()

    expect(body.choices[0].message.tool_calls).toHaveLength(1)
    expect(body.choices[0].message.tool_calls[0].function).toEqual({
      name: "read_file",
      arguments: '{"path":"CHANGELOG.md"}',
    })
  })

  test("streams standard ACP session/update tool_call notifications", async () => {
    const client = new FakeAcpClient(
      [
        {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-2",
            title: "Run tests",
            kind: "execute",
            rawInput: { command: "npm test" },
          },
        },
        { update: { type: "TurnEnd" } },
      ],
      "session/update",
    )
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: new KiroAcpTransport({ client, promptTimeoutMs: 100 }),
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "test" }],
        stream: true,
      }),
    })
    const body = await response.text()

    expect(body).toContain('"id":"call-2"')
    expect(body).toContain('"name":"execute"')
    expect(body).toContain('\\"npm test\\"')
  })

  test("passes OpenAI file inputs to ACP as embedded resources", async () => {
    const client = new FakeAcpClient()
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: new KiroAcpTransport({ client, promptTimeoutMs: 100 }),
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize attachments" },
              {
                type: "file",
                file: {
                  filename: "notes.txt",
                  file_data: "data:text/plain;base64,aGVsbG8=",
                },
              },
              {
                type: "file",
                file: {
                  filename: "spec.pdf",
                  file_data: "data:application/pdf;base64,cGRm",
                },
              },
            ],
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const promptParams = client.requests[3]?.params as { content?: Array<Record<string, any>> }
    expect(promptParams.content?.[1]).toEqual({
      type: "resource",
      resource: {
        uri: "attachment://notes.txt",
        mimeType: "text/plain",
        text: "hello",
      },
    })
    expect(promptParams.content?.[2]).toEqual({
      type: "resource",
      resource: {
        uri: "attachment://spec.pdf",
        mimeType: "application/pdf",
        blob: "cGRm",
      },
    })
  })
})
