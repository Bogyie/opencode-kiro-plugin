import { KiroPluginError } from "./errors.js"
import type { KiroTransport } from "./fetch-adapter.js"
import type { KiroGenerateRequest } from "./request-adapter.js"
import type { KiroGenerateResponse } from "./response-adapter.js"

export class KiroAcpTransport implements KiroTransport {
  async generate(_request: KiroGenerateRequest): Promise<KiroGenerateResponse> {
    throw new KiroPluginError(
      "ACP backend skeleton is present, but full Kiro ACP session transport is not implemented yet.",
      "KIRO_ACP_NOT_IMPLEMENTED",
      501,
    )
  }
}
