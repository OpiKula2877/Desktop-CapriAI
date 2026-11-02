import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MELTDOWN_AT, applyDelta, decay, scaleDelta } from '../src/main/moodMeter'
import { isPathAllowed } from '../src/main/permissions'
import { matchScore, normalize } from '../src/main/appIndex'

describe('mood meter', () => {
  it('high volatility angers much faster than low', () => {
    expect(scaleDelta(10, 100)).toBeGreaterThan(scaleDelta(10, 0) * 5)
  })

  it('max volatility reaches meltdown with a few insults', () => {
    let a = 0
    for (let i = 0; i < 4; i++) a = applyDelta(a, 15, 100)
    expect(a).toBe(MELTDOWN_AT)
  })

  it('zero volatility barely moves', () => {
    let a = 0
    for (let i = 0; i < 10; i++) a = applyDelta(a, 15, 0)
    expect(a).toBeLessThan(40)
  })

  it('clamps to 0..100 and decays', () => {
    expect(applyDelta(5, -50, 50)).toBe(0)
    expect(decay(50, 10, 50)).toBeLessThan(50)
    expect(decay(1, 100, 50)).toBe(0)
  })
})

describe('isPathAllowed', () => {
  const folders = ['C:\\Users\\Sam\\Documents']
  it('allows the folder and children', () => {
    expect(isPathAllowed('C:\\Users\\Sam\\Documents', folders)).toBe(true)
    expect(isPathAllowed('C:\\Users\\Sam\\Documents\\a\\b.txt', folders)).toBe(true)
    expect(isPathAllowed('c:\\users\\sam\\documents\\x.txt', folders)).toBe(true)
  })
  it('blocks siblings, traversal and relative paths', () => {
    expect(isPathAllowed('C:\\Users\\Sam\\DocumentsEvil\\x', folders)).toBe(false)
    expect(isPathAllowed('C:\\Users\\Sam\\Documents\\..\\secret.txt', folders)).toBe(false)
    expect(isPathAllowed('C:\\Windows\\System32\\x.dll', folders)).toBe(false)
    expect(isPathAllowed('Documents\\x.txt', folders)).toBe(false)
    expect(isPathAllowed('', folders)).toBe(false)
  })
  it('blocks everything with no folders', () => {
    expect(isPathAllowed('C:\\x', [])).toBe(false)
  })
})

describe('app matching', () => {
  it('normalizes diacritics', () => {
    expect(normalize('Kalkulačka')).toBe('kalkulacka')
  })
  it('prefers exact and prefix matches', () => {
    expect(matchScore('spotify', 'Spotify')).toBe(100)
    expect(matchScore('visual', 'Visual Studio Code')).toBeGreaterThan(matchScore('code', 'Visual Studio Code'))
    expect(matchScore('xyz', 'Spotify')).toBe(0)
  })
})

describe('meltdown is purely visual', () => {
  const dir = join(__dirname, '..', 'src', 'renderer', 'src', 'meltdown')
  const mainSide = readFileSync(join(__dirname, '..', 'src', 'main', 'meltdown.ts'), 'utf8')
  it('renderer files import nothing that can touch the system', () => {
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8')
      expect(src).not.toMatch(/from ['"](node:)?(fs|child_process|os|path)['"]/)
      expect(src).not.toMatch(/require\(/)
    }
  })
  it('main-side meltdown module has no fs / process access', () => {
    expect(mainSide).not.toMatch(/from ['"](node:)?(fs|child_process)['"]/)
    expect(mainSide).not.toMatch(/winHelper|shell\./)
  })
})

describe('blackout is purely visual', () => {
  it('stage page and blackout module never touch files or processes', () => {
    const dir = join(__dirname, '..', 'src', 'renderer', 'src', 'stage')
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8')
      expect(src).not.toMatch(/from ['"](node:)?(fs|child_process|os|path)['"]/)
      expect(src).not.toMatch(/require\(/)
    }
    const mainSide = readFileSync(join(__dirname, '..', 'src', 'main', 'blackout.ts'), 'utf8')
    expect(mainSide).not.toMatch(/from ['"](node:)?(fs|child_process)['"]/)
    expect(mainSide).not.toMatch(/winHelper|shell\.|writeFile/)
  })
})
