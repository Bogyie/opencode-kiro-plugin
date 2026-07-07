import {
  CodeWhispererStreamingClient,
  GenerateAssistantResponseCommand,
  type GenerateAssistantResponseCommandInput,
  type GenerateAssistantResponseCommandOutput,
  type ChatResponseStream,
} from "@aws/codewhisperer-streaming-client"
import type { Command } from "@smithy/smithy-client"
import type { KiroTransport } from "./fetch-adapter.js"
import type { KiroGenerateRequest } from "./request-adapter.js"
import type { KiroGenerateResponse, KiroStreamChunk } from "./response-adapter.js"

export interface KiroTransportOptions {
  readonly region: string
  readonly accessToken: string
  readonly endpoint?: string
  readonly profileArn?: string
  readonly userAgent?: string
  readonly agentMode?: string
}

export interface CodeWhispererClientLike {
  send(command: Command<any, any, any, any, any>): Promise<GenerateAssistantResponseCommandOutput>
  destroy?(): void
}

export type CodeWhispererClientFactory = (options: KiroTransportOptions) => CodeWhispererClientLike

const DEFAULT_USER_AGENT = "KiroIDE"
const DEFAULT_AGENT_MODE = "vibe"

export function createCodeWhispererClient(options: KiroTransportOptions): CodeWhispererClientLike {
  const client = new CodeWhispererStreamingClient({
    region: options.region,
    endpoint: options.endpoint ?? `https://q.${options.region}.amazonaws.com`,
    token: async () => ({ token: options.accessToken }),
    customUserAgent: [[options.userAgent ?? DEFAULT_USER_AGENT]],
    maxAttempts: 3,
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
  return {
    ...(options.profileArn ? { profileArn: options.profileArn } : {}),
    agentMode: options.agentMode ?? DEFAULT_AGENT_MODE,
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
  let modelId: string | undefined
  for await (const event of stream) {
    if (event.assistantResponseEvent) {
      text += event.assistantResponseEvent.content ?? ""
      modelId = event.assistantResponseEvent.modelId ?? modelId
    }
    if (event.error) {
      throw new Error(event.error.message ?? "Kiro stream returned an error event")
    }
  }

  return {
    text,
    ...(modelId ? { modelId } : {}),
  }
}

export async function* streamAssistantText(
  stream: AsyncIterable<ChatResponseStream> | undefined,
): AsyncIterable<KiroStreamChunk> {
  if (!stream) return

  for await (const event of stream) {
    if (event.assistantResponseEvent?.content) {
      yield {
        text: event.assistantResponseEvent.content,
        ...(event.assistantResponseEvent.modelId ? { modelId: event.assistantResponseEvent.modelId } : {}),
      }
    }
    if (event.error) {
      throw new Error(event.error.message ?? "Kiro stream returned an error event")
    }
  }
}

async function collectChunks(chunks: AsyncIterable<KiroStreamChunk>, fallbackModelId: string): Promise<KiroGenerateResponse> {
  let text = ""
  let modelId: string | undefined
  for await (const chunk of chunks) {
    text += chunk.text
    modelId = chunk.modelId ?? modelId
  }
  return {
    text,
    modelId: modelId ?? fallbackModelId,
  }
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

  async *stream(request: KiroGenerateRequest): AsyncIterable<KiroStreamChunk> {
    const input = toGenerateAssistantResponseInput(request, this.#options)
    const output = await this.#client.send(new GenerateAssistantResponseCommand(input))
    yield* streamAssistantText(output.generateAssistantResponseResponse)
  }

  dispose(): void {
    this.#client.destroy?.()
  }
}
