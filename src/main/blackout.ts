// The blackout prank: when shaking pushes Capri over the edge, every monitor goes black, after
// 3 s the picture glitches back block by block from the centre – and she stands in the middle,
// arms crossed, refusing to do anything until you apologise in the chat.
// Screenshots used for the rebuild live only in memory and are never saved. A hard timeout and the
// panic hotkey always give the screens back.
import { screen } from 'electron'
import { getMood, setGrudge } from './mood'
import { enterWait, goHome } from './roam'
import {
  avatarSize,
  captureAllDisplays,
  getWin,
  hideOverlay,
  placeAvatar,
  send,
  setAvatarShown,
  stageBlackout
} from './windows'

const BLACK_MS = 3000
const REBUILD_MS = 2600
const HARD_LIMIT_MS = 9000

let running = false
let hardStop: NodeJS.Timeout | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function blackoutRunning(): boolean {
  return running
}

export async function startBlackout(): Promise<void> {
  if (running) return
  running = true
  setGrudge(true)
  hideOverlay()
  setAvatarShown(false)
  getWin('cursor')?.hide()
  hardStop = setTimeout(() => void endScreens(), HARD_LIMIT_MS)
  try {
    await sleep(260) // let her windows disappear before the desktop is photographed
    const images = await captureAllDisplays()
    if (!running) return
    await stageBlackout('black')
    await sleep(BLACK_MS)
    if (!running) return
    await stageBlackout('rebuild', images, REBUILD_MS)
    await sleep(REBUILD_MS - 300)
    if (!running) return

    // She was waiting behind it all along: centre of the primary screen.
    const wa = screen.getPrimaryDisplay().workArea
    const { w, h } = avatarSize()
    placeAvatar(wa.x + (wa.width - w) / 2, wa.y + (wa.height - h) / 2)
    enterWait()
    setAvatarShown(true)
    getWin('avatar')?.moveTop()
    await sleep(500)
    await stageBlackout('fade', undefined, 700)
    await sleep(750)
  } catch (e) {
    console.warn('[blackout]', e)
  } finally {
    await endScreens()
  }
  if (getMood().grudge) send('avatar', 'avatar:say', 'Tak. A teď se omluv. Čekám.')
}

async function endScreens(): Promise<void> {
  if (hardStop) clearTimeout(hardStop)
  hardStop = null
  if (!running) return
  running = false
  await stageBlackout('end')
  setAvatarShown(true)
}

/** Panic hotkey / tray: screens back immediately and the grudge is dropped. */
export async function abortBlackout(): Promise<void> {
  await endScreens()
  if (getMood().grudge) {
    setGrudge(false)
    void goHome()
  }
}

/** Called after an accepted apology. */
export function forgiveGrudge(): void {
  setGrudge(false)
  send('avatar', 'avatar:glitch')
  void goHome()
}
