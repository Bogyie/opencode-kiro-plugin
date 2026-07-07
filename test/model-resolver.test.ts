import { describe, expect, test } from "bun:test"
import { ModelCache } from "../src/model-cache.js"
import { ModelResolutionError, ModelResolver, normalizeModelName } from "../src/model-resolver.js"

describe("normalizeModelName", () => {
  test("normalizes common Kiro and client model name variants", () => {
    expect(normalizeModelName("claude-sonnet-4-6")).toBe("claude-sonnet-4.6")
    expect(normalizeModelName("claude-sonnet-4-6-20260101")).toBe("claude-sonnet-4.6")
    expect(normalizeModelName("claude-sonnet-4.6-20260101")).toBe("claude-sonnet-4.6")
    expect(normalizeModelName("claude-4.6-sonnet-high")).toBe("claude-sonnet-4.6")
    expect(normalizeModelName("claude-3-7-sonnet")).toBe("claude-3.7-sonnet")
    expect(normalizeModelName("claude-opus-4-8-thinking")).toBe("claude-opus-4.8")
  })

  test("keeps non-Claude model names stable except for casing and brackets", () => {
    expect(normalizeModelName("DeepSeek-3.2[128k]")).toBe("deepseek-3.2")
    expect(normalizeModelName("qwen3-coder-next")).toBe("qwen3-coder-next")
  })
})

describe("ModelResolver", () => {
  test("resolves alias before cache lookup", () => {
    const cache = new ModelCache(60)
    cache.update([{ id: "auto" }])

    const resolver = new ModelResolver({ cache, aliases: { "kiro-auto": "auto" } })

    expect(resolver.resolve("kiro-auto")).toEqual({
      internalID: "auto",
      source: "cache",
      original: "kiro-auto",
      normalized: "auto",
      verified: true,
    })
  })

  test("uses dynamic cache as verified source", () => {
    const cache = new ModelCache(60)
    cache.update([{ id: "claude-sonnet-4.6" }])

    const resolver = new ModelResolver({ cache })

    expect(resolver.resolve("claude-sonnet-4-6")).toMatchObject({
      internalID: "claude-sonnet-4.6",
      source: "cache",
      verified: true,
    })
  })

  test("resolves hidden models separately from visible cache models", () => {
    const cache = new ModelCache(60)
    const resolver = new ModelResolver({
      cache,
      hiddenModels: { "claude-3.7-sonnet": "CLAUDE_3_7_SONNET_20250219_V1_0" },
    })

    expect(resolver.resolve("claude-3-7-sonnet")).toMatchObject({
      internalID: "CLAUDE_3_7_SONNET_20250219_V1_0",
      source: "hidden",
      verified: true,
    })
  })

  test("passes through unknown models by default", () => {
    const resolver = new ModelResolver({ cache: new ModelCache(60) })

    expect(resolver.resolve("claude-opus-4-9")).toEqual({
      internalID: "claude-opus-4.9",
      source: "passthrough",
      original: "claude-opus-4-9",
      normalized: "claude-opus-4.9",
      verified: false,
    })
  })

  test("throws with same-family suggestions when pass-through is disabled", () => {
    const cache = new ModelCache(60)
    cache.update([{ id: "claude-sonnet-4.6" }, { id: "claude-haiku-4.5" }])
    const resolver = new ModelResolver({ cache, disablePassThrough: true })

    expect(() => resolver.resolve("claude-sonnet-5-1")).toThrow(ModelResolutionError)
    try {
      resolver.resolve("claude-sonnet-5-1")
    } catch (error) {
      expect(error).toBeInstanceOf(ModelResolutionError)
      expect((error as ModelResolutionError).suggestions).toEqual(["claude-sonnet-4.6"])
    }
  })

  test("blocks disabled models after normalization", () => {
    const cache = new ModelCache(60)
    cache.update([{ id: "claude-sonnet-4.6" }])
    const resolver = new ModelResolver({ cache, disabledModels: ["claude-sonnet-4.6"] })

    expect(() => resolver.resolve("claude-sonnet-4-6")).toThrow(ModelResolutionError)
  })
})

