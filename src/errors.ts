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

export function errorResponse(error: unknown): Response {
  const known =
    error instanceof KiroPluginError
      ? error
      : new KiroPluginError(error instanceof Error ? error.message : "Unknown Kiro plugin error", "KIRO_PLUGIN_ERROR")

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

