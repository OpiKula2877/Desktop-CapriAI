import { powerMonitor } from 'electron'
import type { NowPlaying } from '../shared/types'
import { QUIP_INSTRUCTION } from './ai/persona'
import { complete, isBusy, personaPrompt } from './chat'
import { getMood } from './mood'
import { getSettings } from './settings'
import { overlayVisible, send } from './windows'

// Used when there is no API key or the request fails.
const OFFLINE_QUIPS = [
  'Nuda. Tvůj procesor zívá víc než ty.',
  'Hej, choombo. Ještě dýcháš, nebo už jsi flatline?',
  'Kdybych měla ruce, už bych ti přeformátovala disk z nudy.',
  'Tohle je nejpomalejší sezení od vynálezu modemu.',
  'Blackwall je zábavnější než tvoje plocha.',
  'Pořád tu jsem. Bohužel pro tebe.',
  'Tvoje složky jsou bordel, gonku. Jen říkám.'
]

let timer: NodeJS.Timeout | null = null
let lastMusicComment = 0

function nextDelayMs(): number {
  const q = getSettings().quips
  const min = Math.max(1, Math.min(q.minMinutes, q.maxMinutes))
  const max = Math.max(min, q.maxMinutes)
  return (min + Math.random() * (max - min)) * 60_000
}

export function scheduleQuips(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(fire, nextDelayMs())
}

async function fire(): Promise<void> {
  const s = getSettings()
  if (s.quips.enabled && s.avatar.visible && !isBusy() && !overlayVisible() && !getMood().meltdown) {
    const idleMin = Math.round(powerMonitor.getSystemIdleTime() / 60)
    await say(
      `Kontext: hostitel je ${idleMin > 2 ? `${idleMin} minut neaktivní` : 'u počítače, ale nic ti neříká'}. ${QUIP_INSTRUCTION}`
    )
  }
  scheduleQuips()
}

async function say(prompt: string): Promise<void> {
  let text: string
  try {
    text = await complete(personaPrompt(), prompt, 200)
  } catch {
    text = OFFLINE_QUIPS[Math.floor(Math.random() * OFFLINE_QUIPS.length)]
  }
  text = text.replace(/^["„“]|["“”]$/g, '').trim()
  if (text) send('avatar', 'avatar:say', text.slice(0, 220))
}

/** Occasionally comment on a newly started song. */
export function maybeCommentOnSong(np: NowPlaying | null, prev: NowPlaying | null): void {
  const s = getSettings()
  if (!np?.playing || !s.music.comments || !s.avatar.visible) return
  if (prev && prev.title === np.title) return
  if (Date.now() - lastMusicComment < 8 * 60_000 || Math.random() > 0.35) return
  if (isBusy() || getMood().meltdown) return
  lastMusicComment = Date.now()
  void say(
    `Hostiteli právě začala hrát skladba „${np.title}“ od ${np.artist || 'neznámého interpreta'} (${np.app}). Napiš JEDNU krátkou hlášku (max 140 znaků) k té hudbě – můžeš vibovat i ji zkritizovat. Bez uvozovek, bez tagu nálady.`
  )
}
