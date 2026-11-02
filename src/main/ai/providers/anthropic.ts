import type { ChatMessage, Part } from '../../../shared/types'
import { ensureOk, safeJson, sseEvents, trimSlash, type Provider } from '../provider'

function toAnthropic(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.parts.map((p) => {
      switch (p.type) {
        case 'text':
          return { type: 'text', text: p.text }
        case 'image':
          return { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }
        case 'tool_call':
          return { type: 'tool_use', id: p.id, name: p.name, input: p.args }
        case 'tool_result': {
          const content: unknown[] = [{ type: 'text', text: p.text || '(ok)' }]
          if (p.image) content.push({ type: 'image', source: { type: 'base64', media_type: p.image.mime, data: p.image.data } })
          return { type: 'tool_result', tool_use_id: p.id, content, is_error: Boolean(p.isError) }
        }
      }
    })
  }))
}

export const anthropicProvider: Provider = {
  async stream(req, onText) {
    const res = await fetch(`${trimSlash(req.baseUrl)}/v1/messages`, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': req.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        stream: true,
        messages: toAnthropic(req.messages),
        ...(req.tools.length
          ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
          : {})
      })
    })
    await ensureOk(res, 'Anthropic')

    const blocks: { kind: 'text' | 'tool'; text: string; id?: string; name?: string; json: string }[] = []
    let stop: string | undefined
    for await (const { data } of sseEvents(res)) {
      const ev = safeJson(data) as any
      switch (ev.type) {
        case 'content_block_start': {
          const cb = ev.content_block
          blocks[ev.index] =
            cb.type === 'tool_use'
              ? { kind: 'tool', text: '', id: cb.id, name: cb.name, json: '' }
              : { kind: 'text', text: cb.text ?? '', json: '' }
          break
        }
        case 'content_block_delta': {
          const b = blocks[ev.index]
          if (!b) break
          if (ev.delta.type === 'text_delta') {
            b.text += ev.delta.text
            onText(ev.delta.text)
          } else if (ev.delta.type === 'input_json_delta') {
            b.json += ev.delta.partial_json
          }
          break
        }
        case 'message_delta':
          stop = ev.delta?.stop_reason ?? stop
          break
        case 'error':
          throw new Error(`Anthropic: ${ev.error?.message ?? data}`)
      }
    }

    const parts: Part[] = []
    for (const b of blocks) {
      if (!b) continue
      if (b.kind === 'text' && b.text) parts.push({ type: 'text', text: b.text })
      if (b.kind === 'tool') parts.push({ type: 'tool_call', id: b.id!, name: b.name!, args: safeJson(b.json) })
    }
    return {
      parts,
      stopReason: stop === 'tool_use' ? 'tool_use' : stop === 'max_tokens' ? 'max_tokens' : stop === 'end_turn' ? 'end' : 'other'
    }
  }
}
