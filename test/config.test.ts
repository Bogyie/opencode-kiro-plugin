import { describe, expect, test } from "bun:test"
import { DEFAULT_MODEL_CACHE_TTL_SECONDS, loadOptions } from "../src/config.js"

describe("loadOptions", () => {
  test("loads defaults from empty input", () => {
    expect(loadOptions()).toMatchObject({
      providerID: "kiro",
      region: "us-east-1",
      backend: "auto",
      modelDiscovery: "auto",
      modelCacheTtlSeconds: DEFAULT_MODEL_CACHE_TTL_SECONDS,
      modelAliases: {},
      hiddenModels: {},
      disabledModels: [],
      disableModelPassThrough: false,
    })
  })

  test("accepts supported knobs and ignores invalid shapes", () => {
    expect(
      loadOptions({
        providerID: "kiro-dev",
        region: "eu-central-1",
        backend: "fetch",
        modelDiscovery: "off",
        modelCacheTtlSeconds: 30,
        modelAliases: { sonnet: "claude-sonnet-4.6", bad: 123 },
        hiddenModels: { legacy: "INTERNAL" },
        disabledModels: ["auto", 123],
        disableModelPassThrough: true,
      }),
    ).toMatchObject({
      providerID: "kiro-dev",
      region: "eu-central-1",
      backend: "fetch",
      modelDiscovery: "off",
      modelCacheTtlSeconds: 30,
      modelAliases: { sonnet: "claude-sonnet-4.6" },
      hiddenModels: { legacy: "INTERNAL" },
      disabledModels: ["auto"],
      disableModelPassThrough: true,
    })
  })
})

