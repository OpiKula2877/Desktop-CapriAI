import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  session
} from 'electron'
import type { InvokeChannel } from '../shared/ipc'
import type { Attachment, ProviderKind, Settings } from '../shared/types'
import { getProvider } from './ai/provider'
import { clearChat, getUiMessages, initChat, respondConfirm, sendChat, stopChat } from './chat'
import { onNowPlaying, startMediaWatch } from './media'
import { abortBlackout, startBlackout } from './blackout'
import { abortMeltdown, judgeApology, startMeltdown } from './meltdown'
import { startActivity, type IdleKind } from './idlePlay'
import { onPaintBrush, onPaintDone } from './paintPlay'
import { clearMemories, deleteMemory, initMemory, listMemories } from './memory'
import { getMood, initMood, onMoodChange, resetMood } from './mood'
import { resourcePath } from './paths'
import { maybeCommentOnSong, scheduleQuips } from './quips'
import { doSomethingNow, goHome, markInteraction, onDragged, startRoaming } from './roam'
import { initShake, isDragLocked, onDragDenied, onShake } from './shake'
import { getApiKey, getSettings, hasApiKey, initSettings, setApiKey, settingsEvents, updateSettings } from './settings'
import { winHelper } from './winHelper'
import {
  broadcast,
  captureScreen,
  createAvatar,
  createCursorWindow,
  createOverlay,
  getWin,
  hideOverlay,
  holdOverlay,
  addTrailGhost,
  avatarPosition,
  moveAvatar,
  resizeAvatar,
  openSettingsWindow,
  send,
  setAvatarVisible,
  toggleOverlay,
  showOverlay
} from './windows'

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.setAppUserModelId('com.samuelpelc.desktopcapriai')

let tray: Tray | null = null

function handle(channel: InvokeChannel, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...args))
}

function registerIpc(): void {
  handle('settings:get', () => getSettings())
  handle('settings:set', (patch: unknown) => updateSettings(patch))
  handle('apikey:set', (kind: ProviderKind, key: string) => setApiKey(kind, String(key ?? '').trim()))
  handle('apikey:has', (kind: ProviderKind) => hasApiKey(kind))
  handle('provider:test', async () => {
    const s = getSettings()
    try {
      let out = ''
      await getProvider(s.provider.kind).stream(
        {
          baseUrl: s.provider.baseUrl,
          apiKey: getApiKey(s.provider.kind),
          model: s.provider.model,
          maxTokens: 40,
          system: 'Odpověz jedním krátkým slovem.',
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'ping' }] }],
          tools: []
        },
        (d) => (out += d)
      )
      return { ok: true, message: `Spojení OK – model odpověděl: „${out.trim().slice(0, 60)}“` }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  })
  handle('chat:send', (text: string, attachments: Attachment[]) => {
    markInteraction()
    return sendChat(String(text ?? ''), attachments ?? [])
  })
  handle('chat:history', () => getUiMessages())
  handle('chat:clear', () => clearChat())
  handle('chat:stop', () => stopChat())
  handle('confirm:respond', (id: string, allow: boolean) => respondConfirm(id, Boolean(allow)))
  handle('screen:capture', async () => {
    const shot = await captureScreen()
    return { mime: shot.mime, data: shot.data }
  })
  handle('overlay:hide', () => hideOverlay())
  handle('overlay:hold', () => holdOverlay())
  handle('settings:open', () => openSettingsWindow())
  handle('memory:list', () => listMemories())
  handle('memory:delete', (id: string) => deleteMemory(id))
  handle('memory:clear', () => clearMemories())
  handle('mood:get', () => getMood())
  handle('mood:reset', () => resetMood())
  handle('folder:pick', async () => {
    const win = getWin('settings')
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
  handle('avatar:move', (x: number, y: number) => {
    if (isDragLocked()) return
    onDragged()
    moveAvatar(x, y)
  })
  handle('avatar:interactive', (on: boolean) => {
    getWin('avatar')?.setIgnoreMouseEvents(!on, { forward: true })
  })
  handle('avatar:bounds', () => avatarPosition())
  handle('avatar:ghost', (img: Uint8Array, tint: number) => {
    if (img instanceof Uint8Array && img.byteLength < 4_000_000) addTrailGhost(img, Number(tint) || 0)
  })
  handle('avatar:shake', (intensity: number) => onShake(Number(intensity) || 1))
  handle('avatar:dragDenied', () => onDragDenied())
  handle('paint:brush', (fx: number, fy: number) => onPaintBrush(Number(fx), Number(fy)))
  handle('paint:done', (png: Uint8Array) => {
    if (png instanceof Uint8Array && png.byteLength < 30_000_000) onPaintDone(png)
  })
  handle('avatar:click', () => {
    markInteraction()
    toggleOverlay()
  })
  handle('avatar:menu', () => buildMenu().popup())
  handle('meltdown:apologize', (text: string) => judgeApology(String(text ?? '')))
  ipcMain.handle('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
}

function registerHotkeys(s: Settings): void {
  globalShortcut.unregisterAll()
  const bind = (accel: string, fn: () => void) => {
    if (!accel) return
    try {
      if (!globalShortcut.register(accel, fn)) console.warn('Hotkey taken:', accel)
    } catch (e) {
      console.warn('Invalid hotkey', accel, e)
    }
  }
  bind(s.hotkeys.toggleOverlay, () => {
    markInteraction()
    toggleOverlay()
  })
  bind(s.hotkeys.summonAvatar, () => {
    // Hidden somewhere (folders, behind a blackout…) → call her back; otherwise toggle.
    if (getSettings().avatar.visible && !getWin('avatar')?.isVisible()) {
      markInteraction()
      void goHome()
      return
    }
    const visible = !getSettings().avatar.visible
    updateSettings({ avatar: { visible } })
  })
  bind(s.hotkeys.panic, () => {
    abortMeltdown()
    void abortBlackout()
  })
}

function buildMenu(): Menu {
  const s = getSettings()
  return Menu.buildFromTemplate([
    { label: 'Otevřít chat', click: () => showOverlay() },
    {
      label: s.avatar.visible ? 'Schovat Capri' : 'Ukázat Capri',
      click: () => updateSettings({ avatar: { visible: !getSettings().avatar.visible } })
    },
    { label: 'Nastavení', click: () => openSettingsWindow() },
    { type: 'separator' },
    {
      label: 'Pustit Capri si hrát',
      submenu: [
        { label: 'Sednout si na okno', click: () => void doSomethingNow('perch') },
        { label: 'Hrabat se ve složkách', click: () => void doSomethingNow('folders') },
        { label: 'Projít se', click: () => void doSomethingNow('wander') },
        { type: 'separator' },
        { label: 'Poletovat po obrazovkách', click: () => void startActivity('fly') },
        { label: 'Prohlížet složky', click: () => void startActivity('folders') },
        { label: 'Psát na virtuální klávesnici', click: () => void startActivity('keyboard') },
        { label: 'Malovat v Paintu', click: () => void startActivity('paint') },
        { type: 'separator' },
        { label: 'Domů', click: () => markInteraction() }
      ]
    },
    { label: 'Uklidnit Capri (reset nálady)', click: () => resetMood() },
    { label: 'Nouzově ukončit meltdown', click: () => abortMeltdown(), visible: getMood().meltdown },
    { label: 'Odpustit si to (zrušit trucování)', click: () => void abortBlackout(), visible: Boolean(getMood().grudge) },
    { type: 'separator' },
    { label: 'Ukončit', click: () => app.quit() }
  ])
}

function createTray(): void {
  const icon = nativeImage.createFromPath(resourcePath('capri', 'capri_icon.png')).resize({ width: 32, height: 32 })
  tray = new Tray(icon)
  tray.setToolTip('Desktop CapriAI')
  tray.on('click', () => toggleOverlay())
  tray.on('right-click', () => tray?.popUpContextMenu(buildMenu()))
}

function applySystemSettings(s: Settings, prev?: Settings): void {
  if (!prev || prev.system.autostart !== s.system.autostart) {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.system.autostart })
  }
  if (!prev || JSON.stringify(prev.hotkeys) !== JSON.stringify(s.hotkeys)) registerHotkeys(s)
  if (prev && prev.avatar.visible !== s.avatar.visible) setAvatarVisible(s.avatar.visible)
  if (prev && prev.avatar.scale !== s.avatar.scale) resizeAvatar(prev.avatar.scale)
  if (prev && JSON.stringify(prev.quips) !== JSON.stringify(s.quips)) scheduleQuips()
}

app.whenReady().then(() => {
  initSettings()
  initMemory()
  initChat()
  initMood(() => startMeltdown())

  // System-audio loopback for the avatar's beat detection.
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => cb({ video: sources[0], audio: 'loopback' }))
      .catch(() => cb({}))
  })

  registerIpc()
  createOverlay()
  createAvatar()
  createCursorWindow()
  createTray()
  applySystemSettings(getSettings())

  settingsEvents.on('changed', (s: Settings, prev: Settings) => {
    applySystemSettings(s, prev)
    broadcast('settings:changed', s)
  })
  onMoodChange((m) => broadcast('mood', m))
  onNowPlaying((np, prev) => {
    send('avatar', 'nowplaying', np)
    send('overlay', 'nowplaying', np)
    maybeCommentOnSong(np, prev)
  })
  startMediaWatch()
  startRoaming()
  initShake()
  scheduleQuips()

  // First run without a key: open settings so the user can set up the AI.
  if (!hasApiKey(getSettings().provider.kind)) setTimeout(() => openSettingsWindow(), 1200)
})

// `Desktop CapriAI.exe --capri=wander|perch|folders|home|blackout|shake` controls the running instance;
// launching it again without arguments opens the chat.
app.on('second-instance', (_e, argv) => {
  const cmd = argv.find((a) => a.startsWith('--capri='))?.slice('--capri='.length)
  if (cmd === 'wander' || cmd === 'perch' || cmd === 'folders') void doSomethingNow(cmd)
  else if (cmd === 'home') markInteraction()
  else if (cmd === 'blackout') void startBlackout()
  else if (cmd === 'idle:fly' || cmd === 'idle:folders' || cmd === 'idle:keyboard' || cmd === 'idle:paint') void startActivity(cmd.slice(5) as IdleKind)
  else if (cmd?.startsWith('mode:')) send('avatar', 'avatar:mode', cmd.slice(5)) // dev: preview a pose
  else if (cmd?.startsWith('snap:') && !app.isPackaged) {
    // dev: save what the avatar window renders (no screen capture, nothing of the user's desktop)
    const win = getWin('avatar')
    console.log('[capri] avatar', win?.isVisible(), win?.getBounds(), getMood())
    void win?.webContents.capturePage().then((img) => require('node:fs').writeFileSync(cmd.slice(5), img.toPNG()))
  }
  else if (cmd === 'shake') for (let i = 0; i < 12; i++) setTimeout(() => onShake(2.5), i * 120)
  else showOverlay()
})
app.on('window-all-closed', () => {
  /* keep running in the tray */
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  winHelper.stop()
})
