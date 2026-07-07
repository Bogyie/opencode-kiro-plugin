import { describe, expect, test } from "bun:test"
import type { ChatResponseStream } from "@aws/codewhisperer-streaming-client"
import {
  CodeWhispererKiroTransport,
  collectAssistantText,
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
})
