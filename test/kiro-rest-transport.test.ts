import { describe, expect, test } from "bun:test"
import { KiroRestTransport, toKiroRestPayload } from "../src/kiro-rest-transport.js"
import type { KiroGenerateRequest } from "../src/request-adapter.js"

const request: KiroGenerateRequest = {
  modelId: "claude-sonnet-4.5",
  system: "Be terse.",
  prompt: "Say hi",
  history: [
    {
      role: "assistant",
      content: "Earlier answer",
      toolUses: [{ toolUseId: "call-1", name: "read_file", input: { path: "README.md" } }],
    },
  ],
  tools: [
    {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
  toolResults: [{ toolUseId: "call-1", toolName: "read_file", content: "contents" }],
  images: [{ format: "png", bytes: Uint8Array.from([1, 2, 3]) }],
  documents: [],
  modelOptions: { maxTokens: 64, temperature: 0 },
  stream: true,
  metadata: {
    originalModel: "claude-sonnet-4.5",
    normalizedModel: "claude-sonnet-4.5",
    modelSource: "cache",
    hasTools: true,
  },
}

function stringHeader(name: string, value: string): Buffer {
  const nameBytes = Buffer.from(name)
  const valueBytes = Buffer.from(value)
  const out = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length)
  let offset = 0
  out.writeUInt8(nameBytes.length, offset)
  offset += 1
  nameBytes.copy(out, offset)
  offset += nameBytes.length
  out.writeUInt8(7, offset)
  offset += 1
  out.writeUInt16BE(valueBytes.length, offset)
  offset += 2
  valueBytes.copy(out, offset)
  return out
}

function eventFrame(eventType: string, payload: unknown): Buffer {
  const headers = stringHeader(":event-type", eventType)
  const body = Buffer.from(JSON.stringify(payload))
  const totalLength = 12 + headers.length + body.length + 4
  const frame = Buffer.alloc(totalLength)
  frame.writeUInt32BE(totalLength, 0)
  frame.writeUInt32BE(headers.length, 4)
  frame.writeUInt32BE(0, 8)
  headers.copy(frame, 12)
  body.copy(frame, 12 + headers.length)
  frame.writeUInt32BE(0, totalLength - 4)
  return frame
}

function streamResponse(frames: Buffer[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(frame.subarray(0, Math.ceil(frame.length / 2)))
        controller.enqueue(frame.subarray(Math.ceil(frame.length / 2)))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
}

describe("KiroRestTransport", () => {
  test("builds direct Kiro REST payload", () => {
    expect(toKiroRestPayload(request, "arn:aws:codewhisperer:us-east-1:123456789012:profile/test")).toMatchObject({
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
      inferenceConfig: {
        maxTokens: 64,
        temperature: 0,
      },
      conversationState: {
        chatTriggerType: "MANUAL",
        history: [
          {
            userInputMessage: {
              content: "Be terse.",
              modelId: "claude-sonnet-4.5",
              origin: "AI_EDITOR",
            },
          },
          {
            assistantResponseMessage: {
              content: "I will follow these instructions.",
            },
          },
          {
            assistantResponseMessage: {
              content: "Earlier answer",
              toolUses: [{ toolUseId: "call-1", name: "read_file", input: { path: "README.md" } }],
            },
          },
          {
            userInputMessage: {
              content: "",
              modelId: "claude-sonnet-4.5",
              origin: "AI_EDITOR",
              userInputMessageContext: {
                toolResults: [
                  {
                    toolUseId: "call-1",
                    content: [{ text: "contents" }],
                    status: "success",
                    toolName: "read_file",
                  },
                ],
              },
            },
          },
        ],
        currentMessage: {
          userInputMessage: {
            content: "Say hi",
            modelId: "claude-sonnet-4.5",
            origin: "AI_EDITOR",
            images: [{ format: "png", source: { bytes: "AQID" } }],
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
            },
          },
        },
      },
    })
  })

  test("streams AWS event stream assistant chunks from direct API", async () => {
    const seen: { url?: string; authorization: string | undefined } = { authorization: undefined }
    const transport = new KiroRestTransport(
      { region: "us-east-1" },
      {
        credentialProvider: async () => ({
          accessToken: "token",
          profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
          region: "us-east-1",
          source: "kirocli:odic:token",
        }),
        fetcher: async (input, init) => {
          seen.url = String(input)
          seen.authorization = new Headers(init?.headers).get("authorization") ?? undefined
          return streamResponse([
            eventFrame("assistantResponseEvent", { content: "po" }),
            eventFrame("assistantResponseEvent", { content: "pong" }),
            eventFrame("contextUsageEvent", { contextUsagePercentage: 1 }),
          ])
        },
      },
    )

    const chunks = []
    for await (const chunk of transport.stream(request)) chunks.push(chunk)

    expect(seen.url).toBe("https://q.us-east-1.amazonaws.com/generateAssistantResponse")
    expect(seen.authorization).toBe("Bearer token")
    expect(chunks).toEqual([
      { type: "text", text: "po", modelId: "claude-sonnet-4.5" },
      { type: "text", text: "ng", modelId: "claude-sonnet-4.5" },
    ])
  })

  test("falls back to codewhisperer endpoint after rate limit", async () => {
    const urls: string[] = []
    const transport = new KiroRestTransport(
      { region: "us-east-1", accessToken: "token" },
      {
        fetcher: async (input) => {
          urls.push(String(input))
          if (urls.length === 1) return new Response("quota", { status: 429 })
          return streamResponse([eventFrame("assistantResponseEvent", { content: "ok" })])
        },
      },
    )

    await expect(transport.generate(request)).resolves.toMatchObject({ text: "ok" })
    expect(urls).toEqual([
      "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
      "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
    ])
  })

  test("maps invalid bearer token responses to auth errors", async () => {
    const transport = new KiroRestTransport(
      { region: "us-east-1", accessToken: "bad-token" },
      {
        login: async () => false,
        fetcher: async () => new Response(JSON.stringify({ message: "invalid token" }), { status: 403 }),
      },
    )

    await expect(transport.generate(request)).rejects.toMatchObject({
      code: "KIRO_AUTH_ERROR",
      status: 403,
    })
  })

  test("maps missing direct REST credentials to auth errors", async () => {
    let logins = 0
    const transport = new KiroRestTransport(
      { region: "us-east-1" },
      {
        credentialProvider: async () => undefined,
        login: async () => {
          logins += 1
          return false
        },
      },
    )

    await expect(transport.generate(request)).rejects.toMatchObject({
      code: "KIRO_AUTH_ERROR",
      status: 401,
    })
    expect(logins).toBe(1)
  })

  test("waits for login and retries direct REST once after missing credentials", async () => {
    let credentialsCalls = 0
    let logins = 0
    const fetches: string[] = []
    const transport = new KiroRestTransport(
      { region: "us-east-1" },
      {
        credentialProvider: async () => {
          credentialsCalls += 1
          if (credentialsCalls === 1) return undefined
          return {
            accessToken: "token-after-login",
            profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
            region: "us-east-1",
            source: "kirocli:odic:token",
          }
        },
        login: async () => {
          logins += 1
          return true
        },
        fetcher: async (input) => {
          fetches.push(String(input))
          return streamResponse([eventFrame("assistantResponseEvent", { content: "ok" })])
        },
      },
    )

    await expect(transport.generate(request)).resolves.toMatchObject({ text: "ok" })
    expect(credentialsCalls).toBe(2)
    expect(logins).toBe(1)
    expect(fetches).toEqual(["https://q.us-east-1.amazonaws.com/generateAssistantResponse"])
  })

  test("waits for login and retries direct REST once after rejected credentials", async () => {
    let logins = 0
    const statuses = [403, 200]
    const transport = new KiroRestTransport(
      { region: "us-east-1", accessToken: "stored-token" },
      {
        login: async () => {
          logins += 1
          return true
        },
        fetcher: async () => {
          const status = statuses.shift()
          if (status === 403) return new Response(JSON.stringify({ message: "expired token" }), { status })
          return streamResponse([eventFrame("assistantResponseEvent", { content: "ok" })])
        },
      },
    )

    await expect(transport.generate(request)).resolves.toMatchObject({ text: "ok" })
    expect(logins).toBe(1)
  })
})
