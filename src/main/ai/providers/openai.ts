import type { ChatMessage, Part } from '../../../shared/types'
import { ensureOk, safeJson, sseEvents, trimSlash, type Provider } from '../provider'

/** OpenAI Chat Completions format – works with OpenAI, OpenRouter, Groq, Ollama, LM Studio, … */
function toOpenAI(system: string, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
      const calls = m.parts.filter((p) => p.type === 'tool_call') as Extract<Part, { type: 'tool_call' }>[]
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) }
              }))
            }
          : {})
      })
      continue
    }
    // user turn: tool results become separate "tool" messages; images from tool results
    // are attached to a following user message because tool messages can't carry images.
    const pending: unknown[] = []
    const userContent: unknown[] = []
    for (const p of m.parts) {
      if (p.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: p.id, content: (p.isError ? 'ERROR: ' : '') + (p.text || '(ok)') })
        if (p.image) pending.push({ type: 'image_url', image_url: { url: `data:${p.image.mime};base64,${p.image.data}` } })
      } else if (p.type === 'text') userContent.push({ type: 'text', text: p.text })
      else if (p.type === 'image') userContent.push({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } })
    }
    const content = [...pending, ...userContent]
    if (content.length) {
      if (pending.length && !userContent.length) content.unshift({ type: 'text', text: '[screenshot z nástroje]' })
      out.push({ role: 'user', content })
    }
  }
  return out
}

export const openaiProvider: Provider = {
  async stream(req, onText) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (req.apiKey) headers.authorization = `Bearer ${req.apiKey}`
    const res = await fetch(`${trimSlash(req.baseUrl)}/chat/completions`, {
      method: 'POST',
      signal: req.signal,
      headers,
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        stream: true,
        messages: toOpenAI(req.system, req.messages),
        ...(req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters }
              }))
            }
          : {})
      })
    })
    await ensureOk(res, 'OpenAI-compatible')

    let text = ''
    let finish: string | undefined
    const calls: { id: string; name: string; args: string }[] = []
    for await (const { data } of sseEvents(res)) {
      if (data === '[DONE]') break
      const ev = safeJson(data) as any
      if (ev.error) throw new Error(`API: ${ev.error.message ?? data}`)
      const choice = ev.choices?.[0]
      if (!choice) continue
      const d = choice.delta ?? {}
      if (typeof d.content === 'string' && d.content) {
        text += d.content
        onText(d.content)
      }
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? 0
        calls[i] ??= { id: '', name: '', args: '' }
        if (tc.id) calls[i].id = tc.id
        if (tc.function?.name) calls[i].name += tc.function.name
        if (tc.function?.arguments) calls[i].args += tc.function.arguments
      }
      if (choice.finish_reason) finish = choice.finish_reason
    }

    const parts: Part[] = []
    if (text) parts.push({ type: 'text', text })
    calls.forEach((c, i) => {
      if (c?.name) parts.push({ type: 'tool_call', id: c.id || `call_${Date.now()}_${i}`, name: c.name, args: safeJson(c.args) })
    })
    const hasCalls = parts.some((p) => p.type === 'tool_call')
    return {
      parts,
      stopReason: hasCalls ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'stop' ? 'end' : 'other'
    }
  }
}
