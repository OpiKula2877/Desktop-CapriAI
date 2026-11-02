import { join } from 'node:path'
import { BrowserWindow, desktopCapturer, screen, type BrowserWindowConstructorOptions } from 'electron'
import { clampInto, clampToDisplays, type Rect } from '../shared/geometry'
import type { EventChannel } from '../shared/ipc'
import { getSettings, updateSettings } from './settings'
import { resourcePath } from './paths'

export type PageName = 'overlay' | 'avatar' | 'settings' | 'meltdown' | 'cursor' | 'stage' | 'paint'

const wins: Partial<Record<PageName, BrowserWindow>> = {}

const OVERLAY_W = 780
const OVERLAY_H = 580
const AVATAR_W = 320
const AVATAR_H = 440

function baseOptions(extra: BrowserWindowConstructorOptions): BrowserWindowConstructorOptions {
  return {
    show: false,
    frame: false,
    icon: resourcePath('capri', 'capri_icon.png'),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    },
    ...extra
  }
}

function load(win: BrowserWindow, page: PageName): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(`${devUrl}/${page}.html`)
    win.webContents.on('console-message', (e) => console.log(`[${page}] ${e.message}`))
  } else void win.loadFile(join(__dirname, `../renderer/${page}.html`))
  // External links never open inside app windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void import('electron').then(({ shell }) => shell.openExternal(url))
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
}

export function getWin(page: PageName): BrowserWindow | undefined {
  const w = wins[page]
  return w && !w.isDestroyed() ? w : undefined
}

export function send(page: PageName, channel: EventChannel, ...args: unknown[]): void {
  getWin(page)?.webContents.send(channel, ...args)
}

export function broadcast(channel: EventChannel, ...args: unknown[]): void {
  for (const w of Object.values(wins)) if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
}

// ---------------- overlay ----------------

export function createOverlay(): BrowserWindow {
  const win = new BrowserWindow(
    baseOptions({
      width: OVERLAY_W,
      height: OVERLAY_H,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      hasShadow: false
    })
  )
  win.setAlwaysOnTop(true, 'floating')
  load(win, 'overlay')
  // Clicking anywhere outside the box closes it (Capri's own windows never take focus).
  win.on('blur', () => {
    if (overlayHeld || Date.now() - shownAt < 250 || capturing) return
    hideOverlay()
  })
  win.on('focus', () => (overlayHeld = false))
  wins.overlay = win
  return win
}

let hideTimer: NodeJS.Timeout | null = null
let shownAt = 0
let overlayHeld = false
let capturing = false

/** Keep the overlay open through the next focus loss (native file dialog). Released on refocus. */
export function holdOverlay(): void {
  overlayHeld = true
}

export function showOverlay(): void {
  const win = getWin('overlay')
  if (!win) return
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = d.workArea
  win.setBounds({ x: Math.round(wa.x + (wa.width - OVERLAY_W) / 2), y: wa.y + 8, width: OVERLAY_W, height: OVERLAY_H })
  win.setOpacity(1)
  shownAt = Date.now()
  win.show()
  win.focus()
  send('overlay', 'overlay:shown')
  send('avatar', 'avatar:glitch')
}

export function hideOverlay(): void {
  const win = getWin('overlay')
  if (!win || !win.isVisible() || hideTimer) return
  send('overlay', 'overlay:hiding')
  hideTimer = setTimeout(() => {
    hideTimer = null
    win.hide()
  }, 200)
}

export function toggleOverlay(): void {
  const win = getWin('overlay')
  if (!win) return
  if (win.isVisible() && win.isFocused() && !hideTimer) hideOverlay()
  else showOverlay()
}

export function overlayVisible(): boolean {
  return Boolean(getWin('overlay')?.isVisible())
}

// ---------------- avatar ----------------

/**
 * The avatar window always uses this exact size. On Windows with display scaling (125 % ...)
 * feeding getSize()/getBounds() back into setBounds() drifts by a pixel each call, which made
 * Capri grow while being dragged - so the size is never read back from the window.
 */
export function avatarSize(): { w: number; h: number } {
  const scale = Math.min(1.4, Math.max(0.45, getSettings().avatar.scale || 0.7))
  return { w: Math.round(AVATAR_W * scale), h: Math.round(AVATAR_H * scale) }
}

let avatarPos = { x: 0, y: 0 }

export function displayBounds(): Rect[] {
  return screen.getAllDisplays().map((d) => d.bounds)
}

/**
 * Single place that positions the avatar window (fixed size, integer coordinates). The window is
 * always kept completely on one monitor – on the one under `anchor` (the mouse while dragging),
 * otherwise the one under her centre.
 */
export function placeAvatar(x: number, y: number, anchor?: { x: number; y: number }): void {
  const win = getWin('avatar')
  const { w, h } = avatarSize()
  const c = clampToDisplays(x, y, w, h, displayBounds(), anchor)
  avatarPos = { x: c.x, y: c.y }
  if (!win) return
  win.setBounds({ x: avatarPos.x, y: avatarPos.y, width: w, height: h })
}

export function avatarPosition(): { x: number; y: number } {
  return { ...avatarPos }
}

export function createAvatar(): BrowserWindow {
  const { w, h } = avatarSize()
  const { x, y } = avatarHome()
  avatarPos = { x, y }

  const win = new BrowserWindow(
    baseOptions({
      x,
      y,
      width: w,
      height: h,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      fullscreenable: false
    })
  )
  win.setAlwaysOnTop(true, 'floating')
  win.setIgnoreMouseEvents(true, { forward: true })
  load(win, 'avatar')
  // Transparent windows don't always report ready-to-show; whichever comes first shows her.
  const showOnStart = () => {
    if (win.isDestroyed() || win.isVisible() || !getSettings().avatar.visible) return
    win.showInactive()
    win.moveTop()
    const k = getSettings().hotkeys
    setTimeout(() => send('avatar', 'avatar:say', `Jsem tu. ${k.toggleOverlay} = chat, ${k.summonAvatar} = schovat / přivolat mě.`), 1600)
  }
  win.once('ready-to-show', showOnStart)
  win.webContents.once('did-finish-load', () => setTimeout(showOnStart, 1200))
  wins.avatar = win
  return win
}

/** Apply a new size from settings, keeping her feet where they were. */
export function resizeAvatar(prevScale: number): void {
  const k = Math.min(1.4, Math.max(0.45, prevScale || 0.7))
  const prevW = Math.round(AVATAR_W * k)
  const prevH = Math.round(AVATAR_H * k)
  const { w, h } = avatarSize()
  placeAvatar(avatarPos.x + (prevW - w) / 2, avatarPos.y + (prevH - h))
}

let savePosTimer: NodeJS.Timeout | null = null

/** User drag: move and remember as her home. */
export function moveAvatar(x: number, y: number): void {
  placeAvatar(x, y, screen.getCursorScreenPoint())
  if (savePosTimer) clearTimeout(savePosTimer)
  savePosTimer = setTimeout(() => {
    const { w, h } = avatarSize()
    updateSettings({ avatar: { x: avatarPos.x + Math.round(w / 2), y: avatarPos.y + h } })
  }, 500)
}

export function setAvatarVisible(visible: boolean): void {
  const win = getWin('avatar')
  if (!win) return
  if (visible) {
    win.showInactive()
    send('avatar', 'avatar:glitch')
  } else win.hide()
}

/** Hips height as a fraction of the avatar window height - used to sit her on window edges. */
export const AVATAR_HIP_RATIO = 0.7

/** Window top-left of her home spot: the saved feet anchor, or bottom-right above the taskbar. */
export function avatarHome(): { x: number; y: number } {
  const s = getSettings().avatar
  const { w, h } = avatarSize()
  const wa = screen.getPrimaryDisplay().workArea
  let ax = s.x ?? wa.x + wa.width - w / 2 - 16
  let ay = s.y ?? wa.y + wa.height
  // Saved spot on a monitor that is gone: back to the primary one.
  const onScreen = screen.getAllDisplays().some((d) => {
    const b = d.bounds
    return ax >= b.x && ax <= b.x + b.width && ay - h / 2 >= b.y && ay - h / 2 <= b.y + b.height
  })
  if (!onScreen) {
    ax = wa.x + wa.width - w / 2 - 16
    ay = wa.y + wa.height
  }
  // Fully inside the work area of that monitor (not over the taskbar).
  const d = screen.getDisplayNearestPoint({ x: Math.round(ax), y: Math.round(ay - h / 2) })
  const c = clampInto(ax - w / 2, ay - h, w, h, d.workArea)
  return { x: c.x, y: c.y }
}

let travelTimer: NodeJS.Timeout | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Move the avatar window to (x, y) with a visible dash (short hops) or a glitch teleport
 * (long jumps). Does not change her saved home position.
 */
export async function travelAvatar(x: number, y: number, opts: { teleport?: boolean } = {}): Promise<void> {
  const win = getWin('avatar')
  if (!win) return
  if (travelTimer) clearInterval(travelTimer)
  const from = avatarPosition()
  const { w, h } = avatarSize()
  const to = clampToDisplays(x, y, w, h, displayBounds())
  x = to.x
  y = to.y
  const dx = x - from.x
  const dy = y - from.y
  const dist = Math.hypot(dx, dy)
  if (dist < 2) return
  // Another monitor is always a glitch jump – never slide across the gap between screens.
  const fromDisplay = clampToDisplays(from.x, from.y, w, h, displayBounds()).display
  const otherScreen = fromDisplay.x !== to.display.x || fromDisplay.y !== to.display.y
  const teleport = otherScreen || (opts.teleport ?? dist > 900)
  const ms = teleport ? 260 : Math.round(Math.min(560, Math.max(240, dist * 0.55)))
  send('avatar', 'avatar:dash', { dx, dy, ms, teleport })
  if (teleport) {
    await sleep(ms)
    if (!win.isDestroyed()) placeAvatar(x, y)
    return
  }
  const start = Date.now()
  await new Promise<void>((resolve) => {
    travelTimer = setInterval(() => {
      if (win.isDestroyed()) return resolve()
      const t = Math.min(1, (Date.now() - start) / ms)
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
      placeAvatar(from.x + dx * e, from.y + dy * e)
      if (t >= 1) {
        clearInterval(travelTimer!)
        travelTimer = null
        resolve()
      }
    }, 15)
  })
}

/** Show / hide without touching the user's "visible" setting (used while she hides in folders). */
export function setAvatarShown(shown: boolean): void {
  const win = getWin('avatar')
  if (!win) return
  if (shown && !win.isVisible()) {
    win.showInactive()
    win.moveTop()
    send('avatar', 'avatar:glitch')
  } else if (!shown && win.isVisible()) win.hide()
}

/** Screen point (DIP) of Capri's "hand" – where her cursor starts its flight. */
export function avatarAnchor(): { x: number; y: number } {
  const win = getWin('avatar')
  if (!win || !win.isVisible()) {
    const p = screen.getCursorScreenPoint()
    return { x: p.x, y: p.y }
  }
  const { w, h } = avatarSize()
  return { x: avatarPos.x + w * 0.35, y: avatarPos.y + h * 0.55 }
}

// ---------------- cursor ----------------

export function createCursorWindow(): BrowserWindow {
  const d = screen.getPrimaryDisplay()
  const win = new BrowserWindow(
    baseOptions({
      ...d.bounds,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      fullscreenable: false,
      enableLargerThanScreen: true
    })
  )
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)
  load(win, 'cursor')
  wins.cursor = win
  return win
}

let cursorHideTimer: NodeJS.Timeout | null = null
let lastCursor: { x: number; y: number } | null = null

/** Fly Capri's cursor from her last position (or her avatar) to a DIP point. Resolves on arrival. */
export async function flyCursor(to: { x: number; y: number }, label: string, click = false, duration = 750): Promise<void> {
  const win = getWin('cursor')
  if (!win) return
  const d = screen.getDisplayNearestPoint({ x: Math.round(to.x), y: Math.round(to.y) })
  const from = lastCursor ?? avatarAnchor()
  if (cursorHideTimer) clearTimeout(cursorHideTimer)
  // Span the window over the union of the source and target displays.
  const src = screen.getDisplayNearestPoint({ x: Math.round(from.x), y: Math.round(from.y) })
  const minX = Math.min(d.bounds.x, src.bounds.x)
  const minY = Math.min(d.bounds.y, src.bounds.y)
  const maxX = Math.max(d.bounds.x + d.bounds.width, src.bounds.x + src.bounds.width)
  const maxY = Math.max(d.bounds.y + d.bounds.height, src.bounds.y + src.bounds.height)
  win.setBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY })
  win.showInactive()
  // All always-on-top windows share one band on Windows; raise the cursor above the overlay.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.moveTop()
  win.webContents.send('cursor:goto', {
    from: { x: from.x - minX, y: from.y - minY },
    to: { x: to.x - minX, y: to.y - minY },
    label,
    click,
    duration
  })
  lastCursor = to
  await new Promise((r) => setTimeout(r, duration + (click ? 220 : 60)))
  cursorHideTimer = setTimeout(() => {
    win.webContents.send('cursor:hide')
    lastCursor = null
    setTimeout(() => win.hide(), 400)
  }, 2500)
}

// ---------------- stage (one full-screen effect layer per monitor) ----------------

interface Stage {
  win: BrowserWindow
  display: Electron.Display
  ready: Promise<void>
  hideTimer: NodeJS.Timeout | null
}
const stages = new Map<number, Stage>()

function stageFor(display: Electron.Display): Stage {
  const have = stages.get(display.id)
  if (have && !have.win.isDestroyed()) {
    if (JSON.stringify(have.display.bounds) !== JSON.stringify(display.bounds)) {
      have.win.setBounds(display.bounds)
      have.display = display
    }
    return have
  }
  const win = new BrowserWindow(
    baseOptions({
      ...display.bounds,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      fullscreenable: false,
      enableLargerThanScreen: true
    })
  )
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)
  load(win, 'stage')
  const ready = new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))
  const st: Stage = { win, display, ready, hideTimer: null }
  stages.set(display.id, st)
  return st
}

/** Show a stage window (without focus) and hide it again after `idleMs` without new effects. */
async function wakeStage(st: Stage, idleMs = 2000): Promise<void> {
  await st.ready
  if (st.win.isDestroyed()) return
  if (st.hideTimer) clearTimeout(st.hideTimer)
  if (!st.win.isVisible()) {
    st.win.setBounds(st.display.bounds)
    st.win.showInactive()
    // Capri herself stays above her own trail.
    if (!blackoutActive) getWin('avatar')?.moveTop()
  }
  if (idleMs > 0) {
    st.hideTimer = setTimeout(() => {
      if (!st.win.isDestroyed() && !blackoutActive) st.win.hide()
    }, idleMs)
  }
}

/** Strobe trail frame: `img` is a webp of the avatar canvas at her current window position. */
export function addTrailGhost(img: Uint8Array, tint: number): void {
  const { w, h } = avatarSize()
  const p = avatarPosition()
  const display = screen.getDisplayNearestPoint({ x: p.x + Math.round(w / 2), y: p.y + Math.round(h / 2) })
  const st = stageFor(display)
  void wakeStage(st).then(() => {
    st.win.webContents.send('stage:ghost', {
      img,
      x: p.x - display.bounds.x,
      y: p.y - display.bounds.y,
      w,
      h,
      tint
    })
  })
}

let blackoutActive = false

/** All monitors: run one blackout phase. Windows block the mouse while it is dark. */
export async function stageBlackout(phase: 'black' | 'rebuild' | 'fade' | 'end', images?: Map<number, Uint8Array>, ms?: number): Promise<void> {
  blackoutActive = phase !== 'end'
  await Promise.all(
    screen.getAllDisplays().map(async (d) => {
      const st = stageFor(d)
      await wakeStage(st, phase === 'end' ? 300 : 0)
      if (st.win.isDestroyed()) return
      st.win.setIgnoreMouseEvents(phase === 'fade' || phase === 'end')
      if (phase === 'black') st.win.moveTop()
      st.win.webContents.send('stage:blackout', { phase, img: images?.get(d.id), ms })
    })
  )
}

/** JPEG of every monitor at full resolution (kept in memory only, never written to disk). */
export async function captureAllDisplays(): Promise<Map<number, Uint8Array>> {
  const displays = screen.getAllDisplays()
  const maxW = Math.max(...displays.map((d) => d.size.width * d.scaleFactor))
  const maxH = Math.max(...displays.map((d) => d.size.height * d.scaleFactor))
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } })
  const out = new Map<number, Uint8Array>()
  for (const d of displays) {
    const src = sources.find((s) => s.display_id === String(d.id)) ?? (displays.length === 1 ? sources[0] : undefined)
    if (src) out.set(d.id, new Uint8Array(src.thumbnail.toJPEG(90)))
  }
  return out
}

// ---------------- paint layer (lies exactly over MS Paint's canvas) ----------------

export async function openPaintLayer(rect: Electron.Rectangle): Promise<BrowserWindow> {
  getWin('paint')?.destroy()
  const win = new BrowserWindow(
    baseOptions({
      ...rect,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      fullscreenable: false
    })
  )
  win.setAlwaysOnTop(true, 'floating')
  win.setIgnoreMouseEvents(true)
  load(win, 'paint')
  wins.paint = win
  await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))
  win.showInactive()
  getWin('avatar')?.moveTop()
  return win
}

export function closePaintLayer(): void {
  getWin('paint')?.destroy()
}

// ---------------- settings ----------------

export function openSettingsWindow(): void {
  const existing = getWin('settings')
  if (existing) {
    existing.show()
    existing.focus()
    return
  }
  const win = new BrowserWindow(
    baseOptions({
      width: 1000,
      height: 700,
      minWidth: 820,
      minHeight: 560,
      backgroundColor: '#0b0305',
      title: 'Desktop CapriAI – Nastavení'
    })
  )
  load(win, 'settings')
  win.once('ready-to-show', () => win.show())
  wins.settings = win
}

// ---------------- meltdown ----------------

let meltdownClosable = false

export function openMeltdownWindow(): void {
  if (getWin('meltdown')) return
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const w = 940
  const h = 600
  meltdownClosable = false
  const win = new BrowserWindow(
    baseOptions({
      x: Math.round(d.workArea.x + (d.workArea.width - w) / 2),
      y: Math.round(d.workArea.y + (d.workArea.height - h) / 2),
      width: w,
      height: h,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: false,
      alwaysOnTop: true,
      title: 'CAPRI://MELTDOWN'
    })
  )
  win.setAlwaysOnTop(true, 'screen-saver')
  win.on('close', (e) => {
    if (!meltdownClosable) e.preventDefault()
  })
  load(win, 'meltdown')
  win.once('ready-to-show', () => {
    win.show()
    win.moveTop()
    win.focus()
  })
  wins.meltdown = win
}

export function closeMeltdownWindow(): void {
  const win = getWin('meltdown')
  if (!win) return
  meltdownClosable = true
  win.close()
}

// ---------------- screen capture ----------------

/** Capture the display under the mouse as JPEG, briefly hiding Capri's own windows. */
export async function captureScreen(maxWidth = 1568): Promise<{ mime: string; data: string; width: number; height: number }> {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const hidden: BrowserWindow[] = []
  capturing = true
  const candidates = [...(['overlay', 'avatar', 'cursor'] as PageName[]).map(getWin), ...[...stages.values()].map((s) => s.win)]
  for (const w of candidates) {
    if (w && !w.isDestroyed() && w.isVisible()) {
      w.setOpacity(0)
      hidden.push(w)
    }
  }
  try {
    await new Promise((r) => setTimeout(r, 160))
    const scale = Math.min(1, maxWidth / (d.size.width * d.scaleFactor))
    const size = {
      width: Math.round(d.size.width * d.scaleFactor * scale),
      height: Math.round(d.size.height * d.scaleFactor * scale)
    }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0]
    if (!src) throw new Error('Nepodařilo se zachytit obrazovku.')
    const img = src.thumbnail
    const { width, height } = img.getSize()
    return { mime: 'image/jpeg', data: img.toJPEG(82).toString('base64'), width, height }
  } finally {
    for (const w of hidden) if (!w.isDestroyed()) w.setOpacity(1)
    capturing = false
  }
}
