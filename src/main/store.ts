import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Tiny JSON file store in userData with atomic writes. */
export class JsonStore<T> {
  private file: string
  private data: T

  constructor(name: string, defaults: T, merge: (stored: unknown, defaults: T) => T = (s) => s as T) {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.file = join(dir, `${name}.json`)
    let stored: unknown = undefined
    try {
      if (existsSync(this.file)) stored = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      stored = undefined
    }
    this.data = stored === undefined ? structuredClone(defaults) : merge(stored, structuredClone(defaults))
  }

  get(): T {
    return this.data
  }

  set(data: T): void {
    this.data = data
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}

/** Deep merge: values from `patch` win, plain objects are merged recursively. Arrays are replaced. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge(out[k], v) : v
  }
  return out as T
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
