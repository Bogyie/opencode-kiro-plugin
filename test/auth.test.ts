import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import {
  detectAuth,
  extractKiroLoginCode,
  extractKiroLoginUrl,
  kiroCliLoginArgs,
  KIRO_LOGIN_URL,
  readKiroCliSessionCredential,
  redacted,
  resolveApiKey,
  runKiroLoginFlowOnce,
  startKiroCliLogin,
  startKiroCliLoginOnce,
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
    expect(
      extractKiroLoginUrl(
        "Open https://us-east-1.signin.aws/platform/example/login?workflowStateHandle=abc then https://app.kiro.dev/signin?state=vKegj05kik&code_challenge=Xdjl98tT9W877w0wloRSvZEPlbiEtoL3zJoFGxkFCTI&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A3128&redirect_from=kirocli",
      ),
    ).toBe(
      "https://app.kiro.dev/signin?state=vKegj05kik&code_challenge=Xdjl98tT9W877w0wloRSvZEPlbiEtoL3zJoFGxkFCTI&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A3128&redirect_from=kirocli",
    )
    expect(
      extractKiroLoginUrl(
        "Callback http://localhost:3128/signin/callback?issuer_url=https%3A%2F%2Fexample.awsapps.com%2Fstart&state=abc",
      ),
    ).toBe("https://example.awsapps.com/start")
    expect(extractKiroLoginUrl("Callback http://127.0.0.1:3128/signin/callback?state=abc")).toBe(KIRO_LOGIN_URL)
    expect(extractKiroLoginUrl("no url yet")).toBe(KIRO_LOGIN_URL)
  })

  test("extracts Kiro login device code from cli output", () => {
    expect(extractKiroLoginCode("enter ABCD-EFGH to continue")).toBe("ABCD-EFGH")
    expect(extractKiroLoginCode("enter ABCDEFGH to continue")).toBe("ABCDEFGH")
    expect(extractKiroLoginCode("no code")).toBeUndefined()
  })

  test("builds Kiro CLI login args for default, device flow, and Identity Center login", () => {
    expect(kiroCliLoginArgs()).toEqual(["login"])
    expect(kiroCliLoginArgs({ useDeviceFlow: true })).toEqual(["login", "--use-device-flow"])
    expect(
      kiroCliLoginArgs({
        license: "pro",
        identityProvider: "https://example.awsapps.com/start",
        region: "ap-northeast-2",
      }),
    ).toEqual([
      "login",
      "--license",
      "pro",
      "--identity-provider",
      "https://example.awsapps.com/start",
      "--region",
      "ap-northeast-2",
    ])
  })

  test("starts Kiro CLI login and waits for whoami success", async () => {
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
    const prompted = await session.waitForPrompt(1000)
    const authenticated = await session.waitForAuth(async () => ({ ok: true, stdout: "dev@example.com", stderr: "" }))

    expect(calls).toEqual([{ command: "kiro-cli", args: ["login"] }])
    expect(prompted).toBe(true)
    expect(session.url).toBe("https://example.com/device")
    expect(session.code).toBe("ABCD-EFGH")
    expect(session.instructions).toBe("Enter code: ABCD-EFGH")
    expect(authenticated).toBe(true)
  })

  test("starts Kiro CLI login with configured Identity Center options", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
    }
    child.stdout = stdout
    child.stderr = stderr
    const calls: unknown[] = []

    const session = startKiroCliLogin(
      {
        license: "pro",
        identityProvider: "https://example.awsapps.com/start",
        region: "ap-northeast-2",
      },
      (command, args) => {
        calls.push({ command, args })
        queueMicrotask(() => stdout.write("Open https://app.kiro.dev/signin?redirect_from=kirocli"))
        return child as unknown as ChildProcess
      },
    )

    expect(await session.waitForPrompt(1000)).toBe(true)
    expect(calls).toEqual([
      {
        command: "kiro-cli",
        args: [
          "login",
          "--license",
          "pro",
          "--identity-provider",
          "https://example.awsapps.com/start",
          "--region",
          "ap-northeast-2",
        ],
      },
    ])
  })

  test("reuses an in-flight Kiro CLI device login session", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
    }
    child.stdout = stdout
    child.stderr = stderr
    let starts = 0

    const spawner = () => {
      starts += 1
      return child as unknown as ChildProcess
    }

    const first = startKiroCliLoginOnce(spawner)
    const second = startKiroCliLoginOnce(spawner)

    expect(second).toBe(first)
    expect(starts).toBe(1)
    await first.waitForAuth(async () => ({ ok: true, stdout: "dev@example.com", stderr: "" }))
  })

  test("shares concurrent Kiro CLI login flows", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
    }
    child.stdout = stdout
    child.stderr = stderr
    let starts = 0
    const spawner = () => {
      starts += 1
      queueMicrotask(() => stdout.write("Open https://example.com/device and enter ABCD-EFGH"))
      return child as unknown as ChildProcess
    }

    const results = await Promise.all([
      runKiroLoginFlowOnce({ spawner, runner: async () => ({ ok: true, stdout: "dev@example.com", stderr: "" }) }),
      runKiroLoginFlowOnce({ spawner, runner: async () => ({ ok: true, stdout: "dev@example.com", stderr: "" }) }),
    ])

    expect(results).toEqual([true, true])
    expect(starts).toBe(1)
  })

  test("reads Kiro CLI session credential from SQLite rows", async () => {
    const runner: CommandRunner = async (_command, args) => {
      const query = args[1]
      if (typeof query === "string" && query.includes("api.codewhisperer.profile")) {
        return {
          ok: true,
          stdout: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
          stderr: "",
        }
      }
      if (typeof query === "string" && query.includes("kirocli:odic:token")) {
        return {
          ok: true,
          stdout: JSON.stringify({
            access_token: "access",
            refresh_token: "refresh",
            expires_at: "2026-07-07T10:00:00Z",
          }),
          stderr: "",
        }
      }
      return { ok: false, stdout: "", stderr: "missing" }
    }

    const credential = await readKiroCliSessionCredential({ dbPath: "/tmp" }, runner)

    expect(credential).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: "2026-07-07T10:00:00Z",
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
      region: "us-east-1",
      source: "kirocli:odic:token",
    })
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
