import type { CommandRunner } from "./auth.js"
import { runCommand, runKiroLoginFlowOnce } from "./auth.js"
import type { CachedModelInfo, ModelCache } from "./model-cache.js"
import { normalizeModelName } from "./model-resolver.js"

export type KiroLoginFlowRunner = () => Promise<boolean>

export interface ModelDiscoveryCommandOptions {
  readonly runner?: CommandRunner
  readonly loginOnAuthFailure?: boolean
  readonly login?: KiroLoginFlowRunner
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positiveNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function fromItem(item: unknown): CachedModelInfo | undefined {
  if (typeof item === "string") {
    const id = normalizeModelName(item)
    return id ? { id, raw: item } : undefined
  }

  const object = record(item)
  if (!object) return undefined
  const id =
    stringValue(object.id) ??
    stringValue(object.modelId) ??
    stringValue(object.model_id) ??
    stringValue(object.model) ??
    stringValue(object.model_name) ??
    stringValue(object.name)
  if (!id) return undefined

  const normalized = normalizeModelName(id)
  if (!normalized) return undefined
  const name = stringValue(object.name) ?? stringValue(object.displayName) ?? stringValue(object.label)
  const contextLimit = positiveNumberValue(object.contextLimit) ?? positiveNumberValue(object.context_window_tokens)
  const outputLimit = positiveNumberValue(object.outputLimit) ?? positiveNumberValue(object.output_limit_tokens)
  return {
    id: normalized,
    ...(name ? { name } : {}),
    ...(contextLimit ? { contextLimit } : {}),
    ...(outputLimit ? { outputLimit } : {}),
    raw: item,
  }
}

function fromJson(value: unknown): CachedModelInfo[] {
  if (Array.isArray(value)) return value.map(fromItem).filter((item): item is CachedModelInfo => item !== undefined)

  const object = record(value)
  if (!object) return []
  const items = object.models ?? object.data ?? object.items
  if (Array.isArray(items)) return fromJson(items)

  const configuredModel = object["chat.defaultModel"] ?? object.defaultModel ?? object.model
  return configuredModel ? fromJson([configuredModel]) : []
}

function fromLines(raw: string): CachedModelInfo[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^\*\s*/, ""))
    .map((line) => /^\S+/.exec(line)?.[0] ?? "")
    .filter((line) => line === "auto" || /[.-]/.test(line))
    .map(fromItem)
    .filter((item): item is CachedModelInfo => item !== undefined)
}

function jsonCandidates(raw: string): string[] {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const objectStart = trimmed.indexOf("{")
  const objectEnd = trimmed.lastIndexOf("}")
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(trimmed.slice(objectStart, objectEnd + 1))
  const arrayStart = trimmed.indexOf("[")
  const arrayEnd = trimmed.lastIndexOf("]")
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(trimmed.slice(arrayStart, arrayEnd + 1))
  return [...new Set(candidates)]
}

export function parseDiscoveredModels(raw: string): CachedModelInfo[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  for (const candidate of jsonCandidates(trimmed)) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      const models = fromJson(parsed)
      if (models.length > 0) return dedupe(models)
    } catch {
      // Try the next JSON candidate, then fall back to line parsing below.
    }
  }
  return dedupe(fromLines(trimmed))
}

export function isModelDiscoveryAuthFailure(output: string): boolean {
  const text = output.toLowerCase()
  return (
    text.includes("not logged in") ||
    text.includes("not authenticated") ||
    text.includes("unauthorized") ||
    text.includes("authorization") ||
    text.includes("authentication") ||
    text.includes("auth token") ||
    text.includes("token expired") ||
    text.includes("expired token")
  )
}

function dedupe(models: ReadonlyArray<CachedModelInfo>): CachedModelInfo[] {
  return [...new Map(models.map((model) => [model.id, model])).values()].sort((a, b) => a.id.localeCompare(b.id))
}

export async function discoverModelsFromCommand(
  command: string,
  args: ReadonlyArray<string>,
  runnerOrOptions: CommandRunner | ModelDiscoveryCommandOptions = runCommand,
): Promise<CachedModelInfo[]> {
  const options: ModelDiscoveryCommandOptions = typeof runnerOrOptions === "function" ? { runner: runnerOrOptions } : runnerOrOptions
  const runner = options.runner ?? runCommand
  const result = await runner(command, [...args])
  if (!result.ok) {
    if (!options.loginOnAuthFailure || !isModelDiscoveryAuthFailure(`${result.stdout}\n${result.stderr}`)) return []
    const loggedIn = await (options.login ?? runKiroLoginFlowOnce)()
    if (!loggedIn) return []
    const retry = await runner(command, [...args])
    if (!retry.ok) return []
    return parseDiscoveredModels(retry.stdout)
  }
  return parseDiscoveredModels(result.stdout)
}

export async function refreshModelCacheFromCommand(
  cache: ModelCache,
  command: string,
  args: ReadonlyArray<string>,
  runnerOrOptions: CommandRunner | ModelDiscoveryCommandOptions = runCommand,
): Promise<CachedModelInfo[]> {
  const models = await discoverModelsFromCommand(command, args, runnerOrOptions)
  if (models.length > 0) cache.update(models)
  return models
}
