import * as THREE from 'three';
import { SHIP_SPECS, getShipTemplate, DOCKS } from './models.js';
import { createEngineRig, Trail, createSelectionIndicator } from './effects.js';
import { clamp, damp, getGlowTexture, shipPalette } from './utils.js';

const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);

function quatFromForward(forward, out = new THREE.Quaternion()) {
  const z = forward.clone().normalize();
  let x = new THREE.Vector3().crossVectors(UP, z);
  if (x.lengthSq() < 1e-5) x = new THREE.Vector3().crossVectors(Z_AXIS, z);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  return out.setFromRotationMatrix(m);
}

const NAME_BANKS = {
  freight: ['Argo Meridian', 'Cinder Vale', 'Tessaly', 'Long Haul', 'Morrow Star', 'Belisarius', 'Corvus Freight', 'Kestrel Dawn'],
  courier: ['Sable', 'Wren', 'Quicksilver', 'Peregrine', 'Mistral', 'Orchid', 'Vesper', 'Halcyon', 'Zephyr'],
  miner: ['Terra Nova', 'Deepward', 'Ore Baron', 'Mole', 'Prospector'],
  patrol: ['Sentinel One', 'Sentinel Two', 'Sentinel Three', 'Warden One', 'Warden Two', 'Warden Three'],
  drone: ['Weld-01', 'Weld-02', 'Weld-03', 'Weld-04', 'Weld-05', 'Patch-06', 'Patch-07', 'Survey-08', 'Survey-09', 'Rivet-10'],
  capital: ['Sovereign Ascendant'],
  escort: ['Asterion', 'Lyre'],
  unknown: ['UNK-7741'],
};

const PREFIX = {
  freight: 'MV', courier: 'CV', miner: 'IV', patrol: 'PV', drone: 'SV', capital: 'DN', unknown: 'UNK',
};

const SERVICE_LABELS = ['outer ring', 'habitat ring', 'dock truss', 'refinery gantry', 'solar spar'];

const COURIER_LANES = [
  new THREE.Vector3(178, 34, 94),
  new THREE.Vector3(55, 58, 190),
  new THREE.Vector3(-112, 28, 176),
  new THREE.Vector3(-188, -2, 52),
  new THREE.Vector3(-154, -26, -124),
  new THREE.Vector3(-26, 4, -196),
  new THREE.Vector3(136, 26, -158),
  new THREE.Vector3(202, 10, -20),
];

const PATROL_ROUTES = [
  { radius: 232, y: 26, speed: 0.058, phase: 0.2 },
  { radius: 286, y: -16, speed: -0.041, phase: 2.8 },
];

const UNKNOWN_ROUTE = [
  new THREE.Vector3(-338, 78, -74),
  new THREE.Vector3(-254, 54, 144),
  new THREE.Vector3(-102, 24, 274),
  new THREE.Vector3(126, 48, 286),
  new THREE.Vector3(294, 97, 128),
  new THREE.Vector3(338, 62, -92),
  new THREE.Vector3(184, 34, -270),
  new THREE.Vector3(-88, 46, -316),
];

/* ------------------------------------------------------------------ */
/* docking authority                                                   */
/* ------------------------------------------------------------------ */

class DockAuthority {
  constructor(docks) {
    this.docks = docks;
  }

  freeDocks(type) {
    return this.docks.filter((d) => d.type === type && !d.occupied && !d.reservedBy);
  }

  request(type, desired = null) {
    const free = this.freeDocks(type);
    if (!free.length) return null;
    if (desired && free.includes(desired)) return desired;
    return free[0];
  }

  reserve(dock, ship) {
    if (!dock) return false;
    if (dock.occupied || (dock.reservedBy && dock.reservedBy !== ship.id)) return false;
    dock.reservedBy = ship.id;
    return true;
  }

  occupy(dock, ship) {
    if (!dock) return;
    dock.reservedBy = ship.id;
    dock.occupied = ship.id;
  }

  release(dock, ship) {
    if (!dock) return;
    if (dock.reservedBy === ship.id) dock.reservedBy = null;
    if (dock.occupied === ship.id) dock.occupied = null;
  }

  nearestFree(type, position) {
    const free = this.freeDocks(type);
    if (!free.length) return null;
    free.sort((a, b) => a.pad.distanceToSquared(position) - b.pad.distanceToSquared(position));
    return free[0];
  }

  occupancy() {
    return this.docks.filter((d) => d.occupied || d.reservedBy).length;
  }
}

/* ------------------------------------------------------------------ */
/* simulation                                                          */
/* ------------------------------------------------------------------ */

export class TrafficSimulation {
  constructor({ scene, station, asteroidField, gates, particleField, jumpFX, effectsEnabled = true }) {
    this.scene = scene;
    this.station = station;
    this.asteroidField = asteroidField;
    this.gates = gates;
    this.particleField = particleField;
    this.jumpFX = jumpFX;
    this.effectsEnabled = effectsEnabled;
    this.dockAuthority = new DockAuthority(DOCKS);
    this.ships = [];
    this.byId = new Map();
    this.time = 0;
    this.density = 'med';
    this.densityLimit = 1;
    this.selection = null;
    this.capital = null;
    this.escorts = [];
    this.unknown = null;
    this.patrolGroups = [[], []];
    this.raycaster = new THREE.Raycaster();
    this.tmpVec = new THREE.Vector3();
    this.tmpVec2 = new THREE.Vector3();
    this.selectionIndicator = createSelectionIndicator();
    scene.add(this.selectionIndicator.group);

    this.createFleet();
    this.registerById();
    this.assignDensityTiers();
    this.setDensity('med');
    this.runWarmup(58);
    this.registerById();
  }

  /* ------------------------- fleet creation ------------------------ */

  createFleet() {
    const gateObjs = this.gates;
    const gateA = gateObjs[0];
    const gateB = gateObjs[1];

    for (let i = 0; i < 8; i++) {
      const gate = i % 2 === 0 ? gateA : gateB;
      const ship = this.createShip('freight', NAME_BANKS.freight[i], i);
      const toStation = new THREE.Vector3().subVectors(new THREE.Vector3(0, 0, 0), gate.group.position).normalize();
      ship.group.position.copy(gate.group.position).addScaledVector(toStation, 34 + (i % 3) * 27);
      ship.group.position.x += Math.cos(i * 2.43) * 30;
      ship.group.position.y += Math.sin(i * 1.71) * 22;
      ship.orientation.copy(quatFromForward(toStation));
      ship.velocity.copy(toStation).multiplyScalar(16);
      this.beginFreightCycle(ship, gate, 0);
      this.ships.push(ship);
    }

    for (let i = 0; i < 9; i++) {
      const ship = this.createShip('courier', NAME_BANKS.courier[i], i);
      this.beginCourier(ship, i);
      this.ships.push(ship);
    }

    for (let i = 0; i < 5; i++) {
      const ship = this.createShip('miner', NAME_BANKS.miner[i], i);
      const dock = DOCKS.filter((d) => d.type === 'miner')[i % 2];
      ship.group.position.copy(dock.pad).addScaledVector(dock.outward, 34 + i * 9);
      ship.group.position.y += 8 + i * 2;
      ship.orientation.copy(quatFromForward(new THREE.Vector3().subVectors(new THREE.Vector3(0, 0, 0), ship.group.position)));
      ship.velocity.copy(dock.outward).multiplyScalar(-10);
      this.beginMinerCycle(ship);
      this.ships.push(ship);
    }

    for (let g = 0; g < 2; g++) {
      for (let i = 0; i < 3; i++) {
        const ship = this.createShip('patrol', NAME_BANKS.patrol[g * 3 + i], g * 3 + i);
        this.beginPatrol(ship, g, i);
        this.patrolGroups[g].push(ship);
        this.ships.push(ship);
      }
    }

    for (let i = 0; i < 10; i++) {
      const ship = this.createShip('drone', NAME_BANKS.drone[i], i);
      this.beginDrone(ship, i);
      this.ships.push(ship);
    }

    this.unknown = this.createShip('unknown', NAME_BANKS.unknown[0], 0);
    this.beginUnknown(this.unknown);
    this.ships.push(this.unknown);

    this.capital = this.createShip('capital', NAME_BANKS.capital[0], 0, true);
    this.capital.group.visible = false;
    this.capital.visible = false;
    this.capital.hidden = true;
    this.capital.capitalState = 'hidden';
    this.capital.nextArrival = 1e9;
    this.capital.mission = {
      target: new THREE.Vector3(0, 0, 0),
      state: 'hidden',
      phase: 'JUMP TRANSIT',
    };
    this.ships.push(this.capital);

    for (let i = 0; i < 2; i++) {
      const ship = this.createShip('patrol', NAME_BANKS.escort[i], i, true);
      ship.isEscort = true;
      ship.capital = this.capital;
      ship.group.visible = false;
      ship.visible = false;
      ship.hidden = true;
      ship.mission = { target: new THREE.Vector3(), state: 'escort', phase: 'STANDBY' };
      this.escorts.push(ship);
      this.ships.push(ship);
    }
  }

  createShip(type, name, index, special = false) {
    const spec = SHIP_SPECS[type];
    const template = getShipTemplate(type).clone(true);
    const group = new THREE.Group();
    group.add(template);
    this.scene.add(group);
    const id = `${PREFIX[type] || 'XV'}-${(type === 'unknown' ? 7741 : 100 + this.ships.length * 7)}`;
    const ship = {
      id,
      type,
      name,
      registry: id,
      spec,
      group,
      orientation: new THREE.Quaternion(),
      velocity: new THREE.Vector3(),
      bank: 0,
      turnDemand: 0,
      throttle: 0.35,
      visible: true,
      densityVisible: true,
      densityTier: 0,
      hidden: false,
      selected: false,
      index,
      phase: Math.random() * Math.PI * 2,
      mission: { state: 'idle', target: new THREE.Vector3(), phase: 'IDLE', progress: 0 },
      task: 'Awaiting assignment',
      destination: '—',
      progress: 0,
      eta: 0,
      overlayPoints: [],
      special,
    };

    const withLight = type === 'capital' || (type === 'freight' && index < 2) || (type === 'miner' && index === 0) || type === 'unknown';
    const rig = createEngineRig(spec, type, withLight);
    group.add(rig.group);
    ship.engineRig = rig;
    const trailColor = shipPalette[type]?.trail || 0x7edcff;
    const trailLife = type === 'courier' || type === 'patrol' ? 1.15 : type === 'drone' ? 0.85 : type === 'capital' ? 2.4 : 1.7;
    ship.trail = new Trail(trailColor, Math.min(5.4, Math.max(0.5, spec.length * 0.06)), 46, trailLife);
    this.scene.add(ship.trail.mesh);

    // manoeuvring thruster points
    const thrGeo = new THREE.BufferGeometry();
    const arr = new Float32Array(spec.thrusters.length * 3);
    for (let i = 0; i < spec.thrusters.length; i++) {
      arr[i * 3] = spec.thrusters[i][0];
      arr[i * 3 + 1] = spec.thrusters[i][1];
      arr[i * 3 + 2] = spec.thrusters[i][2];
    }
    thrGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const thrMat = new THREE.PointsMaterial({
      map: getGlowTexture(),
      color: new THREE.Color(shipPalette[type]?.primary || 0x7edcff),
      size: type === 'capital' ? 4.0 : type === 'drone' ? 0.5 : Math.max(0.8, spec.length * 0.09),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      toneMapped: false,
    });
    ship.thrusters = new THREE.Points(thrGeo, thrMat);
    group.add(ship.thrusters);

    // running lights
    ship.navLights = [];
    for (let i = 0; i < spec.navLights.length; i++) {
      const color = i === 0 ? 0xff455b : i === 1 ? 0x5dffa8 : i === 2 ? 0xffffff : 0xff6f80;
      const mat = new THREE.SpriteMaterial({
        map: getGlowTexture(),
        color,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(...spec.navLights[i]);
      sprite.scale.setScalar(type === 'capital' ? 2.5 : type === 'drone' ? 0.45 : 0.9);
      group.add(sprite);
      ship.navLights.push(sprite);
    }

    // generous invisible pick proxy for small craft
    const pickMat = new THREE.MeshBasicMaterial({ visible: false });
    const pick = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), pickMat);
    pick.scale.setScalar(Math.max(spec.radius * 0.92, 3));
    pick.userData.shipId = id;
    group.add(pick);
    ship.pick = pick;

    // mining beam (used only by miners)
    if (type === 'miner') {
      const beamMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xffcf8c) } },
        vertexShader: /* glsl */`
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: /* glsl */`
          uniform float uTime;
          uniform vec3 uColor;
          varying vec2 vUv;
          void main() {
            float pulse = 0.78 + 0.22 * sin(vUv.y * 45.0 - uTime * 35.0);
            float edge = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.65, vUv.y);
            gl_FragColor = vec4(mix(uColor, vec3(1.4), 0.3), edge * pulse);
          }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.7, 1, 7, 1, true), beamMat);
      beam.frustumCulled = false;
      beam.visible = false;
      this.scene.add(beam);
      ship.beam = beam;
      const beamOuter = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 2.2, 1, 7, 1, true), new THREE.MeshBasicMaterial({
        color: 0xffb15c,
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }));
      beamOuter.frustumCulled = false;
      beamOuter.visible = false;
      this.scene.add(beamOuter);
      ship.beamOuter = beamOuter;
      const impactMat = new THREE.SpriteMaterial({
        map: getGlowTexture(),
        color: 0xffd8a1,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const impact = new THREE.Sprite(impactMat);
      impact.scale.setScalar(7);
      impact.visible = false;
      this.scene.add(impact);
      ship.beamImpact = impact;
      ship.emitterLocal = new THREE.Vector3(0, 0.1, 14.6);
    }

    return ship;
  }

  assignDensityTiers() {
    const groups = {
      freight: 0, courier: 0, miner: 0, patrol: 0, drone: 0,
    };
    const tierMap = {
      freight: [0, 0, 0, 0, 1, 1, 2, 2],
      courier: [0, 0, 0, 0, 1, 1, 1, 2, 2],
      miner: [0, 0, 0, 1, 2],
      patrol: [0, 0, 0, 1, 1, 2],
      drone: [0, 0, 0, 0, 0, 1, 1, 1, 2, 2],
    };
    for (const ship of this.ships) {
      if (ship === this.capital || ship.isEscort || ship === this.unknown) {
        ship.densityTier = 0;
        continue;
      }
      const i = groups[ship.type]++;
      const tiers = tierMap[ship.type];
      ship.densityTier = tiers[Math.min(i, tiers.length - 1)] ?? 1;
    }
  }

  setDensity(level) {
    this.density = level;
    this.densityLimit = level === 'low' ? 0 : level === 'high' ? 2 : 1;
    for (const ship of this.ships) {
      ship.densityVisible = ship.densityTier <= this.densityLimit;
      this.applyVisibility(ship);
    }
  }

  applyVisibility(ship) {
    const vis = ship.visible && ship.densityVisible && !ship.hidden;
    ship.group.visible = vis;
    ship.trail.mesh.visible = vis && ship.trail.points.length > 1;
    if (ship.beam) ship.beam.visible = vis && ship.beamActive;
    if (ship.beamOuter) ship.beamOuter.visible = vis && ship.beamActive;
    if (ship.beamImpact) ship.beamImpact.visible = vis && ship.beamActive;
  }

  get visibleShips() {
    return this.ships.filter((s) => s.visible && s.densityVisible && !s.hidden);
  }

  get activeShipCount() {
    return this.visibleShips.length;
  }

  get miningCount() {
    return this.ships.filter((s) => s.mission.state === 'mining' && s.densityVisible && s.visible).length;
  }

  /* --------------------------- warmup ----------------------------- */

  runWarmup(seconds) {
    const steps = Math.floor(seconds / 0.1);
    for (let i = 0; i < steps; i++) {
      this.updateMissions(0.1, this.time + i * 0.1, true);
    }
    this.time = seconds;
    for (const ship of this.ships) {
      ship.trail.clear();
      ship.engineRig.update(ship.throttle, 0.5, ship.visible);
    }
    this.capital.hidden = true;
    this.capital.visible = false;
    this.capital.capitalState = 'hidden';
    this.capital.mission.state = 'hidden';
    this.capital.group.visible = false;
    this.capital.trail.clear();
    for (const e of this.escorts) {
      e.hidden = true;
      e.visible = false;
      e.trail.clear();
      this.applyVisibility(e);
    }
    this.capital.nextArrival = this.time + 7.5;
  }

  /* --------------------------- missions --------------------------- */

  beginFreightCycle(ship, arrivalGate, cycleIndex) {
    const dock = this.dockAuthority.nearestFree('heavy', arrivalGate.group.position) || DOCKS[0];
    ship.mission = {
      kind: 'freight',
      state: 'inbound',
      dock,
      arrivalGate,
      departureGate: arrivalGate === this.gates[0] ? this.gates[1] : this.gates[0],
      timer: 0,
      nextCheck: 0,
      cycle: cycleIndex,
      target: dock.approach.clone(),
      phase: 'INBOUND',
      progress: 0.05,
      jumpDone: false,
    };
    ship.task = 'Inbound — cargo run';
    ship.destination = 'Helios approach';
    ship.progress = 0.08;
    ship.hidden = false;
    ship.visible = true;
    this.applyVisibility(ship);
  }

  beginCourier(ship, index) {
    const factor = 0.85 + (index % 5) * 0.07;
    const rotation = (index / 9) * Math.PI * 2;
    ship.courier = {
      waypoint: index % COURIER_LANES.length,
      factor,
      rotation,
      yOffset: (index % 4) * 7 - 10,
      legs: index % 3,
      dockEvery: 3 + (index % 3),
      timer: 0,
      dock: null,
      nextCheck: 0,
    };
    const p = this.courierWaypoint(ship, ship.courier.waypoint);
    ship.group.position.copy(p);
    ship.orientation.copy(quatFromForward(new THREE.Vector3(-p.x, 0, -p.z).normalize()));
    ship.velocity.set(0, 0, 0);
    ship.mission = {
      kind: 'courier',
      state: 'courier',
      target: this.courierWaypoint(ship, (ship.courier.waypoint + 1) % COURIER_LANES.length),
      phase: 'TRANSIT',
      progress: 0.2,
    };
    ship.task = 'Courier relay — priority vector';
    ship.destination = 'Relay node KC-04';
  }

  courierWaypoint(ship, index) {
    const base = COURIER_LANES[index % COURIER_LANES.length];
    const c = Math.cos(ship.courier.rotation);
    const s = Math.sin(ship.courier.rotation);
    return new THREE.Vector3(
      (base.x * c - base.z * s) * ship.courier.factor,
      base.y + ship.courier.yOffset,
      (base.x * s + base.z * c) * ship.courier.factor
    );
  }

  beginMinerCycle(ship) {
    const rocks = this.asteroidField.asteroids;
    const candidateIndices = [1, 3, 5, 7, 9, 11, 14, 17, 20, 24, 28, 33, 39, 46, 55, 63];
    const pick = candidateIndices[(ship.index * 3 + Math.floor(this.time / 20)) % candidateIndices.length];
    const rock = rocks[pick % rocks.length];
    const world = this.asteroidField.group.localToWorld(rock.pos.clone());
    const fromStation = world.clone().normalize();
    const workPos = world.clone().addScaledVector(fromStation, Math.max(12, rock.scale * 0.9 + 14));
    workPos.y += Math.max(3, rock.scale * 0.25);
    ship.miner = {
      rock,
      rockIndex: pick,
      workPos,
      timer: 0,
      dock: null,
      nextCheck: 0,
      cycle: (ship.miner?.cycle || 0) + 1,
      lastBeamParticle: 0,
    };
    ship.mission = {
      kind: 'miner',
      state: 'mineOutbound',
      target: workPos.clone(),
      phase: 'OUTBOUND',
      progress: 0.05,
    };
    ship.task = 'Outbound — prospecting run';
    ship.destination = `Asteroid field · K-${String(pick).padStart(3, '0')}`;
    ship.progress = 0.04;
    ship.hidden = false;
    ship.visible = true;
    this.applyVisibility(ship);
  }

  beginPatrol(ship, groupIndex, formationIndex) {
    const route = PATROL_ROUTES[groupIndex];
    ship.patrol = {
      group: groupIndex,
      formation: formationIndex,
      angle: route.phase + formationIndex * 0.2,
      route,
      state: 'patrol',
    };
    const radius = route.radius;
    const a = route.phase + formationIndex * 0.1;
    const pos = new THREE.Vector3(Math.cos(a) * radius, route.y + Math.sin(a * 2) * 9, Math.sin(a) * radius);
    ship.group.position.copy(pos);
    ship.orientation.copy(quatFromForward(new THREE.Vector3(-Math.sin(a), 0, Math.cos(a))));
    ship.velocity.set(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(16);
    ship.mission = {
      kind: 'patrol',
      state: 'patrol',
      target: pos.clone(),
      phase: 'PATROL',
      progress: 0.5,
    };
    ship.task = formationIndex === 0 ? 'Perimeter patrol — sector 7' : `Formation escort — ${NAME_BANKS.patrol[groupIndex * 3]}`;
    ship.destination = `Patrol circuit ${groupIndex + 1}`;
  }

  beginDrone(ship, index) {
    const radius = 96 + (index % 5) * 9 + (index >= 5 ? 24 : 0);
    const angle = (index / 10) * Math.PI * 2 + 0.45;
    const y = -14 + (index % 6) * 11;
    ship.drone = {
      radius,
      angle,
      speed: 0.16 + (index % 4) * 0.025,
      y,
      state: 'orbit',
      serviceTimer: 14 + index * 2.4,
      phase: index * 0.7,
      sector: (index % 5) + 1,
      sparks: 0,
    };
    ship.group.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    ship.orientation.copy(quatFromForward(new THREE.Vector3(-Math.cos(angle), 0, -Math.sin(angle))));
    ship.mission = {
      kind: 'drone',
      state: 'orbit',
      target: ship.group.position.clone(),
      phase: 'SURVEY',
      progress: 0.5,
    };
    ship.task = `Hull inspection — ${SERVICE_LABELS[index % SERVICE_LABELS.length]}`;
    ship.destination = `Helios Station · ring sector ${ship.drone.sector}`;
  }

  beginUnknown(ship) {
    ship.unknown = {
      waypoint: 2,
      timer: 0,
      escorted: false,
    };
    ship.group.position.copy(UNKNOWN_ROUTE[2]);
    ship.orientation.copy(quatFromForward(UNKNOWN_ROUTE[3].clone().sub(UNKNOWN_ROUTE[2]).normalize()));
    ship.velocity.copy(UNKNOWN_ROUTE[3].clone().sub(UNKNOWN_ROUTE[2]).normalize()).multiplyScalar(28);
    ship.mission = {
      kind: 'unknown',
      state: 'dark',
      target: UNKNOWN_ROUTE[3].clone(),
      phase: 'SILENT RUNNING',
      progress: 0.5,
    };
    ship.task = 'Silent running — unregistered vector';
    ship.destination = 'Unknown — deep space';
  }

  /* -------------------------- main update -------------------------- */

  update(dt, time, camera, effectsEnabled = true) {
    this.time = time;
    this.effectsEnabled = effectsEnabled;
    this.updateMissions(dt, time, false);
    for (const ship of this.ships) {
      this.animateShip(ship, dt, time, camera);
    }
    this.updateSelection(time, camera);
  }

  updateMissions(dt, time, warmup) {
    // capital deploy window and patrol interception are scheduled events
    this.updateCapital(dt, time, warmup);
    const interceptActive = (time % 100) >= 55 && (time % 100) < 86;
    for (const ship of this.ships) {
      if (ship === this.capital || ship.isEscort) continue;
      if (ship.type === 'freight') this.updateFreight(ship, dt, time, warmup);
      else if (ship.type === 'courier') this.updateCourier(ship, dt, time, warmup);
      else if (ship.type === 'miner') this.updateMiner(ship, dt, time, warmup);
      else if (ship.type === 'patrol') this.updatePatrol(ship, dt, time, warmup, interceptActive);
      else if (ship.type === 'drone') this.updateDrone(ship, dt, time, warmup);
      else if (ship === this.unknown) this.updateUnknown(ship, dt, time, warmup);
    }
    // escort geometry trails the capital
    for (let i = 0; i < this.escorts.length; i++) {
      this.updateEscort(this.escorts[i], i, dt, time, warmup);
    }
    // release dangling claims if a ship was forced away
    for (const dock of DOCKS) {
      if (dock.occupied) {
        const ship = this.byId.get(dock.occupied);
        if (!ship) dock.occupied = null;
      }
    }
  }

  /* ---------------------------- freight --------------------------- */

  updateFreight(ship, dt, time, warmup) {
    const m = ship.mission;
    m.timer = Math.max(0, m.timer - dt);
    const state = m.state;
    if (state === 'inbound') {
      if (!m.dockReserved) {
        const dist = ship.group.position.length();
        if (dist < 330 && time > m.nextCheck) {
          const requested = this.dockAuthority.request('heavy', m.dock);
          if (requested) {
            m.dock = requested;
            m.dockReserved = true;
            m.state = 'approach';
            m.phase = 'APPROACH';
            this.dockAuthority.reserve(requested, ship);
            ship.destination = requested.label;
            return;
          }
          m.nextCheck = time + 2.1;
          m.state = 'holding';
          m.phase = 'HOLDING';
          ship.task = 'Holding pattern — dock queued';
          return;
        }
      }
      const target = m.dock.approach.clone().addScaledVector(m.dock.outward, 76);
      const dist = ship.group.position.distanceTo(target);
      m.target.copy(target);
      this.steer(ship, target, dt, ship.spec.length > 30 ? 25 : 21, 115);
      m.progress = clamp(1 - dist / 650, 0.03, 0.7);
      ship.overlayPoints = [m.dock.approach, m.dock.berth];
      ship.task = 'Inbound — cargo run';
      ship.destination = 'Helios approach';
      ship.eta = dist / Math.max(4, ship.velocity.length());
      this.setThrottleForTravel(ship, 0.9);
    } else if (state === 'approach') {
      const dist = ship.group.position.distanceTo(m.dock.berth);
      const target = m.dock.berth;
      m.target.copy(target);
      const speedLimit = dist > 42 ? 13.0 : 3.8;
      this.steer(ship, target, dt, speedLimit, 48, true);
      m.progress = clamp(1 - dist / 170, 0.7, 0.96);
      ship.overlayPoints = [m.dock.berth];
      ship.task = 'Final approach — docking clearance';
      ship.destination = m.dock.label;
      ship.eta = dist / Math.max(1.5, ship.velocity.length());
      this.setThrottleForTravel(ship, 0.34);
      if (dist < 4.8 && ship.velocity.length() < 3.0) {
        m.state = 'unloading';
        m.timer = 16 + (ship.index % 4) * 2.5;
        m.phase = 'UNLOADING';
        ship.velocity.set(0, 0, 0);
        ship.destination = m.dock.label;
        this.dockAuthority.occupy(m.dock, ship);
      }
    } else if (state === 'holding') {
      if (time > m.nextCheck) {
        const requested = this.dockAuthority.request('heavy', m.dock);
        if (requested && this.dockAuthority.reserve(requested, ship)) {
          m.dock = requested;
          m.dockReserved = true;
          m.state = 'approach';
          m.phase = 'APPROACH';
          ship.destination = requested.label;
          return;
        }
        m.nextCheck = time + 1.7;
      }
      const target = this.holdPoint(m.dock, ship, time, 95);
      m.target.copy(target);
      this.steer(ship, target, dt, 13, 36);
      m.progress = 0.42;
      ship.overlayPoints = [m.dock.approach];
      ship.task = 'Holding pattern — dock queued';
      ship.destination = m.dock.label;
      ship.eta = 0.0;
      this.setThrottleForTravel(ship, 0.42);
    } else if (state === 'unloading') {
      this.dampToBerth(ship, m.dock, dt);
      ship.velocity.multiplyScalar(0.82);
      const duration = 16 + (ship.index % 4) * 2.5;
      m.progress = 1 - m.timer / duration;
      ship.task = 'Docked — unloading cargo';
      ship.destination = m.dock.label;
      ship.eta = m.timer;
      this.setThrottleForTravel(ship, 0.02);
      this.emitDockParticles(ship, m.dock, dt, time, false);
      if (m.timer <= 0) {
        this.dockAuthority.release(m.dock, ship);
        m.dockReserved = false;
        m.state = 'undock';
        m.timer = 2.6;
        m.phase = 'UNDOCKING';
        ship.task = 'Undocking — outbound vector';
        m.target.copy(m.dock.berth).addScaledVector(m.dock.outward, 90);
      }
    } else if (state === 'undock') {
      const target = m.dock.berth.clone().addScaledVector(m.dock.outward, 90);
      m.target.copy(target);
      this.steer(ship, target, dt, 9, 40);
      m.progress = 0.97;
      ship.task = 'Undocking — outbound vector';
      ship.destination = m.departureGate.def.id;
      this.setThrottleForTravel(ship, 0.6);
      if (m.timer <= 0 || ship.group.position.distanceTo(target) < 10) {
        m.state = 'outbound';
        m.phase = 'OUTBOUND';
      }
    } else if (state === 'outbound') {
      const gatePos = m.departureGate.group.position;
      const toGate = new THREE.Vector3().subVectors(gatePos, ship.group.position);
      const dist = toGate.length();
      let target = gatePos;
      ship.overlayPoints = [gatePos];
      m.target.copy(target);
      this.steer(ship, target, dt, 27, 120);
      m.progress = clamp(1 - dist / 550, 0.1, 0.92);
      ship.task = 'Outbound — departure corridor';
      ship.destination = `${m.departureGate.def.id} Jump Gate`;
      ship.eta = dist / Math.max(5, ship.velocity.length());
      this.setThrottleForTravel(ship, 0.95);
      if (dist < 57) {
        m.state = 'jumpout';
        m.timer = 2.3;
        m.phase = 'JUMP ALIGN';
        ship.task = 'Jump alignment — spin drive charging';
        ship.destination = `${m.departureGate.def.id} Jump Gate`;
        this.setThrottleForTravel(ship, 0.7);
      }
    } else if (state === 'jumpout') {
      this.steer(ship, m.departureGate.group.position, dt, 4.5, 30);
      m.progress = 0.98;
      ship.task = 'Jump alignment — spin drive charging';
      this.setThrottleForTravel(ship, 0.5);
      if (m.timer <= 0) {
        if (!warmup && this.effectsEnabled) {
          this.jumpFX.trigger(
            m.departureGate.group.position,
            0x9d7cff,
            44,
            m.departureGate.group.quaternion,
            2.4,
            1
          );
          m.departureGate.group.userData.jumpPulse = 1.4;
          this.emitJumpSparks(m.departureGate, 0x9d7cff, 30);
        }
        ship.hidden = true;
        ship.visible = false;
        ship.trail.clear();
        m.state = 'transit';
        m.timer = 3.5 + (ship.index % 3) * 0.7;
        m.phase = 'JUMP TRANSIT';
        ship.task = 'Jump transit — no telemetry';
        ship.destination = 'Interstellar transit';
        this.applyVisibility(ship);
      }
    } else if (state === 'transit') {
      if (m.timer <= 0) {
        const arrival = m.departureGate === this.gates[0] ? this.gates[1] : this.gates[0];
        const toStation = new THREE.Vector3().subVectors(new THREE.Vector3(), arrival.group.position).normalize();
        ship.group.position.copy(arrival.group.position).addScaledVector(toStation, 26);
        ship.velocity.copy(toStation).multiplyScalar(14);
        ship.orientation.copy(quatFromForward(toStation));
        ship.hidden = false;
        ship.visible = true;
        if (!warmup && this.effectsEnabled) {
          this.jumpFX.trigger(arrival.group.position, 0x9d7cff, 32, arrival.group.quaternion, 2.0, 0.8);
          arrival.group.userData.jumpPulse = 1.0;
          this.emitJumpSparks(arrival, 0x9d7cff, 20);
        }
        m.cycle += 1;
        this.beginFreightCycle(ship, arrival, m.cycle);
        ship.velocity.copy(toStation).multiplyScalar(12);
      }
    }
    this.finishMissionBookkeeping(ship);
  }

  /* ---------------------------- courier --------------------------- */

  updateCourier(ship, dt, time) {
    const m = ship.mission;
    const c = ship.courier;
    if (m.state === 'courier') {
      const nextIndex = (c.waypoint + 1) % COURIER_LANES.length;
      const target = this.courierWaypoint(ship, nextIndex);
      m.target.copy(target);
      const dist = ship.group.position.distanceTo(target);
      this.steer(ship, target, dt, 53, 65);
      m.progress = clamp(1 - dist / 150, 0.05, 0.95);
      ship.overlayPoints = [target];
      ship.task = `Courier relay — vector ${String(nextIndex + 1).padStart(2, '0')}`;
      ship.destination = `Relay node KC-${String(nextIndex + 1).padStart(2, '0')}`;
      ship.eta = dist / Math.max(10, ship.velocity.length());
      this.setThrottleForTravel(ship, 0.94);
      if (dist < 21) {
        c.waypoint = nextIndex;
        c.legs += 1;
        if (c.legs >= c.dockEvery) {
          const requested = this.dockAuthority.request('express', null);
          if (requested && this.dockAuthority.reserve(requested, ship)) {
            c.dock = requested;
            m.state = 'courierApproach';
            m.phase = 'APPROACH';
            ship.destination = requested.label;
          } else {
            c.dock = DOCKS.find((d) => d.type === 'express');
            m.state = 'courierHold';
            m.nextCheck = time + 1.2;
            m.phase = 'HOLDING';
          }
        }
      }
    } else if (m.state === 'courierHold') {
      if (time > c.nextCheck) {
        const requested = this.dockAuthority.request('express', c.dock);
        if (requested && this.dockAuthority.reserve(requested, ship)) {
          c.dock = requested;
          m.state = 'courierApproach';
          m.phase = 'APPROACH';
          ship.destination = requested.label;
          return;
        }
        c.nextCheck = time + 1.3;
      }
      const target = this.holdPoint(c.dock, ship, time, 52);
      m.target.copy(target);
      this.steer(ship, target, dt, 18, 28);
      m.progress = 0.4;
      ship.overlayPoints = [c.dock.approach];
      ship.task = 'Courier holding — express bay queued';
      ship.destination = c.dock.label;
      this.setThrottleForTravel(ship, 0.36);
    } else if (m.state === 'courierApproach') {
      const dist = ship.group.position.distanceTo(c.dock.berth);
      m.target.copy(c.dock.berth);
      this.steer(ship, c.dock.berth, dt, dist > 28 ? 14 : 4.2, 36, true);
      m.progress = clamp(1 - dist / 125, 0.65, 0.97);
      ship.overlayPoints = [c.dock.berth];
      ship.task = 'Courier approach — priority berth';
      ship.destination = c.dock.label;
      ship.eta = dist / Math.max(2, ship.velocity.length());
      this.setThrottleForTravel(ship, 0.28);
      if (dist < 4.4 && ship.velocity.length() < 3.2) {
        m.state = 'courierDocked';
        m.timer = 3.8 + (ship.index % 3) * 0.8;
        m.phase = 'DATA TRANSFER';
        ship.velocity.set(0, 0, 0);
        this.dockAuthority.occupy(c.dock, ship);
      }
    } else if (m.state === 'courierDocked') {
      this.dampToBerth(ship, c.dock, dt);
      m.timer -= dt;
      const duration = 3.8 + (ship.index % 3) * 0.8;
      m.progress = 1 - m.timer / duration;
      ship.task = 'Docked — data transfer';
      ship.destination = c.dock.label;
      ship.eta = m.timer;
      this.setThrottleForTravel(ship, 0.02);
      if (m.timer <= 0) {
        this.dockAuthority.release(c.dock, ship);
        c.dock = null;
        c.legs = 0;
        c.dockEvery = 3 + ((ship.index + 1) % 3);
        c.waypoint = (c.waypoint + 1) % COURIER_LANES.length;
        m.state = 'courier';
        m.phase = 'DEPARTURE';
        ship.task = 'Departing — priority slot';
      }
    }
    this.finishMissionBookkeeping(ship);
  }

  /* ----------------------------- miner ---------------------------- */

  updateMiner(ship, dt, time, warmup) {
    const m = ship.mission;
    const info = ship.miner;
    const rockWorld = this.asteroidField.group.localToWorld(info.rock.pos.clone());
    const fromStation = rockWorld.clone().normalize();
    const workPos = rockWorld.clone().addScaledVector(fromStation, Math.max(12, info.rock.scale * 0.9 + 14));
    workPos.y += Math.max(3, info.rock.scale * 0.25);
    info.workPos.copy(workPos);
    info.rockWorld = rockWorld;

    if (m.state === 'mineOutbound') {
      m.target.copy(workPos);
      const dist = ship.group.position.distanceTo(workPos);
      this.steer(ship, workPos, dt, 24, 70);
      m.progress = clamp(1 - dist / 520, 0.03, 0.9);
      ship.overlayPoints = [workPos];
      ship.task = 'Outbound — prospecting run';
      ship.destination = `Asteroid field · K-${String(info.rockIndex).padStart(3, '0')}`;
      ship.eta = dist / Math.max(6, ship.velocity.length());
      this.setThrottleForTravel(ship, 0.9);
      if (dist < 8.5) {
        m.state = 'mining';
        m.timer = 15 + (ship.index % 3) * 2.5;
        m.phase = 'CUTTING';
        ship.velocity.multiplyScalar(0.2);
        ship.beamActive = true;
        this.applyVisibility(ship);
      }
    } else if (m.state === 'mining') {
      this.coast(ship, dt, 0.6);
      m.timer -= dt;
      // hold position while the cutting head works
      const hold = workPos.clone().addScaledVector(fromStation, 1.4);
      ship.group.position.lerp(hold, 1 - Math.exp(-1.8 * dt));
      const look = rockWorld.clone().sub(ship.group.position).normalize();
      this.orientTo(ship, look, dt, 1.3);
      m.target.copy(rockWorld);
      const duration = 15 + (ship.index % 3) * 2.5;
      m.progress = 1 - m.timer / duration;
      ship.task = 'Mining — cutting beam active';
      ship.destination = `Asteroid field · K-${String(info.rockIndex).padStart(3, '0')}`;
      ship.eta = m.timer;
      this.setThrottleForTravel(ship, 0.06);
      this.updateMiningBeam(ship, rockWorld, time, dt, warmup);
      if (m.timer <= 0) {
        m.state = 'collecting';
        m.timer = 5.0;
        m.phase = 'COLLECTING';
        ship.beamActive = false;
        ship.beam.visible = false;
        ship.beamOuter.visible = false;
        ship.beamImpact.visible = false;
      }
    } else if (m.state === 'collecting') {
      this.coast(ship, dt, 0.8);
      m.timer -= dt;
      const look = rockWorld.clone().sub(ship.group.position).normalize();
      this.orientTo(ship, look, dt, 1.0);
      m.progress = 1 - m.timer / 5;
      ship.task = 'Collecting ore — magnetic recovery';
      ship.destination = `Asteroid field · K-${String(info.rockIndex).padStart(3, '0')}`;
      ship.eta = m.timer;
      this.setThrottleForTravel(ship, 0.15);
      if (!warmup && this.effectsEnabled) {
        info.sparkAcc = (info.sparkAcc || 0) + dt * 20;
        while (info.sparkAcc > 1) {
          info.sparkAcc -= 1;
          const toShip = ship.group.position.clone().add(new THREE.Vector3(0, 1, 0));
          const start = rockWorld.clone().add(new THREE.Vector3((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5));
          const vel = toShip.clone().sub(start).normalize().multiplyScalar(10 + Math.random() * 12);
          vel.add(new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3));
          this.particleField.spawn(start, vel, 0xffc06e, 1.0, 0.8, 0.8, 0.3);
        }
      }
      if (m.timer <= 0) {
        m.state = 'mineReturn';
        m.phase = 'RETURN';
        info.dock = this.dockAuthority.nearestFree('miner', ship.group.position);
        if (info.dock) this.dockAuthority.reserve(info.dock, ship);
        ship.task = 'Returning — ore hold full';
        ship.destination = info.dock ? info.dock.label : 'Processing queue';
      }
    } else if (m.state === 'mineReturn') {
      if (!info.dock) {
        info.dock = this.dockAuthority.nearestFree('miner', ship.group.position);
      }
      if (!info.dock && ship.group.position.length() < 330 && time > info.nextCheck) {
        const requested = this.dockAuthority.request('miner', null);
        if (requested && this.dockAuthority.reserve(requested, ship)) {
          info.dock = requested;
          m.state = 'mineApproach';
          ship.destination = requested.label;
          return;
        }
        info.nextCheck = time + 2;
      }
      if (info.dock) {
        const target = info.dock.approach.clone().addScaledVector(info.dock.outward, 54);
        m.target.copy(target);
        this.steer(ship, target, dt, 21, 100);
        const dist = ship.group.position.distanceTo(target);
        m.progress = clamp(1 - dist / 450, 0.05, 0.8);
        ship.overlayPoints = [info.dock.approach];
        ship.task = 'Returning — ore hold full';
        ship.destination = info.dock.label;
        ship.eta = dist / Math.max(5, ship.velocity.length());
        this.setThrottleForTravel(ship, 0.8);
        if (dist < 55) {
          m.state = 'mineApproach';
          m.phase = 'APPROACH';
        }
      } else {
        const target = this.holdPoint(DOCKS.filter((d) => d.type === 'miner')[ship.index % 2], ship, time, 70);
        m.target.copy(target);
        this.steer(ship, target, dt, 13, 30);
        m.progress = 0.45;
        ship.task = 'Ore queue — processing delayed';
        ship.destination = 'Ore processing';
        this.setThrottleForTravel(ship, 0.35);
      }
    } else if (m.state === 'mineApproach') {
      const dock = info.dock;
      if (!dock) {
        m.state = 'mineReturn';
        return;
      }
      const dist = ship.group.position.distanceTo(dock.berth);
      m.target.copy(dock.berth);
      this.steer(ship, dock.berth, dt, dist > 40 ? 11 : 3.5, 44, true);
      m.progress = clamp(1 - dist / 130, 0.6, 0.96);
      ship.overlayPoints = [dock.berth];
      ship.task = 'Processing approach — clamp alignment';
      ship.destination = dock.label;
      ship.eta = dist / Math.max(2, ship.velocity.length());
      this.setThrottleForTravel(ship, 0.25);
      if (dist < 4.8 && ship.velocity.length() < 3.0) {
        m.state = 'mineDocked';
        m.timer = 10.5;
        m.phase = 'PROCESSING';
        ship.velocity.set(0, 0, 0);
        this.dockAuthority.occupy(dock, ship);
      }
    } else if (m.state === 'mineDocked') {
      const dock = info.dock;
      this.dampToBerth(ship, dock, dt);
      m.timer -= dt;
      m.progress = 1 - m.timer / 10.5;
      ship.task = 'Docked — ore processing';
      ship.destination = dock.label;
      ship.eta = m.timer;
      this.setThrottleForTravel(ship, 0.02);
      this.emitDockParticles(ship, dock, dt, time, true);
      if (m.timer <= 0) {
        this.dockAuthority.release(dock, ship);
        info.dock = null;
        this.beginMinerCycle(ship);
      }
    }
    this.finishMissionBookkeeping(ship);
  }

  updateMiningBeam(ship, rockWorld, time, dt, warmup) {
    if (!ship.beamActive) return;
    ship.group.updateMatrixWorld();
    const origin = ship.group.localToWorld(ship.emitterLocal.clone());
    const dir = rockWorld.clone().sub(origin);
    const length = dir.length();
    dir.normalize();
    const mid = origin.clone().addScaledVector(dir, length * 0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    ship.beam.position.copy(mid);
    ship.beam.quaternion.copy(q);
    ship.beam.scale.set(1, length, 1);
    ship.beamOuter.position.copy(mid);
    ship.beamOuter.quaternion.copy(q);
    ship.beamOuter.scale.set(1, length * 1.02, 1);
    ship.beam.material.uniforms.uTime.value = time;
    ship.beamImpact.position.copy(rockWorld);
    const flicker = 0.65 + Math.sin(time * 37 + ship.index) * 0.18 + Math.sin(time * 11.3) * 0.1;
    ship.beam.material.uniforms.uColor.value.setRGB(1.0 * flicker, 0.68 * flicker, 0.27 * flicker);
    ship.beamImpact.material.opacity = 0.8 + Math.sin(time * 25) * 0.12;
    ship.beam.visible = ship.visible && ship.densityVisible && !ship.hidden;
    ship.beamOuter.visible = ship.visible && ship.densityVisible && !ship.hidden;
    ship.beamImpact.visible = ship.visible && ship.densityVisible && !ship.hidden;
    if (!warmup && this.effectsEnabled) {
      ship.miner.lastBeamParticle += dt * 34;
      while (ship.miner.lastBeamParticle > 1) {
        ship.miner.lastBeamParticle -= 1;
        const jitter = new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3);
        const start = rockWorld.clone().add(jitter);
        const vel = new THREE.Vector3().randomDirection().multiplyScalar(4 + Math.random() * 11);
        this.particleField.spawn(start, vel, 0xffb15c, 1.5, 0.5 + Math.random() * 0.7, 0.9, 1.8);
      }
    }
  }

  /* ----------------------------- patrol --------------------------- */

  updatePatrol(ship, dt, time, warmup, interceptActive) {
    const p = ship.patrol;
    const group = this.patrolGroups[p.group];
    const leader = group[0];
    const m = ship.mission;
    let target;

    if (interceptActive && this.unknown && !this.unknown.hidden) {
      const unknownPos = this.unknown.group.position;
      if (p.formation === 0) {
        const toMe = ship.group.position.clone().sub(unknownPos).normalize();
        target = unknownPos.clone().addScaledVector(toMe, 34).add(new THREE.Vector3(0, 8, 0));
        if (ship.velocity.length() > 2) {
          const side = new THREE.Vector3().crossVectors(unknownPos.clone().sub(ship.group.position), UP).normalize();
          target.addScaledVector(side, 12);
        }
        p.state = 'intercept';
        m.progress = 0.5;
        ship.task = 'Intercepting unidentified contact';
        ship.destination = 'Contact UNK-7741';
        ship.overlayPoints = [this.unknown.group.position];
      } else {
        const offset = new THREE.Vector3(p.formation === 1 ? -17 : 17, -2, -13);
        offset.applyQuaternion(leader.orientation);
        target = leader.group.position.clone().add(offset);
        target.addScaledVector(this.unknown.velocity, 0.12);
        p.state = 'intercept';
        m.progress = 0.5;
        ship.task = 'Intercept formation — weapons safe';
        ship.destination = 'Contact UNK-7741';
        ship.overlayPoints = [this.unknown.group.position];
      }
      this.steer(ship, target, dt, 48, 60);
      this.setThrottleForTravel(ship, 0.95);
    } else {
      p.state = 'patrol';
      if (p.formation === 0) {
        p.angle += p.route.speed * dt;
        const a = p.angle;
        target = new THREE.Vector3(
          Math.cos(a) * p.route.radius,
          p.route.y + Math.sin(a * 2 + 0.6) * 13,
          Math.sin(a) * p.route.radius
        );
        this.steer(ship, target, dt, 38, 90);
        m.progress = 0.5;
        ship.task = 'Perimeter patrol — sector 7';
        ship.destination = `Patrol circuit ${p.group + 1}`;
        ship.overlayPoints = [target];
      } else {
        const offset = new THREE.Vector3(p.formation === 1 ? -16 : 16, -2.5, -12);
        offset.applyQuaternion(leader.orientation);
        target = leader.group.position.clone().add(offset);
        this.steer(ship, target, dt, 50, 40);
        m.progress = 0.5;
        ship.task = `Formation — ${leader.name}`;
        ship.destination = `Patrol circuit ${p.group + 1}`;
        ship.overlayPoints = [leader.group.position];
      }
      this.setThrottleForTravel(ship, 0.72);
    }
    m.target.copy(target);
    this.finishMissionBookkeeping(ship);
  }

  /* ----------------------------- drones --------------------------- */

  updateDrone(ship, dt, time, warmup) {
    const d = ship.drone;
    const m = ship.mission;
    if (d.state === 'orbit') {
      d.angle += d.speed * dt;
      d.serviceTimer -= dt;
      const a = d.angle;
      const target = new THREE.Vector3(
        Math.cos(a + 0.13) * d.radius,
        d.y + Math.sin(a * 2 + d.phase) * 7,
        Math.sin(a + 0.13) * d.radius
      );
      m.target.copy(target);
      const dist = ship.group.position.distanceTo(target);
      this.steer(ship, target, dt, 18, 18);
      m.progress = (d.angle % (Math.PI * 2)) / (Math.PI * 2);
      ship.overlayPoints = [target];
      ship.task = `Hull survey — ${SERVICE_LABELS[ship.index % SERVICE_LABELS.length]}`;
      ship.destination = `Helios Station · ring sector ${d.sector}`;
      ship.eta = dist / 6;
      this.setThrottleForTravel(ship, 0.3);
      if (d.serviceTimer <= 0) {
        d.state = 'service';
        d.serviceTimer = 3.4 + (ship.index % 4) * 0.6;
        d.sparks = 0;
        this.setThrottleForTravel(ship, 0.02);
      }
    } else if (d.state === 'service') {
      d.serviceTimer -= dt;
      const look = new THREE.Vector3(-ship.group.position.x, 0, -ship.group.position.z).normalize();
      this.orientTo(ship, look, dt, 1.5);
      this.coast(ship, dt, 1.4);
      m.progress = 1 - d.serviceTimer / (3.4 + (ship.index % 4) * 0.6);
      ship.task = 'Welding repair — hull plate';
      ship.destination = `Helios Station · ring sector ${d.sector}`;
      ship.eta = d.serviceTimer;
      this.setThrottleForTravel(ship, 0.02);
      if (!warmup && this.effectsEnabled) {
        d.sparks += dt * 28;
        while (d.sparks > 1) {
          d.sparks -= 1;
          const origin = ship.group.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2));
          const outward = new THREE.Vector3(-Math.cos(d.angle), 0.2 + Math.random() * 0.8, -Math.sin(d.angle)).normalize();
          const vel = outward.multiplyScalar(3 + Math.random() * 7);
          this.particleField.spawn(origin, vel, Math.random() > 0.35 ? 0xffc06c : 0x9deaff, 0.6, 0.35 + Math.random() * 0.4, 1, 1.2);
        }
      }
      if (d.serviceTimer <= 0) {
        d.state = 'orbit';
        d.serviceTimer = 15 + (ship.index % 5) * 3.7;
        d.angle += 0.22;
      }
    }
    this.finishMissionBookkeeping(ship);
  }

  /* ---------------------------- unknown --------------------------- */

  updateUnknown(ship, dt, time, warmup) {
    const u = ship.unknown;
    const m = ship.mission;
    const target = UNKNOWN_ROUTE[u.waypoint];
    m.target.copy(target);
    const dist = ship.group.position.distanceTo(target);
    this.steer(ship, target, dt, 31, 75);
    m.progress = 0.5;
    ship.overlayPoints = [target];
    const nearestPatrol = this.patrolGroups[0][0];
    if (nearestPatrol && nearestPatrol.group.position.distanceTo(ship.group.position) < 90) {
      u.escorted = true;
      ship.task = 'Under patrol escort — compliant';
    } else {
      u.escorted = false;
      ship.task = 'Silent running — unregistered vector';
    }
    ship.destination = 'Unknown — deep space';
    ship.eta = dist / Math.max(4, ship.velocity.length());
    this.setThrottleForTravel(ship, u.escorted ? 0.6 : 0.84);
    if (dist < 26) {
      u.waypoint = (u.waypoint + 1) % UNKNOWN_ROUTE.length;
    }
    this.finishMissionBookkeeping(ship);
  }

  emitJumpSparks(gate, color = 0xb07cff, count = 46) {
    if (!this.effectsEnabled || !gate) return;
    const quat = gate.group.quaternion;
    const origin = gate.group.position;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.6) * 16;
      tmp.copy(origin)
        .addScaledVector(right, Math.cos(a) * r)
        .addScaledVector(up, Math.sin(a) * r)
        .addScaledVector(normal, (Math.random() - 0.5) * 8);
      const dir = new THREE.Vector3()
        .addScaledVector(right, Math.cos(a) * (10 + Math.random() * 32))
        .addScaledVector(up, Math.sin(a) * (10 + Math.random() * 32))
        .addScaledVector(normal, (Math.random() - 0.5) * 25);
      this.particleField.spawn(tmp, dir, Math.random() > 0.35 ? color : 0xffffff, 1.3 + Math.random() * 1.8, 1.1 + Math.random() * 1.9, 0.85, 0.25);
    }
  }

  /* ---------------------------- capital --------------------------- */

  updateCapital(dt, time, warmup) {
    const ship = this.capital;
    if (!ship) return;
    const m = ship.mission;
    if (ship.capitalState === 'hidden') {
      for (const e of this.escorts) e.hidden = true;
      if (time >= ship.nextArrival) {
        const gate = this.gates[0];
        const toStation = new THREE.Vector3().subVectors(new THREE.Vector3(), gate.group.position).normalize();
        ship.group.position.copy(gate.group.position).addScaledVector(toStation, 22);
        ship.orientation.copy(quatFromForward(toStation));
        ship.velocity.copy(toStation).multiplyScalar(2.2);
        ship.hidden = false;
        ship.visible = true;
        ship.capitalState = 'arrival';
        ship.arrivalPath = [
          gate.group.position.clone().addScaledVector(toStation, 90),
          new THREE.Vector3(-312, 92, -108),
          new THREE.Vector3(-255, 72, 72),
          new THREE.Vector3(-196, 54, 151),
        ];
        ship.pathIndex = 0;
        ship.holdCenter = new THREE.Vector3(-196, 54, 151);
        ship.holdAngle = 0;
        ship.holdTimer = 82;
        m.state = 'arrival';
        m.phase = 'JUMP ARRIVAL';
        ship.task = 'Jump arrival — reducing velocity';
        ship.destination = 'Helios Station · outer anchorage';
        for (let i = 0; i < this.escorts.length; i++) {
          const e = this.escorts[i];
          e.hidden = false;
          e.visible = true;
          const off = new THREE.Vector3(i === 0 ? -48 : 48, -4, 28);
          off.applyQuaternion(ship.orientation);
          e.group.position.copy(ship.group.position).add(off);
          e.velocity.copy(toStation).multiplyScalar(2.2);
          e.orientation.copy(ship.orientation);
        }
        if (!warmup && this.effectsEnabled) {
          this.jumpFX.trigger(gate.group.position, 0xb07cff, 58, gate.group.quaternion, 4.2, 1.8);
          gate.group.userData.jumpPulse = 2.2;
          this.emitJumpSparks(gate, 0xb07cff, 70);
        }
        this.applyVisibility(ship);
      }
      return;
    }

    if (ship.capitalState === 'arrival') {
      let target = ship.arrivalPath[ship.pathIndex];
      const dist = ship.group.position.distanceTo(target);
      if (dist < 48 && ship.pathIndex < ship.arrivalPath.length - 1) {
        ship.pathIndex++;
        target = ship.arrivalPath[ship.pathIndex];
      }
      m.target.copy(target);
      this.steer(ship, target, dt, 9.4, 68);
      m.progress = ship.pathIndex / ship.arrivalPath.length;
      ship.overlayPoints = [target];
      ship.task = 'Arrival — honor lane';
      ship.destination = 'Helios Station · outer anchorage';
      this.setThrottleForTravel(ship, 0.56);
      if (ship.pathIndex === ship.arrivalPath.length - 1 && dist < 28) {
        ship.capitalState = 'hold';
        m.state = 'hold';
        m.phase = 'HOLDING';
        ship.task = 'Strategic presence — holding station';
      }
    } else if (ship.capitalState === 'hold') {
      ship.holdTimer -= dt;
      ship.holdAngle += dt * 0.018;
      const a = ship.holdAngle;
      const target = ship.holdCenter.clone().add(new THREE.Vector3(Math.cos(a) * 34, Math.sin(a * 1.4) * 8, Math.sin(a) * 34));
      m.target.copy(target);
      this.steer(ship, target, dt, 5.4, 40);
      m.progress = clamp(1 - ship.holdTimer / 82, 0, 1);
      ship.overlayPoints = [target];
      ship.task = 'Strategic presence — holding station';
      ship.destination = 'Helios Station · outer anchorage';
      this.setThrottleForTravel(ship, 0.38);
      if (ship.holdTimer <= 0) {
        ship.capitalState = 'depart';
        m.state = 'depart';
        m.phase = 'DEPARTURE';
        ship.departGate = this.gates[0];
        ship.task = 'Departure — clearing station space';
        ship.departPath = [
          new THREE.Vector3(-118, 74, 186),
          new THREE.Vector3(-318, 94, 42),
          ship.departGate.group.position.clone(),
        ];
        ship.pathIndex = 0;
      }
    } else if (ship.capitalState === 'depart') {
      let target = ship.departPath[ship.pathIndex];
      const dist = ship.group.position.distanceTo(target);
      if (dist < 55 && ship.pathIndex < ship.departPath.length - 1) {
        ship.pathIndex++;
        target = ship.departPath[ship.pathIndex];
      }
      m.target.copy(target);
      this.steer(ship, target, dt, 9.0, 75);
      m.progress = ship.pathIndex / ship.departPath.length;
      ship.overlayPoints = [target];
      ship.task = 'Departure — jump point approach';
      ship.destination = `${ship.departGate.def.id} Jump Gate`;
      this.setThrottleForTravel(ship, 0.7);
      if (ship.pathIndex === ship.departPath.length - 1 && dist < 46) {
        if (!warmup && this.effectsEnabled) {
          this.jumpFX.trigger(ship.departGate.group.position, 0xb07cff, 55, ship.departGate.group.quaternion, 3.8, 1.6);
          ship.departGate.group.userData.jumpPulse = 2.0;
          this.emitJumpSparks(ship.departGate, 0xb07cff, 60);
        }
        ship.hidden = true;
        ship.visible = false;
        ship.capitalState = 'hidden';
        ship.nextArrival = time + 155;
        ship.trail.clear();
        for (const e of this.escorts) {
          e.hidden = true;
          e.visible = false;
          e.trail.clear();
          this.applyVisibility(e);
        }
        this.applyVisibility(ship);
      }
    }
    // escorts are positioned in updateEscort
    this.finishMissionBookkeeping(ship);
  }

  updateEscort(ship, index, dt, time, warmup) {
    if (this.capital.capitalState === 'hidden' || ship.hidden) {
      ship.hidden = true;
      this.applyVisibility(ship);
      return;
    }
    const cap = this.capital;
    const offset = new THREE.Vector3(index === 0 ? -48 : 48, -3 + (index % 2) * 3, 28 + index * 5);
    offset.applyQuaternion(cap.orientation);
    const target = cap.group.position.clone().add(offset);
    ship.mission.target.copy(target);
    this.steer(ship, target, dt, 52, 24);
    ship.mission.progress = 0.5;
    ship.task = `Escort formation — ${cap.name}`;
    ship.destination = 'Helios Station · outer anchorage';
    ship.overlayPoints = [target];
    this.setThrottleForTravel(ship, 0.5);
    this.finishMissionBookkeeping(ship);
  }

  /* ---------------------------- helpers --------------------------- */

  holdPoint(dock, ship, time, radius = 92) {
    if (!dock) return new THREE.Vector3(120, 20, 0);
    const tangent = new THREE.Vector3(-dock.outward.z, 0, dock.outward.x);
    const angle = time * 0.055 + ship.index * 1.8;
    const pos = dock.pad.clone()
      .addScaledVector(dock.outward, radius)
      .addScaledVector(tangent, Math.cos(angle) * (28 + (ship.index % 3) * 6));
    pos.y += 13 + Math.sin(angle * 1.7) * 8;
    return pos;
  }

  steer(ship, target, dt, speedLimit, arriveRadius = 50, skipSeparation = false) {
    const pos = ship.group.position;
    const to = this.tmpVec.subVectors(target, pos);
    const dist = to.length();
    let desiredSpeed = speedLimit * (dist < arriveRadius ? Math.max(0.055, dist / Math.max(3, arriveRadius * 0.55)) : 1);
    desiredSpeed = Math.min(desiredSpeed, speedLimit);
    const dir = dist > 0.001 ? to.multiplyScalar(1 / dist) : new THREE.Vector3(0, 0, 1);
    const desiredVel = dir.multiplyScalar(desiredSpeed);

    // local traffic separation
    let sepX = 0, sepY = 0, sepZ = 0;
    const p = pos;
    for (const other of this.ships) {
      if (skipSeparation || other === ship || other.hidden) continue;
      if (other.isEscort && other.capital === ship) continue;
      if (ship.isEscort && other === ship.capital) continue;
      const r = Math.max(5, ship.spec.radius + other.spec.radius + 7);
      const dx = p.x - other.group.position.x;
      const dy = p.y - other.group.position.y;
      const dz = p.z - other.group.position.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < r * r && d2 > 0.01) {
        const d = Math.sqrt(d2);
        const force = (1 - d / r) * speedLimit * 0.85;
        sepX += (dx / d) * force;
        sepY += (dy / d) * force * 0.8;
        sepZ += (dz / d) * force;
      }
    }
    desiredVel.x += sepX;
    desiredVel.y += sepY;
    desiredVel.z += sepZ;

    const dv = this.tmpVec2.copy(desiredVel).sub(ship.velocity);
    const maxDelta = ship.spec.length > 30 ? ship.spec.length * 0.3 * dt : (ship.type === 'courier' || ship.type === 'patrol' ? 34 : 15) * dt;
    const maxDeltaCap = Math.max(maxDelta, ship.spec.length > 30 ? 0.65 * dt : 0.38 * dt);
    if (dv.lengthSq() > maxDeltaCap * maxDeltaCap) {
      const f = maxDeltaCap / dv.length();
      dv.multiplyScalar(f);
    }
    ship.velocity.add(dv);
    const cap = speedLimit * 1.12;
    if (ship.velocity.lengthSq() > cap * cap) ship.velocity.setLength(cap);
    pos.addScaledVector(ship.velocity, dt);

    // simulate gentle inertial overshoot at low speed instead of snapping to zero
    if (desiredSpeed < 0.25 && ship.velocity.lengthSq() < 0.4) ship.velocity.set(0, 0, 0);

    const forward = dist > 2.2 ? dir : ship.velocity;
    if (forward.lengthSq() > 0.0001) {
      const targetQ = quatFromForward(forward);
      const turn = 1 - Math.exp(-(ship.type === 'capital' ? 0.55 : ship.type === 'drone' ? 3.7 : 2.6) * dt);
      ship.orientation.slerp(targetQ, turn);
      this.updateBanking(ship, targetQ, dt);
    }
    ship.group.quaternion.copy(ship.orientation);
    return dist;
  }

  coast(ship, dt, strength = 1.2) {
    ship.velocity.multiplyScalar(Math.exp(-strength * dt));
    ship.group.position.addScaledVector(ship.velocity, dt);
    if (ship.velocity.lengthSq() > 0.01) {
      const targetQ = quatFromForward(ship.velocity);
      ship.orientation.slerp(targetQ, 1 - Math.exp(-1.4 * dt));
    }
    this.updateBanking(ship, ship.orientation, dt);
    ship.group.quaternion.copy(ship.orientation);
  }

  orientTo(ship, forward, dt, speed = 1.5) {
    const targetQ = quatFromForward(forward);
    ship.orientation.slerp(targetQ, 1 - Math.exp(-speed * dt));
    ship.group.quaternion.copy(ship.orientation);
  }

  updateBanking(ship, desiredQ, dt) {
    const currentForward = new THREE.Vector3(0, 0, 1).applyQuaternion(ship.orientation);
    const targetForward = new THREE.Vector3(0, 0, 1).applyQuaternion(desiredQ);
    const cross = new THREE.Vector3().crossVectors(currentForward, targetForward);
    const horizontalTurn = cross.y;
    const demand = clamp(Math.abs(horizontalTurn) * 2.4, 0, 1);
    ship.turnDemand = damp(ship.turnDemand, demand, 5, dt);
    const targetBank = clamp(horizontalTurn * 2.6, -0.52, 0.52) * (ship.type === 'capital' ? 0.4 : 1);
    ship.bank = damp(ship.bank, targetBank, 2.2, dt);
    const qBank = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, ship.bank);
    ship.group.quaternion.copy(ship.orientation).multiply(qBank);
  }

  dampToBerth(ship, dock, dt) {
    if (!dock) return;
    ship.group.position.lerp(dock.berth, 1 - Math.exp(-3.3 * dt));
    const q = quatFromForward(dock.outward.clone().negate());
    ship.orientation.slerp(q, 1 - Math.exp(-2.6 * dt));
    ship.group.quaternion.copy(ship.orientation);
    ship.bank = damp(ship.bank, 0, 3, dt);
    ship.velocity.multiplyScalar(0.8);
  }

  setThrottleForTravel(ship, value) {
    ship.throttle = damp(ship.throttle, value, 1.8, 1 / 60);
    ship.throttleTarget = value;
  }

  finishMissionBookkeeping(ship) {
    if (!ship.mission.target) ship.mission.target = ship.group.position.clone();
    ship.eta = Math.max(0, ship.eta || 0);
    if (ship.mission.progress === undefined) ship.mission.progress = 0;
    ship.progress = ship.mission.progress;
    ship.phase = ship.mission.phase;
    if (ship.phase === 'INBOUND' || ship.phase === 'OUTBOUND' || ship.phase === 'PATROL') {
      // handled by state tasks; kept for information panel
    }
  }

  emitDockParticles(ship, dock, dt, time, ore) {
    if (!this.effectsEnabled) return;
    ship.dockAcc = (ship.dockAcc || 0) + dt * (ore ? 16 : 9);
    while (ship.dockAcc > 1) {
      ship.dockAcc -= 1;
      const p = dock.pad.clone().add(new THREE.Vector3((Math.random() - 0.5) * 9, 1, (Math.random() - 0.5) * 9));
      const v = new THREE.Vector3((Math.random() - 0.5) * 4, 2 + Math.random() * 5, (Math.random() - 0.5) * 4);
      this.particleField.spawn(p, v, ore ? 0xffa352 : 0x85dbff, 0.8, 0.8, 0.55, 0.4);
    }
  }

  /* ---------------------------- animation ------------------------- */

  animateShip(ship, dt, time, camera) {
    if (!ship.group.visible) {
      ship.group.visible = false;
      ship.trail.mesh.visible = false;
      return;
    }
    ship.group.quaternion.copy(ship.orientation);
    // apply the bank after orientation has settled
    const qBank = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, ship.bank);
    ship.group.quaternion.multiply(qBank);

    const throttleTarget = ship.throttleTarget ?? ship.throttle ?? 0.4;
    ship.engineRig.update(throttleTarget, dt, true);
    const throttle = ship.engineRig.getThrottle();

    // distance-based level of detail: tiny details vanish before the hull does
    const camDist = camera.position.distanceTo(ship.group.position);
    const navDetail = camDist < 980;
    ship.thrusters.visible = camDist < 900;
    for (const eng of ship.engineRig.engines) {
      eng.halo.visible = ship.type === 'capital' || camDist < 760;
    }

    // exhaust trail is drawn from the centre of the engine cluster
    ship.group.updateMatrixWorld();
    const engineWorld = ship.group.localToWorld(ship.engineRig.center.clone().add(new THREE.Vector3(0, 0, -0.5)));
    if (ship.velocity.length() > 0.45 && !ship.hidden && ship.densityVisible) {
      ship.trail.addPoint(engineWorld, time, throttle);
    }
    ship.trail.update(camera.position, time);
    ship.trail.mesh.visible = ship.visible && ship.densityVisible && !ship.hidden && ship.trail.points.length > 1;

    // thruster flash when turning, docking or holding
    const approaching = ship.mission.state.toLowerCase().includes('approach');
    const maneuvering = clamp(ship.turnDemand * 2.2, 0, 1) + (approaching ? 0.3 : 0);
    const blink = 0.65 + Math.sin(time * 9 + ship.index) * 0.2;
    ship.thrusters.material.opacity = clamp(maneuvering * blink, 0, 0.92);
    ship.thrusters.material.size = (ship.type === 'capital' ? 3.5 : ship.type === 'drone' ? 0.42 : Math.max(0.6, ship.spec.length * 0.07)) * (0.7 + maneuvering * 0.7);

    // navigation lights breathe independently
    const typeOffset = ship.index * 0.37;
    for (let i = 0; i < ship.navLights.length; i++) {
      const sprite = ship.navLights[i];
      sprite.visible = navDetail;
      if (!navDetail) continue;
      const strobe = i === 2 ? (Math.sin(time * 3.1 + typeOffset) > 0.81 ? 1 : 0.08) : (0.45 + Math.sin(time * 1.7 + typeOffset + i * 1.3) * 0.35 + 0.2);
      sprite.material.opacity = strobe;
      const s = (ship.type === 'capital' ? 2.5 : ship.type === 'drone' ? 0.45 : 0.9) * (0.6 + strobe * 0.6);
      sprite.scale.setScalar(s);
    }

    // engine exhaust particles
    if (this.effectsEnabled && !ship.hidden && ship.densityVisible && ship.velocity.lengthSq() > 0.5) {
      ship.exhaustAcc = (ship.exhaustAcc || 0) + dt * (4.0 + throttle * 18 + (ship.type === 'capital' ? 20 : 0));
      while (ship.exhaustAcc >= 1) {
        ship.exhaustAcc -= 1;
        const anchor = ship.engineRig.engines[(Math.random() * ship.engineRig.engines.length) | 0];
        const local = ship.engineRig.center.clone();
        local.x += (Math.random() - 0.5) * ship.spec.radius * 0.5;
        local.y += (Math.random() - 0.5) * ship.spec.radius * 0.24;
        local.z += -ship.spec.length * 0.03;
        const world = ship.group.localToWorld(local);
        const backward = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.group.quaternion);
        const vel = ship.velocity.clone().multiplyScalar(0.34)
          .addScaledVector(backward, (5 + throttle * 22) * (ship.type === 'capital' ? 1.3 : 0.75))
          .add(new THREE.Vector3((Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 1.4));
        const size = (ship.type === 'capital' ? 2.5 : Math.max(0.4, ship.spec.length * 0.035)) * (0.7 + Math.random() * 0.7);
        this.particleField.spawn(world, vel, ship.engineRig.palette.trail, size, 0.4 + Math.random() * 0.8, 0.65, 1.9);
      }
    }

  }

  updateSelection(time, camera) {
    const sel = this.ships.find((s) => s.selected);
    if (sel) {
      this.selectionIndicator.group.visible = true;
      this.selectionIndicator.group.position.copy(sel.group.position);
      const baseScale = Math.max(sel.spec.radius * 0.72, sel.spec.length * 0.28, 4.5);
      this.selectionIndicator.group.userData.baseScale = baseScale;
      const pulse = 1 + Math.sin(time * 2.5) * 0.025;
      this.selectionIndicator.group.scale.setScalar(baseScale * pulse);
      this.selectionIndicator.update(time, camera);
    } else {
      this.selectionIndicator.group.visible = false;
    }
  }

  select(ship) {
    if (this.selection === ship) return;
    if (this.selection) this.selection.selected = false;
    this.selection = ship;
    if (ship) {
      ship.selected = true;
      this.selectionIndicator.group.visible = true;
      this.selectionIndicator.group.position.copy(ship.group.position);
      const baseScale = Math.max(ship.spec.radius * 0.72, ship.spec.length * 0.28, 4.5);
      this.selectionIndicator.group.scale.setScalar(baseScale);
      this.selectionIndicator.group.userData.baseScale = baseScale;
    } else {
      this.selectionIndicator.group.visible = false;
    }
  }

  /* ------------------------- picking helpers ---------------------- */

  getPickables() {
    const list = [];
    for (const ship of this.ships) {
      if (ship.visible && ship.densityVisible && !ship.hidden) list.push(ship.pick);
    }
    return list;
  }

  pick(ndc, camera) {
    this.raycaster.setFromCamera(ndc, camera);
    const intersects = this.raycaster.intersectObjects(this.getPickables(), false);
    if (!intersects.length) return null;
    const id = intersects[0].object.userData.shipId;
    return this.byId.get(id) || null;
  }

  registerById() {
    this.byId.clear();
    for (const ship of this.ships) this.byId.set(ship.id, ship);
  }

  countDocked() {
    return DOCKS.filter((d) => d.occupied).length;
  }
}
