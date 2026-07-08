import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import {
  authorizeKiroDevice,
  credentialFromKiroDeviceAuthKey,
  decodeKiroDeviceAuthKey,
  detectAuth,
  encodeKiroDeviceAuthKey,
  extractKiroLoginCode,
  extractKiroLoginUrl,
  kiroCliLoginArgs,
  kiroDeviceVerificationUrl,
  KIRO_LOCAL_TRANSPORT_KEY,
  KIRO_LOGIN_URL,
  pollKiroDeviceToken,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

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

  test("resolveApiKey accepts stored OAuth connector keys", async () => {
    const key = await resolveApiKey(async () => ({ type: "oauth", key: KIRO_LOCAL_TRANSPORT_KEY }), {})

    expect(key).toBe(KIRO_LOCAL_TRANSPORT_KEY)
  })

  test("resolveApiKey accepts encoded Kiro device auth keys from OAuth storage", async () => {
    const deviceKey = encodeKiroDeviceAuthKey({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3600_000,
      clientId: "client-id",
      clientSecret: "client-secret",
      oidcRegion: "ap-northeast-2",
      region: "us-east-1",
      startUrl: "https://example.awsapps.com/start",
    })
    const key = await resolveApiKey(async () => ({ type: "oauth", access: deviceKey }), {})

    expect(key).toBe(deviceKey)
  })

  test("resolveApiKey ignores generic OAuth access tokens", async () => {
    const key = await resolveApiKey(async () => ({ type: "oauth", access: "plain-oauth-access-token" }), {})

    expect(key).toBe("")
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
    expect(kiroCliLoginArgs({ method: "github", useDeviceFlow: true })).toEqual([
      "login",
      "--use-device-flow",
      "--license",
      "free",
    ])
    expect(kiroCliLoginArgs({ method: "organization", useDeviceFlow: true })).toEqual([
      "login",
      "--use-device-flow",
      "--license",
      "pro",
    ])
    expect(
      kiroCliLoginArgs({
        method: "organization",
        identityProvider: "https://example.awsapps.com/start",
        region: "ap-northeast-2",
        useDeviceFlow: true,
      }),
    ).toEqual([
      "login",
      "--use-device-flow",
      "--license",
      "pro",
      "--identity-provider",
      "https://example.awsapps.com/start",
      "--region",
      "ap-northeast-2",
    ])
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
    expect(
      kiroCliLoginArgs({
        identityProvider: "https://example.awsapps.com/start",
        region: "ap-northeast-2",
        useDeviceFlow: true,
      }),
    ).toEqual([
      "login",
      "--use-device-flow",
      "--license",
      "pro",
      "--identity-provider",
      "https://example.awsapps.com/start",
      "--region",
      "ap-northeast-2",
    ])
  })

  test("builds IAM Identity Center device verification URL", () => {
    expect(kiroDeviceVerificationUrl("https://example.awsapps.com/start", "ABCD-EFGH")).toBe(
      "https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH",
    )
  })

  test("authorizes and polls Kiro device auth without localhost callback", async () => {
    const calls: string[] = []
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      calls.push(`${init?.method ?? "GET"} ${url}`)
      if (url.endsWith("/client/register")) {
        return jsonResponse({ clientId: "client-id", clientSecret: "client-secret" })
      }
      if (url.endsWith("/device_authorization")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          clientId: "client-id",
          clientSecret: "client-secret",
          startUrl: "https://example.awsapps.com/start",
        })
        return jsonResponse({
          verificationUri: "https://device.example",
          verificationUriComplete: "https://device.example/?user_code=ABCD-EFGH",
          userCode: "ABCD-EFGH",
          deviceCode: "device-code",
          interval: 0.001,
          expiresIn: 1,
        })
      }
      if (url.endsWith("/token")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          clientId: "client-id",
          clientSecret: "client-secret",
          deviceCode: "device-code",
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
        })
        return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
      }
      throw new Error(`unexpected request ${url}`)
    }

    const authorization = await authorizeKiroDevice(
      { identityProvider: "https://example.awsapps.com/start/", region: "ap-northeast-2" },
      fetcher,
    )
    const credential = await pollKiroDeviceToken(authorization, { region: "us-east-1" }, fetcher)

    expect(authorization).toMatchObject({
      userCode: "ABCD-EFGH",
      oidcRegion: "ap-northeast-2",
      startUrl: "https://example.awsapps.com/start",
    })
    expect(credential).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      clientId: "client-id",
      clientSecret: "client-secret",
      oidcRegion: "ap-northeast-2",
      region: "us-east-1",
    })
    expect(calls).toEqual([
      "POST https://oidc.ap-northeast-2.amazonaws.com/client/register",
      "POST https://oidc.ap-northeast-2.amazonaws.com/device_authorization",
      "POST https://oidc.ap-northeast-2.amazonaws.com/token",
    ])
  })

  test("encodes, decodes, and refreshes stored Kiro device auth keys", async () => {
    const key = encodeKiroDeviceAuthKey({
      accessToken: "old-access",
      refreshToken: "refresh",
      expiresAt: Date.now() - 1000,
      clientId: "client-id",
      clientSecret: "client-secret",
      oidcRegion: "ap-northeast-2",
      region: "us-east-1",
      startUrl: "https://example.awsapps.com/start",
    })
    const decoded = decodeKiroDeviceAuthKey(key)
    expect(decoded?.refreshToken).toBe("refresh")

    let refreshes = 0
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      refreshes += 1
      expect(String(input)).toBe("https://oidc.ap-northeast-2.amazonaws.com/token")
      expect(JSON.parse(String(init?.body))).toMatchObject({
        refreshToken: "refresh",
        clientId: "client-id",
        clientSecret: "client-secret",
        grantType: "refresh_token",
      })
      return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
    }
    const [credential, sameRefreshCredential] = await Promise.all([
      credentialFromKiroDeviceAuthKey(key, fetcher),
      credentialFromKiroDeviceAuthKey(key, fetcher),
    ])

    expect(credential).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      region: "us-east-1",
      source: "opencode-device-auth",
    })
    expect(sameRefreshCredential?.accessToken).toBe("new-access")
    expect(refreshes).toBe(1)
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
      queueMicrotask(() => {
        stdout.write("Open https://example.com/device and enter ABCD-EFGH")
        child.emit("exit", 0)
      })
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

  test("uses Identity Center device URL when Kiro CLI prints a code", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
    }
    child.stdout = stdout
    child.stderr = stderr

    const session = startKiroCliLogin(
      {
        method: "organization",
        identityProvider: "https://example.awsapps.com/start",
        region: "ap-northeast-2",
        useDeviceFlow: true,
      },
      () => {
        queueMicrotask(() => stdout.write("Confirm the following code in the browser\nCode: ABCD-EFGH\nLogging in..."))
        return child as unknown as ChildProcess
      },
    )

    expect(await session.waitForPrompt(1000)).toBe(true)
    expect(session.url).toBe("https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH")
    expect(session.instructions).toContain("https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH")
  })

  test("answers Kiro CLI Identity Center prompts from configured options", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
    }
    child.stdin = stdin
    child.stdout = stdout
    child.stderr = stderr
    const writes: string[] = []
    stdin.on("data", (chunk) => writes.push(chunk.toString("utf8")))

    const session = startKiroCliLogin(
      {
        method: "organization",
        identityProvider: "https://example.awsapps.com/start",
        region: "ap-northeast-2",
        useDeviceFlow: true,
      },
      () => {
        queueMicrotask(() => {
          stdout.write("? Enter Start URL\n")
          stdout.write("? Enter Region\n")
          stdout.write("Code: ABCD-EFGH\n")
        })
        return child as unknown as ChildProcess
      },
    )

    expect(await session.waitForPrompt(1000)).toBe(true)
    expect(writes).toEqual(["https://example.awsapps.com/start\n", "ap-northeast-2\n"])
  })

  test("selects configured Kiro CLI login method when the prompt appears", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
    }
    child.stdin = stdin
    child.stdout = stdout
    child.stderr = stderr
    const writes: string[] = []
    stdin.on("data", (chunk) => writes.push(chunk.toString("utf8")))

    const session = startKiroCliLogin({ method: "github", useDeviceFlow: true }, () => {
      queueMicrotask(() => {
        stdout.write("? Select login method\n")
        stdout.write("Use with Builder ID\nUse with Google\nUse with GitHub\nUse with Your Organization\n")
        stdout.write("Open https://example.com/device and enter ABCD-EFGH")
      })
      return child as unknown as ChildProcess
    })

    expect(await session.waitForPrompt(1000)).toBe(true)
    expect(writes).toEqual(["\x1B[B\x1B[B\r"])
  })

  test("continues waiting for auth after a login URL even if kiro-cli exits non-zero", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
    }
    child.stdout = stdout
    child.stderr = stderr

    const session = startKiroCliLogin(() => {
      queueMicrotask(() => {
        stdout.write("Open https://app.kiro.dev/signin?redirect_from=kirocli")
        child.emit("exit", 1)
      })
      return child as unknown as ChildProcess
    })

    expect(await session.waitForPrompt(1000)).toBe(true)
    let checks = 0
    const authenticated = await session.waitForAuth(async () => {
      checks += 1
      return checks > 1 ? { ok: true, stdout: "dev@example.com", stderr: "" } : { ok: false, stdout: "", stderr: "" }
    })

    expect(authenticated).toBe(true)
    expect(checks).toBe(2)
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
      queueMicrotask(() => {
        stdout.write("Open https://example.com/device and enter ABCD-EFGH")
        child.emit("exit", 0)
      })
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
