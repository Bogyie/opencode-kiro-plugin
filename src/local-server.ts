import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { FetchAdapter } from "./fetch-adapter.js"

export interface LocalKiroServer {
  readonly baseURL: string
  close(): Promise<void>
}

function requestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })

  if (!response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      res.write(Buffer.from(item.value))
    }
    res.end()
  } finally {
    reader.releaseLock()
  }
}

export async function startLocalKiroServer(fetchAdapter: FetchAdapter): Promise<LocalKiroServer> {
  const server = createServer(async (req, res) => {
    try {
      const body = await requestBody(req)
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const init: RequestInit = {
        method: req.method ?? "POST",
        headers: req.headers as HeadersInit,
      }
      if (body.length > 0) init.body = new Uint8Array(body)
      const response = await fetchAdapter(url, init)
      await writeResponse(res, response)
    } catch (error) {
      res.statusCode = 500
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : "Unknown local Kiro server error",
            type: "KIRO_LOCAL_SERVER_ERROR",
            code: "KIRO_LOCAL_SERVER_ERROR",
          },
        }),
      )
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) reject(error)
          else resolve()
        })
      }),
  }
}
