// Types shared between the main process, preload and renderers.

export type ProviderKind = 'anthropic' | 'openai' | 'gemini'

export interface ProviderSettings {
  kind: ProviderKind
  /** Base URL – for "openai" any OpenAI-compatible endpoint (OpenRouter, Groq, Ollama, LM Studio…). */
  baseUrl: string
  model: string
  /** Utility model for cheap calls (quips, apology judge). Empty = same as model. */
  fastModel: string
  maxTokens: number
}

export type PermissionMode = 'off' | 'ask' | 'auto'

export type ToolName =
  | 'open_app'
  | 'open_url'
  | 'open_path'
  | 'list_dir'
  | 'read_file'
  | 'read_clipboard'
  | 'write_clipboard'
  | 'take_screenshot'
  | 'list_windows'
  | 'focus_window'
  | 'mouse_click'
  | 'type_text'
  | 'now_playing'
  | 'remember'

export interface Settings {
  /** Settings schema version, for migrations. */
  version: number
  provider: ProviderSettings
  hotkeys: {
    toggleOverlay: string
    summonAvatar: string
    panic: string
  }
  personality: {
    /** 0–100, 100 = the most explosive. */
    volatility: number
    meltdownEnabled: boolean
    /** When shaking pushes her over the edge: all screens go black and she waits for an apology. */
    blackoutEnabled: boolean
    extraPrompt: string
  }
  quips: {
    enabled: boolean
    minMinutes: number
    maxMinutes: number
  }
  permissions: Record<ToolName, PermissionMode>
  allowedFolders: string[]
  music: {
    enabled: boolean
    beatDetection: boolean
    comments: boolean
  }
  memory: {
    enabled: boolean
  }
  avatar: {
    visible: boolean
    /** Wander around the screen when bored. */
    roam: boolean
    /** When bored, hide in File Explorer and rummage through folders. */
    folderPlay: boolean
    scale: number
    /** Home anchor = point under her feet (bottom-centre of the window), DIP. */
    x: number | null
    y: number | null
  }
  /** What she does on her own while you are away from the PC. */
  idle: {
    enabled: boolean
    /** No mouse / keyboard input for this long (and no video playing) = you are away. */
    awayMinutes: number
    fly: boolean
    folders: boolean
    keyboard: boolean
    paint: boolean
    /** Folder with reference pictures for painting. Empty = Pictures\CapriAI\předlohy. */
    paintTemplates: string
  }
  system: {
    autostart: boolean
  }
}

export interface MemoryItem {
  id: string
  text: string
  createdAt: number
}

export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown>; signature?: string }
  | {
      type: 'tool_result'
      id: string
      name: string
      text: string
      image?: { mime: string; data: string }
      isError?: boolean
    }

export interface ChatMessage {
  role: 'user' | 'assistant'
  parts: Part[]
}

/** Lightweight message shape the overlay renders. */
export interface UiMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  images?: string[] // data URLs
  pending?: boolean
}

export interface ConfirmRequest {
  id: string
  tool: ToolName
  summary: string
}

export interface MoodState {
  anger: number
  meltdown: boolean
  /** After a blackout: she refuses to move or play until you apologise. */
  grudge?: boolean
}

export interface NowPlaying {
  title: string
  artist: string
  playing: boolean
  app: string
}

export type AvatarState = 'idle' | 'talking' | 'angry' | 'vibe' | 'meltdown' | 'hidden'

/** Where Capri currently hangs out: her home spot, wandering, sitting on a window, or in Explorer. */
export type AvatarMode = 'home' | 'wander' | 'perch' | 'explorer' | 'fly' | 'paint' | 'keyboard' | 'wait'

/** Movement effect cue for the avatar window. */
export interface DashFx {
  dx: number
  dy: number
  ms: number
  teleport: boolean
}

export interface Attachment {
  mime: string
  data: string // base64 without prefix
}

/** One frozen frame of Capri for the strobe trail (coordinates local to the stage window). */
export interface StageGhost {
  img: Uint8Array // webp with alpha
  x: number
  y: number
  w: number
  h: number
  tint: number
}

export interface StageBlackout {
  phase: 'black' | 'rebuild' | 'fade' | 'end'
  img?: Uint8Array // jpeg of this display, for the rebuild
  ms?: number
}

/** Start a painting on the paint layer window (canvas size in image pixels). */
export interface PaintStart {
  width: number
  height: number
  durationMs: number
  /** Template picture (any browser-decodable image); null = procedural fallback scene. */
  template: Uint8Array | null
}
