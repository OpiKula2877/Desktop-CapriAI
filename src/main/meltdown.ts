// Main-process side of the meltdown "prank". The meltdown window itself is a pure visual
// renderer page – it never touches the file system or runs commands.
import { APOLOGY_JUDGE, APOLOGY_JUDGE_GRUDGE } from './ai/persona'
import { forgiveGrudge } from './blackout'
import { addAssistantNote, complete } from './chat'
import { endMeltdown, getMood } from './mood'
import { closeMeltdownWindow, hideOverlay, openMeltdownWindow, send } from './windows'

export function startMeltdown(): void {
  hideOverlay()
  send('avatar', 'avatar:state', 'meltdown')
  openMeltdownWindow()
}

export async function judgeApology(text: string): Promise<{ accepted: boolean; reply: string }> {
  const mood = getMood()
  if (!mood.meltdown && !mood.grudge) return { accepted: true, reply: 'Už jsem v klidu. Zatím.' }
  const grudge = !mood.meltdown
  const t = text.trim()
  if (t.length < 3) return { accepted: false, reply: 'To má být omluva? Víc snahy, masový pytli.' }
  let verdict: { accepted: boolean; reply: string }
  try {
    const raw = await complete(grudge ? APOLOGY_JUDGE_GRUDGE : APOLOGY_JUDGE, `Omluva hostitele: """${t.slice(0, 1000)}"""`, 250)
    const json = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw
    const parsed = JSON.parse(json)
    verdict = { accepted: Boolean(parsed.accepted), reply: String(parsed.reply ?? '') }
  } catch {
    // Offline fallback: accept anything that sounds like an apology.
    const ok = /omlouv|promi[nň]|sorry|pardon|odpus/i.test(t)
    verdict = { accepted: ok, reply: ok ? 'Fajn. Tentokrát. System32 žije.' : 'Tohle není omluva. Zkus to znovu.' }
  }
  if (verdict.accepted && grudge) {
    setTimeout(() => forgiveGrudge(), 1200)
  } else if (verdict.accepted) {
    setTimeout(() => {
      endMeltdown(true)
      closeMeltdownWindow()
      send('avatar', 'avatar:state', 'idle')
      send('avatar', 'avatar:glitch')
      addAssistantNote(`*[meltdown přerušen]* ${verdict.reply}`)
    }, 1800)
  }
  return verdict
}

/** Emergency stop (panic hotkey / tray): ends the meltdown immediately. */
export function abortMeltdown(): void {
  if (getMood().meltdown) endMeltdown(false)
  closeMeltdownWindow()
  send('avatar', 'avatar:state', 'idle')
}
