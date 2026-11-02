import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resourcePath } from './paths'

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/** JSON-lines bridge to resources/scripts/winhelper.ps1 (Win32 + WinRT calls). */
class WinHelper {
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private ready: Promise<void> | null = null

  private start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise((resolveReady, rejectReady) => {
      const proc = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resourcePath('scripts', 'winhelper.ps1')],
        { windowsHide: true }
      )
      this.proc = proc
      const rl = createInterface({ input: proc.stdout })
      rl.on('line', (line) => {
        let msg: { id: number; ok: boolean; result?: unknown; error?: string }
        try {
          msg = JSON.parse(line.replace(/^﻿/, ''))
        } catch {
          return
        }
        if (msg.id === 0) return resolveReady()
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error || 'winhelper error'))
      })
      proc.stderr.on('data', (d) => console.warn('[winhelper]', String(d).trim()))
      proc.on('exit', () => {
        this.proc = null
        this.ready = null
        for (const p of this.pending.values()) p.reject(new Error('winhelper exited'))
        this.pending.clear()
        rejectReady(new Error('winhelper exited before ready'))
      })
    })
    return this.ready
  }

  async call<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
    await this.start()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`winhelper timeout: ${cmd}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc!.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n')
    })
  }

  stop(): void {
    this.proc?.kill()
  }
}

export const winHelper = new WinHelper()

export interface WinInfo {
  hwnd: number
  title: string
  process: string
  x: number
  y: number
  w: number
  h: number
  minimized: boolean
  /** Win32 window class, e.g. CabinetWClass for File Explorer. */
  cls: string
}
