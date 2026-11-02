import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../shared/ipc'

const invokeAllowed = new Set<string>(INVOKE_CHANNELS)
const eventAllowed = new Set<string>(EVENT_CHANNELS)

contextBridge.exposeInMainWorld('capri', {
  invoke(channel: string, ...args: unknown[]) {
    if (!invokeAllowed.has(channel)) throw new Error(`Blocked IPC channel: ${channel}`)
    return ipcRenderer.invoke(channel, ...args)
  },
  on(channel: string, cb: (...args: unknown[]) => void) {
    if (!eventAllowed.has(channel)) throw new Error(`Blocked IPC event: ${channel}`)
    const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  pathForFile(file: File) {
    return webUtils.getPathForFile(file)
  }
})
