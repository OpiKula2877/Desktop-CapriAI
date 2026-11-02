import type { ProviderKind, Settings, ToolName } from './types'

export const PROVIDER_PRESETS: Record<ProviderKind, { baseUrl: string; model: string; fastModel: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5', fastModel: '' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', fastModel: '' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash', fastModel: '' }
}

export const TOOL_LABELS: Record<ToolName, string> = {
  open_app: 'Spouštět aplikace',
  open_url: 'Otevírat weby',
  open_path: 'Otevírat soubory a složky',
  list_dir: 'Procházet složky',
  read_file: 'Číst soubory',
  read_clipboard: 'Číst schránku',
  write_clipboard: 'Zapisovat do schránky',
  take_screenshot: 'Dívat se na obrazovku',
  list_windows: 'Vidět otevřená okna',
  focus_window: 'Přepínat okna',
  mouse_click: 'Klikat myší',
  type_text: 'Psát na klávesnici',
  now_playing: 'Vidět co hraje',
  remember: 'Ukládat si vzpomínky'
}

/** Tools that touch the file system and are restricted to allowedFolders. */
export const FILE_TOOLS: ToolName[] = ['open_path', 'list_dir', 'read_file']

export const SETTINGS_VERSION = 2

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  provider: { kind: 'anthropic', ...PROVIDER_PRESETS.anthropic, maxTokens: 1500 },
  hotkeys: {
    toggleOverlay: 'Alt+C',
    summonAvatar: 'Alt+Shift+C',
    panic: 'Control+Alt+Shift+F12'
  },
  personality: { volatility: 60, meltdownEnabled: true, blackoutEnabled: true, extraPrompt: '' },
  quips: { enabled: true, minMinutes: 20, maxMinutes: 60 },
  permissions: {
    open_app: 'auto',
    open_url: 'auto',
    open_path: 'ask',
    list_dir: 'auto',
    read_file: 'ask',
    read_clipboard: 'auto',
    write_clipboard: 'auto',
    take_screenshot: 'ask',
    list_windows: 'auto',
    focus_window: 'auto',
    mouse_click: 'off',
    type_text: 'off',
    now_playing: 'auto',
    remember: 'auto'
  },
  allowedFolders: [],
  music: { enabled: true, beatDetection: true, comments: true },
  memory: { enabled: true },
  avatar: { visible: true, roam: true, folderPlay: true, scale: 0.7, x: null, y: null },
  idle: { enabled: true, awayMinutes: 4, fly: true, folders: true, keyboard: true, paint: true, paintTemplates: '' },
  system: { autostart: false }
}
