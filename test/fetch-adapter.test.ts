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

function assistantTextFromSse(body: string): string {
  return body
    .split(/\n\n/)
    .map((event) => event.trim())
    .filter((event) => event.startsWith("data: "))
    .map((event) => event.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> })
    .map((item) => item.choices?.[0]?.delta?.content ?? "")
    .join("")
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
      toolResults: [],
      images: [],
      documents: [],
      modelOptions: {},
      stream: false,
      metadata: {
        originalModel: "claude-sonnet-4-6",
        normalizedModel: "claude-sonnet-4.6",
        modelSource: "cache",
        hasTools: true,
      },
    })
  })

  test("extracts data URL images and PDFs from current user message", () => {
    const mediaRequest: OpenAIChatRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe these" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
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
    }

    const converted = toKiroGenerateRequest(mediaRequest, resolver())

    expect(converted.prompt).toBe("Describe these")
    expect(converted.images).toHaveLength(1)
    expect(converted.images[0]?.format).toBe("png")
    expect(Array.from(converted.images[0]?.bytes ?? [])).toEqual([104, 101, 108, 108, 111])
    expect(converted.documents).toHaveLength(1)
    expect(converted.documents[0]?.name).toBe("spec.pdf")
    expect(converted.documents[0]?.format).toBe("pdf")
    expect(Array.from(converted.documents[0]?.bytes ?? [])).toEqual([112, 100, 102])
  })

  test("does not attach historical tool results after a new user turn", () => {
    const converted = toKiroGenerateRequest(
      {
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "Use tools" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "orphan", name: "read_file", content: "ignore" },
          { role: "tool", tool_call_id: "call-1", content: "old" },
          { role: "tool", tool_call_id: "call-1", content: "latest" },
          { role: "user", content: "continue" },
        ],
      },
      resolver(),
    )

    expect(converted.history).toEqual([
      { role: "user", content: "Use tools" },
      { role: "tool", content: "ignore" },
      { role: "tool", content: "old" },
      { role: "tool", content: "latest" },
    ])
    expect(converted.toolResults).toEqual([])
  })

  test("attaches only trailing tool results that match the previous assistant tool calls", () => {
    const converted = toKiroGenerateRequest(
      {
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "Use tools" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "orphan", name: "read_file", content: "ignore" },
          { role: "tool", tool_call_id: "call-1", content: "old" },
          { role: "tool", tool_call_id: "call-1", content: "latest" },
        ],
      },
      resolver(),
    )

    expect(converted.prompt).toBe("")
    expect(converted.history).toEqual([
      { role: "user", content: "Use tools" },
      {
        role: "assistant",
        content: "",
        toolUses: [
          {
            toolUseId: "call-1",
            name: "read_file",
            input: { path: "a" },
          },
        ],
      },
    ])
    expect(converted.toolResults).toEqual([
      {
        toolUseId: "call-1",
        toolName: "read_file",
        content: "latest",
      },
    ])
  })

  test("preserves supported model request options", () => {
    const converted = toKiroGenerateRequest(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Think carefully" }],
        temperature: 0.2,
        max_tokens: 1234.8,
        reasoning_effort: " high ",
      },
      resolver(),
    )

    expect(converted.modelOptions).toEqual({
      temperature: 0.2,
      maxTokens: 1234,
      reasoningEffort: "high",
    })
  })

  test("prefers max completion tokens and nested reasoning effort aliases", () => {
    const converted = toKiroGenerateRequest(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Think carefully" }],
        max_tokens: 100,
        max_completion_tokens: 200,
        reasoning: { effort: "medium" },
      },
      resolver(),
    )

    expect(converted.modelOptions).toEqual({
      maxTokens: 200,
      reasoningEffort: "medium",
    })
  })
})

describe("response adapter", () => {
  test("converts Kiro text response to OpenAI chat response shape", async () => {
    const response = toOpenAIChatResponse(
      { text: "done", reasoning: "thinking", modelId: "claude-sonnet-4.6", usage: { inputTokens: 3, outputTokens: 5 } },
      "claude-sonnet-4.6",
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.model).toBe("claude-sonnet-4.6")
    expect(body.choices[0].message.content).toBe("done")
    expect(body.choices[0].message.reasoning_content).toBe("thinking")
    expect(body.usage.total_tokens).toBe(8)
  })

  test("converts Kiro tool calls to non-streaming OpenAI chat response shape", async () => {
    const response = toOpenAIChatResponse(
      {
        text: "",
        modelId: "claude-sonnet-4.6",
        toolCalls: [
          {
            type: "tool_call",
            id: "call-1",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
        ],
      },
      "claude-sonnet-4.6",
    )
    const body = await response.json()

    expect(body.choices[0].message.content).toBeNull()
    expect(body.choices[0].message.tool_calls).toEqual([
      {
        index: 0,
        id: "call-1",
        type: "function",
        function: {
          name: "read_file",
          arguments: '{"path":"README.md"}',
        },
      },
    ])
    expect(body.choices[0].finish_reason).toBe("tool_calls")
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

  test("returns structured error for empty non-streaming transport responses", async () => {
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: {
        async generate() {
          return { text: "" }
        },
      },
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify(request),
    })
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body.error.code).toBe("KIRO_EMPTY_RESPONSE")
  })

  test("returns OpenAI-compatible SSE when stream is requested", async () => {
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: {
        async generate() {
          throw new Error("generate should not be called for streaming")
        },
        async *stream() {
          yield { type: "text" as const, text: "hel", modelId: "claude-sonnet-4.6" }
          yield { type: "text" as const, text: "lo" }
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
    expect(body).toContain('"role":"assistant"')
    expect(body).toContain('"content":"hel"')
    expect(body).toContain('"finish_reason":"stop"')
    expect(body).toContain("data: [DONE]")
  })

  test("streaming SSE reconstructs the final assistant response text", async () => {
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: {
        async generate() {
          throw new Error("generate should not be called for streaming")
        },
        async *stream() {
          yield { type: "text" as const, text: "The answer " }
          yield { type: "text" as const, text: "is 4." }
        },
      },
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true }),
    })
    const body = await response.text()

    expect(assistantTextFromSse(body)).toBe("The answer is 4.")
  })

  test("does not emit content chunks for usage-only stream events", async () => {
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: {
        async generate() {
          throw new Error("generate should not be called for streaming")
        },
        async *stream() {
          yield { type: "text" as const, text: "", usage: { inputTokens: 3, outputTokens: 5 } }
          yield { type: "text" as const, text: "done", modelId: "claude-sonnet-4.6" }
        },
      },
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true }),
    })
    const body = await response.text()

    expect(body).not.toContain('"content":""')
    expect(body).toContain('"content":"done"')
    expect(body).toContain('"finish_reason":"stop"')
  })

  test("returns structured SSE error for empty streaming transport responses", async () => {
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: {
        async generate() {
          throw new Error("generate should not be called for streaming")
        },
        async *stream() {},
      },
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true }),
    })
    const body = await response.text()

    expect(body).toContain('"code":"KIRO_EMPTY_RESPONSE"')
    expect(body).toContain("data: [DONE]")
  })

  test("streams reasoning deltas separately from content deltas", async () => {
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: {
        async generate() {
          throw new Error("generate should not be called for streaming")
        },
        async *stream() {
          yield { type: "reasoning" as const, text: "thinking", modelId: "claude-sonnet-4.6" }
          yield { type: "text" as const, text: "done", modelId: "claude-sonnet-4.6" }
        },
      },
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true }),
    })
    const body = await response.text()

    expect(body).toContain('"reasoning_content":"thinking"')
    expect(body).toContain('"content":"done"')
  })

  test("wraps non-streaming reasoning responses as SSE when stream is requested", async () => {
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: {
        async generate(input) {
          return { text: `received ${input.modelId}`, reasoning: "thinking", modelId: input.modelId }
        },
      },
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true }),
    })
    const body = await response.text()

    expect(body).toContain('"reasoning_content":"thinking"')
    expect(body).toContain('"content":"received claude-sonnet-4.6"')
  })

  test("wraps non-streaming transport responses as SSE when stream is requested", async () => {
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: {
        async generate(input) {
          return { text: `received ${input.modelId}`, modelId: input.modelId }
        },
      },
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true }),
    })
    const body = await response.text()

    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(body).toContain('"content":"received claude-sonnet-4.6"')
    expect(body).toContain('"finish_reason":"stop"')
    expect(body).toContain("data: [DONE]")
  })

  test("returns structured error for empty non-streaming responses before opening SSE", async () => {
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: {
        async generate() {
          return { text: "" }
        },
      },
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true }),
    })
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(body.error.code).toBe("KIRO_EMPTY_RESPONSE")
  })

  test("streams OpenAI-compatible tool-call deltas with tool-call finish reason", async () => {
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: {
        async generate() {
          throw new Error("generate should not be called for streaming")
        },
        async *stream() {
          yield {
            type: "tool_call" as const,
            id: "call-1",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          }
          yield {
            type: "tool_call" as const,
            id: "call-2",
            name: "write_file",
            arguments: '{"path":"CHANGELOG.md"}',
          }
        },
      },
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true }),
    })
    const body = await response.text()

    expect(body).toContain('"tool_calls"')
    expect(body).toContain('"index":0')
    expect(body).toContain('"id":"call-1"')
    expect(body).toContain('"name":"read_file"')
    expect(body).toContain('\\"README.md\\"')
    expect(body).toContain('"index":1')
    expect(body).toContain('"id":"call-2"')
    expect(body).toContain('"name":"write_file"')
    expect(body).toContain('"finish_reason":"tool_calls"')
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
