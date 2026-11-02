// Full-screen, click-through effect layer – one per monitor. Draws:
//  - the strobe trail Capri leaves when she is yanked or dashes: frozen copies of her body
//    ("1 FPS" look) tinted green / violet with lightning arcing between them,
//  - the blackout prank: black screens, then the desktop rebuilds block by block from the centre.
// Pure visuals: this page has no file-system or process access.
import { blockOrder } from '@shared/geometry'
import type { StageBlackout, StageGhost } from '@shared/types'
import { api } from '../shared/api'
import { jagged, strokePath } from '../avatar/fx'
import './stage.css'

const canvas = document.createElement('canvas')
canvas.id = 'cv'
document.getElementById('root')!.appendChild(canvas)
const g = canvas.getContext('2d')!
let W = 0
let H = 0

function resize(): void {
  const pr = window.devicePixelRatio || 1
  W = window.innerWidth
  H = window.innerHeight
  canvas.width = Math.round(W * pr)
  canvas.height = Math.round(H * pr)
  g.setTransform(pr, 0, 0, pr, 0, 0)
}
window.addEventListener('resize', resize)
resize()

// ---------------- strobe trail ----------------
const TINTS = [null, '#19f07a', '#9a5cf0'] as const
const GHOST_LIFE = 1100
const MAX_GHOSTS = 14

interface Ghost {
  img: HTMLCanvasElement
  x: number
  y: number
  w: number
  h: number
  born: number
  bolt: [number, number][] | null
  boltColor: string
}
let ghosts: Ghost[] = []

async function addGhost(gh: StageGhost): Promise<void> {
  const bmp = await createImageBitmap(new Blob([gh.img as BlobPart], { type: 'image/webp' }))
  const img = document.createElement('canvas')
  img.width = bmp.width
  img.height = bmp.height
  const c = img.getContext('2d')!
  c.drawImage(bmp, 0, 0)
  bmp.close()
  const tint = TINTS[gh.tint % TINTS.length]
  if (tint) {
    c.globalCompositeOperation = 'source-atop'
    c.globalAlpha = 0.86
    c.fillStyle = tint
    c.fillRect(0, 0, img.width, img.height)
  }
  const now = performance.now()
  const prev = ghosts[ghosts.length - 1]
  let bolt: [number, number][] | null = null
  // Lightning arcs between consecutive frames of the same yank.
  if (prev && now - prev.born < 260) {
    bolt = jagged(prev.x + prev.w / 2, prev.y + prev.h * 0.55, gh.x + gh.w / 2, gh.y + gh.h * 0.55, 8)
  }
  ghosts.push({ img, x: gh.x, y: gh.y, w: gh.w, h: gh.h, born: now, bolt, boltColor: tint ?? '#ff1e50' })
  if (ghosts.length > MAX_GHOSTS) ghosts = ghosts.slice(-MAX_GHOSTS)
  wake()
}

function drawGhosts(now: number): void {
  ghosts = ghosts.filter((gh) => now - gh.born < GHOST_LIFE)
  for (const gh of ghosts) {
    const k = 1 - (now - gh.born) / GHOST_LIFE
    // Frozen frame that flickers like a dropped-frame hologram.
    const flicker = Math.random() < 0.18 ? 0.25 : 1
    g.globalAlpha = 0.85 * Math.pow(k, 0.6) * flicker
    const jx = Math.random() < 0.1 ? (Math.random() - 0.5) * 10 : 0
    g.drawImage(gh.img, gh.x + jx, gh.y, gh.w, gh.h)
    if (gh.bolt && now - gh.born < 320) {
      g.globalAlpha = (Math.random() < 0.3 ? 0.35 : 1) * k
      g.shadowColor = gh.boltColor
      g.shadowBlur = 14
      g.strokeStyle = gh.boltColor
      g.lineWidth = 2.5
      strokePath(g, gh.bolt)
      g.shadowBlur = 0
      g.strokeStyle = '#ffffff'
      g.lineWidth = 1
      strokePath(g, gh.bolt)
    }
  }
  g.globalAlpha = 1
  g.shadowBlur = 0
}

// ---------------- blackout ----------------
interface Rebuild {
  img: ImageBitmap
  start: number
  ms: number
  cols: number
  rows: number
  bs: number
  order: number[]
  revealAt: Float32Array // ms offset per block index
}
let blackout: 'off' | 'black' | 'rebuild' | 'fade' = 'off'
let rebuild: Rebuild | null = null
let fade = { start: 0, ms: 600 }

async function onBlackout(b: StageBlackout): Promise<void> {
  if (b.phase === 'black') {
    blackout = 'black'
    ghosts = []
    rebuild?.img.close()
    rebuild = null
    canvas.style.opacity = '1'
    document.body.classList.add('blackout')
  } else if (b.phase === 'rebuild' && b.img) {
    const img = await createImageBitmap(new Blob([b.img as BlobPart], { type: 'image/jpeg' }))
    const bs = Math.max(28, Math.round(Math.min(W, H) / 18))
    const cols = Math.ceil(W / bs)
    const rows = Math.ceil(H / bs)
    const order = blockOrder(cols, rows)
    const revealAt = new Float32Array(cols * rows)
    const ms = b.ms ?? 2600
    // Ease-in: a few blocks first, then the picture floods outward.
    order.forEach((idx, n) => (revealAt[idx] = Math.pow(n / order.length, 0.7) * ms * 0.9))
    rebuild = { img, start: performance.now(), ms, cols, rows, bs, order, revealAt }
    blackout = 'rebuild'
  } else if (b.phase === 'fade') {
    blackout = 'fade'
    fade = { start: performance.now(), ms: b.ms ?? 600 }
  } else if (b.phase === 'end') {
    blackout = 'off'
    rebuild?.img.close()
    rebuild = null
    canvas.style.opacity = '1'
    document.body.classList.remove('blackout')
  }
  wake()
}

function drawRebuild(now: number): void {
  g.fillStyle = '#000'
  g.fillRect(0, 0, W, H)
  const r = rebuild
  if (!r) return
  const t = now - r.start
  const sx = r.img.width / W
  const sy = r.img.height / H
  for (let i = 0; i < r.revealAt.length; i++) {
    const at = r.revealAt[i]
    if (t < at) continue
    const c = i % r.cols
    const row = Math.floor(i / r.cols)
    const x = c * r.bs
    const y = row * r.bs
    const age = t - at
    if (age < 140) {
      // Fresh block: channel-split, offset, sometimes inverted – it "glitches in".
      const off = (1 - age / 140) * r.bs * 0.4 * (Math.random() < 0.5 ? -1 : 1)
      g.drawImage(r.img, x * sx, y * sy, r.bs * sx, r.bs * sy, x + off, y, r.bs, r.bs)
      g.globalCompositeOperation = Math.random() < 0.25 ? 'difference' : 'lighter'
      g.fillStyle = Math.random() < 0.5 ? 'rgba(255,30,80,0.55)' : 'rgba(25,240,122,0.45)'
      g.fillRect(x - off * 0.5, y, r.bs, r.bs)
      g.globalCompositeOperation = 'source-over'
    } else if (Math.random() < 0.004) {
      // Settled blocks still flicker now and then.
      g.fillStyle = Math.random() < 0.5 ? '#000' : '#ff1e50'
      g.fillRect(x, y, r.bs, r.bs)
    } else {
      g.drawImage(r.img, x * sx, y * sy, r.bs * sx, r.bs * sy, x, y, r.bs, r.bs)
    }
  }
  // Occasional horizontal slice tear across the rebuilt picture.
  if (t < r.ms && Math.random() < 0.12) {
    const y = Math.random() * H
    const h = 4 + Math.random() * 40
    const shift = (Math.random() - 0.5) * 80
    g.drawImage(canvas, 0, y * (canvas.height / H), canvas.width, h * (canvas.height / H), shift, y, W, h)
  }
}

// ---------------- loop ----------------
let running = false
function wake(): void {
  if (running) return
  running = true
  requestAnimationFrame(loop)
}

function loop(): void {
  const now = performance.now()
  g.clearRect(0, 0, W, H)
  if (blackout === 'black') {
    g.fillStyle = '#000'
    g.fillRect(0, 0, W, H)
  } else if (blackout === 'rebuild' || blackout === 'fade') {
    drawRebuild(now)
    if (blackout === 'fade') {
      const k = Math.min(1, (now - fade.start) / fade.ms)
      canvas.style.opacity = String(1 - k)
    }
  } else drawGhosts(now)

  if (blackout !== 'off' || ghosts.length) requestAnimationFrame(loop)
  else running = false
}

api.on('stage:ghost', (gh: StageGhost) => void addGhost(gh))
api.on('stage:blackout', (b: StageBlackout) => void onBlackout(b))
