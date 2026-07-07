import { KiroPlugin } from "./plugin.js"

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
export { ModelResolutionError, ModelResolver, normalizeModelName } from "./model-resolver.js"
export { FALLBACK_MODELS } from "./models.js"
export { toKiroGenerateRequest } from "./request-adapter.js"
export { toOpenAIChatResponse, toOpenAIChatStreamResponse } from "./response-adapter.js"

export default {
  id: "kiro",
  server: KiroPlugin,
}
