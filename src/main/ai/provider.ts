import type { ChatMessage, Part, ProviderKind } from '../../shared/types'
import { anthropicProvider } from './providers/anthropic'
import { geminiProvider } from './providers/gemini'
import { openaiProvider } from './providers/openai'

export interface ToolDef {
  name: string
  description: string
  /** JSON schema of the arguments object. */
  parameters: Record<string, unknown>
}

export interface StreamRequest {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  system: string
  messages: ChatMessage[]
  tools: ToolDef[]
  signal?: AbortSignal
}

export interface StreamResult {
  /** Assistant parts: text and tool calls, in order. */
  parts: Part[]
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'other'
}

export interface Provider {
  stream(req: StreamRequest, onText: (delta: string) => void): Promise<StreamResult>
}

export function getProvider(kind: ProviderKind): Provider {
  switch (kind) {
    case 'anthropic':
      return anthropicProvider
    case 'gemini':
      return geminiProvider
    default:
      return openaiProvider
  }
}

/** Parse a fetch Response body as Server-Sent Events, yielding the `data:` payload of each event. */
export async function* sseEvents(res: Response): AsyncGenerator<{ event: string; data: string }> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (data.length) yield { event, data: data.join('\n') }
    }
  }
}

export async function ensureOk(res: Response, label: string): Promise<void> {
  if (res.ok) return
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 600)
  } catch {
    /* ignore */
  }
  throw new Error(`${label} HTTP ${res.status}: ${detail}`)
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

export function safeJson(s: string): Record<string, unknown> {
  if (!s.trim()) return {}
  try {
    const v = JSON.parse(s)
    return typeof v === 'object' && v ? v : {}
  } catch {
    return {}
  }
}
