import { describe, expect, test } from "bun:test"
import { createKiroFetch } from "../src/fetch-adapter.js"
import { ModelCache } from "../src/model-cache.js"
import { ModelResolver } from "../src/model-resolver.js"
import { toKiroGenerateRequest, type OpenAIChatRequest } from "../src/request-adapter.js"
import { toOpenAIChatResponse } from "../src/response-adapter.js"

function resolver(): ModelResolver {
  const cache = new ModelCache(60)
  cache.update([{ id: "claude-sonnet-4.6" }])
  return new ModelResolver({ cache })
}

const request: OpenAIChatRequest = {
  model: "claude-sonnet-4-6",
  messages: [
    { role: "system", content: "You are concise." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi" },
    { role: "tool", tool_call_id: "call-1", name: "read_file", content: "file contents" },
    { role: "user", content: [{ type: "text", text: "Write code" }] },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    },
  ],
}

describe("request adapter", () => {
  test("converts OpenAI-compatible request to text-only Kiro request", () => {
    expect(toKiroGenerateRequest(request, resolver())).toEqual({
      modelId: "claude-sonnet-4.6",
      system: "You are concise.",
      prompt: "Write code",
      history: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "tool", content: "file contents" },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
      toolResults: [
        {
          toolUseId: "call-1",
          toolName: "read_file",
          content: "file contents",
        },
      ],
      stream: false,
      metadata: {
        originalModel: "claude-sonnet-4-6",
        normalizedModel: "claude-sonnet-4.6",
        modelSource: "cache",
        hasTools: true,
      },
    })
  })
})

describe("response adapter", () => {
  test("converts Kiro text response to OpenAI chat response shape", async () => {
    const response = toOpenAIChatResponse(
      { text: "done", modelId: "claude-sonnet-4.6", usage: { inputTokens: 3, outputTokens: 5 } },
      "claude-sonnet-4.6",
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.model).toBe("claude-sonnet-4.6")
    expect(body.choices[0].message.content).toBe("done")
    expect(body.usage.total_tokens).toBe(8)
  })
})

describe("createKiroFetch", () => {
  test("calls injected transport and returns OpenAI-compatible response", async () => {
    const seen: unknown[] = []
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: {
        async generate(input) {
          seen.push(input)
          return { text: `received ${input.modelId}` }
        },
      },
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify(request),
    })
    const body = await response.json()

    expect(seen).toHaveLength(1)
    expect(body.choices[0].message.content).toBe("received claude-sonnet-4.6")
  })

  test("returns OpenAI-compatible SSE when stream is requested", async () => {
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: {
        async generate() {
          throw new Error("generate should not be called for streaming")
        },
        async *stream() {
          yield { text: "hel", modelId: "claude-sonnet-4.6" }
          yield { text: "lo" }
        },
      },
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true }),
    })
    const body = await response.text()

    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(body).toContain('"object":"chat.completion.chunk"')
    expect(body).toContain('"content":"hel"')
    expect(body).toContain("data: [DONE]")
  })

  test("returns structured error when transport is not configured", async () => {
    const fetch = createKiroFetch({ resolver: resolver() })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify(request),
    })
    const body = await response.json()

    expect(response.status).toBe(501)
    expect(body.error.code).toBe("UNSUPPORTED_BACKEND")
  })
})
