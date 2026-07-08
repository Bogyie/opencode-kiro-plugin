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
  readonly models?: () => Promise<ReadonlyArray<string | OpenAIModelListItem>>
}

export type FetchAdapter = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface OpenAIModelListItem {
  readonly id: string
  readonly [key: string]: unknown
}

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

function requestPath(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : input.toString()
  const pathname = new URL(raw, "http://127.0.0.1").pathname.replace(/\/+$/, "")
  return pathname || "/"
}

function isModelsPath(pathname: string): boolean {
  return pathname === "/v1/models" || pathname === "/models"
}

function toOpenAIModel(item: string | OpenAIModelListItem): Record<string, unknown> {
  const id = typeof item === "string" ? item : item.id
  const extra: OpenAIModelListItem = typeof item === "string" ? { id } : item
  return {
    ...extra,
    id,
    object: "model",
    created: typeof extra.created === "number" ? extra.created : 0,
    owned_by: typeof extra.owned_by === "string" ? extra.owned_by : "kiro",
  }
}

async function toOpenAIModelsResponse(models: KiroFetchOptions["models"]): Promise<Response> {
  const data = models ? (await models()).filter((item) => (typeof item === "string" ? item.trim() : item.id.trim())).map(toOpenAIModel) : []
  return Response.json({
    object: "list",
    data,
  })
}

export function createKiroFetch(options: KiroFetchOptions): FetchAdapter {
  const transport = options.transport ?? unsupportedTransport
  return async (input, init) => {
    try {
      if (isModelsPath(requestPath(input))) return toOpenAIModelsResponse(options.models)
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
