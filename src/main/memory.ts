import { randomUUID } from 'node:crypto'
import type { MemoryItem } from '../shared/types'
import { JsonStore } from './store'

const MAX_ITEMS = 200
let store: JsonStore<MemoryItem[]>

export function initMemory(): void {
  store = new JsonStore<MemoryItem[]>('memory', [])
}

export function listMemories(): MemoryItem[] {
  return store.get()
}

export function addMemory(text: string): MemoryItem | null {
  const t = text.trim().slice(0, 300)
  if (!t) return null
  const items = store.get()
  if (items.some((m) => m.text.toLowerCase() === t.toLowerCase())) return null
  const item = { id: randomUUID(), text: t, createdAt: Date.now() }
  store.set([...items, item].slice(-MAX_ITEMS))
  return item
}

export function deleteMemory(id: string): void {
  store.set(store.get().filter((m) => m.id !== id))
}

export function clearMemories(): void {
  store.set([])
}
