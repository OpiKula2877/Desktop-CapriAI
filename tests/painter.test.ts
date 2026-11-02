import { describe, expect, it } from 'vitest'
import { quantize } from '../src/renderer/src/paint/painter'

function image(colors: [number, number, number][], counts: number[]): Uint8ClampedArray {
  const out: number[] = []
  colors.forEach(([r, g, b], i) => {
    for (let k = 0; k < counts[i]; k++) out.push(r, g, b, 255)
  })
  return new Uint8ClampedArray(out)
}

describe('quantize', () => {
  it('returns at most the requested number of colors', () => {
    const px = new Uint8ClampedArray(64 * 64 * 4)
    for (let i = 0; i < px.length; i += 4) {
      px[i] = (i * 7) % 256
      px[i + 1] = (i * 13) % 256
      px[i + 2] = (i * 29) % 256
      px[i + 3] = 255
    }
    for (const n of [1, 5, 24]) {
      const pal = quantize(px, n)
      expect(pal.length).toBeLessThanOrEqual(n)
      expect(pal.length).toBeGreaterThan(0)
    }
  })

  it('returns exactly the two colors of a two-color image', () => {
    const pal = quantize(image([[255, 30, 80], [25, 240, 122]], [90, 10]), 24)
    expect(pal).toHaveLength(2)
    expect(pal).toContainEqual([255, 30, 80])
    expect(pal).toContainEqual([25, 240, 122])
  })

  it('ignores transparent pixels', () => {
    const px = image([[10, 20, 30], [200, 0, 0]], [5, 5])
    for (let i = 20; i < px.length; i += 4) px[i + 3] = 0
    expect(quantize(px, 8)).toEqual([[10, 20, 30]])
    expect(quantize(new Uint8ClampedArray(0), 8)).toEqual([])
  })
})
