// Capri appends a hidden tag like [mood:+15] to every reply. This strips it out of the
// streamed text (even when the tag is split across chunks) and collects the deltas.

const TAG_RE = /\[mood:\s*([+-]?\d{1,3})\s*\]/gi
const PREFIX = '[mood:'

export class MoodTagFilter {
  private held = ''
  readonly deltas: number[] = []

  /** Feed a streamed chunk, get back the text that is safe to show. */
  push(chunk: string): string {
    let text = this.held + chunk
    this.held = ''
    text = this.extract(text)
    // Hold back a trailing fragment that could be the start of a tag.
    const lb = text.lastIndexOf('[')
    if (lb >= 0) {
      const tail = text.slice(lb)
      if (!tail.includes(']') && tail.length < 14 && couldBeTagStart(tail)) {
        this.held = tail
        text = text.slice(0, lb)
      }
    }
    return text
  }

  /** Flush whatever is still held at the end of the stream. */
  finish(): string {
    const rest = this.extract(this.held)
    this.held = ''
    return rest
  }

  get total(): number {
    return this.deltas.reduce((a, b) => a + b, 0)
  }

  private extract(text: string): string {
    return text.replace(TAG_RE, (_m, n: string) => {
      this.deltas.push(Math.max(-100, Math.min(100, parseInt(n, 10))))
      return ''
    })
  }
}

function couldBeTagStart(tail: string): boolean {
  const t = tail.toLowerCase()
  if (t.length <= PREFIX.length) return PREFIX.startsWith(t)
  return t.startsWith(PREFIX) && /^\[mood:\s*[+-]?\d*\s*$/.test(t)
}

/** Remove any tags from a complete string (used for history and quips). */
export function stripMoodTags(text: string): { text: string; delta: number } {
  const f = new MoodTagFilter()
  const out = f.push(text) + f.finish()
  return { text: out.trim(), delta: f.total }
}
