import {
  createAcpStdioClient,
  type AcpJsonRpcClient,
  type AcpNotificationHandler,
  type JsonRpcNotification,
} from "./acp-client.js"
import { promptForCli } from "./cli-transport.js"
import { KiroPluginError } from "./errors.js"
import type { KiroTransport } from "./fetch-adapter.js"
import type { KiroGenerateRequest } from "./request-adapter.js"
import type { KiroGenerateResponse } from "./response-adapter.js"

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
  readonly clientInfo?: {
    readonly name: string
    readonly version: string
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
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
  if (notification.method !== "session/notification") return undefined
  const params = record(notification.params)
  return record(params?.update) ?? record(params?.notification) ?? params
}

function updateType(update: Record<string, unknown>): string | undefined {
  return stringValue(update.type) ?? stringValue(update.kind) ?? stringValue(record(update.update)?.type)
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

function acpPromptContent(request: KiroGenerateRequest): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: promptForCli(request) }]

  for (const image of request.images) {
    content.push({
      type: "image",
      mimeType: `image/${image.format === "jpeg" ? "jpeg" : image.format}`,
      data: Buffer.from(image.bytes).toString("base64"),
    })
  }

  return content
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
      client: createAcpStdioClient(stdioOptions) as AcpJsonRpcClient,
      owned: true,
    }
  }

  async generate(request: KiroGenerateRequest): Promise<KiroGenerateResponse> {
    const { client, owned } = this.#client()
    const promptTimeoutMs = this.#options.promptTimeoutMs ?? 120_000
    const chunks: string[] = []
    let endTurn: (() => void) | undefined
    const turnEnd = new Promise<void>((resolve) => {
      endTurn = resolve
    })
    const unsubscribe = client.onNotification((notification) => {
      const update = notificationUpdate(notification)
      if (!update) return
      const text = textFromUpdate(update)
      if (text) chunks.push(text)
      if (isTurnEnd(update)) endTurn?.()
    })

    try {
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

      await client.request("session/prompt", {
        sessionId,
        content: acpPromptContent(request),
      })
      await timeout(turnEnd, promptTimeoutMs, "Timed out waiting for ACP TurnEnd notification.")

      return {
        text: chunks.join(""),
        modelId: request.modelId,
      }
    } finally {
      unsubscribe()
      if (owned) client.close?.()
    }
  }
}
