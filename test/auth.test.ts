import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import {
  detectAuth,
  extractKiroLoginUrl,
  KIRO_LOGIN_URL,
  redacted,
  resolveApiKey,
  startKiroCliLogin,
  type CommandRunner,
} from "../src/auth.js"
import { getKiroCliStatus, getKiroCliVersion } from "../src/kiro-cli.js"

const failingRunner: CommandRunner = async () => ({ ok: false, stdout: "", stderr: "not found" })

describe("auth diagnostics", () => {
  test("redacts secrets without leaking full values", () => {
    expect(redacted("ksk_1234567890")).toBe("ksk_...7890")
    expect(redacted("short")).toBe("***")
    expect(redacted(undefined)).toBeUndefined()
  })

  test("prefers KIRO_API_KEY without invoking cli", async () => {
    let calls = 0
    const runner: CommandRunner = async () => {
      calls += 1
      return { ok: true, stdout: "ignored", stderr: "" }
    }

    const result = await detectAuth({ KIRO_API_KEY: "ksk_1234567890", KIRO_REGION: "eu-central-1" }, runner)

    expect(calls).toBe(0)
    expect(result).toMatchObject({
      authenticated: true,
      method: "api-key",
      region: "eu-central-1",
    })
    expect(result.message).toContain("ksk_...7890")
  })

  test("uses kiro-cli whoami when api key is absent", async () => {
    const runner: CommandRunner = async (command, args) => {
      expect(command).toBe("kiro-cli")
      expect(args).toEqual(["whoami"])
      return { ok: true, stdout: '{"email":"dev@example.com"}', stderr: "" }
    }

    const result = await detectAuth({}, runner)

    expect(result).toMatchObject({
      authenticated: true,
      method: "cli-session",
      account: "dev@example.com",
      region: "us-east-1",
    })
  })

  test("returns actionable unauthenticated diagnostic", async () => {
    const result = await detectAuth({}, failingRunner)

    expect(result.authenticated).toBe(false)
    expect(result.method).toBe("none")
    expect(result.message).toContain("kiro-cli login")
  })

  test("resolveApiKey prefers env over stored auth", async () => {
    const key = await resolveApiKey(async () => ({ type: "api", key: "stored" }), { KIRO_API_KEY: "env-key" })

    expect(key).toBe("env-key")
  })

  test("resolveApiKey tolerates missing stored auth", async () => {
    const key = await resolveApiKey(async () => {
      throw new Error("not connected")
    }, {})

    expect(key).toBe("")
  })

  test("extracts Kiro login URL from cli output with fallback", () => {
    expect(extractKiroLoginUrl("Open https://example.com/device and continue")).toBe("https://example.com/device")
    expect(extractKiroLoginUrl("no url yet")).toBe(KIRO_LOGIN_URL)
  })

  test("starts Kiro CLI device login and waits for whoami success", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
    }
    child.stdout = stdout
    child.stderr = stderr
    const calls: unknown[] = []

    const session = startKiroCliLogin((command, args) => {
      calls.push({ command, args })
      queueMicrotask(() => stdout.write("Open https://example.com/device and enter ABCD-EFGH"))
      return child as unknown as ChildProcess
    })
    const authenticated = await session.waitForAuth(async () => ({ ok: true, stdout: "dev@example.com", stderr: "" }))

    expect(calls).toEqual([{ command: "kiro-cli", args: ["login", "--use-device-flow"] }])
    expect(session.url).toBe("https://example.com/device")
    expect(session.instructions).toContain("ABCD-EFGH")
    expect(authenticated).toBe(true)
  })
})

describe("kiro-cli helpers", () => {
  test("gets version when cli command succeeds", async () => {
    const version = await getKiroCliVersion(async () => ({ ok: true, stdout: "kiro-cli 1.2.3\n", stderr: "" }))

    expect(version).toBe("kiro-cli 1.2.3")
  })

  test("combines install and auth status", async () => {
    const runner: CommandRunner = async (_command, args) => {
      if (args[0] === "--version") return { ok: true, stdout: "kiro-cli 1.2.3", stderr: "" }
      return { ok: true, stdout: "dev@example.com", stderr: "" }
    }

    const status = await getKiroCliStatus({}, runner)

    expect(status.installed).toBe(true)
    expect(status.version).toBe("kiro-cli 1.2.3")
    expect(status.auth.method).toBe("cli-session")
  })
})
