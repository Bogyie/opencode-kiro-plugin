import { describe, expect, test } from "bun:test"
import { FALLBACK_MODELS } from "../src/models.js"

describe("fallback model presets", () => {
  test("includes current Kiro model picker defaults", () => {
    expect(FALLBACK_MODELS).toMatchObject({
      auto: { name: "Kiro Auto" },
      "claude-fable-5": { name: "Claude Fable 5" },
      "claude-sonnet-5": { name: "Claude Sonnet 5" },
      "claude-sonnet-4.6": { name: "Claude Sonnet 4.6" },
      "claude-opus-4.8": { name: "Claude Opus 4.8" },
      "claude-opus-4.7": { name: "Claude Opus 4.7" },
      "claude-opus-4.6": { name: "Claude Opus 4.6" },
      "claude-opus-4.5": { name: "Claude Opus 4.5" },
      "claude-haiku-4.5": { name: "Claude Haiku 4.5" },
      "deepseek-3.2": { name: "DeepSeek 3.2" },
      "glm-5": { name: "GLM-5" },
      "minimax-m2.5": { name: "MiniMax M2.5" },
      "minimax-m2.1": { name: "MiniMax M2.1" },
      "qwen3-coder-next": { name: "Qwen3 Coder Next" },
    })
  })

  test("keeps current long-context metadata visible to OpenCode", () => {
    expect(FALLBACK_MODELS["claude-sonnet-5"]?.limit?.context).toBe(1_000_000)
    expect(FALLBACK_MODELS["claude-opus-4.8"]?.limit).toEqual({
      context: 1_000_000,
      output: 128_000,
    })
  })
})
