export interface CachedModelInfo {
  readonly id: string
  readonly name?: string
  readonly contextLimit?: number
  readonly outputLimit?: number
  readonly raw?: unknown
}

export class ModelCache {
  readonly #ttlMs: number
  #models = new Map<string, CachedModelInfo>()
  #updatedAt = 0

  constructor(ttlSeconds: number) {
    this.#ttlMs = ttlSeconds * 1000
  }

  update(models: ReadonlyArray<CachedModelInfo>, now = Date.now()): void {
    this.#models = new Map(models.map((model) => [model.id, model]))
    this.#updatedAt = now
  }

  get(id: string): CachedModelInfo | undefined {
    return this.#models.get(id)
  }

  has(id: string): boolean {
    return this.#models.has(id)
  }

  all(): CachedModelInfo[] {
    return [...this.#models.values()]
  }

  ids(): string[] {
    return [...this.#models.keys()].sort()
  }

  isEmpty(): boolean {
    return this.#models.size === 0
  }

  isStale(now = Date.now()): boolean {
    return this.#updatedAt === 0 || now - this.#updatedAt > this.#ttlMs
  }

  get updatedAt(): number | undefined {
    return this.#updatedAt === 0 ? undefined : this.#updatedAt
  }
}

