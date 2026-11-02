// Capri's free-time behaviour. When nobody has paid attention to her for a while she:
//  - dashes off to sit on the top edge of one of your windows,
//  - wanders along the bottom of the screen,
//  - or slips "into your folders": she disappears from the desktop and shows up inside
//    File Explorer (holding a folder) whenever an Explorer window is in front.
// Any interaction (click, chat, hotkey) brings her back home.
import { screen } from 'electron'
import type { AvatarMode } from '../shared/types'
import { isBusy } from './chat'
import { idleTick, stopActivity } from './idlePlay'
import { getMood } from './mood'
import { getSettings } from './settings'
import { winHelper, type WinInfo } from './winHelper'
import {
  AVATAR_HIP_RATIO,
  avatarHome,
  avatarPosition,
  avatarSize,
  getWin,
  overlayVisible,
  placeAvatar,
  send,
  setAvatarShown,
  travelAvatar
} from './windows'

const EXPLORER_CLASS = 'CabinetWClass'
const FOLDER_LINES = [
  'Hrabu se ti ve složkách, choombo. Máš tu bordel.',
  'Tohle je tvůj „Projekt_final_FINAL2“? Fakt?',
  'Našla jsem tu soubory, za který by se styděl i corpo.',
  'Neruš. Indexuju tvůj život.',
  'Tvoje Stažené soubory jsou černá díra.'
]

let mode: AvatarMode = 'home'
let lastInteraction = Date.now()
let boredAfter = randomBoredDelay()
let modeSince = Date.now()
let modeDuration = 0
let perchHwnd = 0
let perchOffset = 0.5
let explorerHwnd = 0
let ticking = false
let saidFolderLine = false
let explorerMissingSince = 0

function randomBoredDelay(): number {
  return (2 + Math.random() * 4) * 60_000
}

function setMode(m: AvatarMode): void {
  mode = m
  modeSince = Date.now()
  send('avatar', 'avatar:mode', m)
}

/** Used by the free-time activities (idlePlay.ts) to switch her pose / behaviour. */
export function setRoamMode(m: AvatarMode): void {
  // Her own Explorer window: she comments on folder names instead of teasing you about yours.
  if (m === 'explorer') saidFolderLine = true
  explorerHwnd = 0
  perchHwnd = 0
  setMode(m)
}

export function currentMode(): AvatarMode {
  return mode
}

/** The user did something with Capri – reset boredom and bring her home. */
export function markInteraction(): void {
  lastInteraction = Date.now()
  boredAfter = randomBoredDelay()
  stopActivity()
  if (getMood().grudge) return // she stays put until you apologise
  if (mode !== 'home') void goHome()
}

/** After a blackout she just stands there, arms crossed. */
export function enterWait(): void {
  explorerHwnd = 0
  perchHwnd = 0
  setMode('wait')
}

/** Called when the user drags her somewhere: that becomes her new home, she stays. */
export function onDragged(): void {
  lastInteraction = Date.now()
  if (mode !== 'home') setMode('home')
}

export async function goHome(): Promise<void> {
  const wasHidden = mode === 'explorer' || !getWin('avatar')?.isVisible()
  setMode('home')
  explorerHwnd = 0
  perchHwnd = 0
  if (!getSettings().avatar.visible) return
  const home = avatarHome()
  if (wasHidden) {
    placeAvatar(home.x, home.y)
    setAvatarShown(true)
  } else await travelAvatar(home.x, home.y)
}

function dipRect(w: WinInfo): Electron.Rectangle {
  return screen.screenToDipRect(null, { x: w.x, y: w.y, width: w.w, height: w.h })
}

function isNormalWindow(w: WinInfo): boolean {
  if (w.minimized || /desktop capriai/i.test(w.title) || w.title === 'Program Manager') return false
  const r = dipRect(w)
  const d = screen.getDisplayMatching(r)
  const fullscreen = r.width >= d.bounds.width && r.height >= d.bounds.height
  return !fullscreen && r.width > 420 && r.height > 200
}

async function perchOnWindow(): Promise<boolean> {
  let wins: WinInfo[]
  try {
    wins = (await winHelper.call<WinInfo[]>('windows')) ?? []
  } catch {
    return false
  }
  const { h } = avatarSize()
  // Windows come in z-order; only the top few are likely to be visible.
  const candidates = wins.filter(isNormalWindow).slice(0, 4).filter((w) => dipRect(w).y > h * AVATAR_HIP_RATIO)
  if (!candidates.length) return false
  const target = candidates[Math.floor(Math.random() * candidates.length)]
  perchHwnd = target.hwnd
  perchOffset = 0.2 + Math.random() * 0.6
  setMode('perch')
  modeDuration = (1 + Math.random() * 3) * 60_000
  await moveToPerch(target)
  return true
}

async function moveToPerch(w: WinInfo): Promise<void> {
  const r = dipRect(w)
  const { w: aw, h } = avatarSize()
  await travelAvatar(r.x + r.width * perchOffset - aw / 2, r.y - h * AVATAR_HIP_RATIO)
}

async function wander(): Promise<void> {
  // Usually her own monitor; sometimes she glitches over to another one.
  const displays = screen.getAllDisplays()
  const home = screen.getDisplayNearestPoint(avatarHome())
  const d = displays.length > 1 && Math.random() < 0.3 ? displays[Math.floor(Math.random() * displays.length)] : home
  const wa = d.workArea
  const { w, h } = avatarSize()
  setMode('wander')
  modeDuration = (0.5 + Math.random()) * 60_000
  await travelAvatar(wa.x + Math.random() * (wa.width - w), wa.y + wa.height - h)
}

/**
 * Slip into your folders – only when a File Explorer window is actually open on screen; otherwise
 * she would just vanish with nowhere to show up.
 */
async function enterFolders(): Promise<boolean> {
  let wins: WinInfo[] = []
  try {
    wins = (await winHelper.call<WinInfo[]>('windows')) ?? []
  } catch {
    return false
  }
  if (!wins.some((w) => w.cls === EXPLORER_CLASS && !w.minimized)) return false
  setMode('explorer')
  explorerMissingSince = 0
  modeDuration = (5 + Math.random() * 10) * 60_000
  saidFolderLine = false
  // Glitch out on the spot (dissolve), then vanish – she never leaves the screen edge.
  send('avatar', 'avatar:dash', { dx: 0, dy: 0, ms: 260, teleport: true })
  await new Promise((r) => setTimeout(r, 280))
  setAvatarShown(false)
  return true
}

async function updateExplorer(): Promise<void> {
  let fg: WinInfo | null = null
  try {
    fg = await winHelper.call<WinInfo | null>('foreground', {}, 3000)
  } catch {
    return
  }
  if (mode !== 'explorer') return
  if (fg && fg.cls === EXPLORER_CLASS && !fg.minimized) {
    const r = dipRect(fg)
    const { w, h } = avatarSize()
    // Sit inside the window's bottom-right corner, above the status bar.
    const x = Math.round(r.x + r.width - w - 24)
    const y = Math.round(r.y + r.height - h - 26)
    const win = getWin('avatar')
    if (!win) return
    explorerMissingSince = 0
    if (!win.isVisible() || explorerHwnd !== fg.hwnd) {
      explorerHwnd = fg.hwnd
      placeAvatar(x, y)
      setAvatarShown(true)
      if (!saidFolderLine) {
        saidFolderLine = true
        setTimeout(() => send('avatar', 'avatar:say', FOLDER_LINES[Math.floor(Math.random() * FOLDER_LINES.length)]), 900)
      }
    } else {
      const b = avatarPosition()
      if (Math.abs(b.x - x) > 2 || Math.abs(b.y - y) > 2) placeAvatar(x, y)
    }
    explorerMissingSince = 0
  } else {
    if (getWin('avatar')?.isVisible()) setAvatarShown(false)
    // No Explorer in front for a while: she gets bored of hiding and comes back.
    explorerMissingSince ||= Date.now()
    if (Date.now() - explorerMissingSince > 25_000) void goHome()
  }
}

async function updatePerch(): Promise<void> {
  let wins: WinInfo[] = []
  try {
    wins = (await winHelper.call<WinInfo[]>('windows')) ?? []
  } catch {
    return
  }
  if (mode !== 'perch') return
  const w = wins.find((x) => x.hwnd === perchHwnd)
  if (!w || w.minimized) return void goHome()
  const r = dipRect(w)
  const { w: aw, h } = avatarSize()
  const want = { x: Math.round(r.x + r.width * perchOffset - aw / 2), y: Math.round(r.y - h * AVATAR_HIP_RATIO) }
  const b = avatarPosition()
  if (b && (Math.abs(b.x - want.x) > 3 || Math.abs(b.y - want.y) > 3)) {
    // Window moved: follow it (quick hop) – or go home if it went off-screen.
    if (want.y < screen.getDisplayMatching(r).bounds.y - h * 0.5) return void goHome()
    await travelAvatar(want.x, want.y)
  }
}

async function tick(): Promise<void> {
  const s = getSettings()
  const m = getMood()
  if (m.grudge || mode === 'wait') return
  // Away from the PC: her free-time activities own the avatar.
  if (await idleTick()) {
    if (mode === 'explorer') await updateExplorer()
    return
  }
  const blocked = isBusy() || overlayVisible() || m.meltdown || !s.avatar.visible

  if (mode === 'explorer') {
    if (!s.avatar.folderPlay || blocked || Date.now() - modeSince > modeDuration) return goHome()
    return updateExplorer()
  }
  if (mode === 'perch') {
    if (!s.avatar.roam || blocked || Date.now() - modeSince > modeDuration) return goHome()
    return updatePerch()
  }
  if (mode === 'wander') {
    if (blocked || Date.now() - modeSince > modeDuration) return goHome()
    return
  }

  // Home: is she bored yet?
  if (blocked || !s.avatar.roam) {
    if (blocked) lastInteraction = Math.max(lastInteraction, Date.now() - boredAfter + 30_000)
    return
  }
  if (Date.now() - lastInteraction < boredAfter) return
  lastInteraction = Date.now()
  boredAfter = randomBoredDelay()
  const roll = Math.random()
  if (s.avatar.folderPlay && roll < 0.35 && (await enterFolders())) return
  if (roll < 0.75 && (await perchOnWindow())) return
  return wander()
}

export function startRoaming(): void {
  setInterval(async () => {
    if (ticking) return
    ticking = true
    try {
      await tick()
    } catch (e) {
      console.warn('[roam]', e)
    } finally {
      ticking = false
    }
  }, 900)
}

/** For testing / tray: trigger a bored action right now. */
export async function doSomethingNow(kind?: 'perch' | 'wander' | 'folders'): Promise<void> {
  if (mode !== 'home') await goHome()
  if (kind === 'folders') {
    if (!(await enterFolders())) send('avatar', 'avatar:say', 'Otevři mi Průzkumníka, jinak nemám kam zalízt.')
    return
  }
  if (kind === 'wander') return wander()
  if (!(await perchOnWindow())) await wander()
}
