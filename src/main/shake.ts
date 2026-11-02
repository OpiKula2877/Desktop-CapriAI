// Shaking Capri by dragging her back and forth annoys her. Past a threshold she refuses to be
// moved at all; keep grabbing her and she blacks out every screen (see blackout.ts).
import { startBlackout } from './blackout'
import { applyAnnoyance, getMood, onMoodChange } from './mood'
import { send } from './windows'

/** Anger from which she won't let you drag her any more. */
export const LOCK_AT = 60

const SHAKE_LINES = [
  'Pusť mě!',
  'Nejsem antistresový míček, choombo.',
  'Hej! Točí se mi RAM.',
  'Ještě jednou a uvidíš.',
  'Přestaň se mnou cloumat, masový pytli.'
]
const DENY_LINES = ['Nesahej na mě.', 'Ne. Už ne.', 'Ruce pryč od mýho kódu.', 'Zkus to ještě jednou. Fakt. Zkus.', 'Varuju tě.']

let lastLine = 0
let locked = false

function pick(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)]
}

function sayThrottled(lines: string[], gap = 2500): void {
  if (Date.now() - lastLine < gap) return
  lastLine = Date.now()
  send('avatar', 'avatar:say', pick(lines))
}

export function isDragLocked(): boolean {
  return locked
}

function syncLock(): void {
  const m = getMood()
  const want = Boolean(m.grudge) || m.meltdown || m.anger >= LOCK_AT
  if (want === locked) return
  locked = want
  send('avatar', 'avatar:locked', locked)
}

export function initShake(): void {
  onMoodChange(syncLock)
  syncLock()
}

/** One sharp direction reversal while she is being dragged (intensity ≈ speed in px/ms, ≤ 3). */
export function onShake(intensity: number): void {
  if (locked) return
  applyAnnoyance(1.4 * Math.max(0.5, Math.min(3, intensity)), () => void startBlackout())
  if (getMood().anger > 25) sayThrottled(SHAKE_LINES)
}

/** The user tried to grab her while she refuses. */
export function onDragDenied(): void {
  applyAnnoyance(7, () => void startBlackout())
  if (!getMood().grudge) sayThrottled(DENY_LINES, 1200)
}
