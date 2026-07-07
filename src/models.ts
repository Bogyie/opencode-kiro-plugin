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

// Retained as an empty compatibility export. Runtime discovery is the source of truth.
export const FALLBACK_MODELS: Readonly<Record<string, ProviderModelConfig>> = {}
