export type BackendMode = "auto" | "fetch" | "cli-chat" | "acp"
export type ModelDiscoveryMode = "auto" | "off"

export interface KiroPluginOptions {
  readonly providerID: string
  readonly region: string
  readonly backend: BackendMode
  readonly modelDiscovery: ModelDiscoveryMode
  readonly modelCacheTtlSeconds: number
  readonly modelAliases: Readonly<Record<string, string>>
  readonly hiddenModels: Readonly<Record<string, string>>
  readonly disabledModels: ReadonlyArray<string>
  readonly disableModelPassThrough: boolean
  readonly trustAllTools: boolean
}

export const DEFAULT_PROVIDER_ID = "kiro"
export const DEFAULT_REGION = "us-east-1"
export const DEFAULT_MODEL_CACHE_TTL_SECONDS = 6 * 60 * 60

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

function positiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
  return value
}

export function loadOptions(raw: unknown = {}): KiroPluginOptions {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const backend: BackendMode =
    typeof input.backend === "string" && BACKENDS.has(input.backend as BackendMode) ? (input.backend as BackendMode) : "auto"
  const modelDiscovery =
    typeof input.modelDiscovery === "string" && DISCOVERY_MODES.has(input.modelDiscovery as ModelDiscoveryMode)
      ? (input.modelDiscovery as ModelDiscoveryMode)
      : "auto"

  return {
    providerID: typeof input.providerID === "string" && input.providerID ? input.providerID : DEFAULT_PROVIDER_ID,
    region: typeof input.region === "string" && input.region ? input.region : DEFAULT_REGION,
    backend,
    modelDiscovery,
    modelCacheTtlSeconds: positiveNumber(input.modelCacheTtlSeconds, DEFAULT_MODEL_CACHE_TTL_SECONDS),
    modelAliases: stringRecord(input.modelAliases),
    hiddenModels: stringRecord(input.hiddenModels),
    disabledModels: stringArray(input.disabledModels),
    disableModelPassThrough: input.disableModelPassThrough === true,
    trustAllTools: input.trustAllTools === true,
  }
}
