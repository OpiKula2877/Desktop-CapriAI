import { useEffect, useState, type ReactNode } from 'react'
import { PROVIDER_PRESETS, TOOL_LABELS } from '@shared/defaults'
import type { MemoryItem, MoodState, PermissionMode, ProviderKind, Settings, ToolName } from '@shared/types'
import { api } from '../shared/api'
import { Icon } from '../shared/icons'

type Tab = 'ai' | 'persona' | 'access' | 'music' | 'memory' | 'system'

const TABS: { id: Tab; label: string; code: string }[] = [
  { id: 'ai', label: 'AI Link', code: '01' },
  { id: 'persona', label: 'Osobnost', code: '02' },
  { id: 'access', label: 'Přístup', code: '03' },
  { id: 'music', label: 'Hudba', code: '04' },
  { id: 'memory', label: 'Paměť', code: '05' },
  { id: 'system', label: 'Systém', code: '06' }
]

const PROVIDER_LABELS: Record<ProviderKind, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI-kompatibilní (OpenAI, OpenRouter, Groq, Ollama, LM Studio…)',
  gemini: 'Google Gemini'
}

export function App() {
  const [s, setS] = useState<Settings | null>(null)
  const [tab, setTab] = useState<Tab>('ai')

  useEffect(() => {
    void api.invoke<Settings>('settings:get').then(setS)
    return api.on('settings:changed', (n: Settings) => setS(n))
  }, [])

  const patch = async (p: unknown) => setS(await api.invoke<Settings>('settings:set', p))

  if (!s) return null
  return (
    <div className="st-root">
      <div className="titlebar">
        <span className="tb-logo glitch" data-text="CAPRI">
          CAPRI
        </span>
        <span className="tb-sub">// CONFIG SHARD v1.0.0</span>
        <div className="tb-actions">
          <button title="Minimalizovat" onClick={() => void api.invoke('window:minimize')}>
            <Icon.min />
          </button>
          <button className="close" title="Zavřít" onClick={() => void api.invoke('window:close')}>
            <Icon.close />
          </button>
        </div>
      </div>
      <div className="st-body">
        <nav className="st-nav">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              <span className="code">{t.code}</span>
              {t.label}
            </button>
          ))}
          <img className="nav-face" src="./capri_icon.png" alt="" draggable={false} />
        </nav>
        <main className="st-main" key={tab}>
          {tab === 'ai' && <AiTab s={s} patch={patch} />}
          {tab === 'persona' && <PersonaTab s={s} patch={patch} />}
          {tab === 'access' && <AccessTab s={s} patch={patch} />}
          {tab === 'music' && <MusicTab s={s} patch={patch} />}
          {tab === 'memory' && <MemoryTab s={s} patch={patch} />}
          {tab === 'system' && <SystemTab s={s} patch={patch} />}
        </main>
      </div>
    </div>
  )
}

interface TabProps {
  s: Settings
  patch: (p: unknown) => Promise<void>
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="sec cut">
      <h2>{title}</h2>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
    </label>
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} type="button">
      <span className="knob" />
      <span>{label}</span>
    </button>
  )
}

/** Text input that commits on blur / Enter instead of every keystroke. */
function LazyInput(props: { value: string; onCommit: (v: string) => void; placeholder?: string; type?: string }) {
  const [v, setV] = useState(props.value)
  useEffect(() => setV(props.value), [props.value])
  return (
    <input
      className="input"
      type={props.type ?? 'text'}
      value={v}
      placeholder={props.placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== props.value && props.onCommit(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

// ---------------- AI ----------------
function AiTab({ s, patch }: TabProps) {
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const kind = s.provider.kind

  useEffect(() => {
    void api.invoke<boolean>('apikey:has', kind).then(setHasKey)
    setKey('')
    setTest(null)
  }, [kind])

  const saveKey = async () => {
    await api.invoke('apikey:set', kind, key)
    setHasKey(Boolean(key.trim()))
    setKey('')
  }

  const runTest = async () => {
    setTesting(true)
    setTest(null)
    if (key.trim()) await saveKey()
    setTest(await api.invoke('provider:test'))
    setTesting(false)
  }

  return (
    <>
      <Section title="Poskytovatel" hint="Capri může běžet na jakémkoli modelu. Výchozí je Claude Haiku 5.5.">
        <Field label="Typ API">
          <select
            className="select"
            value={kind}
            onChange={(e) => {
              const k = e.target.value as ProviderKind
              void patch({ provider: { kind: k, ...PROVIDER_PRESETS[k] } })
            }}
          >
            {(Object.keys(PROVIDER_LABELS) as ProviderKind[]).map((k) => (
              <option key={k} value={k}>
                {PROVIDER_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid2">
          <Field label="Model">
            <LazyInput value={s.provider.model} onCommit={(v) => void patch({ provider: { model: v.trim() } })} />
          </Field>
          <Field label="Rychlý model (hlášky, omluvy) – volitelné">
            <LazyInput
              value={s.provider.fastModel}
              placeholder="stejný jako hlavní"
              onCommit={(v) => void patch({ provider: { fastModel: v.trim() } })}
            />
          </Field>
        </div>
        <div className="grid2">
          <Field label="Base URL">
            <LazyInput value={s.provider.baseUrl} onCommit={(v) => void patch({ provider: { baseUrl: v.trim() } })} />
          </Field>
          <Field label="Max tokenů odpovědi">
            <LazyInput
              type="number"
              value={String(s.provider.maxTokens)}
              onCommit={(v) => void patch({ provider: { maxTokens: Math.max(64, Math.min(32000, Number(v) || 1500)) } })}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="API klíč"
        hint="Klíč je uložený šifrovaně přes Windows (DPAPI) a nikdy neopustí hlavní proces aplikace. U lokálních modelů (Ollama) ho nechej prázdný."
      >
        <div className="row">
          <input
            className="input"
            type="password"
            value={key}
            placeholder={hasKey ? '•••••••••• (uložený – napiš nový pro změnu)' : 'Vlož API klíč'}
            onChange={(e) => setKey(e.target.value)}
          />
          <button className="btn" onClick={() => void saveKey()} disabled={!key.trim()}>
            Uložit
          </button>
          {hasKey && (
            <button
              className="btn ghost"
              onClick={async () => {
                await api.invoke('apikey:set', kind, '')
                setHasKey(false)
              }}
            >
              Smazat
            </button>
          )}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn green" onClick={() => void runTest()} disabled={testing}>
            {testing ? 'Pinguji net…' : 'Otestovat spojení'}
          </button>
          {test && <span className={`test ${test.ok ? 'ok' : 'bad'}`}>{test.message}</span>}
        </div>
      </Section>
    </>
  )
}

// ---------------- Persona ----------------
function PersonaTab({ s, patch }: TabProps) {
  const [vol, setVol] = useState(s.personality.volatility)
  const [mood, setMood] = useState<MoodState | null>(null)
  useEffect(() => setVol(s.personality.volatility), [s.personality.volatility])
  useEffect(() => {
    void api.invoke<MoodState>('mood:get').then(setMood)
    return api.on('mood', (m: MoodState) => setMood(m))
  }, [])

  const volLabel =
    vol >= 85 ? 'TOTÁLNÍ PSYCHO' : vol >= 60 ? 'VÝBUŠNÁ' : vol >= 30 ? 'SARKASTICKÁ' : 'SKORO V KLIDU (skoro)'

  return (
    <>
      <Section
        title="Volatilita"
        hint="Jak rychle se Capri naštve. Na 100 % stačí málo a spustí meltdown. Na 0 % ji skoro nic nerozhodí."
      >
        <div className="vol">
          <input
            type="range"
            min={0}
            max={100}
            value={vol}
            onChange={(e) => setVol(Number(e.target.value))}
            onPointerUp={() => void patch({ personality: { volatility: vol } })}
            onKeyUp={() => void patch({ personality: { volatility: vol } })}
            style={{ '--v': `${vol}%` } as React.CSSProperties}
          />
          <div className="vol-read">
            <b>{vol}%</b>
            <span>{volLabel}</span>
          </div>
        </div>
        {mood && (
          <div className="row" style={{ marginTop: 14 }}>
            <span className="label">Aktuální vztek: {Math.round(mood.anger)} / 100</span>
            <button className="btn ghost" onClick={() => void api.invoke('mood:reset')}>
              Uklidnit
            </button>
          </div>
        )}
      </Section>
      <Section title="Meltdown" hint="Když vztek dojde na 100 %, Capri začne „mazat System32“ a nepřestane, dokud se neomluvíš. Je to čistě vizuální divadlo – nic se nemaže.">
        <Toggle
          on={s.personality.meltdownEnabled}
          onChange={(v) => void patch({ personality: { meltdownEnabled: v } })}
          label="Povolit meltdown"
        />
      </Section>
      <Section title="Blackout" hint="Když s ní moc třeseš, nejdřív se nedá posunout, a když to přeženeš, zčerná všechny obrazovky, po blocích je zase složí a čeká uprostřed na omluvu. Nouzová zkratka ho kdykoli ukončí.">
        <Toggle
          on={s.personality.blackoutEnabled}
          onChange={(v) => void patch({ personality: { blackoutEnabled: v } })}
          label="Povolit blackout při vzteku z třesení"
        />
      </Section>
      <Section title="Spontánní hlášky" hint="Capri občas sama něco řekne v bublině nad postavičkou.">
        <Toggle on={s.quips.enabled} onChange={(v) => void patch({ quips: { enabled: v } })} label="Zapnuto" />
        <div className="grid2" style={{ marginTop: 12 }}>
          <Field label="Minimálně po (minut)">
            <LazyInput
              type="number"
              value={String(s.quips.minMinutes)}
              onCommit={(v) => void patch({ quips: { minMinutes: Math.max(1, Number(v) || 20) } })}
            />
          </Field>
          <Field label="Maximálně po (minut)">
            <LazyInput
              type="number"
              value={String(s.quips.maxMinutes)}
              onCommit={(v) => void patch({ quips: { maxMinutes: Math.max(1, Number(v) || 60) } })}
            />
          </Field>
        </div>
      </Section>
      <Section title="Vlastní instrukce" hint="Doplní se do jejího promptu. Např. jak ti má říkat nebo na co se zaměřit.">
        <PromptArea value={s.personality.extraPrompt} onCommit={(v) => void patch({ personality: { extraPrompt: v } })} />
      </Section>
    </>
  )
}

function PromptArea({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value)
  return (
    <textarea
      className="textarea"
      rows={5}
      value={v}
      placeholder="Říkej mi Sam. Když se ptám na kód, odpovídej v TypeScriptu…"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
    />
  )
}

// ---------------- Access ----------------
const MODES: { id: PermissionMode; label: string }[] = [
  { id: 'off', label: 'Zakázáno' },
  { id: 'ask', label: 'Ptát se' },
  { id: 'auto', label: 'Sama' }
]

function AccessTab({ s, patch }: TabProps) {
  const tools = Object.keys(TOOL_LABELS) as ToolName[]
  return (
    <>
      <Section
        title="Oprávnění"
        hint="Co Capri smí na tvém počítači. „Ptát se“ zobrazí v chatu potvrzení před každou akcí. Klikání a psaní jsou ve výchozím stavu vypnuté."
      >
        <div className="perms">
          {tools.map((t) => (
            <div key={t} className="perm">
              <span>{TOOL_LABELS[t]}</span>
              <div className="seg">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    className={`${s.permissions[t] === m.id ? 'active' : ''} m-${m.id}`}
                    onClick={() => void patch({ permissions: { [t]: m.id } })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>
      <Section
        title="Povolené složky"
        hint="Soubory smí Capri číst, procházet a otevírat jen v těchto složkách (včetně podsložek). Bez složky jsou souborové nástroje vypnuté."
      >
        <div className="folders">
          {s.allowedFolders.length === 0 && <div className="empty-note">Žádné složky. Capri je zamčená mimo souborový systém.</div>}
          {s.allowedFolders.map((f) => (
            <div key={f} className="folder cut">
              <span>{f}</span>
              <button
                className="btn ghost icon"
                title="Odebrat"
                onClick={() => void patch({ allowedFolders: s.allowedFolders.filter((x) => x !== f) })}
              >
                <Icon.close />
              </button>
            </div>
          ))}
        </div>
        <button
          className="btn"
          style={{ marginTop: 12 }}
          onClick={async () => {
            const dir = await api.invoke<string | null>('folder:pick')
            if (dir && !s.allowedFolders.includes(dir)) void patch({ allowedFolders: [...s.allowedFolders, dir] })
          }}
        >
          + Přidat složku
        </button>
      </Section>
    </>
  )
}

// ---------------- Music ----------------
function MusicTab({ s, patch }: TabProps) {
  return (
    <Section
      title="Hudba"
      hint="Capri vidí, co hraje (Spotify, YouTube v prohlížeči, …) přes Windows. U hudebních aplikací (Spotify, Apple Music…) tančí hned. U YouTube a jiných webů nejdřív poslouchá a tančí, jen když AI (YAMNet, běží lokálně) pozná hudbu – ne mluvení. Zvuk nikdy neopustí počítač."
    >
      <div className="stack">
        <Toggle on={s.music.enabled} onChange={(v) => void patch({ music: { enabled: v } })} label="Reagovat na hudbu (vibování, noty)" />
        <Toggle
          on={s.music.beatDetection}
          onChange={(v) => void patch({ music: { beatDetection: v } })}
          label="Poslouchat zvuk systému – rytmus a AI rozpoznání hudby (YouTube apod.)"
        />
        <Toggle on={s.music.comments} onChange={(v) => void patch({ music: { comments: v } })} label="Občas okomentovat písničku" />
      </div>
    </Section>
  )
}

// ---------------- Memory ----------------
function MemoryTab({ s, patch }: TabProps) {
  const [items, setItems] = useState<MemoryItem[]>([])
  const load = () => void api.invoke<MemoryItem[]>('memory:list').then(setItems)
  useEffect(load, [])
  return (
    <>
      <Section title="Dlouhodobá paměť" hint="Věci, které si Capri o tobě zapamatovala. Používá je v každé konverzaci.">
        <Toggle on={s.memory.enabled} onChange={(v) => void patch({ memory: { enabled: v } })} label="Paměť zapnutá" />
      </Section>
      <Section title={`Záznamy (${items.length})`}>
        <div className="mem">
          {items.length === 0 && <div className="empty-note">Zatím o tobě nic neví. Ještě.</div>}
          {[...items].reverse().map((m) => (
            <div key={m.id} className="mem-item cut">
              <span className="mem-date">{new Date(m.createdAt).toLocaleDateString('cs-CZ')}</span>
              <span className="mem-text">{m.text}</span>
              <button
                className="btn ghost icon"
                title="Smazat"
                onClick={async () => {
                  await api.invoke('memory:delete', m.id)
                  load()
                }}
              >
                <Icon.trash />
              </button>
            </div>
          ))}
        </div>
        {items.length > 0 && (
          <button
            className="btn ghost"
            style={{ marginTop: 12 }}
            onClick={async () => {
              if (!confirm('Opravdu vymazat celou paměť?')) return
              await api.invoke('memory:clear')
              load()
            }}
          >
            Vymazat vše
          </button>
        )}
      </Section>
    </>
  )
}

// ---------------- System ----------------
function HotkeyInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [rec, setRec] = useState(false)
  return (
    <button
      className={`hotkey ${rec ? 'rec' : ''}`}
      onClick={() => setRec(true)}
      onBlur={() => setRec(false)}
      onKeyDown={(e) => {
        if (!rec) return
        e.preventDefault()
        if (e.key === 'Escape') return setRec(false)
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
        const parts: string[] = []
        if (e.ctrlKey) parts.push('Control')
        if (e.altKey) parts.push('Alt')
        if (e.shiftKey) parts.push('Shift')
        if (e.metaKey) parts.push('Super')
        let k = e.key.length === 1 ? e.key.toUpperCase() : e.key
        if (k === ' ') k = 'Space'
        if (e.code.startsWith('Key')) k = e.code.slice(3)
        if (e.code.startsWith('Digit')) k = e.code.slice(5)
        if (!parts.length && !/^F\d+$/.test(k)) return
        onCommit([...parts, k].join('+'))
        setRec(false)
      }}
    >
      {rec ? 'Stiskni zkratku…' : value.replace(/Control/g, 'Ctrl')}
    </button>
  )
}

function SizeSlider({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(Math.round(value * 100))
  useEffect(() => setV(Math.round(value * 100)), [value])
  const commit = () => onCommit(v / 100)
  return (
    <div className="vol" style={{ maxWidth: 520 }}>
      <input
        type="range"
        min={45}
        max={140}
        value={v}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        style={{ '--v': `${((v - 45) / 95) * 100}%` } as React.CSSProperties}
      />
      <div className="vol-read">
        <b>{v}%</b>
        <span>VELIKOST</span>
      </div>
    </div>
  )
}

function SystemTab({ s, patch }: TabProps) {
  return (
    <>
      <Section title="Klávesové zkratky" hint="Fungují kdekoli ve Windows. Klikni a stiskni novou kombinaci.">
        <div className="hk">
          <span>Otevřít / schovat chat</span>
          <HotkeyInput value={s.hotkeys.toggleOverlay} onCommit={(v) => void patch({ hotkeys: { toggleOverlay: v } })} />
          <span>Ukázat / schovat Capri na ploše</span>
          <HotkeyInput value={s.hotkeys.summonAvatar} onCommit={(v) => void patch({ hotkeys: { summonAvatar: v } })} />
          <span>Nouzové ukončení meltdownu / blackoutu</span>
          <HotkeyInput value={s.hotkeys.panic} onCommit={(v) => void patch({ hotkeys: { panic: v } })} />
        </div>
      </Section>
      <Section title="Postavička">
        <div className="stack">
          <Toggle on={s.avatar.visible} onChange={(v) => void patch({ avatar: { visible: v } })} label="Zobrazit Capri na ploše" />
          <SizeSlider value={s.avatar.scale} onCommit={(v) => void patch({ avatar: { scale: v } })} />
          <Toggle
            on={s.avatar.roam}
            onChange={(v) => void patch({ avatar: { roam: v } })}
            label="Když se nudí, toulá se po obrazovce a sedá si na okna"
          />
          <Toggle
            on={s.avatar.folderPlay}
            onChange={(v) => void patch({ avatar: { folderPlay: v } })}
            label="Když se nudí, schová se do Průzkumníka a hrabe se ve složkách"
          />
          <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => void patch({ avatar: { x: null, y: null } })}>
            Vrátit na výchozí pozici (po restartu)
          </button>
        </div>
      </Section>
      <Section
        title="Volný čas"
        hint="Když nejsi u počítače (nehýbeš myší a nehraje video), Capri si najde zábavu. Nikdy nehýbe tvou myší ani nepíše tvou klávesnicí a sahá jen na okna, která si sama otevřela. Jakmile se vrátíš, skončí."
      >
        <div className="stack">
          <Toggle on={s.idle.enabled} onChange={(v) => void patch({ idle: { enabled: v } })} label="Zapnuto" />
          <Field label="Jsi pryč po (minut bez pohybu)">
            <LazyInput
              type="number"
              value={String(s.idle.awayMinutes)}
              onCommit={(v) => void patch({ idle: { awayMinutes: Math.max(1, Number(v) || 4) } })}
            />
          </Field>
          <Toggle on={s.idle.fly} onChange={(v) => void patch({ idle: { fly: v } })} label="Poletovat po obrazovkách" />
          <Toggle on={s.idle.folders} onChange={(v) => void patch({ idle: { folders: v } })} label="Prohlížet systémové složky ve vlastním okně Průzkumníka" />
          <Toggle on={s.idle.keyboard} onChange={(v) => void patch({ idle: { keyboard: v } })} label="Ťukat vzkaz na virtuální klávesnici do Poznámkového bloku" />
          <Toggle on={s.idle.paint} onChange={(v) => void patch({ idle: { paint: v } })} label="Malovat obrázky v Paintu (ukládá do Obrázky → CapriAI)" />
          <Field label="Složka s předlohami pro malování (prázdné = Obrázky\CapriAI\předlohy)">
            <div className="row">
              <span className="label">{s.idle.paintTemplates || 'Obrázky\\CapriAI\\předlohy'}</span>
              <button
                className="btn ghost"
                onClick={async () => {
                  const dir = await api.invoke<string | null>('folder:pick')
                  if (dir) void patch({ idle: { paintTemplates: dir } })
                }}
              >
                Vybrat…
              </button>
              {s.idle.paintTemplates && (
                <button className="btn ghost" onClick={() => void patch({ idle: { paintTemplates: '' } })}>
                  Výchozí
                </button>
              )}
            </div>
          </Field>
        </div>
      </Section>
      <Section title="Spuštění">
        <Toggle on={s.system.autostart} onChange={(v) => void patch({ system: { autostart: v } })} label="Spustit s Windows" />
      </Section>
    </>
  )
}
