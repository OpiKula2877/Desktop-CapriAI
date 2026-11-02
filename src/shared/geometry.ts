// Pure geometry helpers (DIP coordinates), shared by main and tests.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function distToRect(px: number, py: number, r: Rect): number {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.width))
  const dy = Math.max(r.y - py, 0, py - (r.y + r.height))
  return Math.hypot(dx, dy)
}

/** The rect containing the point, or the nearest one. */
export function pickRect(px: number, py: number, rects: Rect[]): Rect {
  let best = rects[0]
  let bestD = Infinity
  for (const r of rects) {
    const d = distToRect(px, py, r)
    if (d < bestD) {
      best = r
      bestD = d
    }
  }
  return best
}

/** Top-left position that keeps a w×h box completely inside `b` (not one pixel outside). */
export function clampInto(x: number, y: number, w: number, h: number, b: Rect): { x: number; y: number } {
  const cx = Math.round(Math.min(Math.max(x, b.x), b.x + Math.max(0, b.width - w)))
  const cy = Math.round(Math.min(Math.max(y, b.y), b.y + Math.max(0, b.height - h)))
  return { x: cx, y: cy }
}

/**
 * Keep a box fully on one display. The display is the one under `anchor` (e.g. the mouse while
 * dragging) or, by default, the one under the box centre.
 */
export function clampToDisplays(
  x: number,
  y: number,
  w: number,
  h: number,
  displays: Rect[],
  anchor?: { x: number; y: number }
): { x: number; y: number; display: Rect } {
  const a = anchor ?? { x: x + w / 2, y: y + h / 2 }
  const display = pickRect(a.x, a.y, displays)
  return { ...clampInto(x, y, w, h, display), display }
}

/**
 * Order of w×h blocks for the blackout rebuild: from the centre outward, with a little jitter so
 * the front looks ragged. Returns block indices (row * cols + col).
 */
export function blockOrder(cols: number, rows: number, jitter = 0.35, rand: () => number = Math.random): number[] {
  const cx = (cols - 1) / 2
  const cy = (rows - 1) / 2
  const maxD = Math.hypot(cx, cy) || 1
  const items: { i: number; k: number }[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const d = Math.hypot(c - cx, r - cy) / maxD
      items.push({ i: r * cols + c, k: d + (rand() - 0.5) * jitter })
    }
  }
  return items.sort((a, b) => a.k - b.k).map((it) => it.i)
}
