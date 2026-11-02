import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { isMusicApp } from '@shared/music'
import type { AvatarMode, AvatarState, DashFx, MoodState, NowPlaying, Settings } from '@shared/types'
import '../shared/theme.css'
import './avatar.css'
import { api } from '../shared/api'
import { AudioSense } from './beat'
import { Fx } from './fx'
import { glitchFragment, glitchVertex } from './glitchShader'
import { FolderProp, HAIR_BONES, Puppet, Springs, poseTarget, type PoseName } from './puppet'

// ---------------- DOM ----------------
const root = document.getElementById('root')!
root.innerHTML = `
  <div class="stage">
    <canvas id="cv"></canvas>
    <canvas id="fx"></canvas>
    <div class="notes" id="notes"></div>
    <div class="bubble cut" id="bubble"><span id="bubble-text"></span></div>
  </div>`
const canvas = document.getElementById('cv') as HTMLCanvasElement
const fxCanvas = document.getElementById('fx') as HTMLCanvasElement
const bubble = document.getElementById('bubble')!
const bubbleText = document.getElementById('bubble-text')!
const notesEl = document.getElementById('notes')!

// ---------------- three.js ----------------
const W = () => window.innerWidth
const H = () => window.innerHeight

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true })
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
renderer.setClearColor(0x000000, 0)

const scene = new THREE.Scene()
const VIEW_H = 3.0
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 50)
camera.position.set(0, 0, 10)

const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 4 })
const maskRt = new THREE.WebGLRenderTarget(1, 1, { samples: 4 }) // white where hair is
const post = new THREE.ShaderMaterial({
  vertexShader: glitchVertex,
  fragmentShader: glitchFragment,
  uniforms: {
    tDiffuse: { value: rt.texture },
    tMask: { value: maskRt.texture },
    uTime: { value: 0 },
    uGlitch: { value: 1 },
    uAnger: { value: 0 },
    uPulse: { value: 0 },
    uDissolve: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uDir: { value: new THREE.Vector2(1, 0) }
  },
  transparent: true,
  depthTest: false,
  depthWrite: false
})
const postScene = new THREE.Scene()
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post))
const fx = new Fx(fxCanvas)

function resize(): void {
  const w = W()
  const h = H()
  renderer.setSize(w, h, false)
  const pr = renderer.getPixelRatio()
  rt.setSize(Math.round(w * pr), Math.round(h * pr))
  maskRt.setSize(Math.round(w * pr), Math.round(h * pr))
  post.uniforms.uRes.value.set(w * pr, h * pr)
  fx.resize(w, h, pr)
  const vw = VIEW_H * (w / h)
  camera.left = -vw / 2
  camera.right = vw / 2
  camera.top = VIEW_H - 0.06
  camera.bottom = -0.06
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)
resize()

const rig = new THREE.Group() // whole-body offset (float, lean, jitter)
scene.add(rig)
let puppet: Puppet | null = null
let mixer: THREE.AnimationMixer | null = null
const actions = new Map<string, THREE.AnimationAction>()
let currentClip = ''
let flyDir = 1
const flyCenter = { x: 0, y: 0 }
const FLY_FRAME_BONES = ['head', 'hair_top', 'hair_back', 'hair_tail', 'pelvis', 'hand_L', 'hand_R', 'foot_L', 'foot_R'] as const
const springs = new Springs({
  hair_top: 6,
  hair_L: 9,
  hair_R: 9,
  hair_back: 8,
  hair_tail: 10,
  bangs: 5,
  shard_L: 22,
  shard_R: 22
})
const SPRING_WEIGHTS = { hair_top: 0.5, bangs: 0.6, hair_tail: 1.3, hair_back: 1.1, shard_L: 1.6, shard_R: -1.6 }
const win = { x: window.screenX, y: window.screenY, vx: 0, vy: 0 }
const blink = { next: 2, t: -1 }
const meshes: THREE.Mesh[] = []
// Normal and hair-mask material for every mesh, swapped for the mask pass.
const matPairs: { mesh: THREE.Mesh; normal: THREE.Material; mask: THREE.Material }[] = []
const folder = new FolderProp()
folder.onFlip = () => {
  flipGesture = 1
  burst(0.2)
}
let flipGesture = 0
scene.add(folder)
const blackMask = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, alphaTest: 0.1 })

/** Per-vertex hair flag: red shards bound to the head or one of the hair bones. */
function buildHairColors(mesh: THREE.SkinnedMesh, map: THREE.Texture | null): void {
  const geo = mesh.geometry
  const uv = geo.getAttribute('uv')
  const skin = geo.getAttribute('skinIndex')
  const hairNames = new Set<string>(['head', ...HAIR_BONES])
  const hairIdx = new Set((mesh.skeleton?.bones ?? []).flatMap((b, i) => (hairNames.has(b.name) ? [i] : [])))
  const n = geo.getAttribute('position').count
  const colors = new Float32Array(n * 3)
  const img = map?.image as CanvasImageSource & { width: number; height: number }
  if (uv && skin && hairIdx.size && img?.width) {
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.drawImage(img, 0, 0)
    const px = g.getImageData(0, 0, c.width, c.height).data
    for (let i = 0; i < n; i++) {
      if (!hairIdx.has(skin.getX(i))) continue
      const x = Math.min(c.width - 1, Math.max(0, Math.floor(uv.getX(i) * c.width)))
      const y = Math.min(c.height - 1, Math.max(0, Math.floor(uv.getY(i) * c.height)))
      const o = (y * c.width + x) * 4
      const red = px[o] > 170 && px[o + 1] < 90 && px[o + 2] < 140
      if (red) colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 1
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}

new GLTFLoader().load('./capri.glb', (gltf) => {
  const model = gltf.scene
  model.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const src = mesh.material as THREE.MeshStandardMaterial
    const map = src.emissiveMap ?? src.map ?? null
    // "Paper_Outline_Black" is an inverted-hull outline shell: only its inward faces may render.
    const isOutline = /outline/i.test(src.name)
    const color = map ? new THREE.Color(0xffffff) : src.emissive?.getHex() ? src.emissive.clone() : src.color.clone()
    const side = isOutline ? THREE.FrontSide : THREE.DoubleSide
    const normal = new THREE.MeshBasicMaterial({ map, color, side, alphaTest: 0.5, visible: Boolean(map) || isOutline })
    let mask: THREE.Material
    if (map && (mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      buildHairColors(mesh as THREE.SkinnedMesh, map)
      mask = new THREE.MeshBasicMaterial({ vertexColors: true, side, alphaTest: 0.5 })
    } else {
      mask = new THREE.MeshBasicMaterial({ color: 0x000000, side, visible: normal.visible })
    }
    mesh.material = normal
    mesh.frustumCulled = false
    mesh.geometry.computeBoundingSphere()
    if (mesh.geometry.boundingSphere) mesh.geometry.boundingSphere.radius *= 2
    meshes.push(mesh)
    matPairs.push({ mesh, normal, mask })
  })
  const box = new THREE.Box3().setFromObject(model)
  model.position.x -= (box.min.x + box.max.x) / 2
  model.position.y -= box.min.y
  rig.add(model)
  puppet = new Puppet(model)
  // Clips baked in Blender: idle, read, paint, type, fly, waitAngry, shaken, sit, wave, talk.
  if (gltf.animations.length) {
    mixer = new THREE.AnimationMixer(model)
    for (const clip of gltf.animations) actions.set(clip.name, mixer.clipAction(clip))
  }
  appear()
})

// ---------------- state ----------------
let state: AvatarState = 'idle'
let mode: AvatarMode = 'home'
let mood: MoodState = { anger: 0, meltdown: false }
let nowPlaying: NowPlaying | null = null
let settings: Settings | null = null
let glitch = 1
let pulse = 0
let dissolve = 1 // 1 = invisible, animated to 0 on appear
let dissolveTarget = 0
let beatHit = 0
let shakeHit = 0
let beatSide = 1
let lastBeat = 0
let waveUntil = 0
let nextTear = 4
let dash: { dirX: number; dirY: number; until: number } | null = null
let teleporting = false
let drag: { sx: number; sy: number; bx: number; by: number; moved: boolean; lx: number; ly: number; lt: number } | null = null
let locked = false
const glance = { target: 0, value: 0, next: 0 }

function burst(v: number): void {
  glitch = Math.max(glitch, v)
}

const bodyCenter = () => ({ x: W() / 2, y: H() * 0.55 })

/** Materialize with a pixel dissolve, lightning and data glyphs. */
function appear(): void {
  dissolve = 1
  dissolveTarget = 0
  burst(1)
  const c = bodyCenter()
  fx.lightning(c.x, c.y, 4, W() * 0.45)
  fx.blocks(c.x, c.y, W() * 0.5, H() * 0.6, 10)
  fx.glyphs(c.x, c.y, 3)
}

function dancing(): boolean {
  if (!nowPlaying?.playing || !settings?.music.enabled) return false
  return isMusicApp(nowPlaying) || sense.isMusic
}

function choosePose(now: number): PoseName {
  if (mood.meltdown || state === 'meltdown') return 'meltdown'
  if (dash && now < dash.until) return 'dash'
  if (mode === 'wait') return 'angry'
  if (mode === 'keyboard') return 'peek'
  if (mode === 'paint') return 'talk'
  if (now < waveUntil) return 'wave'
  if (state === 'talking') return mode === 'explorer' ? 'folder' : 'talk'
  if (mode === 'explorer') return 'folder'
  if (mood.anger >= 65 || state === 'angry') return 'angry'
  if (mode === 'perch') return dancing() ? 'vibe' : 'sit'
  if (dancing()) return 'vibe'
  if (mode === 'wander') return 'peek'
  if (mode === 'fly') return 'bored'
  return mood.anger >= 30 ? 'bored' : 'idle'
}

// ---------------- audio: beat + music recognition ----------------
const sense = new AudioSense(
  () => onBeat(true),
  (music) => {
    if (music && nowPlaying?.playing) {
      burst(0.5)
      fx.glyphs(bodyCenter().x, bodyCenter().y, 2, ['♪ DETECTED', 'BPM//SYNC', 'AUDIO.JACK'])
    }
  }
)
let senseClassify: boolean | null = null

function onBeat(real: boolean): void {
  if (real) lastBeat = performance.now()
  if (!dancing()) return
  beatHit = 1
  beatSide *= -1
  pulse = 1
  if (Math.random() < 0.5) spawnNote()
  if (Math.random() < 0.12) {
    burst(0.25)
    fx.blocks(bodyCenter().x, bodyCenter().y, W() * 0.6, H() * 0.6, 3)
  }
}

function syncAudio(): void {
  const playing = Boolean(nowPlaying?.playing && settings?.music.enabled)
  const listen = playing && Boolean(settings?.music.beatDetection)
  const classify = !isMusicApp(nowPlaying)
  if (!listen) {
    sense.stop()
    senseClassify = null
    return
  }
  if (sense.running && senseClassify !== classify) sense.stop()
  senseClassify = classify
  void sense.start(classify)
}

// ---------------- notes ----------------
const NOTE_CHARS = ['♪', '♫', '♬', '♩']
function spawnNote(): void {
  const n = document.createElement('span')
  n.className = 'note'
  n.textContent = NOTE_CHARS[Math.floor(Math.random() * NOTE_CHARS.length)]
  n.style.left = `${20 + Math.random() * 60}%`
  n.style.top = `${28 + Math.random() * 12}%`
  n.style.setProperty('--dx', `${(Math.random() - 0.5) * 100}px`)
  n.style.setProperty('--rot', `${(Math.random() - 0.5) * 60}deg`)
  n.style.color = Math.random() < 0.6 ? 'var(--red)' : Math.random() < 0.5 ? 'var(--green)' : 'var(--violet)'
  n.style.fontSize = `${14 + Math.random() * 12}px`
  notesEl.appendChild(n)
  setTimeout(() => n.remove(), 2400)
}

// ---------------- bubble ----------------
let bubbleTimer: number | undefined
let typeTimer: number | undefined
function say(text: string): void {
  window.clearTimeout(bubbleTimer)
  window.clearInterval(typeTimer)
  bubble.classList.add('show')
  bubbleText.textContent = ''
  burst(0.4)
  fx.blocks(W() / 2, 40, W() * 0.8, 50, 4)
  let i = 0
  typeTimer = window.setInterval(() => {
    i += 2
    bubbleText.textContent = text.slice(0, i)
    if (i >= text.length) window.clearInterval(typeTimer)
  }, 24)
  bubbleTimer = window.setTimeout(() => bubble.classList.remove('show'), 5000 + text.length * 55)
}
bubble.addEventListener('click', () => bubble.classList.remove('show'))

// ---------------- animation ----------------
const clock = new THREE.Timer()
let synthBeatAt = 0
const handPos = new THREE.Vector3()
const handPos2 = new THREE.Vector3()

function proceduralExtras(pose: PoseName, t: number): Record<string, number> {
  const e: Record<string, number> = {}
  const s = Math.sin
  // Always-on life: breathing sway, dangling legs, glances.
  e.head = s(t * 0.9) * 3 + glance.value * 10
  e.upperArm_L = s(t * 1.1) * 3
  e.upperArm_R = -s(t * 1.1 + 0.5) * 3
  e.thigh_L = s(t * 1.3) * 4
  e.shin_L = s(t * 1.3 + 1) * 6
  e.shin_R = s(t * 1.1 + 2) * 3

  switch (pose) {
    case 'talk':
      e.foreArm_R = s(t * 6) * 18
      e.hand_R = s(t * 9) * 14
      e.head += s(t * 7) * 5
      break
    case 'angry': {
      const j = () => (Math.random() - 0.5) * 10
      e.upperArm_L += j()
      e.upperArm_R += j()
      e.foreArm_L = j()
      e.foreArm_R = j()
      e.head += s(t * 30) * 4
      break
    }
    case 'vibe':
      e.head += beatSide * beatHit * 16
      e.spine = beatSide * beatHit * 5
      e.upperArm_R += beatHit * 28
      e.thigh_L += beatHit * 10
      e.shin_L += beatHit * 16
      e.lift = -beatHit * 0.04
      break
    case 'wave':
      e.foreArm_R = s(t * 12) * 28
      e.head += 6
      break
    case 'sit':
      e.thigh_L += s(t * 2) * 6
      e.shin_L += s(t * 2 + 0.6) * 14
      e.shin_R += s(t * 1.7) * 6
      break
    case 'folder':
      e.hand_R = s(t * 1.5) * 4
      // Left hand reaches over when a page is flipped.
      e.foreArm_L = s(t * 1.5 + 1) * 3 - flipGesture * 30
      e.upperArm_L += -flipGesture * 12
      e.head += (s(t * 0.4) > 0.85 ? 16 : 0) + s(t * 2.2) * 2 // glances up at you now and then
      break
    case 'peek':
      e.head += s(t * 1.8) * 8
      e.foreArm_L = s(t * 3) * 10
      break
    case 'bored':
      e.head += s(t * 0.5) * 6
      e.shin_L += s(t * 3) * 12
      break
    case 'dash': {
      const d = dash ?? { dirX: 1, dirY: 0 }
      e.spine = -d.dirX * 18
      e.head -= d.dirX * 8
      e.upperArm_L = -d.dirX * 55
      e.upperArm_R = -d.dirX * 60
      e.foreArm_L = -d.dirX * 25
      e.foreArm_R = -d.dirX * 25
      e.thigh_L = -d.dirX * 15
      e.shin_L = -d.dirX * 20
      e.thigh_R = -d.dirX * 10
      e.lean = -d.dirX * 0.18
      break
    }
    case 'meltdown':
      for (const k of ['upperArm_L', 'foreArm_L', 'upperArm_R', 'foreArm_R', 'head', 'spine', 'thigh_L', 'shin_L']) {
        e[k] = (e[k] ?? 0) + (Math.random() - 0.5) * 40
      }
      break
  }
  // Being shaken: limbs and head flop around like a rag doll.
  if (shakeHit > 0.02) {
    for (const [k, amp] of [['head', 22], ['upperArm_L', 45], ['upperArm_R', 45], ['foreArm_L', 35], ['foreArm_R', 35], ['spine', 10], ['shin_L', 30], ['thigh_L', 20]] as const) {
      e[k] = (e[k] ?? 0) + s(t * 23 + amp) * amp * shakeHit
    }
  }
  return e
}

// ---------------- Blender clips ----------------
const CLIP_FOR: Partial<Record<PoseName, string>> = {
  idle: 'idle',
  bored: 'idle',
  peek: 'idle',
  vibe: 'idle',
  talk: 'talk',
  angry: 'waitAngry',
  wave: 'wave',
  sit: 'sit',
  folder: 'read',
  dash: 'fly',
  meltdown: 'shaken'
}

function clipFor(pose: PoseName): string {
  if (shakeHit > 0.35) return 'shaken'
  if (mode === 'keyboard' && pose !== 'dash') return 'type'
  if (mode === 'paint' && pose !== 'dash') return 'paint'
  if (mode === 'fly') return 'fly'
  return CLIP_FOR[pose] ?? 'idle'
}

function playClip(name: string): void {
  if (name === currentClip) return
  const next = actions.get(name) ?? actions.get('idle')
  if (!next) return
  const prev = actions.get(currentClip)
  next.reset().setEffectiveWeight(1).play()
  if (prev) next.crossFadeFrom(prev, name === 'shaken' || name === 'fly' ? 0.15 : 0.35, false)
  currentClip = name
}

/** Procedural layer on top of a clip: small offsets only (the clip carries the pose). */
function clipExtras(pose: PoseName, t: number): Record<string, number> {
  const e: Record<string, number> = { head: glance.value * 8 }
  if (pose === 'vibe' || dancing()) {
    e.head += beatSide * beatHit * 14
    e.chest = beatSide * beatHit * 5
    e.upperArm_R = beatHit * 24
    e.thigh_L = beatHit * 8
    e.lift = -beatHit * 0.04
  }
  if (pose === 'angry') {
    const j = () => (Math.random() - 0.5) * 6
    e.foreArm_L = j()
    e.foreArm_R = j()
    e.head += Math.sin(t * 30) * 2
  }
  if (pose === 'folder') {
    e.foreArm_L = -flipGesture * 25
    e.upperArm_L = -flipGesture * 10
  }
  if (pose === 'meltdown') {
    for (const k of ['upperArm_L', 'foreArm_L', 'upperArm_R', 'foreArm_R', 'head', 'chest']) e[k] = (Math.random() - 0.5) * 30
  }
  if (pose === 'dash' && dash) e.lean = -Math.abs(dash.dirX) * 0.12
  if (shakeHit > 0.02) {
    for (const [k, amp] of [['head', 14], ['upperArm_L', 30], ['upperArm_R', 30], ['foreArm_L', 25], ['foreArm_R', 25], ['shin_L', 20]] as const) {
      e[k] = (e[k] ?? 0) + Math.sin(t * 23 + amp) * amp * shakeHit
    }
  }
  return e
}

function frame(): void {
  requestAnimationFrame(frame)
  clock.update()
  const dt = Math.min(0.05, clock.getDelta())
  const t = clock.getElapsed()
  const now = performance.now()
  if (dash && now > dash.until) dash = null
  const pose = choosePose(now)
  const anger = mood.anger / 100
  const c = bodyCenter()

  // Fallback rhythm when the beat detector has nothing (music app without audio capture).
  if (pose === 'vibe' && now - lastBeat > 900 && t > synthBeatAt) {
    synthBeatAt = t + 60 / 112
    onBeat(false)
  }
  beatHit *= Math.pow(0.012, dt)
  shakeHit *= Math.pow(0.05, dt)
  flipGesture *= Math.pow(0.03, dt)
  pulse *= Math.pow(0.02, dt)
  glitch *= Math.pow(0.04, dt)
  dissolve += (dissolveTarget - dissolve) * Math.min(1, dt * 5)

  // Occasional hologram tear – a short, contained flicker, then calm again.
  if (t > nextTear && pose !== 'meltdown') {
    nextTear = t + 6 + Math.random() * 10
    burst(0.28)
    if (Math.random() < 0.5) fx.blocks(c.x, c.y, W() * 0.5, H() * 0.5, 3)
  }
  if (Math.random() < dt * 0.25) fx.sparks(c.x, H() * 0.3, 2) // data dust off the hair
  if (pose === 'meltdown') {
    glitch = Math.max(glitch, 0.3 + 0.3 * Math.random())
    if (Math.random() < dt * 4) fx.lightning(c.x, c.y, 2, W() * 0.5)
    if (Math.random() < dt * 6) fx.blocks(c.x, c.y, W(), H(), 3)
  }
  if (pose === 'angry' && Math.random() < dt * 0.5) {
    burst(0.3)
    fx.lightning(c.x, H() * 0.45, 1, W() * 0.3)
  }

  if (t > glance.next) {
    glance.target = (Math.random() - 0.5) * 1.2
    glance.next = t + 2 + Math.random() * 4
  }
  glance.value += (glance.target - glance.value) * Math.min(1, dt * 4)

  // Window motion (drag, dash) for the hair springs.
  const sx = window.screenX
  const sy = window.screenY
  const nvx = (sx - win.x) / Math.max(dt, 0.008)
  const nvy = (sy - win.y) / Math.max(dt, 0.008)
  const accel = (nvx - win.vx) / Math.max(dt, 0.008)
  win.x = sx
  win.y = sy
  win.vx = nvx
  win.vy = nvy

  if (puppet?.ok) {
    const rate = pose === 'dash' || pose === 'meltdown' ? 22 : pose === 'vibe' ? 16 : 7
    if (mixer && actions.size) {
      const clip = clipFor(pose)
      if (clip === 'fly' && dash && Math.abs(dash.dirX) > 0.2) flyDir = Math.sign(dash.dirX)
      playClip(clip)
      mixer.update(dt)
      // Hair and shards lag behind window moves, sway gently, and bounce on the beat.
      const force = -accel * 0.03 + Math.sin(t * 1.9) * 25 + beatSide * beatHit * 300 + shakeHit * Math.sin(t * 23) * 500
      const target = { ...clipExtras(pose, t), ...springs.step(dt, Math.max(-900, Math.min(900, force)), SPRING_WEIGHTS) }
      target.shard_L = (target.shard_L ?? 0) + Math.sin(t * 1.3) * 6
      target.shard_R = (target.shard_R ?? 0) + Math.sin(t * 1.1 + 1) * 6
      puppet.blendTo(target, dt, Math.max(rate, 14))
      puppet.apply(true)
      // Blink every few seconds (eye bone pivot sits on the iris).
      if (t > blink.next && blink.t < 0) blink.t = 0
      if (blink.t >= 0) {
        blink.t += dt
        const k = Math.min(1, blink.t / 0.14)
        const eye = puppet.bone('eye')
        if (eye) eye.scale.y *= Math.max(0.08, Math.abs(1 - 2 * k))
        if (k >= 1) {
          blink.t = -1
          blink.next = t + 2.5 + Math.random() * 4
        }
      }
    } else {
      const target = poseTarget(pose, proceduralExtras(pose, t))
      puppet.blendTo(target, dt, rate)
      puppet.apply()
    }
    const seated = mode === 'perch' || mode === 'explorer'
    const bob = seated ? 0.006 : mode === 'fly' ? 0.07 : 0.025
    rig.position.y = Math.sin(t * 1.6) * bob + (puppet.angles.lift ?? 0)
    rig.position.x = pose === 'meltdown' ? (Math.random() - 0.5) * 0.06 : 0
    if (currentClip === 'fly') {
      // Horizontal flight doesn't fit the portrait window: smaller, mirrored to fly left (the clip
      // heads to the viewer's right) and centred on where her bones actually are.
      rig.scale.set(0.8 * flyDir, 0.8, 1)
      const bob = rig.position.y
      rig.position.set(0, 0, 0)
      rig.updateMatrixWorld(true)
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const b of FLY_FRAME_BONES) {
        puppet.worldPosition(b, handPos)
        minX = Math.min(minX, handPos.x)
        maxX = Math.max(maxX, handPos.x)
        minY = Math.min(minY, handPos.y)
        maxY = Math.max(maxY, handPos.y)
      }
      flyCenter.x += (-(minX + maxX) / 2 - flyCenter.x) * Math.min(1, dt * 6)
      flyCenter.y += (VIEW_H / 2 - 0.06 - (minY + maxY) / 2 - flyCenter.y) * Math.min(1, dt * 6)
      rig.position.set(flyCenter.x, flyCenter.y + bob, 0)
    } else rig.scale.set(1, 1, 1)
    rig.rotation.z = puppet.angles.lean ?? 0

    const reading = pose === 'folder'
    if (reading && !folder.visible) folder.visible = true
    folder.setOpen(reading ? 1 : 0)
    folder.update(dt)
    if (!reading && folder.visible && folder.scale.x < 0.05) folder.visible = false
    folder.scale.setScalar(THREE.MathUtils.lerp(folder.scale.x, reading ? 1 : 0, Math.min(1, dt * 8)))
    if (folder.visible) {
      // Held in both hands in front of her chest.
      rig.updateMatrixWorld(true)
      puppet.worldPosition('hand_L', handPos)
      puppet.worldPosition('hand_R', handPos2)
      folder.position.set((handPos.x + handPos2.x) / 2, (handPos.y + handPos2.y) / 2 - 0.12, 1)
      folder.rotation.z = Math.sin(t * 1.3) * 0.03
    }
  }

  post.uniforms.uTime.value = t
  post.uniforms.uGlitch.value = glitch
  post.uniforms.uPulse.value = pulse
  post.uniforms.uDissolve.value = dissolve
  post.uniforms.uAnger.value = pose === 'meltdown' ? 1 : anger * anger
  if (dash) post.uniforms.uDir.value.set(dash.dirX, -dash.dirY)

  // Hair mask pass
  for (const p of matPairs) p.mesh.material = p.mask
  const folderMats = folder.meshes().map((m) => m.material)
  for (const m of folder.meshes()) m.material = blackMask
  renderer.setRenderTarget(maskRt)
  renderer.clear()
  renderer.render(scene, camera)
  for (const p of matPairs) p.mesh.material = p.normal
  folder.meshes().forEach((m, i) => (m.material = folderMats[i]))
  // Colour pass + post
  renderer.setRenderTarget(rt)
  renderer.clear()
  renderer.render(scene, camera)
  renderer.setRenderTarget(null)
  renderer.clear()
  renderer.render(postScene, postCam)
  // Effects must draw in the same task so the WebGL canvas can be copied for afterimages.
  fx.draw(W(), H(), { x: c.x, y: H() * 0.58, w: W() * 0.45, h: H() * 0.7 }, canvas)
  maybeTrailGhost(now)
}

// ---------------- strobe trail ----------------
// While she is yanked around or dashing, freeze a frame every so often and leave it on the
// desktop (stage window) – a choppy "1 FPS" trace tinted green / violet.
const ghostCanvas = document.createElement('canvas')
const ghostCtx = ghostCanvas.getContext('2d')!
let lastGhost = { t: 0, x: 0, y: 0 }
let ghostTint = 0
function maybeTrailGhost(now: number): void {
  const moving = (drag?.moved ?? false) || (dash !== null && now < dash.until && !teleporting)
  if (!moving || dissolve > 0.4) return
  const x = window.screenX
  const y = window.screenY
  if (now - lastGhost.t < 90 || Math.hypot(x - lastGhost.x, y - lastGhost.y) < 40) return
  lastGhost = { t: now, x, y }
  // Copy in the same task as the render (the WebGL buffer is cleared afterwards).
  ghostCanvas.width = W()
  ghostCanvas.height = H()
  ghostCtx.clearRect(0, 0, W(), H())
  ghostCtx.drawImage(canvas, 0, 0, W(), H())
  const tint = ghostTint++ % 3
  ghostCanvas.toBlob(
    (b) => void b?.arrayBuffer().then((buf) => api.invoke('avatar:ghost', new Uint8Array(buf), tint)),
    'image/webp',
    0.85
  )
}
frame()

// ---------------- click-through hit testing + drag ----------------
const raycaster = new THREE.Raycaster()
const ndc = new THREE.Vector2()
let interactive = false
function setInteractive(on: boolean): void {
  if (on === interactive) return
  interactive = on
  document.body.classList.toggle('hover', on)
  void api.invoke('avatar:interactive', on)
  if (on) pulse = Math.max(pulse, 0.6)
}

function hitTest(x: number, y: number): boolean {
  if (bubble.classList.contains('show')) {
    const r = bubble.getBoundingClientRect()
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true
  }
  const targets: THREE.Object3D[] = folder.visible ? [...meshes, ...folder.meshes()] : meshes
  for (const [dx, dy] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]]) {
    ndc.set(((x + dx) / W()) * 2 - 1, -((y + dy) / H()) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    if (raycaster.intersectObjects(targets, false).length) return true
  }
  return false
}


window.addEventListener('mousemove', (e) => {
  if (drag) {
    const dx = e.screenX - drag.sx
    const dy = e.screenY - drag.sy
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
    if (drag.moved) {
      void api.invoke('avatar:move', drag.bx + dx, drag.by + dy)
      // Speed effects scale with how hard you fling her.
      const now = performance.now()
      const vx = (e.screenX - drag.lx) / Math.max(1, now - drag.lt)
      const vy = (e.screenY - drag.ly) / Math.max(1, now - drag.lt)
      drag.lx = e.screenX
      drag.ly = e.screenY
      drag.lt = now
      const speed = Math.hypot(vx, vy)
      detectShake(vx, vy, now)
      if (speed > 0.6) {
        dash = { dirX: vx / speed, dirY: vy / speed, until: now + 160 }
        fx.startDash(vx, vy, 120)
        if (speed > 2.2 && Math.random() < 0.3) {
          fx.lightning(bodyCenter().x, bodyCenter().y, 1, W() * 0.4)
          burst(0.3)
        }
      }
    }
    return
  }
  setInteractive(hitTest(e.clientX, e.clientY))
})
window.addEventListener('mouseleave', () => {
  if (!drag) setInteractive(false)
})
window.addEventListener('mousedown', async (e) => {
  if (e.button !== 0 || !interactive) return
  if ((e.target as HTMLElement).closest('#bubble')) return
  if (locked) {
    // She won't be moved: a snap of static instead of a drag.
    burst(0.8)
    fx.lightning(e.clientX, e.clientY, 3, 90)
    fx.blocks(e.clientX, e.clientY, 120, 80, 6)
    void api.invoke('avatar:dragDenied')
    return
  }
  const b = await api.invoke<{ x: number; y: number }>('avatar:bounds')
  drag = { sx: e.screenX, sy: e.screenY, bx: b.x, by: b.y, moved: false, lx: e.screenX, ly: e.screenY, lt: performance.now() }
  document.body.classList.add('dragging')
})
window.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !drag) return
  const wasClick = !drag.moved
  drag = null
  document.body.classList.remove('dragging')
  if (wasClick) {
    burst(0.6)
    fx.lightning(e.clientX, e.clientY, 2, 60)
    fx.glyphs(e.clientX, e.clientY, 1)
    void api.invoke('avatar:click')
  } else {
    // Landing
    burst(0.4)
    fx.blocks(bodyCenter().x, H() * 0.8, W() * 0.6, H() * 0.3, 4)
  }
  setInteractive(hitTest(e.clientX, e.clientY))
})
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (interactive) void api.invoke('avatar:menu')
})

// Shaking: count sharp direction reversals while dragging.
const shake = { sx: 0, sy: 0, last: 0 }
function detectShake(vx: number, vy: number, now: number): void {
  const fast = Math.hypot(vx, vy) > 1.2
  const sx = Math.abs(vx) > 0.8 ? Math.sign(vx) : 0
  const sy = Math.abs(vy) > 0.8 ? Math.sign(vy) : 0
  const flipped = (sx && shake.sx && sx !== shake.sx) || (sy && shake.sy && sy !== shake.sy)
  if (sx) shake.sx = sx
  if (sy) shake.sy = sy
  if (!fast || !flipped || now - shake.last < 70) return
  shake.last = now
  shakeHit = 1
  burst(0.5)
  if (Math.random() < 0.5) fx.lightning(bodyCenter().x, bodyCenter().y, 1, W() * 0.4)
  void api.invoke('avatar:shake', Math.min(3, Math.hypot(vx, vy)))
}

// ---------------- IPC ----------------
api.on('avatar:state', (s: AvatarState) => {
  if (s !== state && (s === 'meltdown' || s === 'angry')) burst(0.6)
  state = s
})
api.on('avatar:glitch', () => {
  appear()
  waveUntil = performance.now() + 1600
})
api.on('avatar:mode', (m: AvatarMode) => {
  if (m !== mode) burst(0.7)
  mode = m
})
api.on('avatar:dash', (d: DashFx) => {
  const now = performance.now()
  const len = Math.hypot(d.dx, d.dy) || 1
  const c = bodyCenter()
  if (d.teleport) {
    // Pixel-dissolve out here, then reassemble where the window lands.
    teleporting = true
    setTimeout(() => (teleporting = false), d.ms + 200)
    dissolveTarget = 1
    burst(1)
    fx.lightning(c.x, c.y, 5, W() * 0.5)
    fx.blocks(c.x, c.y, W() * 0.6, H() * 0.7, 8)
    fx.ghost(canvas, 0, 0, '#19f07a', 220)
    setTimeout(() => appear(), d.ms)
    return
  }
  dash = { dirX: d.dx / len, dirY: d.dy / len, until: now + d.ms + 120 }
  fx.startDash(d.dx, d.dy, d.ms)
  fx.lightning(c.x, c.y, 2, W() * 0.35)
  burst(0.45)
  setTimeout(() => {
    fx.lightning(c.x, H() * 0.6, 3, W() * 0.4)
    fx.blocks(c.x, H() * 0.75, W() * 0.6, H() * 0.3, 4)
    burst(0.35)
  }, d.ms)
})
api.on('avatar:say', (text: string) => say(text))
api.on('avatar:locked', (on: boolean) => {
  locked = on
  if (on && drag) {
    // She tears herself out of your grip.
    drag = null
    document.body.classList.remove('dragging')
    burst(1)
    fx.lightning(bodyCenter().x, bodyCenter().y, 4, W() * 0.5)
    fx.blocks(bodyCenter().x, bodyCenter().y, W() * 0.6, H() * 0.6, 8)
  }
})
api.on('mood', (m: MoodState) => {
  if (m.meltdown !== mood.meltdown) burst(1)
  mood = m
})
api.on('nowplaying', (np: NowPlaying | null) => {
  nowPlaying = np
  syncAudio()
})
api.on('settings:changed', (s: Settings) => {
  settings = s
  syncAudio()
})
void api.invoke<Settings>('settings:get').then((s) => {
  settings = s
  syncAudio()
})
void api.invoke<MoodState>('mood:get').then((m) => (mood = m))
