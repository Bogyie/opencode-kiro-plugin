import { describe, expect, test } from "bun:test"
import { ModelCache } from "../src/model-cache.js"

describe("ModelCache", () => {
  test("starts stale and empty", () => {
    const cache = new ModelCache(60)

    expect(cache.isEmpty()).toBe(true)
    expect(cache.isStale(1000)).toBe(true)
    expect(cache.updatedAt).toBeUndefined()
  })

  test("updates and returns sorted ids", () => {
    const cache = new ModelCache(60)

    cache.update([{ id: "z-model" }, { id: "a-model", contextLimit: 1000 }], 1000)

    expect(cache.isEmpty()).toBe(false)
    expect(cache.ids()).toEqual(["a-model", "z-model"])
    expect(cache.get("a-model")?.contextLimit).toBe(1000)
    expect(cache.updatedAt).toBe(1000)
  })

  test("marks cache stale after ttl", () => {
    const cache = new ModelCache(10)

    cache.update([{ id: "auto" }], 1000)

    expect(cache.isStale(10_999)).toBe(false)
    expect(cache.isStale(11_001)).toBe(true)
  })
})

