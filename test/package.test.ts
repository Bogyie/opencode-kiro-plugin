import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name?: string
  files?: string[]
  main?: string
  publishConfig?: {
    access?: string
    registry?: string
  }
  repository?: {
    type?: string
    url?: string
  }
  types?: string
  exports?: {
    "."?: {
      types?: string
      import?: string
    }
  }
  scripts?: Record<string, string>
  opencode?: {
    type?: string
    hooks?: string[]
  }
}

const publishWorkflow = readFileSync(new URL("../.github/workflows/npm-publish.yml", import.meta.url), "utf8")

describe("package metadata", () => {
  test("is named for scoped npm installation through OpenCode", () => {
    expect(packageJson.name).toBe("@bogyie/opencode-kiro-plugin")
    expect(packageJson.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/",
    })
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/bogyie/opencode-kiro-plugin.git",
    })
  })

  test("declares every OpenCode hook exposed by the plugin", () => {
    expect(packageJson.opencode).toEqual({
      type: "plugin",
      hooks: ["auth", "config", "provider", "tool"],
    })
  })

  test("includes documentation, examples, and license in published package", () => {
    expect(packageJson.files).toEqual(["dist", "README.md", "CHANGELOG.md", "LICENSE", "docs", "examples"])
  })

  test("declares ESM package entrypoints", () => {
    expect(packageJson.main).toBe("dist/index.js")
    expect(packageJson.types).toBe("dist/index.d.ts")
    expect(packageJson.exports?.["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    })
  })

  test("cleans and smoke-tests build artifacts before packaging", () => {
    expect(packageJson.scripts?.clean).toBe("node scripts/clean-dist.mjs")
    expect(packageJson.scripts?.build).toBe("npm run clean && tsc -p tsconfig.build.json")
    expect(packageJson.scripts?.prepack).toBe("npm run build")
    expect(packageJson.scripts?.["smoke:package"]).toBe("npm run build && node scripts/smoke-package.mjs")
  })

  test("publishes to npm through trusted publishing from main package version bumps", () => {
    expect(publishWorkflow).toContain("push:")
    expect(publishWorkflow).toContain("branches: [main]")
    expect(publishWorkflow).toContain("package.json")
    expect(publishWorkflow).not.toContain("\n  release:")
    expect(publishWorkflow).not.toContain("types: [published]")
    expect(publishWorkflow).toContain("environment: npm")
    expect(publishWorkflow).toContain("id-token: write")
    expect(publishWorkflow).toContain("contents: write")
    expect(publishWorkflow).toContain("node-version: 24.x")
    expect(publishWorkflow).toContain("oven-sh/setup-bun@v2")
    expect(publishWorkflow).toContain("Determine package release state")
    expect(publishWorkflow).toContain("should_release")
    expect(publishWorkflow).toContain("PACKAGE_EXISTS")
    expect(publishWorkflow).toContain("gh release create")
    expect(publishWorkflow).toContain("Verify package version")
    expect(publishWorkflow).toContain("npm pack --dry-run")
    expect(publishWorkflow).toContain("npm publish --access public --provenance")
    expect(publishWorkflow).not.toContain("NODE_AUTH_TOKEN")
    expect(publishWorkflow).not.toContain("NPM_TOKEN")
  })
})
