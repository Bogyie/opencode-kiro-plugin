import { describe, expect, test } from "bun:test"
import { createKiroFetch } from "../src/fetch-adapter.js"
import { KiroAcpTransport, type AcpSessionClient } from "../src/acp-transport.js"
import type { AcpNotificationHandler } from "../src/acp-client.js"
import { ModelCache } from "../src/model-cache.js"
import { ModelResolver } from "../src/model-resolver.js"

function resolver(): ModelResolver {
  const cache = new ModelCache(60)
  cache.update([{ id: "claude-sonnet-4.6" }, { id: "auto" }])
  return new ModelResolver({ cache })
}

class FakeAcpClient implements AcpSessionClient {
  readonly requests: Array<{ method: string; params?: unknown }> = []
  readonly handlers = new Set<AcpNotificationHandler>()
  closed = false

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push(params === undefined ? { method } : { method, params })
    if (method === "session/new") return { sessionId: "session-1" }
    if (method === "session/prompt") {
      this.notify({
        sessionId: "session-1",
        update: { type: "AgentMessageChunk", content: { type: "text", text: "hello " } },
      })
      this.notify({
        sessionId: "session-1",
        update: { type: "AgentMessageChunk", content: "world" },
      })
      this.notify({
        sessionId: "session-1",
        update: { type: "TurnEnd" },
      })
    }
    return {}
  }

  onNotification(handler: AcpNotificationHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  close(): void {
    this.closed = true
  }

  notify(params: unknown): void {
    for (const handler of this.handlers) {
      handler({ jsonrpc: "2.0", method: "session/notification", params })
    }
  }
}

describe("Kiro ACP transport", () => {
  test("runs initialize, session, model selection, prompt, and collects assistant chunks", async () => {
    const client = new FakeAcpClient()
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: new KiroAcpTransport({ client, cwd: "/tmp/project", promptTimeoutMs: 100 }),
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Previous question" },
          { role: "assistant", content: "Previous answer" },
          { role: "user", content: "Say hello" },
        ],
      }),
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.choices[0].message.content).toBe("hello world")
    expect(client.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_model",
      "session/prompt",
    ])
    expect(client.requests[2]?.params).toEqual({ sessionId: "session-1", model: "claude-sonnet-4.6" })
    expect(JSON.stringify(client.requests[3]?.params)).toContain("System:\\nBe concise.")
    expect(JSON.stringify(client.requests[3]?.params)).toContain("user:\\nSay hello")
    expect(client.closed).toBe(false)
  })

  test("skips model selection for auto model", async () => {
    const client = new FakeAcpClient()
    const fetch = createKiroFetch({
      resolver: resolver(),
      transport: new KiroAcpTransport({ client, promptTimeoutMs: 100 }),
    })

    const response = await fetch("https://q.us-east-1.amazonaws.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(client.requests.map((request) => request.method)).toEqual(["initialize", "session/new", "session/prompt"])
  })
})
