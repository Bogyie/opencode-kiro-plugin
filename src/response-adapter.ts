export interface KiroGenerateResponse {
  readonly text: string
  readonly modelId?: string
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
  }
}

export interface KiroStreamChunk {
  readonly type?: "text"
  readonly text: string
  readonly modelId?: string
}

export interface KiroToolCallChunk {
  readonly type: "tool_call"
  readonly id: string
  readonly name: string
  readonly arguments: string
  readonly modelId?: string
}

export type KiroStreamEvent = KiroStreamChunk | KiroToolCallChunk

export function toOpenAIChatResponse(response: KiroGenerateResponse, model: string): Response {
  return Response.json({
    id: `kiro-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.modelId ?? model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: response.text,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: response.usage?.inputTokens ?? 0,
      completion_tokens: response.usage?.outputTokens ?? 0,
      total_tokens: (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0),
    },
  })
}

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

export function toOpenAIChatStreamResponse(chunks: AsyncIterable<KiroStreamEvent>, model: string): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of chunks) {
          const delta =
            chunk.type === "tool_call"
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: chunk.id,
                      type: "function",
                      function: {
                        name: chunk.name,
                        arguments: chunk.arguments,
                      },
                    },
                  ],
                }
              : { content: chunk.text }
          controller.enqueue(
            encoder.encode(
              sse({
                id: `kiro-${crypto.randomUUID()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: chunk.modelId ?? model,
                choices: [
                  {
                    index: 0,
                    delta,
                    finish_reason: null,
                  },
                ],
              }),
            ),
          )
        }
        controller.enqueue(encoder.encode(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  })
}
