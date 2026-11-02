import { describe, expect, it } from 'vitest'
import { isAway, isBack, oskKeyFraction } from '../src/shared/idle'
import { blockOrder, clampInto, clampToDisplays, pickRect } from '../src/shared/geometry'

// Two monitors side by side, both 1536×864 DIP (1920×1080 at 125 %).
const A = { x: 0, y: 0, width: 1536, height: 864 }
const B = { x: 1536, y: 0, width: 1536, height: 864 }

describe('clamp to monitor', () => {
  it('keeps a box that is fully inside untouched', () => {
    expect(clampInto(100, 100, 224, 308, A)).toEqual({ x: 100, y: 100 })
  })

  it('never lets a single pixel leave the monitor', () => {
    for (const [x, y] of [[-50, -50], [1500, 800], [-999, 400], [700, 5000]]) {
      const c = clampInto(x, y, 224, 308, A)
      expect(c.x).toBeGreaterThanOrEqual(A.x)
      expect(c.y).toBeGreaterThanOrEqual(A.y)
      expect(c.x + 224).toBeLessThanOrEqual(A.x + A.width)
      expect(c.y + 308).toBeLessThanOrEqual(A.y + A.height)
    }
  })

  it('chooses the monitor under the box centre, or the anchor while dragging', () => {
    expect(clampToDisplays(1500, 100, 224, 308, [A, B]).display).toBe(B)
    expect(clampToDisplays(1400, 100, 224, 308, [A, B]).x).toBe(1536 - 224)
    // Dragging with the mouse on B pulls her over to B even if her centre is still on A.
    const c = clampToDisplays(1400, 100, 224, 308, [A, B], { x: 1600, y: 300 })
    expect(c.display).toBe(B)
    expect(c.x).toBe(1536)
  })

  it('falls back to the nearest monitor for points in the gap', () => {
    expect(pickRect(5000, 100, [A, B])).toBe(B)
    expect(pickRect(-300, 2000, [A, B])).toBe(A)
  })
})

describe('blackout block order', () => {
  it('covers every block exactly once', () => {
    const order = blockOrder(20, 12)
    expect(order).toHaveLength(240)
    expect(new Set(order).size).toBe(240)
  })

  it('starts in the centre and ends in a corner region', () => {
    const order = blockOrder(21, 11, 0)
    expect(order[0]).toBe(5 * 21 + 10)
    const last = order[order.length - 1]
    const col = last % 21
    const row = Math.floor(last / 21)
    expect(col === 0 || col === 20).toBe(true)
    expect(row === 0 || row === 10).toBe(true)
  })
})

describe('away detection', () => {
  const base = { idleSec: 600, awayMinutes: 4, mediaPlaying: false, mediaIsMusic: false, fullscreen: false }
  it('away after the idle time with nothing on screen', () => expect(isAway(base)).toBe(true))
  it('not away before the idle time', () => expect(isAway({ ...base, idleSec: 100 })).toBe(false))
  it('watching a video is not away, music alone is', () => {
    expect(isAway({ ...base, mediaPlaying: true })).toBe(false)
    expect(isAway({ ...base, mediaPlaying: true, mediaIsMusic: true })).toBe(true)
  })
  it('fullscreen app is not away', () => expect(isAway({ ...base, fullscreen: true })).toBe(false))
  it('back on fresh input', () => {
    expect(isBack(0.5)).toBe(true)
    expect(isBack(30)).toBe(false)
  })
})

describe('on-screen keyboard layout', () => {
  it('puts every key inside the keyboard area', () => {
    for (const ch of 'ahoj choombo, tady capri. 2077!'.split('')) {
      const { fx, fy } = oskKeyFraction(ch)
      expect(fx).toBeGreaterThan(0)
      expect(fx).toBeLessThan(0.85)
      expect(fy).toBeGreaterThan(0.25)
      expect(fy).toBeLessThan(0.98)
    }
  })
  it('keeps rows ordered and letters left-to-right', () => {
    expect(oskKeyFraction('q').fy).toBeLessThan(oskKeyFraction('a').fy)
    expect(oskKeyFraction('a').fy).toBeLessThan(oskKeyFraction('y').fy)
    expect(oskKeyFraction('q').fx).toBeLessThan(oskKeyFraction('p').fx)
    expect(oskKeyFraction(' ').fy).toBeGreaterThan(oskKeyFraction('m').fy)
  })
})
