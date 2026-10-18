import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/* deterministic utilities                                             */
/* ------------------------------------------------------------------ */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export function dampVec3(out, target, lambda, dt) {
  out.x = damp(out.x, target.x, lambda, dt);
  out.y = damp(out.y, target.y, lambda, dt);
  out.z = damp(out.z, target.z, lambda, dt);
  return out;
}

/* ------------------------------------------------------------------ */
/* procedural noise                                                    */
/* ------------------------------------------------------------------ */

function hash3(ix, iy, iz, seed) {
  let h = ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

const fade = (t) => t * t * (3 - 2 * t);

export function noise3(x, y, z, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
  const c000 = hash3(ix, iy, iz, seed);
  const c100 = hash3(ix + 1, iy, iz, seed);
  const c010 = hash3(ix, iy + 1, iz, seed);
  const c110 = hash3(ix + 1, iy + 1, iz, seed);
  const c001 = hash3(ix, iy, iz + 1, seed);
  const c101 = hash3(ix + 1, iy, iz + 1, seed);
  const c011 = hash3(ix, iy + 1, iz + 1, seed);
  const c111 = hash3(ix + 1, iy + 1, iz + 1, seed);
  const x00 = lerp(c000, c100, fx);
  const x10 = lerp(c010, c110, fx);
  const x01 = lerp(c001, c101, fx);
  const x11 = lerp(c011, c111, fx);
  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
}

export function fbm3(x, y, z, octaves = 5, lacunarity = 2.03, gain = 0.5, seed = 0) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise3(x, y, z, seed + i * 17) * amp;
    norm += amp;
    x *= lacunarity; y *= lacunarity; z *= lacunarity;
    amp *= gain;
  }
  return sum / norm;
}

export function ridged3(x, y, z, octaves = 4, seed = 0) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += (1 - Math.abs(noise3(x, y, z, seed + i * 31))) * amp;
    norm += amp;
    x *= 2.11; y *= 2.11; z *= 2.11;
    amp *= 0.5;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ */
/* canvas textures                                                     */
/* ------------------------------------------------------------------ */

let glowTexture = null;
export function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.055, 'rgba(255,255,255,.98)');
  g.addColorStop(0.16, 'rgba(255,255,255,.68)');
  g.addColorStop(0.36, 'rgba(255,255,255,.17)');
  g.addColorStop(0.7, 'rgba(255,255,255,.025)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowTexture = new THREE.CanvasTexture(canvas);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  glowTexture.minFilter = THREE.LinearFilter;
  return glowTexture;
}

let streakTexture = null;
export function getStreakTexture() {
  if (streakTexture) return streakTexture;
  const w = 64, h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.22, 'rgba(255,255,255,.6)');
  g.addColorStop(0.48, 'rgba(255,255,255,1)');
  g.addColorStop(0.72, 'rgba(255,255,255,.4)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(w * 0.36, 0, w * 0.28, h);
  ctx.filter = 'blur(5px)';
  ctx.drawImage(canvas, 0, 0);
  streakTexture = new THREE.CanvasTexture(canvas);
  streakTexture.colorSpace = THREE.SRGBColorSpace;
  return streakTexture;
}

export function makeLabelTexture(text, color = '#9fe8ff', options = {}) {
  const {
    font = '600 32px "SFMono-Regular", Consolas, monospace',
    pad = 18,
    align = 'center',
    letterSpacing = 3,
  } = options;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const spaced = letterSpacing ? text.split('').join('\u200a') : text;
  const metrics = ctx.measureText(spaced);
  canvas.width = Math.ceil(metrics.width) + pad * 2;
  canvas.height = 64;
  const c = canvas.getContext('2d');
  c.font = font;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillStyle = color;
  c.shadowColor = color;
  c.shadowBlur = 8;
  const x = align === 'center' ? canvas.width / 2 : pad;
  c.fillText(spaced, x, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  return { texture: tex, aspect: canvas.width / canvas.height };
}

export function makeLabelSprite(text, color = '#9fe8ff', height = 5) {
  const { texture, aspect } = makeLabelTexture(text, color);
  const material = new THREE.SpriteMaterial({
    map: texture,
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(height * aspect, height, 1);
  return sprite;
}

export function formatClock(seconds) {
  const total = 14 * 3600 + 32 * 60 + 8 + Math.floor(seconds * 8);
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}


let burstTexture = null;
export function getBurstTexture() {
  if (burstTexture) return burstTexture;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.5);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.035, 'rgba(255,255,255,.97)');
  core.addColorStop(0.12, 'rgba(235,225,255,.55)');
  core.addColorStop(0.32, 'rgba(180,150,255,.12)');
  core.addColorStop(1, 'rgba(120,90,220,0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);

  const rng = mulberry32(6617);
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowColor = 'rgba(220,208,255,.8)';
  ctx.shadowBlur = 3;
  for (let i = 0; i < 34; i++) {
    const a = (i / 34) * Math.PI * 2 + rng() * 0.12;
    const inner = 9 + rng() * 12;
    const outer = 55 + rng() * 66;
    const width = 0.45 + Math.pow(rng(), 2) * 2.2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    const g = ctx.createLinearGradient(inner, 0, outer, 0);
    g.addColorStop(0, 'rgba(255,255,255,.92)');
    g.addColorStop(0.55, 'rgba(238,228,255,.34)');
    g.addColorStop(1, 'rgba(210,190,255,0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(inner, 0);
    ctx.lineTo(outer, 0);
    ctx.stroke();
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
  burstTexture = new THREE.CanvasTexture(canvas);
  burstTexture.colorSpace = THREE.SRGBColorSpace;
  burstTexture.minFilter = THREE.LinearFilter;
  return burstTexture;
}

export const shipPalette = {
  freight: { primary: 0x84d8ff, secondary: 0x4573a1, trail: 0x7edcff },
  courier: { primary: 0x6df5f1, secondary: 0x2d7f92, trail: 0x63fff1 },
  miner: { primary: 0xffd18a, secondary: 0x9a6c3b, trail: 0xffc078 },
  patrol: { primary: 0x7aa8ff, secondary: 0x34558f, trail: 0x7aa8ff },
  drone: { primary: 0x9df9e8, secondary: 0x3f7385, trail: 0x9df9e8 },
  capital: { primary: 0xc1a8ff, secondary: 0x58428f, trail: 0xb69cff },
  unknown: { primary: 0xff6b78, secondary: 0x632a34, trail: 0xff5a6b },
};
