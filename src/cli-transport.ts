import type { CommandRunner } from "./auth.js"
import { runCommand } from "./auth.js"
import { KiroPluginError } from "./errors.js"
import type { KiroTransport } from "./fetch-adapter.js"
import type { KiroGenerateRequest } from "./request-adapter.js"
import type { KiroGenerateResponse } from "./response-adapter.js"

export interface CliChatTransportOptions {
  readonly runner?: CommandRunner
  readonly trustAllTools?: boolean
  readonly requestTimeoutMs?: number
}

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
    ...(options.trustAllTools ? ["--trust-all-tools"] : []),
    promptForCli(request),
  ]
}

export class KiroCliChatTransport implements KiroTransport {
  readonly #runner: CommandRunner
  readonly #trustAllTools: boolean
  readonly #requestTimeoutMs: number

  constructor(options: CliChatTransportOptions = {}) {
    this.#runner = options.runner ?? runCommand
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
    return {
      text: result.stdout.trim(),
      modelId: request.modelId,
    }
  }
}
