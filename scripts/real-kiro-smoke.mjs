import { createKiroFetch, createKiroPlugin, KiroCliChatTransport, ModelCache, ModelResolver, parseDiscoveredModels } from "../dist/index.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

async function run(command, args) {
  try {
    const result = await execFileAsync(command, args, { timeout: 120_000 })
    return { ok: true, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      error,
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assistantTextFromSse(body) {
  return body
    .split(/\n\n/)
    .map((event) => event.trim())
    .filter((event) => event.startsWith("data: "))
    .map((event) => event.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data))
    .map((item) => item.choices?.[0]?.delta?.content ?? "")
    .join("")
}

async function main() {
  const version = await run("kiro-cli", ["--version"])
  assert(version.ok, `kiro-cli --version failed: ${version.stderr || version.error}`)
  console.log(`kiro-cli: ${version.stdout.trim()}`)

  const listed = await run("kiro-cli", ["chat", "--list-models", "--format", "json"])
  assert(listed.ok, `kiro-cli model discovery failed: ${listed.stderr || listed.error}`)
  const models = parseDiscoveredModels(listed.stdout)
  const modelIds = models.map((model) => model.id)
  assert(modelIds.length > 0, "kiro-cli returned no models")
  console.log(`discovered models (${modelIds.length}): ${modelIds.join(", ")}`)

  const plugin = await createKiroPlugin()(
    {
      client: {},
      project: {},
      directory: process.cwd(),
      worktree: process.cwd(),
      experimental_workspace: { register: () => undefined },
      serverUrl: new URL("http://localhost"),
      $: {},
    },
    {
      backend: "cli-chat",
      modelDiscoveryCommand: ["kiro-cli", "chat", "--list-models", "--format", "json"],
      requestTimeoutMs: 120_000,
    },
  )
  const providerModels = await plugin.provider?.models?.({ id: "kiro", name: "Kiro", models: {} }, {})
  assert(providerModels, "plugin provider hook did not return models")
  if (!modelIds.includes("claude-fable-5")) {
    assert(!providerModels["claude-fable-5"], "plugin advertised claude-fable-5 even though real kiro-cli did not list it")
  }
  console.log(`plugin models (${Object.keys(providerModels).length}): ${Object.keys(providerModels).join(", ")}`)

  const selectedModel = modelIds.includes("claude-sonnet-4.5") ? "claude-sonnet-4.5" : modelIds.includes("auto") ? "auto" : modelIds[0]
  assert(selectedModel, "no model selected for real smoke")

  const config = {}
  await plugin.config?.(config)
  const localApi = config.provider?.kiro?.api
  assert(typeof localApi === "string" && localApi.startsWith("http://127.0.0.1:"), `plugin did not expose a local API URL: ${localApi}`)
  const localHttpResponse = await globalThis.fetch(`${localApi}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer kiro-plugin-local-transport",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: selectedModel,
      messages: [{ role: "user", content: "Answer in one short Korean sentence: what is 2+2?" }],
    }),
  })
  const localHttpJson = await localHttpResponse.json()
  assert(localHttpResponse.status === 200, `local HTTP response failed: ${JSON.stringify(localHttpJson)}`)
  const localHttpText = localHttpJson.choices?.[0]?.message?.content ?? ""
  assert(localHttpText.trim(), "local HTTP response did not contain assistant content")
  assert(localHttpText.includes("4"), `local HTTP response did not answer the arithmetic prompt: ${localHttpText}`)
  console.log(`local HTTP assistant response: ${localHttpText}`)

  const cache = new ModelCache(60)
  cache.update(models)
  const adapterFetch = createKiroFetch({
    resolver: new ModelResolver({ cache }),
    transport: new KiroCliChatTransport({ requestTimeoutMs: 120_000 }),
  })

  const nonStreaming = await adapterFetch("https://q.us-east-1.amazonaws.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: selectedModel,
      messages: [{ role: "user", content: "Answer in one short Korean sentence: what is 2+2?" }],
    }),
  })
  const nonStreamingJson = await nonStreaming.json()
  assert(nonStreaming.status === 200, `non-stream response failed: ${JSON.stringify(nonStreamingJson)}`)
  const nonStreamingText = nonStreamingJson.choices?.[0]?.message?.content ?? ""
  assert(nonStreamingText.trim(), "non-stream response did not contain assistant content")
  assert(nonStreamingText.includes("4"), `non-stream response did not answer the arithmetic prompt: ${nonStreamingText}`)
  console.log(`non-stream assistant response: ${nonStreamingText}`)

  const streaming = await adapterFetch("https://q.us-east-1.amazonaws.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: selectedModel,
      stream: true,
      messages: [{ role: "user", content: "Answer in one short sentence containing the number 4: what is 2+2?" }],
    }),
  })
  const streamingBody = await streaming.text()
  assert(streaming.status === 200, `stream response failed: ${streamingBody}`)
  const streamingText = assistantTextFromSse(streamingBody)
  assert(streamingText.trim(), "stream response did not reconstruct assistant content")
  assert(streamingText.includes("4"), `stream response did not answer the arithmetic prompt: ${streamingText}`)
  console.log(`stream assistant response: ${streamingText}`)
  await plugin.dispose?.()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
