import { describe, expect, test } from "bun:test"
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_MODEL_CACHE_TTL_SECONDS, DEFAULT_MODEL_DISCOVERY_COMMAND, loadOptions } from "../src/config.js"

describe("loadOptions", () => {
  test("loads defaults from empty input", () => {
    expect(loadOptions()).toMatchObject({
      providerID: "kiro",
      region: "us-east-1",
      login: { useDeviceFlow: false },
      backend: "auto",
      modelDiscovery: "auto",
      modelDiscoveryCommand: DEFAULT_MODEL_DISCOVERY_COMMAND,
      modelCacheTtlSeconds: DEFAULT_MODEL_CACHE_TTL_SECONDS,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      modelAliases: {},
      extraModels: {},
      hiddenModels: {},
      disabledModels: [],
      disableModelPassThrough: false,
      trustAllTools: false,
    })
  })

  test("accepts supported knobs and ignores invalid shapes", () => {
    expect(
      loadOptions({
        providerID: "kiro-dev",
        region: "eu-central-1",
        login: {
          method: "organization",
          license: "pro",
          identityProvider: " https://example.awsapps.com/start ",
          region: " ap-northeast-2 ",
          useDeviceFlow: true,
          extraArgs: ["--verbose", 123],
        },
        endpoint: " https://custom.example ",
        backend: "fetch",
        modelDiscovery: "off",
        modelDiscoveryCommand: ["kiro-cli", "chat", "--list-models", "--format", "json", 123],
        modelCacheTtlSeconds: 30,
        requestTimeoutMs: 1000,
        maxAttempts: 5,
        profileArn: " arn:aws:q:test ",
        userAgent: " custom-agent ",
        agentMode: " agentic ",
        modelAliases: { sonnet: "claude-sonnet-4.6", bad: 123 },
        extraModels: {
          "claude-opus-4-9": { name: "Claude Opus 4.9" },
          bad: "not a model",
        },
        hiddenModels: { legacy: "INTERNAL" },
        disabledModels: ["auto", 123],
        disableModelPassThrough: true,
        trustAllTools: true,
      }),
    ).toMatchObject({
      providerID: "kiro-dev",
      region: "eu-central-1",
      login: {
        method: "organization",
        license: "pro",
        identityProvider: "https://example.awsapps.com/start",
        region: "ap-northeast-2",
        useDeviceFlow: true,
        extraArgs: ["--verbose"],
      },
      endpoint: "https://custom.example",
      backend: "fetch",
      modelDiscovery: "off",
      modelDiscoveryCommand: ["kiro-cli", "chat", "--list-models", "--format", "json"],
      modelCacheTtlSeconds: 30,
      requestTimeoutMs: 1000,
      maxAttempts: 5,
      profileArn: "arn:aws:q:test",
      userAgent: "custom-agent",
      agentMode: "agentic",
      modelAliases: { sonnet: "claude-sonnet-4.6" },
      extraModels: { "claude-opus-4-9": { name: "Claude Opus 4.9" } },
      hiddenModels: { legacy: "INTERNAL" },
      disabledModels: ["auto"],
      disableModelPassThrough: true,
      trustAllTools: true,
    })
  })

  test("keeps maxAttempts as a positive integer", () => {
    expect(loadOptions({ maxAttempts: 2.8 }).maxAttempts).toBe(2)
    expect(loadOptions({ maxAttempts: 0.5 }).maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS)
  })
})
