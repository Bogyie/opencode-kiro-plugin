import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { KiroAcpTransport } from "./acp-transport.js"
import type { KiroAcpTransportOptions } from "./acp-transport.js"
import {
  credentialFromKiroDeviceAuthKey,
  detectAuth,
  isKiroDeviceAuthKey,
  readKiroCliSessionCredential,
  resolveApiKey,
  startKiroCliLoginOnce,
  runKiroLoginFlowOnce,
} from "./auth.js"
import { KiroCliChatTransport } from "./cli-transport.js"
import { loadOptions } from "./config.js"
import type { KiroPluginOptions } from "./config.js"
import { createKiroFetch, type KiroTransport } from "./fetch-adapter.js"
import { startLocalKiroServer, type LocalKiroServer } from "./local-server.js"
import type { CachedModelInfo } from "./model-cache.js"
import { ModelCache } from "./model-cache.js"
import { discoverModelsFromCommand } from "./model-discovery.js"
import { loadStoredModelCache, saveStoredModelCache } from "./model-cache-store.js"
import { ModelResolver, normalizeModelName } from "./model-resolver.js"
import { KiroRestTransport } from "./kiro-rest-transport.js"
import type { KiroRestTransportOptions } from "./kiro-rest-transport.js"
import type { ProviderModelConfig } from "./models.js"

type MutableConfig = Record<string, any>
type EffectiveBackend = "fetch" | "cli-chat" | "acp" | "none"
const PLACEHOLDER_MODEL_ID = "auto"
const PLACEHOLDER_MODEL: ProviderModelConfig = { name: "Auto" }

function discoveredProviderModels(cache: ModelCache): Record<string, ProviderModelConfig> {
  return Object.fromEntries(
    cache.all().map((model) => [
      model.id,
      {
        name: model.name ?? model.id,
        ...(model.contextLimit || model.outputLimit
          ? {
              limit: {
                context: model.contextLimit ?? 200_000,
                output: model.outputLimit ?? 64_000,
              },
            }
          : {}),
      },
    ]),
  )
}

function modelRecord(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        Boolean(entry[0]) && Boolean(entry[1]) && typeof entry[1] === "object" && !Array.isArray(entry[1]),
    ),
  )
}

function visibleProviderModels(
  cache: ModelCache,
  configuredModels: Record<string, Record<string, unknown>>,
  hiddenModels: Readonly<Record<string, string>>,
  disabledModels: ReadonlySet<string>,
): Record<string, ProviderModelConfig> {
  const discovered = discoveredProviderModels(cache)
  const modelIDs = new Set([...Object.keys(discovered), ...Object.keys(configuredModels), ...Object.keys(hiddenModels)])
  const models = Object.fromEntries(
    [...modelIDs]
      .filter((id) => !disabledModels.has(normalizeModelName(id)))
      .map((id) => [
        id,
        {
          ...(discovered[id] ?? {}),
          ...(configuredModels[id] ?? {}),
        },
      ]),
  )
  if (Object.keys(models).length > 0 || disabledModels.has(PLACEHOLDER_MODEL_ID)) return models
  return { [PLACEHOLDER_MODEL_ID]: PLACEHOLDER_MODEL }
}

function extraModelInfos(models: Readonly<Record<string, Record<string, unknown>>>): CachedModelInfo[] {
  return Object.keys(models).map((id) => ({ id: normalizeModelName(id) }))
}

function mergeModelInfos(discovered: ReadonlyArray<CachedModelInfo>, extraModels: Readonly<Record<string, Record<string, unknown>>>): CachedModelInfo[] {
  return [...new Map([...discovered, ...extraModelInfos(extraModels)].map((model) => [model.id, model])).values()]
}

function bearerToken(init: RequestInit | undefined): string | undefined {
  const header = new Headers(init?.headers).get("authorization")
  const match = header?.match(/^Bearer\s+(.+)$/i)
  return match?.[1] || undefined
}

export function effectiveBackend(options: Pick<KiroPluginOptions, "backend">, accessToken?: string): EffectiveBackend {
  const apiKey = accessToken || process.env.KIRO_API_KEY
  if (options.backend === "acp") return "acp"
  if (options.backend === "cli-chat") return "cli-chat"
  if (options.backend === "fetch") return "fetch"
  if (apiKey && apiKey !== "kiro-plugin-local-transport") return "fetch"
  return "fetch"
}

function localTransport(options: KiroPluginOptions, accessToken?: string): KiroTransport | undefined {
  const backend = effectiveBackend(options, accessToken)
  const login = () =>
    runKiroLoginFlowOnce({
      login: {
        ...options.login,
        useDeviceFlow: true,
      },
    })
  if (backend === "acp") return new KiroAcpTransport(acpTransportOptions(options))
  if (backend === "cli-chat") {
    return new KiroCliChatTransport({
      trustAllTools: options.trustAllTools,
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      login,
    })
  }
  if (backend === "fetch") {
    const apiKey = accessToken || process.env.KIRO_API_KEY
    if (isKiroDeviceAuthKey(apiKey)) {
      return new KiroRestTransport(fetchTransportOptions(options), {
        credentialProvider: async () =>
          (await credentialFromKiroDeviceAuthKey(apiKey as string).catch(() => undefined)) ?? readKiroCliSessionCredential(),
        login,
      })
    }
    return new KiroRestTransport(fetchTransportOptions(options, apiKey === "kiro-plugin-local-transport" ? undefined : apiKey), {
      login,
    })
  }
  return undefined
}

export function acpTransportOptions(options: Pick<KiroPluginOptions, "requestTimeoutMs" | "trustAllTools">): KiroAcpTransportOptions {
  return {
    trustAllTools: options.trustAllTools,
    ...(options.requestTimeoutMs ? { promptTimeoutMs: options.requestTimeoutMs } : {}),
  }
}

export function fetchTransportOptions(
  options: Pick<KiroPluginOptions, "region" | "endpoint" | "profileArn" | "userAgent" | "agentMode" | "maxAttempts" | "requestTimeoutMs">,
  accessToken?: string,
): KiroRestTransportOptions {
  return {
    region: options.region,
    ...(accessToken ? { accessToken } : {}),
    maxAttempts: options.maxAttempts,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.profileArn ? { profileArn: options.profileArn } : {}),
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    ...(options.agentMode ? { agentMode: options.agentMode } : {}),
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  }
}

export function createKiroPlugin(): Plugin {
  return async (_input, rawOptions): Promise<Hooks> => {
    const options = loadOptions(rawOptions)
    const modelCache = new ModelCache(options.modelCacheTtlSeconds)
    let localServer: LocalKiroServer | undefined
    let configuredModels: Record<string, Record<string, unknown>> = { ...options.extraModels }
    let userModelOverrides: Record<string, Record<string, unknown>> | undefined
    const disabledModels = new Set(options.disabledModels.map(normalizeModelName))
    const stored = await loadStoredModelCache()
    if (stored.models.length > 0) {
      modelCache.update(mergeModelInfos(stored.models, options.extraModels), stored.updatedAt)
    } else if (Object.keys(options.extraModels).length > 0) {
      modelCache.update(extraModelInfos(options.extraModels))
    }
    let discovery: Promise<CachedModelInfo[]> | undefined
    let lastModelDiscoveryAt = 0
    const refreshModels = async (force = false) => {
      const discoveryIsStale = lastModelDiscoveryAt === 0 || Date.now() - lastModelDiscoveryAt > options.modelCacheTtlSeconds * 1000
      if (options.modelDiscovery === "off" || options.modelDiscoveryCommand.length === 0 || (!force && !discoveryIsStale)) {
        return []
      }
      if (!discovery) {
        discovery = discoverModelsFromCommand(
          options.modelDiscoveryCommand[0] as string,
          options.modelDiscoveryCommand.slice(1),
        )
          .then((models) => {
            if (models.length > 0) {
              lastModelDiscoveryAt = Date.now()
              modelCache.update(mergeModelInfos(models, options.extraModels), lastModelDiscoveryAt)
              void saveStoredModelCache(models, lastModelDiscoveryAt)
            }
            return models
          })
          .catch(() => [])
          .finally(() => {
            discovery = undefined
          })
      }
      return discovery
    }
    const resolver = new ModelResolver({
      cache: modelCache,
      aliases: options.modelAliases,
      hiddenModels: options.hiddenModels,
      disabledModels: options.disabledModels,
      disablePassThrough: options.disableModelPassThrough,
    })
    const ensureLocalServer = async () => {
      if (localServer) return localServer
      const localFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const transport = localTransport(options, bearerToken(init))
        return createKiroFetch({
          resolver,
          models: async () => {
            await refreshModels(true).catch(() => [])
            return Object.keys(visibleProviderModels(modelCache, configuredModels, options.hiddenModels, disabledModels))
          },
          ...(transport ? { transport } : {}),
        })(input, init)
      }
      localServer = await startLocalKiroServer(localFetch)
      return localServer
    }

    const authorizeCliDeviceLogin = async () => {
      const session = startKiroCliLoginOnce({
        ...options.login,
        useDeviceFlow: true,
      })
      await session.waitForPrompt(options.requestTimeoutMs)
      return {
        url: session.url,
        instructions: session.instructions,
        method: "auto" as const,
        callback: async () => {
          const authenticated = await session.waitForAuth()
          if (!authenticated) return { type: "failed" as const }
          await refreshModels(true).catch(() => [])
          return {
            type: "success" as const,
            key: "kiro-plugin-local-transport",
            metadata: {
              source: "kiro-cli-device-flow",
            },
          }
        },
      }
    }

    return {
      dispose: async () => {
        await localServer?.close()
        localServer = undefined
      },
      config: async (config: MutableConfig) => {
        await refreshModels()
        config.provider ??= {}
        config.provider[options.providerID] ??= {}
        const provider = config.provider[options.providerID]
        const server = await ensureLocalServer()
        userModelOverrides ??= modelRecord(provider.models)
        configuredModels = {
          ...options.extraModels,
          ...userModelOverrides,
        }
        provider.name ??= "Kiro"
        provider.npm = "@ai-sdk/openai-compatible"
        provider.api = server.baseURL
        provider.options ??= {}
        provider.models = visibleProviderModels(modelCache, configuredModels, options.hiddenModels, disabledModels)
      },
      auth: {
        provider: options.providerID,
        methods: [
          {
            type: "oauth",
            label: "Kiro device login",
            authorize: async () => authorizeCliDeviceLogin(),
          },
          {
            type: "api",
            label: "Kiro API key",
            prompts: [
              {
                type: "text",
                key: "apiKey",
                message: "Enter KIRO_API_KEY",
                placeholder: "ksk_...",
              },
            ],
            authorize: async (inputs) => {
              const key = inputs?.apiKey
              if (!key) return { type: "failed" }
              return { type: "success", key }
            },
          },
        ],
        loader: async (auth) => {
          const apiKey = await resolveApiKey(auth)
          const server = await ensureLocalServer()
          return {
            apiKey: apiKey || "kiro-plugin-local-transport",
            baseURL: server.baseURL,
          }
        },
      },
      tool: {
        kiro_status: tool({
          description: "Show Kiro plugin backend, auth, region, and discovered model status.",
          args: {},
          execute: async () => {
            const auth = await detectAuth()
            return {
              title: "Kiro status",
              output: [
                `provider: ${options.providerID}`,
                `backend: ${options.backend}`,
                `effective backend: ${effectiveBackend(options)}`,
                `region: ${auth.region}`,
                `auth: ${auth.method}`,
                `authenticated: ${auth.authenticated ? "yes" : "no"}`,
                `models: ${modelCache.ids().length} discovered/cache entries`,
                auth.message,
              ].join("\n"),
              metadata: {
                providerID: options.providerID,
                backend: options.backend,
                effectiveBackend: effectiveBackend(options),
                region: auth.region,
                authMethod: auth.method,
                authenticated: auth.authenticated,
              },
            }
          },
        }),
        kiro_refresh_models: tool({
          description: "Refresh the cached Kiro model list on demand.",
          args: {},
          execute: async () => {
            const models = await refreshModels(true)
            const cached = modelCache.ids()
            return {
              title: models.length > 0 ? "Kiro models refreshed" : "Kiro model refresh skipped",
              output:
                models.length > 0
                  ? `refreshed: ${models.length}\ncached: ${cached.length}`
                  : `No models were discovered. Keeping cached models: ${cached.length}`,
              metadata: {
                refreshed: models.length > 0,
                discovered: models.length,
                cached: cached.length,
              },
            }
          },
        }),
      },
      provider: {
        id: options.providerID,
        models: async (provider) => {
          const existing = modelRecord(provider.models)
          const visibleModels = visibleProviderModels(modelCache, configuredModels, options.hiddenModels, disabledModels)
          const server = await ensureLocalServer()
          return Object.fromEntries(
            Object.keys(visibleModels)
              .map((id) => {
                const model = {
                  ...(visibleModels[id] ?? {}),
                  ...(existing[id] ?? {}),
                }
                return [
                  id,
                  {
                    ...model,
                    api: {
                      ...((model as { api?: Record<string, unknown> }).api ?? {}),
                      id,
                      npm: "@ai-sdk/openai-compatible",
                      url: server.baseURL,
                    },
                  },
                ]
              }),
          ) as any
        },
      },
    }
  }
}

export const KiroPlugin = createKiroPlugin()
