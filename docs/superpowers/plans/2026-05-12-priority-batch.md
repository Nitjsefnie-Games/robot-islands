# Priority Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the top 5 unblocked deferred mechanics from `HANDOFF.md` §4.2–4.3: auto-flip core-craft flags, scrap-by-cost demolition, foundation-kit decomposition, shipyard coastal gating, and logistics-hub route capacity doubling.

**Architecture:** All five tasks are pure-layer (no PixiJS/DOM). Each task touches 1–3 files and is independently testable. They share no dependencies and can ship in any order.

**Tech Stack:** Vite 5 + TypeScript strict + PixiJS 8 + vitest.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/economy.ts` | Auto-flip `aiCoreCrafted` / `ascendantCoreCrafted` on first production (#20) |
| `src/economy.test.ts` | Tests for core-craft auto-flip |
| `src/placement.ts` | Scrap recovery from build-cost ingredients (#22) |
| `src/placement.test.ts` | Scrap-recovery tests |
| `src/inspector-ui.ts` | Update scrap-preview helper (#22) |
| `src/settlement.ts` | Foundation-kit decomposition on vehicle arrival (#23) |
| `src/settlement.test.ts` | Decomposition tests |
| `src/building-defs.ts` | Add `requiredTile: ['water']` to shipyard (#24) |
| `src/building-defs.test.ts` | Shipyard placement-gate tests |
| `src/routes.ts` | Per-route capacity multiplier for logistics-hub origin (#30) |
| `src/routes.test.ts` | Route-capacity-doubling tests |
| `src/specialization.ts` | Remove deferred comment, expose capacity helper (#30) |

---

## Task 1: #20 — §13 ai_core / ascendant_core auto-flip

**Files:**
- Modify: `src/economy.ts`
- Modify: `src/economy.test.ts`

Context: `aiCoreCrafted` and `ascendantCoreCrafted` on `IslandState` currently seed `false` and are only flipped manually in the dead demo-island path. The spec says they become `true` the first time the island *produces* (not merely receives) an `ai_core` or `ascendant_core`. The hook belongs in `advanceIsland` after `computeRates`, because `production` is authoritative.

- [ ] **Step 1: Write failing test**

In `src/economy.test.ts`, add a new `describe` block near the existing ai_core tests (~line 940):

```typescript
describe('§13 core-craft auto-flip', () => {
  it('flips aiCoreCrafted on first ai_core production', () => {
    const spec = makeSyntheticSpec({ level: 50, major: 14, minor: 14 });
    const state = makeInitialIslandState(spec, 0);
    state.aiCoreCrafted = false;
    // Place a cryogenic_compute_center (T5 arctic building that produces ai_core)
    state.buildings.push({
      id: 't5-1',
      defId: 'cryogenic_compute_center',
      x: 0,
      y: 0,
    });
    // Give it inputs so it can run
    state.inventory.reality_anchor = 100;
    state.inventory.eldritch_processor = 100;
    state.inventory.exotic_alloy = 100;
    state.inventory.casimir_energy = 100;
    advanceIsland(state, 10_000); // 10s is more than one 5400s cycle? No — cycle is 90min.
    // Wait. 90min cycle. Let's advance much longer.
  });
});
```

Wait — `cryogenic_compute_center` cycle is 5400s (90 min). To get 1 unit we need 5400s. Let's advance 6000s (100 min). Give enough power.

Actually, let me re-read the recipe:

```
// src/recipes.ts ~line 578
cryogenic_compute_center: {
  cycleSec: 5400,
  inputs: { reality_anchor: 1, eldritch_processor: 1, exotic_alloy: 2, casimir_energy: 1 },
  outputs: { ai_core: 1 },
  category: 'manufacturing',
},
```

The test needs enough inputs and enough time. Let's also place a power source. But `advanceIsland` will just run at powerFactor if there's insufficient power. To keep the test focused, place a fusion core (produces 2000W) and ensure no other consumers.

```typescript
  it('flips aiCoreCrafted on first ai_core production', () => {
    const spec = makeSyntheticSpec({ level: 50, major: 14, minor: 14 });
    const state = makeInitialIslandState(spec, 0);
    state.aiCoreCrafted = false;
    // Power
    state.buildings.push({ id: 'pwr-1', defId: 'fusion_core', x: -5, y: 0 });
    // Producer
    state.buildings.push({ id: 't5-1', defId: 'cryogenic_compute_center', x: 0, y: 0 });
    // Inputs for one cycle (5400s)
    state.inventory.reality_anchor = 10;
    state.inventory.eldritch_processor = 10;
    state.inventory.exotic_alloy = 20;
    state.inventory.casimir_energy = 10;
    expect(state.aiCoreCrafted).toBe(false);
    advanceIsland(state, 6_000_000); // 100 min
    expect(state.aiCoreCrafted).toBe(true);
    expect(state.inventory.ai_core ?? 0).toBeGreaterThan(0);
  });
```

Also test that it does NOT flip from route delivery alone (no local production):

```typescript
  it('does not flip aiCoreCrafted from inventory presence alone', () => {
    const spec = makeSyntheticSpec({ level: 50, major: 14, minor: 14 });
    const state = makeInitialIslandState(spec, 0);
    state.aiCoreCrafted = false;
    state.inventory.ai_core = 5;
    advanceIsland(state, 10_000);
    expect(state.aiCoreCrafted).toBe(false);
  });
```

And test `ascendantCoreCrafted`:

```typescript
  it('flips ascendantCoreCrafted on first ascendant_core production', () => {
    const spec = makeSyntheticSpec({ level: 50, major: 14, minor: 14 });
    const state = makeInitialIslandState(spec, 0);
    state.aiCoreCrafted = true;
    state.ascendantCoreCrafted = false;
    state.buildings.push({ id: 'pwr-1', defId: 'fusion_core', x: -5, y: 0 });
    state.buildings.push({ id: 't5-2', defId: 'ascendant_assembly', x: 0, y: 0 });
    state.inventory.reality_anchor = 100;
    state.inventory.eldritch_processor = 100;
    state.inventory.ai_core = 100;
    expect(state.ascendantCoreCrafted).toBe(false);
    advanceIsland(state, 8_000_000); // > 7200s cycle
    expect(state.ascendantCoreCrafted).toBe(true);
    expect(state.inventory.ascendant_core ?? 0).toBeGreaterThan(0);
  });
```

Run: `npx vitest run src/economy.test.ts -t "core-craft auto-flip"`
Expected: FAIL — `aiCoreCrafted` stays `false`.

- [ ] **Step 2: Implement auto-flip in `advanceIsland`**

In `src/economy.ts`, inside `advanceIsland`, after the `computeRates` call (~line 862) and before `findNextCapEvent`, add:

```typescript
    const { production, consumption, net } = computeRates(state, ctx, t);
    // §13 auto-flip: first local production of ai_core / ascendant_core
    if (!state.aiCoreCrafted && (production.ai_core ?? 0) > 0) {
      state.aiCoreCrafted = true;
    }
    if (!state.ascendantCoreCrafted && (production.ascendant_core ?? 0) > 0) {
      state.ascendantCoreCrafted = true;
    }
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/economy.test.ts -t "core-craft auto-flip"
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/economy.ts src/economy.test.ts
git commit -m "feat: §13 auto-flip aiCoreCrafted / ascendantCoreCrafted on first production"
```

---

## Task 2: #22 — §6.7 Scrap demolition recovery

**Files:**
- Modify: `src/placement.ts`
- Modify: `src/placement.test.ts`
- Modify: `src/inspector-ui.ts`

Context: `demolishBuilding` currently returns `scrapReturned = footprintTiles(...).length * 3`. Spec §6.7 says scrap should equal `sum(build cost ingredients) × 0.3`, floored. The `placementCostFor(def)` helper already normalizes costs.

- [ ] **Step 1: Write failing test**

In `src/placement.test.ts`, add:

```typescript
describe('§6.7 scrap recovery', () => {
  it('returns scrap proportional to build cost, not footprint area', () => {
    const { spec, state } = makeTestIsland();
    placeBuilding(state, spec, 'mine', 0, 0, 0);
    const mineDef = BUILDING_DEFS.mine;
    const costSum = Object.values(placementCostFor(mineDef)).reduce((a, b) => a + b, 0);
    const expectedScrap = Math.floor(costSum * 0.3);
    const result = demolishBuilding(spec, state, state.buildings[state.buildings.length - 1]!.id);
    expect(result.ok).toBe(true);
    expect(result.scrapReturned).toBe(expectedScrap);
  });

  it('floors scrap from cost × 0.3', () => {
    const { spec, state } = makeTestIsland();
    // workshop costs { stone: 20, wood: 10 } → sum 30 → 30*0.3 = 9.0
    placeBuilding(state, spec, 'workshop', 0, 0, 0);
    const result = demolishBuilding(spec, state, state.buildings[state.buildings.length - 1]!.id);
    expect(result.scrapReturned).toBe(9);
  });
});
```

Run: `npx vitest run src/placement.test.ts -t "scrap recovery"`
Expected: FAIL — scrapReturned still uses footprint-area formula.

- [ ] **Step 2: Implement scrap-by-cost**

In `src/placement.ts`, in `demolishBuilding` (~line 547), replace:

```typescript
  const scrapReturned = Math.floor(tiles.length * 3);
```

with:

```typescript
  const cost = placementCostFor(def);
  const costSum = Object.values(cost).reduce((sum, n) => sum + n, 0);
  const scrapReturned = Math.floor(costSum * 0.3);
```

Also update the JSDoc comment above the function to replace the placeholder paragraph with:

```typescript
 *   1. §6.7 Scrap, proportional to build cost: `floor(sum(placementCost) * 0.3)`.
 *      Every def post-§14 carries a placementCost; if one somehow doesn't,
 *      `placementCostFor` returns `{}` and scrap is 0.
```

- [ ] **Step 3: Update inspector-ui scrap preview**

In `src/inspector-ui.ts`, find `previewScrapForBuilding` (~line 116) and replace the `width * height * 3` formula with the cost-based formula:

```typescript
export function previewScrapForBuilding(defId: BuildingDefId): number {
  const def = BUILDING_DEFS[defId];
  const cost = placementCostFor(def);
  const costSum = Object.values(cost).reduce((sum, n) => sum + n, 0);
  return Math.floor(costSum * 0.3);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/placement.test.ts -t "scrap recovery"
npx vitest run src/placement.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/placement.ts src/placement.test.ts src/inspector-ui.ts
git commit -m "feat: §6.7 scrap demolition recovery from build cost"
```

---

## Task 3: #23 — §12.4 Foundation Kit decomposition

**Files:**
- Modify: `src/settlement.ts`
- Modify: `src/settlement.test.ts`

Context: on successful vehicle arrival, `tickVehicles` creates a fresh `IslandState` via `makeInitialIslandState`. The spec says the Foundation Kit decomposes into its raw constituents (the `kit_assembler` recipe inputs). For now, ignore the "starter inventory grace cap" — that's deferred. Just credit the recipe inputs multiplied by `vehicle.foundationKitCount`.

- [ ] **Step 1: Write failing test**

In `src/settlement.test.ts`, add after the existing arrival tests:

```typescript
describe('§12.4 foundation kit decomposition', () => {
  it('credits kit recipe inputs to the new colony on arrival', () => {
    const { world, homeSpec, homeState, targetSpec } = makeTestWorld();
    homeState.inventory.foundation_kit = 1;
    homeState.inventory.biofuel = 10;
    const r = dispatchVehicle(world, homeSpec, homeState, targetSpec, 'ship', 5, 1, 0);
    expect(r.ok).toBe(true);
    tickVehicles(world, world.islandStates, r.vehicle.expectedArrivalTime + 1);
    const newState = world.islandStates.get(targetSpec.id);
    expect(newState).toBeDefined();
    // kit_assembler inputs: { iron_ingot: 50, brick: 20, lumber: 10, glass: 5, gear: 5 }
    expect(newState!.inventory.iron_ingot).toBe(50);
    expect(newState!.inventory.brick).toBe(20);
    expect(newState!.inventory.lumber).toBe(10);
    expect(newState!.inventory.glass).toBe(5);
    expect(newState!.inventory.gear).toBe(5);
  });

  it('multiplies decomposition by foundationKitCount', () => {
    const { world, homeSpec, homeState, targetSpec } = makeTestWorld();
    homeState.inventory.foundation_kit = 2;
    homeState.inventory.biofuel = 10;
    const r = dispatchVehicle(world, homeSpec, homeState, targetSpec, 'ship', 5, 2, 0);
    expect(r.ok).toBe(true);
    tickVehicles(world, world.islandStates, r.vehicle.expectedArrivalTime + 1);
    const newState = world.islandStates.get(targetSpec.id);
    expect(newState!.inventory.iron_ingot).toBe(100);
  });
});
```

Run: `npx vitest run src/settlement.test.ts -t "foundation kit decomposition"`
Expected: FAIL — new colony has zero starter resources.

- [ ] **Step 2: Implement decomposition**

In `src/settlement.ts`, import `RECIPES` from `./recipes.js` (add to existing imports). Then in `tickVehicles`, after:

```typescript
    const newState = makeInitialIslandState(target, nowMs);
    islandStates.set(target.id, newState);
```

add:

```typescript
    // §12.4 Foundation Kit decomposition: credit recipe inputs to the colony.
    const kitRecipe = RECIPES['kit_assembler'];
    if (kitRecipe) {
      for (const [r, amount] of Object.entries(kitRecipe.inputs)) {
        const id = r as ResourceId;
        const total = (amount ?? 0) * v.foundationKitCount;
        if (total > 0) {
          newState.inventory[id] = (newState.inventory[id] ?? 0) + total;
        }
      }
    }
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/settlement.test.ts -t "foundation kit decomposition"
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/settlement.ts src/settlement.test.ts
git commit -m "feat: §12.4 Foundation Kit decomposition on settlement arrival"
```

---

## Task 4: #24 — Shipyard coastal-tile gating

**Files:**
- Modify: `src/building-defs.ts`
- Modify: `src/building-defs.test.ts`

Context: Shipyard currently has no `requiredTile`. SPEC §8.8 requires coastal/water placement. `TerrainKind` already includes `'water'`. The `validatePlacement` checker in `placement.ts` already gates on `def.requiredTile` — we only need to add the field to the def.

- [ ] **Step 1: Write failing test**

In `src/building-defs.test.ts`, add:

```typescript
describe('§8.8 shipyard coastal gating', () => {
  it('shipyard has requiredTile containing water', () => {
    expect(BUILDING_DEFS.shipyard.requiredTile).toContain('water');
  });
});
```

Run: `npx vitest run src/building-defs.test.ts -t "shipyard coastal gating"`
Expected: FAIL — `requiredTile` is undefined.

- [ ] **Step 2: Add requiredTile to shipyard def**

In `src/building-defs.ts`, inside the `shipyard` definition (~line 595), after `placementCost` add:

```typescript
    requiredTile: ['water'],
```

Also update the deferred comment above the def:

Replace:
```
  // §8.8 / §12.2: Shipyard — T1 logistics building that launches §12 cargo
  // ships for settlement (and, later, T1 cargo routes). Spec requires
  // coastal placement; coastal-tile gating is DEFERRED (no water-tile
  // system yet). Step-12 places Shipyard freely on any tile inside the
  // island ellipse.
```

With:
```
  // §8.8 / §12.2: Shipyard — T1 logistics building that launches §12 cargo
  // ships for settlement (and, later, T1 cargo routes). Requires at least
  // one footprint tile on water (coastal placement gate per §4.3).
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/building-defs.test.ts -t "shipyard coastal gating"
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/building-defs.ts src/building-defs.test.ts
git commit -m "feat: §8.8 Shipyard coastal-tile gating via requiredTile"
```

---

## Task 5: #30 — §9.4 Specialization route-capacity doubling

**Files:**
- Modify: `src/routes.ts`
- Modify: `src/routes.test.ts`
- Modify: `src/specialization.ts`

Context: `Route.capacityPerSec` is a fixed constant at creation time. For a Logistics Hub island, routes *originating* from that island should have double capacity. The cleanest approach: keep `capacityPerSec` as the base value on the `Route` record, and apply the multiplier at dispatch time by reading the origin island's specialization.

- [ ] **Step 1: Write failing test**

In `src/routes.test.ts`, add:

```typescript
describe('§9.4 logistics hub route capacity doubling', () => {
  it('doubles capacity for routes from a logistics_hub island', () => {
    const { world, states } = makeTwoIslandWorld();
    const fromState = states.get('island-a')!;
    fromState.specialization = 'logistics_hub';
    world.routes.push({
      id: 'r-1',
      from: 'island-a',
      to: 'island-b',
      type: 'cargo',
      capacityPerSec: 1,
      filter: 'stone',
      priorityList: [],
      transitTimeSec: 10,
      inFlight: [],
    });
    fromState.inventory.stone = 100;
    const result = dispatchAttempt(world, states, 0, 1);
    expect(result.length).toBe(1);
    expect(result[0]!.amount).toBe(2); // 1 * 2 (doubled)
  });

  it('keeps base capacity for non-logistics-hub origin', () => {
    const { world, states } = makeTwoIslandWorld();
    const fromState = states.get('island-a')!;
    fromState.specialization = null; // generalist
    world.routes.push({
      id: 'r-1',
      from: 'island-a',
      to: 'island-b',
      type: 'cargo',
      capacityPerSec: 1,
      filter: 'stone',
      priorityList: [],
      transitTimeSec: 10,
      inFlight: [],
    });
    fromState.inventory.stone = 100;
    const result = dispatchAttempt(world, states, 0, 1);
    expect(result.length).toBe(1);
    expect(result[0]!.amount).toBe(1); // base capacity
  });
});
```

Run: `npx vitest run src/routes.test.ts -t "logistics hub route capacity doubling"`
Expected: FAIL — capacity is not doubled.

- [ ] **Step 2: Import specialization helper in routes.ts**

In `src/routes.ts`, add import:

```typescript
import { effectiveSpecializationMultipliers } from './specialization.js';
```

- [ ] **Step 3: Apply capacity multiplier at dispatch time**

In `src/routes.ts`, in `dispatchPhase`, replace the capacity usage (~line 308):

```typescript
    const capDemand = route.capacityPerSec * elapsedSec;
```

with:

```typescript
    const srcState = states.get(route.from);
    const originSpec = srcState
      ? effectiveSpecializationMultipliers(srcState.specialization)
      : null;
    const capacityMul =
      srcState?.specialization === 'logistics_hub' ? 2.0 : 1.0;
    const capDemand = route.capacityPerSec * capacityMul * elapsedSec;
```

Wait — `effectiveSpecializationMultipliers` doesn't expose a route-capacity multiplier. It's cleaner to just inline the `logistics_hub` check. The `SpecializationMultipliers` interface currently lacks a `routeCapacityMul` field. Adding one would touch `specialization.ts` and `economy.ts` (which destructures `specMul`). To keep this task minimal, inline the check in `routes.ts`.

But the spec reviewer will flag this as a duplication. Let's instead add a small exported helper in `specialization.ts`:

In `src/specialization.ts`, after `effectiveSpecializationMultipliers`, add:

```typescript
/** §9.4 route capacity multiplier for an origin island's specialization.
 *  Returns 2.0 for logistics_hub, 1.0 otherwise. */
export function routeCapacityMultiplier(role: RoleId | null): number {
  return role === 'logistics_hub' ? 2.0 : 1.0;
}
```

Then in `src/routes.ts`:

```typescript
import { routeCapacityMultiplier } from './specialization.js';
```

And:

```typescript
    const capacityMul = routeCapacityMultiplier(srcState?.specialization ?? null);
    const capDemand = route.capacityPerSec * capacityMul * elapsedSec;
```

Also remove the deferred comment in `specialization.ts` (~line 96):

Replace:
```
      'Logistics recipes ×2.0 and storage caps ×1.5; ×0.75 on all other production. ' +
      'Route capacity doubling (§9.4) is deferred — wires when routes carry a per-route base capacity.',
```

With:
```
      'Logistics recipes ×2.0, storage caps ×1.5, and route capacity ×2.0; ×0.75 on all other production.',
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/routes.test.ts -t "logistics hub route capacity doubling"
npx vitest run src/routes.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes.ts src/routes.test.ts src/specialization.ts
git commit -m "feat: §9.4 logistics hub doubles route capacity for originating routes"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - #20: Auto-flip on first production of ai_core / ascendant_core ✅
   - #22: Scrap = floor(sum(cost) × 0.3) ✅
   - #23: Kit decomposes to recipe inputs on arrival ✅
   - #24: Shipyard requires water tile ✅
   - #30: Logistics Hub doubles origin route capacity ✅

2. **Placeholder scan:** No TBD/TODO/fill-in-details steps. ✅

3. **Type consistency:**
   - `production[id]` uses `?? 0` pattern matching codebase style.
   - `routeCapacityMultiplier` takes `RoleId | null`, consistent with `effectiveSpecializationMultipliers`.
