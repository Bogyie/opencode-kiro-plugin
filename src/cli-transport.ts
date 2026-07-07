import type { CommandRunner } from "./auth.js"
import { runCommand } from "./auth.js"
import { KiroPluginError } from "./errors.js"
import type { KiroTransport } from "./fetch-adapter.js"
import type { KiroGenerateRequest } from "./request-adapter.js"
import type { KiroGenerateResponse, KiroStreamEvent } from "./response-adapter.js"
import { spawn, type ChildProcess } from "node:child_process"

export interface CliChatTransportOptions {
  readonly runner?: CommandRunner
  readonly spawner?: CliChatSpawner
  readonly trustAllTools?: boolean
  readonly requestTimeoutMs?: number
}

export type CliChatSpawner = (command: string, args: ReadonlyArray<string>) => ChildProcess

export function promptForCli(request: KiroGenerateRequest): string {
  const parts = [
    request.system ? `System:\n${request.system}` : "",
    ...request.history.map((turn) => `${turn.role}:\n${turn.content}`),
    `user:\n${request.prompt}`,
  ].filter(Boolean)
  return parts.join("\n\n")
}

export function cliChatArgs(request: KiroGenerateRequest, options: Pick<CliChatTransportOptions, "trustAllTools"> = {}): string[] {
  return [
    "chat",
    "--no-interactive",
    "--model",
    request.modelId,
    ...(options.trustAllTools ? ["--trust-all-tools"] : []),
    promptForCli(request),
  ]
}

export function sanitizeCliChatOutput(output: string): string {
  const text = output.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").replace(/\r/g, "")
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !line.includes("Credits:"))
  if (lines[0]?.trimStart().startsWith(">")) {
    lines[0] = lines[0].replace(/^\s*>\s*/, "")
  }
  return lines.join("\n").trim()
}

export function sanitizeCliChatStreamingOutput(output: string): string {
  const text = output.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").replace(/\r/g, "")
  const lines = text
    .split("\n")
    .filter((line) => !line.includes("Credits:"))
  if (lines[0]?.trimStart().startsWith(">")) {
    lines[0] = lines[0].replace(/^\s*>\s*/, "")
  }
  return lines.join("\n")
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

export class KiroCliChatTransport implements KiroTransport {
  readonly #runner: CommandRunner
  readonly #spawner: CliChatSpawner
  readonly #trustAllTools: boolean
  readonly #requestTimeoutMs: number

  constructor(options: CliChatTransportOptions = {}) {
    this.#runner = options.runner ?? runCommand
    this.#spawner = options.spawner ?? ((command, args) => spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] }))
    this.#trustAllTools = options.trustAllTools === true
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 120_000
  }

  async generate(request: KiroGenerateRequest): Promise<KiroGenerateResponse> {
    const result = await this.#runner("kiro-cli", cliChatArgs(request, { trustAllTools: this.#trustAllTools }), {
      timeoutMs: this.#requestTimeoutMs,
    })
    if (!result.ok) {
      const authError = result.stderr.toLowerCase().includes("not logged in")
      throw new KiroPluginError(
        result.stderr.trim() || "kiro-cli chat failed",
        authError ? "KIRO_AUTH_ERROR" : "KIRO_CLI_FAILED",
        authError ? 401 : 502,
      )
    }
    const text = sanitizeCliChatOutput(result.stdout)
    if (!text) {
      throw new KiroPluginError(
        result.stderr.trim() || "kiro-cli chat completed without returning assistant text",
        "KIRO_EMPTY_RESPONSE",
        502,
      )
    }
    return {
      text,
      modelId: request.modelId,
    }
  }

  async *stream(request: KiroGenerateRequest): AsyncIterable<KiroStreamEvent> {
    const child = this.#spawner("kiro-cli", cliChatArgs(request, { trustAllTools: this.#trustAllTools }))
    const queue = new AsyncQueue<KiroStreamEvent>()
    let rawStdout = ""
    let emittedText = ""
    let stderr = ""
    let sawText = false
    const timer = setTimeout(() => {
      child.kill()
      queue.fail(new KiroPluginError("Timed out waiting for kiro-cli chat response.", "KIRO_TIMEOUT", 504))
    }, this.#requestTimeoutMs)

    child.stdout?.on("data", (chunk: Buffer) => {
      rawStdout += chunk.toString("utf8")
      const cleaned = sanitizeCliChatStreamingOutput(rawStdout)
      if (!cleaned.startsWith(emittedText)) return
      const delta = cleaned.slice(emittedText.length)
      emittedText = cleaned
      if (!delta) return
      sawText = true
      queue.push({ type: "text", text: delta, modelId: request.modelId })
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      queue.fail(new KiroPluginError(error.message, "KIRO_CLI_FAILED", 502))
    })
    child.on("exit", (code, signal) => {
      clearTimeout(timer)
      if (code === 0) {
        if (sawText) queue.close()
        else queue.fail(new KiroPluginError(stderr.trim() || "kiro-cli chat completed without returning assistant text", "KIRO_EMPTY_RESPONSE", 502))
        return
      }
      const authError = stderr.toLowerCase().includes("not logged in")
      queue.fail(
        new KiroPluginError(
          stderr.trim() || `kiro-cli chat exited${code === null ? "" : ` with code ${code}`}${signal ? ` and signal ${signal}` : ""}`,
          authError ? "KIRO_AUTH_ERROR" : "KIRO_CLI_FAILED",
          authError ? 401 : 502,
        ),
      )
    })

    try {
      yield* queue
    } finally {
      clearTimeout(timer)
      if (!child.killed && child.exitCode === null) child.kill()
    }
  }
}
