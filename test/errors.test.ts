import { describe, expect, test } from "bun:test"
import { errorResponse, KiroPluginError, normalizeError } from "../src/errors.js"

describe("normalizeError", () => {
  test("preserves explicit plugin errors", () => {
    const error = new KiroPluginError("custom", "CUSTOM", 418)

    expect(normalizeError(error)).toBe(error)
  })

  test("classifies auth errors", () => {
    const error = normalizeError(Object.assign(new Error("not logged in"), { status: 403 }))

    expect(error.code).toBe("KIRO_AUTH_ERROR")
    expect(error.status).toBe(403)
  })

  test("classifies quota and rate-limit errors", () => {
    const error = normalizeError(new Error("quota exceeded"))

    expect(error.code).toBe("KIRO_RATE_LIMIT")
    expect(error.status).toBe(429)
  })

  test("classifies upstream 5xx errors from metadata", () => {
    const error = normalizeError(Object.assign(new Error("upstream unavailable"), { $metadata: { httpStatusCode: 503 } }))

    expect(error.code).toBe("KIRO_UPSTREAM_ERROR")
    expect(error.status).toBe(503)
  })

  test("classifies network errors", () => {
    const error = normalizeError(new Error("ECONNRESET"))

    expect(error.code).toBe("KIRO_NETWORK_ERROR")
    expect(error.status).toBe(502)
  })
})

describe("errorResponse", () => {
  test("returns OpenAI-compatible error body", async () => {
    const response = errorResponse(new KiroPluginError("missing auth", "KIRO_AUTH_ERROR", 401))
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toEqual({
      error: {
        message: "missing auth",
        type: "KIRO_AUTH_ERROR",
        code: "KIRO_AUTH_ERROR",
      },
    })
  })
})
