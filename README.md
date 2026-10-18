# Helios Station — Kepler Reach

**Live:** https://vesanieminen.github.io/Helios-Station/

A real-time orbital traffic simulation rendered with Three.js. It is a self-contained, procedural world: no external models, textures, or audio assets are required.

**Open it:** use the prebuilt single-file application at `dist/index.html` (it runs directly from disk in a Chromium-based browser), or run the development server below.

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite.

To regenerate the single-file build after changes:

```bash
npm run build
```

## What is in the simulation

- A 42-vessel traffic network with meaningful, repeating behavior:
  - heavy cargo freighters travel between two jump gates and three heavy berths, including holding patterns, docking, unloading, undocking, and jump transit;
  - couriers weave a relay circuit around the station and contend for express bays;
  - miners prospect specific rocks in the nearby field, cut with visible beams, collect ore, return to processing, and depart again;
  - two patrol flights maintain formations and periodically intercept the unregistered contact `UNK-7741`;
  - maintenance drones survey and weld themselves around the station's outer ring;
  - a capital dreadnought arrives through a violet jump aperture, holds at the outer anchorage with escorts, and eventually departs.
- A detailed procedural station with rotating radar and dish, solar arrays, refinery plant, cargo yard, beacons, berths, floodlights and emissive window fields.
- A procedural ocean/cloud/city-light planet, atmospheric scattering rim, moons, asteroid field, nebula, deep starfield and jump gates.
- Emission-driven propulsion: layered plumes, luminous engine cores, exhaust particles, fading ribbon trails, animated manoeuvring thrusters flickering under turns and docking, and oversized navigation lights.
- Post-processing with restrained bloom, ACES tone mapping, vignette, subtle chromatic aberration and film grain.

## Controls

| Input | Action |
| --- | --- |
| Drag | Orbit the camera |
| Scroll | Zoom |
| Click a vessel | Follow it; the vessel panel shows class, destination, task, speed and progress |
| `Overview` / `Station` / `Follow vessel` | Switch camera mode |
| `Pause` / `Space` | Pause / resume the simulation |
| `1×` `2×` `4×` | Simulation speed |
| `Traffic` | Cycle low / medium / high traffic density |
| `Routes` / `R` | Toggle the route and destination overlay |
| Cinematic button / `C` | Enter or leave cinematic mode (letterboxed, interface hidden) |
| `Esc` | Exit cinematic mode or release the followed vessel |
| `V` / `B` | Overview / station view |

## Technical notes

- One `TrafficSimulation` owns every vessel's deterministic mission state, steering, arrival behavior, dock arbitration and separation.
- Ship hulls are built once from procedural geometry, merged by material into a handful of meshes, and cloned. Asteroid instances are drawn with a single `InstancedMesh`.
- Engine exhaust is a pooled GPU point system. Trails are dynamically rebuilt camera-facing ribbons. Effects share geometry and are disposed when finished.
- The scene uses a fixed set of lights, distance-based detail reduction for small nav lights and engine halos, adaptive pixel ratio/bloom tiers, and a one-pass bloom composer.
- All textures — planetary survey, cloud field, night-side city lights, moon craters, nebula, engine glow, jump burst — are generated at runtime on canvas.

## Source layout

```
index.html          interface shell
src/main.js         renderer, camera director, cinematic sequence, UI wiring
src/simulation.js   fleet, missions, docking authority, steering
src/models.js       procedural ships, station, gates, asteroid field
src/planet.js       procedural planet survey and atmosphere
src/effects.js      engine rigs, trails, particles, jump effects, overlay
src/style.css       HUD styling and responsive rules
src/utils.js        deterministic RNG, noise, textures and helpers
```
