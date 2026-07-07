import { KiroPlugin } from "./plugin.js"

export { createKiroPlugin, KiroPlugin } from "./plugin.js"
export { detectAuth, redacted, resolveApiKey } from "./auth.js"
export { loadOptions } from "./config.js"
export { getKiroCliStatus, getKiroCliVersion } from "./kiro-cli.js"
export { ModelCache } from "./model-cache.js"
export { ModelResolutionError, ModelResolver, normalizeModelName } from "./model-resolver.js"
export { FALLBACK_MODELS } from "./models.js"

export default {
  id: "kiro",
  server: KiroPlugin,
}
