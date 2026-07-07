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

  test("publishes to npm only from published GitHub releases", () => {
    expect(publishWorkflow).toContain("release:")
    expect(publishWorkflow).toContain("types: [published]")
    expect(publishWorkflow).toContain("id-token: write")
    expect(publishWorkflow).toContain("oven-sh/setup-bun@v2")
    expect(publishWorkflow).toContain("Verify release tag matches package version")
    expect(publishWorkflow).toContain("npm pack --dry-run")
    expect(publishWorkflow).toContain("npm publish --provenance --access public")
    expect(publishWorkflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}")
  })
})
