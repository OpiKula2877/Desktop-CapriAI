import { randomUUID } from 'node:crypto'
import type { Attachment, ChatMessage, ConfirmRequest, Part, ToolName, UiMessage } from '../shared/types'
import { MoodTagFilter, stripMoodTags } from './ai/moodTag'
import { buildSystemPrompt } from './ai/persona'
import { getProvider } from './ai/provider'
import { listMemories } from './memory'
import { applyMood, getMood } from './mood'
import { currentNowPlaying } from './media'
import { getApiKey, getSettings } from './settings'
import { JsonStore } from './store'
import { checkAllowed, enabledTools, runTool, toolDefs, toolSummary, type ToolContext } from './tools'
import { captureScreen, flyCursor, send, showOverlay } from './windows'
import type { AvatarState } from '../shared/types'

const MAX_TOOL_ROUNDS = 8
const MAX_HISTORY = 40
const MAX_UI = 120

interface Persisted {
  history: ChatMessage[]
  ui: UiMessage[]
}

let store: JsonStore<Persisted>
let history: ChatMessage[] = []
let ui: UiMessage[] = []
let busy = false
let abort: AbortController | null = null
const confirms = new Map<string, (allow: boolean) => void>()

export function initChat(): void {
  store = new JsonStore<Persisted>('history', { history: [], ui: [] })
  history = store.get().history
  ui = store.get().ui
}

function persist(): void {
  // Images are not persisted – they are big and only matter for the current session.
  const strip = (p: Part): Part =>
    p.type === 'image'
      ? { type: 'text', text: '[obrázek]' }
      : p.type === 'tool_result' && p.image
        ? { ...p, image: undefined }
        : p
  store.set({
    history: history.slice(-MAX_HISTORY).map((m) => ({ ...m, parts: m.parts.map(strip) })),
    ui: ui.slice(-MAX_UI).map((m) => ({ ...m, images: undefined, pending: false }))
  })
}

export function getUiMessages(): UiMessage[] {
  return ui
}

export function isBusy(): boolean {
  return busy
}

function emitAll(): void {
  send('overlay', 'chat:messages', ui)
}

function patch(id: string, text: string): void {
  const m = ui.find((x) => x.id === id)
  if (m) m.text = text
  send('overlay', 'chat:patch', { id, text })
}

function pushUi(m: Omit<UiMessage, 'id'>): UiMessage {
  const msg = { id: randomUUID(), ...m }
  ui.push(msg)
  if (ui.length > MAX_UI * 1.5) ui = ui.slice(-MAX_UI)
  emitAll()
  return msg
}

function setAvatar(state: AvatarState): void {
  send('avatar', 'avatar:state', state)
}

function restingAvatarState(): AvatarState {
  return getMood().anger >= 65 ? 'angry' : 'idle'
}

export function clearChat(): void {
  if (busy) abort?.abort()
  history = []
  ui = []
  persist()
  emitAll()
}

export function stopChat(): void {
  abort?.abort()
}

export function respondConfirm(id: string, allow: boolean): void {
  confirms.get(id)?.(allow)
  confirms.delete(id)
}

function askConfirm(tool: ToolName, summary: string): Promise<boolean> {
  const req: ConfirmRequest = { id: randomUUID(), tool, summary }
  showOverlay()
  send('overlay', 'confirm:request', req)
  return new Promise((resolve) => {
    confirms.set(req.id, resolve)
    abort?.signal.addEventListener('abort', () => {
      confirms.delete(req.id)
      resolve(false)
    })
  })
}

/** Model-facing history: limited length, starts on a plain user turn, old images dropped. */
function modelHistory(): ChatMessage[] {
  let h = history.slice(-MAX_HISTORY)
  const start = h.findIndex((m) => m.role === 'user' && !m.parts.some((p) => p.type === 'tool_result'))
  h = start >= 0 ? h.slice(start) : []
  // Keep images only in the last 3 messages that have them.
  let keep = 3
  const out: ChatMessage[] = []
  for (let i = h.length - 1; i >= 0; i--) {
    const m = h[i]
    const hasImg = m.parts.some((p) => p.type === 'image' || (p.type === 'tool_result' && p.image))
    if (hasImg && keep > 0) {
      keep--
      out.unshift(m)
    } else if (hasImg) {
      out.unshift({
        ...m,
        parts: m.parts.map((p) =>
          p.type === 'image' ? { type: 'text', text: '[starší obrázek]' } : p.type === 'tool_result' ? { ...p, image: undefined } : p
        )
      })
    } else out.unshift(m)
  }
  // Providers expect alternating roles: merge consecutive messages of the same role.
  const merged: ChatMessage[] = []
  for (const m of out) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === m.role) prev.parts = [...prev.parts, ...m.parts]
    else merged.push({ role: m.role, parts: [...m.parts] })
  }
  return merged
}

function toolContext(): ToolContext {
  return {
    settings: getSettings(),
    moveCursor: (p, label, click) => flyCursor(p, label, click),
    captureScreen: () => captureScreen(),
    nowPlaying: async () => currentNowPlaying()
  }
}

export async function sendChat(text: string, attachments: Attachment[]): Promise<void> {
  if (busy) return
  const s = getSettings()
  const apiKey = getApiKey(s.provider.kind)
  if (!apiKey && s.provider.kind !== 'openai') {
    pushUi({ role: 'system', text: 'Chybí API klíč. Otevři Nastavení → AI a vlož ho, jinak jsem jen hezká mrtvola na ploše.' })
    return
  }

  const userParts: Part[] = []
  for (const a of attachments) userParts.push({ type: 'image', mime: a.mime, data: a.data })
  if (text.trim()) userParts.push({ type: 'text', text: text.trim() })
  if (!userParts.length) return

  // After a blackout she only listens to apologies.
  if (getMood().grudge) {
    busy = true
    send('overlay', 'chat:busy', true)
    pushUi({ role: 'user', text: text.trim() })
    try {
      const { judgeApology } = await import('./meltdown')
      const v = await judgeApology(text)
      pushUi({ role: 'assistant', text: v.reply || (v.accepted ? 'Fajn. Odpuštěno. Zatím.' : 'To není omluva.') })
      send('avatar', 'avatar:say', v.reply)
    } finally {
      busy = false
      send('overlay', 'chat:busy', false)
    }
    return
  }

  busy = true
  abort = new AbortController()
  send('overlay', 'chat:busy', true)
  history.push({ role: 'user', parts: userParts })
  pushUi({ role: 'user', text: text.trim(), images: attachments.map((a) => `data:${a.mime};base64,${a.data}`) })

  const provider = getProvider(s.provider.kind)
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const settings = getSettings()
      const system = buildSystemPrompt({
        settings,
        anger: getMood().anger,
        memories: settings.memory.enabled ? listMemories() : [],
        nowPlaying: currentNowPlaying(),
        enabledTools: enabledTools(settings)
      })
      const filter = new MoodTagFilter()
      const msg = pushUi({ role: 'assistant', text: '', pending: true })
      let shown = ''
      let lastEmit = 0
      setAvatar('talking')

      const result = await provider.stream(
        {
          baseUrl: settings.provider.baseUrl,
          apiKey,
          model: settings.provider.model,
          maxTokens: settings.provider.maxTokens,
          system,
          messages: modelHistory(),
          tools: toolDefs(settings),
          signal: abort.signal
        },
        (delta) => {
          shown += filter.push(delta)
          const now = Date.now()
          if (now - lastEmit > 40) {
            lastEmit = now
            patch(msg.id, shown)
          }
        }
      )
      shown += filter.finish()
      msg.pending = false
      const parts = result.parts.map((p) => (p.type === 'text' ? { ...p, text: stripMoodTags(p.text).text } : p))
      const calls = parts.filter((p) => p.type === 'tool_call') as Extract<Part, { type: 'tool_call' }>[]
      if (!shown.trim()) {
        ui = ui.filter((m) => m.id !== msg.id)
        emitAll()
      } else {
        patch(msg.id, shown.trim())
        emitAll()
      }
      history.push({ role: 'assistant', parts: parts.length ? parts : [{ type: 'text', text: '…' }] })
      applyMood(filter.total)

      if (!calls.length) break

      const results: Part[] = []
      for (const call of calls) {
        const summary = toolSummary(call.name as ToolName, call.args)
        const line = pushUi({ role: 'tool', text: `▸ ${summary}`, pending: true })
        const denied = checkAllowed(call.name, call.args, getSettings())
        let resultPart: Part
        if (denied) {
          resultPart = { type: 'tool_result', id: call.id, name: call.name, text: denied, isError: true }
        } else {
          const mode = getSettings().permissions[call.name as ToolName]
          const allowed = mode === 'auto' || (await askConfirm(call.name as ToolName, summary))
          if (!allowed) {
            resultPart = { type: 'tool_result', id: call.id, name: call.name, text: 'Hostitel tuhle akci ZAMÍTL.', isError: true }
          } else {
            try {
              const out = await runTool(call.name as ToolName, call.args, toolContext())
              resultPart = { type: 'tool_result', id: call.id, name: call.name, text: out.text, image: out.image }
              if (out.image) line.images = [`data:${out.image.mime};base64,${out.image.data}`]
            } catch (e) {
              resultPart = { type: 'tool_result', id: call.id, name: call.name, text: (e as Error).message, isError: true }
            }
          }
        }
        line.pending = false
        if (resultPart.type === 'tool_result' && resultPart.isError) line.text += `  ✕ ${resultPart.text}`
        emitAll()
        results.push(resultPart)
        if (abort.signal.aborted) break
      }
      history.push({ role: 'user', parts: results })
      if (abort.signal.aborted) break
    }
  } catch (e) {
    const err = e as Error
    if (err.name !== 'AbortError') {
      pushUi({ role: 'system', text: `NET ERROR // ${err.message}` })
    }
    // Drop a dangling assistant tool call so the next request stays valid.
    const last = history[history.length - 1]
    if (last?.role === 'assistant' && last.parts.some((p) => p.type === 'tool_call')) history.pop()
  } finally {
    for (const m of ui) m.pending = false
    busy = false
    abort = null
    persist()
    emitAll()
    send('overlay', 'chat:busy', false)
    setAvatar(getMood().meltdown ? 'meltdown' : restingAvatarState())
  }
}

/** One-shot text completion without tools (quips, apology judge, music comments). */
export async function complete(system: string, userText: string, maxTokens = 300): Promise<string> {
  const s = getSettings()
  const apiKey = getApiKey(s.provider.kind)
  if (!apiKey && s.provider.kind !== 'openai') throw new Error('no api key')
  const res = await getProvider(s.provider.kind).stream(
    {
      baseUrl: s.provider.baseUrl,
      apiKey,
      model: s.provider.fastModel || s.provider.model,
      maxTokens,
      system,
      messages: [{ role: 'user', parts: [{ type: 'text', text: userText }] }],
      tools: []
    },
    () => {}
  )
  const text = res.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('')
  return stripMoodTags(text).text
}

/** System prompt with Capri's persona for one-shot calls. */
export function personaPrompt(): string {
  const settings = getSettings()
  return buildSystemPrompt({
    settings,
    anger: getMood().anger,
    memories: settings.memory.enabled ? listMemories() : [],
    nowPlaying: currentNowPlaying(),
    enabledTools: []
  })
}

/** Inject a line Capri said outside the chat (e.g. after a meltdown) into the visible history. */
export function addAssistantNote(text: string): void {
  history.push({ role: 'assistant', parts: [{ type: 'text', text }] })
  pushUi({ role: 'assistant', text })
  persist()
}
