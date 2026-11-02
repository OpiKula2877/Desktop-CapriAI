// 2D effect layer drawn over the WebGL canvas: afterimages, glitch blocks and lightning.
// (The strobe trail she leaves on the desktop is drawn by the full-screen stage window.)

interface Bolt {
  pts: [number, number][]
  branches: [number, number][][]
  born: number
  life: number
  color: string
}

interface Ghost {
  img: HTMLCanvasElement
  dx: number
  dy: number
  born: number
  life: number
  tint: string
}

const BOLT_COLORS = ['#19f07a', '#9a5cf0', '#ffffff', '#ff1e50']
const BLOCK_COLORS = ['#ff1e50', '#19f07a', '#9a5cf0', '#ffffff', '#050102']
const GLYPHS = ['0xC4PR1', 'ICE//BREACH', 'ネット', 'エングラム', 'JACK-IN', 'SYS.OVERRIDE', '// NO SIGNAL', 'カプリ', 'BLACKWALL?', 'RAM 0xFF']

interface Block {
  x: number
  y: number
  w: number
  h: number
  born: number
  life: number
  color: string
}

interface Glyph {
  text: string
  x: number
  y: number
  born: number
  life: number
  color: string
}

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  born: number
  life: number
  color: string
}

export class Fx {
  private ctx: CanvasRenderingContext2D
  private bolts: Bolt[] = []
  private ghosts: Ghost[] = []
  private dash: { dirX: number; dirY: number; until: number } | null = null
  private blockList: Block[] = []
  private glyphList: Glyph[] = []
  private sparkList: Spark[] = []

  /** Flashing rectangular glitch blocks scattered in an area. */
  blocks(cx: number, cy: number, w: number, h: number, count: number): void {
    const now = performance.now()
    for (let i = 0; i < count; i++) {
      this.blockList.push({
        x: cx + (Math.random() - 0.5) * w,
        y: cy + (Math.random() - 0.5) * h,
        w: 6 + Math.random() * 46,
        h: 2 + Math.random() * 12,
        born: now + Math.random() * 120,
        life: 70 + Math.random() * 160,
        color: BLOCK_COLORS[Math.floor(Math.random() * BLOCK_COLORS.length)]
      })
    }
  }

  /** Short-lived data labels that glitch in – the anime's UI-text flavour. */
  glyphs(cx: number, cy: number, count: number, pool = GLYPHS): void {
    const now = performance.now()
    for (let i = 0; i < count; i++) {
      this.glyphList.push({
        text: pool[Math.floor(Math.random() * pool.length)],
        x: cx + (Math.random() - 0.5) * 120,
        y: cy + (Math.random() - 0.5) * 120,
        born: now + i * 90,
        life: 900 + Math.random() * 500,
        color: Math.random() < 0.5 ? '#19f07a' : '#ff1e50'
      })
    }
  }

  /** Pixel sparks drifting upward. */
  sparks(cx: number, cy: number, count: number): void {
    const now = performance.now()
    for (let i = 0; i < count; i++) {
      this.sparkList.push({
        x: cx + (Math.random() - 0.5) * 90,
        y: cy + (Math.random() - 0.5) * 40,
        vx: (Math.random() - 0.5) * 0.02,
        vy: -0.03 - Math.random() * 0.05,
        size: 1.5 + Math.random() * 2.5,
        born: now,
        life: 900 + Math.random() * 900,
        color: Math.random() < 0.7 ? '#ffffff' : '#ff4d73'
      })
    }
  }

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!
  }

  resize(w: number, h: number, pr: number): void {
    this.canvas.width = Math.round(w * pr)
    this.canvas.height = Math.round(h * pr)
    this.ctx.setTransform(pr, 0, 0, pr, 0, 0)
  }

  get busy(): boolean {
    return (
      this.bolts.length + this.ghosts.length + this.blockList.length + this.glyphList.length + this.sparkList.length > 0 ||
      this.dash !== null
    )
  }

  /** Start a dash in screen direction (dx, dy) for `ms`. */
  startDash(dx: number, dy: number, ms: number): void {
    const len = Math.hypot(dx, dy) || 1
    this.dash = { dirX: dx / len, dirY: dy / len, until: performance.now() + ms }
  }

  /** Lightning crackling out from a point (CSS px). */
  lightning(cx: number, cy: number, count = 3, reach = 120): void {
    const now = performance.now()
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2
      const len = reach * (0.5 + Math.random() * 0.6)
      const pts = jagged(cx, cy, cx + Math.cos(ang) * len, cy + Math.sin(ang) * len, 7)
      const branches: [number, number][][] = []
      for (let b = 0; b < 2; b++) {
        const from = pts[2 + Math.floor(Math.random() * (pts.length - 3))]
        const a2 = ang + (Math.random() - 0.5) * 1.6
        const l2 = len * 0.35
        branches.push(jagged(from[0], from[1], from[0] + Math.cos(a2) * l2, from[1] + Math.sin(a2) * l2, 4))
      }
      this.bolts.push({
        pts,
        branches,
        born: now + i * 40,
        life: 140 + Math.random() * 120,
        color: BOLT_COLORS[Math.floor(Math.random() * BOLT_COLORS.length)]
      })
    }
  }

  /** Remember a frame of the character to leave an afterimage behind. */
  ghost(source: HTMLCanvasElement, dx: number, dy: number, tint: string, life = 260): void {
    const img = document.createElement('canvas')
    img.width = source.width
    img.height = source.height
    const g = img.getContext('2d')!
    g.drawImage(source, 0, 0)
    g.globalCompositeOperation = 'source-atop'
    g.fillStyle = tint
    g.fillRect(0, 0, img.width, img.height)
    this.ghosts.push({ img, dx, dy, born: performance.now(), life, tint })
  }

  draw(w: number, h: number, body: { x: number; y: number; w: number; h: number }, source: HTMLCanvasElement): void {
    const g = this.ctx
    const now = performance.now()
    g.clearRect(0, 0, w, h)

    // Dash: crackling lightning around her while she moves.
    if (this.dash) {
      if (now > this.dash.until) this.dash = null
      else if (Math.random() < 0.12) this.lightning(body.x, body.y, 1, 90)
    }

    // Afterimages
    this.ghosts = this.ghosts.filter((gh) => now - gh.born < gh.life)
    for (const gh of this.ghosts) {
      const k = 1 - (now - gh.born) / gh.life
      g.globalAlpha = 0.45 * k
      g.drawImage(gh.img, gh.dx * (2 - k), gh.dy * (2 - k), w, h)
    }
    g.globalAlpha = 1

    // Pixel sparks
    this.sparkList = this.sparkList.filter((p) => now - p.born < p.life)
    for (const p of this.sparkList) {
      const age = now - p.born
      const k = 1 - age / p.life
      g.globalAlpha = k * (Math.random() < 0.1 ? 0.3 : 1)
      g.fillStyle = p.color
      g.shadowColor = p.color
      g.shadowBlur = 6
      g.fillRect(p.x + p.vx * age, p.y + p.vy * age, p.size, p.size)
    }
    g.shadowBlur = 0
    g.globalAlpha = 1

    // Glitch blocks
    this.blockList = this.blockList.filter((b) => now - b.born < b.life)
    for (const b of this.blockList) {
      if (now < b.born) continue
      g.globalAlpha = Math.random() < 0.3 ? 0.4 : 0.9
      g.fillStyle = b.color
      g.fillRect(b.x + (Math.random() - 0.5) * 6, b.y, b.w, b.h)
    }
    g.globalAlpha = 1

    // Data glyphs
    this.glyphList = this.glyphList.filter((t) => now - t.born < t.life)
    g.font = '700 10px "Share Tech Mono", monospace'
    for (const t of this.glyphList) {
      if (now < t.born) continue
      const age = now - t.born
      const k = 1 - age / t.life
      // Type-on effect, flicker, then fade.
      const shown = t.text.slice(0, Math.ceil(Math.min(1, age / 180) * t.text.length))
      g.globalAlpha = k * (Math.random() < 0.12 ? 0.2 : 1)
      const w = g.measureText(shown).width
      g.fillStyle = 'rgba(5,1,2,0.75)'
      g.fillRect(t.x - 3, t.y - 10, w + 6, 13)
      g.fillStyle = t.color
      g.fillText(shown, t.x, t.y - age * 0.01)
    }
    g.globalAlpha = 1

    // Lightning
    this.bolts = this.bolts.filter((b) => now - b.born < b.life)
    for (const b of this.bolts) {
      if (now < b.born) continue
      const flicker = Math.random() < 0.25 ? 0.3 : 1
      g.globalAlpha = flicker
      g.shadowColor = b.color
      g.shadowBlur = 14
      g.strokeStyle = b.color
      g.lineWidth = 3
      strokePath(g, b.pts)
      for (const br of b.branches) strokePath(g, br)
      g.shadowBlur = 0
      g.strokeStyle = '#ffffff'
      g.lineWidth = 1.2
      strokePath(g, b.pts)
    }
    g.globalAlpha = 1
    g.shadowBlur = 0
  }
}

export function jagged(x1: number, y1: number, x2: number, y2: number, segs: number): [number, number][] {
  const pts: [number, number][] = [[x1, y1]]
  const nx = -(y2 - y1)
  const ny = x2 - x1
  const nl = Math.hypot(nx, ny) || 1
  for (let i = 1; i < segs; i++) {
    const t = i / segs
    const off = (Math.random() - 0.5) * 0.35 * nl
    pts.push([x1 + (x2 - x1) * t + (nx / nl) * off, y1 + (y2 - y1) * t + (ny / nl) * off])
  }
  pts.push([x2, y2])
  return pts
}

export function strokePath(g: CanvasRenderingContext2D, pts: [number, number][]): void {
  g.beginPath()
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
  g.stroke()
}
