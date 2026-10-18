import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, noise3, getGlowTexture, shipPalette } from './utils.js';

/* ------------------------------------------------------------------ */
/* materials                                                           */
/* ------------------------------------------------------------------ */

export function hdrMaterial(hex, intensity = 2.0) {
  const color = new THREE.Color(hex).multiplyScalar(intensity);
  return new THREE.MeshBasicMaterial({ color, toneMapped: false });
}

export const mats = {
  hullDark: new THREE.MeshStandardMaterial({ color: 0x27313d, metalness: 0.58, roughness: 0.46 }),
  hullMid: new THREE.MeshStandardMaterial({ color: 0x44515f, metalness: 0.56, roughness: 0.48 }),
  hullLight: new THREE.MeshStandardMaterial({ color: 0x697783, metalness: 0.54, roughness: 0.42 }),
  hullEdge: new THREE.MeshStandardMaterial({ color: 0x98a5ae, metalness: 0.72, roughness: 0.3 }),
  black: new THREE.MeshStandardMaterial({ color: 0x070b10, metalness: 0.55, roughness: 0.6 }),
  solar: new THREE.MeshStandardMaterial({ color: 0x102a46, metalness: 0.55, roughness: 0.28, emissive: 0x061a2e, emissiveIntensity: 0.55 }),
  solarLine: new THREE.MeshStandardMaterial({ color: 0x365771, metalness: 0.8, roughness: 0.32 }),
  cargoA: new THREE.MeshStandardMaterial({ color: 0x3b4148, metalness: 0.55, roughness: 0.62 }),
  cargoB: new THREE.MeshStandardMaterial({ color: 0x533f34, metalness: 0.4, roughness: 0.68 }),
  cargoC: new THREE.MeshStandardMaterial({ color: 0x263a45, metalness: 0.5, roughness: 0.55 }),
  winWarm: hdrMaterial(0xffc172, 2.6),
  winCool: hdrMaterial(0x83dcff, 2.8),
  winWhite: hdrMaterial(0xe7f5ff, 3.0),
  amber: hdrMaterial(0xffae57, 2.4),
  amberDim: hdrMaterial(0x9f5d20, 1.2),
  cyan: hdrMaterial(0x6fe6ff, 2.8),
  violet: hdrMaterial(0xb78cff, 2.6),
  red: hdrMaterial(0xff5369, 2.8),
  navRed: hdrMaterial(0xff334f, 4.0),
  navGreen: hdrMaterial(0x54ff9d, 4.0),
  navWhite: hdrMaterial(0xffffff, 5.0),
  rock: new THREE.MeshStandardMaterial({ color: 0x5c5750, metalness: 0.1, roughness: 0.98, flatShading: true }),
  rockDark: new THREE.MeshStandardMaterial({ color: 0x403d39, metalness: 0.08, roughness: 1, flatShading: true }),
  mineral: hdrMaterial(0xffbe72, 1.7),
};

/* ------------------------------------------------------------------ */
/* reusable geometry builder                                           */
/* ------------------------------------------------------------------ */

const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 12);
const CYL6 = new THREE.CylinderGeometry(1, 1, 1, 6);
const SPH = new THREE.SphereGeometry(1, 12, 8);
const OCT = new THREE.OctahedronGeometry(1, 0);

class GeoBuilder {
  constructor() {
    this.parts = new Map();
  }

  add(geometry, material, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) {
    let g = geometry.clone();
    if (g.index) g = g.toNonIndexed();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation));
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...position),
      q,
      new THREE.Vector3(...scale)
    );
    g.applyMatrix4(m);
    const list = this.parts.get(material) || [];
    list.push(g);
    this.parts.set(material, list);
  }

  box(w, h, d, x, y, z, material, rotation = [0, 0, 0]) {
    this.add(BOX, material, [x, y, z], rotation, [w, h, d]);
  }

  cyl(radius, height, x, y, z, material, rotation = [0, 0, 0], radiusTop = radius, segments = 12) {
    this.add(segments === 6 ? CYL6 : CYL, material, [x, y, z], rotation, [radius, height, radiusTop]);
  }

  sphere(radius, x, y, z, material, scale = [1, 1, 1]) {
    this.add(SPH, material, [x, y, z], [0, 0, 0], [radius * scale[0], radius * scale[1], radius * scale[2]]);
  }

  torus(radius, tube, x, y, z, material, rotation = [0, 0, 0], radial = 10, tubular = 48) {
    this.add(new THREE.TorusGeometry(radius, tube, radial, tubular), material, [x, y, z], rotation);
  }

  wedge(frontWidth, backWidth, frontHeight, backHeight, length, x, y, z, material, rotation = [0, 0, 0]) {
    this.add(wedgeGeometry(frontWidth, backWidth, frontHeight, backHeight, length), material, [x, y, z], rotation);
  }

  build() {
    const group = new THREE.Group();
    for (const [material, parts] of this.parts) {
      const geo = mergeGeometries(parts, false);
      if (!geo) continue;
      geo.computeBoundingSphere();
      group.add(new THREE.Mesh(geo, material));
    }
    return group;
  }
}

function wedgeGeometry(frontWidth, backWidth, frontHeight, backHeight, length) {
  const fl = length * 0.5;
  const fw = frontWidth * 0.5, bw = backWidth * 0.5;
  const fh = frontHeight * 0.5, bh = backHeight * 0.5;
  const v = [
    // front face
    [-fw, -fh, fl], [fw, -fh, fl], [fw, fh, fl], [-fw, fh, fl],
    // back face
    [-bw, -bh, -fl], [bw, -bh, -fl], [bw, bh, -fl], [-bw, bh, -fl],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3],
    [5, 4, 7], [5, 7, 6],
    [1, 5, 6], [1, 6, 2],
    [4, 0, 3], [4, 3, 7],
    [3, 2, 6], [3, 6, 7],
    [4, 5, 1], [4, 1, 0],
  ];
  const positions = [];
  const uvs = [];
  for (const f of faces) {
    for (const i of f) {
      positions.push(...v[i]);
      uvs.push(v[i][0] * 0.12 + 0.5, v[i][2] * 0.12 + 0.5);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

function wingGeometry(span, rootChord, tipChord, sweep, thickness) {
  const t = thickness * 0.5;
  const points = [
    [0, rootChord * 0.5, 0],
    [span, -sweep + tipChord * 0.5, 0],
    [span, -sweep - tipChord * 0.5, 0],
    [0, -rootChord * 0.5, 0],
  ];
  const verts = [];
  const idx = [];
  for (const p of points) verts.push(p[0], -t, p[1]);
  for (const p of points) verts.push(p[0], t, p[1]);
  for (let i = 0; i < 4; i++) {
    const n = (i + 1) % 4;
    idx.push(i, n, n + 4, i, n + 4, i + 4);
  }
  // top / bottom caps
  idx.push(0, 1, 2, 0, 2, 3);
  idx.push(4, 6, 5, 4, 7, 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((verts.length / 3) * 2).fill(0.5), 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function addWingPair(builder, material, span, rootChord, tipChord, sweep, thickness, x, y, z) {
  const right = wingGeometry(span, rootChord, tipChord, sweep, thickness);
  builder.add(right, material, [x, y, z], [0, 0, 0], [1, 1, 1]);
  let left = right.clone();
  left.scale(-1, 1, 1);
  if (left.index) {
    const arr = left.index.array;
    for (let i = 0; i < arr.length; i += 3) {
      const b = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = b;
    }
    left.index.needsUpdate = true;
  }
  left.computeVertexNormals();
  builder.add(left, material, [x, y, z], [0, 0, 0], [1, 1, 1]);
}

/* ------------------------------------------------------------------ */
/* ship specifications                                                 */
/* ------------------------------------------------------------------ */

export const SHIP_SPECS = {
  freight: {
    label: 'Heavy freighter',
    length: 37,
    radius: 18,
    hullDetail: 1,
    engines: [
      { x: -4.2, y: -1.6, z: -18.6, scale: 0.55, power: 1.0 },
      { x: 4.2, y: -1.6, z: -18.6, scale: 0.55, power: 1.0 },
      { x: -4.2, y: 1.6, z: -18.6, scale: 0.48, power: 0.85 },
      { x: 4.2, y: 1.6, z: -18.6, scale: 0.48, power: 0.85 },
    ],
    thrusters: [
      [-5.3, 0.8, 8], [5.3, 0.8, 8], [-5.3, 0.8, -5], [5.3, 0.8, -5],
      [-4.9, -2.3, 13], [4.9, -2.3, 13], [-4.9, 2.4, -13], [4.9, 2.4, -13],
    ],
    navLights: [
      [-6.2, 1.1, 2], [6.2, 1.1, 2], [0, 3.8, 16.2], [0, 3.9, -17.2],
    ],
    windowColor: 'warm',
  },
  courier: {
    label: 'Courier',
    length: 9.5,
    radius: 6,
    hullDetail: 1,
    engines: [
      { x: -1.25, y: 0.1, z: -4.9, scale: 0.18, power: 1.0 },
      { x: 1.25, y: 0.1, z: -4.9, scale: 0.18, power: 1.0 },
    ],
    thrusters: [
      [-0.6, 0.2, 2.9], [0.6, 0.2, 2.9], [-1.9, 0.1, -0.6], [1.9, 0.1, -0.6],
      [0, 0.65, -2.4],
    ],
    navLights: [[-3.2, 0.1, -0.8], [3.2, 0.1, -0.8], [0, 0.5, 3.9]],
    windowColor: 'cool',
  },
  miner: {
    label: 'Industrial miner',
    length: 26,
    radius: 13,
    hullDetail: 1,
    engines: [
      { x: -2.8, y: 0, z: -13.4, scale: 0.42, power: 1.0 },
      { x: 2.8, y: 0, z: -13.4, scale: 0.42, power: 1.0 },
    ],
    thrusters: [
      [-4.2, 1.0, 5], [4.2, 1.0, 5], [-4.2, -1.1, -3], [4.2, -1.1, -3],
      [0, 2.5, -10],
    ],
    navLights: [[-4.8, 1.2, 1], [4.8, 1.2, 1], [0, 2.6, 10.2]],
    windowColor: 'warm',
  },
  patrol: {
    label: 'Patrol interceptor',
    length: 14,
    radius: 7.5,
    hullDetail: 1,
    engines: [
      { x: -1.3, y: 0, z: -6.2, scale: 0.22, power: 1.0 },
      { x: 1.3, y: 0, z: -6.2, scale: 0.22, power: 1.0 },
    ],
    thrusters: [
      [-0.9, 0.15, 3.2], [0.9, 0.15, 3.2], [-2.8, 0.1, 0], [2.8, 0.1, 0],
    ],
    navLights: [[-3.9, 0.1, -1.6], [3.9, 0.1, -1.6], [0, 0.6, 5.5]],
    windowColor: 'cool',
  },
  drone: {
    label: 'Maintenance drone',
    length: 4.4,
    radius: 2.5,
    hullDetail: 0,
    engines: [
      { x: 0, y: 0, z: -2.2, scale: 0.07, power: 0.8 },
    ],
    thrusters: [
      [-1.1, 0.8, 0], [1.1, 0.8, 0], [-1.1, -0.8, 0], [1.1, -0.8, 0],
      [0, 0.8, 1.1], [0, -0.8, -1.1],
    ],
    navLights: [[0, 1.1, -0.8]],
    windowColor: 'cool',
  },
  capital: {
    label: 'Capital dreadnought',
    length: 142,
    radius: 60,
    hullDetail: 2,
    engines: [
      { x: -12, y: -3.5, z: -69, scale: 1.55, power: 1.0 },
      { x: -4, y: -3.5, z: -69, scale: 1.7, power: 1.0 },
      { x: 4, y: -3.5, z: -69, scale: 1.7, power: 1.0 },
      { x: 12, y: -3.5, z: -69, scale: 1.55, power: 1.0 },
      { x: -8, y: 4.2, z: -69, scale: 1.2, power: 0.8 },
      { x: 8, y: 4.2, z: -69, scale: 1.2, power: 0.8 },
    ],
    thrusters: [
      [-20, 3, 22], [20, 3, 22], [-27, 1, -12], [27, 1, -12],
      [-16, 7, 36], [16, 7, 36], [0, 8, -55],
    ],
    navLights: [[-29, 4, -8], [29, 4, -8], [0, 12, 58], [0, -8, -35]],
    windowColor: 'mixed',
  },
  unknown: {
    label: 'Unknown signature',
    length: 12,
    radius: 6.5,
    hullDetail: 1,
    engines: [
      { x: -1.2, y: 0, z: -5.2, scale: 0.15, power: 1.0 },
      { x: 1.2, y: 0, z: -5.2, scale: 0.15, power: 1.0 },
    ],
    thrusters: [
      [-1.6, 0.1, 0], [1.6, 0.1, 0], [0, 0.4, 3.2],
    ],
    navLights: [[-3.4, 0.1, -0.9], [3.4, 0.1, -0.9]],
    windowColor: 'red',
  },
};

/* ------------------------------------------------------------------ */
/* ship models                                                         */
/* ------------------------------------------------------------------ */

function buildFreighter(accent) {
  const b = new GeoBuilder();
  const dark = mats.hullDark, mid = mats.hullMid, light = mats.hullLight;

  // main spine and keel
  b.box(4.2, 4.6, 30, 0, 0, 0, dark);
  b.box(5.6, 2.0, 24, 0, -3.0, -1, mid);
  b.box(2.2, 1.1, 33, 0, 3.0, -1, light);
  b.wedge(4.5, 6.5, 3.6, 4.2, 5.5, 0, 0.1, 17.8, dark);
  b.wedge(5.5, 7.5, 2.2, 3.2, 4.4, 0, 0.4, 15.4, mid);

  // bridge
  b.box(7.0, 3.0, 5.0, 0, 3.6, 13.0, mid);
  b.box(7.8, 0.7, 5.6, 0, 5.2, 13.0, light);
  b.box(7.4, 0.25, 4.6, 0, 5.62, 13.2, mats.winCool);
  b.box(0.5, 0.2, 3.4, -3.72, 3.8, 13.1, mats.winWarm);
  b.box(0.5, 0.2, 3.4, 3.72, 3.8, 13.1, mats.winWarm);

  // cargo containers, staggered and clamped
  const cargoMats = [mats.cargoA, mats.cargoB, mats.cargoC];
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < 3; i++) {
      for (let row = 0; row < 2; row++) {
        const z = -10 + i * 7.2 + (row ? 1.2 : 0);
        const y = -1.7 + row * 3.5;
        b.box(2.8, 2.9, 6.2, side * 3.9, y, z, cargoMats[(i + row + (side > 0 ? 1 : 0)) % 3]);
        b.box(2.9, 0.14, 6.3, side * 3.9, y + 1.45, z, mats.hullEdge);
        b.box(2.9, 0.14, 6.3, side * 3.9, y - 1.45, z, mats.hullEdge);
      }
    }
    // outrigger trusses
    b.box(0.32, 0.32, 10.4, side * 2.7, 1.8, 9.2, light);
    b.box(0.32, 0.32, 10.4, side * 2.7, 1.8, -10.0, light);
    b.box(0.25, 0.25, 31, side * 5.3, -2.8, -1.2, dark);
    b.box(0.9, 1.8, 3.2, side * 5.25, 2.45, 8.5, mid);
    b.box(0.9, 1.8, 3.2, side * 5.25, 2.45, -7.0, mid);
    // accent navigation stripe
    b.box(0.1, 0.35, 12, side * 5.33, -0.7, 1, accent);
  }

  // propulsion block
  b.box(9.4, 4.0, 5.2, 0, 0, -16.2, mid);
  b.box(8.2, 3.2, 1.0, 0, 0, -18.9, dark);
  for (const side of [-1, 1]) {
    for (const y of [-1.6, 1.6]) {
      b.cyl(1.02, 3.6, side * 4.2, y, -18.4, mats.hullEdge, [Math.PI / 2, 0, 0], 1.02);
      b.cyl(0.78, 2.4, side * 4.2, y, -19.1, mats.black, [Math.PI / 2, 0, 0], 0.72);
      b.box(2.8, 0.12, 2.4, side * 4.2, y + 1.02, -18.3, accent);
    }
  }

  // dorsal fins
  b.wedge(0.45, 1.4, 4.2, 0.2, 8.0, -5.4, 3.8, -8.2, mid, [0, 0, -0.06]);
  b.wedge(0.45, 1.4, 4.2, 0.2, 8.0, 5.4, 3.8, -8.2, mid, [0, 0, 0.06]);

  // warm running lights and tiny utility details
  for (let i = -12; i <= 12; i += 4) {
    b.box(0.08, 0.1, 1.5, 2.18, 2.36, i, i % 8 === 0 ? mats.winWarm : mats.amberDim);
  }
  b.box(1.2, 0.32, 0.32, -2.5, -2.7, 18.0, mats.amber);
  b.box(1.2, 0.32, 0.32, 2.5, -2.7, 18.0, mats.amber);
  b.box(0.24, 0.9, 0.24, 0, 4.6, 9.0, mats.hullEdge);

  return b.build();
}

function buildCourier(accent) {
  const b = new GeoBuilder();
  const dark = mats.hullDark, mid = mats.hullMid, light = mats.hullLight;

  b.wedge(1.5, 2.4, 1.15, 1.65, 7.5, 0, 0, 0.6, dark);
  b.wedge(1.0, 1.7, 0.8, 1.1, 3.4, 0, 0.35, 4.2, light);
  addWingPair(b, mid, 4.0, 3.4, 1.0, 1.9, 0.18, 0, -0.1, -0.2);
  addWingPair(b, dark, 2.2, 1.8, 0.5, 0.9, 0.12, 0, 0.58, -1.9);

  // nose and canopy
  b.wedge(0.6, 1.1, 0.55, 0.7, 2.2, 0, 0.18, 5.0, mats.hullEdge);
  b.box(0.92, 0.32, 1.65, 0, 0.63, 2.7, mats.winCool);
  b.box(0.48, 0.08, 0.48, 0, 0.86, 2.4, mats.winWhite);

  // twin engines and fins
  for (const side of [-1, 1]) {
    b.cyl(0.48, 2.4, side * 1.25, 0.05, -3.7, mid, [Math.PI / 2, 0, 0], 0.34);
    b.cyl(0.38, 0.5, side * 1.25, 0.05, -4.95, mats.black, [Math.PI / 2, 0, 0], 0.3);
    b.box(0.06, 0.25, 2.4, side * 1.74, 0.05, -3.4, accent);
    b.wedge(0.25, 0.42, 2.0, 0.15, 2.6, side * 1.75, 0.55, -3.9, mid, [0, 0, side * 0.18]);
  }
  b.box(0.1, 0.12, 2.5, -2.9, 0.02, -1.8, mats.amberDim);
  b.box(0.1, 0.12, 2.5, 2.9, 0.02, -1.8, mats.cyan);
  b.box(0.08, 0.08, 0.5, 0, 0.74, 3.7, mats.winWhite);

  return b.build();
}

function buildMiner(accent) {
  const b = new GeoBuilder();
  const dark = mats.hullDark, mid = mats.hullMid, light = mats.hullLight;

  b.box(5.2, 4.4, 16.5, 0, 0, -0.5, mid);
  b.box(3.4, 2.0, 5.2, 0, 2.6, 1.1, dark);
  b.wedge(4.8, 5.6, 3.8, 4.6, 4.2, 0, 0, 9.7, dark);
  b.box(4.0, 0.6, 2.2, 0, 3.6, 1.5, light);
  b.box(2.8, 0.16, 0.65, 0, 2.05, 7.0, mats.winWarm);

  // ore pods and industrial arms
  for (const side of [-1, 1]) {
    b.cyl(1.55, 10.5, side * 4.0, -0.2, -4.4, mats.cargoA, [Math.PI / 2, 0, 0], 1.55);
    b.cyl(1.3, 1.2, side * 4.0, -0.2, 1.4, mats.hullEdge, [Math.PI / 2, 0, 0], 1.3);
    b.cyl(1.3, 1.2, side * 4.0, -0.2, -10.2, mats.hullEdge, [Math.PI / 2, 0, 0], 1.3);
    b.box(0.28, 3.7, 0.28, side * 3.9, 2.2, 6.2, light, [0, 0, side * 0.38]);
    b.box(0.28, 3.7, 0.28, side * 3.9, 2.2, 8.4, light, [0, 0, -side * 0.38]);
    b.box(0.36, 0.36, 2.0, side * 2.5, 3.4, 10.0, mid);
    // forward floodlights
    b.box(0.55, 0.35, 0.35, side * 2.55, 1.1, 11.6, mats.amber);
  }
  b.box(5.6, 1.2, 2.1, 0, -2.3, 10.8, light);
  b.box(4.4, 0.35, 0.35, 0, -2.95, 11.8, mats.amber);
  b.box(2.3, 1.7, 2.8, 0, 0.1, 12.3, dark);
  b.cyl(0.7, 1.1, 0, 0.1, 13.6, mats.hullEdge, [Math.PI / 2, 0, 0], 0.7);
  b.cyl(0.42, 0.35, 0, 0.1, 14.25, mats.winWhite, [Math.PI / 2, 0, 0], 0.42);

  // rear engines and support machinery
  b.box(7.8, 3.4, 3.6, 0, 0, -11.8, mid);
  for (const side of [-1, 1]) {
    b.cyl(1.0, 3.4, side * 2.8, 0, -13.6, mats.black, [Math.PI / 2, 0, 0], 0.82);
    b.cyl(0.82, 2.4, side * 2.8, 0, -14.1, mats.hullEdge, [Math.PI / 2, 0, 0], 0.68);
  }
  b.box(0.15, 1.3, 9.2, -2.75, 1.2, -4.6, accent);
  b.box(0.15, 1.3, 9.2, 2.75, 1.2, -4.6, accent);
  for (let i = 0; i < 7; i++) {
    b.box(0.25, 0.35, 0.7, -2.53, 1.35, -8.5 + i * 2.6, mats.amberDim);
  }

  return b.build();
}

function buildPatrol(accent) {
  const b = new GeoBuilder();
  const dark = mats.hullDark, mid = mats.hullMid, light = mats.hullLight;

  b.wedge(1.4, 2.7, 1.1, 1.8, 9.2, 0, 0, 0.5, dark);
  b.wedge(0.9, 1.3, 0.7, 0.9, 3.0, 0, 0.5, 5.0, light);
  addWingPair(b, mid, 5.2, 4.0, 1.1, 2.6, 0.15, 0, -0.1, -0.7);
  addWingPair(b, dark, 2.3, 2.4, 0.8, 1.3, 0.1, 0, 0.48, -2.2);
  b.box(0.9, 0.3, 1.8, 0, 0.72, 2.7, mats.winCool);
  b.box(0.45, 0.1, 0.45, 0, 0.9, 2.2, mats.winWhite);

  for (const side of [-1, 1]) {
    b.cyl(0.42, 3.4, side * 1.3, -0.05, -4.7, mid, [Math.PI / 2, 0, 0], 0.34);
    b.cyl(0.34, 0.5, side * 1.3, -0.05, -6.45, mats.black, [Math.PI / 2, 0, 0], 0.26);
    b.wedge(0.22, 0.5, 2.5, 0.2, 2.8, side * 2.6, 0.5, -3.8, mid, [0, 0, side * 0.15]);
    b.box(0.1, 0.12, 1.6, side * 2.3, 0.2, 0.1, accent);
    b.box(0.1, 0.12, 2.7, side * 4.95, 0.01, -1.65, accent);
  }
  b.box(0.3, 0.4, 2.0, 0, -0.5, -2.0, mats.hullEdge);

  return b.build();
}

function buildDrone(accent) {
  const b = new GeoBuilder();
  const dark = mats.hullDark, mid = mats.hullMid;
  b.add(OCT, mid, [0, 0, 0], [0, 0, 0], [1.05, 0.85, 1.6]);
  b.add(OCT, dark, [0, 0, -0.3], [0, 0, 0], [0.65, 0.55, 1.05]);
  b.box(0.32, 0.32, 0.34, 0, 0.82, 0.1, mats.hullEdge);
  // four arms with tiny tools
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      b.box(1.5, 0.15, 0.15, sx * 0.9, sy * 0.55, 0, mid, [0, 0, sy * 0.1]);
      b.cyl(0.16, 0.4, sx * 1.62, sy * 0.55, 0, mats.hullEdge, [0, 0, Math.PI / 2], 0.12, 6);
      b.sphere(0.11, sx * 1.82, sy * 0.55, 0, mats.winWarm);
    }
  }
  b.box(0.5, 0.2, 0.3, 0, 0.7, 0.9, accent);
  b.cyl(0.22, 0.6, 0, 0, -1.7, mats.black, [Math.PI / 2, 0, 0], 0.18, 6);
  return b.build();
}

function buildCapital(accent) {
  const b = new GeoBuilder();
  const dark = mats.hullDark, mid = mats.hullMid, light = mats.hullLight;

  // dagger-shaped primary hull
  b.wedge(5.5, 23.0, 3.2, 11.0, 92, 0, 0, 3, dark);
  b.wedge(9.0, 29.0, 2.4, 8.0, 48, 0, -3.2, 2, mid);
  b.wedge(4.4, 17.0, 2.0, 7.0, 65, 0, 4.2, -1, mid);
  b.wedge(2.0, 8.0, 1.2, 3.6, 32, 0, 7.0, 8, light);
  b.wedge(0.8, 4.2, 0.8, 2.0, 28, 0, 8.8, 29, mats.hullEdge);

  // layered command superstructure
  b.box(15, 4.4, 26, 0, 7.3, 20, mid);
  b.box(11, 3.6, 17, 0, 10.8, 23, dark);
  b.box(7.4, 2.8, 10, 0, 13.7, 25, light);
  b.box(10.5, 0.32, 4.0, 0, 12.0, 30, mats.winCool);
  for (const y of [8.4, 10.9, 13.3]) {
    b.box(11.2, 0.24, 10.8, 0, y, 26.5, mats.winWarm);
  }
  b.box(0.4, 1.1, 8.5, -5.62, 11.0, 23, mats.winCool);
  b.box(0.4, 1.1, 8.5, 5.62, 11.0, 23, mats.winCool);

  // armoured side wings / broadside decks
  for (const side of [-1, 1]) {
    b.wedge(3.0, 5.0, 2.2, 3.0, 40, side * 15.5, 0.3, 3, mid, [0, side * 0.12, 0]);
    b.box(7.5, 1.2, 31, side * 19.5, -0.2, 4, dark, [0, side * 0.12, 0]);
    b.box(0.4, 0.5, 29, side * 23.2, 0.5, 4, accent, [0, side * 0.12, 0]);
    // turrets
    for (let i = 0; i < 4; i++) {
      const z = -22 + i * 14;
      b.cyl(1.5, 0.9, side * 20.2, 1.2, z, mats.hullEdge, [0, 0, 0], 1.5, 8);
      b.cyl(0.4, 3.2, side * 20.2, 1.8, z + 1.4, mats.hullMid, [Math.PI / 2, 0, 0], 0.3, 6);
    }
    // hangar openings
    b.box(1.0, 2.2, 6.4, side * 23.0, -2.0, 8, mats.amberDim);
    b.box(0.9, 0.16, 5.6, side * 23.4, -1.2, 8, mats.winWarm);
    // vertical fins
    b.wedge(0.5, 1.5, 5.2, 0.3, 12, side * 9.5, 6.0, -25, mid, [0, 0, side * 0.16]);
  }

  // engine block with six nozzles
  b.box(31, 7.0, 15, 0, -0.6, -58, dark);
  b.box(36, 2.0, 8, 0, -1.4, -64, mid);
  b.box(0.35, 1.0, 30, -17.5, 1.5, -42, accent);
  b.box(0.35, 1.0, 30, 17.5, 1.5, -42, accent);
  for (const e of SHIP_SPECS.capital.engines) {
    b.cyl(1.72 * e.scale, 4.2, e.x, e.y, e.z + 0.5, mats.hullEdge, [Math.PI / 2, 0, 0], 1.6 * e.scale, 12);
    b.cyl(1.26 * e.scale, 3.0, e.x, e.y, e.z - 0.8, mats.black, [Math.PI / 2, 0, 0], 1.12 * e.scale, 12);
    b.box(3.6 * e.scale, 0.14, 1.4, e.x, e.y + 1.6 * e.scale, e.z + 0.5, accent);
  }

  // window rows along the flanks
  for (let i = 0; i < 20; i++) {
    const z = -48 + i * 5.0;
    for (const side of [-1, 1]) {
      b.box(0.22, 0.16, 1.7, side * 15.0, 2.0, z, i % 4 === 0 ? mats.winWarm : mats.amberDim);
    }
  }
  for (let i = 0; i < 8; i++) {
    b.box(0.2, 0.2, 1.0, -7.5 + i * 2.1, 4.0, 57, mats.winCool);
  }
  // antennae
  b.box(0.2, 6.0, 0.2, 0, 16.8, 25, mats.hullEdge);
  b.sphere(0.32, 0, 19.8, 25, mats.winWhite);
  b.box(0.8, 0.8, 0.8, -4.2, 9.6, 37, mats.amber);
  b.box(0.8, 0.8, 0.8, 4.2, 9.6, 37, mats.amber);

  return b.build();
}

function buildUnknown(accent) {
  const b = new GeoBuilder();
  const dark = mats.black, mid = mats.hullDark;
  b.wedge(0.8, 2.4, 0.6, 1.4, 8.8, 0, 0, 0.2, dark);
  addWingPair(b, mid, 3.8, 3.6, 0.8, 2.1, 0.12, 0, -0.1, -0.9);
  addWingPair(b, dark, 1.7, 2.0, 0.45, 0.8, 0.08, 0, 0.35, -2.2);
  b.box(0.6, 0.22, 1.4, 0, 0.52, 2.6, mats.red);
  for (const side of [-1, 1]) {
    b.cyl(0.32, 2.4, side * 1.15, 0, -3.8, dark, [Math.PI / 2, 0, 0], 0.25);
    b.cyl(0.24, 0.3, side * 1.15, 0, -5.0, mats.red, [Math.PI / 2, 0, 0], 0.18);
    b.box(0.06, 0.1, 1.6, side * 2.5, 0, -0.5, mats.red);
  }
  return b.build();
}

const shipTemplateCache = new Map();

export function getShipTemplate(type) {
  if (shipTemplateCache.has(type)) return shipTemplateCache.get(type);
  const palette = shipPalette[type] || shipPalette.courier;
  const accent = hdrMaterial(palette.primary, 0.72);
  let mesh;
  if (type === 'freight') mesh = buildFreighter(accent);
  else if (type === 'courier') mesh = buildCourier(accent);
  else if (type === 'miner') mesh = buildMiner(accent);
  else if (type === 'patrol') mesh = buildPatrol(accent);
  else if (type === 'drone') mesh = buildDrone(accent);
  else if (type === 'capital') mesh = buildCapital(accent);
  else mesh = buildUnknown(accent);
  shipTemplateCache.set(type, mesh);
  return mesh;
}

/* ------------------------------------------------------------------ */
/* station                                                             */
/* ------------------------------------------------------------------ */

export const RING_RADIUS = 84;

function dockDefinition(id, label, type, angle, y, radius) {
  const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
  const pad = radial.clone().multiplyScalar(radius).setY(y);
  const outward = radial.clone();
  const berth = pad.clone().addScaledVector(outward, type === 'heavy' ? 11 : 7).add(new THREE.Vector3(0, type === 'heavy' ? 4.7 : 3.0, 0));
  const approach = pad.clone().addScaledVector(outward, type === 'heavy' ? 72 : 50).add(new THREE.Vector3(0, 3, 0));
  return {
    id,
    label,
    type,
    angle,
    radius,
    pad,
    outward,
    berth,
    approach,
    occupied: null,
    reservedBy: null,
  };
}

export const DOCKS = [
  dockDefinition('A-01', 'Helios Dock A-01', 'heavy', 0.34, -2, 119),
  dockDefinition('A-02', 'Helios Dock A-02', 'heavy', 2.48, 5, 121),
  dockDefinition('A-03', 'Helios Dock A-03', 'heavy', 4.56, -6, 119),
  dockDefinition('B-01', 'Express Bay B-01', 'express', 1.23, 20, 108),
  dockDefinition('B-02', 'Express Bay B-02', 'express', 3.59, -20, 110),
  dockDefinition('B-03', 'Express Bay B-03', 'express', 5.48, 14, 107),
  dockDefinition('C-01', 'Ore Processing C-01', 'miner', 2.98, -29, 112),
  dockDefinition('C-02', 'Ore Processing C-02', 'miner', 5.97, -24, 108),
];

export async function createStation() {
  const group = new THREE.Group();
  const b = new GeoBuilder();
  const anim = new THREE.Group();
  group.add(anim);

  // primary torus and layered truss work
  b.torus(RING_RADIUS, 5.6, 0, 0, 0, mats.hullMid, [Math.PI / 2, 0, 0], 14, 96);
  b.torus(RING_RADIUS - 6, 1.2, 0, 0, 0, mats.hullEdge, [Math.PI / 2, 0, 0], 6, 96);
  b.torus(RING_RADIUS + 7, 0.7, 0, 0, 0, mats.hullDark, [Math.PI / 2, 0, 0], 4, 96);
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const x = Math.cos(a) * (RING_RADIUS + 5.2);
    const z = Math.sin(a) * (RING_RADIUS + 5.2);
    b.box(1.9, 1.9, 0.65, x, 0, z, i % 7 === 0 ? mats.hullLight : mats.hullDark, [0, -a, 0]);
    b.box(0.55, 2.6, 0.7, Math.cos(a) * (RING_RADIUS + 4), 0.7, Math.sin(a) * (RING_RADIUS + 4), mats.hullEdge, [0, -a, 0]);
  }
  // amber ring running lights
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    b.box(1.15, 0.18, 0.32, Math.cos(a) * (RING_RADIUS - 4.8), 5.25, Math.sin(a) * (RING_RADIUS - 4.8), i % 4 === 0 ? mats.winWhite : mats.winWarm, [0, -a, 0]);
  }
  // inner ring
  b.torus(RING_RADIUS - 18, 1.4, 0, 0, 0, mats.hullDark, [Math.PI / 2, 0, 0], 6, 80);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    b.box(3.0, 1.1, 4.8, Math.cos(a) * (RING_RADIUS - 14), 0, Math.sin(a) * (RING_RADIUS - 14), i % 3 === 0 ? mats.hullLight : mats.hullMid, [0, -a, 0]);
  }

  // habitat modules distributed around the wheel
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.09;
    const r = RING_RADIUS;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    b.cyl(3.2, 8.0, x, 0, z, mats.hullMid, [0, -a, 0], 3.2, 8);
    b.cyl(4.1, 0.8, x, 0, z, mats.hullEdge, [0, -a, 0], 4.1, 8);
    for (let w = 0; w < 3; w++) {
      b.box(0.3, 0.22, 4.6, x + Math.cos(a) * 3.1, 1.4 + w * 1.1, z + Math.sin(a) * 3.1, mats.winWarm, [0, -a, 0]);
    }
  }

  // spokes and central spindle
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const r = (RING_RADIUS - 16) * 0.5;
    b.box(2.1, 1.6, RING_RADIUS - 16, Math.cos(a) * r, 0, Math.sin(a) * r, i % 2 ? mats.hullMid : mats.hullDark, [0, -a, 0]);
    b.box(0.55, 0.55, RING_RADIUS - 21, Math.cos(a) * r, 2.0, Math.sin(a) * r, mats.hullEdge, [0, -a, 0]);
    b.box(0.55, 0.55, RING_RADIUS - 21, Math.cos(a) * r, -2.0, Math.sin(a) * r, mats.hullEdge, [0, -a, 0]);
  }
  b.cyl(15.5, 35, 0, 0, 0, mats.hullMid, [0, 0, 0], 15.5, 20);
  b.cyl(18.5, 4.2, 0, 0, 0, mats.hullEdge, [0, 0, 0], 18.5, 24);
  b.cyl(12.5, 11, 0, 21, 0, mats.hullDark, [0, 0, 0], 10.5, 16);
  b.cyl(8.5, 9, 0, -20, 0, mats.hullMid, [0, 0, 0], 7.2, 12);
  b.cyl(3.6, 19, 0, 36, 0, mats.hullEdge, [0, 0, 0], 2.2, 10);
  b.cyl(6.2, 2.8, 0, 44, 0, mats.hullMid, [0, 0, 0], 4.6, 12);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    b.box(1.3, 0.16, 0.28, Math.cos(a) * 15.0, 2.2, Math.sin(a) * 15.0, mats.winWarm, [0, -a, 0]);
    b.box(1.3, 0.16, 0.28, Math.cos(a) * 15.0, 7.0, Math.sin(a) * 15.0, mats.winCool, [0, -a, 0]);
  }
  // central beacon and antennae
  b.sphere(0.8, 0, 47.5, 0, mats.winWhite);
  b.box(0.18, 8.0, 0.18, 0, 51, 0, mats.hullEdge);
  b.sphere(0.4, 0, 55, 0, mats.navRed);

  // docks: arms, clamps, approach lights
  for (const dock of DOCKS) {
    const { pad, angle, type } = dock;
    const inner = new THREE.Vector3(Math.cos(angle) * (RING_RADIUS - 4), pad.y * 0.35, Math.sin(angle) * (RING_RADIUS - 4));
    const mid = pad.clone().lerp(inner, 0.45);
    const armLen = pad.distanceTo(inner);
    b.box(3.8, 1.8, armLen, mid.x, mid.y, mid.z, type === 'heavy' ? mats.hullMid : mats.hullDark, [0, -angle, 0]);
    b.box(0.45, 0.5, armLen, mid.x, mid.y + 1.4, mid.z, mats.hullEdge, [0, -angle, 0]);
    b.cyl(type === 'heavy' ? 10.5 : 7.5, 1.5, pad.x, pad.y, pad.z, mats.hullEdge, [0, 0, 0], type === 'heavy' ? 10.5 : 7.5, 12);
    b.cyl(type === 'heavy' ? 8.0 : 5.5, 0.75, pad.x, pad.y + 1.05, pad.z, mats.hullDark, [0, 0, 0], 8.0, 12);
    // guide lights around pad
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const px = pad.x + Math.cos(a) * (type === 'heavy' ? 9.2 : 6.5);
      const pz = pad.z + Math.sin(a) * (type === 'heavy' ? 9.2 : 6.5);
      b.box(0.45, 0.14, 0.45, px, pad.y + 0.9, pz, i % 2 ? mats.amber : mats.winWhite);
    }
    // docking clamps
    for (const side of [-1, 1]) {
      const perp = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle)).multiplyScalar(side * (type === 'heavy' ? 7.2 : 4.8));
      b.box(1.2, 3.2, 1.2, pad.x + perp.x, pad.y + 2.0, pad.z + perp.z, mats.hullMid);
      b.box(0.3, 0.6, 0.3, pad.x + perp.x, pad.y + 3.8, pad.z + perp.z, mats.navRed);
    }
    if (type === 'miner') {
      // refinery pipes and hoppers
      const dir = dock.outward;
      const base = pad.clone().addScaledVector(dir, 8);
      b.cyl(4.4, 9.5, base.x, base.y - 8, base.z, mats.cargoA, [0, 0, 0], 2.8, 10);
      b.cyl(2.0, 7.0, base.x + dir.z * 5, base.y - 4, base.z - dir.x * 5, mats.hullEdge, [0, 0, 0], 1.2, 8);
      b.box(0.4, 0.4, 8, base.x + dir.z * 2.8, base.y - 2.5, base.z - dir.x * 2.8, mats.amberDim, [0, -angle, 0]);
    }
  }

  // large solar arrays on outriggers
  for (const side of [-1, 1]) {
    const bx = side * 105;
    b.box(30, 0.8, 1.6, bx, 7.5, 0, mats.hullEdge);
    b.box(2.0, 1.0, 36, bx, 7.5, 0, mats.hullMid);
    b.box(0.8, 18, 0.8, side * 118, 16.0, 0, mats.hullEdge);
    for (let i = 0; i < 2; i++) {
      const panelX = side * (117 + i * 20);
      b.box(17, 0.35, 38, panelX, 15.0, -9.5, mats.solar, [0, 0, 0]);
      b.box(17, 0.35, 38, panelX, 15.0, 30.0, mats.solar, [0, 0, 0]);
      b.box(17.3, 0.45, 0.35, panelX, 15.1, -28.4, mats.solarLine);
      b.box(17.3, 0.45, 0.35, panelX, 15.1, 9.4, mats.solarLine);
      for (let g = 1; g < 5; g++) {
        b.box(0.12, 0.42, 38, panelX - 8.5 + g * 3.4, 15.15, 10.2, mats.solarLine);
      }
    }
  }

  // refinery / industrial module under the wheel
  const ind = new THREE.Group();
  b.cyl(8.0, 14, -48, -34, 52, mats.hullMid, [0, 0, 0], 6.8, 16);
  b.cyl(6.0, 25, -58, -30, 60, mats.hullDark, [0, 0, 0], 4.0, 12);
  b.cyl(4.4, 16, -38, -28, 63, mats.cargoA, [0, 0, 0], 3.2, 10);
  b.box(2.0, 2.0, 35, -48, -23, 55, mats.hullEdge, [0, 0.6, 0]);
  for (let i = 0; i < 6; i++) {
    b.box(5.3, 0.16, 0.35, -58, -20 + i * 2.7, 60, mats.winWarm);
  }
  b.torus(6.0, 0.4, -48, -48, 52, mats.amberDim, [Math.PI / 2, 0, 0], 5, 32);
  b.sphere(0.7, -58, -43, 60, mats.amber);

  // cargo yard and storage silos
  const cargoMats = [mats.cargoA, mats.cargoB, mats.cargoC, mats.hullMid];
  for (let i = 0; i < 22; i++) {
    const a = 0.5 + i * 0.92;
    const r = 54 + (i % 4) * 5.5;
    b.box(3.0, 2.2, 5.0, Math.cos(a) * r, -32 + (i % 3) * 3, Math.sin(a) * r, cargoMats[i % cargoMats.length], [0, -a + 0.2, 0]);
  }

  // comms dish and mast
  b.cyl(0.4, 12, 23, 25, -23, mats.hullEdge, [0, 0, 0], 0.4, 6);
  b.sphere(1.0, 23, 31.5, -23, mats.winWarm);
  b.cyl(1.6, 1.1, -22, 28, 18, mats.hullEdge, [0, 0, 0], 1.2, 8);
  const dish = new THREE.Group();
  const dishGeo = new THREE.SphereGeometry(4.8, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const dishMesh = new THREE.Mesh(dishGeo, mats.hullLight);
  dishMesh.rotation.x = Math.PI;
  dishMesh.rotation.z = 0.4;
  dish.position.set(-22, 29, 18);
  dish.add(dishMesh);
  anim.add(dish);
  dish.userData.spin = 0.07;

  const radar = new THREE.Group();
  const rGeo = new THREE.BoxGeometry(0.26, 0.26, 12);
  const rMesh = new THREE.Mesh(rGeo, mats.hullEdge);
  rMesh.position.z = 6;
  radar.add(rMesh);
  const rTip = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), mats.cyan);
  rTip.position.z = 12;
  radar.add(rTip);
  radar.position.set(0, 48, 0);
  anim.add(radar);
  radar.userData.spin = -0.26;

  // window field on the central drum
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    for (let row = 0; row < 3; row++) {
      b.box(1.0, 0.18, 0.22, Math.cos(a) * 15.7, -6 + row * 5.0, Math.sin(a) * 15.7, (i + row) % 5 === 0 ? mats.winCool : mats.winWarm, [0, -a, 0]);
    }
  }

  // navigation mast on top and underside
  b.cyl(0.26, 18, 0, 58, 0, mats.hullEdge, [0, 0, 0], 0.26, 6);
  b.torus(7.0, 0.35, 0, 62, 0, mats.amberDim, [Math.PI / 2, 0, 0], 5, 32);
  b.sphere(0.6, 0, 68, 0, mats.navRed);
  b.sphere(0.5, 0, -30, 0, mats.navWhite);

  const staticStation = b.build();
  group.add(staticStation);

  // beacon sprites around ring and docks
  const beacons = [];
  const beaconGroup = new THREE.Group();
  const beaconColors = [0x7edcff, 0xffc27e, 0xff5369];
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + 0.2;
    const r = i < 12 ? RING_RADIUS + 12 : 52;
    const material = new THREE.SpriteMaterial({
      map: getGlowTexture(),
      color: beaconColors[i % 3],
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    const s = new THREE.Sprite(material);
    s.position.set(Math.cos(a) * r, i < 12 ? 6 + (i % 4) * 5 : 18 + (i % 3) * 8, Math.sin(a) * r);
    s.scale.setScalar(i < 12 ? 2.0 : 1.3);
    s.userData.phase = i * 0.9;
    s.userData.baseScale = s.scale.x;
    beaconGroup.add(s);
    beacons.push(s);
  }

  // docking bay floodlights: pinpoints of warm light around pads
  for (const dock of DOCKS) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(),
      color: dock.type === 'miner' ? 0xffb45a : 0x9bdcff,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }));
    s.position.copy(dock.pad).add(new THREE.Vector3(0, 2.2, 0));
    s.scale.setScalar(dock.type === 'heavy' ? 18 : 12);
    beaconGroup.add(s);
    beacons.push(s);
    s.userData.phase = dock.angle * 2.0;
    s.userData.baseScale = s.scale.x;
  }
  group.add(beaconGroup);

  return {
    group,
    anim,
    beacons,
    dish,
    radar,
    docks: DOCKS,
  };
}

/* ------------------------------------------------------------------ */
/* jump gates                                                          */
/* ------------------------------------------------------------------ */

export const GATE_DEFS = [
  { id: 'EREBUS', label: 'Erebus Jump Gate', position: new THREE.Vector3(-438, 84, -438), radius: 41 },
  { id: 'TYCHO', label: 'Tycho Jump Gate', position: new THREE.Vector3(294, 118, -610), radius: 38 },
];

export function createJumpGate(def) {
  const group = new THREE.Group();
  group.position.copy(def.position);
  group.lookAt(0, 0, 0);

  const b = new GeoBuilder();
  const r = def.radius;
  b.torus(r, 2.6, 0, 0, 0, mats.hullDark, [0, 0, 0], 10, 64);
  b.torus(r - 4.0, 0.55, 0, 0, 0, mats.hullEdge, [0, 0, 0], 5, 64);
  b.torus(r + 5.5, 0.7, 0, 0, 0, mats.hullMid, [0, 0, 0], 5, 64);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    b.box(4.2, 5.6, 7.0, x, y, 0, i % 2 ? mats.hullMid : mats.hullDark, [0, 0, a]);
    b.box(1.5, 1.2, 8.4, x, y, 1.0, i % 2 ? mats.violet : mats.cyan, [0, 0, a]);
  }
  // structural pylons anchor the ring in space
  for (const side of [-1, 1]) {
    b.box(2.2, 26, 2.2, side * (r + 9), -18, 0, mats.hullDark, [0, 0, side * 0.22]);
    b.box(1.0, 1.6, 5.0, side * (r + 15), -28, 0, mats.hullMid);
    b.sphere(0.55, side * (r + 16.5), -31, 0, mats.navRed);
  }
  group.add(b.build());

  const portalMat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      uActive: { value: 0 },
      colorA: { value: new THREE.Color(0x6d8eff) },
      colorB: { value: new THREE.Color(0xb56cff) },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform float time;
      uniform float uActive;
      uniform vec3 colorA;
      uniform vec3 colorB;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float a = atan(p.y, p.x);
        float swirl = sin(a * 7.0 + r * 17.0 - time * 2.0) * 0.5 + 0.5;
        float swirl2 = sin(a * 13.0 - r * 29.0 + time * 3.0) * 0.5 + 0.5;
        float edge = smoothstep(1.0, 0.68, r);
        float core = smoothstep(0.55, 0.02, r);
        vec3 col = mix(colorA, colorB, swirl * 0.7 + swirl2 * 0.3);
        float alpha = edge * (0.07 + uActive * 0.28) + core * uActive * 0.55 * (0.6 + swirl * 0.4);
        gl_FragColor = vec4(col * (0.5 + uActive * 2.4), alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const portal = new THREE.Mesh(new THREE.CircleGeometry(r - 4, 64), portalMat);
  portal.position.z = -0.8;
  group.add(portal);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color: 0x7a8dff,
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  }));
  halo.scale.setScalar(r * 2.7);
  group.add(halo);

  group.userData = { def, portalMat, halo, portal };
  return group;
}

/* ------------------------------------------------------------------ */
/* asteroid field                                                      */
/* ------------------------------------------------------------------ */

export function createAsteroidField() {
  const group = new THREE.Group();
  group.position.set(268, -44, -176);
  const rng = mulberry32(93471);
  const count = 560;
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const positions = geo.attributes.position;
  const seen = new Map();
  const vec = new THREE.Vector3();
  for (let i = 0; i < positions.count; i++) {
    vec.fromBufferAttribute(positions, i).normalize();
    const key = `${vec.x.toFixed(4)},${vec.y.toFixed(4)},${vec.z.toFixed(4)}`;
    let d = seen.get(key);
    if (d === undefined) {
      d = 1 + noise3(vec.x * 2.1, vec.y * 2.1, vec.z * 2.1, 7) * 0.24 + noise3(vec.x * 6.1, vec.y * 6.1, vec.z * 6.1, 11) * 0.09;
      seen.set(key, d);
    }
    positions.setXYZ(i, vec.x * d, vec.y * d, vec.z * d);
  }
  geo.computeVertexNormals();

  const mesh = new THREE.InstancedMesh(geo, mats.rock, count);
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const asteroids = [];
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const angle = rng() * Math.PI * 2;
    const radius = Math.pow(rng(), 0.65) * 148;
    const y = (rng() - 0.5) * 94;
    const scale = i < 10 ? 8 + rng() * 13 : 0.7 + Math.pow(rng(), 2.5) * 6.8;
    const pos = new THREE.Vector3(
      Math.cos(angle) * radius + (rng() - 0.5) * 18,
      y,
      Math.sin(angle) * radius * 0.74 + (rng() - 0.5) * 15
    );
    dummy.position.copy(pos);
    dummy.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
    dummy.scale.set(scale * (0.75 + rng() * 0.5), scale * (0.65 + rng() * 0.55), scale * (0.75 + rng() * 0.5));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    asteroids.push({ pos, scale, index: i });
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);

  // fine dust and mineral glints around the field
  const dustGeo = new THREE.BufferGeometry();
  const dustCount = 220;
  const dp = new Float32Array(dustCount * 3);
  const dc = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.pow(rng(), 0.6) * 165;
    dp[i * 3] = Math.cos(a) * r;
    dp[i * 3 + 1] = (rng() - 0.5) * 110;
    dp[i * 3 + 2] = Math.sin(a) * r * 0.8;
    const warm = rng() > 0.4;
    dc[i * 3] = warm ? 0.85 : 0.35;
    dc[i * 3 + 1] = warm ? 0.55 : 0.55;
    dc[i * 3 + 2] = warm ? 0.25 : 0.75;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dp, 3));
  dustGeo.setAttribute('color', new THREE.BufferAttribute(dc, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    size: 1.2,
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  }));
  group.add(dust);

  return {
    group,
    mesh,
    asteroids,
    center: group.position.clone(),
    update(time, dt) {
      group.rotation.y += dt * 0.0009;
    },
  };
}

/* ------------------------------------------------------------------ */
/* navigation beacons & lane markers                                   */
/* ------------------------------------------------------------------ */

export function createNavigationBeacons() {
  const group = new THREE.Group();
  const rng = mulberry32(1171);
  const beacons = [];
  const b = new GeoBuilder();
  for (let i = 0; i < 14; i++) {
    const a = rng() * Math.PI * 2;
    const r = 170 + rng() * 150;
    const y = (rng() - 0.5) * 85;
    const pos = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
    b.box(0.8, 2.8, 0.8, pos.x, pos.y, pos.z, mats.hullMid);
    b.box(2.4, 0.18, 0.18, pos.x, pos.y + 1.5, pos.z, mats.hullEdge);
    const material = new THREE.SpriteMaterial({
      map: getGlowTexture(),
      color: i % 3 === 0 ? 0xffb260 : 0x7edcff,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const s = new THREE.Sprite(material);
    s.position.copy(pos).add(new THREE.Vector3(0, 1.55, 0));
    s.scale.setScalar(2.6);
    s.userData.phase = i * 1.3;
    group.add(s);
    beacons.push(s);
  }
  group.add(b.build());
  return { group, beacons };
}
