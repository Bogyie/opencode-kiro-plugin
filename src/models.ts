export interface ProviderModelConfig {
  readonly name?: string
  readonly limit?: {
    readonly context: number
    readonly output: number
  }
  readonly modalities?: {
    readonly input: ReadonlyArray<"text" | "image" | "pdf">
    readonly output: ReadonlyArray<"text">
  }
  readonly tool_call?: boolean
  readonly variants?: Readonly<Record<string, Record<string, unknown>>>
}

const TEXT_IMAGE_PDF = { input: ["text", "image", "pdf"], output: ["text"] } as const
const TEXT_ONLY = { input: ["text"], output: ["text"] } as const

export const FALLBACK_MODELS: Readonly<Record<string, ProviderModelConfig>> = {
  auto: {
    name: "Kiro Auto",
    limit: { context: 200_000, output: 64_000 },
    modalities: TEXT_IMAGE_PDF,
    tool_call: true,
  },
  "claude-sonnet-4": {
    name: "Claude Sonnet 4",
    limit: { context: 200_000, output: 64_000 },
    modalities: TEXT_IMAGE_PDF,
    tool_call: true,
  },
  "claude-sonnet-4-5": {
    name: "Claude Sonnet 4.5",
    limit: { context: 200_000, output: 64_000 },
    modalities: TEXT_IMAGE_PDF,
    tool_call: true,
  },
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    limit: { context: 1_000_000, output: 64_000 },
    modalities: TEXT_IMAGE_PDF,
    tool_call: true,
  },
  "claude-opus-4-8": {
    name: "Claude Opus 4.8",
    limit: { context: 1_000_000, output: 64_000 },
    modalities: TEXT_IMAGE_PDF,
    tool_call: true,
  },
  "claude-haiku-4-5": {
    name: "Claude Haiku 4.5",
    limit: { context: 200_000, output: 64_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    tool_call: true,
  },
  "deepseek-3.2": {
    name: "DeepSeek 3.2",
    limit: { context: 128_000, output: 64_000 },
    modalities: TEXT_ONLY,
    tool_call: true,
  },
  "glm-5": {
    name: "GLM-5",
    limit: { context: 200_000, output: 64_000 },
    modalities: TEXT_ONLY,
    tool_call: true,
  },
  "minimax-m2.5": {
    name: "MiniMax M2.5",
    limit: { context: 200_000, output: 64_000 },
    modalities: TEXT_ONLY,
    tool_call: true,
  },
  "minimax-m2.1": {
    name: "MiniMax M2.1",
    limit: { context: 200_000, output: 64_000 },
    modalities: TEXT_ONLY,
    tool_call: true,
  },
  "qwen3-coder-next": {
    name: "Qwen3 Coder Next",
    limit: { context: 256_000, output: 64_000 },
    modalities: TEXT_ONLY,
    tool_call: true,
  },
}

