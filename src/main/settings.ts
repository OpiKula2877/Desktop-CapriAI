import { EventEmitter } from 'node:events'
import { safeStorage } from 'electron'
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from '../shared/defaults'
import type { ProviderKind, Settings } from '../shared/types'
import { JsonStore, deepMerge } from './store'

let store: JsonStore<Settings>
let keyStore: JsonStore<Partial<Record<ProviderKind, string>>>

export const settingsEvents = new EventEmitter()

export function initSettings(): void {
  store = new JsonStore<Settings>('settings', DEFAULT_SETTINGS, (stored, defaults) => migrate(deepMerge(defaults, stored), stored))
  keyStore = new JsonStore('keys', {})
}

export function getSettings(): Settings {
  return store.get()
}

export function updateSettings(patch: unknown): Settings {
  const prev = store.get()
  const next = deepMerge(prev, patch)
  next.personality.volatility = clamp(Math.round(next.personality.volatility), 0, 100)
  store.set(next)
  settingsEvents.emit('changed', next, prev)
  return next
}

export function setApiKey(kind: ProviderKind, key: string): void {
  const keys = { ...keyStore.get() }
  if (!key) delete keys[kind]
  else if (safeStorage.isEncryptionAvailable()) keys[kind] = 'enc:' + safeStorage.encryptString(key).toString('base64')
  else keys[kind] = 'raw:' + Buffer.from(key, 'utf8').toString('base64')
  keyStore.set(keys)
}

export function getApiKey(kind: ProviderKind): string {
  const v = keyStore.get()[kind]
  if (!v) return ''
  if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'))
  if (v.startsWith('raw:')) return Buffer.from(v.slice(4), 'base64').toString('utf8')
  return ''
}

export function hasApiKey(kind: ProviderKind): boolean {
  return Boolean(keyStore.get()[kind])
}

/** Upgrade settings saved by older versions. */
function migrate(s: Settings, stored: unknown): Settings {
  const v = (stored as { version?: number })?.version ?? 1
  if (v < 2) {
    // v1 stored the window's top-left at a 320x440 size; v2 stores the point under her feet,
    // and Capri got smaller by default.
    if (s.avatar.x !== null && s.avatar.y !== null) {
      s.avatar.x = Math.round(s.avatar.x + (320 * (s.avatar.scale || 1)) / 2)
      s.avatar.y = Math.round(s.avatar.y + 440 * (s.avatar.scale || 1))
    }
    s.avatar.scale = Math.min(s.avatar.scale || 0.7, 0.7)
  }
  s.version = SETTINGS_VERSION
  return s
}

function clamp(n: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, Number.isFinite(n) ? n : a))
}
