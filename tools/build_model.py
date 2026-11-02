"""Blender (headless) script: rig the Capri paper-cutout model for 2D puppet animation.

The source mesh is ~2500 loose flat shards with no skeleton. We add an armature and bind every
shard rigidly (weight 1.0) to one bone, chosen by palette colour and position, so poses bend her
like a paper puppet. Every bone only rotates around the view axis (front ortho camera, model
faces -Y); clips are baked as quaternions around that axis plus local scale for squash/stretch.

Usage:  blender -b --python tools/build_model.py [-- --debug | --poses]
        --debug  render per-bone colours (dbg_front/side/back.png) into $CAPRI_DBG and exit
        --poses  also render a few frames of some clips (pose_<clip>_<n>.png) into $CAPRI_DBG
Output: resources/model/capri.glb and src/renderer/public/capri.glb
"""
import bpy, bmesh, math, os, shutil, sys
from mathutils import Quaternion, Vector, kdtree
from mathutils.geometry import intersect_point_line

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "capri-model", "source", "Untitled5blend.glb")
OUT = os.path.join(ROOT, "resources", "model", "capri.glb")
PUBLIC = os.path.join(ROOT, "src", "renderer", "public", "capri.glb")
DEBUG = "--debug" in sys.argv
POSES = "--poses" in sys.argv
DBG_DIR = os.environ.get("CAPRI_DBG", ROOT)
FPS = 30


# ---------------------------------------------------------------------------------------------
# Animation clips. Angles are degrees around the view axis, + = counter-clockwise as seen by the
# viewer (same convention as puppet.ts: raising the viewer-left arm is negative, the right arm
# positive). Each clip is a seamless loop of `seconds`, built from:
#   pose  : held offsets from the modelled pose
#   keys  : {bone: [(t, deg), ...]} eased (smoothstep) keys, t in 0..1, wrapping around the loop
#   sway  : {bone: (amp, cycles, phase)} sine overlay, whole cycles per loop so it loops
#   scale : {bone: [(t, sx, sy), ...]} eased local scale keys (Y runs along the bone)
#   depth : {bone: s} scale along the view axis, held for the whole clip. Invisible from the front
#           camera, but it pulls that limb toward the viewer so it draws over the body: the
#           forearms pivot behind the torso (RIG_Y), so s = 2.2 lifts hands in front of the chest.
# ---------------------------------------------------------------------------------------------
def blink(at, seconds, close=0.08):
    """Eye scale keys for one blink centred at loop fraction `at` (~0.15 s long)."""
    d = 0.06 / seconds
    return [(0, 1, 1), (at - d, 1, 1), (at, 1, close), (at + 1.5 * d, 1, 1)]


def hair(amp, cycles=1, phase=0.0):
    """Secondary hair sway: every lock follows the same wave a little later than the last."""
    return {
        "hair_top": (amp * 0.6, cycles, phase), "bangs": (amp * 0.5, cycles, phase + 0.04),
        "hair_back": (amp * 0.5, cycles, phase + 0.06), "hair_L": (amp, cycles, phase + 0.10),
        "hair_R": (amp, cycles, phase + 0.12), "hair_tail": (amp * 1.3, cycles, phase + 0.18),
    }


BREATHE = [(0, 1, 1), (0.5, 0.992, 1.018)]

CLIPS = {
    "idle": dict(
        seconds=3.0,
        pose={"upperArm_L": 4, "upperArm_R": -4},
        sway={**hair(2.5), "pelvis": (1.2, 1, 0), "chest": (1.0, 1, 0.1), "head": (2.0, 1, 0.2),
              "upperArm_L": (2.5, 1, 0.25), "upperArm_R": (2.5, 1, 0.75), "foreArm_L": (3, 1, 0.35),
              "foreArm_R": (3, 1, 0.85), "shard_L": (4, 1, 0.0), "shard_R": (4, 1, 0.5),
              "shin_R": (2, 1, 0.4), "foot_L": (2, 1, 0.6)},
        scale={"chest": BREATHE, "eye": blink(0.7, 3.0)},
    ),
    "read": dict(  # folder held in front of the chest, left hand flips a page every loop
        seconds=3.0,
        pose={"upperArm_L": -9, "foreArm_L": 135, "hand_L": 94,
              "upperArm_R": 8, "foreArm_R": -122, "hand_R": -105,
              "neck": -3, "head": -7, "chest": 1},
        keys={"upperArm_L": [(0, 0), (0.50, 0), (0.62, -14), (0.78, -8), (0.92, 0)],
              "foreArm_L": [(0, 0), (0.50, 0), (0.60, 30), (0.72, -6), (0.82, -18), (0.92, 0)],
              "hand_L": [(0, 0), (0.50, 0), (0.60, 25), (0.75, -25), (0.92, 0)],
              "head": [(0, 0), (0.55, 0), (0.70, 4), (0.90, 0)],
              "hair_L": [(0, 0), (0.62, 0), (0.74, -3), (0.90, 0)]},
        sway={**hair(1.5), "pelvis": (0.8, 1, 0), "foreArm_R": (2, 1, 0.3),
              "shard_L": (4, 1, 0.0), "shard_R": (4, 1, 0.5), "foot_L": (2, 1, 0.6)},
        scale={"chest": BREATHE, "head": [(0, 1, 0.97)], "eye": blink(0.3, 3.0)},
        depth={"foreArm_L": 2.2, "foreArm_R": 2.2},
    ),
    "paint": dict(  # right arm makes broad brush strokes, left arm holds the palette out
        seconds=2.0,
        pose={"upperArm_R": 70, "foreArm_R": 40, "hand_R": 15,
              "upperArm_L": -30, "foreArm_L": 70, "hand_L": 25, "head": 5},
        keys={"foreArm_R": [(0, -28), (0.25, 28), (0.5, -28), (0.75, 28)],
              "upperArm_R": [(0, -6), (0.30, 8), (0.55, -6), (0.80, 8)],
              "hand_R": [(0, 18), (0.12, 18), (0.25, -18), (0.37, -18), (0.5, 18), (0.62, 18),
                         (0.75, -18), (0.87, -18)],
              "chest": [(0, -2), (0.25, 3), (0.5, -2), (0.75, 3)],
              "head": [(0, 3), (0.30, -3), (0.55, 3), (0.80, -3)]},
        sway={**hair(3, 2, 0.1), "pelvis": (1, 1, 0), "foreArm_L": (3, 1, 0.2),
              "shard_L": (5, 1, 0.0), "shard_R": (5, 1, 0.5)},
        scale={"chest": BREATHE, "eye": blink(0.8, 2.0)},
    ),
    "type": dict(  # hands over a keyboard, alternating taps, hunched toward the screen
        seconds=1.2,
        pose={"upperArm_L": -13, "foreArm_L": 110, "hand_L": 33,
              "upperArm_R": 8, "foreArm_R": -95, "hand_R": -43,
              "spine": -2, "neck": -4, "head": -6},
        keys={"hand_L": [(0, 0), (0.08, -14), (0.18, 0), (0.50, 0), (0.58, -10), (0.66, 0)],
              "hand_R": [(0, 0), (0.25, 0), (0.33, 14), (0.43, 0), (0.75, 0), (0.83, 10), (0.91, 0)],
              "foreArm_L": [(0, 0), (0.08, -4), (0.20, 0), (0.58, -3), (0.70, 0)],
              "foreArm_R": [(0, 0), (0.33, 4), (0.45, 0), (0.83, 3), (0.95, 0)],
              "head": [(0, 0), (0.5, 1.5)]},
        sway={**hair(1.2, 2), "chest": (0.8, 2, 0), "shard_L": (3, 1, 0), "shard_R": (3, 1, 0.5)},
        scale={"spine": [(0, 1.01, 0.96)], "chest": [(0, 1.01, 0.97), (0.5, 1.0, 0.985)],
               "eye": blink(0.45, 1.2)},
        depth={"foreArm_L": 2.2, "foreArm_R": 2.2},
    ),
    "fly": dict(  # horizontal flight toward the viewer's right, hair and legs streaming behind
        seconds=1.6,
        pose={"pelvis": -78, "spine": 4, "chest": 3, "neck": 10, "head": 12,
              "upperArm_R": 120, "foreArm_R": 10, "hand_R": 5,
              "upperArm_L": 20, "foreArm_L": 10, "hand_L": 10,
              "thigh_L": 12, "shin_L": 8, "foot_L": 25, "thigh_R": 10, "shin_R": 10, "foot_R": 10,
              "hair_top": 8, "hair_L": 10, "hair_R": -7, "hair_tail": -10, "hair_back": -3,
              "bangs": 4, "shard_L": 12, "shard_R": -6},
        keys={"pelvis": [(0, -3), (0.5, 3)]},
        sway={**hair(3, 3), "spine": (2, 1, 0.1), "head": (2, 1, 0.25),
              "upperArm_R": (4, 1, 0.3), "upperArm_L": (6, 2, 0.4), "foreArm_L": (8, 2, 0.5),
              "thigh_L": (5, 2, 0.2), "shin_L": (9, 2, 0.35), "thigh_R": (4, 2, 0.7),
              "shin_R": (7, 2, 0.85), "foot_L": (8, 2, 0.5), "foot_R": (8, 2, 0.0),
              "shard_L": (8, 2, 0.1), "shard_R": (8, 2, 0.6)},
        scale={"pelvis": [(0, 0.98, 1.03), (0.5, 1.01, 0.99)], "hair_top": [(0, 1, 0.92)],
               "eye": blink(0.5, 1.6)},
    ),
    "waitAngry": dict(  # arms crossed, head tilted, impatient foot tapping
        seconds=2.0,
        pose={"upperArm_L": 26, "foreArm_L": 114, "hand_L": 20,
              "upperArm_R": -27, "foreArm_R": -109, "hand_R": -24,
              "pelvis": 2, "chest": -2, "neck": -4, "head": -12},
        keys={"foot_L": [(0, 0), (0.08, 16), (0.18, 0), (0.25, 0), (0.33, 16), (0.43, 0),
                         (0.5, 0), (0.58, 16), (0.68, 0), (0.75, 0), (0.83, 16), (0.93, 0)],
              "shin_L": [(0, 0), (0.08, 3), (0.18, 0), (0.25, 0), (0.33, 3), (0.43, 0),
                         (0.5, 0), (0.58, 3), (0.68, 0), (0.75, 0), (0.83, 3), (0.93, 0)],
              "head": [(0, 0), (0.40, 0), (0.48, 5), (0.56, -3), (0.64, 0)],
              "hair_tail": [(0, 0), (0.08, -3), (0.25, 0), (0.33, -3), (0.5, 0), (0.58, -3),
                            (0.75, 0), (0.83, -3)]},
        sway={**hair(1.5, 4), "chest": (0.7, 4, 0.1), "shard_L": (6, 2, 0), "shard_R": (6, 2, 0.5)},
        scale={"chest": BREATHE, "eye": [(0, 1, 0.72), (0.78, 1, 0.72), (0.81, 1, 0.08),
                                         (0.85, 1, 0.72)]},
        depth={"foreArm_L": 2.2, "foreArm_R": 2.6},  # right forearm crosses over the left
    ),
    "shaken": dict(  # limp rag-doll bounce: everything droops and flops a beat late
        seconds=1.2,
        pose={"upperArm_L": 18, "foreArm_L": 15, "hand_L": 20,
              "upperArm_R": -18, "foreArm_R": -15, "hand_R": -20, "head": -10, "neck": -5},
        sway={**hair(5, 2, 0.2), "pelvis": (4, 2, 0), "spine": (4, 2, 0.08), "chest": (5, 2, 0.12),
              "neck": (6, 2, 0.18), "head": (10, 2, 0.25),
              "upperArm_L": (12, 2, 0.2), "foreArm_L": (16, 2, 0.32), "hand_L": (20, 2, 0.45),
              "upperArm_R": (12, 2, 0.7), "foreArm_R": (16, 2, 0.82), "hand_R": (20, 2, 0.95),
              "thigh_L": (6, 2, 0.15), "shin_L": (10, 2, 0.3), "foot_L": (14, 2, 0.45),
              "thigh_R": (6, 2, 0.65), "shin_R": (8, 2, 0.8), "foot_R": (14, 2, 0.95),
              "shard_L": (12, 2, 0.3), "shard_R": (12, 2, 0.8)},
        scale={"pelvis": [(0, 1.04, 0.93), (0.25, 0.98, 1.04), (0.5, 1.04, 0.93), (0.75, 0.98, 1.04)],
               "eye": [(0, 1, 0.45), (0.5, 1, 0.6)]},
    ),
    "sit": dict(  # perched on an edge, dangling leg swinging lazily
        seconds=3.0,
        pose={"pelvis": 2, "thigh_L": -10, "shin_L": 6, "upperArm_L": 14, "foreArm_L": 30,
              "hand_L": 10, "upperArm_R": -16, "foreArm_R": -26, "hand_R": -10, "head": 4},
        keys={"shin_L": [(0, -7), (0.5, 9)], "foot_L": [(0, -6), (0.12, -6), (0.62, 10)],
              "shin_R": [(0, 2), (0.5, -2)]},
        sway={**hair(2, 1, 0.3), "chest": (1, 1, 0), "head": (2.5, 1, 0.15),
              "shard_L": (4, 1, 0), "shard_R": (4, 1, 0.5)},
        scale={"pelvis": [(0, 1.01, 0.97)], "chest": BREATHE, "eye": blink(0.4, 3.0)},
    ),
    "wave": dict(  # right arm high, forearm waving twice per loop
        seconds=1.6,
        pose={"upperArm_R": 118, "foreArm_R": 34, "hand_R": 10, "upperArm_L": 6,
              "chest": -3, "head": 6},
        keys={"foreArm_R": [(0, -22), (0.25, 22), (0.5, -22), (0.75, 22)],
              "hand_R": [(0, -10), (0.08, -14), (0.33, 14), (0.58, -14), (0.83, 14)],
              "upperArm_R": [(0, -4), (0.25, 4), (0.5, -4), (0.75, 4)],
              "head": [(0, -2), (0.5, 2)]},
        sway={**hair(2.5, 2, 0.15), "pelvis": (1, 1, 0), "chest": (1.5, 2, 0.05),
              "shard_L": (5, 2, 0), "shard_R": (5, 2, 0.5)},
        scale={"chest": BREATHE, "eye": blink(0.62, 1.6)},
    ),
    "talk": dict(  # chatty right-hand gestures, nodding head
        seconds=2.0,
        pose={"upperArm_R": 40, "foreArm_R": 70, "hand_R": 20, "upperArm_L": 8, "foreArm_L": -6},
        keys={"foreArm_R": [(0, 0), (0.2, 14), (0.4, -6), (0.6, 16), (0.8, 4)],
              "hand_R": [(0, 0), (0.22, 18), (0.42, -10), (0.62, 20), (0.82, 0)],
              "upperArm_R": [(0, 0), (0.3, 8), (0.65, -4)],
              "head": [(0, 0), (0.15, 4), (0.3, -2), (0.5, 3), (0.65, -3), (0.85, 2)],
              "neck": [(0, 0), (0.25, -2), (0.55, 2)],
              "upperArm_L": [(0, 0), (0.5, 4)]},
        sway={**hair(2, 2, 0.2), "pelvis": (0.8, 1, 0), "chest": (1, 2, 0.1),
              "shard_L": (4, 1, 0), "shard_R": (4, 1, 0.5)},
        scale={"chest": BREATHE, "neck": [(0, 1, 1), (0.15, 1, 1.03), (0.3, 1, 0.99), (0.5, 1, 1.03),
                                           (0.65, 1, 0.99), (0.85, 1, 1.02)],
               "eye": blink(0.9, 2.0)},
    ),
}

# ---------------------------------------------------------------------------------------------
# Skeleton: name -> (head, tail, parent). Coordinates measured from grid renders (Blender axes,
# model faces -Y). Left/right are from the viewer's point of view. The eye bone is re-centred on
# the blue iris at runtime so scaling its Y blinks around the eye centre.
# ---------------------------------------------------------------------------------------------
BONES = {
    "pelvis":     ((-0.04, 0.10, 0.74), (-0.04, 0.10, 0.88), None),
    "spine":      ((-0.04, 0.10, 0.88), (-0.05, 0.06, 1.10), "pelvis"),
    "chest":      ((-0.05, 0.06, 1.10), (-0.06, 0.02, 1.33), "spine"),
    "neck":       ((-0.06, 0.02, 1.33), (-0.06, -0.08, 1.43), "chest"),
    "head":       ((-0.06, -0.08, 1.43), (-0.08, -0.10, 2.30), "neck"),
    "hair_top":   ((-0.12, -0.10, 2.08), (-0.15, -0.10, 2.36), "head"),
    "hair_L":     ((-0.28, -0.10, 1.85), (-0.60, -0.10, 1.62), "head"),
    "hair_R":     ((0.12, -0.10, 1.98), (0.55, -0.10, 1.95), "head"),
    "hair_back":  ((-0.05, 0.10, 1.95), (-0.03, 0.10, 1.55), "head"),
    "hair_tail":  ((0.08, -0.10, 1.72), (0.50, -0.10, 1.38), "head"),
    "bangs":      ((-0.15, -0.30, 1.88), (-0.22, -0.30, 1.50), "head"),
    "eye":        ((-0.24, -0.20, 1.55), (-0.24, -0.20, 1.61), "head"),
    "upperArm_L": ((-0.22, 0.08, 1.34), (-0.43, 0.25, 1.00), "chest"),
    "foreArm_L":  ((-0.43, 0.25, 1.00), (-0.64, 0.10, 0.72), "upperArm_L"),
    "hand_L":     ((-0.64, 0.10, 0.72), (-0.78, 0.02, 0.60), "foreArm_L"),
    "upperArm_R": ((0.15, 0.08, 1.33), (0.32, 0.25, 1.03), "chest"),
    "foreArm_R":  ((0.32, 0.25, 1.03), (0.48, 0.10, 0.74), "upperArm_R"),
    "hand_R":     ((0.48, 0.10, 0.74), (0.62, 0.02, 0.62), "foreArm_R"),
    "shard_L":    ((-0.30, 0.22, 1.30), (-0.51, 0.22, 1.00), "chest"),
    "shard_R":    ((0.24, 0.20, 1.30), (0.45, 0.20, 1.04), "chest"),
    "thigh_L":    ((-0.12, 0.08, 0.86), (-0.22, -0.39, 0.66), "pelvis"),
    "shin_L":     ((-0.22, -0.39, 0.66), (-0.24, 0.06, 0.20), "thigh_L"),
    "foot_L":     ((-0.24, 0.06, 0.20), (-0.24, 0.00, 0.00), "shin_L"),
    "thigh_R":    ((0.04, 0.08, 0.88), (0.13, -0.48, 1.00), "pelvis"),
    "shin_R":     ((0.13, -0.48, 1.00), (-0.36, -0.50, 0.64), "thigh_R"),
    "foot_R":     ((-0.36, -0.50, 0.64), (-0.58, -0.56, 0.50), "shin_R"),
}
HAIR = ("hair_top", "hair_L", "hair_R", "hair_back", "hair_tail", "bangs")
# Rig depth (y) per bone: bones lie flat in the screen plane so local Z is exactly the view axis.
# Forearms pivot behind the torso so a `depth` scale pulls the hands in front of the chest.
RIG_Y = {"foreArm_L": 0.6, "foreArm_R": 0.6}
NOT_BODY = {"head", "eye", "shard_L", "shard_R", *HAIR}  # bound by rules, not nearest segment
NECK_Z = 1.43       # shard centres above this belong to the head
FACE_X = (-0.42, 0.08)  # face/skull column (front view): black here stays on the head
FACE_TOP = 1.88
DEBUG_COLORS = {
    "pelvis": (0.55, 0.55, 0.55), "spine": (1, 1, 1), "chest": (0.8, 0.8, 0.65), "neck": (0.3, 0.3, 0.3),
    "head": (1, 0.6, 0), "hair_top": (1, 0, 0), "hair_L": (0.6, 0, 0.1), "hair_R": (1, 0.45, 0.45),
    "hair_back": (0.5, 0.25, 0.6), "hair_tail": (1, 0.85, 0), "bangs": (0, 0.9, 0.7), "eye": (0, 0, 0),
    "upperArm_L": (0, 0, 1), "foreArm_L": (0, 0.6, 1), "hand_L": (0, 1, 1),
    "upperArm_R": (0.6, 0, 1), "foreArm_R": (1, 0, 1), "hand_R": (1, 0.6, 1),
    "shard_L": (0.2, 0.9, 0.2), "shard_R": (0.9, 0.9, 0.3),
    "thigh_L": (0, 0.5, 0), "shin_L": (0, 1, 0), "foot_L": (0.6, 1, 0.6),
    "thigh_R": (0.5, 0.3, 0), "shin_R": (0.75, 0.75, 0), "foot_R": (0.35, 0.35, 0.8),
}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
mesh_obj = [o for o in bpy.data.objects if o.type == "MESH"][0]
mesh_obj.name = "Capri"
bpy.context.view_layer.objects.active = mesh_obj
mesh_obj.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
me = mesh_obj.data

# ---- shards: loose parts with centroid + palette colour sampled at the UV centroid ----
img = next(i for i in bpy.data.images if i.size[0] > 0)
TEX_W, TEX_H = img.size
TEX = img.pixels[:]


def palette(u, v):
    x = min(TEX_W - 1, max(0, int(u * TEX_W)))
    y = min(TEX_H - 1, max(0, int(v * TEX_H)))
    r, g, b = TEX[(y * TEX_W + x) * 4:(y * TEX_W + x) * 4 + 3]
    if r > 0.6 and g < 0.35:
        return "red"
    if g > 0.6 and r < 0.5:
        return "green"
    if b > 0.6 and r < 0.4:
        return "blue"
    if r > 0.8 and g > 0.8:
        return "white"
    return "black"


class Shard:
    def __init__(self, faces, outline):
        self.verts = sorted({v.index for f in faces for v in f.verts})
        self.co = [me.vertices[i].co.copy() for i in self.verts]
        self.c = sum(self.co, Vector()) / len(self.co)
        uvs = [l[uv_layer].uv for f in faces for l in f.loops]
        self.col = palette(sum(u.x for u in uvs) / len(uvs), sum(u.y for u in uvs) / len(uvs))
        self.outline = outline
        self.bone = None


outline_mats = {i for i, m in enumerate(me.materials) if m and "outline" in m.name.lower()}
bm = bmesh.new()
bm.from_mesh(me)
bm.faces.ensure_lookup_table()
uv_layer = bm.loops.layers.uv.active
shards, seen = [], set()
for f in bm.faces:
    if f.index in seen:
        continue
    comp, stack = [], [f]
    seen.add(f.index)
    while stack:
        x = stack.pop()
        comp.append(x)
        for v in x.verts:
            for g in v.link_faces:
                if g.index not in seen:
                    seen.add(g.index)
                    stack.append(g)
    shards.append(Shard(comp, comp[0].material_index in outline_mats))
bm.free()
main = [s for s in shards if not s.outline]


def flat(p):
    return Vector((p.x, 0, p.z))


def seg_dist(p, a, b):
    closest, f = intersect_point_line(p, a, b)
    if f < 0:
        closest = a
    elif f > 1:
        closest = b
    return (p - closest).length


# Floating spikes: in the front view they form small islands not touching the body.
pts = [(i, flat(p)) for i, s in enumerate(main) for p in s.co]
kd = kdtree.KDTree(len(pts))
for j, (_, p) in enumerate(pts):
    kd.insert(p, j)
kd.balance()
root = list(range(len(main)))


def find(a):
    while root[a] != a:
        root[a] = root[root[a]]
        a = root[a]
    return a


for i, p in pts:
    for _, j, _ in kd.find_range(p, 0.012):
        a, b = find(i), find(pts[j][0])
        if a != b:
            root[a] = b
islands = {}
for i in range(len(main)):
    islands.setdefault(find(i), []).append(main[i])
for isl in islands.values():
    if len(isl) <= 80:
        side = "shard_L" if isl[0].c.x < 0 else "shard_R"
        for s in isl:
            s.bone = side
        print("FLOATING", side, len(isl), "shards")
arm_segs = [(flat(Vector(BONES[n][0])), flat(Vector(BONES[n][1])))
            for n in ("upperArm_L", "foreArm_L", "hand_L", "upperArm_R", "foreArm_R", "hand_R")]

# Eye: centre of the blue iris; nearby black (pupil, rim) shards in front of the face blink with it.
blue = [p for s in main if s.col == "blue" for p in s.co]
eye_lo = Vector((min(p.x for p in blue), 0, min(p.z for p in blue)))
eye_hi = Vector((max(p.x for p in blue), 0, max(p.z for p in blue)))
eye_c = (eye_lo + eye_hi) / 2
eye_r = (eye_hi - eye_lo) / 2 * 1.1
eye_y = sum(p.y for p in blue) / len(blue)
BONES["eye"] = ((eye_c.x, eye_y, eye_c.z), (eye_c.x, eye_y, eye_c.z + 0.06), "head")


def in_eye(c):
    return ((c.x - eye_c.x) / eye_r.x) ** 2 + ((c.z - eye_c.z) / eye_r.z) ** 2 <= 1 and c.y < -0.05


def hair_bone(c):
    if c.z > 2.12:
        return "hair_top"
    if c.x < -0.33:
        return "hair_L"
    if c.x > 0.10 and c.z < 1.78:
        return "hair_tail"
    if c.x > 0.18:
        return "hair_R"
    if FACE_X[0] <= c.x <= FACE_X[1] and (c.z < 1.6 or c.z < FACE_TOP and c.y < -0.15):
        return "bangs"
    return "hair_back"


body = {n: (Vector(h), Vector(t)) for n, (h, t, _) in BONES.items() if n not in NOT_BODY}
body["neck"] = (Vector((-0.06, -0.05, 1.38)), Vector(BONES["neck"][1]))  # keep the collar on the chest


def pick_bone(s):
    c = s.c
    in_head = c.z > NECK_Z or (
        c.z > 1.28 and s.col in ("red", "black") and abs(c.x + 0.05) > 0.27
        and min(seg_dist(flat(c), a, b) for a, b in arm_segs) > 0.07)
    if not in_head:
        # The bones sit behind the body, so the red top's front would be "nearest" the neck in 3D.
        cands = [n for n in body if n != "neck" or c.z > 1.36]
        return min(cands, key=lambda n: seg_dist(c, *body[n]))
    if s.col == "blue" or (s.col == "white" and c.z > 1.5) or (s.col == "black" and in_eye(c)):
        return "eye"
    if s.col in ("green", "white"):
        return "head"
    if s.col == "black" and FACE_X[0] <= c.x <= FACE_X[1] and c.z < FACE_TOP and c.y < 0.15:
        return "head"
    return hair_bone(c)


for s in main:
    if not s.bone:
        s.bone = pick_bone(s)
# The violet outline shell duplicates every shard: follow the nearest main shard of the same colour.
kd = kdtree.KDTree(len(main))
for i, s in enumerate(main):
    kd.insert(s.c, i)
kd.balance()
for s in shards:
    if s.outline:
        near = [main[i] for _, i, _ in kd.find_n(s.c, 6)]
        s.bone = next((m.bone for m in near if m.col == s.col), near[0].bone)

assign = {n: [] for n in BONES}
for s in shards:
    assign[s.bone].extend(s.verts)
groups = {n: mesh_obj.vertex_groups.new(name=n) for n in BONES}
for n, idx in assign.items():
    if idx:
        groups[n].add(idx, 1.0, "REPLACE")
print("ASSIGN", {n: len(i) for n, i in assign.items()})
for n, idx in assign.items():
    ys = [me.vertices[i].co.y for i in idx]
    if ys:
        print("DEPTH %-10s %.3f .. %.3f" % (n, min(ys), max(ys)))

# ---- armature ----
arm_data = bpy.data.armatures.new("CapriRig")
arm_obj = bpy.data.objects.new("CapriRig", arm_data)
bpy.context.scene.collection.objects.link(arm_obj)
bpy.ops.object.select_all(action="DESELECT")
bpy.context.view_layer.objects.active = arm_obj
arm_obj.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
for name, (h, t, parent) in BONES.items():
    b = arm_data.edit_bones.new(name)
    y = RIG_Y.get(name, (h[1] + t[1]) / 2)
    b.head, b.tail = Vector((h[0], y, h[2])), Vector((t[0], y, t[2]))
    # Roll so every bone's local Z points toward the viewer (-Y): rotations then stay in screen plane.
    b.align_roll(Vector((0, -1, 0)))
for name, (_, _, parent) in BONES.items():
    if parent:
        arm_data.edit_bones[name].parent = arm_data.edit_bones[parent]
bpy.ops.object.mode_set(mode="OBJECT")

mod = mesh_obj.modifiers.new("Armature", "ARMATURE")
mod.object = arm_obj
mesh_obj.parent = arm_obj

# ---- render helpers (debug / pose checks) ----
sc = bpy.context.scene
sc.render.fps = FPS


def setup_render(scale, size):
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.light = "FLAT"
    cam = bpy.data.cameras.new("c")
    cam.type = "ORTHO"
    cam.ortho_scale = scale
    co = bpy.data.objects.new("c", cam)
    sc.collection.objects.link(co)
    sc.camera = co
    sc.render.resolution_x = sc.render.resolution_y = size
    return co


def render(co, name, loc, rot):
    co.location = loc
    co.rotation_euler = [math.radians(a) for a in rot]
    sc.render.filepath = os.path.join(DBG_DIR, name + ".png")
    bpy.ops.render.render(write_still=True)


if DEBUG:
    base = len(me.materials)
    for n in BONES:
        m = bpy.data.materials.new("dbg_" + n)
        m.diffuse_color = (*DEBUG_COLORS[n], 1)
        me.materials.append(m)
    slot = {n: base + i for i, n in enumerate(BONES)}
    vg_of = {i: s.bone for s in shards for i in s.verts}
    for p in me.polygons:
        p.material_index = slot[vg_of[p.vertices[0]]]
    sc.display.shading.color_type = "MATERIAL"
    co = setup_render(2.8, 800)
    render(co, "dbg_front", (0, -6, 1.2), (90, 0, 0))
    render(co, "dbg_side", (6, 0, 1.2), (90, 0, 90))
    render(co, "dbg_back", (0, 6, 1.2), (90, 0, 180))
    co.data.ortho_scale = 1.0
    render(co, "dbg_face", (-0.15, -6, 1.55), (90, 0, 0))
    sys.exit(0)

# ---- bake clips: one action + NLA track per clip ----
def eased(keys, t):
    """Smoothstep between (t, *values) keys, wrapping around the loop."""
    ks = sorted(keys)
    ks = [(ks[-1][0] - 1, *ks[-1][1:])] + ks + [(ks[0][0] + 1, *ks[0][1:])]
    for k0, k1 in zip(ks, ks[1:]):
        if k0[0] <= t <= k1[0]:
            u = 0.0 if k1[0] == k0[0] else (t - k0[0]) / (k1[0] - k0[0])
            u = u * u * (3 - 2 * u)
            return [a + (b - a) * u for a, b in zip(k0[1:], k1[1:])]
    return list(ks[0][1:])


def clip_angle(clip, bone, t):
    deg = clip.get("pose", {}).get(bone, 0.0)
    if bone in clip.get("keys", {}):
        deg += eased(clip["keys"][bone], t)[0]
    if bone in clip.get("sway", {}):
        amp, cycles, phase = clip["sway"][bone]
        deg += amp * math.sin(2 * math.pi * (cycles * t + phase))
    return deg


for name, clip in CLIPS.items():
    for part in ("pose", "keys", "sway", "scale", "depth"):
        unknown = set(clip.get(part, {})) - set(BONES)
        assert not unknown, f"{name}.{part}: unknown bones {unknown}"

# View axis (-Y, toward the camera) in each bone's rest frame: rotating around it keeps the bone
# in the screen plane even for bones that also point into depth.
view_axis = {b.name: (b.matrix_local.to_3x3().inverted() @ Vector((0, -1, 0))).normalized()
             for b in arm_data.bones}
scaled = {b for clip in CLIPS.values() for part in ("scale", "depth") for b in clip.get(part, {})}
pose_renders = {"read": 4, "fly": 4, "waitAngry": 4}
ad = arm_obj.animation_data_create()
for pb in arm_obj.pose.bones:
    pb.rotation_mode = "QUATERNION"
for name, clip in CLIPS.items():
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    ad.action = act
    frames = round(clip["seconds"] * FPS)
    for f in range(frames + 1):
        t = f / frames
        for pb in arm_obj.pose.bones:
            ang = math.radians(clip_angle(clip, pb.name, t))
            pb.rotation_quaternion = Quaternion(view_axis[pb.name], ang)
            pb.keyframe_insert("rotation_quaternion", frame=f, group=pb.name)
            if pb.name in scaled:
                sx, sy = eased(clip["scale"][pb.name], t) if pb.name in clip.get("scale", {}) else (1, 1)
                pb.scale = (sx, sy, clip.get("depth", {}).get(pb.name, 1))
                pb.keyframe_insert("scale", frame=f, group=pb.name)
    if POSES and name in pose_renders:
        if not sc.camera:
            for m in me.materials:
                if m and "outline" in m.name.lower():
                    m.diffuse_color = (0.12, 0.0, 0.2, 1)
            # Cull back faces so the inverted-hull outline only shows as a rim, like in the app.
            sc.display.shading.show_backface_culling = True
            sc.display.shading.color_type = "TEXTURE"
            setup_render(3.6, 700)
        n = pose_renders[name]
        for i in range(n):
            sc.frame_set(round(frames * i / n))
            render(sc.camera, f"pose_{name}_{i}", (0, -6, 1.1), (90, 0, 0))
    track = ad.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 0, act)
    if hasattr(strip, "action_slot") and act.slots:
        strip.action_slot = act.slots[0]
    track.mute = True
    ad.action = None
    print("CLIP", name, "%.1fs" % clip["seconds"], frames + 1, "frames")
for pb in arm_obj.pose.bones:
    pb.rotation_quaternion = (1, 0, 0, 0)
    pb.scale = (1, 1, 1)

bpy.ops.object.select_all(action="SELECT")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    use_selection=True,
    export_skins=True,
    export_def_bones=True,
    export_animations=True,
    export_animation_mode="ACTIONS",
    export_force_sampling=True,
    export_frame_step=1,
    export_reset_pose_bones=True,
    export_anim_slide_to_zero=True,
)
shutil.copy(OUT, PUBLIC)
print("EXPORTED", OUT)
