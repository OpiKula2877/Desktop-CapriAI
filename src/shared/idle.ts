// Pure helpers for Capri's free time: "is the user away?" and where keys sit on the Windows
// on-screen keyboard (osk.exe), so her cursor can hop over the right key.

export interface AwayInput {
  /** Seconds since the last real mouse / keyboard input (powerMonitor.getSystemIdleTime). */
  idleSec: number
  awayMinutes: number
  /** Something is playing in a media session… */
  mediaPlaying: boolean
  /** …and it is a music app (music alone doesn't mean you are watching). */
  mediaIsMusic: boolean
  /** The foreground window covers its whole monitor (game, film, presentation). */
  fullscreen: boolean
}

export function isAway(a: AwayInput): boolean {
  if (a.idleSec < a.awayMinutes * 60) return false
  if (a.mediaPlaying && !a.mediaIsMusic) return false // watching a video
  if (a.fullscreen) return false
  return true
}

/** Local date-time for file names, e.g. 2026-11-02_09-53. */
export function localStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`
}

/** The user is back: any input in the last couple of seconds. */
export function isBack(idleSec: number): boolean {
  return idleSec < 2
}

// ---------------- on-screen keyboard ----------------
// osk.exe (Windows 11) draws ~15.5 key units per row in the left ~84 % of its window (the right
// part holds Home / PgUp / Navigace…), below the title bar and an empty strip. Rows: numbers,
// Tab row, Caps row, Shift row, Space row. Measured from a real screenshot of the window.
const KEYS_LEFT = 0.003
const KEYS_RIGHT = 0.842
const ROWS_TOP = 0.25
const ROWS_BOTTOM = 0.985
const UNITS = 15.5

// [row, unit offset of the first key] + the keys of that row (Czech QWERTZ layout).
const ROWS: [number, number, string][] = [
  [0, 1.9, '+ěščřžýáíé='],
  [1, 1.4, 'qwertzuiopú)'],
  [2, 1.8, 'asdfghjklů§'],
  [3, 2.3, 'yxcvbnm,.-']
]

const STRIP: Record<string, string> = { ó: 'o', ď: 'd', ť: 't', ň: 'n', ě: 'ě' }

/** Centre of a key as a fraction (0..1) of the OSK window. Unknown characters → space bar. */
export function oskKeyFraction(ch: string): { fx: number; fy: number } {
  const c = STRIP[ch.toLowerCase()] ?? ch.toLowerCase()
  const rowH = (ROWS_BOTTOM - ROWS_TOP) / 5
  const unitW = (KEYS_RIGHT - KEYS_LEFT) / UNITS
  if (c === '\n') return { fx: KEYS_LEFT + unitW * 14.3, fy: ROWS_TOP + rowH * 1.5 }
  for (const [row, offset, keys] of ROWS) {
    const i = keys.indexOf(c)
    if (i >= 0) return { fx: KEYS_LEFT + unitW * (offset + i + 0.5), fy: ROWS_TOP + rowH * (row + 0.5) }
  }
  if (/[0-9]/.test(c)) {
    // Digits share the number row (Shift + ěščř… on Czech keyboards).
    const i = c === '0' ? 9 : Number(c) - 1
    return { fx: KEYS_LEFT + unitW * (1.9 + i + 0.5), fy: ROWS_TOP + rowH * 0.5 }
  }
  return { fx: KEYS_LEFT + unitW * 7, fy: ROWS_TOP + rowH * 4.5 } // space bar
}
