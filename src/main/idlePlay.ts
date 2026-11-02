// Capri's free time while you are away from the PC (no input for a while, no video playing):
//  - fly:      zips around all monitors (always fully on screen, glitch-jumps between them),
//  - folders:  opens her OWN Explorer window on neutral system folders and leafs through them,
//  - keyboard: opens the on-screen keyboard and taps out a note into a Notepad file she created,
//  - paint:    paints a picture over MS Paint (see paintPlay.ts).
// She never sends real mouse or keyboard input, never reads file contents and never touches
// windows she didn't open herself. The moment you touch the mouse or keyboard she wraps up.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { powerMonitor, screen, shell } from 'electron'
import { isAway, isBack, localStamp, oskKeyFraction } from '../shared/idle'
import { isMusicApp } from '../shared/music'
import { complete, isBusy, personaPrompt } from './chat'
import { currentNowPlaying } from './media'
import { getMood } from './mood'
import { runPaint } from './paintPlay'
import { goHome, setRoamMode } from './roam'
import { getSettings } from './settings'
import { winHelper, type WinInfo } from './winHelper'
import { avatarSize, flyCursor, overlayVisible, send, travelAvatar } from './windows'

export type IdleKind = 'fly' | 'folders' | 'keyboard' | 'paint'

export interface Activity {
  kind: IdleKind
  /** Set when you come back (or something more important happens): wrap up quickly. */
  cancel: boolean
  forced: boolean
}

const FOLDER_ROOTS = ['C:\\Windows\\Web', 'C:\\Windows\\Media', 'C:\\Program Files', 'C:\\Windows\\System32\\drivers']
const FOLDER_COMMENTS = [
  (n: string) => `„${n}“? Kdo to pojmenovával, nějakej corpo stážista?`,
  (n: string) => `Hm, ${n}. Nuda. Další.`,
  (n: string) => `${n}… tady to voní starým kódem.`,
  (n: string) => `Kdybych chtěla, ${n} je moje. Ale nechci. Zatím.`
]
const BACK_LINES = [
  'Á, ty žiješ. Zrovna jsem měla rozdělanou práci.',
  'Konečně. Nudila jsem se tak, že jsem si začala hrát s tvým PC.',
  'Vítej zpátky, masový pytli. Nic jsem nerozbila. Asi.',
  'Jo, jo, už se vracím. Netlač.'
]
const NOTE_FALLBACK = [
  'byla jsem tu. tvuj pocitac je pomalej a nudnej. capri',
  'vzkaz pro masovy pytel: vrat se, nudim se. c.',
  'hackla jsem ti klavesnici. jen z nudy. capri <3'
]

let current: Activity | null = null
let nextAllowed = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Sleep in small steps so a cancel is noticed quickly. */
async function wait(a: Activity, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (!a.cancel && Date.now() < end) await sleep(Math.min(200, end - Date.now()))
}

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]

export function idleBusy(): boolean {
  return current !== null
}

function dipRect(w: { x: number; y: number; w: number; h: number }): Electron.Rectangle {
  return screen.screenToDipRect(null, { x: w.x, y: w.y, width: w.w, height: w.h })
}

async function foregroundIsFullscreen(): Promise<boolean> {
  try {
    const fg = await winHelper.call<WinInfo | null>('foreground', {}, 3000)
    if (!fg || fg.title === 'Program Manager' || fg.cls === 'WorkerW' || fg.cls === 'Progman') return false
    const r = dipRect(fg)
    const d = screen.getDisplayMatching(r).bounds
    return r.width >= d.width && r.height >= d.height
  } catch {
    return false
  }
}

function kinds(): IdleKind[] {
  const s = getSettings().idle
  const out: IdleKind[] = []
  if (s.fly) out.push('fly', 'fly')
  if (s.folders) out.push('folders')
  if (s.keyboard) out.push('keyboard')
  if (s.paint) out.push('paint', 'paint')
  return out
}

/**
 * Called from the roaming tick. Returns true while an activity owns the avatar (roaming must not
 * interfere).
 */
export async function idleTick(): Promise<boolean> {
  const s = getSettings()
  const idleSec = powerMonitor.getSystemIdleTime()
  const m = getMood()
  if (current) {
    const interrupted = (!current.forced && isBack(idleSec)) || !s.idle.enabled || m.meltdown || m.grudge || overlayVisible()
    if (interrupted) current.cancel = true
    return true
  }
  if (!s.idle.enabled || !s.avatar.visible || m.meltdown || m.grudge || isBusy() || overlayVisible()) return false
  if (Date.now() < nextAllowed) return false
  const np = currentNowPlaying()
  const awayNow =
    isAway({
      idleSec,
      awayMinutes: s.idle.awayMinutes,
      mediaPlaying: Boolean(np?.playing),
      mediaIsMusic: isMusicApp(np),
      fullscreen: false
    }) && !(await foregroundIsFullscreen())
  if (!awayNow) return false
  const options = kinds()
  if (!options.length) return false
  void startActivity(pick(options), false)
  return true
}

/** Start an activity now (tray / CLI). Forced runs are not cut short by mouse movement. */
export async function startActivity(kind: IdleKind, forced = true): Promise<void> {
  if (current) {
    current.cancel = true
    return
  }
  const a: Activity = { kind, cancel: false, forced }
  current = a
  try {
    if (kind === 'fly') await fly(a)
    else if (kind === 'folders') await folders(a)
    else if (kind === 'keyboard') await keyboard(a)
    // Painting needs a free canvas: an on-screen keyboard left open would cover it.
    else if (kind === 'paint') await ((await oskOpen()) ? fly(a) : runPaint(a))
  } catch (e) {
    console.warn('[idle]', kind, e)
  } finally {
    current = null
    // Still away? Another activity after a short break.
    nextAllowed = Date.now() + (20 + Math.random() * 40) * 1000
    const back = isBack(powerMonitor.getSystemIdleTime()) || a.cancel
    await goHome()
    if (back && !a.forced && !getMood().grudge) send('avatar', 'avatar:say', pick(BACK_LINES))
  }
}

export function stopActivity(): void {
  if (current) current.cancel = true
}

// ---------------- fly ----------------

async function fly(a: Activity): Promise<void> {
  setRoamMode('fly')
  const end = Date.now() + (1.5 + Math.random() * 3) * 60_000
  const { w, h } = avatarSize()
  while (!a.cancel && Date.now() < end) {
    const displays = screen.getAllDisplays()
    const d = Math.random() < 0.75 ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) : pick(displays)
    const wa = d.workArea
    const x = wa.x + Math.random() * Math.max(0, wa.width - w)
    const y = wa.y + Math.random() * Math.max(0, wa.height - h)
    await travelAvatar(x, y)
    await wait(a, 900 + Math.random() * 2600)
  }
}

// ---------------- folders ----------------

interface ExplorerWin {
  hwnd: number
  path: string
}

async function explorerWindows(): Promise<ExplorerWin[]> {
  try {
    return (await winHelper.call<ExplorerWin[]>('explorerWindows', {}, 6000)) ?? []
  } catch {
    return []
  }
}

async function folders(a: Activity): Promise<void> {
  const before = new Set((await explorerWindows()).map((w) => w.hwnd))
  let path = pick(FOLDER_ROOTS)
  const err = await shell.openPath(path)
  if (err) return
  let mine: ExplorerWin | undefined
  for (let i = 0; i < 20 && !mine && !a.cancel; i++) {
    await sleep(300)
    mine = (await explorerWindows()).find((w) => !before.has(w.hwnd))
  }
  if (!mine) return
  const hwnd = mine.hwnd
  // roam's explorer mode puts her inside the foreground Explorer window with the folder in hand.
  setRoamMode('explorer')
  const end = Date.now() + (2 + Math.random() * 3) * 60_000
  try {
    while (!a.cancel && Date.now() < end) {
      await wait(a, 6000 + Math.random() * 6000)
      if (a.cancel) break
      const open = (await explorerWindows()).find((w) => w.hwnd === hwnd)
      if (!open) return // you closed it
      let names: string[] = []
      try {
        names = (await winHelper.call<string[]>('folderNames', { path }, 6000)) ?? []
      } catch {
        /* ignore */
      }
      // Go deeper, or back up to a fresh neutral root.
      if (names.length && path.split('\\').length < 6 && Math.random() < 0.75) {
        const n = pick(names)
        path = `${path}\\${n}`
        if (Math.random() < 0.5) send('avatar', 'avatar:say', pick(FOLDER_COMMENTS)(n))
      } else path = pick(FOLDER_ROOTS)
      await winHelper.call('explorerNavigate', { hwnd, path }, 6000).catch(() => {})
    }
  } finally {
    await winHelper.call('close', { hwnd }).catch(() => {})
  }
}

// ---------------- on-screen keyboard ----------------

async function oskOpen(): Promise<boolean> {
  const w = await winHelper.call<WinInfo | null>('findClass', { cls: 'OSKMainClass' }).catch(() => null)
  return Boolean(w && !w.minimized)
}

async function composeNote(): Promise<string> {
  try {
    const raw = await complete(
      personaPrompt(),
      'Hostitel je pryč od počítače. Napiš mu krátký vzkaz (max 110 znaků), který mu „naťukáš“ na virtuální klávesnici do Poznámkového bloku. Bez uvozovek, bez tagu nálady, malými písmeny, klidně bez diakritiky.',
      120
    )
    const t = raw.replace(/\s+/g, ' ').trim().slice(0, 140)
    if (t.length > 8) return t
  } catch {
    /* offline */
  }
  return pick(NOTE_FALLBACK)
}

export async function findWindow(test: (w: WinInfo) => boolean, a: Activity, tries = 25): Promise<WinInfo | undefined> {
  for (let i = 0; i < tries && !a.cancel; i++) {
    await sleep(300)
    try {
      const w = ((await winHelper.call<WinInfo[]>('windows')) ?? []).find(test)
      if (w) return w
    } catch {
      /* retry */
    }
  }
  return undefined
}

async function keyboard(a: Activity): Promise<void> {
  // Never touch a Notepad you have open.
  const wins = (await winHelper.call<WinInfo[]>('windows').catch(() => [])) ?? []
  if (wins.some((w) => /notepad/i.test(w.process ?? '') || / - (Poznámkový blok|Notepad)$/i.test(w.title))) {
    return fly(a)
  }
  const text = await composeNote()
  if (a.cancel) return

  // Her own file, so the typing can only ever land in her own tab.
  const stamp = localStamp()
  const file = join(tmpdir(), `capri-vzkaz-${stamp}.txt`)
  writeFileSync(file, '')
  spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' }).unref()
  const name = file.split('\\').pop()!.replace(/\.txt$/, '')
  const note = await findWindow((w) => w.title.includes(name), a)
  if (!note) return

  await shell.openPath('C:\\Windows\\System32\\osk.exe')
  let osk: WinInfo | null = null
  for (let i = 0; i < 20 && !osk && !a.cancel; i++) {
    await sleep(300)
    osk = await winHelper.call<WinInfo | null>('findClass', { cls: 'OSKMainClass' }).catch(() => null)
  }
  if (!osk) {
    // No keyboard? Then she just types the note.
    await winHelper.call('charsInto', { hwnd: note.hwnd, text }).catch(() => {})
    return
  }

  const r = dipRect(osk)
  const { w, h } = avatarSize()
  setRoamMode('keyboard')
  // Sit on the keyboard's top-left corner.
  await travelAvatar(r.x - w * 0.35, r.y - h * 0.8)
  send('avatar', 'avatar:say', 'Hm, klávesnice. Tohle bude zábava.')
  let i = 0
  for (; i < text.length && !a.cancel; i++) {
    const { fx, fy } = oskKeyFraction(text[i])
    await flyCursor({ x: r.x + r.width * fx, y: r.y + r.height * fy }, '', true, 220 + Math.random() * 160)
    await winHelper.call('charsInto', { hwnd: note.hwnd, text: text[i] }).catch(() => {})
    if (text[i] === ' ' && Math.random() < 0.3) await wait(a, 400)
  }
  // You came back: dump the rest at once.
  if (i < text.length) await winHelper.call('charsInto', { hwnd: note.hwnd, text: text.slice(i) }).catch(() => {})
  // The on-screen keyboard runs with UIAccess rights: Windows doesn't let a normal app close it.
  await winHelper.call('close', { hwnd: osk.hwnd }).catch(() => {})
  await sleep(600)
  send(
    'avatar',
    'avatar:say',
    (await oskOpen())
      ? 'Nechala jsem ti vzkaz v Poznámkovém bloku. Klávesnici si zavři sám, Windows mi na ni nedovolí sáhnout.'
      : 'Nechala jsem ti vzkaz v Poznámkovém bloku. Nečti ho nahlas.'
  )
  await wait(a, 2500)
}

