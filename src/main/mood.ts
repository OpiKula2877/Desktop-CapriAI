import type { MoodState } from '../shared/types'
import { MELTDOWN_AT, applyDelta, decay } from './moodMeter'
import { getSettings } from './settings'
import { JsonStore } from './store'

interface Persisted {
  anger: number
  at: number
}

let store: JsonStore<Persisted>
let state: MoodState = { anger: 0, meltdown: false }
const listeners = new Set<(s: MoodState) => void>()
let onMeltdown: () => void = () => {}

export function initMood(meltdownHandler: () => void): void {
  onMeltdown = meltdownHandler
  store = new JsonStore<Persisted>('mood', { anger: 0, at: Date.now() })
  const p = store.get()
  state.anger = decay(p.anger, (Date.now() - p.at) / 60_000, getSettings().personality.volatility)
  setInterval(() => {
    if (state.meltdown || state.grudge || state.anger <= 0) return
    set(decay(state.anger, 0.5, getSettings().personality.volatility))
  }, 30_000)
}

export function getMood(): MoodState {
  return { ...state }
}

export function onMoodChange(cb: (s: MoodState) => void): void {
  listeners.add(cb)
}

function set(anger: number, meltdown = state.meltdown, grudge = state.grudge ?? false): void {
  state = { anger: Math.round(anger * 10) / 10, meltdown, grudge }
  store.set({ anger: state.anger, at: Date.now() })
  for (const l of listeners) l(getMood())
}

/** Apply the sum of mood-tag deltas from one reply. */
export function applyMood(delta: number): void {
  if (!delta || state.meltdown) return
  const s = getSettings()
  const next = applyDelta(state.anger, delta, s.personality.volatility)
  if (next >= MELTDOWN_AT && s.personality.meltdownEnabled) {
    set(MELTDOWN_AT, true)
    onMeltdown()
  } else {
    set(Math.min(next, s.personality.meltdownEnabled ? next : 95))
  }
}

/**
 * Annoyance from the user's hands (shaking, grabbing her while she refuses). Reaching the top
 * calls `onPeak` (the blackout) when enabled, otherwise the classic meltdown.
 */
export function applyAnnoyance(delta: number, onPeak: () => void): void {
  if (state.meltdown || state.grudge) return
  const s = getSettings()
  const next = applyDelta(state.anger, delta, s.personality.volatility)
  if (next >= MELTDOWN_AT && s.personality.blackoutEnabled) {
    set(MELTDOWN_AT)
    onPeak()
  } else if (next >= MELTDOWN_AT && s.personality.meltdownEnabled) {
    set(MELTDOWN_AT, true)
    onMeltdown()
  } else set(Math.min(next, 95))
}

export function setGrudge(on: boolean): void {
  set(on ? MELTDOWN_AT : 35, false, on)
}

export function endMeltdown(forgiven: boolean): void {
  set(forgiven ? 35 : 60, false)
}

export function resetMood(): void {
  set(0, false, false)
}
