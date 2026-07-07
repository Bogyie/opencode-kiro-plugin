import type { ModelResolver } from "./model-resolver.js"

export interface OpenAIChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content?: string | ReadonlyArray<OpenAIContentPart>
  readonly tool_call_id?: string
  readonly tool_calls?: ReadonlyArray<OpenAIMessageToolCall>
  readonly name?: string
}

export type OpenAIContentPart = { type: string; text?: string; [key: string]: unknown }

export interface OpenAIMessageToolCall {
  readonly id?: string
  readonly type?: "function"
  readonly function?: {
    readonly name?: string
    readonly arguments?: string
  }
}

export interface OpenAIChatRequest {
  readonly model: string
  readonly messages: ReadonlyArray<OpenAIChatMessage>
  readonly stream?: boolean
  readonly tools?: ReadonlyArray<OpenAITool>
  readonly temperature?: number
  readonly max_tokens?: number
}

export interface OpenAITool {
  readonly type: "function"
  readonly function: {
    readonly name: string
    readonly description?: string
    readonly parameters?: unknown
  }
}

export interface KiroGenerateRequest {
  readonly modelId: string
  readonly prompt: string
  readonly system?: string
  readonly history: ReadonlyArray<KiroConversationTurn>
  readonly tools: ReadonlyArray<KiroToolSpec>
  readonly toolResults: ReadonlyArray<KiroToolResult>
  readonly images: ReadonlyArray<KiroImageBlock>
  readonly documents: ReadonlyArray<KiroDocumentBlock>
  readonly stream: boolean
  readonly metadata: {
    readonly originalModel: string
    readonly normalizedModel: string
    readonly modelSource: string
    readonly hasTools: boolean
  }
}

export interface KiroImageBlock {
  readonly format: "png" | "jpeg" | "gif" | "webp"
  readonly bytes: Uint8Array
}

export interface KiroDocumentBlock {
  readonly name: string
  readonly format: "pdf" | "txt" | "md" | "csv" | "html" | "doc" | "docx" | "xls" | "xlsx"
  readonly bytes: Uint8Array
}

export interface KiroConversationTurn {
  readonly role: "user" | "assistant" | "tool"
  readonly content: string
}

export interface KiroToolSpec {
  readonly name: string
  readonly description?: string
  readonly inputSchema: unknown
}

export interface KiroToolResult {
  readonly toolUseId: string
  readonly content: string
  readonly toolName?: string
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

function dataUrlBytes(dataUrl: string): { mime: string; bytes: Uint8Array } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(dataUrl)
  if (!match?.[1] || !match[2]) return undefined
  return {
    mime: match[1].toLowerCase(),
    bytes: Uint8Array.from(Buffer.from(match[2], "base64")),
  }
}

function imageFormat(mime: string): KiroImageBlock["format"] | undefined {
  if (mime === "image/png") return "png"
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpeg"
  if (mime === "image/gif") return "gif"
  if (mime === "image/webp") return "webp"
  return undefined
}

function documentFormat(mime: string): KiroDocumentBlock["format"] | undefined {
  if (mime === "application/pdf") return "pdf"
  if (mime === "text/plain") return "txt"
  if (mime === "text/markdown") return "md"
  if (mime === "text/csv") return "csv"
  if (mime === "text/html") return "html"
  return undefined
}

function partUrl(part: OpenAIContentPart): string | undefined {
  if (part.type === "image_url") {
    const image = part.image_url as { url?: unknown } | undefined
    return typeof image?.url === "string" ? image.url : undefined
  }
  if (part.type === "input_image") {
    if (typeof part.image_url === "string") return part.image_url
    const image = part.image_url as { url?: unknown } | undefined
    return typeof image?.url === "string" ? image.url : undefined
  }
  if (part.type === "file" || part.type === "input_file") {
    const file = part.file as { file_data?: unknown; filename?: unknown } | undefined
    if (typeof file?.file_data === "string") return file.file_data
    if (typeof part.file_data === "string") return part.file_data
  }
  return undefined
}

function partFilename(part: OpenAIContentPart, fallback: string): string {
  const file = part.file as { filename?: unknown } | undefined
  if (typeof file?.filename === "string" && file.filename) return file.filename
  if (typeof part.filename === "string" && part.filename) return part.filename
  return fallback
}

function mediaFromContent(content: OpenAIChatMessage["content"]): {
  images: KiroImageBlock[]
  documents: KiroDocumentBlock[]
} {
  if (!Array.isArray(content)) return { images: [], documents: [] }
  const images: KiroImageBlock[] = []
  const documents: KiroDocumentBlock[] = []

  for (const [index, part] of content.entries()) {
    const url = partUrl(part)
    if (!url) continue
    const decoded = dataUrlBytes(url)
    if (!decoded) continue

    const imgFormat = imageFormat(decoded.mime)
    if (imgFormat) {
      images.push({ format: imgFormat, bytes: decoded.bytes })
      continue
    }

    const docFormat = documentFormat(decoded.mime)
    if (docFormat) {
      documents.push({
        name: partFilename(part, `attachment-${index + 1}.${docFormat}`),
        format: docFormat,
        bytes: decoded.bytes,
      })
    }
  }

  return { images, documents }
}

function toolSpecs(tools: ReadonlyArray<OpenAITool> | undefined): KiroToolSpec[] {
  return (tools ?? []).map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    inputSchema: tool.function.parameters ?? { type: "object", properties: {} },
  }))
}

function requestedToolCallIds(messages: ReadonlyArray<OpenAIChatMessage>): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.id) ids.add(toolCall.id)
    }
  }
  return ids
}

function toolNameById(messages: ReadonlyArray<OpenAIChatMessage>): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.id && toolCall.function?.name) names.set(toolCall.id, toolCall.function.name)
    }
  }
  return names
}

function toolResults(messages: ReadonlyArray<OpenAIChatMessage>): KiroToolResult[] {
  const requested = requestedToolCallIds(messages)
  const names = toolNameById(messages)
  const results = new Map<string, KiroToolResult>()

  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id) continue
    if (requested.size > 0 && !requested.has(message.tool_call_id)) continue
    const toolName = message.name ?? names.get(message.tool_call_id)
    results.set(message.tool_call_id, {
      toolUseId: message.tool_call_id,
      content: textFromContent(message.content),
      ...(toolName ? { toolName } : {}),
    })
  }

  return [...results.values()]
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
  const currentMessage = request.messages.filter((message) => message.role !== "system").at(-1)
  const media = mediaFromContent(currentMessage?.content)

  return {
    modelId: resolved.internalID,
    prompt: current?.content ?? "",
    history,
    tools: toolSpecs(request.tools),
    toolResults: toolResults(request.messages),
    images: media.images,
    documents: media.documents,
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
