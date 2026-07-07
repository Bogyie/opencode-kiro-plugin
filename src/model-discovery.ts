import type { CommandRunner } from "./auth.js"
import { runCommand } from "./auth.js"
import type { CachedModelInfo, ModelCache } from "./model-cache.js"
import { normalizeModelName } from "./model-resolver.js"

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function fromItem(item: unknown): CachedModelInfo | undefined {
  if (typeof item === "string") {
    const id = normalizeModelName(item)
    return id ? { id, raw: item } : undefined
  }

  const object = record(item)
  if (!object) return undefined
  const id = stringValue(object.id) ?? stringValue(object.modelId) ?? stringValue(object.model) ?? stringValue(object.name)
  if (!id) return undefined

  const normalized = normalizeModelName(id)
  if (!normalized) return undefined
  const name = stringValue(object.name) ?? stringValue(object.displayName) ?? stringValue(object.label)
  return {
    id: normalized,
    ...(name ? { name } : {}),
    raw: item,
  }
}

function fromJson(value: unknown): CachedModelInfo[] {
  if (Array.isArray(value)) return value.map(fromItem).filter((item): item is CachedModelInfo => item !== undefined)

  const object = record(value)
  if (!object) return []
  const items = object.models ?? object.data ?? object.items
  return Array.isArray(items) ? fromJson(items) : []
}

function fromLines(raw: string): CachedModelInfo[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes(" ") && !line.includes("\t"))
    .map(fromItem)
    .filter((item): item is CachedModelInfo => item !== undefined)
}

export function parseDiscoveredModels(raw: string): CachedModelInfo[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const models = fromJson(parsed)
    if (models.length > 0) return dedupe(models)
  } catch {
    // Fall back to line parsing below.
  }
  return dedupe(fromLines(trimmed))
}

function dedupe(models: ReadonlyArray<CachedModelInfo>): CachedModelInfo[] {
  return [...new Map(models.map((model) => [model.id, model])).values()].sort((a, b) => a.id.localeCompare(b.id))
}

export async function discoverModelsFromCommand(
  command: string,
  args: ReadonlyArray<string>,
  runner: CommandRunner = runCommand,
): Promise<CachedModelInfo[]> {
  const result = await runner(command, [...args])
  if (!result.ok) return []
  return parseDiscoveredModels(result.stdout)
}

export async function refreshModelCacheFromCommand(
  cache: ModelCache,
  command: string,
  args: ReadonlyArray<string>,
  runner: CommandRunner = runCommand,
): Promise<CachedModelInfo[]> {
  const models = await discoverModelsFromCommand(command, args, runner)
  if (models.length > 0) cache.update(models)
  return models
}
