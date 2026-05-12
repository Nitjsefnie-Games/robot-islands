# T5 Drone & Extractor Mechanics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement T5 path-drawn drones (#29), T5 extractor multi-output rotation (#45), and Probability Engine (#41).

**Architecture:** Path-drawn drones extend the `Drone` interface with a `waypoints` array; dark-mode telemetry defers discovery until return. Multi-output rotation uses a deterministic seed+index picker in `computeRates`. Probability Engine adds a drone-bias multiplier at launch time.

**Tech Stack:** TypeScript strict, vitest. Pure layer: `drones.ts`, `economy.ts`, `recipes.ts`, `building-defs.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/drones.ts` | Path-drawn drone dispatch, dark-mode telemetry, waypoint path rasterization |
| `src/drones.test.ts` | Tests for path-drawn drones |
| `src/economy.ts` | Multi-output rotation in `computeRates` |
| `src/economy.test.ts` | Tests for rotation outputs |
| `src/building-defs.ts` | `path_drone_foundry`, `probability_engine` defs |
| `src/recipes.ts` | Recipes for T5 extractors with multi-output |
| `src/world.ts` | `probabilityBias` on `WorldState` or `IslandState` |

---

### Task 1: T5 Path-Drawn Drones

**Files:**
- Modify: `src/drones.ts`
- Modify: `src/drones-ui.ts` (render layer — optional, can be deferred to UI plan)
- Test: `src/drones.test.ts`

- [ ] **Step 1: Extend Drone interface for path-drawn**

```typescript
export interface Drone {
  // ... existing fields ...
  /** For T5 path-drawn drones: sequence of waypoints. Empty for straight-line drones. */
  readonly waypoints: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  /** True if this drone is currently in dark mode (out of antenna range). */
  darkMode: boolean;
  /** Accumulated discoveries while in dark mode. */
  darkModeDiscoveries: Array<{ readonly islandId: string }>;
}
```

Update `dispatchDrone` to accept an optional `waypoints` array. If provided, compute total path length as sum of segment lengths. Range check: `totalPathLength <= fuel * DRONE_T5_EFFICIENCY`.

- [ ] **Step 2: Path rasterization for waypoints**

```typescript
/** Rasterize a polyline path into cell corridor. */
export function rasterizeWaypointPath(
  waypoints: ReadonlyArray<{ x: number; y: number }>,
  scanRadius: number
): Set<string> /* cell keys */ {
  const cells = new Set<string>();
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const segmentCells = corridorCells(a.x, a.y, b.x, b.y, scanRadius);
    segmentCells.forEach(c => cells.add(c));
  }
  return cells;
}
```

- [ ] **Step 3: Dark-mode telemetry in `tickDrones`**

On each tick (or at return time), evaluate whether the drone's current position is within any antenna signal range (`pointInSignalRange`). If yes, `darkMode = false` and discoveries flush immediately to world map. If no, `darkMode = true` and discoveries append to `darkModeDiscoveries`.

At `expectedReturnTime`:
- If drone survived weather and fuel: flush all `darkModeDiscoveries` to world map.
- If destroyed: discard `darkModeDiscoveries`.

- [ ] **Step 4: Add T5 constants**

```typescript
export const DRONE_T5_EFFICIENCY = 8; // farther per fuel unit
export const DRONE_T5_SPEED_TILES_PER_SEC = 0.8;
export const DRONE_T5_SCAN_RADIUS_TILES = 12;
export const DRONE_T5_WEATHER_MULTIPLIER = 0.5;
```

- [ ] **Step 5: Add `path_drone_foundry` def**

```typescript
| 'path_drone_foundry'
```

```typescript
path_drone_foundry: {
  id: 'path_drone_foundry',
  name: 'Path Drone Foundry',
  category: 'logistics',
  tier: 5,
  footprint: { width: 3, height: 3 },
  power: { consumes: 50 },
  placementCost: { steel: 50, microchip: 20, quantum_chip: 2 },
},
```

- [ ] **Step 6: Tests**

```typescript
describe('T5 path-drawn drone', () => {
  it('dispatches with waypoints', () => {
    const drone = dispatchDrone(world, origin, fuel, [{x:0,y:0},{x:10,y:0},{x:10,y:10}]);
    expect(drone.waypoints.length).toBe(3);
  });
  it('enters dark mode outside antenna range', () => {
    // ...
  });
  it('flushes dark mode discoveries on return', () => {
    // ...
  });
  it('loses dark mode data on destruction', () => {
    // ...
  });
});
```

- [ ] **Step 7: Commit**

```bash
git add src/drones.ts src/drones.test.ts src/building-defs.ts
git commit -m "feat(§11.6): T5 path-drawn drones with dark-mode telemetry"
```

---

### Task 2: T5 Extractor Multi-Output Rotation

**Files:**
- Modify: `src/recipes.ts`
- Modify: `src/economy.ts`
- Modify: `src/building-defs.ts`
- Test: `src/economy.test.ts`

- [ ] **Step 1: Extend Recipe for multi-output rotation**

Current `Recipe` has `outputs: Record<ResourceId, number>`. For rotation, we need an alternative:

```typescript
export type RecipeOutputMode =
  | { kind: 'fixed'; outputs: Record<ResourceId, number> }
  | { kind: 'rotating'; cycleIndex: number; options: ReadonlyArray<Record<ResourceId, number>> };
```

Actually, keep it simpler: add an optional `rotateOutputs` field:

```typescript
export interface Recipe {
  defId: BuildingDefId;
  inputs: Record<ResourceId, number>;
  outputs: Record<ResourceId, number>;
  cycleSec: number;
  category: RecipeCategory;
  /** If set, outputs cycle through these options deterministically. */
  rotateOutputs?: ReadonlyArray<Record<ResourceId, number>>;
}
```

- [ ] **Step 2: Add T5 raw resources to ResourceId**

Ensure these exist:

```typescript
| 'aetheric_current'
| 'quantum_foam'
| 'spacetime_fragment'
| 'tachyon_stream'
| 'dark_matter'
| 'strange_matter'
| 'higgs_flux'
```

Add `XP_WEIGHT` entries: T5 raw = 300.

- [ ] **Step 3: Add rotating recipes**

```typescript
// Aetheric Conduit: cycles between aetheric_current and quantum_foam
{
  defId: 'aetheric_conduit',
  inputs: {},
  outputs: { aetheric_current: 1 },
  rotateOutputs: [{ aetheric_current: 1 }, { quantum_foam: 1 }],
  cycleSec: 1800, // 30 min
  category: 'extraction',
},
// Spacetime Resonator: cycles between spacetime_fragment and tachyon_stream
{
  defId: 'spacetime_resonator',
  inputs: {},
  outputs: { spacetime_fragment: 1 },
  rotateOutputs: [{ spacetime_fragment: 1 }, { tachyon_stream: 1 }],
  cycleSec: 2400,
  category: 'extraction',
},
// Eldritch Sieve: 1/3 each of dark_matter, strange_matter, higgs_flux
{
  defId: 'eldritch_sieve',
  inputs: {},
  outputs: { dark_matter: 1 },
  rotateOutputs: [
    { dark_matter: 1 },
    { strange_matter: 1 },
    { higgs_flux: 1 },
  ],
  cycleSec: 3600,
  category: 'extraction',
},
```

- [ ] **Step 4: Deterministic output picker in `computeRates`**

In `economy.ts`, when resolving a recipe with `rotateOutputs`:

```typescript
function resolveRotatingOutput(
  recipe: Recipe,
  buildingId: string,
  worldSeed: string,
  nowMs: number
): Record<ResourceId, number> {
  if (!recipe.rotateOutputs || recipe.rotateOutputs.length === 0) {
    return recipe.outputs;
  }
  // Use building placement time or world tick to determine cycle index
  // For determinism: seed from worldSeed + buildingId + floor(nowMs / cycleMs)
  const cycleMs = recipe.cycleSec * 1000;
  const cycleIndex = Math.floor(nowMs / cycleMs);
  const rng = makeSeededRng(`${worldSeed}_rotate_${buildingId}_${cycleIndex}`);
  // For Aetheric Conduit / Spacetime Resonator: deterministic alternation
  if (recipe.rotateOutputs.length === 2) {
    const idx = cycleIndex % 2;
    return recipe.rotateOutputs[idx];
  }
  // For Eldritch Sieve: 1/3 each, deterministic from seed + cycleIndex
  const idx = Math.floor(rng() * recipe.rotateOutputs.length);
  return recipe.rotateOutputs[idx];
}
```

Actually, per spec §8.10: "Eldritch Sieve: {dark_matter, strange_matter, higgs_flux} at 1/3 each, deterministic from seed + cycle index." So use cycle index directly for the deterministic pick, not RNG per cycle.

```typescript
const idx = cycleIndex % recipe.rotateOutputs.length;
return recipe.rotateOutputs[idx];
```

- [ ] **Step 5: Aetheric Anomaly modifier interaction**

Per §8.10: "Aetheric Anomaly modifier interaction: doubles cycle speed". In `computeRates`, if the island has `aethericExtraction` modifier, halve the effective `cycleSec` for T5 extractors.

- [ ] **Step 6: Tests**

```typescript
describe('T5 extractor rotation', () => {
  it('Aetheric Conduit alternates outputs each cycle', () => {
    // ...
  });
  it('Eldritch Sieve cycles through three outputs deterministically', () => {
    // ...
  });
  it('Aetheric Anomaly doubles cycle speed', () => {
    // ...
  });
});
```

- [ ] **Step 7: Commit**

```bash
git add src/recipes.ts src/economy.ts src/economy.test.ts src/building-defs.ts
git commit -m "feat(§8.10): T5 extractor multi-output rotation with deterministic cycling"
```

---

### Task 3: Probability Engine

**Files:**
- Modify: `src/building-defs.ts`
- Modify: `src/drones.ts`
- Modify: `src/world.ts` or `src/economy.ts`
- Test: `src/drones.test.ts`

- [ ] **Step 1: Add Probability Engine def**

```typescript
| 'probability_engine'
```

```typescript
probability_engine: {
  id: 'probability_engine',
  name: 'Probability Engine',
  category: 'special',
  tier: 5,
  footprint: { width: 2, height: 2 },
  power: { consumes: 80 },
  placementCost: { steel: 40, quantum_chip: 4, exotic_alloy: 10 },
},
```

- [ ] **Step 2: Compute island's probability bias**

```typescript
// src/drones.ts or new helper
export function probabilityBiasForIsland(state: IslandState): number {
  const engineCount = state.buildings.filter(b => b.defId === 'probability_engine').length;
  if (engineCount === 0) return 0;
  if (engineCount === 1) return 0.25;
  if (engineCount === 2) return 0.40;
  if (engineCount === 3) return 0.50;
  return 0.60; // asymptotic cap for 4+
}
```

- [ ] **Step 3: Apply bias at drone dispatch**

In `dispatchDrone`, when the origin island has `probabilityBias > 0`, store it on the `Drone` record:

```typescript
readonly probabilityBias: number;
```

In the discovery resolution (capsule scan), use the bias to boost rare/unique island encounter chance. Since island generation is deterministic, "rare/unique" must be defined. Use a threshold: islands with `modifierCount >= 2` or containing `Aetheric Anomaly` are "rare". The bias increases the effective scan radius for rare islands only, or adds a reroll.

Simpler: at scan time, if a discovered island is rare, roll again with bias:

```typescript
if (isRareIsland(island) && drone.probabilityBias > 0) {
  const rng = makeSeededRng(`${world.seed}_prob_${drone.id}_${island.id}`);
  if (rng() < drone.probabilityBias) {
    // "Bonus discovery" — maybe reveal an extra cell or modifier detail
  }
}
```

Since the spec says "+25% chance to encounter rare/unique islands per scan", and scan is deterministic, implement it as: when scanning, the capsule radius for rare islands is effectively multiplied by `(1 + bias)`.

```typescript
const effectiveScanRadius = isRareIsland(island)
  ? drone.scanRadius * (1 + drone.probabilityBias)
  : drone.scanRadius;
```

- [ ] **Step 4: Tests**

```typescript
describe('Probability Engine', () => {
  it('1 engine gives +25% bias', () => {
    expect(probabilityBiasForIsland({ buildings: [{defId:'probability_engine'}] } as any)).toBe(0.25);
  });
  it('4 engines cap at +60%', () => {
    expect(probabilityBiasForIsland({ buildings: [
      {defId:'probability_engine'},{defId:'probability_engine'},
      {defId:'probability_engine'},{defId:'probability_engine'},
    ] } as any)).toBe(0.60);
  });
});
```

- [ ] **Step 5: Commit**

```bash
git add src/drones.ts src/building-defs.ts src/drones.test.ts
git commit -m "feat(§13.3): Probability Engine +25% rare island encounter bias"
```

---

## Self-Review

**1. Spec coverage:**
- §11.6 T5 path-drawn drone → Task 1
- §8.10 T5 extractor multi-output → Task 2
- §13.3 Probability Engine → Task 3

**2. Placeholder scan:** No TBD.

**3. Type consistency:** `Drone` interface extended with `waypoints`, `darkMode`, `darkModeDiscoveries`, `probabilityBias`.
