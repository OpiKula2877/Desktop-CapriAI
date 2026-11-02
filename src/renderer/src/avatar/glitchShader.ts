// Full-screen post pass that gives Capri her anime look:
//  - glittering star-field on her hair only (screen space, like the show)
//  - pixel-block dissolve when she teleports / materializes
//  - offset violet rim around the silhouette
//  - glitch (slices + RGB split) only during events: dashes, teleports, anger, meltdown

export const glitchVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export const glitchFragment = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform sampler2D tMask;    // white where hair is
uniform float uPulse;      // 0..1 beat / hover pulse
uniform float uDissolve;   // 0..1 pixel dissolve (1 = gone)
uniform float uTime;
uniform float uGlitch;   // 0..1 burst intensity
uniform float uAnger;    // 0..1
uniform vec2 uRes;       // render target size in px
uniform vec2 uDir;       // dash direction (for directional RGB smear)
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

// Star field in screen space: sparse cells, each may hold a twinkling star.
float stars(vec2 px, float cell, float density, float t) {
  vec2 c = floor(px / cell);
  float h = hash(c);
  if (h > density) return 0.0;
  vec2 p = (vec2(hash(c + 3.1), hash(c + 7.7)) * 0.7 + 0.15) * cell;
  float d = length(px - c * cell - p);
  float size = mix(0.5, 1.6, hash(c + 1.3)) * (cell / 9.0);
  float tw = 0.55 + 0.45 * sin(t * mix(1.5, 5.0, hash(c + 9.2)) + h * 40.0);
  return smoothstep(size + 0.9, size * 0.3, d) * tw;
}

vec4 tap(vec2 uv) { return texture2D(tDiffuse, uv); }

void main() {
  vec2 uv = vUv;
  vec2 px = vUv * uRes;
  float g = clamp(uGlitch, 0.0, 1.0);
  float t = floor(uTime * 24.0);

  // --- event glitch: slice displacement ---
  if (g > 0.02) {
    float rows = mix(14.0, 40.0, hash(vec2(t, 1.0)));
    float row = floor(uv.y * rows);
    if (hash(vec2(row, t)) < g * 0.6) uv.x += (hash(vec2(row, t + 7.0)) - 0.5) * 0.18 * g;
  }

  vec2 split = (uDir * 0.012 + vec2(0.006, 0.0)) * g;
  vec4 cg = tap(uv);
  vec4 cr = tap(uv + split);
  vec4 cb = tap(uv - split);
  vec3 col = g > 0.02 ? vec3(cr.r, cg.g, cb.b) : cg.rgb;
  float a = g > 0.02 ? max(cg.a, max(cr.a, cb.a)) : cg.a;

  // Work in straight (un-premultiplied) sRGB from here on.
  vec3 c = a > 0.001 ? pow(clamp(col / max(a, 0.001), 0.0, 1.0), vec3(1.0 / 2.2)) : vec3(0.0);

  // --- glitter on red parts (hair, body panels) ---
  float hair = texture2D(tMask, uv).r;
  float red = hair * smoothstep(0.6, 0.8, c.r) * (1.0 - smoothstep(0.25, 0.45, c.g)) * (1.0 - smoothstep(0.45, 0.65, c.b));
  if (red > 0.0) {
    // the show's crimson with a slow vertical sheen
    vec3 crimson = mix(vec3(0.83, 0.04, 0.24), vec3(1.0, 0.13, 0.33), 0.5 + 0.5 * sin(px.y * 0.018 + uTime * 0.6));
    c = mix(c, crimson, red * 0.85);
    float st = stars(px, 7.0, 0.16, uTime) + stars(px + 3.0, 15.0, 0.22, uTime * 0.7) * 1.2;
    c += vec3(1.0, 0.92, 0.96) * st * red;
  }

  // --- violet offset rim (outside the silhouette) ---
  if (a < 0.5) {
    vec2 o = (1.6 + 1.8 * uPulse) / uRes;
    float rim = max(max(tap(uv + vec2(o.x, -o.y)).a, tap(uv + vec2(o.x * 1.8, 0.0)).a), tap(uv + vec2(0.0, -o.y * 1.8)).a);
    rim = clamp(rim - a, 0.0, 1.0);
    c = mix(c, mix(vec3(0.58, 0.33, 1.0), vec3(0.85, 0.7, 1.0), uPulse), rim / max(a + rim, 0.001));
    a = max(a, rim);
  }

  // --- anger: hot tint + rare flash ---
  float flick = step(0.96, hash(vec2(t, 5.0))) * uAnger;
  c = mix(c, vec3(c.r * 1.1 + 0.08, c.g * 0.55, c.b * 0.65), uAnger * 0.45);
  c += vec3(0.5, 0.0, 0.1) * flick;

  // --- pixel dissolve: 5px blocks vanish in random order, with a green edge ---
  if (uDissolve > 0.001) {
    float b = hash(floor(px / 5.0) + 0.37);
    float edge = smoothstep(uDissolve - 0.08, uDissolve, b);
    if (b < uDissolve) a = 0.0;
    else c = mix(vec3(0.1, 0.94, 0.48), c, edge);
  }

  gl_FragColor = vec4(clamp(c, 0.0, 1.0) * a, a);
}
`
