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

export type KiroAuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface KiroLoginSession {
  readonly url: string
  readonly code: string | undefined
  readonly instructions: string
  waitForPrompt(timeoutMs?: number): Promise<boolean>
  waitForAuth(runner?: CommandRunner): Promise<boolean>
}

export interface KiroCliLoginOptions {
  readonly license?: "free" | "pro"
  readonly identityProvider?: string
  readonly region?: string
  readonly useDeviceFlow?: boolean
  readonly extraArgs?: ReadonlyArray<string>
}

export interface KiroDeviceAuthorization {
  readonly verificationUrl: string
  readonly verificationUrlComplete: string
  readonly userCode: string
  readonly deviceCode: string
  readonly clientId: string
  readonly clientSecret: string
  readonly intervalSeconds: number
  readonly expiresInSeconds: number
  readonly oidcRegion: string
  readonly startUrl: string
}

export interface KiroDeviceAuthCredential {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly clientId: string
  readonly clientSecret: string
  readonly oidcRegion: string
  readonly region: string
  readonly startUrl: string
  readonly profileArn?: string
}

export interface KiroLoginFlowOptions {
  readonly spawner?: ProcessSpawner
  readonly runner?: CommandRunner
  readonly promptTimeoutMs?: number
  readonly login?: KiroCliLoginOptions
}

export const KIRO_LOGIN_URL = "https://view.awsapps.com/start"
export const DEFAULT_KIRO_CLI_DB_PATH = join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3")
export const DEFAULT_KIRO_CLI_TOKEN_KEYS = ["kirocli:odic:token", "codewhisperer:odic:token"] as const
const KIRO_DEVICE_AUTH_KEY_PREFIX = "kiro-device:"
const KIRO_OIDC_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
] as const
const LOGIN_REUSE_WINDOW_MS = 2 * 60 * 1000
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
let sharedLoginSession: KiroLoginSession | undefined
let sharedLoginStartedAt = 0
let sharedLoginSessionKey = ""
let sharedLoginFlow: Promise<boolean> | undefined
let sharedLoginFlowKey = ""
const refreshedDeviceCredentials = new Map<string, KiroDeviceAuthCredential>()
const deviceRefreshes = new Map<string, Promise<KiroDeviceAuthCredential>>()

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

function numberField(input: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = input?.[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
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

function normalizeStartUrl(raw: string | undefined): string {
  const value = raw?.trim() || KIRO_LOGIN_URL
  const url = new URL(value)
  url.hash = ""
  url.search = ""
  if (url.pathname.endsWith("/start/")) url.pathname = url.pathname.replace(/\/start\/$/, "/start")
  if (!url.pathname.endsWith("/start")) url.pathname = `${url.pathname.replace(/\/+$/, "")}/start`
  return url.toString()
}

export function kiroDeviceVerificationUrl(startUrl: string, userCode: string): string {
  const url = new URL(startUrl)
  url.search = ""
  if (url.pathname.endsWith("/start")) url.pathname = `${url.pathname}/`
  url.pathname = url.pathname.replace(/\/start\/?$/, "/start/")
  url.hash = `#/device?user_code=${encodeURIComponent(userCode)}`
  return url.toString()
}

function oidcEndpoint(region: string): string {
  return `https://oidc.${region || "us-east-1"}.amazonaws.com`
}

function deviceAuthUserAgent(): string {
  return "KiroIDE"
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  const parsed = jsonObject(text)
  if (!parsed) throw new Error(`Kiro auth returned invalid JSON: ${text.slice(0, 200)}`)
  if (!response.ok) {
    const message = stringField(parsed, "message", "error_description", "error") ?? text.slice(0, 200)
    throw new Error(`Kiro auth request failed: HTTP ${response.status} ${message}`)
  }
  return parsed
}

export async function authorizeKiroDevice(
  options: KiroCliLoginOptions = {},
  fetcher: KiroAuthFetch = fetch,
): Promise<KiroDeviceAuthorization> {
  const oidcRegion = options.region || "us-east-1"
  const startUrl = normalizeStartUrl(options.identityProvider)
  const endpoint = oidcEndpoint(oidcRegion)
  const register = await jsonResponse(
    await fetcher(`${endpoint}/client/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": deviceAuthUserAgent(),
      },
      body: JSON.stringify({
        clientName: "Kiro IDE",
        clientType: "public",
        scopes: KIRO_OIDC_SCOPES,
        grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      }),
    }),
  )
  const clientId = stringField(register, "clientId", "client_id")
  const clientSecret = stringField(register, "clientSecret", "client_secret")
  if (!clientId || !clientSecret) throw new Error("Kiro auth client registration did not return client credentials.")

  const authorization = await jsonResponse(
    await fetcher(`${endpoint}/device_authorization`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": deviceAuthUserAgent(),
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        startUrl,
      }),
    }),
  )
  const verificationUrl = stringField(authorization, "verificationUri", "verification_uri")
  const verificationUrlComplete = stringField(authorization, "verificationUriComplete", "verification_uri_complete")
  const userCode = stringField(authorization, "userCode", "user_code")
  const deviceCode = stringField(authorization, "deviceCode", "device_code")
  if (!verificationUrl || !verificationUrlComplete || !userCode || !deviceCode) {
    throw new Error("Kiro device authorization response did not return required fields.")
  }
  return {
    verificationUrl,
    verificationUrlComplete,
    userCode,
    deviceCode,
    clientId,
    clientSecret,
    intervalSeconds: numberField(authorization, "interval") ?? 5,
    expiresInSeconds: numberField(authorization, "expiresIn", "expires_in") ?? 600,
    oidcRegion,
    startUrl,
  }
}

export async function pollKiroDeviceToken(
  authorization: KiroDeviceAuthorization,
  options: Pick<KiroDeviceAuthCredential, "region" | "profileArn">,
  fetcher: KiroAuthFetch = fetch,
): Promise<KiroDeviceAuthCredential> {
  const maxAttempts = Math.max(1, Math.floor(authorization.expiresInSeconds / authorization.intervalSeconds))
  let intervalMs = authorization.intervalSeconds * 1000

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await delay(intervalMs)
    const response = await fetcher(`${oidcEndpoint(authorization.oidcRegion)}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": deviceAuthUserAgent(),
      },
      body: JSON.stringify({
        clientId: authorization.clientId,
        clientSecret: authorization.clientSecret,
        deviceCode: authorization.deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })
    const data = await response.text().then((text) => jsonObject(text) ?? {})
    const error = stringField(data, "error")
    if (error === "authorization_pending") continue
    if (error === "slow_down") {
      intervalMs += 5000
      continue
    }
    if (error) {
      const description = stringField(data, "error_description") ?? ""
      throw new Error(`Kiro device authorization failed: ${error}${description ? ` - ${description}` : ""}`)
    }
    if (!response.ok) {
      throw new Error(`Kiro device token request failed: HTTP ${response.status}`)
    }

    const accessToken = stringField(data, "access_token", "accessToken")
    const refreshToken = stringField(data, "refresh_token", "refreshToken")
    if (!accessToken || !refreshToken) throw new Error("Kiro device token response did not return access and refresh tokens.")
    const expiresIn = numberField(data, "expires_in", "expiresIn") ?? 3600
    return {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      clientId: authorization.clientId,
      clientSecret: authorization.clientSecret,
      oidcRegion: authorization.oidcRegion,
      region: options.profileArn ? (regionFromProfileArn(options.profileArn) ?? options.region) : options.region,
      startUrl: authorization.startUrl,
      ...(options.profileArn ? { profileArn: options.profileArn } : {}),
    }
  }

  throw new Error("Kiro device authorization timed out.")
}

export async function refreshKiroDeviceAuthCredential(
  credential: KiroDeviceAuthCredential,
  fetcher: KiroAuthFetch = fetch,
): Promise<KiroDeviceAuthCredential> {
  const data = await jsonResponse(
    await fetcher(`${oidcEndpoint(credential.oidcRegion)}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": deviceAuthUserAgent(),
      },
      body: JSON.stringify({
        refreshToken: credential.refreshToken,
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
        grantType: "refresh_token",
      }),
    }),
  )
  const accessToken = stringField(data, "access_token", "accessToken")
  if (!accessToken) throw new Error("Kiro refresh token response did not return an access token.")
  const refreshToken = stringField(data, "refresh_token", "refreshToken") ?? credential.refreshToken
  const expiresIn = numberField(data, "expires_in", "expiresIn") ?? 3600
  return {
    ...credential,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  }
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8")
}

export function encodeKiroDeviceAuthKey(credential: KiroDeviceAuthCredential): string {
  return `${KIRO_DEVICE_AUTH_KEY_PREFIX}${base64UrlEncode(JSON.stringify(credential))}`
}

export function decodeKiroDeviceAuthKey(key: string | undefined): KiroDeviceAuthCredential | undefined {
  try {
    if (!key?.startsWith(KIRO_DEVICE_AUTH_KEY_PREFIX)) return undefined
    const parsed = jsonObject(base64UrlDecode(key.slice(KIRO_DEVICE_AUTH_KEY_PREFIX.length)))
    const accessToken = stringField(parsed, "accessToken")
    const refreshToken = stringField(parsed, "refreshToken")
    const expiresAt = numberField(parsed, "expiresAt")
    const clientId = stringField(parsed, "clientId")
    const clientSecret = stringField(parsed, "clientSecret")
    const oidcRegion = stringField(parsed, "oidcRegion")
    const region = stringField(parsed, "region")
    const startUrl = stringField(parsed, "startUrl")
    if (!accessToken || !refreshToken || !expiresAt || !clientId || !clientSecret || !oidcRegion || !region || !startUrl) return undefined
    const profileArn = stringField(parsed, "profileArn")
    return {
      accessToken,
      refreshToken,
      expiresAt,
      clientId,
      clientSecret,
      oidcRegion,
      region,
      startUrl,
      ...(profileArn ? { profileArn } : {}),
    }
  } catch {
    return undefined
  }
}

export function isKiroDeviceAuthKey(key: string | undefined): boolean {
  return Boolean(decodeKiroDeviceAuthKey(key))
}

export async function credentialFromKiroDeviceAuthKey(
  key: string,
  fetcher: KiroAuthFetch = fetch,
): Promise<KiroCliSessionCredential | undefined> {
  const cached = refreshedDeviceCredentials.get(key)
  let credential = cached ?? decodeKiroDeviceAuthKey(key)
  if (!credential) return undefined
  if (credential.expiresAt <= Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    let refresh = deviceRefreshes.get(key)
    if (!refresh) {
      refresh = refreshKiroDeviceAuthCredential(credential, fetcher).finally(() => {
        deviceRefreshes.delete(key)
      })
      deviceRefreshes.set(key, refresh)
    }
    credential = await refresh
    refreshedDeviceCredentials.set(key, credential)
  }
  return {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAt: new Date(credential.expiresAt).toISOString(),
    ...(credential.profileArn ? { profileArn: credential.profileArn } : {}),
    region: regionFromProfileArn(credential.profileArn) ?? credential.region,
    source: "opencode-device-auth",
  }
}

function urls(text: string): string[] {
  return text.match(/https?:\/\/[^\s"'<>]+/g) ?? []
}

function isLocalCallbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    return (
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") &&
      url.pathname.includes("/callback")
    )
  } catch {
    return false
  }
}

function loginUrlFromLocalCallbackUrl(value: string): string | undefined {
  if (!isLocalCallbackUrl(value)) return undefined
  try {
    const issuerUrl = new URL(value).searchParams.get("issuer_url")
    if (!issuerUrl || isLocalCallbackUrl(issuerUrl)) return undefined
    const parsed = new URL(issuerUrl)
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

function isKiroSigninUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname.toLowerCase() === "app.kiro.dev" && url.pathname === "/signin"
  } catch {
    return false
  }
}

function firstLoginUrl(text: string): string | undefined {
  const candidates = urls(text)
  const kiroSigninUrl = candidates.find(isKiroSigninUrl)
  if (kiroSigninUrl) return kiroSigninUrl

  for (const url of candidates) {
    const callbackLoginUrl = loginUrlFromLocalCallbackUrl(url)
    if (callbackLoginUrl) return callbackLoginUrl
    if (!isLocalCallbackUrl(url)) return url
  }
  return undefined
}

export function extractKiroLoginUrl(output: string): string {
  return firstLoginUrl(output) ?? KIRO_LOGIN_URL
}

export function extractKiroLoginCode(output: string): string | undefined {
  return /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.exec(output)?.[0] ?? /\b[A-Z0-9]{8,}\b/.exec(output)?.[0]
}

function defaultSpawner(command: string, args: ReadonlyArray<string>): ChildProcess {
  return spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] })
}

function loginKey(options: KiroCliLoginOptions = {}): string {
  return JSON.stringify(kiroCliLoginArgs(options))
}

function loginOptionsAndSpawner(
  optionsOrSpawner: KiroCliLoginOptions | ProcessSpawner | undefined,
  spawner: ProcessSpawner | undefined,
): { options: KiroCliLoginOptions; spawner: ProcessSpawner } {
  if (typeof optionsOrSpawner === "function") return { options: {}, spawner: optionsOrSpawner }
  return { options: optionsOrSpawner ?? {}, spawner: spawner ?? defaultSpawner }
}

export function kiroCliLoginArgs(options: KiroCliLoginOptions = {}): string[] {
  const args = ["login"]
  if (options.license) args.push("--license", options.license)
  if (options.identityProvider) args.push("--identity-provider", options.identityProvider)
  if (options.region) args.push("--region", options.region)
  if (options.useDeviceFlow) args.push("--use-device-flow")
  args.push(...(options.extraArgs ?? []))
  return args
}

export function startKiroCliLogin(
  optionsOrSpawner?: KiroCliLoginOptions | ProcessSpawner,
  spawner?: ProcessSpawner,
): KiroLoginSession {
  const resolved = loginOptionsAndSpawner(optionsOrSpawner, spawner)
  const child = resolved.spawner("kiro-cli", kiroCliLoginArgs(resolved.options))
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
        if (firstLoginUrl(output)) return true
        if (exited && exitCode !== 0) return false
        await delay(100)
      }
      return Boolean(extractKiroLoginCode(output) || firstLoginUrl(output))
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
  optionsOrSpawner?: KiroCliLoginOptions | ProcessSpawner,
  spawner?: ProcessSpawner,
): KiroLoginSession {
  const resolved = loginOptionsAndSpawner(optionsOrSpawner, spawner)
  const key = loginKey(resolved.options)
  const now = Date.now()
  if (sharedLoginSession && sharedLoginSessionKey === key && now - sharedLoginStartedAt < LOGIN_REUSE_WINDOW_MS) {
    return sharedLoginSession
  }

  const session = startKiroCliLogin(resolved.options, resolved.spawner)
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
          sharedLoginSessionKey = ""
        }
      }
    },
  }
  sharedLoginSession = wrapped
  sharedLoginStartedAt = now
  sharedLoginSessionKey = key
  return wrapped
}

export async function runKiroLoginFlowOnce(options: KiroLoginFlowOptions = {}): Promise<boolean> {
  const key = loginKey(options.login)
  if (!sharedLoginFlow || sharedLoginFlowKey !== key) {
    sharedLoginFlowKey = key
    sharedLoginFlow = (async () => {
      const session = startKiroCliLoginOnce(options.login, options.spawner)
      await session.waitForPrompt(options.promptTimeoutMs)
      return session.waitForAuth(options.runner)
    })().finally(() => {
      sharedLoginFlow = undefined
      sharedLoginFlowKey = ""
    })
  }
  return sharedLoginFlow
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
  auth: () => Promise<{ type: string; key?: string; access?: string }>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (env.KIRO_API_KEY) return env.KIRO_API_KEY
  try {
    const credential = await auth()
    return credential.key || credential.access || ""
  } catch {
    return ""
  }
}
