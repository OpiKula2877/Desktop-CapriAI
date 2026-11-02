import '../shared/theme.css'
import './cursor.css'
import { api } from '../shared/api'

interface Goto {
  from: { x: number; y: number }
  to: { x: number; y: number }
  label: string
  click: boolean
  duration: number
}

const root = document.getElementById('root')!
root.innerHTML = `
  <canvas id="trail"></canvas>
  <div class="cursor" id="cursor">
    <svg viewBox="0 0 32 32" width="34" height="34">
      <path d="M3 2 L27 15 L16 17.5 L11 29 Z" fill="#ff1e50" stroke="#050102" stroke-width="2" stroke-linejoin="miter"/>
      <path d="M6 7 L21 15 L14.5 16.5 L11.5 23.5 Z" fill="none" stroke="#19f07a" stroke-width="1.2"/>
    </svg>
    <div class="label" id="label"></div>
  </div>`

const cursor = document.getElementById('cursor')!
const label = document.getElementById('label')!
const trail = document.getElementById('trail') as HTMLCanvasElement
const ctx = trail.getContext('2d')!
let points: { x: number; y: number; t: number }[] = []
let pos = { x: -100, y: -100 }
let anim = 0

function resize(): void {
  trail.width = window.innerWidth * devicePixelRatio
  trail.height = window.innerHeight * devicePixelRatio
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
}
window.addEventListener('resize', resize)
resize()

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

function place(x: number, y: number): void {
  pos = { x, y }
  cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`
}

function drawTrail(): void {
  const now = performance.now()
  points = points.filter((p) => now - p.t < 420)
  ctx.clearRect(0, 0, trail.width, trail.height)
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const life = 1 - (now - b.t) / 420
    ctx.strokeStyle = `rgba(255, 30, 80, ${life * 0.8})`
    ctx.lineWidth = 1 + life * 5
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    // Chromatic ghost
    ctx.strokeStyle = `rgba(25, 240, 122, ${life * 0.35})`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(a.x + 3, a.y)
    ctx.lineTo(b.x + 3, b.y)
    ctx.stroke()
  }
  if (points.length) requestAnimationFrame(drawTrail)
}

function ripple(x: number, y: number): void {
  for (let i = 0; i < 2; i++) {
    const r = document.createElement('div')
    r.className = 'ripple'
    r.style.left = `${x}px`
    r.style.top = `${y}px`
    r.style.animationDelay = `${i * 90}ms`
    document.body.appendChild(r)
    setTimeout(() => r.remove(), 700)
  }
}

api.on('cursor:goto', (g: Goto) => {
  cancelAnimationFrame(anim)
  cursor.classList.remove('gone')
  cursor.classList.add('on')
  label.textContent = g.label ? `> ${g.label}` : ''
  const start = performance.now()
  const from = pos.x < 0 ? g.from : pos
  if (pos.x < 0) place(from.x, from.y)
  // Arc: control point offset perpendicular to the path.
  const mx = (from.x + g.to.x) / 2
  const my = (from.y + g.to.y) / 2
  const dx = g.to.x - from.x
  const dy = g.to.y - from.y
  const len = Math.hypot(dx, dy) || 1
  const bend = Math.min(160, len * 0.25)
  const cx = mx - (dy / len) * bend
  const cy = my + (dx / len) * bend

  const step = () => {
    const t = Math.min(1, (performance.now() - start) / g.duration)
    const e = ease(t)
    const x = (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * cx + e * e * g.to.x
    const y = (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * cy + e * e * g.to.y
    place(x, y)
    points.push({ x, y, t: performance.now() })
    if (points.length === 1) requestAnimationFrame(drawTrail)
    if (t < 1) anim = requestAnimationFrame(step)
    else if (g.click) {
      cursor.classList.add('press')
      ripple(g.to.x, g.to.y)
      setTimeout(() => cursor.classList.remove('press'), 160)
    }
  }
  anim = requestAnimationFrame(step)
})

api.on('cursor:hide', () => {
  cursor.classList.add('gone')
  setTimeout(() => {
    cursor.classList.remove('on', 'gone')
    pos = { x: -100, y: -100 }
  }, 380)
})
