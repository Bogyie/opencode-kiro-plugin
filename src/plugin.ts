import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { KiroAcpTransport } from "./acp-transport.js"
import type { KiroAcpTransportOptions } from "./acp-transport.js"
import {
  authorizeKiroDevice,
  credentialFromKiroDeviceAuthKey,
  detectAuth,
  encodeKiroDeviceAuthKey,
  isKiroDeviceAuthKey,
  kiroDeviceVerificationUrl,
  pollKiroDeviceToken,
  readKiroCliSessionCredential,
  resolveApiKey,
  runKiroLoginFlowOnce,
} from "./auth.js"
import { KiroCliChatTransport } from "./cli-transport.js"
import { loadOptions } from "./config.js"
import type { KiroPluginOptions } from "./config.js"
import { createKiroFetch, type KiroTransport } from "./fetch-adapter.js"
import { startLocalKiroServer, type LocalKiroServer } from "./local-server.js"
import { ModelCache } from "./model-cache.js"
import { refreshModelCacheFromCommand } from "./model-discovery.js"
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

function bearerToken(init: RequestInit | undefined): string | undefined {
  const header = new Headers(init?.headers).get("authorization")
  const match = header?.match(/^Bearer\s+(.+)$/i)
  return match?.[1] || undefined
}

function inputString(inputs: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = inputs?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
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
  if (backend === "acp") return new KiroAcpTransport(acpTransportOptions(options))
  if (backend === "cli-chat") {
    return new KiroCliChatTransport({
      trustAllTools: options.trustAllTools,
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      login: () => runKiroLoginFlowOnce({ login: options.login }),
    })
  }
  if (backend === "fetch") {
    const apiKey = accessToken || process.env.KIRO_API_KEY
    if (isKiroDeviceAuthKey(apiKey)) {
      return new KiroRestTransport(fetchTransportOptions(options), {
        credentialProvider: async () =>
          (await credentialFromKiroDeviceAuthKey(apiKey as string).catch(() => undefined)) ?? readKiroCliSessionCredential(),
        login: () => runKiroLoginFlowOnce({ login: options.login }),
      })
    }
    return new KiroRestTransport(fetchTransportOptions(options, apiKey === "kiro-plugin-local-transport" ? undefined : apiKey), {
      login: () => runKiroLoginFlowOnce({ login: options.login }),
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
    if (Object.keys(options.extraModels).length > 0) {
      modelCache.update(Object.keys(options.extraModels).map((id) => ({ id: normalizeModelName(id) })))
    }
    let discovery: Promise<unknown> | undefined
    let lastModelDiscoveryAt = 0
    const refreshModels = async (force = false) => {
      const discoveryIsStale = lastModelDiscoveryAt === 0 || Date.now() - lastModelDiscoveryAt > options.modelCacheTtlSeconds * 1000
      if (options.modelDiscovery === "off" || options.modelDiscoveryCommand.length === 0 || (!force && !discoveryIsStale)) {
        return []
      }
      if (!discovery) {
        discovery = refreshModelCacheFromCommand(
          modelCache,
          options.modelDiscoveryCommand[0] as string,
          options.modelDiscoveryCommand.slice(1),
        )
          .then((models) => {
            if (models.length > 0) lastModelDiscoveryAt = Date.now()
            return models
          })
          .catch(() => [])
          .finally(() => {
            discovery = undefined
          })
      }
      return (await discovery) as Awaited<ReturnType<typeof refreshModelCacheFromCommand>>
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
          ...(transport ? { transport } : {}),
        })(input, init)
      }
      localServer = await startLocalKiroServer(localFetch)
      return localServer
    }

    const authorizeDeviceLogin = async (inputs?: Record<string, unknown>) => {
      const startUrl = inputString(inputs, "startUrl") ?? options.login.identityProvider
      const idcRegion = inputString(inputs, "idcRegion") ?? options.login.region ?? "us-east-1"
      const profileArn = inputString(inputs, "profileArn") ?? options.profileArn
      const authorization = await authorizeKiroDevice({
        region: idcRegion,
        ...(startUrl ? { identityProvider: startUrl } : {}),
      })
      const url = startUrl ? kiroDeviceVerificationUrl(authorization.startUrl, authorization.userCode) : authorization.verificationUrlComplete
      return {
        url,
        instructions: `Open the verification URL and complete Kiro sign-in.\nCode: ${authorization.userCode}`,
        method: "auto" as const,
        callback: async () => {
          const credential = await pollKiroDeviceToken(
            authorization,
            {
              region: options.region,
              ...(profileArn ? { profileArn } : {}),
            },
          )
          const key = encodeKiroDeviceAuthKey(credential)
          return {
            type: "success" as const,
            key,
            access: key,
            refresh: credential.refreshToken,
            expires: credential.expiresAt,
            metadata: {
              source: "kiro-device-auth",
              region: credential.region,
              oidcRegion: credential.oidcRegion,
              ...(credential.profileArn ? { profileArn: credential.profileArn } : {}),
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
            label: options.login.identityProvider ? "Kiro device login (configured)" : "Kiro device login",
            authorize: async () => authorizeDeviceLogin(),
          },
          {
            type: "oauth",
            label: "Kiro device login (custom)",
            prompts: [
              {
                type: "text",
                key: "startUrl",
                message: options.login.identityProvider
                  ? `IAM Identity Center Start URL (current: ${options.login.identityProvider}, leave blank to keep)`
                  : "IAM Identity Center Start URL (leave blank for AWS Builder ID)",
                placeholder: "https://your-company.awsapps.com/start",
              },
              {
                type: "text",
                key: "idcRegion",
                message:
                  options.login.region && options.login.region !== "us-east-1"
                    ? `IAM Identity Center region (current: ${options.login.region}, leave blank to keep)`
                    : "IAM Identity Center region (leave blank for us-east-1)",
                placeholder: "us-east-1",
              },
              {
                type: "text",
                key: "profileArn",
                message: options.profileArn
                  ? `Profile ARN (current: ${options.profileArn}, leave blank to keep)`
                  : "Profile ARN (optional, improves region/profile routing for IAM Identity Center)",
                placeholder: "arn:aws:codewhisperer:us-east-1:123456789012:profile/XXXXXXXXXX",
              },
            ],
            authorize: async (inputs) => authorizeDeviceLogin(inputs),
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
