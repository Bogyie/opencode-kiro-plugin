import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeKiroDeviceAuthKey } from "../src/auth.js"
import { acpTransportOptions, createKiroPlugin, effectiveBackend, fetchTransportOptions } from "../src/plugin.js"

const input = {
  client: {},
  project: {},
  directory: "/tmp/project",
  worktree: "/tmp/project",
  experimental_workspace: { register: () => undefined },
  serverUrl: new URL("http://localhost"),
  $: {},
} as any

const withoutDiscovery = { modelDiscovery: "off" } as const
let originalModelCachePath: string | undefined
let isolatedModelCacheDirectory: string | undefined

beforeEach(() => {
  originalModelCachePath = process.env.OPENCODE_KIRO_MODEL_CACHE
  isolatedModelCacheDirectory = mkdtempSync(join(tmpdir(), "opencode-kiro-plugin-test-cache-"))
  process.env.OPENCODE_KIRO_MODEL_CACHE = join(isolatedModelCacheDirectory, "models.json")
})

afterEach(() => {
  if (originalModelCachePath === undefined) delete process.env.OPENCODE_KIRO_MODEL_CACHE
  else process.env.OPENCODE_KIRO_MODEL_CACHE = originalModelCachePath
  if (isolatedModelCacheDirectory) rmSync(isolatedModelCacheDirectory, { recursive: true, force: true })
  isolatedModelCacheDirectory = undefined
  originalModelCachePath = undefined
})

async function providerModels(hooks: Awaited<ReturnType<ReturnType<typeof createKiroPlugin>>>, models: Record<string, unknown> = {}) {
  return hooks.provider?.models?.(
    {
      id: "kiro",
      name: "Kiro",
      models,
    } as any,
    {},
  )
}

async function waitForProviderModel(
  hooks: Awaited<ReturnType<ReturnType<typeof createKiroPlugin>>>,
  modelID: string,
): Promise<any> {
  let models: any
  for (let attempt = 0; attempt < 20; attempt += 1) {
    models = await providerModels(hooks)
    if (models?.[modelID]) return models
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return models
}

async function refreshModels(hooks: Awaited<ReturnType<ReturnType<typeof createKiroPlugin>>>) {
  return (hooks.tool?.kiro_refresh_models as any)?.execute({}, {})
}

function tempMarker() {
  const directory = mkdtempSync(join(tmpdir(), "opencode-kiro-plugin-"))
  const marker = join(directory, "called")
  return {
    marker,
    command: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "called")`],
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
}

describe("Kiro plugin", () => {
  test("selects direct fetch as the auto backend", () => {
    const original = process.env.KIRO_API_KEY
    delete process.env.KIRO_API_KEY
    try {
      expect(effectiveBackend({ backend: "auto" })).toBe("fetch")
      expect(effectiveBackend({ backend: "auto" }, "kiro-plugin-local-transport")).toBe("fetch")
      expect(effectiveBackend({ backend: "auto" }, "token")).toBe("fetch")
      expect(effectiveBackend({ backend: "fetch" })).toBe("fetch")
      expect(effectiveBackend({ backend: "cli-chat" })).toBe("cli-chat")
    } finally {
      if (original === undefined) delete process.env.KIRO_API_KEY
      else process.env.KIRO_API_KEY = original
    }
  })

  test("maps plugin timeout options to ACP prompt timeout", () => {
    expect(acpTransportOptions({ requestTimeoutMs: 30_000, trustAllTools: true })).toEqual({
      promptTimeoutMs: 30_000,
      trustAllTools: true,
    })
    expect(acpTransportOptions({ trustAllTools: false })).toEqual({
      trustAllTools: false,
    })
  })

  test("maps plugin fetch options to Kiro REST transport options", () => {
    expect(
      fetchTransportOptions(
        {
          region: "eu-central-1",
          endpoint: "https://custom.example",
          profileArn: "arn:aws:q:test",
          userAgent: "custom-agent",
          agentMode: "agentic",
          maxAttempts: 5,
          requestTimeoutMs: 30_000,
        },
        "token",
      ),
    ).toEqual({
      region: "eu-central-1",
      accessToken: "token",
      endpoint: "https://custom.example",
      profileArn: "arn:aws:q:test",
      userAgent: "custom-agent",
      agentMode: "agentic",
      maxAttempts: 5,
      requestTimeoutMs: 30_000,
    })
  })

  test("exports config, auth, and provider hooks", async () => {
    const hooks = await createKiroPlugin()(input, undefined)

    expect(hooks.config).toBeFunction()
    expect(hooks.auth?.provider).toBe("kiro")
    expect(hooks.auth?.methods.map((method) => method.type)).toEqual(["oauth", "api"])
    expect(hooks.auth?.methods.map((method) => method.label)).toEqual(["Kiro device login", "Kiro API key"])
    expect(hooks.provider?.id).toBe("kiro")
  })

  test("tags Kiro chat requests with the OpenCode agent header", async () => {
    const hooks = await createKiroPlugin()(input, withoutDiscovery)
    const output = { headers: {} as Record<string, string> }

    await hooks["chat.headers"]?.(
      {
        sessionID: "ses_test",
        agent: "title",
        model: { providerID: "kiro" },
        provider: { id: "kiro" },
        message: { id: "msg_test" },
      } as any,
      output as any,
    )

    expect(output.headers["x-opencode-kiro-agent"]).toBe("title")
    await hooks.dispose?.()
  })

  test("keeps connector login on the Kiro CLI device-flow path", async () => {
    const hooks = await createKiroPlugin()(input, {
      profileArn: "arn:aws:codewhisperer:ap-northeast-2:123456789012:profile/PROFILEID",
      login: {
        identityProvider: "https://example.awsapps.com/start",
        region: "ap-northeast-2",
      },
    })

    expect(hooks.auth?.methods[0]?.label).toBe("Kiro device login")
    expect(hooks.auth?.methods[0]).not.toHaveProperty("prompts")
  })

  test("injects provider config without replacing user model overrides", async () => {
    const hooks = await createKiroPlugin()(input, { ...withoutDiscovery, region: "eu-central-1" })
    const config: any = {
      provider: {
        kiro: {
          api: "https://custom.example",
          models: {
            auto: { name: "Custom Auto" },
          },
        },
      },
    }

    await hooks.config?.(config)

    expect(config.provider.kiro.name).toBe("Kiro")
    expect(config.provider.kiro.npm).toBe("@ai-sdk/openai-compatible")
    expect(config.provider.kiro.api.startsWith("http://127.0.0.1:")).toBe(true)
    expect(config.provider.kiro.models.auto.name).toBe("Custom Auto")
    expect(config.provider.kiro.models["claude-sonnet-4.6"]).toBeUndefined()
    await hooks.dispose?.()
  })

  test("injects only explicit extra model presets and lets user config override them", async () => {
    const hooks = await createKiroPlugin()(input, {
      ...withoutDiscovery,
      extraModels: {
        "claude-opus-4-9": {
          name: "Claude Opus 4.9",
          limit: { context: 1_000_000, output: 64_000 },
        },
      },
    })
    const config: any = {
      provider: {
        kiro: {
          models: {
            "claude-opus-4-9": { name: "User Opus" },
          },
        },
      },
    }

    await hooks.config?.(config)

    expect(config.provider.kiro.models["claude-opus-4-9"].name).toBe("User Opus")
    expect(config.provider.kiro.models["claude-sonnet-4.6"]).toBeUndefined()
    await hooks.dispose?.()
  })

  test("injects a connector-visible provider with an auto model during startup", async () => {
    const marker = tempMarker()
    const hooks = await createKiroPlugin()(input, {
      modelDiscoveryCommand: marker.command,
    })
    const config: any = {}

    try {
      await hooks.config?.(config)

      expect(config.provider.kiro.name).toBe("Kiro")
      expect(config.provider.kiro.npm).toBe("@ai-sdk/openai-compatible")
      expect(config.provider.kiro.api.startsWith("http://127.0.0.1:")).toBe(true)
      expect(config.provider.kiro.models).toEqual({ auto: { name: "Auto" } })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(existsSync(marker.marker)).toBe(true)
      await hooks.dispose?.()
    } finally {
      marker.cleanup()
    }
  })

  test("refreshes models during startup config when discovery succeeds", async () => {
    const hooks = await createKiroPlugin()(input, {
      modelDiscoveryCommand: [
        process.execPath,
        "-e",
        "console.log(JSON.stringify({models:[{id:'startup-model',name:'Startup Model'}]}))",
      ],
    })
    const config: any = {}

    await hooks.config?.(config)

    expect(config.provider.kiro.models["startup-model"].name).toBe("Startup Model")
    expect(config.provider.kiro.models.auto).toBeUndefined()
    await hooks.dispose?.()
  })

  test("uses stored model cache during startup when discovery fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-kiro-model-cache-"))
    const cachePath = join(directory, "models.json")
    const original = process.env.OPENCODE_KIRO_MODEL_CACHE
    process.env.OPENCODE_KIRO_MODEL_CACHE = cachePath
    writeFileSync(
      cachePath,
      JSON.stringify({
        updatedAt: 1234,
        models: [{ id: "cached-model", name: "Cached Model" }],
      }),
    )

    try {
      const hooks = await createKiroPlugin()(input, {
        modelDiscoveryCommand: [process.execPath, "-e", "process.exit(1)"],
      })
      const config: any = {}

      await hooks.config?.(config)

      expect(config.provider.kiro.models["cached-model"].name).toBe("Cached Model")
      expect(config.provider.kiro.models.auto).toBeUndefined()
      await hooks.dispose?.()
    } finally {
      if (original === undefined) delete process.env.OPENCODE_KIRO_MODEL_CACHE
      else process.env.OPENCODE_KIRO_MODEL_CACHE = original
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("refreshes models after successful connector device login", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-kiro-connector-login-"))
    const fakeCli = join(directory, "kiro-cli")
    const cachePath = join(directory, "models.json")
    const originalPath = process.env.PATH
    const originalApiKey = process.env.KIRO_API_KEY
    const originalCache = process.env.OPENCODE_KIRO_MODEL_CACHE
    writeFileSync(
      fakeCli,
      [
        "#!/usr/bin/env node",
        'if (process.argv[2] === "login") {',
        '  console.log("Open https://app.kiro.dev/signin and enter ABCD-EFGH")',
        "  process.exit(0)",
        "}",
        'if (process.argv[2] === "whoami") {',
        '  console.log("dev@example.com")',
        "  process.exit(0)",
        "}",
        "process.exit(1)",
      ].join("\n"),
    )
    chmodSync(fakeCli, 0o755)
    process.env.PATH = `${directory}:${originalPath ?? ""}`
    delete process.env.KIRO_API_KEY
    process.env.OPENCODE_KIRO_MODEL_CACHE = cachePath

    try {
      const hooks = await createKiroPlugin()(input, {
        requestTimeoutMs: 1000,
        modelDiscoveryCommand: [
          process.execPath,
          "-e",
          "console.log(JSON.stringify({models:[{id:'connector-model',name:'Connector Model'}]}))",
        ],
      })
      const authorize = hooks.auth?.methods[0]?.authorize
      expect(authorize).toBeFunction()

      const flow = await authorize?.({})
      expect(flow).toHaveProperty("callback")
      const result = await (flow as { callback(): Promise<unknown> }).callback()
      const models = await providerModels(hooks)

      expect(result).toEqual({
        type: "success",
        key: "kiro-plugin-local-transport",
        metadata: { source: "kiro-cli-device-flow" },
      })
      expect(models?.["connector-model"]?.name).toBe("Connector Model")
      await hooks.dispose?.()
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalApiKey === undefined) delete process.env.KIRO_API_KEY
      else process.env.KIRO_API_KEY = originalApiKey
      if (originalCache === undefined) delete process.env.OPENCODE_KIRO_MODEL_CACHE
      else process.env.OPENCODE_KIRO_MODEL_CACHE = originalCache
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("synthesizes an auto placeholder when no models are configured", async () => {
    const hooks = await createKiroPlugin()(input, {
      modelDiscoveryCommand: [process.execPath, "-e", "process.exit(1)"],
    })
    const models = await providerModels(hooks)
    expect(models?.auto?.api.id).toBe("auto")
    expect(models?.auto?.api.npm).toBe("@ai-sdk/openai-compatible")
    await hooks.dispose?.()
  })

  test("does not start browser login during startup discovery auth failures", async () => {
    const marker = tempMarker()
    const hooks = await createKiroPlugin()(input, {
      modelDiscoveryCommand: marker.command,
      login: {
        license: "pro",
        identityProvider: "https://example.awsapps.com/start",
        region: "ap-northeast-2",
      },
    })
    const config: any = {}

    try {
      await hooks.config?.(config)
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(config.provider.kiro.models).toEqual({ auto: { name: "Auto" } })
      expect(existsSync(marker.marker)).toBe(true)
      await hooks.dispose?.()
    } finally {
      marker.cleanup()
    }
  })

  test("serves /v1/models from discovery cache fallback without invoking chat transport", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-kiro-model-route-"))
    const counter = join(directory, "count")
    const script = [
      "const fs = require('node:fs')",
      `const file = ${JSON.stringify(counter)}`,
      "const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0",
      "fs.writeFileSync(file, String(count + 1))",
      "process.exit(1)",
    ].join(";")
    const hooks = await createKiroPlugin()(input, {
      modelDiscoveryCommand: [process.execPath, "-e", script],
    })
    const config: any = {}

    try {
      await hooks.config?.(config)
      expect(readFileSync(counter, "utf8")).toBe("1")

      const response = await fetch(`${config.provider.kiro.api}/models`)
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(readFileSync(counter, "utf8")).toBe("2")
      expect(body).toEqual({
        object: "list",
        data: [{ id: "auto", object: "model", created: 0, owned_by: "kiro" }],
      })
      await hooks.dispose?.()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("uses Kiro CLI device flow when chat auth retry starts login", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-kiro-chat-login-"))
    const fakeCli = join(directory, "kiro-cli")
    const log = join(directory, "args")
    const originalPath = process.env.PATH
    const originalApiKey = process.env.KIRO_API_KEY
    writeFileSync(
      fakeCli,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs')",
        `fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n")`,
        'if (process.argv[2] === "chat") {',
        '  console.error("not logged in")',
        "  process.exit(1)",
        "}",
        'if (process.argv[2] === "login") {',
        '  console.log("Open https://app.kiro.dev/signin and enter ABCD-EFGH")',
        "  process.exit(0)",
        "}",
        'if (process.argv[2] === "whoami") {',
        '  console.log("dev@example.com")',
        "  process.exit(0)",
        "}",
        "process.exit(1)",
      ].join("\n"),
    )
    chmodSync(fakeCli, 0o755)
    process.env.PATH = `${directory}:${originalPath ?? ""}`
    delete process.env.KIRO_API_KEY

    try {
      const hooks = await createKiroPlugin()(input, { ...withoutDiscovery, backend: "cli-chat", requestTimeoutMs: 1000 })
      const config: any = {}
      await hooks.config?.(config)

      const response = await fetch(`${config.provider.kiro.api}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      const body = await response.json()

      expect(response.status).toBe(401)
      expect(body.error.code).toBe("KIRO_AUTH_ERROR")
      expect(readFileSync(log, "utf8")).toContain("login --use-device-flow")
      await hooks.dispose?.()
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalApiKey === undefined) delete process.env.KIRO_API_KEY
      else process.env.KIRO_API_KEY = originalApiKey
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("does not start login for OpenCode title requests that fail auth", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-kiro-title-auth-"))
    const fakeCli = join(directory, "kiro-cli")
    const log = join(directory, "args")
    const originalPath = process.env.PATH
    const originalApiKey = process.env.KIRO_API_KEY
    writeFileSync(
      fakeCli,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs')",
        `fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n")`,
        'if (process.argv[2] === "chat") {',
        '  console.error("not logged in")',
        "  process.exit(1)",
        "}",
        'if (process.argv[2] === "login") {',
        '  console.log("Open https://app.kiro.dev/signin and enter ABCD-EFGH")',
        "  process.exit(0)",
        "}",
        "process.exit(1)",
      ].join("\n"),
    )
    chmodSync(fakeCli, 0o755)
    process.env.PATH = `${directory}:${originalPath ?? ""}`
    delete process.env.KIRO_API_KEY

    try {
      const hooks = await createKiroPlugin()(input, { ...withoutDiscovery, backend: "cli-chat", requestTimeoutMs: 1000 })
      const config: any = {}
      await hooks.config?.(config)

      const response = await fetch(`${config.provider.kiro.api}/chat/completions`, {
        method: "POST",
        headers: { "x-opencode-kiro-agent": "title" },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "generate title" }],
        }),
      })
      const body = await response.json()
      const calls = readFileSync(log, "utf8")

      expect(response.status).toBe(401)
      expect(body.error.code).toBe("KIRO_AUTH_ERROR")
      expect(calls).toContain("chat --no-interactive")
      expect(calls).not.toContain("login")
      await hooks.dispose?.()
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalApiKey === undefined) delete process.env.KIRO_API_KEY
      else process.env.KIRO_API_KEY = originalApiKey
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("provider hook adds OpenAI-compatible API metadata only to discovered or configured models", async () => {
    const hooks = await createKiroPlugin()(input, { ...withoutDiscovery, region: "eu-central-1" })
    const config: any = {
      provider: {
        kiro: {
          models: {
            auto: { name: "Auto" },
          },
        },
      },
    }
    await hooks.config?.(config)
    const models = await providerModels(hooks, {
      auto: { name: "Auto" },
      "claude-fable-5": { name: "Stale Fable" },
    })

    expect(models?.auto?.api.id).toBe("auto")
    expect(models?.auto?.api.npm).toBe("@ai-sdk/openai-compatible")
    expect(models?.auto?.api.url.startsWith("http://127.0.0.1:")).toBe(true)
    expect(models?.["claude-fable-5"]).toBeUndefined()
    await hooks.dispose?.()
  })

  test("provider hook uses local OpenAI-compatible endpoint for provider API metadata", async () => {
    const hooks = await createKiroPlugin()(input, {
      ...withoutDiscovery,
      region: "eu-central-1",
      endpoint: "https://custom.example",
    })
    const config: any = {
      provider: {
        kiro: {
          models: {
            auto: { name: "Auto" },
          },
        },
      },
    }

    await hooks.config?.(config)
    const models = await providerModels(hooks, {
      auto: { name: "Auto" },
    })

    expect(config.provider.kiro.api.startsWith("http://127.0.0.1:")).toBe(true)
    expect(models?.auto?.api.url.startsWith("http://127.0.0.1:")).toBe(true)
    await hooks.dispose?.()
  })

  test("provider hook can discover models from a configured command", async () => {
    const hooks = await createKiroPlugin()(input, {
      modelDiscoveryCommand: [
        process.execPath,
        "-e",
        "console.log(JSON.stringify({models:[{id:'new-model-1',name:'New Model 1',context_window_tokens:123456}]}))",
      ],
    })
    await refreshModels(hooks)
    const models = await waitForProviderModel(hooks, "new-model-1")

    expect(models?.["new-model-1"]?.name).toBe("New Model 1")
    expect(models?.["new-model-1"]?.limit).toEqual({
      context: 123456,
      output: 64_000,
    })
    expect(models?.["new-model-1"]?.api.id).toBe("new-model-1")
    expect(models?.["new-model-1"]?.api.npm).toBe("@ai-sdk/openai-compatible")
    expect(models?.["new-model-1"]?.api.url.startsWith("http://127.0.0.1:")).toBe(true)
    expect(models?.["claude-fable-5"]).toBeUndefined()
    await hooks.dispose?.()
  })

  test("explicit extra models do not suppress runtime discovery", async () => {
    const hooks = await createKiroPlugin()(input, {
      extraModels: {
        "manual-model": { name: "Manual Model" },
      },
      modelDiscoveryCommand: [
        process.execPath,
        "-e",
        "console.log(JSON.stringify({models:[{id:'dynamic-model',name:'Dynamic Model'}]}))",
      ],
    })

    const first = await providerModels(hooks)
    expect(first?.["manual-model"]?.name).toBe("Manual Model")

    await refreshModels(hooks)
    const models = await waitForProviderModel(hooks, "dynamic-model")
    expect(models?.["manual-model"]?.name).toBe("Manual Model")
    expect(models?.["dynamic-model"]?.name).toBe("Dynamic Model")
    await hooks.dispose?.()
  })

  test("auth loader uses KIRO_API_KEY without requiring stored OpenCode auth", async () => {
    const original = process.env.KIRO_API_KEY
    process.env.KIRO_API_KEY = "env-key"
    try {
      const hooks = await createKiroPlugin()(input, withoutDiscovery)
      const loaded = await hooks.auth?.loader?.(
        async () => {
          throw new Error("not connected")
        },
        {} as any,
      )

      expect(loaded?.apiKey).toBe("env-key")
      expect(loaded?.baseURL?.startsWith("http://127.0.0.1:")).toBe(true)
      await hooks.dispose?.()
    } finally {
      if (original === undefined) delete process.env.KIRO_API_KEY
      else process.env.KIRO_API_KEY = original
    }
  })

  test("auth loader returns a non-empty key when using local transports", async () => {
    const original = process.env.KIRO_API_KEY
    delete process.env.KIRO_API_KEY
    try {
      const hooks = await createKiroPlugin()(input, { ...withoutDiscovery, backend: "cli-chat" })
      const loaded = await hooks.auth?.loader?.(
        async () => {
          throw new Error("not connected")
        },
        {} as any,
      )

      expect(loaded?.apiKey).toBe("kiro-plugin-local-transport")
      expect(loaded?.baseURL?.startsWith("http://127.0.0.1:")).toBe(true)
      await hooks.dispose?.()
    } finally {
      if (original === undefined) delete process.env.KIRO_API_KEY
      else process.env.KIRO_API_KEY = original
    }
  })

  test("auth loader preserves stored Kiro device OAuth keys", async () => {
    const key = encodeKiroDeviceAuthKey({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3600_000,
      clientId: "client-id",
      clientSecret: "client-secret",
      oidcRegion: "ap-northeast-2",
      region: "us-east-1",
      startUrl: "https://example.awsapps.com/start",
    })
    const hooks = await createKiroPlugin()(input, withoutDiscovery)
    const loaded = await hooks.auth?.loader?.(
      async () => ({ type: "oauth", access: key, refresh: "refresh", expires: Date.now() + 3600_000 }),
      {} as any,
    )

    expect(loaded?.apiKey).toBe(key)
    expect(loaded?.baseURL?.startsWith("http://127.0.0.1:")).toBe(true)
    await hooks.dispose?.()
  })

  test("auth loader can be created with extra models without pass-through", async () => {
    const hooks = await createKiroPlugin()(input, {
      ...withoutDiscovery,
      backend: "acp",
      disableModelPassThrough: true,
      extraModels: {
        "claude-opus-4-9": { name: "Claude Opus 4.9" },
      },
    })
    const loaded = await hooks.auth?.loader?.(
      async () => {
        throw new Error("not connected")
      },
      {} as any,
    )

    expect(loaded?.baseURL?.startsWith("http://127.0.0.1:")).toBe(true)
    await hooks.dispose?.()
  })

  test("auth loader wires ACP backend without requiring API key", async () => {
    const original = process.env.KIRO_API_KEY
    delete process.env.KIRO_API_KEY
    try {
      const hooks = await createKiroPlugin()(input, { ...withoutDiscovery, backend: "acp" })
      const loaded = await hooks.auth?.loader?.(
        async () => {
          throw new Error("not connected")
        },
        {} as any,
      )

      expect(loaded?.baseURL?.startsWith("http://127.0.0.1:")).toBe(true)
      await hooks.dispose?.()
    } finally {
      if (original === undefined) delete process.env.KIRO_API_KEY
      else process.env.KIRO_API_KEY = original
    }
  })

  test("provides kiro_status diagnostic tool", async () => {
    const hooks = await createKiroPlugin()(input, { ...withoutDiscovery, backend: "fetch" })

    expect(hooks.tool?.kiro_status).toBeDefined()
    expect(hooks.tool?.kiro_status?.description).toContain("Kiro plugin")
    expect(hooks.tool?.kiro_refresh_models).toBeDefined()
    expect(hooks.tool?.kiro_refresh_models?.description).toContain("Refresh")
  })
})
