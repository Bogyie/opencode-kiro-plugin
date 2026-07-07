import { errorResponse, UnsupportedBackendError } from "./errors.js"
import { readOpenAIRequest, toKiroGenerateRequest, type KiroGenerateRequest } from "./request-adapter.js"
import { toOpenAIChatResponse, toOpenAIChatStreamResponse, type KiroGenerateResponse, type KiroStreamEvent } from "./response-adapter.js"
import type { ModelResolver } from "./model-resolver.js"

export interface KiroTransport {
  generate(request: KiroGenerateRequest): Promise<KiroGenerateResponse>
  stream?(request: KiroGenerateRequest): AsyncIterable<KiroStreamEvent>
}

export interface KiroFetchOptions {
  readonly resolver: ModelResolver
  readonly transport?: KiroTransport
}

export type FetchAdapter = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const unsupportedTransport: KiroTransport = {
  async generate(): Promise<KiroGenerateResponse> {
    throw new UnsupportedBackendError()
  },
}

async function* streamGeneratedResponse(transport: KiroTransport, request: KiroGenerateRequest): AsyncIterable<KiroStreamEvent> {
  const response = await transport.generate(request)
  if (response.reasoning) yield { type: "reasoning", text: response.reasoning, modelId: response.modelId ?? request.modelId }
  if (response.text) yield { type: "text", text: response.text, modelId: response.modelId ?? request.modelId }
  for (const toolCall of response.toolCalls ?? []) yield toolCall
}

export function createKiroFetch(options: KiroFetchOptions): FetchAdapter {
  const transport = options.transport ?? unsupportedTransport
  return async (input, init) => {
    try {
      const request = await readOpenAIRequest(input, init)
      const kiroRequest = toKiroGenerateRequest(request, options.resolver)
      if (request.stream === true && transport.stream) {
        return toOpenAIChatStreamResponse(transport.stream(kiroRequest), kiroRequest.modelId)
      }
      if (request.stream === true) {
        return toOpenAIChatStreamResponse(streamGeneratedResponse(transport, kiroRequest), kiroRequest.modelId)
      }
      const response = await transport.generate(kiroRequest)
      return toOpenAIChatResponse(response, kiroRequest.modelId)
    } catch (error) {
      return errorResponse(error)
    }
  }
}
