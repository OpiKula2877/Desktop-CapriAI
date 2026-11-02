// Minimal angular icon set (stroke = currentColor).
import type { JSX } from 'react'

const p = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 } as const

export const Icon: Record<string, () => JSX.Element> = {
  send: () => (
    <svg {...p}>
      <path d="M2 8h10M8 3l5 5-5 5" strokeLinecap="square" />
    </svg>
  ),
  camera: () => (
    <svg {...p}>
      <path d="M1.5 4.5h3l1.5-2h4l1.5 2h3v9h-13z" />
      <circle cx="8" cy="8.5" r="2.5" />
    </svg>
  ),
  image: () => (
    <svg {...p}>
      <path d="M1.5 2.5h13v11h-13z" />
      <path d="M1.5 11l4-4 3 3 2-2 4 4" />
    </svg>
  ),
  gear: () => (
    <svg {...p}>
      <path d="M8 1.5l1.2 2 2.3-.4.4 2.3 2 1.2-1.2 1.4 1.2 1.4-2 1.2-.4 2.3-2.3-.4L8 14.5l-1.2-2-2.3.4-.4-2.3-2-1.2L3.3 8 2.1 6.6l2-1.2.4-2.3 2.3.4z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  ),
  trash: () => (
    <svg {...p}>
      <path d="M2.5 4h11M6 4V2h4v2M3.5 4l1 10h7l1-10" />
    </svg>
  ),
  up: () => (
    <svg {...p}>
      <path d="M3 10l5-5 5 5" strokeLinecap="square" />
    </svg>
  ),
  copy: () => (
    <svg {...p}>
      <path d="M5 5h9v9H5z" />
      <path d="M2 11V2h9" />
    </svg>
  ),
  stop: () => (
    <svg {...p}>
      <path d="M4 4h8v8H4z" fill="currentColor" />
    </svg>
  ),
  close: () => (
    <svg {...p}>
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  ),
  min: () => (
    <svg {...p}>
      <path d="M3 8h10" />
    </svg>
  ),
  note: () => (
    <svg {...p}>
      <path d="M6 12V3l7-1.5v9" />
      <circle cx="4.5" cy="12" r="1.8" fill="currentColor" />
      <circle cx="11.5" cy="10.5" r="1.8" fill="currentColor" />
    </svg>
  )
}
