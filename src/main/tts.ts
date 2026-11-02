// Placeholder for the future custom text-to-speech voice (planned after v1.0.0).
// A TTS engine implements this interface; chat.ts will call speak() with finished replies.

export interface TtsEngine {
  /** Synthesize and play `text`. Resolves when playback finishes or is interrupted. */
  speak(text: string, opts?: { signal?: AbortSignal }): Promise<void>
  stop(): void
}

export const noTts: TtsEngine = {
  async speak() {},
  stop() {}
}
