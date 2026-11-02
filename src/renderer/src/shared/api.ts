import type { EventChannel, InvokeChannel } from '@shared/ipc'

interface CapriBridge {
  invoke<T = unknown>(channel: InvokeChannel, ...args: unknown[]): Promise<T>
  on(channel: EventChannel, cb: (...args: any[]) => void): () => void
  pathForFile(file: File): string
}

declare global {
  interface Window {
    capri: CapriBridge
  }
}

export const api = window.capri
