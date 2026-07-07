import { describe, expect, test } from "bun:test"
import { discoverModelsFromCommand, parseDiscoveredModels } from "../src/model-discovery.js"

describe("model discovery", () => {
  test("parses JSON model arrays", () => {
    expect(parseDiscoveredModels(JSON.stringify(["claude-sonnet-4-6", { id: "claude-opus-4-8", name: "Opus" }]))).toEqual([
      { id: "claude-opus-4.8", name: "Opus", raw: { id: "claude-opus-4-8", name: "Opus" } },
      { id: "claude-sonnet-4.6", raw: "claude-sonnet-4-6" },
    ])
  })

  test("parses JSON objects with model collections", () => {
    expect(parseDiscoveredModels(JSON.stringify({ models: [{ modelId: "deepseek-3.2", displayName: "DeepSeek" }] }))).toEqual([
      {
        id: "deepseek-3.2",
        name: "DeepSeek",
        raw: { modelId: "deepseek-3.2", displayName: "DeepSeek" },
      },
    ])
  })

  test("falls back to line based output", () => {
    expect(parseDiscoveredModels("claude-sonnet-4-6\nheading with spaces\nqwen3-coder-next\n")).toEqual([
      { id: "claude-sonnet-4.6", raw: "claude-sonnet-4-6" },
      { id: "qwen3-coder-next", raw: "qwen3-coder-next" },
    ])
  })

  test("discovers models through an injected command runner", async () => {
    const models = await discoverModelsFromCommand("kiro-cli", ["models", "--json"], async (command, args) => {
      expect(command).toBe("kiro-cli")
      expect(args).toEqual(["models", "--json"])
      return {
        ok: true,
        stdout: JSON.stringify({ data: [{ name: "MiniMax", model: "minimax-m2.5" }] }),
        stderr: "",
      }
    })

    expect(models).toEqual([
      {
        id: "minimax-m2.5",
        name: "MiniMax",
        raw: { name: "MiniMax", model: "minimax-m2.5" },
      },
    ])
  })
})
