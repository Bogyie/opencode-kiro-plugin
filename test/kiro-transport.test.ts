import { describe, expect, test } from "bun:test"
import type { ChatResponseStream } from "@aws/codewhisperer-streaming-client"
import {
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
