import type { ModelResolver } from "./model-resolver.js"

export interface OpenAIChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content?: string | ReadonlyArray<{ type: string; text?: string; [key: string]: unknown }>
  readonly tool_call_id?: string
}

export interface OpenAIChatRequest {
  readonly model: string
  readonly messages: ReadonlyArray<OpenAIChatMessage>
  readonly stream?: boolean
  readonly tools?: ReadonlyArray<unknown>
  readonly temperature?: number
  readonly max_tokens?: number
}

export interface KiroGenerateRequest {
  readonly modelId: string
  readonly prompt: string
  readonly system?: string
  readonly history: ReadonlyArray<KiroConversationTurn>
  readonly stream: boolean
  readonly metadata: {
    readonly originalModel: string
    readonly normalizedModel: string
    readonly modelSource: string
    readonly hasTools: boolean
  }
}

export interface KiroConversationTurn {
  readonly role: "user" | "assistant" | "tool"
  readonly content: string
}

function textFromContent(content: OpenAIChatMessage["content"]): string {
  if (content === undefined) return ""
  if (typeof content === "string") return content
  return content
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") return part.text
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

export async function readOpenAIRequest(input: RequestInfo | URL, init?: RequestInit): Promise<OpenAIChatRequest> {
  if (init?.body) {
    const raw = typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as BufferSource)
    return JSON.parse(raw) as OpenAIChatRequest
  }

  if (input instanceof Request) {
    return (await input.clone().json()) as OpenAIChatRequest
  }

  throw new Error("Missing OpenAI-compatible request body")
}

export function toKiroGenerateRequest(request: OpenAIChatRequest, resolver: ModelResolver): KiroGenerateRequest {
  const resolved = resolver.resolve(request.model)
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => textFromContent(message.content))
    .filter(Boolean)
    .join("\n\n")
  const turns = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const content = textFromContent(message.content)
      return content ? { role: message.role, content } : undefined
    })
    .filter((item): item is KiroConversationTurn => item !== undefined)
  const current = turns.at(-1)
  const history = turns.slice(0, -1)

  return {
    modelId: resolved.internalID,
    prompt: current?.content ?? "",
    history,
    ...(system ? { system } : {}),
    stream: request.stream === true,
    metadata: {
      originalModel: request.model,
      normalizedModel: resolved.normalized,
      modelSource: resolved.source,
      hasTools: Boolean(request.tools?.length),
    },
  }
}
