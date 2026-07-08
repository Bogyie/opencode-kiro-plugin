import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { CachedModelInfo } from "./model-cache.js"

interface StoredModelCache {
  readonly updatedAt?: number
  readonly models?: unknown
}

function cachePath(): string {
  if (process.env.OPENCODE_KIRO_MODEL_CACHE) return process.env.OPENCODE_KIRO_MODEL_CACHE
  const base = process.env.XDG_CACHE_HOME || join(homedir() || tmpdir(), ".cache")
  return join(base, "opencode-kiro-plugin", "models.json")
}

function modelInfo(value: unknown): CachedModelInfo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (typeof input.id !== "string" || !input.id.trim()) return undefined
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : undefined
  const contextLimit = typeof input.contextLimit === "number" && Number.isFinite(input.contextLimit) ? input.contextLimit : undefined
  const outputLimit = typeof input.outputLimit === "number" && Number.isFinite(input.outputLimit) ? input.outputLimit : undefined
  return {
    id: input.id.trim(),
    ...(name ? { name } : {}),
    ...(contextLimit ? { contextLimit } : {}),
    ...(outputLimit ? { outputLimit } : {}),
    ...("raw" in input ? { raw: input.raw } : {}),
  }
}

export async function loadStoredModelCache(): Promise<{ models: CachedModelInfo[]; updatedAt?: number }> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), "utf8")) as StoredModelCache
    const models = Array.isArray(parsed.models) ? parsed.models.map(modelInfo).filter((item): item is CachedModelInfo => Boolean(item)) : []
    return {
      models,
      ...(typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? { updatedAt: parsed.updatedAt } : {}),
    }
  } catch {
    return { models: [] }
  }
}

export async function saveStoredModelCache(models: ReadonlyArray<CachedModelInfo>, updatedAt = Date.now()): Promise<void> {
  try {
    const path = cachePath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ updatedAt, models }, null, 2), "utf8")
  } catch {
    // Best-effort cache only.
  }
}
