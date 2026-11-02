import { app } from 'electron'
import { join } from 'node:path'

/** Path inside the bundled `resources/` folder (dev: repo root, packaged: process.resourcesPath). */
export function resourcePath(...parts: string[]): string {
  const base = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
  return join(base, ...parts)
}
