import { KiroPlugin } from "./plugin.js"

export { createKiroPlugin, KiroPlugin } from "./plugin.js"
export { loadOptions } from "./config.js"
export { ModelCache } from "./model-cache.js"
export { ModelResolutionError, ModelResolver, normalizeModelName } from "./model-resolver.js"
export { FALLBACK_MODELS } from "./models.js"

export default {
  id: "kiro",
  server: KiroPlugin,
}

