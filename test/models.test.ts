import { describe, expect, test } from "bun:test"
import { FALLBACK_MODELS } from "../src/models.js"

describe("optional model metadata presets", () => {
  test("does not advertise static models", () => {
    expect(FALLBACK_MODELS).toEqual({})
    expect(FALLBACK_MODELS["claude-fable-5"]).toBeUndefined()
  })
})
