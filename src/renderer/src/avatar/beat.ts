// Listens to system audio (WASAPI loopback via getDisplayMedia; main answers the request with
// audio: 'loopback'). Two jobs:
//  1. beat detection – bass-band energy onsets drive her head-banging
//  2. music recognition – Google's YAMNet audio classifier (TensorFlow.js, runs locally) tells
//     music from speech/noise, so a YouTube video with talking doesn't make her dance.
// Audio never leaves the computer.

import type * as TF from '@tensorflow/tfjs'

const YAMNET_RATE = 16000
const WINDOW_SAMPLES = Math.round(YAMNET_RATE * 1.95) // two YAMNet frames
const SPEECH = 0
const MUSIC = 132
const GENRES: [number, number] = [211, 276] // Pop … music genres in the AudioSet ontology

let tf: typeof TF | null = null
let model: TF.GraphModel | null = null
let modelLoading: Promise<void> | null = null

async function loadModel(): Promise<void> {
  if (model) return
  modelLoading ??= (async () => {
    tf = await import('@tensorflow/tfjs')
    await tf.ready()
    model = await tf.loadGraphModel('./yamnet/model.json')
  })()
  await modelLoading
}

export class AudioSense {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private proc: ScriptProcessorNode | null = null
  private raf = 0
  private history: number[] = []
  private lastBeat = 0
  private starting = false
  private failedUntil = 0
  // 16 kHz ring of recent audio for the classifier
  private pcm = new Float32Array(WINDOW_SAMPLES)
  private pcmFill = 0
  private classifyTimer: number | undefined
  private musicEma = 0
  private loud = 0

  /** Current verdict: is what's playing music? (with hysteresis) */
  isMusic = false
  /** Smoothed music probability 0..1 (for debugging / UI). */
  get musicScore(): number {
    return this.musicEma
  }

  constructor(
    private onBeat: () => void,
    private onVerdict: (music: boolean) => void
  ) {}

  get running(): boolean {
    return this.stream !== null
  }

  async start(classify: boolean): Promise<void> {
    if (this.stream || this.starting || Date.now() < this.failedUntil) return
    this.starting = true
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 1, height: 1, frameRate: 1 } })
      stream.getVideoTracks().forEach((t) => t.stop())
      if (!stream.getAudioTracks().length) throw new Error('no loopback audio')
      this.stream = stream
      this.ctx = new AudioContext()
      const src = this.ctx.createMediaStreamSource(stream)
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 1024
      this.analyser.smoothingTimeConstant = 0.2
      src.connect(this.analyser) // not connected to the speakers: no echo
      if (classify) this.startClassifier(src)
      this.loop()
    } catch (e) {
      console.warn('Audio sense unavailable:', e)
      this.failedUntil = Date.now() + 60_000
    } finally {
      this.starting = false
    }
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
    window.clearInterval(this.classifyTimer)
    this.proc?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close()
    this.stream = null
    this.ctx = null
    this.analyser = null
    this.proc = null
    this.history = []
    this.pcmFill = 0
    this.musicEma = 0
    this.setVerdict(false)
  }

  private setVerdict(music: boolean): void {
    if (music === this.isMusic) return
    this.isMusic = music
    this.onVerdict(music)
  }

  private startClassifier(src: MediaStreamAudioSourceNode): void {
    const ctx = this.ctx!
    void loadModel().catch((e) => console.warn('YAMNet failed to load', e))
    // ScriptProcessor collects PCM; its output goes nowhere audible (gain 0).
    const proc = ctx.createScriptProcessor(4096, 1, 1)
    const mute = ctx.createGain()
    mute.gain.value = 0
    src.connect(proc)
    proc.connect(mute)
    mute.connect(ctx.destination)
    const ratio = ctx.sampleRate / YAMNET_RATE
    proc.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0)
      const n = Math.floor(input.length / ratio)
      let peak = 0
      // Linear-interpolated downsample into the ring (shift when full).
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const p = i * ratio
        const i0 = Math.floor(p)
        const f = p - i0
        const v = input[i0] * (1 - f) + (input[Math.min(i0 + 1, input.length - 1)] ?? 0) * f
        out[i] = v
        peak = Math.max(peak, Math.abs(v))
      }
      this.loud = this.loud * 0.8 + peak * 0.2
      if (this.pcmFill + n > WINDOW_SAMPLES) {
        const shift = this.pcmFill + n - WINDOW_SAMPLES
        this.pcm.copyWithin(0, shift, this.pcmFill)
        this.pcmFill -= shift
      }
      this.pcm.set(out, this.pcmFill)
      this.pcmFill += n
    }
    this.proc = proc
    this.classifyTimer = window.setInterval(() => void this.classify(), 1500)
  }

  private async classify(): Promise<void> {
    if (!model || !tf || this.pcmFill < WINDOW_SAMPLES) return
    // Silence is not music.
    if (this.loud < 0.004) return this.update(0)
    const wave = tf.tensor1d(this.pcm.slice(0, WINDOW_SAMPLES))
    let music = 0
    try {
      const raw = model.predict(wave) as TF.Tensor | TF.Tensor[]
      const outs = Array.isArray(raw) ? raw : [raw]
      // Outputs are [spectrogram, embeddings, scores] – pick the 521-class scores by shape.
      const scores = (outs.find((o) => o.shape[1] === 521) ?? outs[outs.length - 1]) as TF.Tensor2D
      const mean = scores.mean(0)
      const data = (await mean.data()) as Float32Array
      const genre = Math.max(...Array.from(data.subarray(GENRES[0], GENRES[1] + 1)))
      const m = Math.max(data[MUSIC], genre * 1.4)
      const speech = data[SPEECH]
      // Music with a voice over it still counts; pure talking does not.
      music = speech > m * 1.6 ? m * 0.4 : m
      tf.dispose([mean, ...outs])
    } finally {
      wave.dispose()
    }
    this.update(music)
  }

  private update(music: number): void {
    this.musicEma = this.musicEma * 0.55 + music * 0.45
    if (import.meta.env.DEV) console.log(`[yamnet] music=${music.toFixed(2)} ema=${this.musicEma.toFixed(2)} loud=${this.loud.toFixed(3)}`)
    if (!this.isMusic && this.musicEma > 0.42) this.setVerdict(true)
    else if (this.isMusic && this.musicEma < 0.2) this.setVerdict(false)
  }

  private loop = () => {
    const a = this.analyser
    if (!a || !this.ctx) return
    const bins = new Uint8Array(a.frequencyBinCount)
    a.getByteFrequencyData(bins)
    // Bass band ≈ 40–160 Hz
    const hz = this.ctx.sampleRate / a.fftSize
    const lo = Math.max(1, Math.floor(40 / hz))
    const hi = Math.max(lo + 1, Math.ceil(160 / hz))
    let e = 0
    for (let i = lo; i <= hi; i++) e += bins[i] * bins[i]
    e /= hi - lo + 1
    this.history.push(e)
    if (this.history.length > 60) this.history.shift()
    const avg = this.history.reduce((s, v) => s + v, 0) / this.history.length
    const now = performance.now()
    if (e > avg * 1.35 && e > 1500 && now - this.lastBeat > 280) {
      this.lastBeat = now
      this.onBeat()
    }
    this.raf = requestAnimationFrame(this.loop)
  }
}
