import type { AuthDiagnostics, CommandRunner } from "./auth.js"
import { detectAuth, runCommand } from "./auth.js"

export interface KiroCliStatus {
  readonly installed: boolean
  readonly version?: string
  readonly auth: AuthDiagnostics
}

export async function getKiroCliVersion(runner: CommandRunner = runCommand): Promise<string | undefined> {
  const result = await runner("kiro-cli", ["--version"])
  if (!result.ok) return undefined
  return result.stdout.trim() || undefined
}

export async function getKiroCliStatus(
  env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): Promise<KiroCliStatus> {
  const version = await getKiroCliVersion(runner)
  const auth = await detectAuth(env, runner)
  return {
    installed: version !== undefined,
    auth,
    ...(version ? { version } : {}),
  }
}
