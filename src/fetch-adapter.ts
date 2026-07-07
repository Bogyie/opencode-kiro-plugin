import { errorResponse, KiroPluginError, UnsupportedBackendError } from "./errors.js"
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

function assertNonEmptyResponse(response: KiroGenerateResponse): void {
  if (response.text || response.reasoning || (response.toolCalls?.length ?? 0) > 0) return
  throw new KiroPluginError("Kiro backend returned an empty response.", "KIRO_EMPTY_RESPONSE", 502)
}

async function* responseToStream(response: KiroGenerateResponse, fallbackModelId: string): AsyncIterable<KiroStreamEvent> {
  assertNonEmptyResponse(response)
  if (response.reasoning) yield { type: "reasoning", text: response.reasoning, modelId: response.modelId ?? fallbackModelId }
  if (response.text) yield { type: "text", text: response.text, modelId: response.modelId ?? fallbackModelId }
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
        const response = await transport.generate(kiroRequest)
        assertNonEmptyResponse(response)
        return toOpenAIChatStreamResponse(responseToStream(response, kiroRequest.modelId), kiroRequest.modelId)
      }
      const response = await transport.generate(kiroRequest)
      assertNonEmptyResponse(response)
      return toOpenAIChatResponse(response, kiroRequest.modelId)
    } catch (error) {
      return errorResponse(error)
    }
  }
}
