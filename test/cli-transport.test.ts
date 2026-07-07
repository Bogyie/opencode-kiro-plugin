import { describe, expect, test } from "bun:test"
import type { CommandRunner } from "../src/auth.js"
import { cliChatArgs, KiroCliChatTransport, promptForCli } from "../src/cli-transport.js"
import type { KiroGenerateRequest } from "../src/request-adapter.js"

const request: KiroGenerateRequest = {
  modelId: "claude-sonnet-4.6",
  system: "Be concise.",
  prompt: "Fix the test",
  history: [
    { role: "user", content: "Previous question" },
    { role: "assistant", content: "Previous answer" },
  ],
  tools: [],
  toolResults: [],
  images: [],
  documents: [],
  stream: false,
  metadata: {
    originalModel: "claude-sonnet-4-6",
    normalizedModel: "claude-sonnet-4.6",
    modelSource: "cache",
    hasTools: false,
  },
}

describe("CLI prompt helpers", () => {
  test("builds prompt with system and history context", () => {
    expect(promptForCli(request)).toBe(
      [
        "System:\nBe concise.",
        "user:\nPrevious question",
        "assistant:\nPrevious answer",
        "user:\nFix the test",
      ].join("\n\n"),
    )
  })

  test("builds official headless chat args", () => {
    expect(cliChatArgs(request, { trustAllTools: true })).toEqual([
      "chat",
      "--no-interactive",
      "--trust-all-tools",
      promptForCli(request),
    ])
  })
})

describe("KiroCliChatTransport", () => {
  test("returns stdout as text response", async () => {
    const calls: unknown[] = []
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args })
      return { ok: true, stdout: "done\n", stderr: "" }
    }
    const transport = new KiroCliChatTransport({ runner })

    await expect(transport.generate(request)).resolves.toEqual({
      text: "done",
      modelId: "claude-sonnet-4.6",
    })
    expect(calls).toEqual([{ command: "kiro-cli", args: cliChatArgs(request) }])
  })

  test("maps cli failures to plugin errors", async () => {
    const runner: CommandRunner = async () => ({ ok: false, stdout: "", stderr: "not logged in" })
    const transport = new KiroCliChatTransport({ runner })

    expect(transport.generate(request)).rejects.toThrow("not logged in")
    try {
      await transport.generate(request)
    } catch (error) {
      expect((error as { code?: string; status?: number }).code).toBe("KIRO_AUTH_ERROR")
      expect((error as { code?: string; status?: number }).status).toBe(401)
    }
  })
})
