import { execFile } from "node:child_process"
import { spawn, type ChildProcess } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type AuthMethod = "api-key" | "cli-session" | "none"

export interface AuthDiagnostics {
  readonly authenticated: boolean
  readonly method: AuthMethod
  readonly region: string
  readonly message: string
  readonly account?: string
}

export interface CommandResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  readonly error?: unknown
}

export interface CommandRunOptions {
  readonly timeoutMs?: number
}

export type CommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
  options?: CommandRunOptions,
) => Promise<CommandResult>

export type ProcessSpawner = (command: string, args: ReadonlyArray<string>) => ChildProcess

export interface KiroLoginSession {
  readonly url: string
  readonly instructions: string
  waitForAuth(runner?: CommandRunner): Promise<boolean>
}

export const KIRO_LOGIN_URL = "https://view.awsapps.com/start"

export async function runCommand(command: string, args: ReadonlyArray<string>, options: CommandRunOptions = {}): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, [...args], { timeout: options.timeoutMs ?? 5000 })
    return { ok: true, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const partial = error as { stdout?: string; stderr?: string }
    return {
      ok: false,
      stdout: partial.stdout ?? "",
      stderr: partial.stderr ?? "",
      error,
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function firstUrl(text: string): string | undefined {
  return /https?:\/\/[^\s"'<>]+/.exec(text)?.[0]
}

export function extractKiroLoginUrl(output: string): string {
  return firstUrl(output) ?? KIRO_LOGIN_URL
}

export function startKiroCliLogin(spawner: ProcessSpawner = (command, args) => spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] })): KiroLoginSession {
  const child = spawner("kiro-cli", ["login", "--use-device-flow"])
  let output = ""
  let exited = false
  let exitCode: number | null = null

  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8")
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8")
  })
  child.on("exit", (code) => {
    exited = true
    exitCode = code
  })

  return {
    get url() {
      return extractKiroLoginUrl(output)
    },
    get instructions() {
      const url = extractKiroLoginUrl(output)
      const code = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.exec(output)?.[0] ?? /\b[A-Z0-9]{8,}\b/.exec(output)?.[0]
      return [
        "Complete Kiro CLI login in the browser.",
        `URL: ${url}`,
        ...(code ? [`Code: ${code}`] : []),
        "The plugin will continue after `kiro-cli whoami` succeeds.",
      ].join("\n")
    },
    async waitForAuth(runner: CommandRunner = runCommand): Promise<boolean> {
      const deadline = Date.now() + 10 * 60 * 1000
      while (Date.now() < deadline) {
        const auth = await detectAuth(process.env, runner)
        if (auth.authenticated) return true
        if (exited && exitCode !== 0) return false
        await delay(2000)
      }
      return false
    },
  }
}

export function redacted(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (value.length <= 8) return "***"
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

function parseWhoami(stdout: string): string | undefined {
  const trimmed = stdout.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed) as { email?: unknown; username?: unknown; account?: unknown }
    const account = parsed.email ?? parsed.username ?? parsed.account
    return typeof account === "string" ? account : undefined
  } catch {
    return trimmed.split(/\s+/)[0]
  }
}

export async function detectAuth(
  env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): Promise<AuthDiagnostics> {
  const region = env.KIRO_REGION || env.AWS_REGION || "us-east-1"
  if (env.KIRO_API_KEY) {
    return {
      authenticated: true,
      method: "api-key",
      region,
      message: `Using KIRO_API_KEY (${redacted(env.KIRO_API_KEY)})`,
    }
  }

  const whoami = await runner("kiro-cli", ["whoami"])
  if (whoami.ok) {
    const account = parseWhoami(whoami.stdout)
    return {
      authenticated: true,
      method: "cli-session",
      region,
      message: account ? `Using kiro-cli session for ${account}` : "Using active kiro-cli session",
      ...(account ? { account } : {}),
    }
  }

  return {
    authenticated: false,
    method: "none",
    region,
    message: "No KIRO_API_KEY or active kiro-cli session found. Run `kiro-cli login` or configure KIRO_API_KEY.",
  }
}

export async function resolveApiKey(
  auth: () => Promise<{ type: string; key?: string }>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (env.KIRO_API_KEY) return env.KIRO_API_KEY
  try {
    const credential = await auth()
    return credential.type === "api" && credential.key ? credential.key : ""
  } catch {
    return ""
  }
}
