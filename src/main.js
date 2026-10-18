import './style.css';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import { mulberry32, clamp, damp, formatClock } from './utils.js';
import { createPlanetSystem } from './planet.js';
import {
  createStation,
  createJumpGate,
  createAsteroidField,
  createNavigationBeacons,
  GATE_DEFS,
  DOCKS,
} from './models.js';
import { ParticleField, JumpFX, RouteOverlay } from './effects.js';
import { TrafficSimulation } from './simulation.js';

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

const canvas = document.getElementById('scene');
const loading = document.getElementById('loading');
const loadingBar = document.getElementById('loadingBar');
const loadingPhase = document.getElementById('loadingPhase');

const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const isLowPower = isMobile || (navigator.deviceMemory && navigator.deviceMemory <= 4);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  powerPreference: 'high-performance',
  stencil: false,
});
let pixelRatio = Math.min(window.devicePixelRatio || 1, isMobile ? 1.25 : 1.6);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
renderer.setClearColor(0x02040a, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.5, 7000);
camera.position.set(290, 180, 430);

const clock = new THREE.Clock();
let simTime = 0;
let simSpeed = 1;
let paused = false;
let cinemaActive = false;
let effectsEnabled = true;
let trafficLevel = 'med';
let routesVisible = false;
let currentView = 'overview';
let selectedShip = null;
let hoveredShip = null;
let followLostTimer = 0;
let lastInfoUpdate = 0;
let lastOpsUpdate = 0;
let lastHoverCheck = 0;
let toastTimer = 0;
let frames = 0;
let fpsTimer = 0;
let smoothedFps = 60;
let qualityTimer = 0;
let qualityLevel = 0;
let qualityScale = 1;
let realTime = 0;
let pointerDown = false;
let dragDistance = 0;
let lastPointer = { x: 0, y: 0 };
let lastCapitalState = 'hidden';

/* ------------------------------------------------------------------ */
/* scene lighting & environment                                        */
/* ------------------------------------------------------------------ */

const sunDir = new THREE.Vector3(0.82, 0.35, 0.25).normalize();

scene.add(new THREE.AmbientLight(0x304760, 0.85));
const hemisphere = new THREE.HemisphereLight(0x5f86b5, 0x11151c, 0.72);
scene.add(hemisphere);

const sun = new THREE.DirectionalLight(0xfff1df, 4.4);
sun.position.copy(sunDir).multiplyScalar(1600);
scene.add(sun);

const rim = new THREE.DirectionalLight(0x5f86c9, 1.25);
rim.position.set(-900, -300, -600);
scene.add(rim);

const warmStationLight = new THREE.PointLight(0xffa85c, 2600, 330, 2);
warmStationLight.position.set(0, 2, 0);
scene.add(warmStationLight);
const coolStationLight = new THREE.PointLight(0x74c5ff, 1700, 250, 2);
coolStationLight.position.set(0, 35, 0);
scene.add(coolStationLight);

const envTexture = makeEnvironmentTexture();
const pmrem = new THREE.PMREMGenerator(renderer);
const envMap = pmrem.fromEquirectangular(envTexture).texture;
scene.environment = envMap;
if ('environmentIntensity' in scene) scene.environmentIntensity = 0.85;

/* ------------------------------------------------------------------ */
/* background                                                          */
/* ------------------------------------------------------------------ */

const nebulaTexture = makeNebulaTexture();
const backgroundSphere = new THREE.Mesh(
  new THREE.SphereGeometry(3450, 48, 32),
  new THREE.MeshBasicMaterial({
    map: nebulaTexture,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    color: 0xffffff,
  })
);
backgroundSphere.renderOrder = -100;
scene.add(backgroundSphere);

const starField = makeStarField();
scene.add(starField);

let _starSpriteTex;
const brightStars = makeBrightStars();
scene.add(brightStars);

/* ------------------------------------------------------------------ */
/* world assembly                                                      */
/* ------------------------------------------------------------------ */

let planetSystem;
let station;
let asteroidField;
let navigationBeacons;
let gates = [];
let particleField;
let jumpFX;
let simulation;
let routeOverlay;

async function buildWorld() {
  setLoading(8, 'Charting local starfield');
  await paint();

  setLoading(20, 'Generating planetary survey');
  await paint();
  planetSystem = createPlanetSystem({ planetSunDir: sunDir });
  scene.add(planetSystem.group);

  setLoading(44, 'Fabricating Helios orbital ring');
  await paint();
  station = await createStation();
  scene.add(station.group);

  setLoading(60, 'Spinning jump gate aperture');
  await paint();
  for (const def of GATE_DEFS) {
    const group = createJumpGate(def);
    scene.add(group);
    gates.push({ def, group });
  }

  setLoading(69, 'Seeding asteroid field K-12');
  await paint();
  asteroidField = createAsteroidField();
  scene.add(asteroidField.group);

  navigationBeacons = createNavigationBeacons();
  scene.add(navigationBeacons.group);

  setLoading(78, 'Spooling engine cores');
  await paint();
  particleField = new ParticleField(isLowPower ? 1500 : 2600);
  particleField.material.uniforms.uPixelRatio.value = pixelRatio;
  scene.add(particleField.points);
  jumpFX = new JumpFX(scene);

  setLoading(88, 'Synchronizing orbital traffic network');
  await paint();
  simulation = new TrafficSimulation({
    scene,
    station,
    asteroidField,
    gates,
    particleField,
    jumpFX,
    effectsEnabled: true,
  });
  simTime = simulation.time;

  routeOverlay = new RouteOverlay(simulation.ships, DOCKS, GATE_DEFS);
  scene.add(routeOverlay.group);

  setLoading(100, 'Helios Station online');
  await paint();

  setupPost();
  setupCameraRig();
  setupInteractions();
  setupUI();
  resize();
  setLoadingDone();
}

/* ------------------------------------------------------------------ */
/* procedural sky                                                      */
/* ------------------------------------------------------------------ */

function makeEnvironmentTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#060b16');
  g.addColorStop(0.42, '#0a1220');
  g.addColorStop(0.65, '#03070d');
  g.addColorStop(1, '#010204');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 512);

  const rng = mulberry32(4815);
  for (let i = 0; i < 10; i++) {
    const x = rng() * 1024;
    const y = 80 + rng() * 300;
    const r = 60 + rng() * 170;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    const hue = i % 3 === 0 ? '255,180,105' : i % 3 === 1 ? '92,160,255' : '130,100,255';
    grad.addColorStop(0, `rgba(${hue},.16)`);
    grad.addColorStop(1, `rgba(${hue},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeNebulaTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  const rng = mulberry32(31287);

  const base = ctx.createLinearGradient(0, 0, 0, 1024);
  base.addColorStop(0, '#010206');
  base.addColorStop(0.32, '#030712');
  base.addColorStop(0.58, '#02050c');
  base.addColorStop(0.78, '#04060e');
  base.addColorStop(1, '#010205');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 2048, 1024);

  // faint galactic band
  ctx.save();
  ctx.translate(1024, 540);
  ctx.rotate(-0.24);
  const band = ctx.createLinearGradient(0, -190, 0, 190);
  band.addColorStop(0, 'rgba(44,70,120,0)');
  band.addColorStop(0.35, 'rgba(66,98,158,.09)');
  band.addColorStop(0.5, 'rgba(103,123,178,.12)');
  band.addColorStop(0.68, 'rgba(79,89,145,.07)');
  band.addColorStop(1, 'rgba(30,40,80,0)');
  ctx.fillStyle = band;
  ctx.fillRect(-1500, -190, 3000, 380);
  ctx.restore();

  ctx.filter = 'blur(32px)';
  const colors = [
    [62, 106, 190],
    [97, 76, 168],
    [43, 132, 164],
    [178, 126, 89],
    [45, 74, 140],
  ];
  for (let i = 0; i < 36; i++) {
    const x = rng() * 2048;
    const y = 70 + rng() * 860;
    const r = 130 + rng() * 460;
    const c = colors[(rng() * colors.length) | 0];
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    const alpha = 0.035 + rng() * 0.075;
    grad.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${alpha})`);
    grad.addColorStop(0.45, `rgba(${c[0]},${c[1]},${c[2]},${alpha * 0.55})`);
    grad.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.filter = 'none';

  // a few sharper wisps give the cloud some structure
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 15; i++) {
    const x = rng() * 2048;
    const y = rng() * 1024;
    const rx = 80 + rng() * 260;
    const ry = 14 + rng() * 45;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rng() * Math.PI);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0, `rgba(${i % 2 ? '94,139,211' : '91,98,193'},.035)`);
    grad.addColorStop(1, 'rgba(70,90,150,0)');
    ctx.scale(1, ry / rx);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

function makeStarField() {
  const count = isLowPower ? 5200 : 9000;
  const rng = mulberry32(1229);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const col = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = rng();
    const v = rng();
    const theta = u * Math.PI * 2;
    const phi = Math.acos(2 * v - 1);
    const r = 3000;
    positions[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
    positions[i * 3 + 1] = Math.cos(phi) * r;
    positions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
    const roll = rng();
    if (roll > 0.92) col.setHSL(0.09, 0.55, 0.85);
    else if (roll > 0.75) col.setHSL(0.58, 0.45, 0.78);
    else col.setHSL(0.6, 0.12, 0.9 + rng() * 0.1);
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
    sizes[i] = 0.55 + Math.pow(rng(), 4) * 3.6;
    phases[i] = rng() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
    },
    vertexShader: /* glsl */`
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aPhase;
      uniform float uTime;
      uniform float uPixelRatio;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = aColor;
        float tw = 0.73 + 0.27 * sin(uTime * 1.4 + aPhase * 13.0);
        vAlpha = 0.38 + 0.62 * tw;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(1.0, aSize * uPixelRatio * (0.8 + tw * 0.5));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p);
        float a = smoothstep(0.5, 0.06, d);
        a += smoothstep(0.5, 0.18, d) * 0.22;
        gl_FragColor = vec4(vColor * 1.25, a * vAlpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.userData.material = mat;
  return points;
}

function makeBrightStars() {
  const group = new THREE.Group();
  const rng = mulberry32(7719);
  const colors = [0xbfe5ff, 0xffe3bd, 0xacc7ff, 0xffffff];
  for (let i = 0; i < 36; i++) {
    const u = rng();
    const v = rng();
    const theta = u * Math.PI * 2;
    const phi = Math.acos(2 * v - 1);
    const r = 2600;
    const mat = new THREE.SpriteMaterial({
      map: starSpriteTexture(),
      color: new THREE.Color(colors[i % colors.length]).multiplyScalar(1.6),
      transparent: true,
      opacity: 0.42 + rng() * 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    const s = new THREE.Sprite(mat);
    s.position.set(
      Math.sin(phi) * Math.cos(theta) * r,
      Math.cos(phi) * r,
      Math.sin(phi) * Math.sin(theta) * r
    );
    s.scale.setScalar(7 + rng() * 15);
    group.add(s);
  }
  return group;
}

function starSpriteTexture() {
  if (_starSpriteTex) return _starSpriteTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.03, 'rgba(255,255,255,.95)');
  g.addColorStop(0.12, 'rgba(255,255,255,.4)');
  g.addColorStop(0.32, 'rgba(255,255,255,.07)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  _starSpriteTex = new THREE.CanvasTexture(c);
  _starSpriteTex.colorSpace = THREE.SRGBColorSpace;
  return _starSpriteTex;
}

/* ------------------------------------------------------------------ */
/* post processing                                                     */
/* ------------------------------------------------------------------ */

let composer;
let bloomPass;
let finalPass;

function setupPost() {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: isLowPower ? 0 : 4,
    colorSpace: THREE.LinearSRGBColorSpace,
  });
  composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.62, 0.55, 0.82);
  bloomPass.threshold = 0.83;
  bloomPass.strength = isLowPower ? 0.48 : 0.6;
  bloomPass.radius = 0.56;
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  finalPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform vec2 uResolution;
      varying vec2 vUv;
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      void main() {
        vec2 uv = vUv;
        vec2 center = uv - 0.5;
        float r2 = dot(center, center);
        vec2 offset = center * r2 * 0.0016;
        vec3 col;
        col.r = texture2D(tDiffuse, uv + offset).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - offset).b;
        float vig = 1.0 - smoothstep(0.18, 0.82, length(center) * 1.22) * 0.46;
        col *= vig;
        float grain = (hash(uv * uResolution + fract(uTime) * 93.1) - 0.5) * 0.022;
        col += grain;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  composer.addPass(finalPass);
}

/* ------------------------------------------------------------------ */
/* camera rig                                                          */
/* ------------------------------------------------------------------ */

const VIEW_PRESETS = {
  overview: {
    focus: new THREE.Vector3(68, 4, -24),
    theta: 0.51,
    phi: 1.23,
    radius: 478,
  },
  station: {
    focus: new THREE.Vector3(2, 6, 0),
    theta: 0.92,
    phi: 1.33,
    radius: 215,
  },
};

class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'overview';
    this.ship = null;
    this.focus = VIEW_PRESETS.overview.focus.clone();
    this.desiredFocus = this.focus.clone();
    this.theta = VIEW_PRESETS.overview.theta;
    this.phi = VIEW_PRESETS.overview.phi;
    this.radius = VIEW_PRESETS.overview.radius;
    this.desiredTheta = this.theta;
    this.desiredPhi = this.phi;
    this.desiredRadius = this.radius;
    this.localTheta = 0.46;
    this.localPhi = 1.26;
    this.followRadius = 50;
    this.lookOffset = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, 1);
    this.lastAspectScale = this.getAspectScale();
    this.snapToPreset('overview');
  }

  getAspectScale() {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    return clamp(1.74 / aspect, 1, 1.6);
  }

  onResize() {
    const scale = this.getAspectScale();
    const ratio = scale / this.lastAspectScale;
    this.lastAspectScale = scale;
    this.desiredRadius *= ratio;
    this.followRadius *= ratio;
  }

  snapToPreset(name) {
    const p = VIEW_PRESETS[name];
    this.focus.copy(p.focus);
    this.desiredFocus.copy(p.focus);
    const aspectScale = this.getAspectScale();
    this.lastAspectScale = aspectScale;
    this.theta = p.theta;
    this.phi = p.phi;
    this.radius = p.radius * aspectScale;
    this.desiredTheta = p.theta;
    this.desiredPhi = p.phi;
    this.desiredRadius = p.radius * aspectScale;
    this.mode = name;
    this.ship = null;
    this.applyCamera();
  }

  setOverview(instant = false) {
    this.mode = 'overview';
    this.ship = null;
    const p = VIEW_PRESETS.overview;
    this.desiredFocus.copy(p.focus);
    this.desiredTheta = p.theta;
    this.desiredPhi = p.phi;
    this.desiredRadius = p.radius * this.getAspectScale();
    if (instant) this.snapToPreset('overview');
  }

  setStation() {
    this.mode = 'station';
    this.ship = null;
    const p = VIEW_PRESETS.station;
    this.desiredFocus.copy(p.focus);
    this.desiredTheta = p.theta;
    this.desiredPhi = p.phi;
    this.desiredRadius = p.radius * this.getAspectScale();
  }

  setFollow(ship) {
    if (!ship) return;
    this.mode = 'follow';
    this.ship = ship;
    this.localTheta = 0.48;
    this.localPhi = 1.25;
    this.followRadius = clamp(ship.spec.length * 1.9 + ship.spec.radius * 1.0, 22, 235) * this.getAspectScale();
  }

  releaseFollow() {
    this.setOverview();
  }

  drag(dx, dy) {
    if (this.mode === 'follow') {
      this.localTheta -= dx * 0.0062;
      this.localPhi = clamp(this.localPhi - dy * 0.0048, 0.28, Math.PI - 0.22);
    } else {
      this.desiredTheta -= dx * 0.0053;
      this.desiredPhi = clamp(this.desiredPhi - dy * 0.0042, 0.16, Math.PI - 0.14);
    }
  }

  zoom(delta) {
    if (this.mode === 'follow') {
      this.followRadius = clamp(this.followRadius * (1 + delta * 0.00115), 9, 620);
    } else {
      this.desiredRadius = clamp(this.desiredRadius * (1 + delta * 0.00125), 95, 1900);
    }
  }

  update(dt) {
    if (this.mode === 'follow' && this.ship) {
      const ship = this.ship;
      this.forward.set(0, 0, 1).applyQuaternion(ship.orientation);
      this.desiredFocus.copy(ship.group.position).addScaledVector(this.forward, ship.spec.length * 0.06);
      this.desiredFocus.y += ship.spec.length * 0.015;
      const stationAwareStates = new Set([
        'holding', 'approach', 'unloading', 'undock', 'courierHold', 'courierApproach',
        'courierDocked', 'mineApproach', 'mineDocked', 'orbit', 'service', 'hold',
      ]);
      const pos = ship.group.position;
      const stationDist = Math.hypot(pos.x, pos.y, pos.z);
      const stationAware = stationAwareStates.has(ship.mission.state) && stationDist < 320;
      let baseYaw;
      if (stationAware) {
        // Look from outside the station toward the berth, so the wheel and
        // planet remain in frame behind a docked or queued ship.
        baseYaw = Math.atan2(pos.x, pos.z);
      } else {
        baseYaw = Math.atan2(this.forward.x, this.forward.z) + Math.PI;
      }
      this.desiredTheta = baseYaw + this.localTheta;
      this.desiredPhi = this.localPhi;
      this.desiredRadius = this.followRadius;
    }
    this.focus.x = damp(this.focus.x, this.desiredFocus.x, 4.2, dt);
    this.focus.y = damp(this.focus.y, this.desiredFocus.y, 4.2, dt);
    this.focus.z = damp(this.focus.z, this.desiredFocus.z, 4.2, dt);
    // wrap the angle cleanly when crossing the seam
    let delta = this.desiredTheta - this.theta;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.theta += delta * (1 - Math.exp(-2.5 * dt));
    this.phi = damp(this.phi, this.desiredPhi, 2.6, dt);
    this.radius = damp(this.radius, this.desiredRadius, 2.2, dt);
    this.applyCamera();
  }

  applyCamera() {
    const r = this.radius;
    const sinPhi = Math.sin(this.phi);
    const x = this.focus.x + Math.sin(this.theta) * sinPhi * r;
    const y = this.focus.y + Math.cos(this.phi) * r;
    const z = this.focus.z + Math.cos(this.theta) * sinPhi * r;
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.focus);
  }
}

let cameraRig;

function setupCameraRig() {
  cameraRig = new CameraRig(camera);
  cameraRig.snapToPreset('overview');
}

/* ------------------------------------------------------------------ */
/* cinematic director                                                  */
/* ------------------------------------------------------------------ */

class CinemaDirector {
  constructor(simulation, camera, rig) {
    this.simulation = simulation;
    this.camera = camera;
    this.rig = rig;
    this.active = false;
    this.shotIndex = 0;
    this.elapsed = 0;
    this.camPos = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();
    this.shots = this.buildShots();
  }

  pickShip(type, predicate = null) {
    const candidates = this.simulation.ships.filter((s) => s.type === type && s.visible && s.densityVisible && !s.hidden && (!predicate || predicate(s)));
    if (!candidates.length) return null;
    let best = candidates[0];
    for (const c of candidates) if (c.spec.length > best.spec.length) best = c;
    return best;
  }

  minerInAction() {
    return this.pickShip('miner', (s) => s.mission.state === 'mining' || s.mission.state === 'collecting');
  }

  buildShots() {
    const sim = this.simulation;
    return [
      {
        label: 'Helios approach',
        duration: 19,
        view: (e) => {
          const p = e / 19;
          const focus = new THREE.Vector3(52, 4, -24);
          const theta = 0.5 + p * 0.035;
          const phi = 1.22 + Math.sin(p * Math.PI) * 0.018;
          const radius = 478 - p * 34;
          const pos = new THREE.Vector3(
            focus.x + Math.sin(theta) * Math.sin(phi) * radius,
            focus.y + Math.cos(phi) * radius,
            focus.z + Math.cos(theta) * Math.sin(phi) * radius
          );
          return { pos, target: focus.clone().add(new THREE.Vector3(0, 6, 0)) };
        },
      },
      {
        label: 'Ring operations',
        duration: 17,
        view: (e) => {
          const p = e / 17;
          const theta = 0.94 + p * 0.12;
          const phi = 1.32;
          const radius = 202 - p * 22;
          const pos = new THREE.Vector3(
            Math.sin(theta) * Math.sin(phi) * radius,
            6 + Math.cos(phi) * radius,
            Math.cos(theta) * Math.sin(phi) * radius
          );
          return { pos, target: new THREE.Vector3(0, 5, 0) };
        },
      },
      {
        label: 'Freighter close pass',
        duration: 17,
        view: (e) => {
          const ship = this.pickShip('freight', (s) => !s.mission.state.includes('Docked')) || this.pickShip('freight');
          if (!ship) return this.wideFallback(e, 17);
          const p = e / 17;
          const local = new THREE.Vector3(46 + p * 9, 17, 62 - p * 12);
          const pos = ship.group.localToWorld(local);
          const target = ship.group.position.clone().add(new THREE.Vector3(0, 0, ship.spec.length * 0.05));
          return { pos, target };
        },
      },
      {
        label: 'Asteroid operations',
        duration: 18,
        view: (e) => {
          const miner = this.minerInAction() || this.pickShip('miner');
          if (!miner) {
            const center = asteroidField.group.position;
            return { pos: center.clone().add(new THREE.Vector3(180, 70, 200)), target: center };
          }
          const p = e / 18;
          const rock = miner.miner.rockWorld || miner.group.position;
          const fromStation = rock.clone().normalize();
          const side = new THREE.Vector3(-fromStation.z, 0, fromStation.x).normalize();
          const pos = rock.clone().addScaledVector(fromStation, 46 + p * 5).addScaledVector(side, 35).add(new THREE.Vector3(0, 18, 0));
          const target = rock.clone().lerp(miner.group.position, 0.5);
          return { pos, target };
        },
      },
      {
        label: 'Outer traffic weave',
        duration: 15,
        view: (e) => {
          const p = e / 15;
          const theta = 1.55 + p * 0.08;
          const phi = 1.42;
          const radius = 265 - p * 24;
          const pos = new THREE.Vector3(
            Math.sin(theta) * Math.sin(phi) * radius,
            28 + Math.cos(phi) * radius,
            Math.cos(theta) * Math.sin(phi) * radius
          );
          return { pos, target: new THREE.Vector3(0, 18, 0) };
        },
      },
      {
        label: 'Sovereign anchorage',
        duration: 20,
        view: (e) => {
          const cap = sim.capital;
          if (cap && cap.visible && !cap.hidden) {
            const p = e / 20;
            const local = new THREE.Vector3(145 + p * 18, 52, 165);
            const pos = cap.group.localToWorld(local);
            return { pos, target: cap.group.position.clone().add(new THREE.Vector3(0, 4, 0)) };
          }
          return null;
        },
      },
      {
        label: 'Night side',
        duration: 19,
        view: (e) => {
          const p = e / 19;
          const theta = -0.2 + p * 0.06;
          const phi = 1.54;
          const radius = 460;
          const focus = new THREE.Vector3(4, 26, -80);
          const pos = new THREE.Vector3(
            focus.x + Math.sin(theta) * Math.sin(phi) * radius,
            focus.y + Math.cos(phi) * radius,
            focus.z + Math.cos(theta) * Math.sin(phi) * radius
          );
          return { pos, target: focus.clone().add(new THREE.Vector3(0, 20, -140)) };
        },
      },
    ];
  }

  wideFallback(e, duration) {
    const p = e / duration;
    const focus = new THREE.Vector3(52, 4, -24);
    const theta = 0.52;
    const phi = 1.22;
    const radius = 478 - p * 24;
    return {
      pos: new THREE.Vector3(
        focus.x + Math.sin(theta) * Math.sin(phi) * radius,
        focus.y + Math.cos(phi) * radius,
        focus.z + Math.cos(theta) * Math.sin(phi) * radius
      ),
      target: focus,
    };
  }

  enter() {
    this.active = true;
    this.previousView = currentView;
    this.shotIndex = 0;
    this.elapsed = 0;
    this.camPos.copy(this.camera.position);
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.target.copy(this.camera.position).addScaledVector(dir, 300);
    cinemaActive = true;
    this.routesWereVisible = routesVisible;
    if (routesVisible) {
      routesVisible = false;
      routeOverlay.setVisible(false);
      document.getElementById('routesBtn').classList.remove('active');
      document.getElementById('routeLegend').classList.remove('visible');
    }
    hideHover();
    document.body.classList.add('cinematic');
    document.getElementById('cinemaBar').style.display = 'flex';
    document.getElementById('cinemaBar').classList.add('show');
    document.getElementById('cinemaShot').textContent = this.shots[0].label;
    updateViewButtons('cinematic');
  }

  exit() {
    this.active = false;
    cinemaActive = false;
    document.body.classList.remove('cinematic');
    document.getElementById('cinemaBar').classList.remove('show');
    document.getElementById('cinemaBar').style.display = 'none';
    if (this.routesWereVisible) {
      routesVisible = true;
      routeOverlay.setVisible(true);
      document.getElementById('routesBtn').classList.add('active');
      document.getElementById('routeLegend').classList.add('visible');
    }
    currentView = this.previousView === 'station' ? 'station' : 'overview';
    if (currentView === 'station') cameraRig.setStation();
    else cameraRig.setOverview();
    updateViewButtons(currentView);
  }

  update(dt) {
    if (!this.active) return;
    const shot = this.shots[this.shotIndex];
    this.elapsed += dt;
    if (this.elapsed >= shot.duration) {
      this.shotIndex = (this.shotIndex + 1) % this.shots.length;
      this.elapsed = 0;
      document.getElementById('cinemaShot').textContent = this.shots[this.shotIndex].label;
    }
    const activeShot = this.shots[this.shotIndex];
    let view = activeShot.view(this.elapsed);
    if (!view) {
      // skip shots that need the absent capital, with a graceful wide composition
      view = this.wideFallback(this.elapsed, activeShot.duration);
    }
    this.camPos.x = damp(this.camPos.x, view.pos.x, 0.62, dt);
    this.camPos.y = damp(this.camPos.y, view.pos.y, 0.62, dt);
    this.camPos.z = damp(this.camPos.z, view.pos.z, 0.62, dt);
    this.target.x = damp(this.target.x, view.target.x, 0.95, dt);
    this.target.y = damp(this.target.y, view.target.y, 0.95, dt);
    this.target.z = damp(this.target.z, view.target.z, 0.95, dt);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.target);
  }
}

let cinemaDirector;

/* ------------------------------------------------------------------ */
/* interactions                                                        */
/* ------------------------------------------------------------------ */

function setupInteractions() {
  cinemaDirector = new CinemaDirector(simulation, camera, cameraRig);
  const el = canvas;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pointerDown = true;
    dragDistance = 0;
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    hideHover();
  });

  el.addEventListener('pointermove', (e) => {
    if (pointerDown) {
      const dx = e.clientX - lastPointer.x;
      const dy = e.clientY - lastPointer.y;
      dragDistance += Math.abs(dx) + Math.abs(dy);
      lastPointer.x = e.clientX;
      lastPointer.y = e.clientY;
      if (!cinemaActive && dragDistance > 3) cameraRig.drag(dx, dy);
      return;
    }
    if (cinemaActive) return;
    const now = performance.now();
    if (now - lastHoverCheck < 45) {
      positionHover(e.clientX, e.clientY);
      return;
    }
    lastHoverCheck = now;
    const ship = pickShipAt(e.clientX, e.clientY);
    hoveredShip = ship;
    if (ship) {
      el.classList.add('hovering');
      const hover = document.getElementById('hoverLabel');
      document.getElementById('hoverName').textContent = ship.name;
      document.getElementById('hoverClass').textContent = `${ship.spec.label} · ${ship.registry}`;
      hover.classList.add('show');
      positionHover(e.clientX, e.clientY);
    } else {
      hideHover();
      el.classList.remove('hovering');
    }
  });

  el.addEventListener('pointerup', (e) => {
    if (!pointerDown) return;
    pointerDown = false;
    el.classList.remove('dragging');
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    if (dragDistance <= 4) {
      if (cinemaActive) return;
      const ship = pickShipAt(e.clientX, e.clientY);
      if (ship) {
        selectShip(ship);
      }
    }
  });

  el.addEventListener('pointerleave', () => {
    if (!pointerDown) hideHover();
  });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (cinemaActive) return;
    cameraRig.zoom(e.deltaY);
  }, { passive: false });
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      togglePause();
    } else if (e.key === 'c' || e.key === 'C') {
      toggleCinema();
    } else if (e.key === 'r' || e.key === 'R') {
      toggleRoutes();
    } else if (e.key === 'Escape') {
      if (cinemaActive) toggleCinema();
      else if (selectedShip) releaseSelection();
    } else if (e.key === 'v' || e.key === 'V') {
      setView('overview');
    } else if (e.key === 'b' || e.key === 'B') {
      setView('station');
    } else if (e.key === '1' || e.key === '2' || e.key === '4') {
      setSpeed(Number(e.key));
    }
  });

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) clock.getDelta();
  });
}

function positionHover(x, y) {
  const el = document.getElementById('hoverLabel');
  el.style.transform = `translate(${x + 14}px, ${y + 16}px)`;
}

function hideHover() {
  document.getElementById('hoverLabel').classList.remove('show');
}

function pickShipAt(clientX, clientY) {
  const ndc = new THREE.Vector2(
    (clientX / window.innerWidth) * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1
  );
  return simulation.pick(ndc, camera);
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

const ui = {};

function setupUI() {
  ui.pause = document.getElementById('pauseBtn');
  ui.speedButtons = [...document.querySelectorAll('#speedGroup button')];
  ui.densityBtn = document.getElementById('densityBtn');
  ui.densityLabel = document.getElementById('densityLabel');
  ui.routesBtn = document.getElementById('routesBtn');
  ui.cinemaBtn = document.getElementById('cinemaBtn');
  ui.viewSwitcher = document.getElementById('viewSwitcher');
  ui.panel = document.getElementById('vesselPanel');
  ui.ops = document.getElementById('opsPanel');
  ui.routeLegend = document.getElementById('routeLegend');
  ui.toast = document.getElementById('toast');
  ui.viewButtons = [...ui.viewSwitcher.querySelectorAll('button')];
  ui.trafficBars = document.getElementById('trafficBars');

  for (let i = 0; i < 12; i++) {
    const bar = document.createElement('i');
    bar.style.height = `${3 + (i % 5)}px`;
    ui.trafficBars.appendChild(bar);
  }

  ui.pause.addEventListener('click', togglePause);
  for (const btn of ui.speedButtons) {
    btn.addEventListener('click', () => setSpeed(Number(btn.dataset.speed)));
  }
  ui.densityBtn.addEventListener('click', cycleDensity);
  ui.routesBtn.addEventListener('click', toggleRoutes);
  ui.cinemaBtn.addEventListener('click', toggleCinema);
  document.getElementById('exitCinema').addEventListener('click', toggleCinema);
  document.getElementById('closeVessel').addEventListener('click', releaseSelection);
  document.getElementById('releaseFollow').addEventListener('click', releaseSelection);
  for (const btn of ui.viewButtons) {
    btn.addEventListener('click', () => {
      if (btn.dataset.view === 'follow' && selectedShip) setView('follow');
      else if (btn.dataset.view !== 'follow') setView(btn.dataset.view);
    });
  }
  ui.panel.style.display = 'none';
  document.getElementById('cinemaBar').style.display = 'none';
  document.getElementById('hud').addEventListener('pointermove', (e) => {
    if (e.target.closest('.panel, .toolbar, .view-switcher, .cinema-bar')) {
      hideHover();
      canvas.classList.remove('hovering');
    }
  });
  updateViewButtons('overview');
  updateStageStats();
}

function togglePause() {
  paused = !paused;
  ui.pause.classList.toggle('paused', paused);
  ui.pause.setAttribute('aria-label', paused ? 'Resume simulation' : 'Pause simulation');
  showToast(paused ? 'Simulation paused' : 'Simulation resumed');
}

function setSpeed(speed) {
  simSpeed = speed;
  for (const btn of ui.speedButtons) btn.classList.toggle('active', Number(btn.dataset.speed) === speed);
  showToast(`Simulation speed ${speed}×`);
}

function cycleDensity() {
  const order = ['low', 'med', 'high'];
  trafficLevel = order[(order.indexOf(trafficLevel) + 1) % 3];
  simulation.setDensity(trafficLevel);
  ui.densityLabel.textContent = trafficLevel === 'low' ? 'Low' : trafficLevel === 'high' ? 'High' : 'Med';
  showToast(`Traffic density ${trafficLevel.toUpperCase()} · ${simulation.activeShipCount} vessels active`);
  updateStageStats();
}

function toggleRoutes() {
  if (cinemaActive) return;
  routesVisible = !routesVisible;
  routeOverlay.setVisible(routesVisible);
  ui.routesBtn.classList.toggle('active', routesVisible);
  ui.routeLegend.classList.toggle('visible', routesVisible);
  if (routesVisible) routeOverlay.update(simTime);
  showToast(routesVisible ? 'Route overlay engaged' : 'Route overlay disengaged');
}

function toggleCinema() {
  if (!cinemaActive) {
    if (selectedShip) releaseSelection();
    cinemaDirector.enter();
    showToast('Cinematic mode · C to exit');
  } else {
    cinemaDirector.exit();
  }
}

function setView(view) {
  if (cinemaActive) cinemaDirector.exit();
  if (view === 'follow') {
    if (!selectedShip) {
      showToast('Select a vessel to track');
      return;
    }
    cameraRig.setFollow(selectedShip);
    currentView = 'follow';
  } else if (view === 'station') {
    cameraRig.setStation();
    currentView = 'station';
  } else {
    cameraRig.setOverview();
    currentView = 'overview';
  }
  updateViewButtons(currentView);
  if (selectedShip) updateVesselPanel();
}

function updateViewButtons(view) {
  if (!ui.viewButtons) return;
  for (const btn of ui.viewButtons) {
    btn.classList.toggle('active', btn.dataset.view === view);
    if (btn.dataset.view === 'follow') btn.disabled = !selectedShip || cinemaActive;
  }
}

function selectShip(ship) {
  selectedShip = ship;
  simulation.select(ship);
  currentView = 'follow';
  cameraRig.setFollow(ship);
  ui.panel.style.display = '';
  ui.panel.classList.remove('closing');
  ui.panel.style.animation = 'none';
  void ui.panel.offsetHeight;
  ui.panel.style.animation = '';
  ui.ops.style.display = 'none';
  updateViewButtons('follow');
  const followText = document.getElementById('followText');
  if (followText) followText.textContent = 'Follow camera locked';
  updateVesselPanel(true);
  showToast(`Tracking ${ship.name} · ${ship.spec.label}`);
}

function releaseSelection() {
  selectedShip = null;
  simulation.select(null);
  ui.panel.style.display = 'none';
  ui.ops.style.display = '';
  currentView = 'overview';
  cameraRig.setOverview();
  updateViewButtons('overview');
  showToast('Follow released');
}

function showToast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2400);
}

function updateVesselPanel(force = false) {
  if (!selectedShip) return;
  const ship = selectedShip;
  document.getElementById('vesselClass').textContent = `${ship.spec.label} · ${ship.registry}`;
  document.getElementById('vesselName').textContent = ship.name;
  document.getElementById('vesselTask').textContent = ship.task;
  document.getElementById('vesselDest').textContent = ship.destination;
  document.getElementById('vesselSpeed').innerHTML = `${Math.round(ship.velocity.length() * 9.4)} <small>m/s</small>`;
  document.getElementById('vesselReg').textContent = ship.registry;
  const eta = ship.eta > 0.5 ? formatEta(ship.eta) : (ship.mission.state.includes('Docked') || ship.mission.state.includes('unloading') ? formatEta(ship.eta) : '—');
  document.getElementById('vesselEta').textContent = eta;
  document.getElementById('vesselPhase').textContent = (ship.mission.phase || ship.mission.state || 'TRANSIT').toString().toUpperCase();
  const prog = Math.round(clamp(ship.progress ?? 0.3, 0, 1) * 100);
  document.getElementById('vesselProgressLabel').textContent = `${prog}%`;
  document.getElementById('vesselProgress').style.width = `${Math.max(4, prog)}%`;
  const followText = document.getElementById('followText');
  if (followText) followText.textContent = currentView === 'follow' ? 'Follow camera locked' : 'Vessel selected';
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0.5) return '—';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (s < 60) return `00:${String(r).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function updateStageStats() {
  if (!simulation) return;
  const active = simulation.activeShipCount;
  document.getElementById('statActive').textContent = `${String(active).padStart(2, '0')} vessels`;
  document.getElementById('statDocks').textContent = `${simulation.countDocked()} / ${DOCKS.length}`;
  document.getElementById('statMining').textContent = `${simulation.miningCount} active`;
  const level = active > 39 ? 'Traffic heavy' : active > 28 ? 'Traffic elevated' : 'Traffic nominal';
  document.getElementById('statTraffic').textContent = level;
  const bars = ui.trafficBars ? [...ui.trafficBars.children] : [];
  for (let i = 0; i < bars.length; i++) {
    const h = 3 + ((active * (i + 3) + simTime * 0.4) % 9);
    bars[i].style.height = `${h.toFixed(1)}px`;
    bars[i].classList.toggle('hot', i < Math.round((active / 44) * bars.length));
  }
  setText('statActive', `${String(active).padStart(2, '0')} vessels`);
  document.getElementById('telemetry').innerHTML = `SIM <b id="fps">${Math.round(smoothedFps)}</b> FPS <span>·</span> ${active} VESSELS <span>·</span> HD 40307`;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/* ------------------------------------------------------------------ */
/* loading                                                             */
/* ------------------------------------------------------------------ */

function setLoading(pct, phase) {
  if (loadingBar) loadingBar.style.width = `${pct}%`;
  if (loadingPhase && phase) loadingPhase.textContent = phase;
}

async function paint() {
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

function setLoadingDone() {
  setLoading(100, 'Helios Station online');
  setTimeout(() => {
    loading.classList.add('done');
    loading.style.opacity = '0';
    loading.style.visibility = 'hidden';
    setTimeout(() => { loading.style.display = 'none'; }, 1400);
    setTimeout(() => {
      showToast(`Helios Station · ${simulation.activeShipCount} vessels under way`);
    }, 700);
  }, 420);
}

/* ------------------------------------------------------------------ */
/* resize & quality                                                    */
/* ------------------------------------------------------------------ */

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (cameraRig) cameraRig.onResize();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  if (composer) {
    composer.setPixelRatio(pixelRatio);
    composer.setSize(w, h);
  }
  if (finalPass) finalPass.uniforms.uResolution.value.set(w, h);
  if (particleField) particleField.material.uniforms.uPixelRatio.value = pixelRatio;
  if (starField) starField.userData.material.uniforms.uPixelRatio.value = pixelRatio;
}

function updateQuality(dt) {
  frames++;
  fpsTimer += dt;
  qualityTimer += dt;
  if (fpsTimer > 0.55) {
    smoothedFps = frames / fpsTimer;
    frames = 0;
    fpsTimer = 0;
  }
  if (qualityLevel === 0 && qualityTimer > 6 && smoothedFps < 44) {
    qualityLevel = 1;
    qualityScale = 0.78;
    pixelRatio = Math.max(0.7, Math.min(window.devicePixelRatio || 1, 1.6) * qualityScale);
    renderer.setPixelRatio(pixelRatio);
    resize();
    bloomPass.strength = 0.42;
    if (particleField) particleField.material.uniforms.uPixelRatio.value = pixelRatio;
    showToast('Adaptive quality engaged');
  } else if (qualityLevel === 1 && qualityTimer > 17 && smoothedFps < 31) {
    qualityLevel = 2;
    qualityScale = 0.62;
    pixelRatio = Math.max(0.62, Math.min(window.devicePixelRatio || 1, 1.6) * qualityScale);
    renderer.setPixelRatio(pixelRatio);
    resize();
    bloomPass.strength = 0.32;
    if (particleField) particleField.material.uniforms.uPixelRatio.value = pixelRatio;
    showToast('Performance mode engaged');
  }
}

/* ------------------------------------------------------------------ */
/* animation loop                                                      */
/* ------------------------------------------------------------------ */

function animate() {
  requestAnimationFrame(animate);
  if (!simulation) return;
  const rawDt = Math.min(clock.getDelta(), 0.05);
  realTime += rawDt;
  const dt = paused ? 0 : rawDt * simSpeed;

  if (!paused) {
    const steps = Math.min(5, Math.max(1, Math.ceil(dt / 0.034)));
    const step = dt / steps;
    for (let i = 0; i < steps; i++) {
      const stepTime = simTime + step * (i + 1);
      simulation.update(step, stepTime, camera, effectsEnabled);
    }
    simTime += dt;
    if (simulation.capital.capitalState !== lastCapitalState) {
      if (simulation.capital.capitalState === 'arrival') {
        showToast(`Capital arrival · ${simulation.capital.name}`);
      } else if (lastCapitalState === 'depart' && simulation.capital.capitalState === 'hidden') {
        showToast(`${simulation.capital.name} has departed station space`);
      }
      lastCapitalState = simulation.capital.capitalState;
    }
    particleField.update(dt);
    jumpFX.update(dt);
    planetSystem.update(simTime, dt);
    asteroidField.update(simTime, dt);
    updateStation(simTime, dt);
    routeOverlay.update(simTime);
  }

  // star shader is alive even while paused
  starField.userData.material.uniforms.uTime.value = realTime;
  finalPass.uniforms.uTime.value = realTime;

  if (cinemaActive) {
    cinemaDirector.update(rawDt);
  } else {
    cameraRig.update(rawDt);
  }
  simulation.updateSelection(realTime, camera);

  // leave a jump/transit scene if the tracked ship disappears
  if (selectedShip && (selectedShip.hidden || !selectedShip.densityVisible)) {
    followLostTimer += rawDt;
    if (followLostTimer > 2.6) {
      const wasHidden = selectedShip.hidden;
      releaseSelection();
      showToast(wasHidden ? 'Vessel entered jump transit — follow released' : 'Vessel hidden by traffic filter');
    }
  } else {
    followLostTimer = 0;
  }

  if (simTime - lastInfoUpdate > 0.12) {
    lastInfoUpdate = simTime;
    if (selectedShip && !selectedShip.hidden) updateVesselPanel();
  }
  if (realTime - lastOpsUpdate > 0.65) {
    lastOpsUpdate = realTime;
    updateStageStats();
    document.getElementById('sim-clock').textContent = formatClock(simTime);
  }

  updateQuality(rawDt);
  if (composer) composer.render();
  else renderer.render(scene, camera);
}

function updateStation(time, dt) {
  if (!station) return;
  for (const child of station.anim.children) {
    if (child.userData.spin) child.rotation.y += dt * child.userData.spin;
  }
  for (const beacon of station.beacons) {
    const phase = beacon.userData.phase || 0;
    const base = beacon.userData.baseScale || beacon.scale.x;
    const flick = 0.5 + 0.5 * Math.sin(time * 1.8 + phase * 2.1);
    beacon.material.opacity = 0.25 + flick * 0.75;
    beacon.scale.setScalar(base * (0.8 + flick * 0.35));
  }
  for (const beacon of navigationBeacons.beacons) {
    const flick = 0.5 + 0.5 * Math.sin(time * 2.1 + beacon.userData.phase);
    beacon.material.opacity = 0.2 + flick * 0.8;
  }
  for (const gate of gates) {
    const pulse = gate.group.userData.jumpPulse || 0;
    gate.group.userData.portalMat.uniforms.time.value = time;
    gate.group.userData.portalMat.uniforms.uActive.value = 0.08 + pulse * 1.2;
    gate.group.userData.jumpPulse = Math.max(0, pulse - dt * 0.65);
    gate.group.userData.halo.material.opacity = 0.12 + Math.sin(time * 0.8 + gate.def.position.x) * 0.03 + pulse * 0.35;
  }
}

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

buildWorld().then(() => {
  resize();
  animate();
}).catch((err) => {
  console.error(err);
  const bar = document.querySelector('.loading-sub');
  if (bar) bar.textContent = 'Unable to initialize orbital network';
  setLoading(100, 'Initialization error');
});
