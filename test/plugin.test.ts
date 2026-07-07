import { describe, expect, test } from "bun:test"
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

describe("Kiro plugin", () => {
  test("selects streaming cli-chat as the auto fallback without direct fetch auth", () => {
    const original = process.env.KIRO_API_KEY
    delete process.env.KIRO_API_KEY
    try {
      expect(effectiveBackend({ backend: "auto" })).toBe("cli-chat")
      expect(effectiveBackend({ backend: "auto" }, "kiro-plugin-local-transport")).toBe("cli-chat")
      expect(effectiveBackend({ backend: "auto" }, "token")).toBe("fetch")
      expect(effectiveBackend({ backend: "fetch" })).toBe("none")
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

  test("maps plugin fetch options to CodeWhisperer transport options", () => {
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
    expect(hooks.provider?.id).toBe("kiro")
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

  test("injects discovered models into provider config so the picker can show Kiro", async () => {
    const hooks = await createKiroPlugin()(input, {
      modelDiscoveryCommand: [
        process.execPath,
        "-e",
        "console.log(JSON.stringify({models:[{model_id:'claude-sonnet-5',model_name:'claude-sonnet-5',context_window_tokens:1000000}]}))",
      ],
    })
    const config: any = {}

    await hooks.config?.(config)

    expect(config.provider.kiro.models["claude-sonnet-5"].name).toBe("claude-sonnet-5")
    expect(config.provider.kiro.models["claude-sonnet-5"].limit).toEqual({
      context: 1_000_000,
      output: 64_000,
    })
    await hooks.dispose?.()
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
    const models = await hooks.provider?.models?.(
      {
        id: "kiro",
        name: "Kiro",
        models: {
          auto: { name: "Auto" },
          "claude-fable-5": { name: "Stale Fable" },
        },
      } as any,
      {},
    )

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
    const models = await hooks.provider?.models?.(
      {
        id: "kiro",
        name: "Kiro",
        models: {
          auto: { name: "Auto" },
        },
      } as any,
      {},
    )

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
    const models = await hooks.provider?.models?.(
      {
        id: "kiro",
        name: "Kiro",
        models: {},
      } as any,
      {},
    )

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
  })
})
