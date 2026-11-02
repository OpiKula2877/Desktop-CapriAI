// Capri's painting engine: paints a template the way a glitchy AI would.
// The stages run on a virtual clock so finishFast() can compress whatever is left:
// quantized pixel dots, Hertzmann-style painterly strokes coarse-to-fine, then a detail pass.
// The painting lives on an offscreen layer (what toBlob exports); scanlines, RGB splits,
// glyphs and the HUD are drawn only onto the visible canvas, so the result stays clean.

export interface PainterOptions {
  durationMs: number
  seed?: number
  onBrush?: (x: number, y: number) => void
}

type RGB = [number, number, number]
type Pt = [number, number]

const GREEN = '#19f07a'
const RED = '#ff1e50'
const FONT = '"Share Tech Mono", Consolas, monospace'
const GLYPHS = [
  '0xC4PR1', 'PIXEL//SYNC', 'NEURAL.MAP', 'EDGE//LOCK', 'MEDIAN.CUT', 'RGB>>LAB', 'VEC.FIELD',
  'HEURISTIC++', 'DREAM.EXE', 'KERNEL//OK', 'GRAD.NORM', 'C4PR1::INK', 'NO.UNDO', 'ENGRAM//ART'
]
const SCRAMBLE = '01#$%&@<>/\\ABCDEFX'

const DOT_SIZES = [24, 12, 6]
const BRUSHES = [18, 8, 3]
const THRESHOLDS = [0, 15, 12] // mean RGB error a cell needs before a stroke goes there; 0 = paint everything
const MAX_LEN = [14, 11, 7]
const MIN_LEN = [3, 2, 1]
const ALPHA = [0.96, 0.9, 0.85]
// Share of durationMs per phase, in phase order (intro, 3x dots, flicker, 3x (strokes, flicker), detail, outro).
const WEIGHTS = { intro: 2, dots: [5, 6, 9], flick: 0.7, strokes: [17, 20, 26], detail: 10, outro: 2.4 }

interface Phase {
  label: string
  weight: number
  glitch: number // RGB/slice flashes per second
  scan: 'loop' | 'sweep' | null
  glyphs: number // ms between data glyphs, 0 = none
  enter: () => number // heavy prep, runs when the phase starts; returns its unit count
  unit: (i: number) => Pt | null
  t0: number
  t1: number
}

interface Layer {
  bw: number
  ref: Uint8ClampedArray
  lum: Float32Array
  snap: Uint8ClampedArray
  order: Int32Array
}

interface Detail {
  order: Int32Array
  lights: Set<number>
  lum: Float32Array
}

interface Flash { kind: 'slice' | 'rgb'; born: number; life: number; bands: number[] }
interface Glyph { text: string; x: number; y: number; color: string; born: number; life: number }
interface Trail { pts: number[]; born: number }
interface Blip { x: number; y: number; s: number; born: number }

export class Painter {
  private readonly w: number
  private readonly h: number
  private readonly sc: number
  private readonly view: CanvasRenderingContext2D
  private readonly paint: HTMLCanvasElement
  private readonly pctx: CanvasRenderingContext2D
  private readonly refCanvas: HTMLCanvasElement
  private refData: Uint8ClampedArray = new Uint8ClampedArray(0)
  private palette: RGB[] = []
  private readonly rng: () => number
  private readonly fx: () => number
  private readonly phases: Phase[] = []
  private readonly end: number

  private vt = 0
  private speed = 1
  private cap = 400
  private last = -1
  private now = 0
  private startTs = 0
  private pi = 0
  private entered = false
  private count = 0
  private drawn = 0
  private finished = false
  private done: Promise<void> | null = null
  private resolve: () => void = () => {}

  private layer: Layer | null = null
  private detail: Detail | null = null
  // Reference-only prep (blurs, edge plan) runs one job per frame during the dot stage.
  private jobs: (() => void)[] = []
  private pre: ({ ref: Uint8ClampedArray; lum: Float32Array } | undefined)[] = []
  private detailPlan: Detail | null = null
  private readonly seed: number
  private markers: number[] = []
  private brush: Pt | null = null
  private brushSize = 24
  private lastPts: number[] | null = null
  private flashes: Flash[] = []
  private glyphs: Glyph[] = []
  private trails: Trail[] = []
  private blips: Blip[] = []
  private nextGlyph = 0
  private tint: [HTMLCanvasElement, HTMLCanvasElement] | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly source: CanvasImageSource & { width: number; height: number },
    private readonly opts: PainterOptions
  ) {
    this.w = canvas.width
    this.h = canvas.height
    this.sc = Math.min(1.8, Math.max(0.7, Math.sqrt(this.w * this.h) / 900))
    this.view = ctx2d(canvas)
    this.paint = makeCanvas(this.w, this.h, canvas)
    this.pctx = ctx2d(this.paint)
    this.refCanvas = makeCanvas(this.w, this.h, canvas)
    const seed = opts.seed ?? (Math.random() * 2 ** 32) >>> 0
    this.seed = seed
    this.rng = mulberry32(seed)
    this.fx = mulberry32(seed ^ 0x9e3779b9)
    this.buildPhases()
    const total = this.phases.reduce((s, p) => s + p.weight, 0)
    const dur = Math.max(1000, opts.durationMs || 150_000)
    let acc = 0
    for (const p of this.phases) {
      p.t0 = (acc / total) * dur
      acc += p.weight
      p.t1 = (acc / total) * dur
    }
    this.end = dur
  }

  start(): Promise<void> {
    if (!this.done) {
      this.done = new Promise((res) => {
        this.resolve = res
        requestAnimationFrame(this.frame)
      })
    }
    return this.done
  }

  finishFast(ms = 2500): void {
    const left = this.end - this.vt
    if (left > 0) this.speed = Math.max(this.speed, left / Math.max(16, ms))
    else this.speed = Math.max(this.speed, 2)
  }

  toBlob(): Promise<Blob> {
    return new Promise((res, rej) =>
      this.paint.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png')
    )
  }

  // ---------------------------------------------------------------- phases

  private buildPhases(): void {
    const add = (p: Omit<Phase, 't0' | 't1'>): void => {
      this.phases.push({ ...p, t0: 0, t1: 0 })
    }
    add({
      label: 'INIT//WAKE', weight: WEIGHTS.intro, glitch: 3, scan: 'sweep', glyphs: 160,
      enter: () => {
        this.prepareReference()
        this.jobs = [
          ...BRUSHES.map((_, k) => () => { this.pre[k] = this.reference(k) }),
          () => { this.detailPlan = this.planDetail() }
        ]
        this.say('0xC4PR1 // WAKE', RED, this.w * 0.5 - 50 * this.sc, this.h * 0.5)
        return 0
      },
      unit: () => null
    })
    DOT_SIZES.forEach((s, k) => {
      let order: Int32Array = new Int32Array(0)
      let colors: Uint8Array = new Uint8Array(0)
      let cols = 0
      add({
        label: `SAMPLE ${s}PX`, weight: WEIGHTS.dots[k], glitch: 0.6, scan: 'loop', glyphs: 420,
        enter: () => {
          ;({ order, colors, cols } = this.planDots(s))
          this.brushSize = s
          return order.length
        },
        unit: (i) => this.dot(order[i], cols, s, colors)
      })
    })
    BRUSHES.forEach((b, k) => {
      add(this.flicker(`RECOMPUTE//L${k + 1}`, () => {
        this.layer = this.analyze(k)
        this.markers = sample(this.layer.order, 280, this.fx)
      }))
      add({
        label: `BRUSH ${b}PX`, weight: WEIGHTS.strokes[k], glitch: 0.2, scan: null, glyphs: 650,
        enter: () => {
          this.markers = []
          this.brushSize = this.layer!.bw
          return this.layer!.order.length
        },
        unit: (i) => this.stroke(this.layer!, this.layer!.order[i], k)
      })
    })
    add(this.flicker('EDGE//SCAN', () => {
      this.layer = null
      this.detail = this.detailPlan ?? this.planDetail()
      this.detailPlan = null
      this.markers = sample(this.detail.order, 280, this.fx)
    }))
    add({
      label: 'DETAIL//ACCENT', weight: WEIGHTS.detail, glitch: 0.15, scan: null, glyphs: 700,
      enter: () => {
        this.markers = []
        this.brushSize = 8 * this.sc
        return this.detail!.order.length
      },
      unit: (i) => this.accent(this.detail!.order[i])
    })
    add({
      label: 'COMMIT', weight: WEIGHTS.outro, glitch: 1.2, scan: 'sweep', glyphs: 0,
      enter: () => {
        this.detail = null
        this.underlay()
        this.say('RENDER//COMPLETE', GREEN, this.w * 0.5 - 60 * this.sc, this.h * 0.5)
        return 0
      },
      unit: () => null
    })
  }

  private flicker(label: string, prep: () => void): Omit<Phase, 't0' | 't1'> {
    return {
      label, weight: WEIGHTS.flick, glitch: 9, scan: 'sweep', glyphs: 110,
      enter: () => {
        prep()
        this.flash(true)
        return 0
      },
      unit: () => null
    }
  }

  // ---------------------------------------------------------------- loop

  private frame = (ts: number): void => {
    if (this.finished) return
    if (this.last < 0) {
      this.last = ts
      this.startTs = ts
    }
    const dt = Math.min(1000, Math.max(0, ts - this.last))
    this.last = ts
    this.now = ts
    this.vt += dt * this.speed
    // Hurrying trades frame rate for throughput; the user is back and wants the picture.
    const hurry = this.speed > 1
    const deadline = performance.now() + (hurry ? 38 : 12)
    // The JS deadline misses GPU raster cost, so also adapt a unit cap to the real frame interval.
    if (dt > 45) this.cap = Math.max(24, this.cap * 0.8)
    else if (dt < 25) this.cap = Math.min(6000, this.cap * 1.08 + 4)
    let budget = hurry ? Infinity : this.cap
    let pos: Pt | null = null
    this.jobs.shift()?.()
    while (this.pi < this.phases.length) {
      const ph = this.phases[this.pi]
      if (!this.entered) {
        this.entered = true
        this.count = ph.enter()
        this.drawn = 0
      }
      const target = Math.min(this.count, Math.ceil(this.progress(ph) * this.count))
      while (this.drawn < target && budget-- > 0 && performance.now() < deadline) {
        const q = ph.unit(this.drawn++)
        if (q) pos = q
      }
      if (this.drawn >= this.count && this.vt >= ph.t1) {
        this.pi++
        this.entered = false
        continue
      }
      break
    }
    if (pos) {
      this.brush = pos
      this.opts.onBrush?.(pos[0], pos[1])
    }
    if (this.lastPts) {
      this.trails.push({ pts: this.lastPts, born: ts })
      if (this.trails.length > 10) this.trails.shift()
      this.lastPts = null
    }
    if (this.pi >= this.phases.length) {
      this.finish()
      return
    }
    this.spawn(this.phases[this.pi], dt)
    this.render(this.phases[this.pi])
    requestAnimationFrame(this.frame)
  }

  private progress(ph: Phase): number {
    return Math.min(1, Math.max(0, (this.vt - ph.t0) / Math.max(1, ph.t1 - ph.t0)))
  }

  private finish(): void {
    this.finished = true
    this.view.globalCompositeOperation = 'source-over'
    this.view.globalAlpha = 1
    this.view.clearRect(0, 0, this.w, this.h)
    this.view.drawImage(this.paint, 0, 0)
    this.resolve()
  }

  // ---------------------------------------------------------------- reference

  private prepareReference(): void {
    const { w, h } = this
    const r = ctx2d(this.refCanvas, true)
    const src = this.source as { naturalWidth?: number; naturalHeight?: number; width: number; height: number }
    const sw = src.naturalWidth || src.width || w
    const sh = src.naturalHeight || src.height || h
    const k = Math.max(w / sw, h / sh)
    r.fillStyle = '#ffffff'
    r.fillRect(0, 0, w, h)
    r.imageSmoothingQuality = 'high'
    r.drawImage(this.source, (w - sw * k) / 2, (h - sh * k) / 2, sw * k, sh * k)
    this.refData = r.getImageData(0, 0, w, h).data
    this.palette = quantize(this.refData, 24)
    if (!this.palette.length) this.palette = [[0, 0, 0]]
  }

  private blurred(sigma: number): Uint8ClampedArray {
    const { w, h } = this
    if (sigma < 0.6) return this.refData
    const c = makeCanvas(w, h, this.canvas)
    const x = ctx2d(c, true)
    x.filter = `blur(${sigma.toFixed(2)}px)`
    if (typeof x.filter === 'string' && x.filter !== 'none') {
      // Edges fade in alpha only; getImageData un-premultiplies, so the colors there stay right.
      x.drawImage(this.refCanvas, 0, 0)
      x.filter = 'none'
    } else {
      const k = Math.max(1, sigma * 1.6)
      const s = makeCanvas(Math.ceil(w / k), Math.ceil(h / k), this.canvas)
      const sx = ctx2d(s)
      sx.imageSmoothingQuality = 'high'
      sx.drawImage(this.refCanvas, 0, 0, s.width, s.height)
      x.imageSmoothingEnabled = true
      x.imageSmoothingQuality = 'high'
      x.drawImage(s, 0, 0, w, h)
    }
    return x.getImageData(0, 0, w, h).data
  }

  private reference(k: number): { ref: Uint8ClampedArray; lum: Float32Array } {
    const ref = this.blurred(BRUSHES[k] * this.sc * 0.35)
    return { ref, lum: luminance(ref) }
  }

  // ---------------------------------------------------------------- (a) pixel dots

  private planDots(s: number): { order: Int32Array; colors: Uint8Array; cols: number } {
    const { w, h } = this
    const cols = Math.ceil(w / s)
    const rows = Math.ceil(h / s)
    const colors = new Uint8Array(cols * rows)
    const centers = new Int32Array(cols * rows)
    const step = Math.max(1, Math.floor(s / 6))
    const d = this.refData
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        let r = 0, g = 0, b = 0, n = 0
        const x1 = Math.min(w, bx * s + s), y1 = Math.min(h, by * s + s)
        for (let y = by * s; y < y1; y += step) {
          for (let x = bx * s; x < x1; x += step) {
            const o = (y * w + x) * 4
            r += d[o]; g += d[o + 1]; b += d[o + 2]; n++
          }
        }
        const cell = by * cols + bx
        colors[cell] = nearest(this.palette, r / n, g / n, b / n)
        const cx = Math.min(w - 1, bx * s + (s >> 1)), cy = Math.min(h - 1, by * s + (s >> 1))
        centers[cell] = cy * w + cx
      }
    }
    // Shuffle per tile so the cursor roams area by area instead of teleporting every frame.
    const pixOrder = tileOrder(centers, w, Math.max(150 * this.sc, s * 6), this.rng)
    const order = new Int32Array(pixOrder.length)
    for (let i = 0; i < pixOrder.length; i++) {
      const p = pixOrder[i]
      order[i] = Math.floor(((p / w) | 0) / s) * cols + Math.floor((p % w) / s)
    }
    return { order, colors, cols }
  }

  private dot(cell: number, cols: number, s: number, colors: Uint8Array): Pt {
    const x = (cell % cols) * s, y = Math.floor(cell / cols) * s
    const [r, g, b] = this.palette[colors[cell]]
    const c = this.pctx
    c.fillStyle = `rgb(${r},${g},${b})`
    if (s >= 20) {
      c.beginPath()
      c.arc(x + s / 2, y + s / 2, s * 0.43, 0, Math.PI * 2)
      c.fill()
    } else if (s >= 10) {
      // LED tile: a darker seam instead of a gap, so no white grid shows through.
      c.fillStyle = `rgb(${(r * 0.72) | 0},${(g * 0.72) | 0},${(b * 0.72) | 0})`
      c.fillRect(x, y, s, s)
      c.fillStyle = `rgb(${r},${g},${b})`
      c.fillRect(x + 1, y + 1, s - 2, s - 2)
    } else {
      c.fillRect(x, y, s, s)
    }
    this.blips.push({ x, y, s, born: this.now })
    if (this.blips.length > 140) this.blips.shift()
    return [x + s / 2, y + s / 2]
  }

  // ---------------------------------------------------------------- (b) painterly strokes

  private analyze(k: number): Layer {
    const { w, h } = this
    const bw = BRUSHES[k] * this.sc
    const { ref, lum } = this.pre[k] ?? this.reference(k)
    this.pre[k] = undefined
    const snap = this.pctx.getImageData(0, 0, w, h).data
    const g = Math.max(2, Math.round(bw * 0.8))
    const thresh = THRESHOLDS[k]
    const picks: number[] = []
    for (let gy = 0; gy < h; gy += g) {
      for (let gx = 0; gx < w; gx += g) {
        let sum = 0, n = 0, best = -1, bestErr = -1
        const x1 = Math.min(w, gx + g), y1 = Math.min(h, gy + g)
        for (let y = gy; y < y1; y++) {
          for (let x = gx; x < x1; x++) {
            const p = y * w + x, o = p * 4
            const e = snap[o + 3] < 8 ? 300 : dist(ref, o, snap[o], snap[o + 1], snap[o + 2])
            sum += e; n++
            if (e > bestErr) { bestErr = e; best = p }
          }
        }
        if (sum / n > thresh) picks.push(thresh === 0 ? Math.min(y1 - 1, gy + (g >> 1)) * w + Math.min(x1 - 1, gx + (g >> 1)) : best)
      }
    }
    return { bw, ref, lum, snap, order: tileOrder(picks, w, Math.max(150 * this.sc, bw * 8), this.rng) }
  }

  private stroke(L: Layer, p0: number, k: number): Pt {
    const { w, h, rng } = this
    const ref = L.ref, o0 = p0 * 4
    const jit = 1 + (rng() - 0.5) * 0.09
    const cr = clamp255(ref[o0] * jit), cg = clamp255(ref[o0 + 1] * jit), cb = clamp255(ref[o0 + 2] * jit)
    const step = Math.max(1.4, L.bw * 0.5)
    const pts = [p0 % w, (p0 / w) | 0]
    let x = pts[0], y = pts[1], ldx = 0, ldy = 0
    for (let i = 1; i < MAX_LEN[k]; i++) {
      const xi = Math.round(x), yi = Math.round(y), p = yi * w + xi, o = p * 4
      if (i > MIN_LEN[k] && dist(ref, o, L.snap[o], L.snap[o + 1], L.snap[o + 2]) < dist(ref, o, cr, cg, cb)) break
      const [gx, gy] = sobel(L.lum, w, h, xi, yi)
      const mag = Math.hypot(gx, gy)
      let dx: number, dy: number
      if (mag < 6) {
        const a = this.flow(x, y)
        dx = Math.cos(a); dy = Math.sin(a)
      } else {
        dx = -gy / mag; dy = gx / mag
      }
      if (ldx * dx + ldy * dy < 0) { dx = -dx; dy = -dy }
      if (i > 1) {
        dx = dx * 0.65 + ldx * 0.35; dy = dy * 0.65 + ldy * 0.35
        const m = Math.hypot(dx, dy) || 1
        dx /= m; dy /= m
      }
      x += dx * step; y += dy * step
      if (x < 0 || y < 0 || x > w - 1 || y > h - 1) break
      ldx = dx; ldy = dy
      pts.push(x, y)
    }
    this.renderStroke(pts, L.bw, cr, cg, cb, ALPHA[k])
    this.lastPts = pts
    return [pts[pts.length - 2], pts[pts.length - 1]]
  }

  private flow(x: number, y: number): number {
    return Math.sin(x * 0.0071 + y * 0.0023) * 1.6 + Math.cos(y * 0.0093 - x * 0.0017) * 1.3
  }

  private renderStroke(pts: number[], bw: number, r: number, g: number, b: number, alpha: number): void {
    const c = this.pctx
    c.lineCap = 'round'
    c.lineJoin = 'round'
    c.strokeStyle = `rgba(${r | 0},${g | 0},${b | 0},${alpha})`
    c.lineWidth = bw
    tracePath(c, pts)
    c.stroke()
    if (bw < 6 || pts.length < 4) return
    // Bristle streaks: thin offset lines with a slight tonal shift give the stroke texture.
    for (const off of [-0.3, 0.04, 0.32]) {
      const f = 1 + (this.rng() - 0.5) * 0.2
      c.strokeStyle = `rgba(${clamp255(r * f)},${clamp255(g * f)},${clamp255(b * f)},0.38)`
      c.lineWidth = bw * 0.15
      tracePath(c, offsetPath(pts, off * bw))
      c.stroke()
    }
  }

  // ---------------------------------------------------------------- (c) detail pass

  private planDetail(): Detail {
    const { w, h } = this
    const lum = luminance(this.refData)
    const g = Math.max(3, Math.round(4 * this.sc))
    const edgeAt: number[] = [], edgeMag: number[] = [], lightAt: number[] = [], lightLum: number[] = []
    for (let gy = 0; gy < h; gy += g) {
      for (let gx = 0; gx < w; gx += g) {
        let bm = -1, bp = 0, bl = -1, blp = 0
        const x1 = Math.min(w, gx + g), y1 = Math.min(h, gy + g)
        for (let y = gy; y < y1; y++) {
          for (let x = gx; x < x1; x++) {
            const m = sobelMag2(lum, w, h, x, y), p = y * w + x
            if (m > bm) { bm = m; bp = p }
            if (lum[p] > bl) { bl = lum[p]; blp = p }
          }
        }
        edgeAt.push(bp); edgeMag.push(Math.sqrt(bm))
        lightAt.push(blp); lightLum.push(bl)
      }
    }
    const eT = Math.max(90, percentile(edgeMag, 0.8))
    const lT = Math.max(190, percentile(lightLum, 0.94))
    const picks: number[] = []
    const lights = new Set<number>()
    for (let i = 0; i < edgeAt.length; i++) {
      if (edgeMag[i] > eT) picks.push(edgeAt[i])
      if (lightLum[i] > lT && i % 3 === 0 && !lights.has(lightAt[i])) {
        lights.add(lightAt[i])
        picks.push(lightAt[i])
      }
    }
    // Own RNG: this may run as an idle job, and must not shift the stroke RNG's sequence.
    return { order: tileOrder(picks, w, 160 * this.sc, mulberry32(this.seed ^ 0x5bd1e995)), lights, lum }
  }

  private accent(p: number): Pt {
    const { w, h, sc } = this
    const D = this.detail!
    const x = p % w, y = (p / w) | 0
    const d = this.refData
    const c = this.pctx
    if (D.lights.has(p)) {
      const o = p * 4
      const r = d[o] + (255 - d[o]) * 0.45, g = d[o + 1] + (255 - d[o + 1]) * 0.45, b = d[o + 2] + (255 - d[o + 2]) * 0.45
      const rad = (2.5 + this.rng() * 2.5) * sc
      const col = `${r | 0},${g | 0},${b | 0}`
      const glow = c.createRadialGradient(x, y, 0, x, y, rad)
      glow.addColorStop(0, `rgba(${col},0.55)`)
      glow.addColorStop(0.35, `rgba(${col},0.22)`)
      glow.addColorStop(1, `rgba(${col},0)`)
      c.fillStyle = glow
      c.fillRect(x - rad, y - rad, rad * 2, rad * 2)
      return [x, y]
    }
    const [gx, gy] = sobel(D.lum, w, h, x, y)
    const m = Math.hypot(gx, gy) || 1
    const nx = gx / m, ny = gy / m
    // Sample the dark side of the edge and lay a thin darker line along it.
    const sx = Math.round(Math.min(w - 1, Math.max(0, x - nx * 1.5 * sc)))
    const sy = Math.round(Math.min(h - 1, Math.max(0, y - ny * 1.5 * sc)))
    const o = (sy * w + sx) * 4
    const len = (3 + this.rng() * 5) * sc
    const tx = -ny * len, ty = nx * len
    const bx = x - nx * 0.6 * sc, by = y - ny * 0.6 * sc
    c.lineCap = 'round'
    c.strokeStyle = `rgba(${(d[o] * 0.72) | 0},${(d[o + 1] * 0.72) | 0},${(d[o + 2] * 0.72) | 0},0.55)`
    c.lineWidth = 1.3 * sc
    c.beginPath()
    c.moveTo(bx - tx / 2, by - ty / 2)
    c.quadraticCurveTo(bx + nx * 0.8 * sc, by + ny * 0.8 * sc, bx + tx / 2, by + ty / 2)
    c.stroke()
    this.lastPts = [bx - tx / 2, by - ty / 2, bx + tx / 2, by + ty / 2]
    return [x, y]
  }

  private underlay(): void {
    // Any pinholes the strokes left get the dot layer's average tone instead of transparency.
    const c = this.pctx
    const [r, g, b] = this.palette[0]
    c.globalCompositeOperation = 'destination-over'
    c.fillStyle = `rgb(${r},${g},${b})`
    c.fillRect(0, 0, this.w, this.h)
    c.globalCompositeOperation = 'source-over'
  }

  // ---------------------------------------------------------------- transient fx

  private spawn(ph: Phase, dt: number): void {
    const { fx, now } = this
    if (fx() < ph.glitch * (dt / 1000)) this.flash(ph.glitch > 5)
    if (ph.glyphs && now >= this.nextGlyph) {
      this.nextGlyph = now + ph.glyphs * (0.6 + fx() * 0.8)
      const [bx, by] = this.brush ?? [fx() * this.w, fx() * this.h]
      const text = fx() < 0.35 ? this.dynamicGlyph(bx, by) : GLYPHS[(fx() * GLYPHS.length) | 0]
      this.say(text, fx() < 0.68 ? GREEN : RED, bx + (fx() - 0.3) * 90 * this.sc, by + (fx() - 0.5) * 70 * this.sc)
    }
  }

  private dynamicGlyph(x: number, y: number): string {
    const fx = this.fx
    switch ((fx() * 4) | 0) {
      case 0: return `0x${((fx() * 0xffffff) | 0).toString(16).toUpperCase().padStart(6, '0')}`
      case 1: return `XY ${x | 0},${y | 0}`
      case 2: return `ERR ${(fx() * 0.3).toFixed(3)}`
      default: return `${Math.round((this.vt / this.end) * 100)}%//SYNC`
    }
  }

  private say(text: string, color: string, x: number, y: number): void {
    const pad = 8 * this.sc
    this.glyphs.push({
      text, color,
      x: Math.min(this.w - text.length * 7 * this.sc - pad, Math.max(pad, x)),
      y: Math.min(this.h - pad, Math.max(pad + 10 * this.sc, y)),
      born: this.now, life: 900 + this.fx() * 900
    })
    if (this.glyphs.length > 14) this.glyphs.shift()
  }

  private flash(heavy: boolean): void {
    const { fx, w, h, sc, now } = this
    const life = (heavy ? 90 : 60) + fx() * 140
    if (fx() < 0.45 && !this.flashes.some((f) => f.kind === 'rgb')) {
      const bh = Math.max(8, h * (0.05 + fx() * (heavy ? 0.35 : 0.18)))
      const y = fx() * (h - bh)
      this.captureTint(y, bh)
      this.flashes.push({ kind: 'rgb', born: now, life, bands: [y, bh, (3 + fx() * 7) * sc] })
      return
    }
    const bands: number[] = []
    const n = 1 + ((fx() * (heavy ? 5 : 3)) | 0)
    for (let i = 0; i < n; i++) {
      const bh = (3 + fx() * (heavy ? 60 : 30)) * sc
      bands.push(fx() * (h - bh), bh, (fx() - 0.5) * (heavy ? 120 : 60) * sc)
    }
    if (heavy && fx() < 0.2) bands.push(0, h, (fx() - 0.5) * 8 * sc)
    this.flashes.push({ kind: 'slice', born: now, life, bands })
  }

  private captureTint(y: number, bh: number): void {
    if (!this.tint) this.tint = [makeCanvas(this.w, this.h, this.canvas), makeCanvas(this.w, this.h, this.canvas)]
    this.tint.forEach((t, i) => {
      const c = ctx2d(t)
      c.globalCompositeOperation = 'copy'
      c.drawImage(this.paint, 0, y, this.w, bh, 0, 0, this.w, bh)
      c.globalCompositeOperation = 'multiply'
      c.fillStyle = i === 0 ? '#ff0000' : '#00ffff'
      c.fillRect(0, 0, this.w, bh)
      c.globalCompositeOperation = 'destination-in'
      c.drawImage(this.paint, 0, y, this.w, bh, 0, 0, this.w, bh)
      c.globalCompositeOperation = 'source-over'
    })
  }

  private render(ph: Phase): void {
    const { view: v, w, h, now } = this
    v.globalCompositeOperation = 'source-over'
    v.globalAlpha = 1
    v.clearRect(0, 0, w, h)
    v.drawImage(this.paint, 0, 0)
    this.flashes = this.flashes.filter((f) => now - f.born < f.life)
    this.glyphs = this.glyphs.filter((g) => now - g.born < g.life)
    for (const f of this.flashes) this.drawFlash(f)
    this.drawBlips()
    this.drawTrails()
    this.drawMarkers()
    this.drawScan(ph)
    this.drawGlyphs()
    this.drawReticle()
    this.drawHud(ph)
    v.globalAlpha = 1
  }

  private drawFlash(f: Flash): void {
    const { view: v, w } = this
    if (f.kind === 'rgb' && this.tint) {
      const [y, bh, d] = f.bands
      v.clearRect(0, y, w, bh)
      v.globalCompositeOperation = 'lighter'
      v.drawImage(this.tint[0], 0, 0, w, bh, -d, y, w, bh)
      v.drawImage(this.tint[1], 0, 0, w, bh, d, y, w, bh)
      v.globalCompositeOperation = 'source-over'
      v.fillStyle = RED
      v.globalAlpha = 0.7
      v.fillRect(0, y, w, 1)
      v.globalAlpha = 1
      return
    }
    for (let i = 0; i < f.bands.length; i += 3) {
      const y = f.bands[i], bh = f.bands[i + 1], dx = f.bands[i + 2]
      v.clearRect(0, y, w, bh)
      v.drawImage(this.paint, 0, y, w, bh, dx, y, w, bh)
      v.globalAlpha = 0.16
      v.fillStyle = i % 2 ? GREEN : RED
      v.fillRect(dx < 0 ? w + dx : 0, y, Math.abs(dx), bh)
      v.globalAlpha = 1
    }
  }

  private drawBlips(): void {
    const { view: v, now } = this
    this.blips = this.blips.filter((b) => now - b.born < 260)
    v.strokeStyle = GREEN
    v.lineWidth = 1
    for (const b of this.blips) {
      v.globalAlpha = 0.9 * (1 - (now - b.born) / 260)
      v.strokeRect(b.x + 0.5, b.y + 0.5, b.s - 1, b.s - 1)
    }
    v.globalAlpha = 1
  }

  private drawTrails(): void {
    const { view: v, now } = this
    this.trails = this.trails.filter((t) => now - t.born < 380)
    v.lineWidth = 1
    v.lineCap = 'round'
    v.lineJoin = 'round'
    for (const t of this.trails) {
      v.globalAlpha = 0.85 * (1 - (now - t.born) / 380)
      v.strokeStyle = GREEN
      v.beginPath()
      for (let i = 0; i < t.pts.length; i += 2) (i ? v.lineTo(t.pts[i], t.pts[i + 1]) : v.moveTo(t.pts[i], t.pts[i + 1]))
      v.stroke()
      v.fillStyle = RED
      v.fillRect(t.pts[0] - 1.5, t.pts[1] - 1.5, 3, 3)
    }
    v.globalAlpha = 1
  }

  private drawMarkers(): void {
    if (!this.markers.length) return
    const { view: v, w, fx, sc } = this
    const s = 4 * sc
    v.strokeStyle = RED
    v.lineWidth = 1
    for (const p of this.markers) {
      v.globalAlpha = 0.35 + fx() * 0.6
      v.strokeRect((p % w) - s / 2 + 0.5, ((p / w) | 0) - s / 2 + 0.5, s, s)
    }
    v.globalAlpha = 1
  }

  private drawScan(ph: Phase): void {
    if (!ph.scan) return
    const { view: v, w, h, sc, fx } = this
    const y = ph.scan === 'loop' ? (((this.now - this.startTs) % 2600) / 2600) * h : this.progress(ph) * h
    const band = 70 * sc
    const g = v.createLinearGradient(0, y - band, 0, y)
    g.addColorStop(0, 'rgba(25,240,122,0)')
    g.addColorStop(1, 'rgba(25,240,122,0.2)')
    v.fillStyle = g
    v.fillRect(0, y - band, w, band)
    v.globalAlpha = 0.9
    v.fillStyle = GREEN
    v.fillRect(0, y - 1, w, 2)
    v.fillStyle = RED
    for (let i = 0; i < 7; i++) v.fillRect(fx() * w, y - 2, 3 * sc, 3 * sc)
    v.font = `${Math.round(10 * sc)}px ${FONT}`
    v.fillStyle = GREEN
    v.fillText(`SCAN 0x${(y | 0).toString(16).toUpperCase().padStart(3, '0')}`, w - 92 * sc, y - 5 * sc)
    v.globalAlpha = 1
  }

  private drawGlyphs(): void {
    const { view: v, now, sc, fx } = this
    v.font = `${Math.round(11 * sc)}px ${FONT}`
    for (const g of this.glyphs) {
      const t = (now - g.born) / g.life
      const shown = Math.min(g.text.length, Math.floor((t / 0.35) * g.text.length))
      let text = g.text.slice(0, shown)
      for (let i = shown; i < g.text.length; i++) text += SCRAMBLE[(fx() * SCRAMBLE.length) | 0]
      v.globalAlpha = Math.min(1, t * 8, (1 - t) * 4)
      v.fillStyle = 'rgba(5,1,2,0.55)'
      v.fillRect(g.x - 3 * sc, g.y - 11 * sc, (text.length * 6.4 + 6) * sc, 14 * sc)
      v.fillStyle = g.color
      v.fillRect(g.x - 3 * sc, g.y - 11 * sc, 2 * sc, 14 * sc)
      v.fillText(text, g.x + 2 * sc, g.y)
    }
    v.globalAlpha = 1
  }

  private drawReticle(): void {
    if (!this.brush) return
    const { view: v, sc } = this
    const [x, y] = this.brush
    const r = this.brushSize * 0.8 + 6 * sc, k = r * 0.45
    v.strokeStyle = RED
    v.lineWidth = 1.5
    v.globalAlpha = 0.85
    v.beginPath()
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      v.moveTo(x + sx * r, y + sy * (r - k))
      v.lineTo(x + sx * r, y + sy * r)
      v.lineTo(x + sx * (r - k), y + sy * r)
    }
    v.stroke()
    v.fillStyle = GREEN
    v.fillRect(x - 1, y - 1, 2, 2)
    v.globalAlpha = 1
  }

  private drawHud(ph: Phase): void {
    const { view: v, h, sc } = this
    const pct = Math.min(100, Math.round((this.vt / this.end) * 100))
    const x = 10 * sc, y = h - 12 * sc, bar = 130 * sc
    v.globalAlpha = 0.8
    v.fillStyle = 'rgba(5,1,2,0.6)'
    v.fillRect(x - 4 * sc, y - 24 * sc, bar + 120 * sc, 32 * sc)
    v.font = `${Math.round(10 * sc)}px ${FONT}`
    v.fillStyle = GREEN
    v.fillText(`C4PR1://PAINT.EXE  ${ph.label}  ${pct}%`, x, y - 11 * sc)
    v.fillStyle = 'rgba(25,240,122,0.25)'
    v.fillRect(x, y - 4 * sc, bar, 3 * sc)
    v.fillStyle = RED
    v.fillRect(x, y - 4 * sc, (bar * pct) / 100, 3 * sc)
    v.globalAlpha = 1
  }
}

// ---------------------------------------------------------------- quantize (median cut)

export function quantize(pixels: Uint8ClampedArray, colors: number): [number, number, number][] {
  const total = pixels.length >> 2
  const stride = Math.max(1, Math.ceil(total / 160_000))
  let n = 0
  for (let i = 0; i < total; i += stride) if (pixels[i * 4 + 3] >= 128) n++
  if (n === 0 || colors < 1) return []
  const px = new Uint8Array(n * 3)
  for (let i = 0, k = 0; i < total; i += stride) {
    const o = i * 4
    if (pixels[o + 3] < 128) continue
    px[k++] = pixels[o]; px[k++] = pixels[o + 1]; px[k++] = pixels[o + 2]
  }
  const idx = new Uint32Array(n)
  for (let i = 0; i < n; i++) idx[i] = i

  interface Box { lo: number; hi: number; ch: number; range: number }
  const measure = (lo: number, hi: number): Box => {
    const mn = [255, 255, 255], mx = [0, 0, 0]
    for (let i = lo; i < hi; i++) {
      const o = idx[i] * 3
      for (let c = 0; c < 3; c++) {
        const v = px[o + c]
        if (v < mn[c]) mn[c] = v
        if (v > mx[c]) mx[c] = v
      }
    }
    const r = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
    const ch = r[0] >= r[1] && r[0] >= r[2] ? 0 : r[1] >= r[2] ? 1 : 2
    return { lo, hi, ch, range: r[ch] }
  }
  const split = (b: Box): number => {
    const hist = new Uint32Array(256)
    for (let i = b.lo; i < b.hi; i++) hist[px[idx[i] * 3 + b.ch]]++
    const size = b.hi - b.lo
    let v = 0, acc = 0
    for (; v < 256; v++) {
      acc += hist[v]
      if (acc >= size / 2) break
    }
    // Left gets values < cut; never split inside a run of equal values so flat colors stay exact.
    const cut = acc < size ? v + 1 : v
    let i = b.lo, j = b.hi - 1
    while (i <= j) {
      if (px[idx[i] * 3 + b.ch] < cut) i++
      else {
        const t = idx[i]; idx[i] = idx[j]; idx[j] = t
        j--
      }
    }
    return i
  }

  const boxes = [measure(0, n)]
  while (boxes.length < colors) {
    let best = -1, score = 0
    boxes.forEach((b, i) => {
      const s = b.range * Math.sqrt(b.hi - b.lo)
      if (b.range > 0 && s > score) { score = s; best = i }
    })
    if (best < 0) break
    const b = boxes[best]
    const mid = split(b)
    boxes.splice(best, 1, measure(b.lo, mid), measure(mid, b.hi))
  }
  return boxes
    .sort((a, b) => b.hi - b.lo - (a.hi - a.lo))
    .map((b) => {
      let r = 0, g = 0, bl = 0
      for (let i = b.lo; i < b.hi; i++) {
        const o = idx[i] * 3
        r += px[o]; g += px[o + 1]; bl += px[o + 2]
      }
      const c = b.hi - b.lo
      return [Math.round(r / c), Math.round(g / c), Math.round(bl / c)] as RGB
    })
}

// ---------------------------------------------------------------- fallback scene

export function fallbackScene(w: number, h: number, seed = 2077): HTMLCanvasElement {
  const rng = mulberry32(seed)
  const c = makeCanvas(w, h)
  const x = ctx2d(c)
  const s = Math.sqrt(w * h) / 900
  const hz = h * (0.6 + rng() * 0.06)

  const sky = x.createLinearGradient(0, 0, 0, hz)
  sky.addColorStop(0, '#07021a')
  sky.addColorStop(0.4, '#2c0a4a')
  sky.addColorStop(0.72, '#a3124f')
  sky.addColorStop(0.92, '#ff5a3c')
  sky.addColorStop(1, '#ffb347')
  x.fillStyle = sky
  x.fillRect(0, 0, w, hz)

  for (let i = 0; i < 160; i++) {
    const sy = rng() * hz * 0.6
    x.globalAlpha = (0.3 + rng() * 0.7) * (1 - sy / (hz * 0.6))
    x.fillStyle = rng() < 0.15 ? '#ff9ac0' : '#ffffff'
    const r = rng() < 0.08 ? 1.6 * s : 0.8 * s
    x.fillRect(rng() * w, sy, r, r)
  }
  x.globalAlpha = 1

  // Striped synth sun with a glow.
  const sr = Math.min(w, h) * 0.24
  const sx = w * (0.38 + rng() * 0.24), sy = hz - sr * 0.3
  const glow = x.createRadialGradient(sx, sy, sr * 0.6, sx, sy, sr * 2.4)
  glow.addColorStop(0, 'rgba(255,70,120,0.45)')
  glow.addColorStop(1, 'rgba(255,70,120,0)')
  x.fillStyle = glow
  x.fillRect(0, 0, w, hz)
  const sun = makeCanvas(w, h)
  const sc = ctx2d(sun)
  const sg = sc.createLinearGradient(0, sy - sr, 0, sy + sr)
  sg.addColorStop(0, '#fff3a0')
  sg.addColorStop(0.5, '#ff9a3c')
  sg.addColorStop(1, '#ff1e6e')
  sc.fillStyle = sg
  sc.beginPath()
  sc.arc(sx, sy, sr, 0, Math.PI * 2)
  sc.fill()
  sc.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 9; i++) {
    const t = i / 9
    const by = sy + sr * (0.05 + t * 0.95)
    sc.fillRect(sx - sr, by, sr * 2, sr * (0.02 + t * 0.07))
  }
  x.drawImage(sun, 0, 0)

  // Mountains.
  const ridge = (base: number, amp: number, color: string, rim: string): void => {
    x.fillStyle = color
    x.beginPath()
    x.moveTo(0, hz)
    const pts: Pt[] = []
    for (let px = 0; px <= w; px += w / 24) pts.push([px, base - rng() * amp])
    for (const [px, py] of pts) x.lineTo(px, py)
    x.lineTo(w, hz)
    x.closePath()
    x.fill()
    x.strokeStyle = rim
    x.lineWidth = 1.5 * s
    x.beginPath()
    pts.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py)))
    x.stroke()
  }
  ridge(hz - h * 0.05, h * 0.12, '#3a0d4f', 'rgba(255,90,160,0.7)')
  ridge(hz - h * 0.01, h * 0.06, '#24072f', 'rgba(255,60,120,0.5)')

  // Skyline, two depths, with lit windows and neon strips.
  const city = (maxH: number, body: string, lit: number): void => {
    let bx = -rng() * 30 * s
    while (bx < w) {
      const bw = (24 + rng() * 60) * s
      const bh = maxH * (0.25 + rng() * 0.75)
      const top = hz - bh
      x.fillStyle = body
      x.fillRect(bx, top, bw, bh + 1)
      if (rng() < 0.3) x.fillRect(bx + bw * 0.45, top - bh * 0.18, 2 * s, bh * 0.18)
      const ws = 5 * s
      for (let wy = top + ws; wy < hz - ws; wy += ws * 1.8) {
        for (let wx = bx + ws * 0.8; wx < bx + bw - ws; wx += ws * 1.6) {
          if (rng() > lit) continue
          const k = rng()
          x.fillStyle = k < 0.6 ? '#ffcf6b' : k < 0.85 ? '#37e0ff' : '#ff3d7f'
          x.globalAlpha = 0.55 + rng() * 0.45
          x.fillRect(wx, wy, ws * 0.7, ws * 0.8)
        }
      }
      x.globalAlpha = 1
      if (rng() < 0.22) {
        x.fillStyle = rng() < 0.5 ? '#ff1e50' : '#19f0e0'
        x.shadowColor = x.fillStyle
        x.shadowBlur = 12 * s
        x.fillRect(bx + bw * 0.15, top + bh * 0.15, 3 * s, bh * 0.4)
        x.shadowBlur = 0
      }
      bx += bw + rng() * 6 * s
    }
  }
  city(h * 0.32, '#1c0830', 0.18)
  city(h * 0.22, '#0b0414', 0.3)

  // Ground with a perspective grid and the sun's reflection.
  const gr = x.createLinearGradient(0, hz, 0, h)
  gr.addColorStop(0, '#2a0838')
  gr.addColorStop(1, '#05010a')
  x.fillStyle = gr
  x.fillRect(0, hz, w, h - hz)
  for (let i = 0; i < 14; i++) {
    const t = i / 14
    x.globalAlpha = 0.35 * (1 - t)
    x.fillStyle = i % 2 ? '#ff9a3c' : '#ff3d7f'
    const rw = sr * (1.4 - t * 0.9) * (0.7 + rng() * 0.6)
    x.fillRect(sx - rw / 2 + (rng() - 0.5) * 20 * s, hz + (h - hz) * t * 0.6 + 3 * s, rw, 2 * s)
  }
  x.globalAlpha = 1
  x.strokeStyle = 'rgba(255,45,149,0.75)'
  x.lineWidth = 1.4 * s
  x.beginPath()
  const vx = w / 2
  for (let i = -18; i <= 18; i++) {
    x.moveTo(vx + i * w * 0.012, hz)
    x.lineTo(vx + i * w * 0.16, h)
  }
  for (let i = 1; i < 12; i++) {
    const gy = hz + (h - hz) * (i / 12) ** 2
    x.moveTo(0, gy)
    x.lineTo(w, gy)
  }
  x.stroke()
  const haze = x.createLinearGradient(0, hz - h * 0.05, 0, hz + h * 0.04)
  haze.addColorStop(0, 'rgba(255,80,130,0)')
  haze.addColorStop(0.5, 'rgba(255,80,130,0.35)')
  haze.addColorStop(1, 'rgba(255,80,130,0)')
  x.fillStyle = haze
  x.fillRect(0, hz - h * 0.05, w, h * 0.09)
  return c
}

// ---------------------------------------------------------------- helpers

function makeCanvas(w: number, h: number, like?: HTMLCanvasElement): HTMLCanvasElement {
  const c = (like?.ownerDocument ?? document).createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

function ctx2d(c: HTMLCanvasElement, read = false): CanvasRenderingContext2D {
  const x = c.getContext('2d', read ? { willReadFrequently: true } : undefined)
  if (!x) throw new Error('2D canvas context unavailable')
  return x
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(a: T[], rng: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

// Random order over pixel indices, grouped into randomly ordered square tiles.
function tileOrder(items: ArrayLike<number>, w: number, tile: number, rng: () => number): Int32Array {
  const tw = Math.ceil(w / tile)
  const buckets = new Map<number, number[]>()
  for (let i = 0; i < items.length; i++) {
    const p = items[i]
    const key = Math.floor(((p / w) | 0) / tile) * tw + Math.floor((p % w) / tile)
    let b = buckets.get(key)
    if (!b) buckets.set(key, (b = []))
    b.push(p)
  }
  const out = new Int32Array(items.length)
  let k = 0
  for (const key of shuffle([...buckets.keys()], rng)) for (const p of shuffle(buckets.get(key)!, rng)) out[k++] = p
  return out
}

function sample(a: Int32Array, n: number, rng: () => number): number[] {
  const out: number[] = []
  for (let i = 0; i < n && a.length; i++) out.push(a[(rng() * a.length) | 0])
  return out
}

function nearest(pal: RGB[], r: number, g: number, b: number): number {
  let best = 0, bd = Infinity
  for (let i = 0; i < pal.length; i++) {
    const [pr, pg, pb] = pal[i]
    const d = (pr - r) ** 2 * 0.3 + (pg - g) ** 2 * 0.59 + (pb - b) ** 2 * 0.11
    if (d < bd) { bd = d; best = i }
  }
  return best
}

function dist(a: Uint8ClampedArray, o: number, r: number, g: number, b: number): number {
  const dr = a[o] - r, dg = a[o + 1] - g, db = a[o + 2] - b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0
}

function luminance(d: Uint8ClampedArray): Float32Array {
  const l = new Float32Array(d.length >> 2)
  for (let i = 0, o = 0; i < l.length; i++, o += 4) l[i] = d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114
  return l
}

function sobel(l: Float32Array, w: number, h: number, x: number, y: number): Pt {
  const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : x
  const r0 = (y > 0 ? y - 1 : 0) * w, r1 = y * w, r2 = (y < h - 1 ? y + 1 : y) * w
  const a = l[r0 + x0], b = l[r0 + x], c = l[r0 + x1]
  const d = l[r1 + x0], f = l[r1 + x1]
  const g = l[r2 + x0], k = l[r2 + x], m = l[r2 + x1]
  return [c + 2 * f + m - (a + 2 * d + g), g + 2 * k + m - (a + 2 * b + c)]
}

function sobelMag2(l: Float32Array, w: number, h: number, x: number, y: number): number {
  const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : x
  const r0 = (y > 0 ? y - 1 : 0) * w, r1 = y * w, r2 = (y < h - 1 ? y + 1 : y) * w
  const a = l[r0 + x0], c = l[r0 + x1], g = l[r2 + x0], m = l[r2 + x1]
  const sx = c + 2 * l[r1 + x1] + m - (a + 2 * l[r1 + x0] + g)
  const sy = g + 2 * l[r2 + x] + m - (a + 2 * l[r0 + x] + c)
  return sx * sx + sy * sy
}

function percentile(v: number[], q: number): number {
  if (!v.length) return 0
  const s = Float32Array.from(v).sort()
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

// Smooth curve through the points via quadratic segments between midpoints.
function tracePath(c: CanvasRenderingContext2D, p: number[]): void {
  c.beginPath()
  c.moveTo(p[0], p[1])
  if (p.length === 2) {
    c.lineTo(p[0] + 0.01, p[1])
    return
  }
  if (p.length === 4) {
    c.lineTo(p[2], p[3])
    return
  }
  for (let i = 2; i < p.length - 2; i += 2) {
    c.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2)
  }
  c.lineTo(p[p.length - 2], p[p.length - 1])
}

function offsetPath(p: number[], off: number): number[] {
  const out: number[] = []
  const n = p.length / 2
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1) * 2, b = Math.min(n - 1, i + 1) * 2
    const tx = p[b] - p[a], ty = p[b + 1] - p[a + 1]
    const m = Math.hypot(tx, ty) || 1
    out.push(p[i * 2] - (ty / m) * off, p[i * 2 + 1] + (tx / m) * off)
  }
  return out
}
