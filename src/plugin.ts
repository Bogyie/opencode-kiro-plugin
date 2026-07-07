import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { loadOptions } from "./config.js"
import { FALLBACK_MODELS } from "./models.js"

type MutableConfig = Record<string, any>

function mergeModels(existing: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    ...FALLBACK_MODELS,
    ...(existing ?? {}),
  }
}

export function createKiroPlugin(): Plugin {
  return async (_input, rawOptions): Promise<Hooks> => {
    const options = loadOptions(rawOptions)
    const baseURL = `https://q.${options.region}.amazonaws.com`

    return {
      config: async (config: MutableConfig) => {
        config.provider ??= {}
        config.provider[options.providerID] ??= {}

        const provider = config.provider[options.providerID]
        provider.name ??= "Kiro"
        provider.npm = "@ai-sdk/openai-compatible"
        provider.api ??= baseURL
        provider.options ??= {}
        provider.models = mergeModels(provider.models)
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
          const credential = await auth()
          return {
            apiKey: credential.type === "api" ? credential.key : "",
            baseURL,
          }
        },
      },
      provider: {
        id: options.providerID,
        models: async (provider) => {
          return Object.fromEntries(
            Object.entries(provider.models ?? {}).map(([id, model]) => [
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
