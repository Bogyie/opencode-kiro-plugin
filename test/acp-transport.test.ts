import { describe, expect, test } from "bun:test"
import { createKiroFetch } from "../src/fetch-adapter.js"
import { KiroAcpTransport } from "../src/acp-transport.js"
import { ModelCache } from "../src/model-cache.js"
import { ModelResolver } from "../src/model-resolver.js"

function resolver(): ModelResolver {
  const cache = new ModelCache(60)
  cache.update([{ id: "claude-sonnet-4.6" }])
  return new ModelResolver({ cache })
}

describe("Kiro ACP transport", () => {
  test("returns a structured not-implemented error while the ACP session transport is a skeleton", async () => {
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: new KiroAcpTransport(),
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    const body = await response.json()

    expect(response.status).toBe(501)
    expect(body.error.code).toBe("KIRO_ACP_NOT_IMPLEMENTED")
    expect(body.error.message).toContain("ACP backend skeleton")
  })
})
