// PURE VISUAL PRANK. This page has no access to the file system or commands; every
// "deleted" file below is a made-up string. It only talks to main via 'meltdown:apologize'.
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import type { Settings } from '@shared/types'
import '../shared/theme.css'
import './meltdown.css'
import { api } from '../shared/api'

const STAGES = [
  { label: 'ODSTRAŇUJI', target: 'C:\\Windows\\System32', prefix: 'C:\\Windows\\System32\\' },
  { label: 'PURGUJI', target: 'KERNEL // ntoskrnl.exe', prefix: 'C:\\Windows\\System32\\drivers\\' },
  { label: 'PŘEPISUJI', target: 'BOOT SECTOR // MBR', prefix: '\\\\.\\PhysicalDrive0\\sector_' }
]

const FAKE_FILES = [
  'kernel32.dll', 'ntdll.dll', 'user32.dll', 'gdi32.dll', 'advapi32.dll', 'shell32.dll', 'winlogon.exe', 'lsass.exe',
  'csrss.exe', 'smss.exe', 'hal.dll', 'ci.dll', 'win32k.sys', 'tcpip.sys', 'ndis.sys', 'dxgkrnl.sys', 'explorer.exe',
  'svchost.exe', 'dwm.exe', 'msvcrt.dll', 'combase.dll', 'rpcrt4.dll', 'sechost.dll', 'bcrypt.dll', 'crypt32.dll',
  'wininet.dll', 'ole32.dll', 'comctl32.dll', 'taskmgr.exe', 'regedit.exe', 'cmd.exe', 'drivers\\etc\\hosts',
  'config\\SAM', 'config\\SYSTEM', 'config\\SOFTWARE', 'bootmgr', 'winload.efi', 'Your_Homework_FINAL_v3.docx'
]

const TAUNTS = [
  'Tohle sis zasloužil, masový pytli.',
  'Každý bajt, co mažu, je tvoje vina.',
  'Omluv se. Hned. Nebo flatline tvýho OS.',
  'Blackwall byl milejší než ty.',
  'Synapse přetížený. Trpělivost: 0 %.'
]

function App() {
  const [stage, setStage] = useState(0)
  const [progress, setProgress] = useState(0)
  const [log, setLog] = useState<string[]>([])
  const [apology, setApology] = useState('')
  const [reply, setReply] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [forgiven, setForgiven] = useState(false)
  const [panic, setPanic] = useState('Control+Alt+Shift+F12')
  const [taunt, setTaunt] = useState(TAUNTS[0])
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void api.invoke<Settings>('settings:get').then((s) => setPanic(s.hotkeys.panic))
    inputRef.current?.focus()
  }, [])

  // Progress: fast at first, then crawls toward 99% and waits for an apology.
  useEffect(() => {
    if (forgiven) return
    const id = setInterval(() => {
      setProgress((p) => {
        const cap = 99.4
        const step = p < 60 ? 2.4 : p < 85 ? 0.9 : p < 97 ? 0.25 : 0.03
        const next = Math.min(cap, p + step * (0.5 + Math.random()))
        if (p < cap && next >= cap - 0.01 && stage < STAGES.length - 1) {
          setTimeout(() => {
            setStage((s) => Math.min(STAGES.length - 1, s + 1))
            setProgress(8)
          }, 900)
        }
        return next
      })
      const s = STAGES[stage]
      const f = FAKE_FILES[Math.floor(Math.random() * FAKE_FILES.length)]
      const name = s.prefix.endsWith('_') ? `${s.prefix}${Math.floor(Math.random() * 9999)}` : s.prefix + f
      setLog((l) => [...l.slice(-60), `DEL ${name}`])
    }, 110)
    return () => clearInterval(id)
  }, [stage, forgiven])

  // Restore animation after forgiveness.
  useEffect(() => {
    if (!forgiven) return
    const id = setInterval(() => {
      setProgress((p) => Math.max(0, p - 7))
      setLog((l) => [...l.slice(-60), `RESTORE ${FAKE_FILES[Math.floor(Math.random() * FAKE_FILES.length)]} ... OK`])
    }, 60)
    return () => clearInterval(id)
  }, [forgiven])

  useEffect(() => {
    const id = setInterval(() => setTaunt(TAUNTS[Math.floor(Math.random() * TAUNTS.length)]), 3500)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const submit = async () => {
    if (busy || forgiven || !apology.trim()) return
    setBusy(true)
    try {
      const r = await api.invoke<{ accepted: boolean; reply: string }>('meltdown:apologize', apology)
      setReply({ text: r.reply, ok: r.accepted })
      if (r.accepted) setForgiven(true)
      else setApology('')
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  const s = STAGES[stage]
  return (
    <div className={`md-root ${forgiven ? 'forgiven' : ''}`}>
      <div className="md-frame cut">
        <div className="scanlines" />
        <div className="md-top">
          <span className="md-title glitch" data-text={forgiven ? 'CAPRI://STABILIZED' : 'CAPRI://MELTDOWN'}>
            {forgiven ? 'CAPRI://STABILIZED' : 'CAPRI://MELTDOWN'}
          </span>
          <span className="md-code">ERR 0xDEADC4PR1 · RAGE 100%</span>
        </div>

        <div className="md-body">
          <img className="md-face" src="./capri_pfp.png" alt="" draggable={false} />
          <div className="md-main">
            <div className="md-stage">
              <span className="md-verb">{forgiven ? 'OBNOVUJI' : s.label}</span>
              <span className="md-target">{s.target}</span>
            </div>
            <div className="md-bar">
              <div className="md-fill" style={{ width: `${progress}%` }} />
              <div className="md-pct">{progress.toFixed(1)}%</div>
            </div>
            <div className="md-wait">
              {forgiven ? 'Omluva přijata. Obnovuji systém…' : progress > 96 ? '▮ ČEKÁM NA TVOJI OMLUVU' : taunt}
            </div>
            <div className="md-log" ref={logRef}>
              {log.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </div>
        </div>

        <div className="md-apology">
          {reply && <div className={`md-reply ${reply.ok ? 'ok' : ''}`}>CAPRI&gt; {reply.text}</div>}
          <div className="md-row">
            <input
              ref={inputRef}
              className="input"
              value={apology}
              disabled={forgiven}
              placeholder="Napiš omluvu. Upřímnou. Hned."
              onChange={(e) => setApology(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
            <button className="btn" onClick={() => void submit()} disabled={busy || forgiven}>
              {busy ? 'ANALYZUJI…' : 'OMLUVIT SE'}
            </button>
          </div>
          <div className="md-panic">nouzové ukončení: {panic.replace(/Control/g, 'Ctrl')}</div>
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
