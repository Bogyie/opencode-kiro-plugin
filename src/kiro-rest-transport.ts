import { KiroPluginError } from "./errors.js"
import {
  readKiroCliSessionCredential,
  regionFromProfileArn,
  type KiroCliSessionCredential,
} from "./auth.js"
import type { KiroTransport } from "./fetch-adapter.js"
import type { KiroGenerateRequest } from "./request-adapter.js"
import type { KiroGenerateResponse, KiroStreamEvent } from "./response-adapter.js"

export interface KiroRestTransportOptions {
  readonly region: string
  readonly accessToken?: string
  readonly endpoint?: string
  readonly profileArn?: string
  readonly userAgent?: string
  readonly agentMode?: string
  readonly maxAttempts?: number
  readonly requestTimeoutMs?: number
}

export type KiroCredentialProvider = () => Promise<KiroCliSessionCredential | undefined>
export type KiroRestFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface KiroRestTransportDependencies {
  readonly fetcher?: KiroRestFetch
  readonly credentialProvider?: KiroCredentialProvider
}

interface ResolvedCredentials {
  readonly accessToken: string
  readonly profileArn?: string
  readonly region: string
}

interface KiroEventStreamMessage {
  readonly eventType: string
  readonly payload: Record<string, unknown>
}

const DEFAULT_USER_AGENT = "KiroIDE"
const DEFAULT_AGENT_MODE = "vibe"
const STREAMING_SDK_VERSION = "1.0.34"

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

function conversationId(request: KiroGenerateRequest): string {
  const seed = `${request.modelId}:${request.prompt}:${request.system ?? ""}`
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return `opencode-${hash.toString(16)}-${Date.now().toString(36)}`
}

export function toKiroRestPayload(request: KiroGenerateRequest, profileArn?: string): Record<string, unknown> {
  const toolResults = request.toolResults.map((item) => ({
    toolUseId: item.toolUseId,
    content: [{ text: item.content }],
    status: "success",
    ...(item.toolName ? { toolName: item.toolName } : {}),
  }))
  const history = [
    ...(request.system
      ? [
          {
            userInputMessage: {
              content: request.system,
              modelId: request.modelId,
              origin: "AI_EDITOR",
            },
          },
          {
            assistantResponseMessage: {
              content: "I will follow these instructions.",
            },
          },
        ]
      : []),
    ...request.history.map((turn) =>
      turn.role === "assistant"
        ? {
            assistantResponseMessage: {
              content: turn.content,
              ...(turn.toolUses && turn.toolUses.length > 0
                ? {
                    toolUses: turn.toolUses.map((toolUse) => ({
                      toolUseId: toolUse.toolUseId,
                      name: toolUse.name,
                      input: toolUse.input,
                    })),
                  }
                : {}),
            },
          }
        : {
            userInputMessage: {
              content: turn.content,
              modelId: request.modelId,
              origin: "AI_EDITOR",
            },
          },
    ),
    ...(toolResults.length > 0
      ? [
          {
            userInputMessage: {
              content: "",
              modelId: request.modelId,
              origin: "AI_EDITOR",
              userInputMessageContext: {
                toolResults,
              },
            },
          },
        ]
      : []),
  ]

  const tools = request.tools.map((item) => ({
    toolSpecification: {
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
      inputSchema: { json: item.inputSchema },
    },
  }))
  const userInputMessageContext =
    tools.length > 0
      ? {
          ...(tools.length > 0 ? { tools } : {}),
        }
      : undefined

  const inferenceConfig =
    request.modelOptions.maxTokens !== undefined || request.modelOptions.temperature !== undefined
      ? {
          ...(request.modelOptions.maxTokens !== undefined ? { maxTokens: request.modelOptions.maxTokens } : {}),
          ...(request.modelOptions.temperature !== undefined ? { temperature: request.modelOptions.temperature } : {}),
        }
      : undefined

  return {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: conversationId(request),
      currentMessage: {
        userInputMessage: {
          content: request.prompt || "Continue.",
          modelId: request.modelId,
          origin: "AI_EDITOR",
          ...(request.images.length > 0
            ? {
                images: request.images.map((image) => ({
                  format: image.format,
                  source: { bytes: base64(image.bytes) },
                })),
              }
            : {}),
          ...(userInputMessageContext ? { userInputMessageContext } : {}),
        },
      },
      ...(history.length > 0 ? { history } : {}),
    },
    ...(profileArn ? { profileArn } : {}),
    ...(inferenceConfig ? { inferenceConfig } : {}),
  }
}

function modelUserAgent(userAgent: string): string {
  if (userAgent !== DEFAULT_USER_AGENT) return userAgent
  const nodeVersion = process.version.replace(/^v/, "")
  const platform = process.platform === "darwin" ? "darwin" : process.platform
  return `aws-sdk-js/${STREAMING_SDK_VERSION} ua/2.1 os/${platform} lang/js md/nodejs#${nodeVersion} api/codewhispererstreaming#${STREAMING_SDK_VERSION} m/E ${DEFAULT_USER_AGENT}`
}

function endpointCandidates(options: KiroRestTransportOptions, region: string): string[] {
  if (options.endpoint) {
    return [options.endpoint.endsWith("/generateAssistantResponse") ? options.endpoint : `${options.endpoint.replace(/\/+$/, "")}/generateAssistantResponse`]
  }
  const qEndpoint = `https://q.${region}.amazonaws.com/generateAssistantResponse`
  if (region !== "us-east-1") return [qEndpoint]
  return [qEndpoint, "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse"]
}

function headersFor(endpoint: string, accessToken: string, options: KiroRestTransportOptions): Headers {
  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    accept: "*/*",
    "user-agent": modelUserAgent(options.userAgent ?? DEFAULT_USER_AGENT),
    "x-amz-user-agent": `aws-sdk-js/${STREAMING_SDK_VERSION} ${options.userAgent ?? DEFAULT_USER_AGENT}`,
    "x-amzn-kiro-agent-mode": options.agentMode ?? DEFAULT_AGENT_MODE,
    "x-amzn-codewhisperer-optout": "true",
    "amz-sdk-request": `attempt=1; max=${options.maxAttempts ?? 3}`,
    "amz-sdk-invocation-id": crypto.randomUUID(),
  })
  if (new URL(endpoint).hostname.startsWith("codewhisperer.")) {
    headers.set("x-amz-target", "AmazonCodeWhispererStreamingService.GenerateAssistantResponse")
  }
  return headers
}

function timeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs) return undefined
  return AbortSignal.timeout(timeoutMs)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function tokenUsage(payload: Record<string, unknown>): KiroGenerateResponse["usage"] | undefined {
  const usage = payload.tokenUsage
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined
  const record = usage as Record<string, unknown>
  const uncached = numberValue(record.uncachedInputTokens) ?? 0
  const cacheRead = numberValue(record.cacheReadInputTokens) ?? 0
  const cacheWrite = numberValue(record.cacheWriteInputTokens) ?? 0
  const outputTokens = numberValue(record.outputTokens)
  const inputTokens = numberValue(record.inputTokens) ?? (uncached + cacheRead + cacheWrite || undefined)
  return inputTokens || outputTokens
    ? {
        ...(inputTokens ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      }
    : undefined
}

function parseHeaders(buffer: Buffer): Record<string, unknown> {
  const headers: Record<string, unknown> = {}
  let offset = 0
  while (offset < buffer.length) {
    const nameLength = buffer[offset]
    if (nameLength === undefined) break
    offset += 1
    const name = buffer.subarray(offset, offset + nameLength).toString("utf8")
    offset += nameLength
    const type = buffer[offset]
    offset += 1
    if (type === 7) {
      const valueLength = buffer.readUInt16BE(offset)
      offset += 2
      headers[name] = buffer.subarray(offset, offset + valueLength).toString("utf8")
      offset += valueLength
      continue
    }
    if (type === 6) {
      const valueLength = buffer.readUInt16BE(offset)
      offset += 2
      headers[name] = buffer.subarray(offset, offset + valueLength)
      offset += valueLength
      continue
    }
    if (type === 0 || type === 1) {
      headers[name] = type === 0
      continue
    }
    if (type === 2) {
      headers[name] = buffer.readInt8(offset)
      offset += 1
      continue
    }
    if (type === 3) {
      headers[name] = buffer.readInt16BE(offset)
      offset += 2
      continue
    }
    if (type === 4) {
      headers[name] = buffer.readInt32BE(offset)
      offset += 4
      continue
    }
    if (type === 5) {
      headers[name] = Number(buffer.readBigInt64BE(offset))
      offset += 8
      continue
    }
    break
  }
  return headers
}

async function* decodeEventStream(body: ReadableStream<Uint8Array>): AsyncIterable<KiroEventStreamMessage> {
  const reader = body.getReader()
  let buffer = Buffer.alloc(0)
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      buffer = Buffer.concat([buffer, Buffer.from(item.value)])
      while (buffer.length >= 16) {
        const totalLength = buffer.readUInt32BE(0)
        const headersLength = buffer.readUInt32BE(4)
        if (totalLength < 16) throw new KiroPluginError("Kiro returned an invalid event stream frame.", "KIRO_STREAM_ERROR", 502)
        if (buffer.length < totalLength) break
        const frame = buffer.subarray(0, totalLength)
        buffer = buffer.subarray(totalLength)
        const headers = parseHeaders(frame.subarray(12, 12 + headersLength))
        const payloadBytes = frame.subarray(12 + headersLength, totalLength - 4)
        if (payloadBytes.length === 0) continue
        const payload = JSON.parse(payloadBytes.toString("utf8")) as Record<string, unknown>
        yield {
          eventType: stringValue(headers[":event-type"]) ?? "unknown",
          payload,
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function normalizeChunk(chunk: string, previous: { value: string }): string {
  const old = previous.value
  if (!old) {
    previous.value = chunk
    return chunk
  }
  if (chunk === old || old.startsWith(chunk)) return ""
  if (chunk.startsWith(old)) {
    previous.value = chunk
    return chunk.slice(old.length)
  }
  previous.value = chunk
  return chunk
}

async function collectChunks(chunks: AsyncIterable<KiroStreamEvent>, fallbackModelId: string): Promise<KiroGenerateResponse> {
  let text = ""
  let reasoning = ""
  let usage: KiroGenerateResponse["usage"] | undefined
  const toolCalls = []
  for await (const chunk of chunks) {
    if (chunk.type === "tool_call") {
      toolCalls.push(chunk)
      continue
    }
    if (chunk.type === "reasoning") {
      reasoning += chunk.text
      continue
    }
    text += chunk.text
    if (chunk.usage) usage = chunk.usage
  }
  return {
    text,
    modelId: fallbackModelId,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
  }
}

export class KiroRestTransport implements KiroTransport {
  readonly #options: KiroRestTransportOptions
  readonly #fetcher: KiroRestFetch
  readonly #credentialProvider: KiroCredentialProvider

  constructor(options: KiroRestTransportOptions, dependencies: KiroRestTransportDependencies = {}) {
    this.#options = options
    this.#fetcher = dependencies.fetcher ?? fetch
    this.#credentialProvider = dependencies.credentialProvider ?? (() => readKiroCliSessionCredential())
  }

  async #credentials(): Promise<ResolvedCredentials> {
    const session = this.#options.accessToken ? undefined : await this.#credentialProvider()
    const accessToken = this.#options.accessToken ?? session?.accessToken
    if (!accessToken) {
      throw new KiroPluginError("No Kiro API token or Kiro CLI session token found. Run Kiro login and try again.", "KIRO_AUTH_ERROR", 401)
    }
    const profileArn = this.#options.profileArn ?? session?.profileArn
    return {
      accessToken,
      ...(profileArn ? { profileArn } : {}),
      region: regionFromProfileArn(profileArn) ?? session?.region ?? this.#options.region,
    }
  }

  async generate(request: KiroGenerateRequest): Promise<KiroGenerateResponse> {
    return collectChunks(this.stream(request), request.modelId)
  }

  async *stream(request: KiroGenerateRequest): AsyncIterable<KiroStreamEvent> {
    const credentials = await this.#credentials()
    const payload = toKiroRestPayload(request, credentials.profileArn)
    let lastError: KiroPluginError | undefined

    for (const endpoint of endpointCandidates(this.#options, credentials.region)) {
      const init: RequestInit = {
        method: "POST",
        headers: headersFor(endpoint, credentials.accessToken, this.#options),
        body: JSON.stringify(payload),
      }
      const signal = timeoutSignal(this.#options.requestTimeoutMs)
      if (signal) init.signal = signal
      const response = await this.#fetcher(endpoint, init)

      if (!response.ok) {
        const errorBody = await response.text()
        const message = errorBody || `Kiro API returned HTTP ${response.status}`
        const code = response.status === 401 || response.status === 403 ? "KIRO_AUTH_ERROR" : response.status === 429 ? "KIRO_RATE_LIMIT" : "KIRO_UPSTREAM_ERROR"
        lastError = new KiroPluginError(message, code, response.status)
        if (response.status === 429 || response.status >= 500) continue
        throw lastError
      }

      if (!response.body) return

      const assistant = { value: "" }
      const reasoning = { value: "" }
      const toolInputs = new Map<string, { name: string; input: string }>()
      for await (const event of decodeEventStream(response.body)) {
        if (event.eventType === "assistantResponseEvent") {
          const content = stringValue(event.payload.content)
          if (!content) continue
          const text = normalizeChunk(content, assistant)
          if (text) yield { type: "text", text, modelId: request.modelId }
          continue
        }
        if (event.eventType === "reasoningContentEvent") {
          const content = stringValue(event.payload.text)
          if (!content) continue
          const text = normalizeChunk(content, reasoning)
          if (text) yield { type: "reasoning", text, modelId: request.modelId }
          continue
        }
        if (event.eventType === "toolUseEvent") {
          const id = stringValue(event.payload.toolUseId) ?? stringValue(event.payload.id) ?? crypto.randomUUID()
          const name = stringValue(event.payload.name) ?? stringValue(event.payload.toolName)
          if (!name) continue
          const current = toolInputs.get(id) ?? { name, input: "" }
          const input = event.payload.input
          current.input += typeof input === "string" ? input : input && typeof input === "object" ? JSON.stringify(input) : ""
          current.name = name
          toolInputs.set(id, current)
          if (event.payload.stop === true) {
            yield { type: "tool_call", id, name: current.name, arguments: current.input, modelId: request.modelId }
            toolInputs.delete(id)
          }
          continue
        }
        const usage = tokenUsage(event.payload)
        if (usage) yield { type: "text", text: "", usage, modelId: request.modelId }
      }
      for (const [id, toolCall] of toolInputs) {
        yield { type: "tool_call", id, name: toolCall.name, arguments: toolCall.input, modelId: request.modelId }
      }
      return
    }

    if (lastError) throw lastError
  }
}
