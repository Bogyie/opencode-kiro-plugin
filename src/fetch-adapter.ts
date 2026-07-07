import { errorResponse, UnsupportedBackendError } from "./errors.js"
import { readOpenAIRequest, toKiroGenerateRequest, type KiroGenerateRequest } from "./request-adapter.js"
import { toOpenAIChatResponse, type KiroGenerateResponse } from "./response-adapter.js"
import type { ModelResolver } from "./model-resolver.js"

export interface KiroTransport {
  generate(request: KiroGenerateRequest): Promise<KiroGenerateResponse>
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

export function createKiroFetch(options: KiroFetchOptions): FetchAdapter {
  const transport = options.transport ?? unsupportedTransport
  return async (input, init) => {
    try {
      const request = await readOpenAIRequest(input, init)
      const kiroRequest = toKiroGenerateRequest(request, options.resolver)
      const response = await transport.generate(kiroRequest)
      return toOpenAIChatResponse(response, kiroRequest.modelId)
    } catch (error) {
      return errorResponse(error)
    }
  }
}
