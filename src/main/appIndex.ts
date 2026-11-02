import { readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { app } from 'electron'

export interface AppEntry {
  name: string
  path: string
}

const SHORTCUT_EXT = new Set(['.lnk', '.url', '.appref-ms'])
let cache: { at: number; entries: AppEntry[] } | null = null

function startMenuRoots(): string[] {
  const roots = [
    join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    app.getPath('desktop'),
    join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop')
  ]
  return roots.filter(Boolean)
}

function walk(dir: string, out: AppEntry[], depth = 0): void {
  if (depth > 4) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    const p = join(dir, n)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out, depth + 1)
    else if (SHORTCUT_EXT.has(extname(n).toLowerCase())) out.push({ name: basename(n, extname(n)), path: p })
  }
}

export function listApps(): AppEntry[] {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.entries
  const entries: AppEntry[] = []
  for (const r of startMenuRoots()) walk(r, entries)
  cache = { at: Date.now(), entries }
  return entries
}

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Score how well `query` matches app `name`; 0 = no match. */
export function matchScore(query: string, name: string): number {
  const q = normalize(query)
  const n = normalize(name)
  if (!q || !n) return 0
  if (n === q) return 100
  if (n.startsWith(q)) return 80 - Math.min(20, n.length - q.length)
  if (n.includes(q)) return 60 - Math.min(20, n.length - q.length)
  const tokens = q.split(' ')
  if (tokens.every((t) => n.includes(t))) return 40
  return 0
}

export function findApps(query: string, limit = 5): AppEntry[] {
  return listApps()
    .map((a) => ({ a, s: matchScore(query, a.name) - (/uninstall|odinstal/i.test(a.name) ? 50 : 0) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s)
    .slice(0, limit)
    .map((x) => x.a)
}

/** Built-in Windows apps that have no Start Menu shortcut. Values are exe names or URIs. */
export const BUILTIN_APPS: Record<string, string> = {
  notepad: 'notepad.exe',
  'poznamkovy blok': 'notepad.exe',
  calc: 'calc.exe',
  kalkulacka: 'calc.exe',
  calculator: 'calc.exe',
  explorer: 'explorer.exe',
  pruzkumnik: 'explorer.exe',
  'file explorer': 'explorer.exe',
  cmd: 'cmd.exe',
  terminal: 'wt.exe',
  powershell: 'powershell.exe',
  'task manager': 'taskmgr.exe',
  'spravce uloh': 'taskmgr.exe',
  paint: 'mspaint.exe',
  settings: 'ms-settings:',
  nastaveni: 'ms-settings:',
  'control panel': 'control.exe',
  'ovladaci panely': 'control.exe',
  'snipping tool': 'ms-screenclip:'
}
