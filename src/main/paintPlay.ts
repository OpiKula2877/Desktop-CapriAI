// Capri paints a picture while you are away. She opens MS Paint on a blank canvas of her own and
// paints on a click-through layer lying exactly over Paint's canvas (glitchy pixels → painterly
// strokes → details), with her cursor following the brush. No real mouse input is ever sent.
// The result is saved to Pictures\CapriAI and opened in Paint for real.
//
// Templates: any pictures you put in Pictures\CapriAI\předlohy (or the folder set in Settings).
// Without templates she paints a procedural neon-city scene.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { app, desktopCapturer, nativeImage, screen } from 'electron'
import { localStamp } from '../shared/idle'
import type { PaintStart } from '../shared/types'
import { findWindow, type Activity } from './idlePlay'
import { setRoamMode } from './roam'
import { getSettings } from './settings'
import { winHelper, type WinInfo } from './winHelper'
import { avatarSize, closePaintLayer, flyCursor, getWin, openPaintLayer, send, travelAvatar } from './windows'

const CANVAS_W = 960
const CANVAS_H = 600
const PAINT_MS = 150_000
// Unique near-white so the canvas can be found in a screenshot of Paint's window.
const MARK = { r: 250, g: 250, b: 251 }
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])

let canvasDip: Electron.Rectangle | null = null
let finishPainting: ((png: Uint8Array) => void) | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function templatesDir(): string {
  return getSettings().idle.paintTemplates || join(app.getPath('pictures'), 'CapriAI', 'předlohy')
}

function pickTemplate(): Uint8Array | null {
  const dir = templatesDir()
  try {
    mkdirSync(dir, { recursive: true }) // so you can see where to put pictures
    const files = readdirSync(dir).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()))
    if (!files.length) return null
    return new Uint8Array(readFileSync(join(dir, files[Math.floor(Math.random() * files.length)])))
  } catch {
    return null
  }
}

function blankCanvasFile(): string {
  const px = Buffer.alloc(CANVAS_W * CANVAS_H * 4)
  for (let i = 0; i < px.length; i += 4) {
    px[i] = MARK.b // BGRA
    px[i + 1] = MARK.g
    px[i + 2] = MARK.r
    px[i + 3] = 255
  }
  const file = join(tmpdir(), `capri-platno-${Date.now()}.png`)
  writeFileSync(file, nativeImage.createFromBitmap(px, { width: CANVAS_W, height: CANVAS_H }).toPNG())
  return file
}

/** Find Paint's canvas (our marker colour) inside its window – screenshot of that area only. */
async function findCanvas(paint: WinInfo): Promise<Electron.Rectangle | null> {
  const winDip = screen.screenToDipRect(null, { x: paint.x, y: paint.y, width: paint.w, height: paint.h })
  const d = screen.getDisplayMatching(winDip)
  const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  const src = sources.find((s) => s.display_id === String(d.id)) ?? (sources.length === 1 ? sources[0] : undefined)
  if (!src) return null
  const img = src.thumbnail
  const { width, height } = img.getSize()
  const bmp = img.toBitmap()
  const origin = screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y })
  const x0 = Math.max(0, paint.x - origin.x)
  const y0 = Math.max(0, paint.y - origin.y)
  const x1 = Math.min(width, x0 + paint.w)
  const y1 = Math.min(height, y0 + paint.h)
  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  let hits = 0
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const o = (y * width + x) * 4
      if (bmp[o] === MARK.b && bmp[o + 1] === MARK.g && bmp[o + 2] === MARK.r) {
        hits++
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (hits < 2000) return null
  // Something (a topmost window) may cover part of the canvas. The width is the most reliable
  // edge; derive the height from the image's aspect ratio and work out which edge is the real one:
  // above a real top edge there is Paint's workspace background (same colour as left of the canvas).
  const w = maxX - minX + 2
  let top = minY
  let h = maxY - minY + 2
  const expectH = Math.round((w * CANVAS_H) / CANVAS_W)
  if (h < expectH * 0.95) {
    const px = (x: number, y: number) => {
      const o = (Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 4
      return [bmp[o], bmp[o + 1], bmp[o + 2]]
    }
    const bg = px(minX - 12, minY + 4)
    const above = px((minX + maxX) >> 1, minY - 6)
    const topIsReal = bg.every((v, i) => Math.abs(v - above[i]) < 12)
    if (!topIsReal) top = maxY + 2 - expectH
    h = expectH
  }
  return screen.screenToDipRect(null, { x: minX + origin.x, y: top + origin.y, width: w, height: h })
}

/** IPC from the paint layer: the brush is at (fx, fy) of the canvas. */
export function onPaintBrush(fx: number, fy: number): void {
  const r = canvasDip
  if (!r || !Number.isFinite(fx) || !Number.isFinite(fy)) return
  void flyCursor({ x: r.x + r.width * fx, y: r.y + r.height * fy }, '', false, 300)
}

/** IPC from the paint layer: finished PNG. */
export function onPaintDone(png: Uint8Array): void {
  finishPainting?.(png)
}

export async function runPaint(a: Activity): Promise<void> {
  const file = blankCanvasFile()
  const tag = file.split('\\').pop()!.replace(/\.png$/, '')
  try {
    spawn('mspaint.exe', [file], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
  } catch {
    return
  }
  let paintWin = await findWindow((w) => w.title.includes(tag), a)
  if (!paintWin || a.cancel) return
  await sleep(1500) // let Paint finish laying out
  paintWin = (await findWindow((w) => w.hwnd === paintWin!.hwnd, a, 3)) ?? paintWin
  const winDip = screen.screenToDipRect(null, { x: paintWin.x, y: paintWin.y, width: paintWin.w, height: paintWin.h })
  const rect =
    (await findCanvas(paintWin).catch(() => null)) ??
    // Fallback: centred in the window.
    { x: Math.round(winDip.x + (winDip.width - CANVAS_W * 0.6) / 2), y: Math.round(winDip.y + winDip.height * 0.22), width: Math.round(CANVAS_W * 0.6), height: Math.round(CANVAS_H * 0.6) }
  canvasDip = rect

  // Capri sits by the right edge of Paint, brush in hand.
  setRoamMode('paint')
  const { w, h } = avatarSize()
  await travelAvatar(winDip.x + winDip.width - w * 0.6, winDip.y + winDip.height - h)
  send('avatar', 'avatar:say', 'Neruš. Tvořím.')

  const layer = await openPaintLayer(rect)
  const done = new Promise<Uint8Array | null>((resolve) => {
    finishPainting = resolve
    setTimeout(() => resolve(null), PAINT_MS + 60_000)
  })
  const start: PaintStart = { width: CANVAS_W, height: CANVAS_H, durationMs: PAINT_MS, template: pickTemplate() }
  layer.webContents.send('paint:start', start)

  let hurried = false
  const watch = setInterval(() => {
    if (a.cancel && !hurried && !layer.isDestroyed()) {
      hurried = true
      layer.webContents.send('paint:finish')
    }
  }, 200)
  let png: Uint8Array | null = null
  try {
    png = await done
  } finally {
    clearInterval(watch)
    finishPainting = null
    canvasDip = null
  }

  await winHelper.call('close', { hwnd: paintWin.hwnd }).catch(() => {})
  if (png) {
    const outDir = join(app.getPath('pictures'), 'CapriAI')
    mkdirSync(outDir, { recursive: true })
    const stamp = localStamp()
    let out = join(outDir, `capri_${stamp}.png`)
    for (let i = 2; existsSync(out); i++) out = join(outDir, `capri_${stamp}_${i}.png`)
    writeFileSync(out, png)
    spawn('mspaint.exe', [out], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
    const name = out.split('\\').pop()!.replace(/\.png$/, '')
    await findWindow((w) => w.title.includes(name), { ...a, cancel: false }, 20)
    send('avatar', 'avatar:say', 'Hotovo. Masterpiece. Uložila jsem ti to do Obrázků → CapriAI.')
  }
  await sleep(300)
  closePaintLayer()
  getWin('avatar')?.moveTop()
}
