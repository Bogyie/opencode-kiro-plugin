import { beforeAll, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createKiroPlugin } from "../src/plugin.js"
import { parseDiscoveredModels } from "../src/model-discovery.js"
import { authorizeKiroDevice, kiroDeviceVerificationUrl, pollKiroDeviceToken } from "../src/auth.js"
import type { KiroDeviceAuthorization, KiroDeviceAuthCredential } from "../src/auth.js"

const execFileAsync = promisify(execFile)
const runReal = process.env.OPENCODE_KIRO_REAL === "1"
const runRealLogin = runReal && process.env.OPENCODE_KIRO_REAL_LOGIN === "1"
const realTest = runReal && !runRealLogin ? test : test.skip
const realLoginTest = runRealLogin ? test : test.skip
let realLoginAuthorization: KiroDeviceAuthorization | undefined
let realLoginCredential: KiroDeviceAuthCredential | undefined
let realLoginPromise: Promise<KiroDeviceAuthCredential> | undefined

function redact(value: string | undefined): string {
  if (!value) return ""
  return value.replace(/https:\/\/[^/\s]+\.awsapps\.com\/start/g, "https://<redacted>.awsapps.com/start")
}

async function run(command: string, args: string[], timeoutMs = 120_000) {
  try {
    const result = await execFileAsync(command, args, { timeout: timeoutMs })
    return { ok: true, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const partial = error as { stdout?: string; stderr?: string }
    return {
      ok: false,
      stdout: partial.stdout ?? "",
      stderr: partial.stderr ?? "",
      error,
    }
  }
}

async function openLoginUrl(url: string) {
  if (process.env.OPENCODE_KIRO_REAL_LOGIN_OPEN === "0") return
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : process.platform === "linux"
          ? "xdg-open"
          : undefined
  const args =
    process.platform === "darwin"
      ? [url]
      : process.platform === "win32"
        ? ["/c", "start", "", url]
        : process.platform === "linux"
          ? [url]
          : []
  if (!command) return
  const result = await run(command, args, 10_000)
  if (!result.ok) console.warn(`Could not open login URL automatically: ${result.stderr || String(result.error)}`)
}

async function runRealIdentityLogin() {
  if (realLoginPromise) return realLoginPromise
  realLoginPromise = (async () => {
    const identityProvider = process.env.KIRO_REAL_IDENTITY_PROVIDER
    const region = process.env.KIRO_REAL_IDENTITY_REGION
    if (!identityProvider) throw new Error("Set KIRO_REAL_IDENTITY_PROVIDER for this real login test.")
    if (!region) throw new Error("Set KIRO_REAL_IDENTITY_REGION for this real login test.")

    const authorization = await authorizeKiroDevice({ identityProvider, region })
    const url = kiroDeviceVerificationUrl(identityProvider, authorization.userCode)
    realLoginAuthorization = authorization
    expect(url).toContain("#/device?user_code=")
    expect(url).not.toContain("app.kiro.dev/signin")
    console.log(`Kiro IAM Identity Center device login URL: ${redact(url)}`)
    console.log(`Confirm code: ${authorization.userCode}`)
    await openLoginUrl(url)
    const credential = await pollKiroDeviceToken(authorization, { region: "us-east-1" })
    realLoginCredential = credential
    return credential
  })()
  return realLoginPromise
}

async function readSse(response: Response) {
  const reader = response.body?.getReader()
  expect(reader).toBeDefined()
  const decoder = new TextDecoder()
  let body = ""
  let chunks = 0
  while (reader) {
    const item = await reader.read()
    if (item.done) break
    chunks += 1
    body += decoder.decode(item.value, { stream: true })
  }
  body += decoder.decode()
  return { body, chunks }
}

function assistantTextFromSse(body: string): string {
  return body
    .split(/\n\n/)
    .map((event) => event.trim())
    .filter((event) => event.startsWith("data: "))
    .map((event) => event.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> })
    .map((item) => item.choices?.[0]?.delta?.content ?? "")
    .join("")
}

async function realModels() {
  const listed = await run("kiro-cli", ["chat", "--list-models", "--format", "json"])
  expect(listed.ok, listed.stderr || String(listed.error)).toBe(true)
  const jsonModels = parseDiscoveredModels(listed.stdout)
  if (jsonModels.length > 0) return jsonModels

  const plain = await run("kiro-cli", ["chat", "--list-models"])
  expect(plain.ok, plain.stderr || String(plain.error)).toBe(true)
  const plainModels = parseDiscoveredModels(plain.stdout)
  expect(
    plainModels.length,
    [
      "kiro-cli returned no parseable models.",
      `json stdout: ${listed.stdout.slice(0, 1000)}`,
      `json stderr: ${listed.stderr.slice(0, 1000)}`,
      `plain stdout: ${plain.stdout.slice(0, 1000)}`,
      `plain stderr: ${plain.stderr.slice(0, 1000)}`,
    ].join("\n"),
  ).toBeGreaterThan(0)
  return plainModels
}

describe("real Kiro CLI integration", () => {
  beforeAll(async () => {
    if (runRealLogin) await runRealIdentityLogin()
  }, 900_000)

  realTest(
    "calls the installed kiro-cli and parses the real model list",
    async () => {
      const version = await run("kiro-cli", ["--version"])
      expect(version.ok, version.stderr || String(version.error)).toBe(true)

      const models = await realModels()
      expect(models.map((model) => model.id)).toContain("auto")
    },
    180_000,
  )

  realTest(
    "calls the plugin local API against the real Kiro backend",
    async () => {
      const models = await realModels()
      const modelIds = models.map((model) => model.id)
      const selectedModel = modelIds.includes("claude-sonnet-4.5")
        ? "claude-sonnet-4.5"
        : modelIds.includes("auto")
          ? "auto"
          : (modelIds[0] as string)

      const plugin = await createKiroPlugin()(
        {
          client: {},
          project: {},
          directory: process.cwd(),
          worktree: process.cwd(),
          experimental_workspace: { register: () => undefined },
          serverUrl: new URL("http://localhost"),
          $: {},
        } as any,
        {
          backend: "auto",
          modelDiscoveryCommand: ["kiro-cli", "chat", "--list-models", "--format", "json"],
          requestTimeoutMs: 120_000,
        },
      )

      try {
        const config: any = {}
        await plugin.config?.(config)
        const localApi = config.provider?.kiro?.api
        expect(typeof localApi).toBe("string")
        expect((localApi as string).startsWith("http://127.0.0.1:")).toBe(true)

        const response = await fetch(`${localApi}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: "Bearer kiro-plugin-local-transport",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: selectedModel,
            messages: [{ role: "user", content: "Answer in one short sentence containing the number 4: what is 2+2?" }],
          }),
        })
        const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
        expect(response.status, JSON.stringify(json)).toBe(200)
        expect(json.choices?.[0]?.message?.content ?? "").toContain("4")

        const stream = await fetch(`${localApi}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: "Bearer kiro-plugin-local-transport",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: selectedModel,
            stream: true,
            messages: [{ role: "user", content: "Answer in one short sentence containing the number 4: what is 2+2?" }],
          }),
        })
        const { body, chunks } = await readSse(stream)
        expect(stream.status, body).toBe(200)
        expect(chunks).toBeGreaterThan(0)
        expect(assistantTextFromSse(body)).toContain("4")
      } finally {
        await plugin.dispose?.()
      }
    },
    240_000,
  )

  realLoginTest(
    "runs the real IAM Identity Center device login flow and waits for completion",
    async () => {
      const credential = realLoginCredential ?? (await runRealIdentityLogin())
      expect(realLoginAuthorization?.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
      expect(credential.accessToken).toBeTruthy()
      expect(credential.refreshToken).toBeTruthy()
    },
    900_000,
  )
})
