import * as THREE from 'three';
import { getGlowTexture, getBurstTexture, makeLabelSprite, shipPalette, damp } from './utils.js';

const plumeGeo = new THREE.CylinderGeometry(0.08, 1, 1, 10, 1, true);

function makePlumeMaterial(color, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        float fade = pow(1.0 - vUv.y, 1.55);
        float shimmer = 0.82 + 0.18 * sin(vUv.y * 22.0 - uTime * 24.0 + vUv.x * 12.0);
        float hot = pow(1.0 - vUv.y, 5.0);
        vec3 col = mix(uColor * 1.5, vec3(1.4), hot * 0.5);
        gl_FragColor = vec4(col, fade * uOpacity * shimmer);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

export function createEngineRig(spec, type, withLight = true) {
  const palette = shipPalette[type] || shipPalette.courier;
  const group = new THREE.Group();
  const coreMat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color: new THREE.Color(palette.primary),
    transparent: true,
    opacity: 0.98,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const haloMat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color: new THREE.Color(palette.trail),
    transparent: true,
    opacity: 0.42,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const innerMat = makePlumeMaterial(palette.primary, 0.82);
  const outerMat = makePlumeMaterial(palette.secondary, 0.22);

  const engines = [];
  const center = new THREE.Vector3();
  for (const e of spec.engines) {
    const anchor = new THREE.Group();
    anchor.position.set(e.x, e.y, e.z);
    const scale = e.scale;

    const halo = new THREE.Sprite(haloMat);
    halo.scale.setScalar(scale * 8.5);
    anchor.add(halo);

    const core = new THREE.Sprite(coreMat);
    core.scale.setScalar(scale * 3.0);
    anchor.add(core);

    const inner = new THREE.Mesh(plumeGeo, innerMat);
    inner.rotation.x = -Math.PI / 2;
    inner.frustumCulled = false;
    anchor.add(inner);

    const outer = new THREE.Mesh(plumeGeo, outerMat);
    outer.rotation.x = -Math.PI / 2;
    outer.frustumCulled = false;
    anchor.add(outer);

    group.add(anchor);
    engines.push({ anchor, core, halo, inner, outer, scale, power: e.power ?? 1 });
    center.x += e.x; center.y += e.y; center.z += e.z;
  }
  center.divideScalar(Math.max(1, spec.engines.length));

  let light = null;
  if (withLight && spec.length > 19) {
    light = new THREE.PointLight(palette.primary, 0, Math.max(38, spec.length * 2.2), 2);
    light.position.copy(center).add(new THREE.Vector3(0, 0, -spec.length * 0.08));
    group.add(light);
  }

  let throttle = 0.4;
  let time = 0;

  function update(targetThrottle, dt, active = true) {
    throttle = damp(throttle, targetThrottle, 3.2, dt);
    time += dt;
    innerMat.uniforms.uTime.value = time;
    outerMat.uniforms.uTime.value = time;
    outerMat.uniforms.uOpacity.value = 0.015 + throttle * 0.17;
    innerMat.uniforms.uOpacity.value = 0.06 + throttle * 0.82;
    coreMat.opacity = 0.4 + throttle * 0.6;

    for (let i = 0; i < engines.length; i++) {
      const eng = engines[i];
      const pulse = 0.92 + Math.sin(time * 19 + i * 2.37) * 0.08;
      const length = (2.2 + throttle * 24.0) * eng.scale * eng.power * pulse;
      const width = eng.scale * (0.55 + throttle * 0.58);
      eng.inner.scale.set(width, length, width);
      eng.inner.position.z = -length * 0.5;
      eng.outer.scale.set(width * 1.85, length * 1.22, width * 1.85);
      eng.outer.position.z = -length * 0.61;
      eng.core.scale.setScalar(eng.scale * (1.9 + throttle * 4.0) * pulse);
      eng.halo.scale.setScalar(eng.scale * (4.4 + throttle * 8.2) * pulse);
      eng.halo.material.opacity = 0.12 + throttle * 0.31;
    }
    if (light) light.intensity = 62 * throttle * (0.92 + Math.sin(time * 17) * 0.08);
  }

  return {
    group,
    engines,
    center,
    palette,
    update,
    getThrottle: () => throttle,
    light,
  };
}

/* ------------------------------------------------------------------ */
/* engine trails                                                       */
/* ------------------------------------------------------------------ */

export class Trail {
  constructor(color, width = 1.4, maxPoints = 38, lifetime = 1.45) {
    this.color = new THREE.Color(color);
    this.width = width;
    this.maxPoints = maxPoints;
    this.lifetime = lifetime;
    this.points = [];
    this.positions = new Float32Array(maxPoints * 2 * 3);
    this.alphas = new Float32Array(maxPoints * 2);
    this.index = new Uint16Array((maxPoints - 1) * 6);
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2;
      this.index[i * 6] = a;
      this.index[i * 6 + 1] = a + 1;
      this.index[i * 6 + 2] = a + 3;
      this.index[i * 6 + 3] = a;
      this.index[i * 6 + 4] = a + 3;
      this.index[i * 6 + 5] = a + 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(this.index, 1));
    geo.setDrawRange(0, 0);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: this.color } },
      vertexShader: /* glsl */`
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(uColor * 0.9, vAlpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.last = new THREE.Vector3();
    this.hasLast = false;
    this.tmp = new THREE.Vector3();
    this.tan = new THREE.Vector3();
    this.view = new THREE.Vector3();
    this.side = new THREE.Vector3();
  }

  addPoint(pos, time, intensity) {
    if (!this.hasLast) {
      this.last.copy(pos);
      this.hasLast = true;
    }
    const dist = this.last.distanceTo(pos);
    if (dist > 0.18) {
      this.points.unshift({ pos: pos.clone(), t: time, intensity });
      this.last.copy(pos);
      if (this.points.length > this.maxPoints) this.points.pop();
    } else if (this.points.length) {
      this.points[0].t = time;
      this.points[0].intensity = intensity;
    }
    while (this.points.length && time - this.points[this.points.length - 1].t > this.lifetime) {
      this.points.pop();
    }
  }

  clear() {
    this.points.length = 0;
    this.hasLast = false;
    this.geometry.setDrawRange(0, 0);
  }

  update(cameraPosition, time) {
    // drop stale points
    while (this.points.length && time - this.points[this.points.length - 1].t > this.lifetime) {
      this.points.pop();
    }
    const n = this.points.length;
    if (n < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }
    const posArr = this.positions;
    const alphaArr = this.alphas;
    for (let i = 0; i < n; i++) {
      const p = this.points[i].pos;
      const prev = this.points[Math.max(0, i - 1)].pos;
      const next = this.points[Math.min(n - 1, i + 1)].pos;
      this.tan.subVectors(prev, next);
      if (this.tan.lengthSq() < 1e-6) this.tan.set(0, 0, 1);
      this.view.subVectors(cameraPosition, p);
      this.side.crossVectors(this.tan, this.view).normalize();
      if (this.side.lengthSq() < 1e-6) this.side.set(1, 0, 0);
      const age = THREE.MathUtils.clamp(1 - (time - this.points[i].t) / this.lifetime, 0, 1);
      const a = Math.pow(age, 1.65) * (0.55 + this.points[i].intensity * 0.35);
      const w = this.width * (0.35 + age * 0.65) * (0.4 + this.points[i].intensity * 0.8);
      const j = i * 6;
      posArr[j] = p.x + this.side.x * w;
      posArr[j + 1] = p.y + this.side.y * w;
      posArr[j + 2] = p.z + this.side.z * w;
      posArr[j + 3] = p.x - this.side.x * w;
      posArr[j + 4] = p.y - this.side.y * w;
      posArr[j + 5] = p.z - this.side.z * w;
      const k = i * 2;
      alphaArr[k] = a;
      alphaArr[k + 1] = a;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.setDrawRange(0, (n - 1) * 6);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* exhaust, sparks and dust particles                                  */
/* ------------------------------------------------------------------ */

export class ParticleField {
  constructor(max = 2400) {
    this.max = max;
    this.next = 0;
    this.particles = [];
    const positions = new Float32Array(max * 3);
    const colors = new Float32Array(max * 3);
    const sizes = new Float32Array(max);
    const alphas = new Float32Array(max);
    for (let i = 0; i < max; i++) {
      this.particles.push({ active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, maxLife: 1, color: new THREE.Color(), size: 1, alpha: 1, drag: 0.5, shrink: 0.6 });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry = geo;
    this.positions = positions;
    this.colors = colors;
    this.sizes = sizes;
    this.alphas = alphas;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: 1 } },
      vertexShader: /* glsl */`
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(aSize * uPixelRatio * (260.0 / max(1.0, -mv.z)), 1.0, 90.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float d = length(p);
          float core = smoothstep(0.5, 0.02, d);
          float glow = smoothstep(0.5, 0.12, d) * 0.42;
          gl_FragColor = vec4(vColor * (1.4 + core * 0.6), (core + glow) * vAlpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.tmpColor = new THREE.Color();
  }

  spawn(position, velocity, color, size, life, alpha = 1, drag = 0.8) {
    const p = this.particles[this.next];
    this.next = (this.next + 1) % this.max;
    p.active = true;
    p.pos.copy(position);
    p.vel.copy(velocity);
    p.color.set(color);
    p.size = size;
    p.life = life;
    p.maxLife = life;
    p.alpha = alpha;
    p.drag = drag;
  }

  update(dt) {
    const { particles, positions, colors, sizes, alphas } = this;
    for (let i = 0; i < this.max; i++) {
      const p = particles[i];
      const j = i * 3;
      if (!p.active) {
        alphas[i] = 0;
        continue;
      }
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        alphas[i] = 0;
        continue;
      }
      const drag = Math.exp(-p.drag * dt);
      p.vel.multiplyScalar(drag);
      p.pos.addScaledVector(p.vel, dt);
      positions[j] = p.pos.x;
      positions[j + 1] = p.pos.y;
      positions[j + 2] = p.pos.z;
      colors[j] = p.color.r;
      colors[j + 1] = p.color.g;
      colors[j + 2] = p.color.b;
      const t = p.life / p.maxLife;
      sizes[i] = p.size * (0.3 + t * 0.7);
      alphas[i] = Math.pow(t, 0.7) * p.alpha;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ */
/* jump effects                                                        */
/* ------------------------------------------------------------------ */

export class JumpFX {
  constructor(scene) {
    this.scene = scene;
    this.effects = [];
    this.ringGeo = new THREE.TorusGeometry(1, 0.055, 6, 96);
    this.ringGeo2 = new THREE.TorusGeometry(1, 0.018, 4, 96);
    this.sphereGeo = new THREE.SphereGeometry(1, 24, 16);
  }

  trigger(position, color = 0xa777ff, scale = 42, quaternion = null, duration = 2.8, intensity = 1) {
    const group = new THREE.Group();
    group.position.copy(position);
    if (quaternion) group.quaternion.copy(quaternion);
    const c = new THREE.Color(color);
    const rings = [];
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: c.clone().multiplyScalar(0.7 + i * 0.18),
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const m = new THREE.Mesh(i === 0 ? this.ringGeo : this.ringGeo2, mat);
      m.scale.setScalar(scale * (0.7 + i * 0.16));
      m.renderOrder = 8;
      group.add(m);
      rings.push(m);
    }
    const flashMat = new THREE.SpriteMaterial({
      map: getBurstTexture(),
      color: c.clone().lerp(new THREE.Color(0xffffff), 0.2),
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      rotation: Math.random() * Math.PI * 2,
    });
    const flash = new THREE.Sprite(flashMat);
    flash.scale.setScalar(scale * 3.4);
    flash.renderOrder = 9;
    group.add(flash);

    const softGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(),
      color: c.clone(),
      transparent: true,
      opacity: 0.36,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }));
    softGlow.scale.setScalar(scale * 5.4);
    softGlow.renderOrder = 7;
    group.add(softGlow);

    const shockMat = new THREE.MeshBasicMaterial({
      color: c,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
      toneMapped: false,
    });
    const shock = new THREE.Mesh(this.sphereGeo, shockMat);
    shock.scale.setScalar(scale * 0.3);
    group.add(shock);

    const light = new THREE.PointLight(c, 210 * intensity, scale * 4.4, 2);
    group.add(light);
    this.scene.add(group);
    this.effects.push({ group, rings, flash, softGlow, shock, light, t: 0, duration, scale, intensity, seed: Math.random() * 10 });
  }

  update(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.t += dt;
      const p = Math.min(1, e.t / e.duration);
      const fade = Math.pow(1 - p, 1.8);
      for (let r = 0; r < e.rings.length; r++) {
        const ring = e.rings[r];
        const rp = Math.min(1, p * (1.0 + r * 0.35));
        ring.scale.setScalar(e.scale * (0.55 + rp * (2.0 + r * 1.4)));
        ring.material.opacity = Math.pow(1 - rp, 1.5) * (0.4 + r * 0.1) * e.intensity;
        ring.rotation.z += dt * (0.2 + r * 0.15);
      }
      e.flash.material.opacity = Math.pow(1 - Math.min(1, p * 1.7), 2.6) * 0.92;
      e.flash.scale.setScalar(e.scale * (2.8 + p * 2.6));
      e.flash.material.rotation += dt * 0.25;
      e.softGlow.material.opacity = Math.pow(1 - Math.min(1, p * 1.35), 2.2) * 0.45;
      e.softGlow.scale.setScalar(e.scale * (4.4 + p * 2.4));
      e.shock.scale.setScalar(e.scale * (0.3 + p * 2.6));
      e.shock.material.opacity = Math.pow(1 - p, 2.2) * 0.2 * e.intensity;
      e.light.intensity = 240 * e.intensity * Math.pow(1 - p, 2.2);
      if (p >= 1) {
        this.scene.remove(e.group);
        e.rings.forEach((r) => { r.material.dispose(); });
        e.flash.material.dispose();
        e.softGlow.material.dispose();
        e.shock.material.dispose();
        this.effects.splice(i, 1);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* selection indicator                                                 */
/* ------------------------------------------------------------------ */

export function createSelectionIndicator() {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: 0x69cce8,
    transparent: true,
    opacity: 0.38,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 4, 80), mat);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.006, 4, 80), mat);
  const ring3 = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.004, 4, 64), mat);
  group.add(ring1, ring2, ring3);
  const dotMat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color: 0x8ce6ff,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const dots = [];
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Sprite(dotMat);
    const a = (i / 4) * Math.PI * 2;
    s.position.set(Math.cos(a), Math.sin(a), 0);
    s.scale.setScalar(0.04);
    group.add(s);
    dots.push(s);
  }
  group.visible = false;
  return {
    group,
    rings: [ring1, ring2, ring3],
    dots,
    update(time, camera) {
      group.quaternion.copy(camera.quaternion);
      ring1.rotation.z = time * 0.25;
      ring2.rotation.z = -time * 0.12;
      ring3.rotation.z = time * 0.4;
      const pulse = 1 + Math.sin(time * 2.5) * 0.025;
      const base = group.userData.baseScale || 1;
      group.scale.setScalar(base * pulse);
      mat.opacity = 0.28 + Math.sin(time * 2.2) * 0.1;
    },
  };
}

/* ------------------------------------------------------------------ */
/* route overlay                                                       */
/* ------------------------------------------------------------------ */

export class RouteOverlay {
  constructor(ships, docks, gates) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.items = new Map();
    this.docks = docks;
    this.gates = gates;
    this.labels = new THREE.Group();
    this.group.add(this.labels);
    const colors = {
      freight: 0x8ed8ff,
      courier: 0x6df5f1,
      miner: 0xffd18a,
      patrol: 0x7aa8ff,
      capital: 0xc1a8ff,
      drone: 0x9df9e8,
      unknown: 0xff7888,
    };
    for (const ship of ships) {
      const material = new THREE.LineBasicMaterial({
        color: colors[ship.type] || 0x9fe8ff,
        transparent: true,
        opacity: 0.32,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3).setUsage(THREE.DynamicDrawUsage));
      const line = new THREE.Line(geo, material);
      line.frustumCulled = false;
      this.group.add(line);
      this.items.set(ship.id, { ship, line, material, points: 2 });
    }

    for (const dock of docks) {
      const sprite = makeLabelSprite(dock.id, dock.type === 'miner' ? '#ffd18a' : '#a6dfff', 3.1);
      sprite.position.copy(dock.pad).add(new THREE.Vector3(0, 8.5, 0));
      sprite.material.opacity = 0.55;
      this.labels.add(sprite);
    }
    for (const gate of gates) {
      const sprite = makeLabelSprite(gate.id, '#bda8ff', 4.2);
      sprite.position.copy(gate.position).add(new THREE.Vector3(0, gate.radius + 6, 0));
      sprite.material.opacity = 0.7;
      this.labels.add(sprite);
    }
  }

  setVisible(v) {
    this.group.visible = v;
  }

  update(time) {
    if (!this.group.visible) return;
    for (const item of this.items.values()) {
      const { ship, line, material } = item;
      const posAttr = line.geometry.attributes.position;
      const start = ship.group.position;
      const path = ship.overlayPoints && ship.overlayPoints.length ? ship.overlayPoints : [ship.mission.target];
      const n = Math.min(path.length, 3);
      let idx = 0;
      posAttr.setXYZ(idx++, start.x, start.y, start.z);
      for (let i = 0; i < n; i++) {
        const p = path[i];
        if (p) posAttr.setXYZ(idx++, p.x, p.y, p.z);
      }
      for (; idx < 6; idx++) posAttr.setXYZ(idx, path[path.length - 1]?.x ?? start.x, path[path.length - 1]?.y ?? start.y, path[path.length - 1]?.z ?? start.z);
      posAttr.needsUpdate = true;
      line.geometry.setDrawRange(0, idx);
      material.opacity = (ship.visible && ship.densityVisible && !ship.hidden) ? (ship.selected ? 0.86 : 0.27) : 0.0;
    }
  }
}
