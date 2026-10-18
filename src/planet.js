import * as THREE from 'three';
import { fbm3, ridged3, getGlowTexture, smoothstep } from './utils.js';

/* ------------------------------------------------------------------ */
/* equirectangular procedural survey                                   */
/* ------------------------------------------------------------------ */

function spherePoint(u, v) {
  const lon = (u - 0.5) * Math.PI * 2;
  const lat = (v - 0.5) * Math.PI;
  const cl = Math.cos(lat);
  return {
    x: Math.cos(lon) * cl,
    y: Math.sin(lat),
    z: Math.sin(lon) * cl,
    lat,
    lon,
  };
}

function hashCell(x, y, z) {
  let h = x * 374761393 + y * 668265263 + z * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

function buildSurfaceTextures(width = 1024, height = 512) {
  const surface = document.createElement('canvas');
  surface.width = width;
  surface.height = height;
  const sctx = surface.getContext('2d');
  const simg = sctx.createImageData(width, height);
  const sd = simg.data;

  const lights = document.createElement('canvas');
  lights.width = width;
  lights.height = height;
  const lctx = lights.getContext('2d');
  const limg = lctx.createImageData(width, height);
  const ld = limg.data;

  const landMask = new Float32Array(width * height);
  const elevationMap = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const p = spherePoint(u, v);
      const px = p.x, py = p.y, pz = p.z;

      // Continental plates, gently warped by a second field.
      const warp = fbm3(px * 2.6 + 5.2, py * 2.6 - 1.7, pz * 2.6 + 9.1, 3, 2.1, 0.5, 2);
      const continental = fbm3(
        px * 1.65 + warp * 0.33,
        py * 1.65 + warp * 0.21,
        pz * 1.65 - warp * 0.28,
        5, 2.03, 0.51, 11
      );
      const detail = fbm3(px * 9.5, py * 9.5, pz * 9.5, 3, 2.24, 0.46, 23);
      const ridge = ridged3(px * 4.2 + 2, py * 4.2, pz * 4.2, 4, 37);

      const elev = continental + detail * 0.09 + 0.035;
      const land = elev > 0.045 ? 1 : 0;
      const shore = smoothstep(0.02, 0.085, elev);
      const moisture = fbm3(px * 3.1 - 4.3, py * 3.1 + 8.8, pz * 3.1, 3, 2.0, 0.5, 71);
      const ice = smoothstep(0.78, 0.94, Math.abs(p.lat) / (Math.PI * 0.5)) +
        (py > 0.86 ? smoothstep(0.86, 0.91, py + detail * 0.02) : 0);

      let r, g, b;
      if (land) {
        const h = smoothstep(0.06, 0.48, elev);
        // Cool coastal greens, dry interiors, pale rocky highlands.
        const dry = smoothstep(0.12, 0.55, moisture);
        const baseR = 34 + dry * 42 + h * 45;
        const baseG = 66 + dry * 23 + h * 34;
        const baseB = 53 + (1 - dry) * 13 + h * 33;
        const rock = smoothstep(0.4, 0.8, h + ridge * 0.25);
        r = baseR * (1 - rock) + (81 + ridge * 30) * rock;
        g = baseG * (1 - rock) + (81 + ridge * 16) * rock;
        b = baseB * (1 - rock) + (77 + ridge * 10) * rock;
        // Coastal shelf brightening.
        r += (1 - shore) * 10;
        g += (1 - shore) * 20;
        b += (1 - shore) * 25;
      } else {
        const depth = smoothstep(-0.34, 0.045, elev);
        const current = fbm3(px * 6.0 + 1.4, py * 6.0, pz * 6.0, 3, 2.0, 0.5, 91);
        r = 5 + depth * 10 + current * 2;
        g = 17 + depth * 31 + current * 3;
        b = 39 + depth * 49 + current * 6;
      }
      // Ice caps, mixed with cloud-like fracture.
      const iceMix = THREE.MathUtils.clamp(ice * (0.75 + detail * 0.3), 0, 1);
      r = r * (1 - iceMix) + 188 * iceMix;
      g = g * (1 - iceMix) + 203 * iceMix;
      b = b * (1 - iceMix) + 213 * iceMix;

      // Fine terrain variation.
      const micro = noiseLite(px * 38, py * 38, pz * 38);
      r += micro * 5; g += micro * 5; b += micro * 5;

      const idx = (y * width + x) * 4;
      sd[idx] = THREE.MathUtils.clamp(r, 0, 255);
      sd[idx + 1] = THREE.MathUtils.clamp(g, 0, 255);
      sd[idx + 2] = THREE.MathUtils.clamp(b, 0, 255);
      sd[idx + 3] = 255;

      landMask[y * width + x] = land ? shore : 0;
      elevationMap[y * width + x] = elev;

      // City lights: clustered against coastlines, mostly on lower ground.
      const cityField = fbm3(px * 5.1 + 17, py * 5.1 - 4, pz * 5.1 + 8, 3, 2.0, 0.5, 133);
      const cell = 112;
      const qx = Math.floor(((px + 1) * 0.5) * cell);
      const qy = Math.floor(((py + 1) * 0.5) * cell);
      const qz = Math.floor(((pz + 1) * 0.5) * cell);
      const h = hashCell(qx + 7, qy + 3, qz + 11);
      const coastal = smoothstep(0.05, 0.2, shore) * (1 - smoothstep(0.5, 0.86, elev));
      let city = 0;
      if (land && cityField > 0.17 && h > 0.972) {
        const metro = smoothstep(0.17, 0.62, cityField);
        city = (0.22 + metro * 0.78) * (0.25 + coastal * 0.75) * (0.55 + h * 0.45);
        // A tiny collection of city dots within populated cells.
        if (h > 0.989) city = Math.min(1, city * 1.8);
      }
      ld[idx] = 255;
      ld[idx + 1] = 186 + city * 48;
      ld[idx + 2] = 104 + city * 56;
      ld[idx + 3] = Math.floor(city * 255);
    }
  }

  sctx.putImageData(simg, 0, 0);
  lctx.putImageData(limg, 0, 0);

  // Bloom the city lights with a soft, warm halo. The source dots stay crisp.
  const glow = document.createElement('canvas');
  glow.width = width;
  glow.height = height;
  const gctx = glow.getContext('2d');
  gctx.filter = 'blur(2.2px)';
  gctx.globalAlpha = 0.9;
  gctx.drawImage(lights, 0, 0);
  gctx.filter = 'none';
  gctx.globalAlpha = 0.68;
  gctx.globalCompositeOperation = 'lighter';
  gctx.drawImage(lights, 0, 0);

  const surfaceTex = new THREE.CanvasTexture(surface);
  surfaceTex.colorSpace = THREE.SRGBColorSpace;
  surfaceTex.wrapS = THREE.RepeatWrapping;
  surfaceTex.anisotropy = 4;

  const lightsTex = new THREE.CanvasTexture(glow);
  lightsTex.colorSpace = THREE.SRGBColorSpace;
  lightsTex.wrapS = THREE.RepeatWrapping;

  return { surfaceTex, lightsTex, landMask, elevationMap, width, height };
}

// Lightweight triplanar value noise used for tiny surface grain.
function noiseLite(x, y, z) {
  const s = Math.sin(x * 0.73 + y * 1.13 + z * 0.91) *
    Math.sin(x * 2.13 - y * 1.41 + z * 1.77);
  return s;
}

function buildCloudTexture(width = 768, height = 384) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  const d = img.data;
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const p = spherePoint(u, v);
      const warp = fbm3(p.x * 2.4 + 2.7, p.y * 2.4, p.z * 2.4 - 1.2, 3, 2.0, 0.5, 201);
      const cloud = fbm3(
        p.x * 3.4 + warp * 0.55,
        p.y * 3.4 + warp * 0.15,
        p.z * 3.4 - warp * 0.42,
        5, 2.05, 0.53, 177
      );
      let band = smoothstep(0.29, 0.57, cloud + 0.08);
      band *= 0.6 + 0.4 * Math.sin(p.y * 8.0 + warp * 2.0) ** 2;
      const swirl = smoothstep(0.62, 0.84, fbm3(p.x * 9.0, p.y * 9.0, p.z * 9.0, 3, 2, 0.5, 207));
      band = THREE.MathUtils.clamp(band * (0.72 + swirl * 0.4), 0, 1);
      const idx = (y * width + x) * 4;
      const light = 232 + band * 23;
      d[idx] = light;
      d[idx + 1] = light;
      d[idx + 2] = 255;
      d[idx + 3] = band * 218;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

function buildMoonTexture(seed = 1, size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size / 2;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(canvas.width, canvas.height);
  const d = img.data;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const p = spherePoint(x / (canvas.width - 1), y / (canvas.height - 1));
      const base = fbm3(p.x * 3.2, p.y * 3.2, p.z * 3.2, 4, 2.1, 0.52, seed);
      const crater = ridged3(p.x * 7.2, p.y * 7.2, p.z * 7.2, 4, seed + 18);
      let v = 95 + base * 42 + crater * 25;
      v -= smoothstep(0.55, 0.95, crater) * 13;
      const idx = (y * canvas.width + x) * 4;
      d[idx] = v * 0.96; d[idx + 1] = v * 0.99; d[idx + 2] = v * 1.04; d[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // A handful of soft impact basins at this distance reads beautifully.
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#1f2227';
  for (let i = 0; i < 18; i++) {
    const x = (i * 127.3 + seed * 31) % canvas.width;
    const y = (i * 71.7 + seed * 19) % canvas.height;
    const r = 4 + ((i * 37) % 19);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/* ------------------------------------------------------------------ */
/* planet assembly                                                     */
/* ------------------------------------------------------------------ */

export function createPlanetSystem({ planetSunDir }) {
  const radius = 1020;
  const group = new THREE.Group();
  group.position.set(465, -930, -1510);

  const sunDir = planetSunDir.clone().normalize();

  const survey = buildSurfaceTextures(1024, 512);
  const cloudTex = buildCloudTexture(768, 384);

  const surfaceMat = new THREE.MeshStandardMaterial({
    map: survey.surfaceTex,
    color: 0xffffff,
    roughness: 0.96,
    metalness: 0.0,
  });
  const surface = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), surfaceMat);
  surface.rotation.y = 2.15;
  group.add(surface);

  const cloudMat = new THREE.MeshStandardMaterial({
    map: cloudTex,
    color: 0xe6f3ff,
    roughness: 1,
    metalness: 0,
    transparent: true,
    opacity: 0.84,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.008, 80, 52), cloudMat);
  clouds.rotation.y = 2.3;
  clouds.renderOrder = 1;
  group.add(clouds);

  const lightsMat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: survey.lightsTex },
      sunDir: { value: sunDir },
      intensity: { value: 2.35 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      varying vec3 vNormalW;
      void main() {
        vUv = uv;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D map;
      uniform vec3 sunDir;
      uniform float intensity;
      varying vec2 vUv;
      varying vec3 vNormalW;
      void main() {
        vec4 t = texture2D(map, vUv);
        float day = smoothstep(-0.22, 0.16, dot(normalize(vNormalW), sunDir));
        float night = 1.0 - day;
        // Warm sodium / cool LED mix across metropolitan cores.
        vec3 col = t.rgb * vec3(1.0, 0.78, 0.5);
        gl_FragColor = vec4(col * night * intensity, t.a * night * 0.95);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const cityLights = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.004, 96, 64), lightsMat);
  cityLights.rotation.y = 2.15;
  cityLights.renderOrder = 2;
  group.add(cityLights);

  const atmosphereMat = new THREE.ShaderMaterial({
    uniforms: {
      sunDir: { value: sunDir },
      atmoColor: { value: new THREE.Color(0x5bbcff) },
      atmoWarm: { value: new THREE.Color(0xffb576) },
    },
    vertexShader: /* glsl */`
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 sunDir;
      uniform vec3 atmoColor;
      uniform vec3 atmoWarm;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main() {
        vec3 n = normalize(vNormalW);
        float rim = pow(1.0 - clamp(dot(n, vViewDir), 0.0, 1.0), 2.0);
        float sun = clamp(dot(n, sunDir) * 0.5 + 0.5, 0.0, 1.0);
        float forward = pow(clamp(dot(-n, sunDir), 0.0, 1.0), 1.6);
        vec3 col = mix(atmoColor, atmoWarm, forward * 0.18);
        float alpha = rim * (0.13 + sun * 0.7) + rim * forward * 0.14;
        gl_FragColor = vec4(col * (0.75 + sun * 1.25), alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: false,
  });
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.026, 96, 64), atmosphereMat);
  atmosphere.renderOrder = 3;
  group.add(atmosphere);

  // Soft exterior halo, occluded by the planet's own depth.
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color: new THREE.Color(0x2f8bd4),
    transparent: true,
    opacity: 0.34,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
  }));
  halo.scale.set(radius * 2.45, radius * 2.45, 1);
  halo.position.z = 5;
  halo.renderOrder = 0;
  group.add(halo);

  // Thin high-orbit dust belt, visible as a delicate arc.
  const beltGroup = new THREE.Group();
  const beltGeo = new THREE.BufferGeometry();
  const beltCount = 900;
  const pos = new Float32Array(beltCount * 3);
  const colors = new Float32Array(beltCount * 3);
  for (let i = 0; i < beltCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = radius * (1.62 + Math.random() * 0.2);
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = (Math.random() - 0.5) * radius * 0.035;
    pos[i * 3 + 2] = Math.sin(a) * r;
    const c = 0.35 + Math.random() * 0.4;
    colors[i * 3] = c * 0.65; colors[i * 3 + 1] = c * 0.78; colors[i * 3 + 2] = c;
  }
  beltGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  beltGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const belt = new THREE.Points(beltGeo, new THREE.PointsMaterial({
    size: 2.6,
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    sizeAttenuation: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  belt.rotation.x = 0.26;
  belt.rotation.z = -0.18;
  beltGroup.add(belt);
  beltGroup.position.y = radius * 0.12;
  group.add(beltGroup);

  // Distant moons, each on its own slow orbit.
  const moons = [];
  const moonDefs = [
    { pos: [-1365, 1230, -590], r: 62, seed: 4, speed: 0.0035, color: 0x9d9a91 },
    { pos: [735, 1430, -890], r: 38, seed: 9, speed: 0.0022, color: 0x7b93a4 },
  ];
  for (const def of moonDefs) {
    const mat = new THREE.MeshStandardMaterial({
      map: buildMoonTexture(def.seed, 384),
      color: def.color,
      roughness: 1,
      metalness: 0,
      emissive: 0x0a1220,
      emissiveIntensity: 0.55,
    });
    const moon = new THREE.Mesh(new THREE.SphereGeometry(def.r, 32, 24), mat);
    moon.position.set(...def.pos);
    const moonHalo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(),
      color: 0x507aac,
      transparent: true,
      opacity: 0.11,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    }));
    moonHalo.scale.setScalar(def.r * 3.1);
    moon.add(moonHalo);
    moon.userData.orbitSpeed = def.speed;
    moon.userData.baseAngle = Math.atan2(def.pos[2], def.pos[0]);
    moon.userData.orbitRadius = Math.hypot(def.pos[0], def.pos[2]);
    moon.userData.y = def.pos[1];
    group.add(moon);
    moons.push(moon);
  }

  return {
    group,
    surface,
    clouds,
    cityLights,
    atmosphere,
    halo,
    moons,
    sunDir,
    radius,
    update(time, dt) {
      surface.rotation.y += dt * 0.0016;
      clouds.rotation.y += dt * 0.0021;
      cityLights.rotation.y = surface.rotation.y;
      for (const moon of moons) {
        const a = moon.userData.baseAngle + time * moon.userData.orbitSpeed;
        moon.position.x = Math.cos(a) * moon.userData.orbitRadius;
        moon.position.z = Math.sin(a) * moon.userData.orbitRadius;
        moon.position.y = moon.userData.y + Math.sin(time * 0.03 + a) * 10;
        moon.rotation.y += dt * 0.008;
      }
    },
  };
}
