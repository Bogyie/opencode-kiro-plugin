import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { KiroAcpTransport } from "./acp-transport.js"
import type { KiroAcpTransportOptions } from "./acp-transport.js"
import { detectAuth, resolveApiKey } from "./auth.js"
import { KiroCliChatTransport } from "./cli-transport.js"
import { loadOptions } from "./config.js"
import type { KiroPluginOptions } from "./config.js"
import { createKiroFetch } from "./fetch-adapter.js"
import { startLocalKiroServer, type LocalKiroServer } from "./local-server.js"
import { ModelCache } from "./model-cache.js"
import { refreshModelCacheFromCommand } from "./model-discovery.js"
import { ModelResolver, normalizeModelName } from "./model-resolver.js"
import { CodeWhispererKiroTransport } from "./kiro-transport.js"
import type { KiroTransportOptions } from "./kiro-transport.js"
import type { ProviderModelConfig } from "./models.js"

type MutableConfig = Record<string, any>

function mergeModels(
  extraModels: Readonly<Record<string, Record<string, unknown>>>,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...extraModels,
    ...(existing ?? {}),
  }
}

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
    const baseURL = options.endpoint ?? `https://q.${options.region}.amazonaws.com`
    const modelCache = new ModelCache(options.modelCacheTtlSeconds)
    let localServer: LocalKiroServer | undefined
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

    return {
      dispose: async () => {
        await localServer?.close()
        localServer = undefined
      },
      config: async (config: MutableConfig) => {
        config.provider ??= {}
        config.provider[options.providerID] ??= {}

        const provider = config.provider[options.providerID]
        provider.name ??= "Kiro"
        provider.npm = "@ai-sdk/openai-compatible"
        provider.api ??= baseURL
        provider.options ??= {}
        provider.models = mergeModels(options.extraModels, provider.models)
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
          const transport =
            options.backend === "acp"
              ? new KiroAcpTransport(acpTransportOptions(options))
            : options.backend === "cli-chat"
              ? new KiroCliChatTransport({
                  trustAllTools: options.trustAllTools,
                  ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
                })
              : apiKey
                ? new CodeWhispererKiroTransport(fetchTransportOptions(options, apiKey))
                : options.backend === "auto"
                  ? new KiroCliChatTransport({
                      trustAllTools: options.trustAllTools,
                      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
                    })
                  : undefined
          const localFetch = createKiroFetch({
            resolver,
            ...(transport ? { transport } : {}),
          })
          localServer ??= await startLocalKiroServer(localFetch)
          return {
            apiKey: apiKey || "kiro-plugin-local-transport",
            baseURL: localServer.baseURL,
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
          const models = {
            ...discoveredProviderModels(modelCache),
            ...(provider.models ?? {}),
          }
          return Object.fromEntries(
            Object.entries(models).map(([id, model]) => [
              id,
              {
                ...(model as Record<string, unknown>),
                api: {
                  ...((model as { api?: Record<string, unknown> }).api ?? {}),
                  id,
                  npm: "@ai-sdk/openai-compatible",
                  url: baseURL,
                },
              },
            ]),
          ) as any
        },
      },
    }
  }
}

export const KiroPlugin = createKiroPlugin()
