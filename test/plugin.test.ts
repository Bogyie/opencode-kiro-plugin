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
