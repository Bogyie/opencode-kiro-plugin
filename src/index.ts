import { KiroPlugin } from "./plugin.js"

export { AcpJsonRpcClient, createAcpStdioClient, decodeJsonRpc, encodeJsonRpc } from "./acp-client.js"
export type { AcpConnection, AcpNotificationHandler, AcpStdioClientOptions, JsonRpcMessage } from "./acp-client.js"
export { acpPermissionResponse, KiroAcpTransport } from "./acp-transport.js"
export type { AcpSessionClient, KiroAcpTransportOptions } from "./acp-transport.js"
export { createKiroPlugin, effectiveBackend, KiroPlugin } from "./plugin.js"
export {
  detectAuth,
  extractKiroLoginUrl,
  KIRO_LOGIN_URL,
  readKiroCliSessionCredential,
  redacted,
  regionFromProfileArn,
  resolveApiKey,
  startKiroCliLogin,
  startKiroCliLoginOnce,
} from "./auth.js"
export { cliChatArgs, KiroCliChatTransport, promptForCli } from "./cli-transport.js"
export { createKiroFetch } from "./fetch-adapter.js"
export { loadOptions } from "./config.js"
export { getKiroCliStatus, getKiroCliVersion } from "./kiro-cli.js"
export {
  additionalModelRequestFields,
  CodeWhispererKiroTransport,
  collectAssistantText,
  createCodeWhispererClient,
  streamAssistantText,
  toGenerateAssistantResponseInput,
  usageFromMetadataEvent,
} from "./kiro-transport.js"
export { KiroRestTransport, toKiroRestPayload } from "./kiro-rest-transport.js"
export type { KiroRestTransportOptions } from "./kiro-rest-transport.js"
export { ModelCache } from "./model-cache.js"
export { discoverModelsFromCommand, parseDiscoveredModels, refreshModelCacheFromCommand } from "./model-discovery.js"
export { ModelResolutionError, ModelResolver, normalizeModelName } from "./model-resolver.js"
export { FALLBACK_MODELS } from "./models.js"
export { toKiroGenerateRequest } from "./request-adapter.js"
export type { KiroGenerateRequest, KiroModelOptions } from "./request-adapter.js"
export { toOpenAIChatResponse, toOpenAIChatStreamResponse } from "./response-adapter.js"
export type { KiroReasoningChunk, KiroStreamEvent, KiroToolCallChunk } from "./response-adapter.js"

export default {
  id: "kiro",
  server: KiroPlugin,
}
