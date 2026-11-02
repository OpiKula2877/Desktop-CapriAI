import { spawn } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { clipboard, screen, shell } from 'electron'
import { FILE_TOOLS } from '../shared/defaults'
import type { Settings, ToolName } from '../shared/types'
import type { ToolDef } from './ai/provider'
import { BUILTIN_APPS, findApps, normalize } from './appIndex'
import { addMemory } from './memory'
import { isPathAllowed } from './permissions'
import { winHelper, type WinInfo } from './winHelper'

export interface ToolOutput {
  text: string
  image?: { mime: string; data: string }
}

export interface Point {
  x: number
  y: number
}

/** Services the tools need from the rest of the app. */
export interface ToolContext {
  settings: Settings
  /** Animate Capri's cursor to a point (DIP screen coordinates). */
  moveCursor(p: Point, label: string, click?: boolean): Promise<void>
  captureScreen(): Promise<{ mime: string; data: string; width: number; height: number }>
  nowPlaying(): Promise<unknown>
}

interface ToolSpec {
  def: ToolDef
  /** Short Czech description of the concrete action for confirm cards and the activity log. */
  summary(args: any): string
  run(args: any, ctx: ToolContext): Promise<ToolOutput>
}

// Mapping of the last screenshot to screen coordinates, used by mouse_click.
let lastShot: { bounds: Electron.Rectangle; width: number; height: number } | null = null

const IMAGE_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

function obj(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required }
}

function str(description: string): Record<string, unknown> {
  return { type: 'string', description }
}

function taskbarPoint(): Point {
  const d = screen.getPrimaryDisplay()
  return { x: d.bounds.x + d.bounds.width / 2, y: d.bounds.y + d.bounds.height - 20 }
}

function windowCenter(w: WinInfo): Point {
  const p = screen.screenToDipPoint({ x: w.x + w.w / 2, y: w.y + Math.min(40, w.h / 2) })
  return p
}

async function findWindow(query: string): Promise<WinInfo | null> {
  const wins = await winHelper.call<WinInfo[]>('windows')
  const q = normalize(query)
  const scored = (wins ?? [])
    .filter((w) => !/desktop capriai/i.test(w.title))
    .map((w) => {
      const t = normalize(w.title)
      const p = normalize(w.process ?? '')
      const s = p === q ? 90 : t.includes(q) ? 70 : p.includes(q) ? 60 : q.split(' ').every((k) => t.includes(k)) ? 40 : 0
      return { w, s }
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
  return scored[0]?.w ?? null
}

const SPECS: Record<ToolName, ToolSpec> = {
  open_app: {
    def: {
      name: 'open_app',
      description: 'Spustí aplikaci na počítači hostitele podle jména (hledá ve Start menu a na ploše). Např. "Spotify", "Discord", "notepad", "kalkulačka".',
      parameters: obj({ name: str('Jméno aplikace') }, ['name'])
    },
    summary: (a) => `spustit aplikaci „${a.name}“`,
    async run(a, ctx) {
      const name = String(a.name ?? '')
      await ctx.moveCursor(taskbarPoint(), `exec ${name}`, true)
      const hit = findApps(name)[0]
      if (hit) {
        const err = await shell.openPath(hit.path)
        if (err) throw new Error(err)
        return { text: `Spuštěno: ${hit.name}` }
      }
      const builtin = BUILTIN_APPS[normalize(name)]
      if (builtin) {
        if (builtin.endsWith(':')) await shell.openExternal(builtin)
        else spawn(builtin, [], { detached: true, stdio: 'ignore' }).unref()
        return { text: `Spuštěno: ${builtin}` }
      }
      throw new Error(`Aplikaci „${name}“ jsem nenašla ve Start menu ani na ploše.`)
    }
  },
  open_url: {
    def: {
      name: 'open_url',
      description: 'Otevře webovou adresu (http/https) ve výchozím prohlížeči. Pro vyhledávání použij např. https://www.google.com/search?q=...',
      parameters: obj({ url: str('Celá URL včetně https://') }, ['url'])
    },
    summary: (a) => `otevřít ${a.url}`,
    async run(a, ctx) {
      const url = new URL(String(a.url))
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Jen http/https adresy.')
      await ctx.moveCursor(taskbarPoint(), `jack-in ${url.hostname}`, true)
      await shell.openExternal(url.toString())
      return { text: `Otevřeno: ${url.toString()}` }
    }
  },
  open_path: {
    def: {
      name: 'open_path',
      description: 'Otevře soubor nebo složku výchozím programem. Jen v povolených složkách.',
      parameters: obj({ path: str('Absolutní cesta') }, ['path'])
    },
    summary: (a) => `otevřít ${a.path}`,
    async run(a, ctx) {
      await ctx.moveCursor(taskbarPoint(), 'open', true)
      const err = await shell.openPath(String(a.path))
      if (err) throw new Error(err)
      return { text: `Otevřeno: ${a.path}` }
    }
  },
  list_dir: {
    def: {
      name: 'list_dir',
      description: 'Vypíše obsah složky (jen v povolených složkách).',
      parameters: obj({ path: str('Absolutní cesta ke složce') }, ['path'])
    },
    summary: (a) => `projít složku ${a.path}`,
    async run(a) {
      const dir = String(a.path)
      const entries = await readdir(dir, { withFileTypes: true })
      const lines: string[] = []
      for (const e of entries.slice(0, 200)) {
        if (e.isDirectory()) lines.push(`[DIR] ${e.name}`)
        else {
          let size = ''
          try {
            size = ` (${Math.round((await stat(join(dir, e.name))).size / 1024)} kB)`
          } catch {
            /* ignore */
          }
          lines.push(`${e.name}${size}`)
        }
      }
      if (entries.length > 200) lines.push(`… a dalších ${entries.length - 200}`)
      return { text: lines.join('\n') || '(prázdná složka)' }
    }
  },
  read_file: {
    def: {
      name: 'read_file',
      description: 'Přečte textový soubor nebo obrázek (jen v povolených složkách, max 100 kB textu).',
      parameters: obj({ path: str('Absolutní cesta k souboru') }, ['path'])
    },
    summary: (a) => `přečíst ${a.path}`,
    async run(a) {
      const path = String(a.path)
      const mime = IMAGE_EXT[extname(path).toLowerCase()]
      const buf = await readFile(path)
      if (mime) {
        if (buf.length > 5 * 1024 * 1024) throw new Error('Obrázek je moc velký.')
        return { text: `Obrázek ${path}`, image: { mime, data: buf.toString('base64') } }
      }
      if (buf.subarray(0, 8000).includes(0)) throw new Error('Binární soubor – to číst nebudu.')
      const text = buf.toString('utf8')
      return { text: text.length > 100_000 ? text.slice(0, 100_000) + '\n…(zkráceno)' : text }
    }
  },
  read_clipboard: {
    def: { name: 'read_clipboard', description: 'Přečte text ze schránky hostitele.', parameters: obj({}) },
    summary: () => 'přečíst schránku',
    async run() {
      const text = await clipboard.readText().catch(() => '')
      if (!text && (await clipboard.has('image/png').catch(() => false))) {
        const items = await clipboard.read()
        const item = items.find((i) => i.types.includes('image/png'))
        if (item) {
          const blob = (await item.getType('image/png')) as Blob
          const data = Buffer.from(await blob.arrayBuffer()).toString('base64')
          return { text: 'Ve schránce je obrázek.', image: { mime: 'image/png', data } }
        }
      }
      return { text: text || '(schránka je prázdná)' }
    }
  },
  write_clipboard: {
    def: {
      name: 'write_clipboard',
      description: 'Zapíše text do schránky hostitele.',
      parameters: obj({ text: str('Text ke zkopírování') }, ['text'])
    },
    summary: () => 'zapsat do schránky',
    async run(a) {
      await clipboard.writeText(String(a.text))
      return { text: 'Zkopírováno do schránky.' }
    }
  },
  take_screenshot: {
    def: {
      name: 'take_screenshot',
      description: 'Udělá screenshot obrazovky hostitele, abys viděla, co dělá. Souřadnice v obrázku lze použít pro mouse_click.',
      parameters: obj({})
    },
    summary: () => 'podívat se na obrazovku',
    async run(_a, ctx) {
      const shot = await ctx.captureScreen()
      const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      lastShot = { bounds: d.bounds, width: shot.width, height: shot.height }
      return { text: `Screenshot ${shot.width}x${shot.height} px.`, image: { mime: shot.mime, data: shot.data } }
    }
  },
  list_windows: {
    def: { name: 'list_windows', description: 'Vypíše otevřená okna na počítači.', parameters: obj({}) },
    summary: () => 'zjistit otevřená okna',
    async run() {
      const wins = (await winHelper.call<WinInfo[]>('windows')) ?? []
      return {
        text: wins
          .filter((w) => !/desktop capriai/i.test(w.title))
          .map((w) => `- ${w.title} [${w.process}]${w.minimized ? ' (minimalizované)' : ''}`)
          .join('\n')
      }
    }
  },
  focus_window: {
    def: {
      name: 'focus_window',
      description: 'Přepne na otevřené okno (podle části názvu nebo jména procesu, např. "chrome", "Discord").',
      parameters: obj({ query: str('Část názvu okna nebo proces') }, ['query'])
    },
    summary: (a) => `přepnout na okno „${a.query}“`,
    async run(a, ctx) {
      const w = await findWindow(String(a.query))
      if (!w) throw new Error(`Okno „${a.query}“ neexistuje.`)
      await ctx.moveCursor(w.minimized ? taskbarPoint() : windowCenter(w), w.process, true)
      await winHelper.call('focus', { hwnd: w.hwnd })
      return { text: `Přepnuto na: ${w.title}` }
    }
  },
  mouse_click: {
    def: {
      name: 'mouse_click',
      description: 'Klikne skutečnou myší na bod v POSLEDNÍM screenshotu (souřadnice v pixelech toho obrázku). Nejdřív si udělej take_screenshot.',
      parameters: obj(
        {
          x: { type: 'number', description: 'X v pixelech screenshotu' },
          y: { type: 'number', description: 'Y v pixelech screenshotu' },
          button: { type: 'string', enum: ['left', 'right'] },
          double: { type: 'boolean' }
        },
        ['x', 'y']
      )
    },
    summary: (a) => `kliknout myší na [${a.x}, ${a.y}]`,
    async run(a, ctx) {
      if (!lastShot) throw new Error('Nejdřív take_screenshot.')
      const dip = {
        x: lastShot.bounds.x + (Number(a.x) / lastShot.width) * lastShot.bounds.width,
        y: lastShot.bounds.y + (Number(a.y) / lastShot.height) * lastShot.bounds.height
      }
      await ctx.moveCursor(dip, 'click', true)
      const phys = screen.dipToScreenPoint(dip)
      await winHelper.call('click', { x: Math.round(phys.x), y: Math.round(phys.y), right: a.button === 'right', double: Boolean(a.double) })
      return { text: 'Kliknuto.' }
    }
  },
  type_text: {
    def: {
      name: 'type_text',
      description: 'Napíše text na klávesnici do aktuálně aktivního okna.',
      parameters: obj({ text: str('Text k napsání') }, ['text'])
    },
    summary: (a) => `napsat „${String(a.text).slice(0, 40)}“`,
    async run(a) {
      await winHelper.call('type', { text: String(a.text) }, 20000)
      return { text: 'Napsáno.' }
    }
  },
  now_playing: {
    def: { name: 'now_playing', description: 'Zjistí, jaká hudba/média právě hrají.', parameters: obj({}) },
    summary: () => 'zjistit co hraje',
    async run(_a, ctx) {
      const np = await ctx.nowPlaying()
      return { text: np ? JSON.stringify(np) : 'Nic nehraje.' }
    }
  },
  remember: {
    def: {
      name: 'remember',
      description: 'Uloží si do dlouhodobé paměti důležitý fakt o hostiteli (jméno, záliby, projekty, čím tě štve). Používej střídmě, jen pro trvalé věci.',
      parameters: obj({ fact: str('Krátký fakt, např. "Jmenuje se Samuel a programuje v TypeScriptu"') }, ['fact'])
    },
    summary: (a) => `zapamatovat si: ${a.fact}`,
    async run(a) {
      const m = addMemory(String(a.fact))
      return { text: m ? 'Uloženo.' : 'Tohle už vím.' }
    }
  }
}

export function enabledTools(settings: Settings): ToolName[] {
  return (Object.keys(SPECS) as ToolName[]).filter((n) => {
    if (settings.permissions[n] === 'off') return false
    if (n === 'remember' && !settings.memory.enabled) return false
    if (FILE_TOOLS.includes(n) && settings.allowedFolders.length === 0) return false
    return true
  })
}

export function toolDefs(settings: Settings): ToolDef[] {
  return enabledTools(settings).map((n) => SPECS[n].def)
}

export function toolSummary(name: ToolName, args: unknown): string {
  return SPECS[name]?.summary(args ?? {}) ?? name
}

/** Validate permission + folder allowlist. Returns an error message or null. */
export function checkAllowed(name: string, args: any, settings: Settings): string | null {
  if (!(name in SPECS)) return `Neznámý nástroj ${name}.`
  const tool = name as ToolName
  if (!enabledTools(settings).includes(tool)) return `Nástroj ${name} je hostitelem zakázaný.`
  if (FILE_TOOLS.includes(tool) && !isPathAllowed(String(args?.path ?? ''), settings.allowedFolders)) {
    return `Cesta ${args?.path} je mimo povolené složky.`
  }
  return null
}

export async function runTool(name: ToolName, args: unknown, ctx: ToolContext): Promise<ToolOutput> {
  return SPECS[name].run(args ?? {}, ctx)
}
