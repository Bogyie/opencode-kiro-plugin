import { describe, expect, test } from "bun:test"
import { AcpJsonRpcClient, decodeJsonRpc, encodeJsonRpc, type JsonRpcMessage, type JsonRpcRequest } from "../src/acp-client.js"

describe("ACP JSON-RPC client", () => {
  test("encodes and decodes newline-delimited JSON-RPC messages", () => {
    const message = { jsonrpc: "2.0" as const, id: 1, method: "initialize", params: { client: "test" } }
    const encoded = encodeJsonRpc(message)

    expect(encoded.endsWith("\n")).toBe(true)
    expect(decodeJsonRpc(encoded)).toEqual(message)
  })

  test("sends requests and resolves matching responses", async () => {
    const sent: JsonRpcMessage[] = []
    const client = new AcpJsonRpcClient({
      send(message) {
        sent.push(message)
      },
    })

    const promise = client.request("initialize", { client: "test" })

    expect(sent).toEqual([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { client: "test" } }])

    client.receive({ jsonrpc: "2.0", id: 1, result: { ok: true } })

    await expect(promise).resolves.toEqual({ ok: true })
  })

  test("rejects JSON-RPC error responses with ACP error code", async () => {
    const client = new AcpJsonRpcClient({
      send() {
        return undefined
      },
    })

    const promise = client.request("session/new")
    client.receive({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    })

    await expect(promise).rejects.toMatchObject({
      code: "KIRO_ACP_ERROR",
      status: 502,
      message: "Method not found",
    })
  })

  test("emits notifications and ignores unknown response ids", async () => {
    const notifications: unknown[] = []
    const client = new AcpJsonRpcClient({
      send() {
        return undefined
      },
    })
    client.onNotification((notification) => {
      notifications.push(notification)
    })

    const promise = client.request("session/new")

    client.receive({ jsonrpc: "2.0", method: "progress", params: { value: 1 } })
    client.receive({ jsonrpc: "2.0", id: 99, result: "ignored" })
    client.receive({ jsonrpc: "2.0", id: 1, result: "done" })

    expect(notifications).toEqual([{ jsonrpc: "2.0", method: "progress", params: { value: 1 } }])
    await expect(promise).resolves.toBe("done")
  })

  test("responds to agent-origin JSON-RPC requests", async () => {
    const sent: JsonRpcMessage[] = []
    const client = new AcpJsonRpcClient(
      {
        send(message) {
          sent.push(message)
        },
      },
      {
        onRequest(message) {
          expect(message.method).toBe("session/request_permission")
          return { outcome: { outcome: "selected", optionId: "allow-once" } }
        },
      },
    )

    client.receive({ jsonrpc: "2.0", id: 12, method: "session/request_permission", params: { options: [] } })
    await Promise.resolve()

    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 12,
        result: { outcome: { outcome: "selected", optionId: "allow-once" } },
      },
    ])
  })

  test("returns method-not-found for unhandled agent-origin requests", async () => {
    const sent: JsonRpcMessage[] = []
    const client = new AcpJsonRpcClient({
      send(message) {
        sent.push(message)
      },
    })

    client.receive({ jsonrpc: "2.0", id: 13, method: "unknown/method" })
    await Promise.resolve()

    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 13,
        error: { code: -32601, message: "Method not found: unknown/method" },
      },
    ])
  })

  test("rejects all pending requests when the connection closes", async () => {
    const client = new AcpJsonRpcClient({
      send() {
        return undefined
      },
    })

    const first = client.request("session/new")
    const second = client.request("prompt/send")
    const firstError = first.catch((caught) => caught)
    const secondError = second.catch((caught) => caught)
    const error = new Error("closed")

    client.rejectAll(error)

    await expect(firstError).resolves.toBe(error)
    await expect(secondError).resolves.toBe(error)
  })
})
