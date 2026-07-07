import {
  CodeWhispererStreamingClient,
  GenerateAssistantResponseCommand,
  type GenerateAssistantResponseCommandInput,
  type GenerateAssistantResponseCommandOutput,
  type ChatResponseStream,
} from "@aws/codewhisperer-streaming-client"
import type { Command } from "@smithy/smithy-client"
import { KiroPluginError } from "./errors.js"
import type { KiroTransport } from "./fetch-adapter.js"
import type { KiroGenerateRequest } from "./request-adapter.js"
import type { KiroGenerateResponse, KiroStreamChunk, KiroStreamEvent } from "./response-adapter.js"

export interface KiroTransportOptions {
  readonly region: string
  readonly accessToken: string
  readonly endpoint?: string
  readonly profileArn?: string
  readonly userAgent?: string
  readonly agentMode?: string
  readonly maxAttempts?: number
  readonly requestTimeoutMs?: number
}

export interface CodeWhispererClientLike {
  send(command: Command<any, any, any, any, any>): Promise<GenerateAssistantResponseCommandOutput>
  destroy?(): void
}

export type CodeWhispererClientFactory = (options: KiroTransportOptions) => CodeWhispererClientLike

const DEFAULT_USER_AGENT = "KiroIDE"
const DEFAULT_AGENT_MODE = "vibe"

export function additionalModelRequestFields(request: KiroGenerateRequest): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {}
  if (request.modelOptions.temperature !== undefined) fields.temperature = request.modelOptions.temperature
  if (request.modelOptions.maxTokens !== undefined) fields.max_tokens = request.modelOptions.maxTokens
  if (request.modelOptions.reasoningEffort) {
    fields.output_config = {
      effort: request.modelOptions.reasoningEffort,
    }
  }
  return Object.keys(fields).length > 0 ? fields : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function usageFromMetadataEvent(event: ChatResponseStream): KiroGenerateResponse["usage"] | undefined {
  const usage = event.metadataEvent?.tokenUsage
  if (!usage) return undefined
  const uncachedInput = numberValue(usage.uncachedInputTokens) ?? 0
  const cacheRead = numberValue(usage.cacheReadInputTokens) ?? 0
  const cacheWrite = numberValue(usage.cacheWriteInputTokens) ?? 0
  const outputTokens = numberValue(usage.outputTokens)
  return {
    inputTokens: uncachedInput + cacheRead + cacheWrite,
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  }
}

export function createCodeWhispererClient(options: KiroTransportOptions): CodeWhispererClientLike {
  const client = new CodeWhispererStreamingClient({
    region: options.region,
    endpoint: options.endpoint ?? `https://q.${options.region}.amazonaws.com`,
    token: async () => ({ token: options.accessToken }),
    customUserAgent: [[options.userAgent ?? DEFAULT_USER_AGENT]],
    maxAttempts: options.maxAttempts ?? 3,
    retryMode: "standard",
  } as any)

  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers["x-amzn-kiro-agent-mode"] = options.agentMode ?? DEFAULT_AGENT_MODE
      return next(args)
    },
    { step: "build", name: "addKiroAgentMode" },
  )

  return client
}

export function toGenerateAssistantResponseInput(
  request: KiroGenerateRequest,
  options: Pick<KiroTransportOptions, "profileArn" | "agentMode"> = {},
): GenerateAssistantResponseCommandInput {
  const content = request.prompt
  const modelFields = additionalModelRequestFields(request)
  return {
    ...(options.profileArn ? { profileArn: options.profileArn } : {}),
    agentMode: options.agentMode ?? DEFAULT_AGENT_MODE,
    ...(modelFields ? { additionalModelRequestFields: modelFields } : {}),
    conversationState: {
      chatTriggerType: "MANUAL",
      history: [
        ...(request.system
          ? [
              {
                userInputMessage: {
                  content: request.system,
                  origin: "AI_EDITOR",
                },
              },
            ]
          : []),
        ...request.history.map((turn) =>
          turn.role === "assistant"
            ? {
                assistantResponseMessage: {
                  content: turn.content,
                },
              }
            : {
                userInputMessage: {
                  content: turn.content,
                  origin: "AI_EDITOR",
                },
              },
        ),
      ],
      currentMessage: {
        userInputMessage: {
          content,
          modelId: request.modelId,
          origin: "AI_EDITOR",
          ...(request.images.length > 0
            ? {
                images: request.images.map((image) => ({
                  format: image.format,
                  source: { bytes: image.bytes },
                })),
              }
            : {}),
          ...(request.documents.length > 0
            ? {
                documents: request.documents.map((document) => ({
                  name: document.name,
                  format: document.format,
                  source: { bytes: document.bytes },
                })),
              }
            : {}),
          userInputMessageContext:
            request.tools.length > 0 || request.toolResults.length > 0
              ? {
                  ...(request.tools.length > 0
                    ? {
                        tools: request.tools.map((item) => ({
                          toolSpecification: {
                            name: item.name,
                            ...(item.description ? { description: item.description } : {}),
                            inputSchema: { json: item.inputSchema },
                          },
                        })),
                      }
                    : {}),
                  ...(request.toolResults.length > 0
                    ? {
                        toolResults: request.toolResults.map((item) => ({
                          toolUseId: item.toolUseId,
                          content: [{ text: item.content }],
                          status: "SUCCESS",
                          ...(item.toolName ? { toolName: item.toolName } : {}),
                        })),
                      }
                    : {}),
                }
              : undefined,
        },
      },
    },
  } as any
}

export async function collectAssistantText(
  stream: AsyncIterable<ChatResponseStream> | undefined,
): Promise<KiroGenerateResponse> {
  if (!stream) return { text: "" }

  let text = ""
  let reasoning = ""
  let modelId: string | undefined
  let usage: KiroGenerateResponse["usage"] | undefined
  for await (const event of stream) {
    if (event.assistantResponseEvent) {
      text += event.assistantResponseEvent.content ?? ""
      modelId = event.assistantResponseEvent.modelId ?? modelId
    }
    if (event.reasoningContentEvent?.text) {
      reasoning += event.reasoningContentEvent.text
    }
    usage = usageFromMetadataEvent(event) ?? usage
    if (event.error) {
      throw new Error(event.error.message ?? "Kiro stream returned an error event")
    }
  }

  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    ...(modelId ? { modelId } : {}),
    ...(usage ? { usage } : {}),
  }
}

export async function* streamAssistantText(
  stream: AsyncIterable<ChatResponseStream> | undefined,
): AsyncIterable<KiroStreamEvent> {
  if (!stream) return

  const toolInputs = new Map<string, { name: string; input: string }>()
  for await (const event of stream) {
    if (event.assistantResponseEvent?.content) {
      yield {
        type: "text",
        text: event.assistantResponseEvent.content,
        ...(event.assistantResponseEvent.modelId ? { modelId: event.assistantResponseEvent.modelId } : {}),
      }
    }
    if (event.reasoningContentEvent?.text) {
      yield {
        type: "reasoning",
        text: event.reasoningContentEvent.text,
      }
    }
    if (event.toolUseEvent?.toolUseId && event.toolUseEvent.name) {
      const id = event.toolUseEvent.toolUseId
      const current = toolInputs.get(id) ?? { name: event.toolUseEvent.name, input: "" }
      current.input += event.toolUseEvent.input ?? ""
      current.name = event.toolUseEvent.name
      toolInputs.set(id, current)
      if (event.toolUseEvent.stop) {
        yield {
          type: "tool_call",
          id,
          name: current.name,
          arguments: current.input,
        }
        toolInputs.delete(id)
      }
    }
    const usage = usageFromMetadataEvent(event)
    if (usage) {
      yield {
        type: "text",
        text: "",
        usage,
      }
    }
    if (event.error) {
      throw new Error(event.error.message ?? "Kiro stream returned an error event")
    }
  }
}

async function collectChunks(chunks: AsyncIterable<KiroStreamEvent>, fallbackModelId: string): Promise<KiroGenerateResponse> {
  let text = ""
  let reasoning = ""
  let modelId: string | undefined
  let usage: KiroGenerateResponse["usage"] | undefined
  const toolCalls = []
  for await (const chunk of chunks) {
    if (chunk.type === "tool_call") {
      toolCalls.push(chunk)
      modelId = chunk.modelId ?? modelId
      continue
    }
    if (chunk.type === "reasoning") {
      reasoning += chunk.text
      modelId = chunk.modelId ?? modelId
      continue
    }
    text += chunk.text
    modelId = chunk.modelId ?? modelId
    if (chunk.usage) usage = chunk.usage
  }
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    modelId: modelId ?? fallbackModelId,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, message: string): Promise<T> {
  if (!timeoutMs) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new KiroPluginError(message, "KIRO_TIMEOUT", 504)), timeoutMs)
  })
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export class CodeWhispererKiroTransport implements KiroTransport {
  readonly #options: KiroTransportOptions
  readonly #client: CodeWhispererClientLike

  constructor(options: KiroTransportOptions, factory: CodeWhispererClientFactory = createCodeWhispererClient) {
    this.#options = options
    this.#client = factory(options)
  }

  async generate(request: KiroGenerateRequest): Promise<KiroGenerateResponse> {
    return collectChunks(this.stream(request), request.modelId)
  }

  async *stream(request: KiroGenerateRequest): AsyncIterable<KiroStreamEvent> {
    const input = toGenerateAssistantResponseInput(request, this.#options)
    const output = await withTimeout(
      this.#client.send(new GenerateAssistantResponseCommand(input)),
      this.#options.requestTimeoutMs,
      "Timed out waiting for Kiro response.",
    )
    yield* streamAssistantText(output.generateAssistantResponseResponse)
  }

  dispose(): void {
    this.#client.destroy?.()
  }
}
