import { KiroPlugin } from "./plugin.js"

export { AcpJsonRpcClient, createAcpStdioClient, decodeJsonRpc, encodeJsonRpc } from "./acp-client.js"
export type { AcpConnection, AcpNotificationHandler, AcpStdioClientOptions, JsonRpcMessage } from "./acp-client.js"
export { acpPermissionResponse, KiroAcpTransport } from "./acp-transport.js"
export type { AcpSessionClient, KiroAcpTransportOptions } from "./acp-transport.js"
export { createKiroPlugin, KiroPlugin } from "./plugin.js"
export { detectAuth, redacted, resolveApiKey } from "./auth.js"
export { cliChatArgs, KiroCliChatTransport, promptForCli } from "./cli-transport.js"
export { createKiroFetch } from "./fetch-adapter.js"
export { loadOptions } from "./config.js"
export { getKiroCliStatus, getKiroCliVersion } from "./kiro-cli.js"
export {
  CodeWhispererKiroTransport,
  collectAssistantText,
  createCodeWhispererClient,
  streamAssistantText,
  toGenerateAssistantResponseInput,
} from "./kiro-transport.js"
export { ModelCache } from "./model-cache.js"
export { discoverModelsFromCommand, parseDiscoveredModels, refreshModelCacheFromCommand } from "./model-discovery.js"
export { ModelResolutionError, ModelResolver, normalizeModelName } from "./model-resolver.js"
export { FALLBACK_MODELS } from "./models.js"
export { toKiroGenerateRequest } from "./request-adapter.js"
export { toOpenAIChatResponse, toOpenAIChatStreamResponse } from "./response-adapter.js"
export type { KiroStreamEvent, KiroToolCallChunk } from "./response-adapter.js"

export default {
  id: "kiro",
  server: KiroPlugin,
}
