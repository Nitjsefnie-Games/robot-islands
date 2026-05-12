# Robot Islands — Handoff Resume Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume development from `HANDOFF.md` by shipping the five warm-up tasks (#19, #25, #17, #21, #28) in dependency order. Each task produces passing tests and a clean `npm run build`.

**Architecture:** Tackle trivial tasks first to warm up the codebase, then small/medium pure-layer fixes. No render-layer changes except where `main.ts` consumes new result shapes. All tasks are independent except that #21 and #28 touch more files.

**Tech Stack:** Vite 5 + TypeScript strict + PixiJS 8 + vitest. Pure layer = no PixiJS/DOM imports.

---

## File Structure (modified / created)

| File | Responsibility |
|---|---|
| `src/building-defs.ts` | Bump `dronepad.tier` (#19); add `requiredTile` to extractors (#21) |
| `src/building-defs.test.ts` | Update tier-gating assertions (#19) |
| `src/storage-categories.test.ts` | Verify `temp_sensitive` coverage (#25) |
| `src/economy.ts` | Fix funnel drain to net-of-local-production (#17); stall extractor rates on missing terrain (#21) |
| `src/economy.test.ts` | Funnel-provenance + tile-gating rate tests |
| `src/island.ts` | Add `oil_well`, `gas_seep`, `helium_vent` to `TerrainKind` (#21) |
| `src/biomes.ts` | Scatter new terrain kinds in appropriate biome `rareTerrain` lists (#21) |
| `src/biomes.test.ts` | Terrain-distribution spot checks for new kinds |
| `src/placement.ts` | Already enforces `requiredTile` — no changes needed (#21) |
| `src/settlement.ts` | Add deterministic mechanical-failure roll (#28) |
| `src/settlement.test.ts` | Failure-roll unit tests |
| `src/main.ts` | React to `vehicleResult.failures` if we expose them (#28) |

---

## Task 1: #19 — Drone Pad T1→T2

**Files:**
- Modify: `src/building-defs.ts:445`
- Modify: `src/building-defs.test.ts:341-343,354-363`

- [ ] **Step 1: Bump tier**

```typescript
// In src/building-defs.ts, dronepad def (~line 441)
  dronepad: {
    id: 'dronepad',
    displayName: 'Drone Pad',
    category: 'logistics',
    tier: 2,
    width: 1,
    height: 1,
    fill: 0x4a6b78,
    stroke: 0x14222a,
    placementCost: { stone: 25, wood: 15 },
    glyph: '⤴',
  },
```

Delete the old deferred-tier comment block (lines 437-440).

- [ ] **Step 2: Update tier-unlocking test comment**

In `src/building-defs.test.ts` inside `it('returns every T1 id at level 1', …)`:

```typescript
    // T1 defs in the catalog: mine, workshop, solar, coal_gen, dock,
    // logger, smelter, crate, silo, biomass_plant.
```

Remove the two `dronepad` comment lines.

- [ ] **Step 3: Assert dronepad unlocks at level 5 (T2)**

In `src/building-defs.test.ts` inside `it('returns T1 + T2 ids at level 5', …)`:

```typescript
    expect(list).toContain('dronepad');
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/building-defs.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/building-defs.ts src/building-defs.test.ts
git commit -m "feat: Drone Pad T1→T2 per SPEC §8.8"
```

---

## Task 2: #25 — Cold Storage consumers audit

**Files:**
- Modify: `src/storage-categories.test.ts:81-104`

Context: `cryo_coolant` is already tagged `temp_sensitive` in `src/storage-categories.ts:106`. The deferred resources (`cryogenic_compound`, `liquid_nitrogen`, plastics) do not yet exist in `src/recipes.ts`. This task is therefore an audit + comment update, not new resource addition.

- [ ] **Step 1: Harden the existing spot-check test**

In `src/storage-categories.test.ts` inside `it('§4.6 spot checks: …')`, add:

```typescript
    // Temp-sensitive — cryo_coolant is the sole live member until
    // cryogenic_compound / liquid_nitrogen / plastics are catalogued.
    expect(RESOURCE_STORAGE_CATEGORY.cryo_coolant).toBe('temp_sensitive');
```

- [ ] **Step 2: Update the count-test comment**

Replace the `it('every category has at least one assigned resource …')` body comment with:

```typescript
    // Sanity: each non-empty category in the spec must have at least one
    // member in the current catalog so the corresponding specialized
    // storage building actually does something on placement.
    // temp_sensitive currently has one live member (cryo_coolant).
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/storage-categories.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/storage-categories.test.ts
git commit -m "test: assert cryo_coolant is temp_sensitive; document deferred resources"
```

---

## Task 3: #17 — §10.1 Funnel per-unit provenance

**Files:**
- Modify: `src/economy.ts:734-743`
- Modify: `src/economy.test.ts`

**Problem:** `accrueXp` drains `funnelPending[r]` for ALL consumption of `r`, even when the island also produces `r` locally. Per SPEC §10.1 the bonus applies only to "resources it consumes from incoming routes". Local production should offset local consumption before funnel credit is touched.

- [ ] **Step 1: Write the failing test**

Append to `src/economy.test.ts` (new `describe` block at end of file):

```typescript
describe('accrueXp funnel provenance §10.1', () => {
  it('does not drain funnel for consumption covered by local production', () => {
    const state = makeIslandState({ buildings: [] });
    // Seed funnel credit for iron_ore.
    state.funnelPending.iron_ore = 100;
    // Local production of iron_ore = 5 / sec.
    // Local consumption of iron_ore = 3 / sec (e.g. smelter).
    // Net consumption is negative (production > consumption), so NO funnel
    // drain should occur.
    accrueXp(state, { iron_ore: 5 }, { iron_ore: 3 }, 1);
    expect(state.funnelPending.iron_ore).toBe(100);
    expect(state.xp).toBeGreaterThan(0); // production XP still accrues
  });

  it('drains funnel only for net imported consumption', () => {
    const state = makeIslandState({ buildings: [] });
    state.funnelPending.iron_ore = 100;
    // Local production = 2 / sec, consumption = 5 / sec.
    // Net consumption = 3 / sec → drain 3 * XP_WEIGHT.iron_ore * 0.5.
    accrueXp(state, { iron_ore: 2 }, { iron_ore: 5 }, 1);
    const expectedDrain = 3 * XP_WEIGHT.iron_ore * 0.5;
    expect(state.funnelPending.iron_ore).toBeCloseTo(100 - expectedDrain, 6);
  });
});
```

> Note: `accrueXp` is a private function in `economy.ts`. If it is not exported, export it with a `@internal` comment for testing, or perform the test via `advanceIsland` with a crafted state. Check current visibility first; if private, add `export` before the `function` keyword.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/economy.test.ts -t "does not drain funnel"
```

Expected: FAIL (funnelPending drops below 100).

- [ ] **Step 3: Fix the funnel drain logic**

In `src/economy.ts`, inside `accrueXp`, replace the funnel-drain loop:

```typescript
  for (const r of Object.keys(consumption) as ResourceId[]) {
    const consRate = consumption[r] ?? 0;
    if (consRate <= 0) continue;
    const prodRate = production[r] ?? 0;
    const netRate = Math.max(0, consRate - prodRate);
    if (netRate <= 0) continue;
    const netConsumed = netRate * dtSec;
    const pending = state.funnelPending[r] ?? 0;
    if (pending <= 0) continue;
    const want = netConsumed * (XP_WEIGHT[r] ?? 0) * FUNNELING_BONUS_PERCENT_FOR_DRAIN;
    const drawn = Math.min(want, pending);
    state.funnelPending[r] = pending - drawn;
    gain += drawn;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/economy.test.ts -t "funnel provenance"
```

Expected: PASS

- [ ] **Step 5: Run full economy test suite**

```bash
npx vitest run src/economy.test.ts
```

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/economy.ts src/economy.test.ts
git commit -m "fix: funnel drain uses net consumption (production shields local use) §10.1"
```

---

## Task 4: #21 — §8.1 Tile-gating for extractors

**Files:**
- Modify: `src/island.ts:14-49`
- Modify: `src/biomes.ts:62-122`
- Modify: `src/building-defs.ts` (logger, quarry, sand_pit, well, coastal_pump, quartz_mine, pump_jack, gas_extractor, drilling_rig)
- Modify: `src/economy.ts` (`computeRates` — optional stall logic)
- Modify: `src/biomes.test.ts`
- Modify: `src/economy.test.ts`

### 4A — Add missing terrain kinds

- [ ] **Step 1: Extend `TerrainKind` and colors**

In `src/island.ts`:

```typescript
export type TerrainKind =
  | 'grass'
  | 'stone'
  | 'ore'
  | 'coal'
  | 'water'
  | 'tree'
  | 'sand'
  | 'ice'
  | 'magma_vent'
  | 'oil_well'
  | 'gas_seep'
  | 'helium_vent';
```

Add colors to `TERRAIN_COLOR`:

```typescript
const TERRAIN_COLOR: Readonly<Record<TerrainKind, number>> = {
  grass: 0x4a7c44,
  stone: 0x8a8a8a,
  ore: 0x5a4a3a,
  coal: 0x1a1a1a,
  water: 0x3b6fa3,
  tree: 0x2d5a2d,
  sand: 0xc4a062,
  ice: 0xc8e6f0,
  magma_vent: 0xd04020,
  oil_well: 0x1a0f05,     // near-black crude
  gas_seep: 0x8a9a4a,     // sulfur-green
  helium_vent: 0xc0c8e0,  // pale helium-grey
};
```

- [ ] **Step 2: Scatter new terrains in biome rare pools**

In `src/biomes.ts`, update `BIOME_DEFS`:

```typescript
  desert: {
    id: 'desert',
    initialMajorRadius: 12,
    initialMinorRadius: 12,
    powerSource: 'solar',
    defaultTerrain: 'sand',
    rareTerrain: ['stone', 'ore', 'oil_well'],
    displayName: 'Desert',
  },
  coast: {
    id: 'coast',
    initialMajorRadius: 14,
    initialMinorRadius: 7,
    powerSource: 'wind',
    defaultTerrain: 'sand',
    rareTerrain: ['water', 'water', 'ore', 'oil_well', 'gas_seep'],
    displayName: 'Coast',
  },
  volcanic: {
    id: 'volcanic',
    initialMajorRadius: 7,
    initialMinorRadius: 7,
    powerSource: 'geothermal',
    defaultTerrain: 'stone',
    rareTerrain: ['magma_vent', 'coal', 'ore', 'gas_seep', 'helium_vent'],
    displayName: 'Volcanic',
  },
  arctic: {
    id: 'arctic',
    initialMajorRadius: 10,
    initialMinorRadius: 10,
    powerSource: 'cryogenic',
    defaultTerrain: 'stone',
    rareTerrain: ['ice', 'ice', 'stone', 'helium_vent'],
    displayName: 'Arctic',
  },
```

Plains stays unchanged (it is the home biome and uses hand-placed terrain).

- [ ] **Step 3: Run biome tests**

```bash
npx vitest run src/biomes.test.ts
```

Expected: PASS (determinism + home-identity tests still hold).

### 4B — Wire `requiredTile` into extractor defs

- [ ] **Step 4: Add `requiredTile` to each extractor**

In `src/building-defs.ts`, add the field to each def (preserving all other fields):

| defId | requiredTile |
|---|---|
| `logger` | `['tree']` |
| `quarry` | `['stone']` |
| `sand_pit` | `['sand']` |
| `well` | `['water']` |
| `coastal_pump` | `['water']` |
| `quartz_mine` | `['stone']` |
| `pump_jack` | `['oil_well']` |
| `gas_extractor` | `['gas_seep']` |
| `drilling_rig` | `['helium_vent']` |

Example diff for `logger`:

```typescript
  logger: {
    id: 'logger',
    displayName: 'Logger',
    category: 'extraction',
    tier: 1,
    width: 1,
    height: 1,
    fill: 0x2f5e2c,
    stroke: 0x0f2a0c,
    requiredTile: ['tree'],
    placementCost: { stone: 15, wood: 5 },
    glyph: '⌬',
  },
```

Do the same pattern for the remaining eight defs. Delete the old "Tile gating DEFERRED" comments as you go.

> Note: `mine` already has `requiredTile: ['ore', 'coal']` — leave it alone.

- [ ] **Step 5: Write placement-gate test**

Append to `src/economy.test.ts` (or `placement.test.ts` if one exists — use whichever has `validatePlacement` tests):

```typescript
import { validatePlacement } from './placement.js';
import { BUILDING_DEFS } from './building-defs.js';

describe('extractor tile gating §8.1', () => {
  const makeSpecWithTerrain = (terrain: string) => ({
    id: 'test-island',
    name: 'test',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
    buildings: [],
    terrainAt: (x: number, y: number) => terrain as any,
    modifiers: ['stable'],
  });

  it('allows logger on tree tile', () => {
    const spec = makeSpecWithTerrain('tree');
    const result = validatePlacement(spec, {} as any, BUILDING_DEFS.logger, 0, 0, 0);
    expect(result.ok).toBe(true);
  });

  it('rejects logger on grass tile', () => {
    const spec = makeSpecWithTerrain('grass');
    const result = validatePlacement(spec, {} as any, BUILDING_DEFS.logger, 0, 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tile-requirement-not-met');
  });

  it('rejects pump_jack on stone tile', () => {
    const spec = makeSpecWithTerrain('stone');
    const result = validatePlacement(spec, {} as any, BUILDING_DEFS.pump_jack, 0, 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tile-requirement-not-met');
  });
});
```

- [ ] **Step 6: Run placement tests**

```bash
npx vitest run src/economy.test.ts -t "extractor tile gating"
# or if placed in a separate test file:
npx vitest run src/placement.test.ts -t "extractor tile gating"
```

Expected: PASS

### 4C — Optional: stall production for pre-placed invalid extractors

- [ ] **Step 7: (Optional but recommended) Zero rates when requiredTile is not met**

In `src/economy.ts` inside `computeRates`, after resolving the building's recipe and before applying buffs, add a terrain check:

```typescript
    // §8.1 tile-gating stall: if any footprint tile is outside the allowed
    // set, the building produces zero (but still consumes power/heat if
    // wired — here we zero the whole rate for simplicity).
    if (def.requiredTile && def.requiredTile.length > 0 && ctx?.terrainAt) {
      let tileOk = true;
      for (const t of footprintTiles(b, def.width, def.height)) {
        const k = ctx.terrainAt(t.x, t.y);
        if (!def.requiredTile.includes(k)) {
          tileOk = false;
          break;
        }
      }
      if (!tileOk) {
        byBuilding.push({ building: b, rates: { production: {}, consumption: {} }, net: {} });
        continue;
      }
    }
```

> Verify that `ctx` already carries `terrainAt` (it does — `RatesContext` includes it for maintenance and solar lookups). If not, add `terrainAt?: (x:number,y:number)=>TerrainKind` to `RatesContext`.

- [ ] **Step 8: Run full economy suite**

```bash
npx vitest run src/economy.test.ts
```

Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/island.ts src/biomes.ts src/building-defs.ts src/economy.ts src/biomes.test.ts src/economy.test.ts
git commit -m "feat: tile-gating for all extractors §8.1"
```

---

## Task 5: #28 — §12.5 Vehicle mechanical-failure rolls

**Files:**
- Modify: `src/settlement.ts:118-140, 294-296, 325-374`
- Modify: `src/settlement.test.ts`
- Modify: `src/main.ts:1177-1188`

### 5A — Data model + tuning

- [ ] **Step 1: Add `failureRate` to tuning**

In `src/settlement.ts`, update `VehicleTuning` and `tuningFor`:

```typescript
export interface VehicleTuning {
  readonly tier: VehicleTier;
  readonly speed: number;
  readonly tilesPerFuel: number;
  readonly weatherMultiplier: number;
  readonly failureRate: number; // §12.5 mechanical failure probability [0,1]
}

export function tuningFor(kind: VehicleKind): VehicleTuning {
  if (kind === 'ship') {
    return {
      tier: 1,
      speed: SHIP_SPEED_TILES_PER_SEC,
      tilesPerFuel: SHIP_TILES_PER_FUEL,
      weatherMultiplier: SHIP_T1_WEATHER_MUL,
      failureRate: 0.02, // 2% T1 ship
    };
  }
  return {
    tier: 2,
    speed: HELI_SPEED_TILES_PER_SEC,
    tilesPerFuel: HELI_TILES_PER_FUEL,
    weatherMultiplier: HELI_T2_WEATHER_MUL,
    failureRate: 0.01, // 1% T2 helicopter
  };
}
```

- [ ] **Step 2: Expand `TickVehiclesResult` to carry failures**

```typescript
export interface TickVehiclesResult {
  readonly arrivals: VehicleArrival[];
  readonly failures: VehicleArrival[];
}
```

- [ ] **Step 3: Implement deterministic failure roll in `tickVehicles`**

Import `makeSeededRng` at the top of `src/settlement.ts`:

```typescript
import { makeSeededRng } from './rng.js';
```

Inside `tickVehicles`, after the arrival-time check but before processing success:

```typescript
    // §12.5 mechanical failure roll — deterministic per vehicle so tests
    // are stable. Seed mixes vehicle id + launchTime.
    const rng = makeSeededRng(`${v.id}:${v.launchTime}`);
    const failed = rng() < v.failureRate;
    if (failed) {
      arrivals.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
      continue; // vehicle lost; target stays unsettled
    }
```

Wait — `SettlementVehicle` does not yet carry `failureRate`. Add it to the interface and to the record created in `dispatchVehicle`:

```typescript
export interface SettlementVehicle {
  // ... existing fields ...
  readonly failureRate: number;
}
```

In `dispatchVehicle`:

```typescript
  const vehicle: SettlementVehicle = {
    // ... existing fields ...
    failureRate: t.failureRate,
  };
```

- [ ] **Step 4: Update `tickVehicles` to populate both arrays**

```typescript
export function tickVehicles(
  world: WorldState,
  islandStates: Map<string, IslandState>,
  nowMs: number,
): TickVehiclesResult {
  const arrivals: VehicleArrival[] = [];
  const failures: VehicleArrival[] = [];
  const remaining: SettlementVehicle[] = [];

  for (const v of world.vehicles) {
    if (nowMs < v.expectedArrivalTime) {
      remaining.push(v);
      continue;
    }
    const target = world.islands.find((s) => s.id === v.target);
    if (!target) continue;
    if (target.populated) {
      arrivals.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
      continue;
    }

    // §12.5 mechanical failure
    const rng = makeSeededRng(`${v.id}:${v.launchTime}`);
    if (rng() < v.failureRate) {
      failures.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
      continue;
    }

    // Success path — existing logic
    target.populated = true;
    const autoBuildingDefId = v.kind === 'ship' ? 'dock' : 'helipad';
    target.buildings.push({
      id: `${target.id}-auto-${autoBuildingDefId}-1`,
      defId: autoBuildingDefId,
      x: 0,
      y: 0,
    });
    const newState = makeInitialIslandState(target, nowMs);
    islandStates.set(target.id, newState);
    arrivals.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
  }

  world.vehicles.length = 0;
  for (const v of remaining) world.vehicles.push(v);

  return { arrivals, failures };
}
```

- [ ] **Step 5: Update `main.ts` to react to failures**

In `src/main.ts` around line 1177:

```typescript
    const vehicleResult = tickVehicles(worldState, islandStates, now);
    if (vehicleResult.arrivals.length > 0) {
      // ... existing arrival handling ...
    }
    if (vehicleResult.failures.length > 0) {
      // Minimal first-step: log to console. Future step can add UI toast.
      for (const f of vehicleResult.failures) {
        console.log(`Settlement vehicle lost: ${f.kind} → ${f.targetIslandId}`);
      }
    }
```

### 5B — Tests

- [ ] **Step 6: Write failure-roll tests**

Append to `src/settlement.test.ts`:

```typescript
describe('mechanical failure §12.5', () => {
  it('deterministically fails a T1 ship with a known seed', () => {
    // Build a world with one vehicle whose seed is known to fail.
    // Because makeSeededRng is deterministic, we can find a launchTime
    // that produces rng() < 0.02 for a given id.
    const world = makeTestWorld();
    const origin = world.islands[0]!;
    const target = world.islands[1]!;
    const originState = makeTestState();
    originState.inventory.biofuel = 100;
    originState.inventory.foundation_kit = 1;

    // Brute-force a launchTime that causes failure for id 'vehicle-1'.
    let launchTime = 0;
    while (true) {
      const rng = makeSeededRng(`vehicle-1:${launchTime}`);
      if (rng() < 0.02) break;
      launchTime += 1;
    }

    const result = dispatchVehicle(world, origin, originState, target, 'ship', 10, 1, launchTime);
    expect(result.ok).toBe(true);
    const v = (result as any).vehicle as SettlementVehicle;

    const tickResult = tickVehicles(world, new Map(), v.expectedArrivalTime + 1);
    expect(tickResult.failures.length).toBe(1);
    expect(tickResult.arrivals.length).toBe(0);
    expect(target.populated).toBe(false);
  });

  it('deterministically succeeds a T2 helicopter with a known seed', () => {
    const world = makeTestWorld();
    const origin = world.islands[0]!;
    const target = world.islands[1]!;
    const originState = makeTestState();
    originState.inventory.diesel = 100;
    originState.inventory.foundation_kit = 1;

    // Force target to need a helipad by making it already have a dock?
    // No — just dispatch helicopter.
    let launchTime = 0;
    while (true) {
      const rng = makeSeededRng(`vehicle-1:${launchTime}`);
      if (rng() >= 0.01) break;
      launchTime += 1;
    }

    const result = dispatchVehicle(world, origin, originState, target, 'helicopter', 10, 1, launchTime);
    expect(result.ok).toBe(true);
    const v = (result as any).vehicle as SettlementVehicle;

    const tickResult = tickVehicles(world, new Map(), v.expectedArrivalTime + 1);
    expect(tickResult.failures.length).toBe(0);
    expect(tickResult.arrivals.length).toBe(1);
    expect(target.populated).toBe(true);
  });
});
```

> If `makeTestWorld` / `makeTestState` helpers don't exist in `settlement.test.ts`, inspect the file and reuse its existing fixture pattern.

- [ ] **Step 7: Run settlement tests**

```bash
npx vitest run src/settlement.test.ts
```

Expected: PASS (including new failure tests).

- [ ] **Step 8: Run full test suite**

```bash
npm test
```

Expected: 721+ tests PASS (exact count may shift).

- [ ] **Step 9: Run build**

```bash
npm run build
```

Expected: clean (tsc strict + vite production).

- [ ] **Step 10: Commit**

```bash
git add src/settlement.ts src/settlement.test.ts src/main.ts
git commit -m "feat: settlement vehicle mechanical-failure rolls §12.5"
```

---

## Self-Review

Run this checklist before offering execution.

**1. Spec coverage:**
- [ ] #19 — SPEC §8.8 Drone Pad is T2: covered by tier bump.
- [ ] #25 — SPEC §4.6 Cold Storage categories: covered by audit + hardening.
- [ ] #17 — SPEC §10.1 "consumes from incoming routes": covered by net-consumption fix.
- [ ] #21 — SPEC §4.3/§8.1 tile requirements: covered by `requiredTile` + placement gate + optional rate stall.
- [ ] #28 — SPEC §12.5 base mechanical failure: covered by deterministic roll + failure tracking.

**2. Placeholder scan:**
- [ ] No "TBD", "TODO", "implement later" in any step.
- [ ] No vague "add error handling" without code.
- [ ] No "similar to Task N" shortcuts.

**3. Type consistency:**
- [ ] `failureRate` added to both `VehicleTuning` and `SettlementVehicle`.
- [ ] `TickVehiclesResult` now has `failures` array in all return sites.
- [ ] `TerrainKind` union matches `TERRAIN_COLOR` keys exactly.
- [ ] `accrueXp` signature unchanged; only internal loop logic modified.

**4. Test delta expectation:**
- building-defs.test.ts: +1 assertion (level-5 dronepad).
- storage-categories.test.ts: +1 spot-check assertion.
- economy.test.ts: +2 funnel tests; +3 tile-gating placement tests.
- settlement.test.ts: +2 failure-roll tests.
- biomes.test.ts: unchanged (no new assertions, but new terrain kinds flow through determinism tests).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-12-handoff-resume.md`.**

**Two execution options:**

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Use `superpowers:subagent-driven-development`.
2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

**Which approach?**
