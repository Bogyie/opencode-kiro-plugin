import { describe, expect, test } from "bun:test"
import { discoverModelsFromCommand, isModelDiscoveryAuthFailure, parseDiscoveredModels } from "../src/model-discovery.js"

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

  test("parses kiro-cli chat list-models JSON output", () => {
    const raw = JSON.stringify({
      models: [
        {
          model_name: "claude-sonnet-5",
          model_id: "claude-sonnet-5",
          description: "Experimental preview of Claude Sonnet 5 model with 1M context window",
          context_window_tokens: 1000000,
        },
        {
          model_name: "claude-opus-4.8",
          model_id: "claude-opus-4.8",
          description: "Claude Opus 4.8 model with 1M context window",
          context_window_tokens: 1000000,
        },
      ],
      default_model: "auto",
    })

    expect(parseDiscoveredModels(raw)).toEqual([
      {
        id: "claude-opus-4.8",
        contextLimit: 1000000,
        raw: {
          model_name: "claude-opus-4.8",
          model_id: "claude-opus-4.8",
          description: "Claude Opus 4.8 model with 1M context window",
          context_window_tokens: 1000000,
        },
      },
      {
        id: "claude-sonnet-5",
        contextLimit: 1000000,
        raw: {
          model_name: "claude-sonnet-5",
          model_id: "claude-sonnet-5",
          description: "Experimental preview of Claude Sonnet 5 model with 1M context window",
          context_window_tokens: 1000000,
        },
      },
    ])
  })

  test("falls back to line based output", () => {
    expect(parseDiscoveredModels("claude-sonnet-4-6\nheading with spaces\nqwen3-coder-next\n")).toEqual([
      { id: "claude-sonnet-4.6", raw: "claude-sonnet-4-6" },
      { id: "qwen3-coder-next", raw: "qwen3-coder-next" },
    ])
  })

  test("parses kiro-cli chat list-models plain output", () => {
    expect(
      parseDiscoveredModels(`Available models (* = default):

* auto                 1.00x credits      Models chosen by task
  claude-sonnet-5      1.30x credits      Experimental preview of Claude Sonnet 5
  claude-opus-4.8      2.20x credits      Claude Opus 4.8 model
`),
    ).toEqual([
      { id: "auto", raw: "auto" },
      { id: "claude-opus-4.8", raw: "claude-opus-4.8" },
      { id: "claude-sonnet-5", raw: "claude-sonnet-5" },
    ])
  })


  test("discovers models through an injected command runner", async () => {
    const models = await discoverModelsFromCommand("kiro-cli", ["chat", "--list-models", "--format", "json"], async (command, args) => {
      expect(command).toBe("kiro-cli")
      expect(args).toEqual(["chat", "--list-models", "--format", "json"])
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

  test("detects auth failures from model discovery output", () => {
    expect(isModelDiscoveryAuthFailure("error: not logged in")).toBe(true)
    expect(isModelDiscoveryAuthFailure("UnauthorizedException")).toBe(true)
    expect(isModelDiscoveryAuthFailure("network unavailable")).toBe(false)
  })

  test("runs login flow and retries model discovery once on auth failure", async () => {
    const calls: unknown[] = []
    let logins = 0
    const models = await discoverModelsFromCommand("kiro-cli", ["chat", "--list-models"], {
      loginOnAuthFailure: true,
      login: async () => {
        logins += 1
        return true
      },
      runner: async (command, args) => {
        calls.push({ command, args })
        if (calls.length === 1) return { ok: false, stdout: "", stderr: "not logged in" }
        return { ok: true, stdout: JSON.stringify({ models: [{ id: "claude-sonnet-5" }] }), stderr: "" }
      },
    })

    expect(logins).toBe(1)
    expect(calls).toEqual([
      { command: "kiro-cli", args: ["chat", "--list-models"] },
      { command: "kiro-cli", args: ["chat", "--list-models"] },
    ])
    expect(models).toEqual([{ id: "claude-sonnet-5", raw: { id: "claude-sonnet-5" } }])
  })

  test("does not retry model discovery when login flow fails", async () => {
    let calls = 0
    let logins = 0
    const models = await discoverModelsFromCommand("kiro-cli", ["chat", "--list-models"], {
      loginOnAuthFailure: true,
      login: async () => {
        logins += 1
        return false
      },
      runner: async () => {
        calls += 1
        return { ok: false, stdout: "", stderr: "not authenticated" }
      },
    })

    expect(logins).toBe(1)
    expect(calls).toBe(1)
    expect(models).toEqual([])
  })
})
