import type { ChatMessage, Part } from '../../../shared/types'
import { ensureOk, safeJson, sseEvents, trimSlash, type Provider } from '../provider'

function toGemini(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    const parts: unknown[] = []
    for (const p of m.parts) {
      switch (p.type) {
        case 'text':
          parts.push({ text: p.text })
          break
        case 'image':
          parts.push({ inlineData: { mimeType: p.mime, data: p.data } })
          break
        case 'tool_call':
          parts.push({ functionCall: { name: p.name, args: p.args }, ...(p.signature ? { thoughtSignature: p.signature } : {}) })
          break
        case 'tool_result':
          parts.push({
            functionResponse: { name: p.name, response: p.isError ? { error: p.text } : { result: p.text || 'ok' } }
          })
          if (p.image) parts.push({ inlineData: { mimeType: p.image.mime, data: p.image.data } })
          break
      }
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts }
  })
}

/** Gemini rejects a few JSON-schema keywords; strip them recursively. */
function cleanSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(cleanSchema)
  if (typeof s !== 'object' || s === null) return s
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties' || k === '$schema') continue
    out[k] = cleanSchema(v)
  }
  return out
}

export const geminiProvider: Provider = {
  async stream(req, onText) {
    const url = `${trimSlash(req.baseUrl)}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`
    const res = await fetch(url, {
      method: 'POST',
      signal: req.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': req.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: toGemini(req.messages),
        generationConfig: { maxOutputTokens: req.maxTokens },
        ...(req.tools.length
          ? {
              tools: [
                {
                  functionDeclarations: req.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: cleanSchema(t.parameters)
                  }))
                }
              ]
            }
          : {})
      })
    })
    await ensureOk(res, 'Gemini')

    let text = ''
    let finish: string | undefined
    const parts: Part[] = []
    let n = 0
    for await (const { data } of sseEvents(res)) {
      const ev = safeJson(data) as any
      if (ev.error) throw new Error(`Gemini: ${ev.error.message ?? data}`)
      const cand = ev.candidates?.[0]
      if (!cand) continue
      for (const p of cand.content?.parts ?? []) {
        if (typeof p.text === 'string' && !p.thought) {
          text += p.text
          onText(p.text)
        }
        if (p.functionCall) {
          parts.push({
            type: 'tool_call',
            id: `g_${Date.now()}_${n++}`,
            name: p.functionCall.name,
            args: p.functionCall.args ?? {},
            signature: p.thoughtSignature
          })
        }
      }
      if (cand.finishReason) finish = cand.finishReason
    }
    if (text) parts.unshift({ type: 'text', text })
    const hasCalls = parts.some((p) => p.type === 'tool_call')
    return {
      parts,
      stopReason: hasCalls ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : finish === 'STOP' ? 'end' : 'other'
    }
  }
}
