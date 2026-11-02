import * as THREE from 'three'

// 2D cut-out puppet on top of the rigged GLB: every bone only rotates in the screen plane
// (around the camera axis), so Capri moves like a paper puppet instead of a 3D figure.
// The GLB carries animation clips baked in Blender (tools/build_model.py); the puppet layers
// procedural motion (beat, glances, shaking, hair springs) on top of whatever clip is playing.

export const BONE_NAMES = [
  'pelvis',
  'spine',
  'chest',
  'neck',
  'head',
  'hair_top',
  'hair_L',
  'hair_R',
  'hair_back',
  'hair_tail',
  'bangs',
  'eye',
  'shard_L',
  'shard_R',
  'upperArm_L',
  'foreArm_L',
  'hand_L',
  'upperArm_R',
  'foreArm_R',
  'hand_R',
  'thigh_L',
  'shin_L',
  'foot_L',
  'thigh_R',
  'shin_R',
  'foot_R'
] as const

/** Hair locks: neighbouring locks tear apart past ~10° relative rotation, so springs stay small. */
export const HAIR_BONES = ['hair_top', 'hair_L', 'hair_R', 'hair_back', 'hair_tail', 'bangs'] as const
export type BoneName = (typeof BONE_NAMES)[number]

/** Pose = screen-plane angles in degrees (+ = counter-clockwise) relative to the modelled pose. */
export type Pose = Partial<Record<BoneName, number>> & { lean?: number; lift?: number }

// L/R are from the viewer's side. Raising the left arm = negative, right arm = positive.
export const POSES = {
  idle: { upperArm_L: 6, upperArm_R: -6 },
  bored: { spine: -4, head: 8, upperArm_L: 12, upperArm_R: -14, foreArm_R: -10, lift: -0.04 },
  talk: { upperArm_R: 48, foreArm_R: 62, hand_R: 20, upperArm_L: 8 },
  angry: { upperArm_L: -78, foreArm_L: -48, hand_L: -20, upperArm_R: 80, foreArm_R: 52, hand_R: 20, spine: 0, head: -4 },
  vibe: { upperArm_R: 70, foreArm_R: 70, upperArm_L: 24, foreArm_L: -70, hand_L: -30 },
  wave: { upperArm_R: 118, foreArm_R: 34, hand_R: 10, upperArm_L: 6 },
  sit: { spine: 4, upperArm_L: 18, foreArm_L: 18, upperArm_R: -20, foreArm_R: -18, thigh_L: -6, lift: 0 },
  // Forearms swing in so both hands meet in front of the chest (angles derived from the rig).
  folder: { upperArm_L: 20, foreArm_L: 128, hand_L: 0, upperArm_R: -20, foreArm_R: -115, hand_R: 0, head: -8, spine: 2 },
  peek: { spine: -10, head: -14, upperArm_L: -30, foreArm_L: -60, upperArm_R: 26, foreArm_R: 50 },
  dash: { spine: 0, upperArm_L: 0, upperArm_R: 0 },
  meltdown: { upperArm_L: -95, foreArm_L: -30, upperArm_R: 95, foreArm_R: 30, head: 0 }
} satisfies Record<string, Pose>
export type PoseName = keyof typeof POSES

interface BoneRig {
  bone: THREE.Bone
  rest: THREE.Quaternion
  axis: THREE.Vector3 // camera axis expressed in the bone's local frame
}

const VIEW_AXIS = new THREE.Vector3(0, 0, 1)
const tmpQ = new THREE.Quaternion()

export class Puppet {
  readonly bones = new Map<BoneName, BoneRig>()
  /** Current animated angles (degrees). */
  readonly angles: Record<string, number> = {}

  constructor(root: THREE.Object3D) {
    root.updateMatrixWorld(true)
    for (const name of BONE_NAMES) {
      const bone = root.getObjectByName(name) as THREE.Bone | undefined
      if (!bone) continue
      const worldQ = bone.getWorldQuaternion(new THREE.Quaternion())
      const axis = VIEW_AXIS.clone().applyQuaternion(worldQ.invert()).normalize()
      this.bones.set(name, { bone, rest: bone.quaternion.clone(), axis })
      this.angles[name] = 0
    }
    this.angles.lean = 0
    this.angles.lift = 0
  }

  get ok(): boolean {
    return this.bones.size > 0
  }

  /** Ease current angles toward `target` (degrees). `rate` ≈ 1/seconds to settle. */
  blendTo(target: Record<string, number>, dt: number, rate = 8): void {
    const k = 1 - Math.exp(-rate * dt)
    for (const key of Object.keys(this.angles)) {
      const goal = target[key] ?? 0
      this.angles[key] += (goal - this.angles[key]) * k
    }
  }

  /**
   * Write the angles to the bones. `overClip`: on top of the rotation an AnimationMixer just set
   * this frame (the angles are then offsets), otherwise relative to the modelled rest pose.
   */
  apply(overClip = false): void {
    for (const [name, rig] of this.bones) {
      const rad = THREE.MathUtils.degToRad(this.angles[name] ?? 0)
      tmpQ.setFromAxisAngle(rig.axis, rad)
      if (overClip) rig.bone.quaternion.multiply(tmpQ)
      else rig.bone.quaternion.copy(rig.rest).multiply(tmpQ)
    }
  }

  bone(name: BoneName): THREE.Bone | undefined {
    return this.bones.get(name)?.bone
  }

  worldPosition(name: BoneName, out = new THREE.Vector3()): THREE.Vector3 {
    const rig = this.bones.get(name)
    return rig ? rig.bone.getWorldPosition(out) : out.set(0, 0, 0)
  }
}

/**
 * Secondary motion: damped springs that make hair and the floating shards lag behind head turns
 * and window movement. Outputs degrees per bone.
 */
export class Springs {
  private readonly s = new Map<string, { x: number; v: number }>()

  constructor(
    private readonly limits: Record<string, number>,
    private readonly stiffness = 60,
    private readonly damping = 7
  ) {
    for (const k of Object.keys(limits)) this.s.set(k, { x: 0, v: 0 })
  }

  /** `force` pushes every spring (deg/s²), scaled per bone by `weights`. */
  step(dt: number, force: number, weights: Record<string, number> = {}): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [k, st] of this.s) {
      const a = -this.stiffness * st.x - this.damping * st.v + force * (weights[k] ?? 1)
      st.v += a * dt
      st.x += st.v * dt
      const lim = this.limits[k]
      if (Math.abs(st.x) > lim) {
        st.x = Math.sign(st.x) * lim
        st.v *= -0.3
      }
      out[k] = st.x
    }
    return out
  }
}

/** Sum of a named pose plus extra procedural offsets. */
export function poseTarget(name: PoseName, extra: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = { ...(POSES[name] as Record<string, number>) }
  for (const [k, v] of Object.entries(extra)) out[k] = (out[k] ?? 0) + v
  return out
}

// ---------------- Windows folder prop ----------------
// The classic yellow Explorer folder, built from flat cut-out planes so it matches her 2D look:
// back panel with tab, a few sheets of paper and a front flap hinged at the bottom. The flap
// swings open (scaled on Y – in the front orthographic view that reads as a hinge rotation) and
// she leafs through the sheets, which tip forward one by one.

const OUTLINE = '#3a2200'

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w * 2
  c.height = h * 2
  const g = c.getContext('2d')!
  g.scale(2, 2)
  g.lineJoin = 'round'
  draw(g)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath()
  g.roundRect(x, y, w, h, r)
}

/** A plane whose origin sits on its bottom edge (so scaling Y hinges it there). */
function hingedPlane(w: number, h: number, tex: THREE.Texture): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(w, h)
  geo.translate(0, h / 2, 0)
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide, depthTest: false })
  return new THREE.Mesh(geo, mat)
}

const PAGE_TEXTS = ['0xC4PR1', 'LOG_2077', 'shard.bin', 'BLACKWALL', 'kernel.sys', 'ネット']

export class FolderProp extends THREE.Group {
  private readonly front: THREE.Mesh
  private readonly pages: THREE.Mesh[] = []
  private openness = 0
  private openTarget = 0
  private flipping: { page: THREE.Mesh; t: number } | null = null
  private nextFlip = 1.5
  /** Called when a page starts to tip over (for a hand gesture / glitch). */
  onFlip: (() => void) | null = null

  constructor() {
    super()
    const W = 0.46
    const H = 0.36
    // Back panel with the tab on the top-left.
    const backTex = canvasTex(280, 230, (g) => {
      g.fillStyle = '#e09a1c'
      g.strokeStyle = OUTLINE
      g.lineWidth = 3
      g.beginPath()
      g.moveTo(6, 28)
      g.lineTo(6, 12)
      g.quadraticCurveTo(6, 6, 12, 6)
      g.lineTo(96, 6)
      g.quadraticCurveTo(104, 6, 110, 14)
      g.lineTo(122, 26)
      g.lineTo(266, 26)
      g.quadraticCurveTo(274, 26, 274, 34)
      g.lineTo(274, 216)
      g.quadraticCurveTo(274, 224, 266, 224)
      g.lineTo(14, 224)
      g.quadraticCurveTo(6, 224, 6, 216)
      g.closePath()
      g.fill()
      g.stroke()
      g.fillStyle = 'rgba(255,255,255,0.18)'
      g.fillRect(10, 30, 260, 6)
    })
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(W, W * (230 / 280)),
      new THREE.MeshBasicMaterial({ map: backTex, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide, depthTest: false })
    )
    back.position.set(0, H * 0.5, 0)
    back.renderOrder = 10
    this.add(back)

    // Sheets of paper, standing in the folder, hinged at the bottom.
    for (let i = 0; i < 4; i++) {
      const label = PAGE_TEXTS[(i * 2) % PAGE_TEXTS.length]
      const tex = canvasTex(220, 190, (g) => {
        roundRect(g, 3, 3, 214, 184, 4)
        g.fillStyle = i % 2 ? '#f6f3ee' : '#ffffff'
        g.fill()
        g.strokeStyle = '#8a7f73'
        g.lineWidth = 2
        g.stroke()
        g.fillStyle = '#ff1e50'
        g.font = '700 15px "Share Tech Mono", monospace'
        g.fillText(label, 16, 28)
        g.fillStyle = '#b8b0a6'
        for (let l = 0; l < 7; l++) g.fillRect(16, 44 + l * 18, 120 + ((l * 37 + i * 23) % 70), 5)
        g.fillStyle = '#19f07a'
        g.fillRect(16, 44 + 18 * ((i + 2) % 7), 40, 5)
      })
      const page = hingedPlane(W * 0.78, H * 0.78, tex)
      page.position.set((i - 1.5) * 0.012, 0.015, 0)
      page.renderOrder = 11 + i
      this.pages.push(page)
      this.add(page)
    }

    // Front flap: lighter yellow, hinged at the bottom edge.
    const frontTex = canvasTex(290, 190, (g) => {
      const grad = g.createLinearGradient(0, 0, 0, 190)
      grad.addColorStop(0, '#ffd866')
      grad.addColorStop(1, '#f7b92e')
      roundRect(g, 4, 4, 282, 182, 8)
      g.fillStyle = grad
      g.fill()
      g.strokeStyle = OUTLINE
      g.lineWidth = 3
      g.stroke()
      g.fillStyle = 'rgba(255,255,255,0.35)'
      g.fillRect(12, 10, 266, 5)
    })
    this.front = hingedPlane(W * 1.02, H * 0.66, frontTex)
    this.front.renderOrder = 20
    this.add(this.front)
    this.visible = false
  }

  /** 0 = closed, 1 = flap fully down. */
  setOpen(target: number): void {
    this.openTarget = Math.min(1, Math.max(0, target))
  }

  flip(): void {
    if (this.flipping || this.openness < 0.6) return
    // Front-most standing sheet tips forward.
    const page = [...this.pages].reverse().find((p) => p.scale.y > 0.5) ?? null
    if (!page) {
      for (const p of this.pages) p.scale.y = 1 // restack and start over
      return
    }
    this.flipping = { page, t: 0 }
    this.onFlip?.()
  }

  update(dt: number): void {
    this.openness += (this.openTarget - this.openness) * Math.min(1, dt * 6)
    // Flap hinge: full height → tipped toward the viewer (shorter), papers show above it.
    this.front.scale.y = 1 - 0.5 * this.openness
    this.front.position.y = -0.03 * this.openness
    // Sheets rise out of the folder a bit when it is open.
    for (const p of this.pages) if (p !== this.flipping?.page && p.scale.y > 0.5) p.position.y = 0.015 + 0.04 * this.openness

    if (this.openness > 0.6) {
      this.nextFlip -= dt
      if (this.nextFlip <= 0) {
        this.nextFlip = 2 + Math.random() * 2
        this.flip()
      }
    }
    if (this.flipping) {
      const f = this.flipping
      f.t = Math.min(1, f.t + dt * 2.6)
      const e = f.t < 0.5 ? 2 * f.t * f.t : 1 - Math.pow(-2 * f.t + 2, 2) / 2
      // 1 → -0.35: the sheet tips toward the viewer and lies on the open flap.
      f.page.scale.y = 1 - 1.5 * e
      f.page.renderOrder = 30
      if (f.t >= 1) {
        f.page.renderOrder = 21
        this.flipping = null
        // Once every sheet is down, quietly restack them.
        if (this.pages.every((p) => p.scale.y < 0.5)) {
          setTimeout(() => {
            this.pages.forEach((p, i) => {
              p.scale.y = 1
              p.renderOrder = 11 + i
            })
          }, 900)
        }
      }
    }
  }

  /** Every mesh of the prop (for raycasts / mask passes). */
  meshes(): THREE.Mesh[] {
    return this.children as THREE.Mesh[]
  }
}
