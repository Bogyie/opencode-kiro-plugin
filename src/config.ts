import type { KiroCliLoginOptions } from "./auth.js"

export type BackendMode = "auto" | "fetch" | "cli-chat" | "acp"
export type ModelDiscoveryMode = "auto" | "off"

export interface KiroPluginOptions {
  readonly providerID: string
  readonly region: string
  readonly login: KiroCliLoginOptions
  readonly endpoint?: string
  readonly backend: BackendMode
  readonly modelDiscovery: ModelDiscoveryMode
  readonly modelDiscoveryCommand: ReadonlyArray<string>
  readonly modelCacheTtlSeconds: number
  readonly requestTimeoutMs?: number
  readonly maxAttempts: number
  readonly profileArn?: string
  readonly userAgent?: string
  readonly agentMode?: string
  readonly modelAliases: Readonly<Record<string, string>>
  readonly extraModels: Readonly<Record<string, Record<string, unknown>>>
  readonly hiddenModels: Readonly<Record<string, string>>
  readonly disabledModels: ReadonlyArray<string>
  readonly disableModelPassThrough: boolean
  readonly trustAllTools: boolean
}

export const DEFAULT_PROVIDER_ID = "kiro"
export const DEFAULT_REGION = "us-east-1"
export const DEFAULT_MODEL_DISCOVERY_COMMAND = ["kiro-cli", "chat", "--list-models", "--format", "json"] as const
export const DEFAULT_MODEL_CACHE_TTL_SECONDS = 6 * 60 * 60
export const DEFAULT_MAX_ATTEMPTS = 3

const BACKENDS = new Set<BackendMode>(["auto", "fetch", "cli-chat", "acp"])
const DISCOVERY_MODES = new Set<ModelDiscoveryMode>(["auto", "off"])

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, item]) => [key, item]),
  )
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function objectRecord(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        Boolean(entry[0]) && Boolean(entry[1]) && typeof entry[1] === "object" && !Array.isArray(entry[1]),
    ),
  )
}

function positiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
  return value
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback
  return Math.max(1, Math.floor(value))
}

function optionalPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function loginOptions(value: unknown): KiroCliLoginOptions {
  const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const license = input.license === "free" || input.license === "pro" ? input.license : undefined
  const identityProvider = optionalString(input.identityProvider)
  const region = optionalString(input.region)
  const extraArgs = stringArray(input.extraArgs)
  return {
    ...(license ? { license } : {}),
    ...(identityProvider ? { identityProvider } : {}),
    ...(region ? { region } : {}),
    useDeviceFlow: input.useDeviceFlow === true,
    ...(extraArgs.length > 0 ? { extraArgs } : {}),
  }
}

export function loadOptions(raw: unknown = {}): KiroPluginOptions {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const backend: BackendMode =
    typeof input.backend === "string" && BACKENDS.has(input.backend as BackendMode) ? (input.backend as BackendMode) : "auto"
  const modelDiscovery =
    typeof input.modelDiscovery === "string" && DISCOVERY_MODES.has(input.modelDiscovery as ModelDiscoveryMode)
      ? (input.modelDiscovery as ModelDiscoveryMode)
      : "auto"
  const requestTimeoutMs = optionalPositiveNumber(input.requestTimeoutMs)
  const endpoint = optionalString(input.endpoint)
  const profileArn = optionalString(input.profileArn)
  const userAgent = optionalString(input.userAgent)
  const agentMode = optionalString(input.agentMode)
  const modelDiscoveryCommand =
    "modelDiscoveryCommand" in input ? stringArray(input.modelDiscoveryCommand) : [...DEFAULT_MODEL_DISCOVERY_COMMAND]

  return {
    providerID: typeof input.providerID === "string" && input.providerID ? input.providerID : DEFAULT_PROVIDER_ID,
    region: typeof input.region === "string" && input.region ? input.region : DEFAULT_REGION,
    login: loginOptions(input.login),
    ...(endpoint ? { endpoint } : {}),
    backend,
    modelDiscovery,
    modelDiscoveryCommand,
    modelCacheTtlSeconds: positiveNumber(input.modelCacheTtlSeconds, DEFAULT_MODEL_CACHE_TTL_SECONDS),
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    maxAttempts: positiveInteger(input.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    ...(profileArn ? { profileArn } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(agentMode ? { agentMode } : {}),
    modelAliases: stringRecord(input.modelAliases),
    extraModels: objectRecord(input.extraModels),
    hiddenModels: stringRecord(input.hiddenModels),
    disabledModels: stringArray(input.disabledModels),
    disableModelPassThrough: input.disableModelPassThrough === true,
    trustAllTools: input.trustAllTools === true,
  }
}
