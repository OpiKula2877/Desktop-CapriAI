import { isAbsolute, relative, resolve } from 'node:path'

/** True when `target` is one of `folders` or inside one of them (Windows paths, case-insensitive). */
export function isPathAllowed(target: string, folders: string[]): boolean {
  if (!target || !isAbsolute(target)) return false
  const t = resolve(target).toLowerCase()
  return folders.some((f) => {
    if (!f) return false
    const base = resolve(f).toLowerCase()
    const rel = relative(base, t)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}
