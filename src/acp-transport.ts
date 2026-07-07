import {
  createAcpStdioClient,
  type AcpJsonRpcClient,
  type AcpNotificationHandler,
  type AcpRequestHandler,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./acp-client.js"
import { promptForCli } from "./cli-transport.js"
import { KiroPluginError } from "./errors.js"
import type { KiroTransport } from "./fetch-adapter.js"
import type { KiroGenerateRequest } from "./request-adapter.js"
import type { KiroGenerateResponse, KiroStreamEvent, KiroToolCallChunk } from "./response-adapter.js"

export interface AcpSessionClient {
  request(method: string, params?: unknown): Promise<unknown>
  onNotification(handler: AcpNotificationHandler): () => void
  close?(): void
}

export interface KiroAcpTransportOptions {
  readonly client?: AcpSessionClient
  readonly command?: string
  readonly args?: ReadonlyArray<string>
  readonly cwd?: string
  readonly promptTimeoutMs?: number
  readonly trustAllTools?: boolean
  readonly clientInfo?: {
    readonly name: string
    readonly version: string
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function arrayValue(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

export function acpPermissionResponse(params: unknown, trustAllTools = false): { outcome: { outcome: "selected"; optionId: string } } {
  const options = arrayValue(record(params)?.options).map(record).filter((item): item is Record<string, unknown> => item !== undefined)
  const preferredKinds = trustAllTools ? ["allow_always", "allow_once"] : ["reject_once", "reject_always"]
  const selected =
    preferredKinds
      .map((kind) => options.find((option) => option.kind === kind))
      .find((option): option is Record<string, unknown> => option !== undefined) ?? options[0]
  const optionId = stringValue(selected?.optionId)
  if (!optionId) {
    throw new KiroPluginError("ACP permission request did not include selectable options.", "KIRO_ACP_PROTOCOL_ERROR", 502)
  }
  return {
    outcome: {
      outcome: "selected",
      optionId,
    },
  }
}

function unsupportedAcpRequest(method: string): never {
  throw new KiroPluginError(`Unsupported ACP client request: ${method}`, "KIRO_ACP_UNSUPPORTED_REQUEST", 502)
}

function sessionIdFrom(result: unknown): string {
  const item = record(result)
  const session = record(item?.session)
  const id = stringValue(item?.sessionId) ?? stringValue(item?.id) ?? stringValue(session?.id)
  if (!id) {
    throw new KiroPluginError("ACP session/new response did not include a session id.", "KIRO_ACP_PROTOCOL_ERROR", 502)
  }
  return id
}

function notificationUpdate(notification: JsonRpcNotification): Record<string, unknown> | undefined {
  if (notification.method !== "session/notification" && notification.method !== "session/update") return undefined
  const params = record(notification.params)
  return record(params?.update) ?? record(params?.notification) ?? params
}

function updateType(update: Record<string, unknown>): string | undefined {
  const nested = record(update.update)
  return (
    stringValue(update.type) ??
    stringValue(update.sessionUpdate) ??
    stringValue(nested?.type) ??
    stringValue(nested?.sessionUpdate) ??
    stringValue(update.kind) ??
    stringValue(nested?.kind)
  )
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join("")
  const item = record(value)
  if (!item) return ""
  return stringValue(item.text) ?? stringValue(item.content) ?? stringValue(item.delta) ?? ""
}

function textFromUpdate(update: Record<string, unknown>): string {
  const type = updateType(update)
  if (type !== "AgentMessageChunk") return ""
  return (
    textFromContent(update.content) ||
    textFromContent(update.text) ||
    textFromContent(update.chunk) ||
    textFromContent(record(update.delta)?.text)
  )
}

function isTurnEnd(update: Record<string, unknown>): boolean {
  return updateType(update) === "TurnEnd"
}

function normalizeToolName(input: string): string {
  const name = input.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "")
  return name || "tool"
}

function jsonArguments(value: unknown): string {
  if (value === undefined) return "{}"
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined)
}

function toolCallDetail(update: Record<string, unknown>): Record<string, unknown> {
  const detail = record(update.update) ?? update
  return (
    record(detail.toolCall) ??
    record(detail.tool_call) ??
    record(detail.call) ??
    record(record(detail.delta)?.toolCall) ??
    record(record(detail.delta)?.tool_call) ??
    detail
  )
}

function toolCallFromUpdate(update: Record<string, unknown>, modelId: string): KiroToolCallChunk | undefined {
  const type = updateType(update)
  if (type !== "ToolCall" && type !== "ToolCallUpdate" && type !== "tool_call" && type !== "tool_call_update") return undefined

  const detail = toolCallDetail(update)
  const id =
    stringValue(detail.toolCallId) ??
    stringValue(detail.tool_call_id) ??
    stringValue(detail.id) ??
    stringValue(detail.callId) ??
    `acp-tool-${crypto.randomUUID()}`
  const explicitName =
    stringValue(detail.name) ??
    stringValue(detail.toolName) ??
    stringValue(detail.tool_name)
  const rawArguments = firstDefined(detail.rawInput, detail.input, detail.parameters, detail.params, detail.args, detail.arguments)
  if ((type === "ToolCallUpdate" || type === "tool_call_update") && rawArguments === undefined && !explicitName) {
    return undefined
  }
  const rawName = explicitName ?? (rawArguments !== undefined ? stringValue(detail.kind) ?? stringValue(detail.title) : undefined) ?? "tool"

  return {
    type: "tool_call",
    id,
    name: normalizeToolName(rawName),
    arguments: jsonArguments(rawArguments),
    modelId,
  }
}

function acpPromptContent(request: KiroGenerateRequest): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: promptForCli(request) }]

  for (const image of request.images) {
    content.push({
      type: "image",
      mimeType: `image/${image.format === "jpeg" ? "jpeg" : image.format}`,
      data: Buffer.from(image.bytes).toString("base64"),
    })
  }

  for (const document of request.documents) {
    const mimeType = documentMimeType(document.format)
    const uri = `attachment://${encodeURIComponent(document.name)}`
    if (document.format === "txt" || document.format === "md" || document.format === "csv" || document.format === "html") {
      content.push({
        type: "resource",
        resource: {
          uri,
          mimeType,
          text: Buffer.from(document.bytes).toString("utf8"),
        },
      })
      continue
    }
    content.push({
      type: "resource",
      resource: {
        uri,
        mimeType,
        blob: Buffer.from(document.bytes).toString("base64"),
      },
    })
  }

  return content
}

function documentMimeType(format: KiroGenerateRequest["documents"][number]["format"]): string {
  if (format === "pdf") return "application/pdf"
  if (format === "txt") return "text/plain"
  if (format === "md") return "text/markdown"
  if (format === "csv") return "text/csv"
  if (format === "html") return "text/html"
  if (format === "doc") return "application/msword"
  if (format === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  if (format === "xls") return "application/vnd.ms-excel"
  return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
}

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new KiroPluginError(message, "KIRO_ACP_TIMEOUT", 504)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = []
  readonly #waiting: Array<() => void> = []
  #closed = false
  #error: unknown

  push(value: T): void {
    if (this.#closed || this.#error) return
    this.#values.push(value)
    this.#wake()
  }

  close(): void {
    this.#closed = true
    this.#wake()
  }

  fail(error: unknown): void {
    this.#error = error
    this.#wake()
  }

  #wake(): void {
    for (const resolve of this.#waiting.splice(0)) resolve()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.#values.length > 0) {
        const value = this.#values.shift()
        if (value !== undefined) yield value
        continue
      }
      if (this.#error) throw this.#error
      if (this.#closed) return
      await new Promise<void>((resolve) => {
        this.#waiting.push(resolve)
      })
    }
  }
}

export class KiroAcpTransport implements KiroTransport {
  readonly #options: KiroAcpTransportOptions

  constructor(options: KiroAcpTransportOptions = {}) {
    this.#options = options
  }

  #client(): { client: AcpSessionClient; owned: boolean } {
    if (this.#options.client) return { client: this.#options.client, owned: false }
    const stdioOptions = {
      ...(this.#options.command ? { command: this.#options.command } : {}),
      ...(this.#options.args ? { args: this.#options.args } : {}),
      ...(this.#options.cwd ? { cwd: this.#options.cwd } : {}),
    }
    return {
      client: createAcpStdioClient({
        ...stdioOptions,
        requestHandler: this.#requestHandler(),
      }) as AcpJsonRpcClient,
      owned: true,
    }
  }

  #requestHandler(): AcpRequestHandler {
    return (message: JsonRpcRequest) => {
      if (message.method === "session/request_permission") {
        return acpPermissionResponse(message.params, this.#options.trustAllTools === true)
      }
      return unsupportedAcpRequest(message.method)
    }
  }

  async #startSession(client: AcpSessionClient, request: KiroGenerateRequest): Promise<string> {
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
      clientInfo: this.#options.clientInfo ?? {
        name: "opencode-kiro-plugin",
        version: "0.1.0",
      },
    })
    const sessionId = sessionIdFrom(
      await client.request("session/new", {
        cwd: this.#options.cwd ?? process.cwd(),
        mcpServers: [],
      }),
    )

    if (request.modelId !== "auto") {
      await client.request("session/set_model", {
        sessionId,
        model: request.modelId,
      })
    }

    return sessionId
  }

  async generate(request: KiroGenerateRequest): Promise<KiroGenerateResponse> {
    const chunks: string[] = []
    const toolCalls = new Map<string, KiroToolCallChunk>()
    for await (const event of this.stream(request)) {
      if (event.type === "tool_call") {
        toolCalls.set(event.id, event)
        continue
      }
      chunks.push(event.text)
    }
    const collectedToolCalls = [...toolCalls.values()]
    return {
      text: chunks.join(""),
      modelId: request.modelId,
      ...(collectedToolCalls.length > 0 ? { toolCalls: collectedToolCalls } : {}),
    }
  }

  async *stream(request: KiroGenerateRequest): AsyncIterable<KiroStreamEvent> {
    const { client, owned } = this.#client()
    const promptTimeoutMs = this.#options.promptTimeoutMs ?? 120_000
    const queue = new AsyncQueue<KiroStreamEvent>()
    let sessionId: string | undefined
    let completed = false
    const seenToolCallPayloads = new Map<string, string>()
    const timer = setTimeout(() => {
      queue.fail(new KiroPluginError("Timed out waiting for ACP TurnEnd notification.", "KIRO_ACP_TIMEOUT", 504))
    }, promptTimeoutMs)
    const unsubscribe = client.onNotification((notification) => {
      const update = notificationUpdate(notification)
      if (!update) return
      const text = textFromUpdate(update)
      if (text) queue.push({ type: "text", text, modelId: request.modelId })
      const toolCall = toolCallFromUpdate(update, request.modelId)
      if (toolCall) {
        const payload = `${toolCall.name}\n${toolCall.arguments}`
        if (seenToolCallPayloads.get(toolCall.id) !== payload) {
          seenToolCallPayloads.set(toolCall.id, payload)
          queue.push(toolCall)
        }
      }
      if (isTurnEnd(update)) {
        completed = true
        queue.close()
      }
    })

    try {
      sessionId = await this.#startSession(client, request)
      const prompt = client.request("session/prompt", {
        sessionId,
        content: acpPromptContent(request),
      }).catch((error) => {
        queue.fail(error)
      })

      for await (const event of queue) {
        yield event
      }
      await timeout(prompt, promptTimeoutMs, "Timed out waiting for ACP prompt response.")
    } finally {
      clearTimeout(timer)
      unsubscribe()
      if (sessionId && !completed) {
        await client.request("session/cancel", { sessionId }).catch(() => undefined)
      }
      if (owned) client.close?.()
    }
  }
}
