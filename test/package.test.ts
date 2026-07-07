import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  files?: string[]
  opencode?: {
    type?: string
    hooks?: string[]
  }
}

describe("package metadata", () => {
  test("declares every OpenCode hook exposed by the plugin", () => {
    expect(packageJson.opencode).toEqual({
      type: "plugin",
      hooks: ["auth", "config", "provider", "tool"],
    })
  })

  test("includes documentation, examples, and license in published package", () => {
    expect(packageJson.files).toEqual(["dist", "README.md", "CHANGELOG.md", "LICENSE", "docs", "examples"])
  })
})
