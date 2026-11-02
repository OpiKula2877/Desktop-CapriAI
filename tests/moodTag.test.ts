import { describe, expect, it } from 'vitest'
import { MoodTagFilter, stripMoodTags } from '../src/main/ai/moodTag'

describe('MoodTagFilter', () => {
  it('strips a tag delivered in one chunk', () => {
    const f = new MoodTagFilter()
    expect(f.push('Ty gonku. [mood:+12]') + f.finish()).toBe('Ty gonku. ')
    expect(f.deltas).toEqual([12])
  })

  it('strips a tag split across many chunks', () => {
    const f = new MoodTagFilter()
    const chunks = ['Hotovo', ', choombo. [', 'mo', 'od:', '-', '7', ']']
    const out = chunks.map((c) => f.push(c)).join('') + f.finish()
    expect(out).toBe('Hotovo, choombo. ')
    expect(f.total).toBe(-7)
  })

  it('does not swallow normal brackets', () => {
    const f = new MoodTagFilter()
    const out = f.push('pole [1, 2] a [link](x)') + f.push(' konec [') + f.push('ok]') + f.finish()
    expect(out).toBe('pole [1, 2] a [link](x) konec [ok]')
    expect(f.deltas).toEqual([])
  })

  it('flushes an unfinished tag-like tail at the end', () => {
    const f = new MoodTagFilter()
    expect(f.push('text [mo') + f.finish()).toBe('text [mo')
  })

  it('stripMoodTags sums deltas and trims', () => {
    expect(stripMoodTags('ahoj [mood:+5] [mood:+3]')).toEqual({ text: 'ahoj', delta: 8 })
  })
})
