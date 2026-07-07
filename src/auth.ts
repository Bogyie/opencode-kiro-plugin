import { execFile } from "node:child_process"
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

export type CommandRunner = (command: string, args: ReadonlyArray<string>) => Promise<CommandResult>

export async function runCommand(command: string, args: ReadonlyArray<string>): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, [...args], { timeout: 5000 })
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
