import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { KiroAcpTransport } from "./acp-transport.js"
import { detectAuth, resolveApiKey } from "./auth.js"
import { KiroCliChatTransport } from "./cli-transport.js"
import { loadOptions } from "./config.js"
import { createKiroFetch } from "./fetch-adapter.js"
import { ModelCache } from "./model-cache.js"
import { refreshModelCacheFromCommand } from "./model-discovery.js"
import { ModelResolver, normalizeModelName } from "./model-resolver.js"
import { CodeWhispererKiroTransport } from "./kiro-transport.js"
import { FALLBACK_MODELS, type ProviderModelConfig } from "./models.js"

type MutableConfig = Record<string, any>

function mergeModels(
  extraModels: Readonly<Record<string, Record<string, unknown>>>,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...FALLBACK_MODELS,
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
      },
    ]),
  )
}

export function createKiroPlugin(): Plugin {
  return async (_input, rawOptions): Promise<Hooks> => {
    const options = loadOptions(rawOptions)
    const baseURL = `https://q.${options.region}.amazonaws.com`
    const modelCache = new ModelCache(options.modelCacheTtlSeconds)
    modelCache.update([...Object.keys(FALLBACK_MODELS), ...Object.keys(options.extraModels)].map((id) => ({ id: normalizeModelName(id) })))
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
              ? new KiroAcpTransport({ trustAllTools: options.trustAllTools })
            : options.backend === "cli-chat"
              ? new KiroCliChatTransport({
                  trustAllTools: options.trustAllTools,
                  ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
                })
              : apiKey
                ? new CodeWhispererKiroTransport({
                    region: options.region,
                    accessToken: apiKey,
                    maxAttempts: options.maxAttempts,
                    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
                  })
                : options.backend === "auto"
                  ? new KiroCliChatTransport({
                      trustAllTools: options.trustAllTools,
                      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
                    })
                  : undefined
          return {
            apiKey,
            baseURL,
            fetch: createKiroFetch({
              resolver,
              ...(transport ? { transport } : {}),
            }),
          }
        },
      },
      tool: {
        kiro_status: tool({
          description: "Show Kiro plugin backend, auth, region, and model fallback status.",
          args: {},
          execute: async () => {
            const auth = await detectAuth()
            return {
              title: "Kiro status",
              output: [
                `provider: ${options.providerID}`,
                `backend: ${options.backend}`,
                `region: ${auth.region}`,
                `auth: ${auth.method}`,
                `authenticated: ${auth.authenticated ? "yes" : "no"}`,
                `models: ${Object.keys(FALLBACK_MODELS).length} fallback presets`,
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
