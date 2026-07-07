import { describe, expect, test } from "bun:test"
import type { ChatResponseStream } from "@aws/codewhisperer-streaming-client"
import {
  additionalModelRequestFields,
  CodeWhispererKiroTransport,
  collectAssistantText,
  streamAssistantText,
  toGenerateAssistantResponseInput,
  type CodeWhispererClientLike,
} from "../src/kiro-transport.js"
import type { KiroGenerateRequest } from "../src/request-adapter.js"

async function* events(items: ChatResponseStream[]): AsyncIterable<ChatResponseStream> {
  for (const item of items) yield item
}

const request: KiroGenerateRequest = {
  modelId: "claude-sonnet-4.6",
  system: "Be concise.",
  prompt: "user: Hello",
  history: [{ role: "assistant", content: "Previous answer" }],
  tools: [
    {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
  toolResults: [{ toolUseId: "call-1", toolName: "read_file", content: "file contents" }],
  images: [{ format: "png", bytes: Uint8Array.from([1, 2, 3]) }],
  documents: [{ name: "spec.pdf", format: "pdf", bytes: Uint8Array.from([4, 5]) }],
  modelOptions: {},
  stream: false,
  metadata: {
    originalModel: "claude-sonnet-4-6",
    normalizedModel: "claude-sonnet-4.6",
    modelSource: "cache",
    hasTools: false,
  },
}

describe("toGenerateAssistantResponseInput", () => {
  test("builds minimal GenerateAssistantResponse command input", () => {
    expect(toGenerateAssistantResponseInput(request, { profileArn: "arn:test" })).toMatchObject({
      profileArn: "arn:test",
      agentMode: "vibe",
      conversationState: {
        chatTriggerType: "MANUAL",
        history: [
          { userInputMessage: { content: "Be concise.", origin: "AI_EDITOR" } },
          { assistantResponseMessage: { content: "Previous answer" } },
        ],
        currentMessage: {
          userInputMessage: {
            content: "user: Hello",
            modelId: "claude-sonnet-4.6",
            origin: "AI_EDITOR",
            images: [{ format: "png", source: { bytes: Uint8Array.from([1, 2, 3]) } }],
            documents: [{ name: "spec.pdf", format: "pdf", source: { bytes: Uint8Array.from([4, 5]) } }],
            userInputMessageContext: {
              tools: [
                {
                  toolSpecification: {
                    name: "read_file",
                    description: "Read a file",
                    inputSchema: { json: { type: "object", properties: { path: { type: "string" } } } },
                  },
                },
              ],
              toolResults: [
                {
                  toolUseId: "call-1",
                  content: [{ text: "file contents" }],
                  status: "SUCCESS",
                  toolName: "read_file",
                },
              ],
            },
          },
        },
      },
    })
  })

  test("adds best-effort model request fields", () => {
    const input = toGenerateAssistantResponseInput({
      ...request,
      modelOptions: {
        temperature: 0.2,
        maxTokens: 2048,
        reasoningEffort: "high",
      },
    })

    expect(input.additionalModelRequestFields).toEqual({
      temperature: 0.2,
      max_tokens: 2048,
      output_config: {
        effort: "high",
      },
    })
  })
})

describe("additionalModelRequestFields", () => {
  test("returns undefined when no model options are present", () => {
    expect(additionalModelRequestFields(request)).toBeUndefined()
  })
})

describe("collectAssistantText", () => {
  test("combines assistant response chunks", async () => {
    const response = await collectAssistantText(
      events([
        { assistantResponseEvent: { content: "hel", modelId: "claude-sonnet-4.6" } },
        { assistantResponseEvent: { content: "lo" } },
      ]),
    )

    expect(response).toEqual({ text: "hello", modelId: "claude-sonnet-4.6" })
  })

  test("throws on stream error events", async () => {
    expect(
      collectAssistantText(events([{ error: { message: "quota exceeded" } } as ChatResponseStream])),
    ).rejects.toThrow("quota exceeded")
  })
})

describe("streamAssistantText", () => {
  test("yields assistant chunks as they arrive", async () => {
    const chunks = []
    for await (const chunk of streamAssistantText(
      events([
        { assistantResponseEvent: { content: "a", modelId: "claude-sonnet-4.6" } },
        { assistantResponseEvent: { content: "b" } },
      ]),
    )) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([{ type: "text", text: "a", modelId: "claude-sonnet-4.6" }, { type: "text", text: "b" }])
  })

  test("accumulates Kiro tool-use input chunks", async () => {
    const chunks = []
    for await (const chunk of streamAssistantText(
      events([
        { toolUseEvent: { toolUseId: "call-1", name: "read_file", input: '{"path"', stop: false } },
        { toolUseEvent: { toolUseId: "call-1", name: "read_file", input: ':"README.md"}', stop: true } },
      ]),
    )) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      {
        type: "tool_call",
        id: "call-1",
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
    ])
  })
})

describe("CodeWhispererKiroTransport", () => {
  test("sends GenerateAssistantResponseCommand through injected client", async () => {
    const sent: unknown[] = []
    const client: CodeWhispererClientLike = {
      async send(command) {
        sent.push((command as any).input)
        return {
          conversationId: "conversation",
          generateAssistantResponseResponse: events([
            { assistantResponseEvent: { content: "done", modelId: "claude-sonnet-4.6" } },
          ]),
          $metadata: {},
        }
      },
    }
    const transport = new CodeWhispererKiroTransport(
      { region: "us-east-1", accessToken: "token" },
      () => client,
    )

    const response = await transport.generate(request)

    expect(response).toEqual({ text: "done", modelId: "claude-sonnet-4.6" })
    expect(sent[0]).toMatchObject({
      agentMode: "vibe",
      conversationState: {
        history: [
          { userInputMessage: { content: "Be concise.", origin: "AI_EDITOR" } },
          { assistantResponseMessage: { content: "Previous answer" } },
        ],
        currentMessage: {
          userInputMessage: {
            modelId: "claude-sonnet-4.6",
          },
        },
      },
    })
  })

  test("preserves tool calls in non-streaming generate responses", async () => {
    const client: CodeWhispererClientLike = {
      async send() {
        return {
          conversationId: "conversation",
          generateAssistantResponseResponse: events([
            { toolUseEvent: { toolUseId: "call-1", name: "read_file", input: '{"path":"README.md"}', stop: true } },
          ]),
          $metadata: {},
        }
      },
    }
    const transport = new CodeWhispererKiroTransport(
      { region: "us-east-1", accessToken: "token" },
      () => client,
    )

    await expect(transport.generate(request)).resolves.toEqual({
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
    })
  })

  test("passes retry and timeout options to injected client factory", () => {
    let seen: unknown
    const client: CodeWhispererClientLike = {
      async send() {
        throw new Error("not used")
      },
    }

    new CodeWhispererKiroTransport(
      { region: "us-east-1", accessToken: "token", maxAttempts: 5, requestTimeoutMs: 1000 },
      (options) => {
        seen = options
        return client
      },
    )

    expect(seen).toMatchObject({
      region: "us-east-1",
      accessToken: "token",
      maxAttempts: 5,
      requestTimeoutMs: 1000,
    })
  })

  test("times out waiting for initial GenerateAssistantResponse response", async () => {
    const client: CodeWhispererClientLike = {
      async send() {
        return new Promise(() => undefined)
      },
    }
    const transport = new CodeWhispererKiroTransport(
      { region: "us-east-1", accessToken: "token", requestTimeoutMs: 1 },
      () => client,
    )

    await expect(transport.generate(request)).rejects.toMatchObject({
      code: "KIRO_TIMEOUT",
      status: 504,
    })
  })

  test("streams chunks through injected client", async () => {
    const client: CodeWhispererClientLike = {
      async send() {
        return {
          conversationId: "conversation",
          generateAssistantResponseResponse: events([
            { assistantResponseEvent: { content: "a", modelId: "claude-sonnet-4.6" } },
            { assistantResponseEvent: { content: "b" } },
          ]),
          $metadata: {},
        }
      },
    }
    const transport = new CodeWhispererKiroTransport(
      { region: "us-east-1", accessToken: "token" },
      () => client,
    )

    const chunks = []
    for await (const chunk of transport.stream(request)) chunks.push(chunk)

    expect(chunks).toEqual([{ type: "text", text: "a", modelId: "claude-sonnet-4.6" }, { type: "text", text: "b" }])
  })
})
