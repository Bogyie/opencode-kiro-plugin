import { KiroPluginError } from "./errors.js"
import { spawn } from "node:child_process"

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id: JsonRpcId
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0"
  readonly id: JsonRpcId
  readonly result: unknown
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0"
  readonly id: JsonRpcId
  readonly error: {
    readonly code: number
    readonly message: string
    readonly data?: unknown
  }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export interface AcpConnection {
  send(message: JsonRpcRequest): void | Promise<void>
  close?(): void
}

export type AcpNotificationHandler = (message: JsonRpcNotification) => void

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

export function encodeJsonRpc(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`
}

export function decodeJsonRpc(line: string): JsonRpcMessage {
  const parsed: unknown = JSON.parse(line)
  if (!parsed || typeof parsed !== "object" || (parsed as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
    throw new KiroPluginError("Invalid JSON-RPC 2.0 message.", "KIRO_ACP_PROTOCOL_ERROR", 502)
  }
  return parsed as JsonRpcMessage
}

function hasId(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message
}

function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message)
}

function hasError(message: JsonRpcResponse): message is JsonRpcFailure {
  return "error" in message
}

export class AcpJsonRpcClient {
  #nextId = 1
  readonly #connection: AcpConnection
  readonly #pending = new Map<JsonRpcId, PendingRequest>()
  readonly #notifications = new Set<AcpNotificationHandler>()

  constructor(connection: AcpConnection) {
    this.#connection = connection
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++
    const message: JsonRpcRequest =
      params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }

    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
    })

    try {
      await this.#connection.send(message)
    } catch (error) {
      this.#pending.delete(id)
      throw error
    }

    return response
  }

  receive(message: JsonRpcMessage): void {
    if (isNotification(message)) {
      for (const handler of this.#notifications) handler(message)
      return
    }

    if (!hasId(message)) return

    const pending = this.#pending.get(message.id)
    if (!pending) return
    this.#pending.delete(message.id)

    if (hasError(message)) {
      pending.reject(new KiroPluginError(message.error.message, "KIRO_ACP_ERROR", 502))
      return
    }

    pending.resolve(message.result)
  }

  rejectAll(error: unknown): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error)
    }
    this.#pending.clear()
  }

  onNotification(handler: AcpNotificationHandler): () => void {
    this.#notifications.add(handler)
    return () => {
      this.#notifications.delete(handler)
    }
  }

  close(): void {
    this.#connection.close?.()
  }
}

export interface AcpStdioClientOptions {
  readonly command?: string
  readonly args?: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
}

export function createAcpStdioClient(options: AcpStdioClientOptions = {}): AcpJsonRpcClient {
  let client: AcpJsonRpcClient | undefined
  const child = spawn(options.command ?? "kiro-cli", [...(options.args ?? ["acp"])], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const connection: AcpConnection = {
    send(message) {
      if (!child.stdin?.writable) {
        throw new KiroPluginError("ACP process stdin is not writable.", "KIRO_ACP_PROCESS_ERROR", 502)
      }
      child.stdin.write(encodeJsonRpc(message))
    },
    close() {
      child.kill()
    },
  }
  client = new AcpJsonRpcClient(connection)

  let stdout = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8")
    for (;;) {
      const index = stdout.indexOf("\n")
      if (index < 0) break
      const line = stdout.slice(0, index).trim()
      stdout = stdout.slice(index + 1)
      if (!line) continue
      try {
        client?.receive(decodeJsonRpc(line))
      } catch (error) {
        client?.rejectAll(error)
      }
    }
  })
  child.on("error", (error) => {
    client?.rejectAll(new KiroPluginError(error.message, "KIRO_ACP_PROCESS_ERROR", 502))
  })
  child.on("exit", (code, signal) => {
    client?.rejectAll(
      new KiroPluginError(`ACP process exited${code === null ? "" : ` with code ${code}`}${signal ? ` and signal ${signal}` : ""}.`, "KIRO_ACP_PROCESS_EXITED", 502),
    )
  })

  return client
}
