import { execFile } from "node:child_process"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
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

export interface KiroCliSessionCredential {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt?: string
  readonly profileArn?: string
  readonly region: string
  readonly source: string
}

export interface KiroCliSessionCredentialOptions {
  readonly dbPath?: string
  readonly tokenKeys?: ReadonlyArray<string>
}

export interface KiroLoginSession {
  readonly url: string
  readonly code: string | undefined
  readonly instructions: string
  waitForPrompt(timeoutMs?: number): Promise<boolean>
  waitForAuth(runner?: CommandRunner): Promise<boolean>
}

export const KIRO_LOGIN_URL = "https://view.awsapps.com/start"
export const DEFAULT_KIRO_CLI_DB_PATH = join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3")
export const DEFAULT_KIRO_CLI_TOKEN_KEYS = ["kirocli:odic:token", "codewhisperer:odic:token"] as const
const LOGIN_REUSE_WINDOW_MS = 2 * 60 * 1000
let sharedLoginSession: KiroLoginSession | undefined
let sharedLoginStartedAt = 0

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

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function jsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function stringField(input: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input?.[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

export function regionFromProfileArn(profileArn: string | undefined): string | undefined {
  const match = /^arn:aws:codewhisperer:([^:]+):/.exec(profileArn?.trim() ?? "")
  return match?.[1]
}

async function sqliteValue(
  dbPath: string,
  table: "auth_kv" | "state",
  key: string,
  runner: CommandRunner,
): Promise<string | undefined> {
  if (!existsSync(dbPath)) return undefined
  const result = await runner("sqlite3", [dbPath, `select value from ${table} where key=${sqlString(key)} limit 1`], {
    timeoutMs: 5000,
  })
  if (!result.ok) return undefined
  const value = result.stdout.trim()
  return value || undefined
}

function profileArnFromState(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (value.startsWith("arn:aws:codewhisperer:")) return value
  const parsed = jsonObject(value)
  return stringField(parsed, "profileArn", "arn", "id")
}

export async function readKiroCliSessionCredential(
  options: KiroCliSessionCredentialOptions = {},
  runner: CommandRunner = runCommand,
): Promise<KiroCliSessionCredential | undefined> {
  const dbPath = options.dbPath ?? DEFAULT_KIRO_CLI_DB_PATH
  const tokenKeys = options.tokenKeys ?? DEFAULT_KIRO_CLI_TOKEN_KEYS
  const profileArn = profileArnFromState(await sqliteValue(dbPath, "state", "api.codewhisperer.profile", runner))

  for (const key of tokenKeys) {
    const raw = await sqliteValue(dbPath, "auth_kv", key, runner)
    const parsed = raw ? jsonObject(raw) : undefined
    const accessToken = stringField(parsed, "access_token", "accessToken", "token")
    if (!accessToken) continue
    const refreshToken = stringField(parsed, "refresh_token", "refreshToken")
    const expiresAt = stringField(parsed, "expires_at", "expiresAt", "expiration")
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(profileArn ? { profileArn } : {}),
      region: regionFromProfileArn(profileArn) ?? "us-east-1",
      source: key,
    }
  }

  return undefined
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

export function extractKiroLoginCode(output: string): string | undefined {
  return /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.exec(output)?.[0] ?? /\b[A-Z0-9]{8,}\b/.exec(output)?.[0]
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
    get code() {
      return extractKiroLoginCode(output)
    },
    get instructions() {
      const code = extractKiroLoginCode(output)
      return code ? `Enter code: ${code}` : "Complete Kiro CLI login in your browser. This window will close automatically."
    },
    async waitForPrompt(timeoutMs = 15_000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (extractKiroLoginCode(output)) return true
        if (firstUrl(output)) return true
        if (exited && exitCode !== 0) return false
        await delay(100)
      }
      return Boolean(extractKiroLoginCode(output) || firstUrl(output))
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

export function startKiroCliLoginOnce(
  spawner: ProcessSpawner = (command, args) => spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] }),
): KiroLoginSession {
  const now = Date.now()
  if (sharedLoginSession && now - sharedLoginStartedAt < LOGIN_REUSE_WINDOW_MS) return sharedLoginSession

  const session = startKiroCliLogin(spawner)
  const wrapped: KiroLoginSession = {
    get url() {
      return session.url
    },
    get code() {
      return session.code
    },
    get instructions() {
      return session.instructions
    },
    waitForPrompt(timeoutMs?: number): Promise<boolean> {
      return session.waitForPrompt(timeoutMs)
    },
    async waitForAuth(runner?: CommandRunner): Promise<boolean> {
      try {
        return await session.waitForAuth(runner)
      } finally {
        if (sharedLoginSession === wrapped) {
          sharedLoginSession = undefined
          sharedLoginStartedAt = 0
        }
      }
    },
  }
  sharedLoginSession = wrapped
  sharedLoginStartedAt = now
  return wrapped
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
