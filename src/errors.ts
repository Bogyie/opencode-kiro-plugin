export class KiroPluginError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 500,
  ) {
    super(message)
    this.name = "KiroPluginError"
  }
}

export class UnsupportedBackendError extends KiroPluginError {
  constructor(message = "Kiro fetch transport is not implemented for this backend yet.") {
    super(message, "UNSUPPORTED_BACKEND", 501)
    this.name = "UnsupportedBackendError"
  }
}

function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Unknown Kiro plugin error"
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : ""
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const status = (error as { status?: unknown; $metadata?: { httpStatusCode?: unknown } }).status
  const metadataStatus = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode
  return typeof status === "number" ? status : typeof metadataStatus === "number" ? metadataStatus : undefined
}

export function normalizeError(error: unknown): KiroPluginError {
  if (error instanceof KiroPluginError) return error

  const message = textOf(error)
  const lower = `${nameOf(error)} ${message}`.toLowerCase()
  const status = statusOf(error)

  if (status === 401 || status === 403 || lower.includes("unauthorized") || lower.includes("not logged in")) {
    return new KiroPluginError(message, "KIRO_AUTH_ERROR", status ?? 401)
  }
  if (status === 429 || lower.includes("rate limit") || lower.includes("quota")) {
    return new KiroPluginError(message, "KIRO_RATE_LIMIT", 429)
  }
  if (status && status >= 500) {
    return new KiroPluginError(message, "KIRO_UPSTREAM_ERROR", status)
  }
  if (lower.includes("network") || lower.includes("timeout") || lower.includes("econn")) {
    return new KiroPluginError(message, "KIRO_NETWORK_ERROR", 502)
  }

  return new KiroPluginError(message, "KIRO_PLUGIN_ERROR")
}

export function errorResponse(error: unknown): Response {
  const known = normalizeError(error)

  return Response.json(
    {
      error: {
        message: known.message,
        type: known.code,
        code: known.code,
      },
    },
    { status: known.status },
  )
}
