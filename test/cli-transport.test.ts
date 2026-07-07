import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import type { CommandRunner } from "../src/auth.js"
import {
  cliChatArgs,
  KiroCliChatTransport,
  promptForCli,
  sanitizeCliChatOutput,
  sanitizeCliChatStreamingOutput,
} from "../src/cli-transport.js"
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
  modelOptions: {},
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
      "--model",
      "claude-sonnet-4.6",
      "--trust-all-tools",
      promptForCli(request),
    ])
  })

  test("sanitizes non-interactive CLI terminal output", () => {
    expect(sanitizeCliChatOutput("\u001b[m> \u001b[0mHello! Nice to meet you.\n\n Credits: 0.14 - Time: 3s\n")).toBe(
      "Hello! Nice to meet you.",
    )
  })

  test("sanitizes partial streaming CLI output without trimming content chunks", () => {
    expect(sanitizeCliChatStreamingOutput("\u001b[m> \u001b[0m2+2 ")).toBe("2+2 ")
    expect(sanitizeCliChatStreamingOutput("\u001b[m> \u001b[0m2+2 equals \n ▸ Credits: 0.05\n")).toBe("2+2 equals \n")
  })
})

describe("KiroCliChatTransport", () => {
  test("returns stdout as text response", async () => {
    const calls: unknown[] = []
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, options })
      return { ok: true, stdout: "done\n", stderr: "" }
    }
    const transport = new KiroCliChatTransport({ runner })

    await expect(transport.generate(request)).resolves.toEqual({
      text: "done",
      modelId: "claude-sonnet-4.6",
    })
    expect(calls).toEqual([{ command: "kiro-cli", args: cliChatArgs(request), options: { timeoutMs: 120_000 } }])
  })

  test("passes configured request timeout to kiro-cli", async () => {
    const calls: unknown[] = []
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, options })
      return { ok: true, stdout: "done\n", stderr: "" }
    }
    const transport = new KiroCliChatTransport({ runner, requestTimeoutMs: 30_000 })

    await transport.generate(request)

    expect(calls).toEqual([{ command: "kiro-cli", args: cliChatArgs(request), options: { timeoutMs: 30_000 } }])
  })

  test("maps cli failures to plugin errors", async () => {
    const runner: CommandRunner = async () => ({ ok: false, stdout: "", stderr: "not logged in" })
    let logins = 0
    const transport = new KiroCliChatTransport({
      runner,
      login: async () => {
        logins += 1
        return false
      },
    })

    await expect(transport.generate(request)).rejects.toThrow("not logged in")
    try {
      await transport.generate(request)
    } catch (error) {
      expect((error as { code?: string; status?: number }).code).toBe("KIRO_AUTH_ERROR")
      expect((error as { code?: string; status?: number }).status).toBe(401)
    }
    expect(logins).toBe(2)
  })

  test("waits for login and retries cli chat once after auth failure", async () => {
    const calls: unknown[] = []
    let logins = 0
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, options })
      if (calls.length === 1) return { ok: false, stdout: "", stderr: "not logged in" }
      return { ok: true, stdout: "done after login\n", stderr: "" }
    }
    const transport = new KiroCliChatTransport({
      runner,
      login: async () => {
        logins += 1
        return true
      },
    })

    await expect(transport.generate(request)).resolves.toEqual({
      text: "done after login",
      modelId: "claude-sonnet-4.6",
    })
    expect(logins).toBe(1)
    expect(calls).toEqual([
      { command: "kiro-cli", args: cliChatArgs(request), options: { timeoutMs: 120_000 } },
      { command: "kiro-cli", args: cliChatArgs(request), options: { timeoutMs: 120_000 } },
    ])
  })

  test("rejects empty successful cli output", async () => {
    const runner: CommandRunner = async () => ({ ok: true, stdout: "\n\u001b[m\n Credits: 0.01 - Time: 1s\n", stderr: "" })
    const transport = new KiroCliChatTransport({ runner })

    await expect(transport.generate(request)).rejects.toThrow("kiro-cli chat completed without returning assistant text")
    try {
      await transport.generate(request)
    } catch (error) {
      expect((error as { code?: string; status?: number }).code).toBe("KIRO_EMPTY_RESPONSE")
      expect((error as { code?: string; status?: number }).status).toBe(502)
    }
  })

  test("streams stdout chunks from kiro-cli without waiting for process exit", async () => {
    const calls: unknown[] = []
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      killed: boolean
      exitCode: number | null
      kill(): boolean
    }
    child.stdout = stdout
    child.stderr = stderr
    child.killed = false
    child.exitCode = null
    child.kill = () => {
      child.killed = true
      child.exitCode = 0
      child.emit("exit", null, "SIGTERM")
      return true
    }
    const transport = new KiroCliChatTransport({
      spawner: (command, args) => {
        calls.push({ command, args })
        queueMicrotask(() => {
          stdout.write("\u001b[m> \u001b[0m2+2 ")
          stdout.write("equals ")
          stdout.write("4.")
          child.exitCode = 0
          child.emit("exit", 0, null)
        })
        return child as unknown as ChildProcess
      },
    })

    const chunks = []
    for await (const chunk of transport.stream(request)) chunks.push(chunk)

    expect(calls).toEqual([{ command: "kiro-cli", args: cliChatArgs(request) }])
    expect(chunks).toEqual([
      { type: "text", text: "2+2 ", modelId: "claude-sonnet-4.6" },
      { type: "text", text: "equals ", modelId: "claude-sonnet-4.6" },
      { type: "text", text: "4.", modelId: "claude-sonnet-4.6" },
    ])
  })
})
