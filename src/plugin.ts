import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { KiroAcpTransport } from "./acp-transport.js"
import type { KiroAcpTransportOptions } from "./acp-transport.js"
import { detectAuth, resolveApiKey } from "./auth.js"
import { KiroCliChatTransport } from "./cli-transport.js"
import { loadOptions } from "./config.js"
import type { KiroPluginOptions } from "./config.js"
import { createKiroFetch, type KiroTransport } from "./fetch-adapter.js"
import { startLocalKiroServer, type LocalKiroServer } from "./local-server.js"
import { ModelCache } from "./model-cache.js"
import { refreshModelCacheFromCommand } from "./model-discovery.js"
import { ModelResolver, normalizeModelName } from "./model-resolver.js"
import { CodeWhispererKiroTransport } from "./kiro-transport.js"
import type { KiroTransportOptions } from "./kiro-transport.js"
import type { ProviderModelConfig } from "./models.js"

type MutableConfig = Record<string, any>

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

function bearerToken(init: RequestInit | undefined): string | undefined {
  const header = new Headers(init?.headers).get("authorization")
  const match = header?.match(/^Bearer\s+(.+)$/i)
  return match?.[1] || undefined
}

function localTransport(options: KiroPluginOptions, accessToken?: string): KiroTransport | undefined {
  if (options.backend === "acp") return new KiroAcpTransport(acpTransportOptions(options))
  if (options.backend === "cli-chat") {
    return new KiroCliChatTransport({
      trustAllTools: options.trustAllTools,
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    })
  }
  const apiKey = accessToken || process.env.KIRO_API_KEY
  if (apiKey && apiKey !== "kiro-plugin-local-transport") {
    return new CodeWhispererKiroTransport(fetchTransportOptions(options, apiKey))
  }
  if (options.backend === "auto") {
    return new KiroCliChatTransport({
      trustAllTools: options.trustAllTools,
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
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
  accessToken: string,
): KiroTransportOptions {
  return {
    region: options.region,
    accessToken,
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
    const disabledModels = new Set(options.disabledModels.map(normalizeModelName))
    if (Object.keys(options.extraModels).length > 0) {
      modelCache.update(Object.keys(options.extraModels).map((id) => ({ id: normalizeModelName(id) })))
    }
    let discovery: Promise<void> | undefined
    let discoveryAttempted = false
    const discoverIfStale = async () => {
      if (
        options.modelDiscovery === "off" ||
        options.modelDiscoveryCommand.length === 0 ||
        (discoveryAttempted && !modelCache.isStale())
      ) {
        return
      }
      discoveryAttempted = true
      discovery ??= refreshModelCacheFromCommand(
        modelCache,
        options.modelDiscoveryCommand[0] as string,
        options.modelDiscoveryCommand.slice(1),
      )
        .catch(() => undefined)
        .then(() => {
          discovery = undefined
        })
      await discovery
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

    return {
      dispose: async () => {
        await localServer?.close()
        localServer = undefined
      },
      config: async (config: MutableConfig) => {
        await discoverIfStale()
        config.provider ??= {}
        config.provider[options.providerID] ??= {}

        const provider = config.provider[options.providerID]
        const server = await ensureLocalServer()
        configuredModels = {
          ...options.extraModels,
          ...modelRecord(provider.models),
        }
        provider.name ??= "Kiro"
        provider.npm = "@ai-sdk/openai-compatible"
        provider.api = server.baseURL
        provider.options ??= {}
        provider.models = configuredModels
      },
      auth: {
        provider: options.providerID,
        methods: [
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
          await discoverIfStale()
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
            await discoverIfStale()
            const auth = await detectAuth()
            return {
              title: "Kiro status",
              output: [
                `provider: ${options.providerID}`,
                `backend: ${options.backend}`,
                `region: ${auth.region}`,
                `auth: ${auth.method}`,
                `authenticated: ${auth.authenticated ? "yes" : "no"}`,
                `models: ${modelCache.ids().length} discovered/cache entries`,
                auth.message,
              ].join("\n"),
              metadata: {
                providerID: options.providerID,
                backend: options.backend,
                region: auth.region,
                authMethod: auth.method,
                authenticated: auth.authenticated,
              },
            }
          },
        }),
      },
      provider: {
        id: options.providerID,
        models: async (provider) => {
          await discoverIfStale()
          const discovered = discoveredProviderModels(modelCache)
          const existing = modelRecord(provider.models)
          const allowedModelIDs = new Set([
            ...Object.keys(discovered),
            ...Object.keys(configuredModels),
            ...Object.keys(options.hiddenModels),
          ])
          const server = await ensureLocalServer()
          return Object.fromEntries(
            [...allowedModelIDs]
              .filter((id) => !disabledModels.has(normalizeModelName(id)))
              .map((id) => {
                const model = {
                  ...(discovered[id] ?? {}),
                  ...(configuredModels[id] ?? {}),
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
