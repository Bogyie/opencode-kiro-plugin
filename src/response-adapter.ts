export interface KiroGenerateResponse {
  readonly text: string
  readonly modelId?: string
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
  }
}

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

