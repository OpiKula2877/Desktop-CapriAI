import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, ConfirmRequest, MoodState, NowPlaying, Settings, UiMessage } from '@shared/types'
import { api } from '../shared/api'
import { Icon } from '../shared/icons'
import { renderMarkdown } from '../shared/markdown'

const MOOD_SEGMENTS = 24

function moodLabel(a: number): string {
  if (a >= 90) return 'KRITICKÝ'
  if (a >= 65) return 'VZTEK'
  if (a >= 40) return 'PODRÁŽDĚNÁ'
  if (a >= 15) return 'OTRÁVENÁ'
  return 'STABILNÍ'
}

function fileToAttachment(file: Blob): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const url = String(r.result)
      const [head, data] = url.split(',')
      resolve({ mime: head.match(/data:(.*?);/)?.[1] ?? 'image/png', data })
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export function App() {
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [confirms, setConfirms] = useState<ConfirmRequest[]>([])
  const [mood, setMood] = useState<MoodState>({ anger: 0, meltdown: false })
  const [np, setNp] = useState<NowPlaying | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [phase, setPhase] = useState<'in' | 'out'>('in')
  const [shotBusy, setShotBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    void api.invoke<UiMessage[]>('chat:history').then(setMessages)
    void api.invoke<MoodState>('mood:get').then(setMood)
    void api.invoke<Settings>('settings:get').then(setSettings)
    const offs = [
      api.on('chat:messages', (m: UiMessage[]) => setMessages([...m])),
      api.on('chat:patch', ({ id, text }: { id: string; text: string }) =>
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text } : m)))
      ),
      api.on('chat:busy', (b: boolean) => setBusy(b)),
      api.on('confirm:request', (r: ConfirmRequest) => setConfirms((c) => [...c, r])),
      api.on('mood', (m: MoodState) => setMood(m)),
      api.on('nowplaying', (n: NowPlaying | null) => setNp(n)),
      api.on('settings:changed', (s: Settings) => setSettings(s)),
      api.on('overlay:shown', () => {
        setPhase('in')
        stick.current = true
        requestAnimationFrame(() => inputRef.current?.focus())
      }),
      api.on('overlay:hiding', () => setPhase('out'))
    ]
    return () => offs.forEach((o) => o())
  }, [])

  // Auto-scroll unless the user scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, confirms])

  const onScroll = () => {
    const el = listRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const sendMsg = useCallback(() => {
    if (busy) return
    const text = input.trim()
    if (!text && !attachments.length) return
    stick.current = true
    void api.invoke('chat:send', text, attachments)
    setInput('')
    setAttachments([])
  }, [busy, input, attachments])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void api.invoke('overlay:hide')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Autosize the textarea.
  useLayoutEffect(() => {
    const t = inputRef.current
    if (!t) return
    t.style.height = '0px'
    t.style.height = Math.min(140, t.scrollHeight) + 'px'
  }, [input])

  const addFiles = async (files: Iterable<File>) => {
    const imgs = [...files].filter((f) => f.type.startsWith('image/')).slice(0, 4)
    const atts = await Promise.all(imgs.map(fileToAttachment))
    setAttachments((a) => [...a, ...atts].slice(0, 6))
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()!).filter(Boolean)
    if (files.length) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  const takeShot = async () => {
    setShotBusy(true)
    try {
      const a = await api.invoke<Attachment>('screen:capture')
      setAttachments((x) => [...x, a].slice(0, 6))
    } finally {
      setShotBusy(false)
      inputRef.current?.focus()
    }
  }

  const answer = (id: string, allow: boolean) => {
    void api.invoke('confirm:respond', id, allow)
    setConfirms((c) => c.filter((x) => x.id !== id))
  }

  // Copy buttons inside rendered markdown.
  const onListClick = (e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('.code-copy') as HTMLButtonElement | null
    if (!btn) return
    const code = btn.closest('.code')?.querySelector('code')?.textContent ?? ''
    void navigator.clipboard.writeText(code)
    btn.textContent = 'COPIED'
    setTimeout(() => (btn.textContent = 'COPY'), 1200)
  }

  const lit = Math.round((mood.anger / 100) * MOOD_SEGMENTS)
  const angry = mood.anger >= 65
  const modelName = settings?.provider.model ?? ''

  return (
    <div
      className={`overlay ${phase} ${angry ? 'angry' : ''} ${dragOver ? 'drag' : ''}`}
      style={{ '--anger': mood.anger / 100 } as React.CSSProperties}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        void addFiles(e.dataTransfer.files)
      }}
    >
      <div className="frame cut">
        <div className="scanlines" />
        <header className="head">
          <div className="ident">
            <img className={`face ${angry ? 'mad' : ''}`} src="./capri_pfp.png" alt="" draggable={false} />
            <div className="ident-text">
              <span className="name glitch" data-text="CAPRI">
                CAPRI
              </span>
              <span className="sub">
                //NET.LINK <i className={busy ? 'dot live' : 'dot'} /> {busy ? 'PROCESSING' : 'ONLINE'}
              </span>
            </div>
          </div>

          <div className="mood" title={`Vztek ${Math.round(mood.anger)} / 100`}>
            <div className="mood-top">
              <span>RAGE</span>
              <b>{moodLabel(mood.anger)}</b>
            </div>
            <div className="mood-bar">
              {Array.from({ length: MOOD_SEGMENTS }, (_, i) => (
                <i key={i} className={i < lit ? 'on' : ''} />
              ))}
            </div>
          </div>

          <div className="actions">
            <button className="btn ghost icon" title="Vymazat konverzaci" onClick={() => void api.invoke('chat:clear')}>
              <Icon.trash />
            </button>
            <button className="btn ghost icon" title="Nastavení" onClick={() => void api.invoke('settings:open')}>
              <Icon.gear />
            </button>
            <button className="btn ghost icon" title="Schovat (Esc)" onClick={() => void api.invoke('overlay:hide')}>
              <Icon.up />
            </button>
          </div>
        </header>

        {np?.playing && (
          <div className="np">
            <Icon.note />
            <div className="np-track">
              <span>
                {np.title}
                {np.artist ? ` — ${np.artist}` : ''}
              </span>
            </div>
          </div>
        )}

        <div className="list" ref={listRef} onScroll={onScroll} onClick={onListClick}>
          {messages.map((m) => (
            <Message key={m.id} m={m} />
          ))}
          {confirms.map((c) => (
            <div key={c.id} className="confirm cut">
              <div className="confirm-label">CAPRI CHCE PŘÍSTUP</div>
              <div className="confirm-text">{c.summary}</div>
              <div className="confirm-actions">
                <button className="btn green" onClick={() => answer(c.id, true)}>
                  Povolit
                </button>
                <button className="btn ghost" onClick={() => answer(c.id, false)}>
                  Zamítnout
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="composer">
          {attachments.length > 0 && (
            <div className="atts">
              {attachments.map((a, i) => (
                <div key={i} className="att cut">
                  <img src={`data:${a.mime};base64,${a.data}`} alt="" />
                  <button onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))} title="Odebrat">
                    <Icon.close />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="row">
            <span className="prompt">&gt;</span>
            <textarea
              ref={inputRef}
              className="ta"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={onPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendMsg()
                }
              }}
              autoFocus
            />
            <button className="btn ghost icon" title="Screenshot obrazovky" onClick={takeShot} disabled={shotBusy}>
              <Icon.camera />
            </button>
            <button className="btn ghost icon" title="Přiložit obrázek" onClick={() => {
                // The native file dialog takes focus – don't let that close the overlay.
                void api.invoke('overlay:hold').then(() => fileRef.current?.click())
              }}>
              <Icon.image />
            </button>
            {busy ? (
              <button className="btn icon" title="Zastavit" onClick={() => void api.invoke('chat:stop')}>
                <Icon.stop />
              </button>
            ) : (
              <button className="btn icon send" title="Odeslat (Enter)" onClick={sendMsg}>
                <Icon.send />
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>
          <div className="foot">
            <span>{modelName}</span>
            <span>ENTER odeslat · SHIFT+ENTER řádek · ESC schovat · CTRL+V obrázek</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function Message({ m }: { m: UiMessage }) {
  const html = useMemo(() => (m.role === 'assistant' ? renderMarkdown(m.text) : ''), [m.role, m.text])
  const [copied, setCopied] = useState(false)

  if (m.role === 'tool') {
    return (
      <div className={`msg tool ${m.pending ? 'pending' : ''}`}>
        <span>{m.text}</span>
        {m.images?.map((src, i) => <img key={i} className="tool-img" src={src} alt="" />)}
      </div>
    )
  }
  if (m.role === 'system') return <div className="msg system cut">{m.text}</div>
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble cut">
          {m.images?.map((src, i) => <img key={i} className="user-img" src={src} alt="" />)}
          {m.text && <div className="user-text">{m.text}</div>}
        </div>
      </div>
    )
  }
  return (
    <div className={`msg assistant ${m.pending ? 'pending' : ''}`}>
      <div className="tag">CAPRI&gt;</div>
      <div className="body">
        {m.text ? <div className="md" dangerouslySetInnerHTML={{ __html: html }} /> : <span className="typing">▮</span>}
        {m.pending && m.text && <span className="caret">▮</span>}
      </div>
      {!m.pending && m.text && (
        <button
          className="copy"
          title="Kopírovat"
          onClick={() => {
            void navigator.clipboard.writeText(m.text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1000)
          }}
        >
          {copied ? 'OK' : <Icon.copy />}
        </button>
      )}
    </div>
  )
}
