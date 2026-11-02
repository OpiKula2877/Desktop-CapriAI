// Pure anger-meter math, kept separate from Electron so it can be unit tested.

export const MELTDOWN_AT = 100

/**
 * Scale a raw mood delta from the model by volatility (0–100, 100 = most explosive).
 * Anger grows much faster with high volatility; calming down is faster with low volatility.
 */
export function scaleDelta(delta: number, volatility: number): number {
  const v = Math.min(100, Math.max(0, volatility)) / 100
  if (delta > 0) return delta * (0.15 + 1.85 * v * v)
  return delta * (1.6 - v)
}

/** Passive cool-down per elapsed minute. */
export function decay(anger: number, minutes: number, volatility: number): number {
  const perMinute = 3 - 2 * (Math.min(100, Math.max(0, volatility)) / 100)
  return Math.max(0, anger - perMinute * minutes)
}

export function applyDelta(anger: number, delta: number, volatility: number): number {
  return Math.min(MELTDOWN_AT, Math.max(0, anger + scaleDelta(delta, volatility)))
}

export function moodLabel(anger: number): string {
  if (anger >= 90) return 'KRITICKÝ'
  if (anger >= 65) return 'VZTEK'
  if (anger >= 40) return 'PODRÁŽDĚNÁ'
  if (anger >= 15) return 'OTRÁVENÁ'
  return 'STABILNÍ'
}
