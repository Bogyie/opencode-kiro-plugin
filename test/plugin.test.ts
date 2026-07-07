import { describe, expect, test } from "bun:test"
import { createKiroPlugin } from "../src/plugin.js"

const input = {
  client: {},
  project: {},
  directory: "/tmp/project",
  worktree: "/tmp/project",
  experimental_workspace: { register: () => undefined },
  serverUrl: new URL("http://localhost"),
  $: {},
} as any

describe("Kiro plugin", () => {
  test("exports config, auth, and provider hooks", async () => {
    const hooks = await createKiroPlugin()(input, undefined)

    expect(hooks.config).toBeFunction()
    expect(hooks.auth?.provider).toBe("kiro")
    expect(hooks.provider?.id).toBe("kiro")
  })

  test("injects provider config without replacing user model overrides", async () => {
    const hooks = await createKiroPlugin()(input, { region: "eu-central-1" })
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
    expect(config.provider.kiro.api).toBe("https://custom.example")
    expect(config.provider.kiro.models.auto.name).toBe("Custom Auto")
    expect(config.provider.kiro.models["claude-sonnet-4-6"].limit.context).toBe(1_000_000)
  })

  test("injects extra model presets and lets user config override them", async () => {
    const hooks = await createKiroPlugin()(input, {
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
    expect(config.provider.kiro.models["claude-sonnet-4-6"].name).toBe("Claude Sonnet 4.6")
  })

  test("provider hook adds OpenAI-compatible API metadata to models", async () => {
    const hooks = await createKiroPlugin()(input, { region: "eu-central-1" })
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

    expect(models?.auto?.api).toEqual({
      id: "auto",
      npm: "@ai-sdk/openai-compatible",
      url: "https://q.eu-central-1.amazonaws.com",
    })
  })

  test("auth loader uses KIRO_API_KEY without requiring stored OpenCode auth", async () => {
    const original = process.env.KIRO_API_KEY
    process.env.KIRO_API_KEY = "env-key"
    try {
      const hooks = await createKiroPlugin()(input, undefined)
      const loaded = await hooks.auth?.loader?.(
        async () => {
          throw new Error("not connected")
        },
        {} as any,
      )

      expect(loaded?.apiKey).toBe("env-key")
      expect(loaded?.baseURL).toBe("https://q.us-east-1.amazonaws.com")
      expect(loaded?.fetch).toBeFunction()
    } finally {
      if (original === undefined) delete process.env.KIRO_API_KEY
      else process.env.KIRO_API_KEY = original
    }
  })

  test("auth loader resolves extra models without pass-through", async () => {
    const hooks = await createKiroPlugin()(input, {
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

    const response = await loaded?.fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-9",
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    const body = await response?.json()

    expect(response?.status).toBe(501)
    expect(body.error.code).toBe("KIRO_ACP_NOT_IMPLEMENTED")
  })

  test("auth loader wires ACP backend without requiring API key", async () => {
    const original = process.env.KIRO_API_KEY
    delete process.env.KIRO_API_KEY
    try {
      const hooks = await createKiroPlugin()(input, { backend: "acp" })
      const loaded = await hooks.auth?.loader?.(
        async () => {
          throw new Error("not connected")
        },
        {} as any,
      )

      const response = await loaded?.fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      const body = await response?.json()

      expect(response?.status).toBe(501)
      expect(body.error.code).toBe("KIRO_ACP_NOT_IMPLEMENTED")
    } finally {
      if (original === undefined) delete process.env.KIRO_API_KEY
      else process.env.KIRO_API_KEY = original
    }
  })

  test("provides kiro_status diagnostic tool", async () => {
    const hooks = await createKiroPlugin()(input, { backend: "fetch" })

    expect(hooks.tool?.kiro_status).toBeDefined()
    expect(hooks.tool?.kiro_status?.description).toContain("Kiro plugin")
  })
})
