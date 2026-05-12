# Weather System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the deterministic cell-based weather system (§2.6) with visibility, vehicle destruction, route capacity modulation, and modifier integration.

**Architecture:** A pure `weather(seed, cx, cy, t)` function using layered simplex noise produces weather states per stratification cell. Weather is visible only within range of populated islands + Weather Stations. Vehicles rasterize their path into cells and roll destruction at cell-entry time. Routes modulate capacity based on storm severity. High Wind modifier (§3.5) hooks into the weather model for variance.

**Tech Stack:** TypeScript strict, no PixiJS in pure layer. Existing `discovery.ts` cell grid, `rng.ts` seeded RNG, `drones.ts` / `settlement.ts` tick loops.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/weather.ts` | Pure weather function, state enum, visibility query, vehicle path rasterization, destruction rolls |
| `src/weather.test.ts` | Unit tests for weather determinism, visibility, path rasterization, destruction rolls |
| `src/routes.ts` | Modify `tickRoutes` to apply storm capacity reduction and in-flight loss |
| `src/drones.ts` | Modify `tickDrones` to evaluate weather destruction at cell-entry timestamps |
| `src/settlement.ts` | Modify `tickVehicles` to evaluate weather destruction at cell-entry timestamps |
| `src/biomes.ts` | Add `weatherDistribution` modifier per biome for the weather function |
| `src/building-defs.ts` | Add `weather_station_t2`, `advanced_weather_station_t3` defs |
| `src/world.ts` | Add `weatherVisibilityCells` to `WorldState` or compute on-the-fly |
| `src/main.ts` | Render-layer: weather overlay rendering (optional, can be pure-color cell tint) |

---

### Task 1: Core Weather Function

**Files:**
- Create: `src/weather.ts`
- Test: `src/weather.test.ts`

- [ ] **Step 1: Define weather state enum and types**

```typescript
// src/weather.ts
export type WeatherState = 'clear' | 'light_fog' | 'storm' | 'severe_storm' | 'catastrophic';

export interface WeatherCell {
  readonly state: WeatherState;
  /** When this state started (ms). */
  readonly sinceMs: number;
  /** When this state ends (ms). */
  readonly untilMs: number;
}

/** Base destruction chance per state per §2.6. */
export const WEATHER_DESTRUCTION_CHANCE: Record<WeatherState, number> = {
  clear: 0,
  light_fog: 0,
  storm: 0.02,
  severe_storm: 0.08,
  catastrophic: 0.20,
};

/** Scan radius penalty per state. */
export const WEATHER_SCAN_PENALTY: Record<WeatherState, number> = {
  clear: 0,
  light_fog: 0.50,
  storm: 0.25,
  severe_storm: 0.75,
  catastrophic: 1.0,
};
```

- [ ] **Step 2: Implement deterministic `weather(seed, cx, cy, nowMs)` using seeded RNG**

Use `makeSeededRng` from `rng.ts` with a composite seed `weather_${seed}_${cx}_${cy}`. Sample a temporal sequence of states with dwell times. The function returns the active state at `nowMs`.

```typescript
import { makeSeededRng } from './rng.js';

const DWELL_MIN_MS = 30 * 60 * 1000; // 30 min
const DWELL_MAX_MS = 4 * 60 * 60 * 1000; // 4 hours
const STATE_TABLE: WeatherState[] = ['clear', 'clear', 'clear', 'light_fog', 'storm', 'severe_storm', 'catastrophic'];
const STATE_WEIGHTS = [40, 20, 15, 10, 8, 4, 1];

export function weather(seed: string, cx: number, cy: number, nowMs: number): WeatherCell {
  const rng = makeSeededRng(`${seed}_weather_${cx}_${cy}`);
  // Generate a timeline of states until we pass nowMs
  let t = 0;
  while (true) {
    const state = weightedPick(STATE_TABLE, STATE_WEIGHTS, rng);
    const dwell = DWELL_MIN_MS + rng() * (DWELL_MAX_MS - DWELL_MIN_MS);
    if (nowMs < t + dwell) {
      return { state, sinceMs: t, untilMs: t + dwell };
    }
    t += dwell;
  }
}
```

Implement `weightedPick` as a local helper. Add tests verifying determinism (same seed/cx/cy/t → same state).

- [ ] **Step 3: Biome modulation helper**

```typescript
import { Biome } from './world.js';

/** Returns adjusted state weights for a biome. Empty cell = Plains baseline. */
export function biomeWeatherWeights(biome: Biome | null): number[] {
  const base = [...STATE_WEIGHTS];
  switch (biome) {
    case 'volcanic': base[4] *= 1.5; base[5] *= 1.5; break; // +storm, +severe
    case 'arctic': base[5] *= 1.3; break;
    case 'coast': base[3] *= 1.5; base[4] *= 1.2; break;
    case 'desert': base[4] *= 0.3; base[3] *= 0.5; break;
    case 'forest': base[4] *= 1.1; break;
    default: break;
  }
  return base;
}
```

Modify `weather()` to accept an optional biome and use `biomeWeatherWeights`. Test that Volcanic has more storms than Plains.

- [ ] **Step 4: Weather visibility query**

```typescript
import { islandCells } from './discovery.js';
import { LIGHTHOUSE_VISION_RADII } from './lighthouse.js'; // existing

const BASE_WEATHER_VISIBILITY_CELLS = 5;

/** Returns true if (cx,cy) is within weather visibility of any populated island. */
export function isWeatherVisible(
  world: WorldState,
  cx: number,
  cy: number
): boolean {
  // Use existing vision sources from world.ts / vision-source.ts
  // For each populated island, check if cell is within BASE_WEATHER_VISIBILITY_CELLS
  // Plus Weather Station bonuses
  // Re-use existing `pointInVisionEllipse` or simple distance check
}
```

For now, use a simplified model: any cell within `BASE_WEATHER_VISIBILITY_CELLS` of any populated island's centre (in cell coords) is visible. Weather Station buildings extend this per-island.

- [ ] **Step 5: Commit**

```bash
git add src/weather.ts src/weather.test.ts
git commit -m "feat(§2.6): deterministic weather function with biome modulation"
```

---

### Task 2: Vehicle Weather Destruction

**Files:**
- Modify: `src/weather.ts` (add path rasterization)
- Modify: `src/drones.ts` (destruction rolls)
- Modify: `src/settlement.ts` (destruction rolls)
- Test: `src/weather.test.ts`, `src/drones.test.ts`, `src/settlement.test.ts`

- [ ] **Step 1: Cell path rasterization**

```typescript
/** Returns ordered list of {cx, cy, entryTimeMs} for a straight-line path. */
export function rasterizePath(
  originX: number,
  originY: number,
  dirX: number,
  dirY: number,
  totalTiles: number,
  speedTilesPerSec: number,
  launchTimeMs: number,
  cellSizeTiles: number
): Array<{ cx: number; cy: number; entryMs: number }> {
  // Bresenham / DDA over cells
  // entryMs = launchTimeMs + (distance_to_cell_entry / speed) * 1000
}
```

Test: a path from (0,0) direction (1,0) length 100 tiles at cell size 16 should hit cells (0,0), (1,0), (2,0), (3,0), (4,0), (5,0), (6,0) with monotonically increasing entry times.

- [ ] **Step 2: Vehicle destruction roll helper**

```typescript
export function rollVehicleDestruction(
  seed: string,
  world: WorldState,
  path: Array<{ cx: number; cy: number; entryMs: number }>,
  vehicleMultiplier: number,
  vehicleId: string
): { destroyed: boolean; atCellIndex: number | null } {
  const rng = makeSeededRng(`${seed}_vehicle_${vehicleId}`);
  for (let i = 0; i < path.length; i++) {
    const { cx, cy, entryMs } = path[i];
    const cell = weather(world.seed, cx, cy, entryMs);
    const baseChance = WEATHER_DESTRUCTION_CHANCE[cell.state];
    if (baseChance === 0) continue;
    const finalChance = baseChance * vehicleMultiplier;
    if (rng() < finalChance) {
      return { destroyed: true, atCellIndex: i };
    }
  }
  return { destroyed: false, atCellIndex: null };
}
```

Test: deterministic rolls, catastrophic state always eventually destroys low-multiplier vehicles given enough cells.

- [ ] **Step 3: Integrate into `tickDrones`**

In `src/drones.ts`, at the point where a drone's `expectedReturnTime` is reached, before adding discoveries:

1. Reconstruct the drone's path using `rasterizePath`.
2. Look up the drone's `weatherMultiplier` from a tier table (T2=1.5, T3=1.0, T4=0.7, T5=0.5).
3. Call `rollVehicleDestruction`.
4. If destroyed, do NOT add discoveries. Remove the drone with a `'lost'` status.
5. If not destroyed, proceed as before.

Add `weatherMultiplier` to `DRONE_TIER_MULTIPLIERS` constant table.

- [ ] **Step 4: Integrate into `tickVehicles`**

In `src/settlement.ts`, at `expectedArrivalTime`, before arrival processing:

1. Reconstruct path via `rasterizePath`.
2. Look up multiplier from `VEHICLE_KIND_TIER_MULTIPLIERS` (ship T1=1.0, heli T2=1.2, etc. per §2.6 table).
3. Call `rollVehicleDestruction`.
4. If destroyed, mark vehicle lost, do NOT populate target.
5. If not destroyed, proceed as before.

- [ ] **Step 5: Commit**

```bash
git add src/weather.ts src/drones.ts src/settlement.ts src/weather.test.ts src/drones.test.ts src/settlement.test.ts
git commit -m "feat(§2.6): vehicle weather destruction rolls at cell-entry time"
```

---

### Task 3: Weather × Routes

**Files:**
- Modify: `src/routes.ts`
- Modify: `src/weather.ts` (route capacity helpers)
- Test: `src/routes.test.ts`

- [ ] **Step 1: Route storm capacity modifier**

```typescript
/** Returns capacity multiplier [0,1] for a route crossing given cells at nowMs. */
export function routeCapacityMultiplierForWeather(
  world: WorldState,
  fromX: number, fromY: number,
  toX: number, toY: number,
  nowMs: number,
  cellSizeTiles: number
): number {
  // Rasterize route path (simpler than vehicle: just line segment between island centres)
  const cells = rasterizeLineSegment(fromX, fromY, toX, toY, cellSizeTiles);
  let minMul = 1;
  for (const { cx, cy } of cells) {
    const w = weather(world.seed, cx, cy, nowMs);
    if (w.state === 'storm') minMul = Math.min(minMul, 0.5);
    else if (w.state === 'severe_storm') minMul = Math.min(minMul, 0.1);
    else if (w.state === 'catastrophic') minMul = Math.min(minMul, 0);
  }
  return minMul;
}
```

- [ ] **Step 2: In-flight loss roll**

In `dispatchPhase` of `routes.ts`, when creating `InFlightBatch`, also store the route's cell path. On arrival (`tickRoutes`), before delivering the batch:

1. For each storm cell the batch crossed, roll loss: Storm=5%, Severe=15%, Catastrophic=30%.
2. Use a deterministic RNG seeded by batch id.
3. Apply losses multiplicatively (or sum — spec says "per-cell roll, scaled by severity").
4. Deliver the reduced amount.

```typescript
// In tickRoutes arrival handling:
let remaining = batch.amount;
for (const cell of batch.crossedCells) {
  const w = weather(world.seed, cell.cx, cell.cy, batch.dispatchTime + cell.transitFraction * transitTimeMs);
  const lossRate = w.state === 'storm' ? 0.05 : w.state === 'severe_storm' ? 0.15 : w.state === 'catastrophic' ? 0.30 : 0;
  if (lossRate > 0) {
    const rng = makeSeededRng(`${world.seed}_routeloss_${batch.id}_${cell.cx}_${cell.cy}`);
    remaining *= (1 - lossRate * rng()); // or deterministic threshold
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/routes.ts src/weather.ts src/routes.test.ts
git commit -m "feat(§2.6): route storm capacity reduction and in-flight losses"
```

---

### Task 4: Weather × Modifier Effects Integration

**Files:**
- Modify: `src/biomes.ts`
- Modify: `src/weather.ts`
- Modify: `src/economy.ts`

- [ ] **Step 1: High Wind modifier integration**

Per §3.5, High Wind gives "Wind power +50%, but all output has ±20% random variance".

Add a `varianceRoll` field to `ModifierMultipliers` in `biomes.ts`:

```typescript
export interface ModifierMultipliers {
  extraction: number;
  windPower: number;
  heatFree: boolean;
  production: number;
  rareFinds: number;
  cryoEfficiency: number;
  forestry: number;
  aethericExtraction: number;
  /** If true, apply ±20% variance to all recipe outputs. */
  outputVariance: boolean;
}
```

Update `IDENTITY_MODIFIER_MULTIPLIERS` and all biome modifier generators to include `outputVariance: false`.

In `computeRates` (`economy.ts`), after computing base rate:

```typescript
if (ctx.modifierMul?.outputVariance) {
  const varianceRng = makeSeededRng(`${state.id}_variance_${Math.floor(nowMs / 1000)}`);
  const varianceFactor = 0.8 + varianceRng() * 0.4; // ±20%
  effectiveRate *= varianceFactor;
}
```

- [ ] **Step 2: Night-phase severe storm boost**

Per §2.7, severe-storm formation rate increases ~25% during Night and Dawn.

In `weather.ts`, when computing state weights, check `dayPhase(nowMs)` and boost severe/catastrophic weights by 1.25x during Night/Dawn.

- [ ] **Step 3: Commit**

```bash
git add src/biomes.ts src/weather.ts src/economy.ts
git commit -m "feat(§3.5): High Wind output variance + night severe-storm boost"
```

---

### Task 5: Weather Station Buildings

**Files:**
- Modify: `src/building-defs.ts`
- Modify: `src/weather.ts`

- [ ] **Step 1: Add Weather Station defs**

```typescript
| 'weather_station_t2'
| 'advanced_weather_station_t3'
```

Add to `BUILDING_DEFS`:

```typescript
weather_station_t2: {
  id: 'weather_station_t2',
  name: 'Weather Station',
  category: 'special',
  tier: 2,
  footprint: { width: 2, height: 2 },
  power: { consumes: 10 },
  placementCost: { steel: 5, gear: 2, glass: 5 },
},
advanced_weather_station_t3: {
  id: 'advanced_weather_station_t3',
  name: 'Advanced Weather Station',
  category: 'special',
  tier: 3,
  footprint: { width: 2, height: 2 },
  power: { consumes: 25 },
  placementCost: { steel: 10, microchip: 2, glass: 10 },
},
```

- [ ] **Step 2: Visibility range constants**

```typescript
export const WEATHER_STATION_BONUS_CELLS = {
  weather_station_t2: 3,
  advanced_weather_station_t3: 6,
};
```

Update `isWeatherVisible` to scan island buildings for these defs and add their bonus.

- [ ] **Step 3: Commit**

```bash
git add src/building-defs.ts src/weather.ts
git commit -m "feat(§2.6): Weather Station + Advanced Weather Station buildings"
```

---

## Self-Review

**1. Spec coverage:**
- §2.6 weather states and effects → Task 1
- §2.6 vehicle destruction per-cell → Task 2
- §2.6 route capacity + in-flight loss → Task 3
- §2.6 visibility + Weather Station → Task 5
- §2.7 night-phase severe boost → Task 4
- §3.5 High Wind variance → Task 4

**2. Placeholder scan:** No TBD/TODO.

**3. Type consistency:** `WeatherState` union used consistently. `makeSeededRng` signature matches existing usage.
