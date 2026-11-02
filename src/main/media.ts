import type { NowPlaying } from '../shared/types'
import { getSettings } from './settings'
import { winHelper } from './winHelper'

let current: NowPlaying | null = null
let timer: NodeJS.Timeout | null = null
const listeners = new Set<(np: NowPlaying | null, prev: NowPlaying | null) => void>()

export function currentNowPlaying(): NowPlaying | null {
  return current
}

export function onNowPlaying(cb: (np: NowPlaying | null, prev: NowPlaying | null) => void): void {
  listeners.add(cb)
}

async function poll(): Promise<void> {
  let np: NowPlaying | null = null
  try {
    np = (await winHelper.call<NowPlaying | null>('media', {}, 6000)) ?? null
    if (np && !np.title) np = null
  } catch {
    np = current
  }
  const changed = JSON.stringify(np) !== JSON.stringify(current)
  if (changed) {
    const prev = current
    current = np
    for (const l of listeners) l(np, prev)
  }
}

export function startMediaWatch(): void {
  if (timer) return
  const loop = async () => {
    if (getSettings().music.enabled) await poll()
    else if (current) {
      const prev = current
      current = null
      for (const l of listeners) l(null, prev)
    }
    timer = setTimeout(loop, 3000)
  }
  void loop()
}
