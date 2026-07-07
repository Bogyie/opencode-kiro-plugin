import { ModelCache } from "./model-cache.js"

export type ModelResolutionSource = "cache" | "hidden" | "passthrough"

export interface ModelResolution {
  readonly internalID: string
  readonly source: ModelResolutionSource
  readonly original: string
  readonly normalized: string
  readonly verified: boolean
}

export interface ModelResolverOptions {
  readonly cache: ModelCache
  readonly aliases?: Readonly<Record<string, string>>
  readonly hiddenModels?: Readonly<Record<string, string>>
  readonly disabledModels?: ReadonlyArray<string>
  readonly disablePassThrough?: boolean
}

export class ModelResolutionError extends Error {
  constructor(
    message: string,
    readonly model: string,
    readonly suggestions: ReadonlyArray<string>,
  ) {
    super(message)
    this.name = "ModelResolutionError"
  }
}

export function normalizeModelName(input: string): string {
  let name = input.trim()
  if (!name) return name

  name = name.replace(/\[\d+[mk]\]$/i, "").toLowerCase()

  const inverted = /^claude-(\d+)\.(\d+)-(haiku|sonnet|opus)-.+$/.exec(name)
  if (inverted) return `claude-${inverted[3]}-${inverted[1]}.${inverted[2]}`

  name = name.replace(/-(thinking|low|medium|high|max)$/, "")

  const standardMinor = /^(claude-(?:haiku|sonnet|opus)-\d+)-(\d{1,2})(?:-(?:\d{8}|latest|\d+))?$/.exec(name)
  if (standardMinor) return `${standardMinor[1]}.${standardMinor[2]}`

  const standardMajor = /^(claude-(?:haiku|sonnet|opus)-\d+)(?:-\d{8})?$/.exec(name)
  if (standardMajor) return standardMajor[1] ?? name

  const legacy = /^claude-(\d+)-(\d+)-(haiku|sonnet|opus)(?:-(?:\d{8}|latest|\d+))?$/.exec(name)
  if (legacy) return `claude-${legacy[1]}.${legacy[2]}-${legacy[3]}`

  const dotWithDate = /^(claude-(?:(?:haiku|sonnet|opus)-\d+\.\d+|\d+\.\d+-(?:haiku|sonnet|opus)))-\d{8}$/.exec(name)
  if (dotWithDate) return dotWithDate[1] ?? name

  return name
}

function familyOf(model: string): string | undefined {
  return /(haiku|sonnet|opus)/i.exec(model)?.[1]?.toLowerCase()
}

export class ModelResolver {
  readonly #cache: ModelCache
  readonly #aliases: Readonly<Record<string, string>>
  readonly #hiddenModels: Readonly<Record<string, string>>
  readonly #disabledModels: Set<string>
  readonly #disablePassThrough: boolean

  constructor(options: ModelResolverOptions) {
    this.#cache = options.cache
    this.#aliases = options.aliases ?? {}
    this.#hiddenModels = options.hiddenModels ?? {}
    this.#disabledModels = new Set((options.disabledModels ?? []).map(normalizeModelName))
    this.#disablePassThrough = options.disablePassThrough === true
  }

  resolve(model: string): ModelResolution {
    const aliased = this.#aliases[model] ?? this.#aliases[normalizeModelName(model)] ?? model
    const normalized = normalizeModelName(aliased)

    if (this.#disabledModels.has(normalized)) {
      throw new ModelResolutionError(`Model is disabled: ${model}`, model, this.suggestions(model))
    }

    if (this.#cache.has(normalized)) {
      return { internalID: normalized, source: "cache", original: model, normalized, verified: true }
    }

    const hidden = this.#hiddenModels[normalized]
    if (hidden) {
      return { internalID: hidden, source: "hidden", original: model, normalized, verified: true }
    }

    if (this.#disablePassThrough) {
      throw new ModelResolutionError(`Unsupported model: ${model}`, model, this.suggestions(model))
    }

    return { internalID: normalized, source: "passthrough", original: model, normalized, verified: false }
  }

  availableModels(): string[] {
    return [...new Set([...this.#cache.ids(), ...Object.keys(this.#hiddenModels), ...Object.keys(this.#aliases)])].sort()
  }

  suggestions(model: string): string[] {
    const family = familyOf(model)
    const available = this.availableModels()
    if (!family) return available
    const matching = available.filter((item) => familyOf(item) === family)
    return matching.length > 0 ? matching : available
  }
}
