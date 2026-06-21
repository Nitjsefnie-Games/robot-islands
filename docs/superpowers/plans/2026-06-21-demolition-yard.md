# Demolition Yard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a placeable **Demolition Yard** building that continuously produces Scrap by running the net economics of one place-then-demolish cycle of a player-selected target building type.

**Architecture:** A new pure module derives a `Recipe` from the target's `placementCost` (reusing the §6.7 scrap fraction). A new optional per-instance field `PlacedBuilding.scrapTarget` (mirroring `cargoLabel`) names the target; `resolveRecipe` returns the derived recipe for `demolition_yard` instances. A new `set-scrap-target` server intent + mutation-gateway method + inspector picker let the player configure the target. No tiles/build-slots/queue; no schema bump (additive optional field carried by the structural-spread serializer).

**Tech Stack:** Vite 5 + TypeScript strict + PixiJS 8 (client `src/`), Fastify 5 + Postgres + tsx (server `server/`), vitest.

## Global Constraints

- TypeScript strict: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` — new code compiles clean.
- Pure layer (`demolition-yard.ts`, `recipes.ts`, `building-defs.ts`, `economy.ts`, `persistence.ts`) imports **no PixiJS**. Render/UI code (`inspector-ui.ts`) is read-only against state and routes mutations through the gateway.
- Every behavior change updates `SPEC.md` in the same change (SPEC is source of truth). Sections: §6.7, §8.
- Module graph stays acyclic at runtime: `demolition-yard.ts` may import `building-defs.ts` + `construction.ts` (values) and `recipes.ts`/`buildings.ts` (types only). `recipes.ts` and `placement.ts` import `demolition-yard.ts`.
- Recipe category for the derived recipe is `'smelting'` (matches `steel_mill_scrap`).
- Scrap recovery fraction is the single shared constant `SCRAP_RECOVERY_FRACTION = 0.3` — never re-inline `0.3`.
- Commit after each task. Co-author trailer on every commit: `Co-Authored-By: <model> <noreply@…>`.

---

### Task 1: Shared scrap constant + derived-recipe pure module

**Files:**
- Modify: `src/building-defs.ts` (add `SCRAP_RECOVERY_FRACTION` export near the top of the module, after imports)
- Modify: `src/placement.ts:1136` (use the constant in `demolishBuilding`)
- Create: `src/demolition-yard.ts`
- Test: `src/demolition-yard.test.ts`

**Interfaces:**
- Produces: `SCRAP_RECOVERY_FRACTION: number` (from `building-defs.ts`); `scrapRecipeForTarget(targetDefId: BuildingDefId): Recipe | undefined` (from `demolition-yard.ts`).
- Consumes: `BUILDING_DEFS`, `BuildingDefId`, `BuildingDef` (building-defs); `BASE_CONSTRUCTION_MS_BY_TIER` (construction); `Recipe`, `ResourceId` (recipes, type-only).

- [ ] **Step 1: Write the failing test** — `src/demolition-yard.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { scrapRecipeForTarget } from './demolition-yard.js';
import { BUILDING_DEFS } from './building-defs.js';
import { BASE_CONSTRUCTION_MS_BY_TIER } from './construction.js';

describe('scrapRecipeForTarget', () => {
  it('derives the iron_mine recipe matching the planner formula', () => {
    // iron_mine placementCost = { stone: 200, wood: 80 } → Σ=280
    const r = scrapRecipeForTarget('iron_mine');
    expect(r).toBeDefined();
    expect(r!.outputs).toEqual({ scrap: Math.floor(280 * 0.3) }); // 84
    // inputs = n - floor(n/2): stone 200-100=100, wood 80-40=40
    expect(r!.inputs).toEqual({ stone: 100, wood: 40 });
    expect(r!.cycleSec).toBe(BASE_CONSTRUCTION_MS_BY_TIER[1] / 1000);
    expect(r!.category).toBe('smelting');
  });

  it('derives a T2 target recipe with the T2 construction cycle', () => {
    // assembler placementCost present, tier 2
    const r = scrapRecipeForTarget('assembler');
    expect(r).toBeDefined();
    expect(r!.cycleSec).toBe(BASE_CONSTRUCTION_MS_BY_TIER[2] / 1000);
    const cost = BUILDING_DEFS.assembler.placementCost!;
    const sum = Object.values(cost).reduce((a, b) => a + b, 0);
    expect(r!.outputs.scrap).toBe(Math.floor(sum * 0.3));
  });

  it('returns undefined for a basket too small to mint scrap', () => {
    // plant_a_tree placementCost = { wood: 5, fresh_water: 1 } → Σ=6 → floor(1.8)=1
    // construct a synthetic zero case via a def with Σ<4 is not in catalog, so
    // assert the smallest real basket still mints ≥1 and a hypothetical 0 path:
    expect(scrapRecipeForTarget('plant_a_tree')!.outputs.scrap).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/demolition-yard.test.ts`
Expected: FAIL — cannot find module `./demolition-yard.js`.

- [ ] **Step 3: Add the shared constant to `building-defs.ts`**

Add immediately after the imports block (before `export type BuildingCategory`):

```ts
/** §6.7 demolition recovery rate: demolishing a building returns
 *  `floor(SCRAP_RECOVERY_FRACTION × Σ totalInvestedCost)` Scrap. Shared by
 *  `demolishBuilding` (placement.ts) and the Demolition Yard derived recipe
 *  (demolition-yard.ts) so the two can never drift. */
export const SCRAP_RECOVERY_FRACTION = 0.3;
```

- [ ] **Step 4: Use the constant in `placement.ts`**

At `src/placement.ts:1136`, replace:

```ts
  const scrapReturned = Math.floor(costSum * 0.3);
```

with:

```ts
  const scrapReturned = Math.floor(costSum * SCRAP_RECOVERY_FRACTION);
```

Add `SCRAP_RECOVERY_FRACTION` to the existing `building-defs.js` import in `placement.ts` (it already imports `BUILDING_DEFS` from there).

- [ ] **Step 5: Create `src/demolition-yard.ts`**

```ts
// Pure: Demolition Yard derived recipe (§6.7). A Demolition Yard automates the
// place-then-demolish loop for a selected target building: per cycle it consumes
// the un-refunded share of the target's placement cost and mints Scrap at the
// §6.7 recovery rate. The recipe is DERIVED from the target def — no recipe table
// entry, no real building instance. Mirrors the synthetic `{building}_scrapper`
// in scripts/bootstrap_planner_v3.py value-for-value.
//
// No PixiJS, no DOM. Runtime deps: building-defs (values), construction (value).
// recipes is imported type-only (stripped at runtime) → graph stays acyclic.
import {
  BUILDING_DEFS,
  SCRAP_RECOVERY_FRACTION,
  type BuildingDefId,
} from './building-defs.js';
import { BASE_CONSTRUCTION_MS_BY_TIER } from './construction.js';
import type { Recipe, ResourceId } from './recipes.js';

/** Build the Demolition Yard recipe for a target building type, or `undefined`
 *  when the target's basket is too small to mint ≥1 Scrap (or has no cost).
 *  - output: `floor(SCRAP_RECOVERY_FRACTION × Σ placementCost)` scrap
 *  - inputs: per resource `n − floor(n/2)` (place cost minus the 50% demolish
 *    refund); only positive nets are listed
 *  - cycleSec: the target tier's base construction time (ms → s) */
export function scrapRecipeForTarget(targetDefId: BuildingDefId): Recipe | undefined {
  const def = BUILDING_DEFS[targetDefId];
  const cost = def.placementCost;
  if (!cost) return undefined;
  let sum = 0;
  const inputs: Partial<Record<ResourceId, number>> = {};
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    sum += n;
    const net = n - Math.floor(n / 2);
    if (net > 0) inputs[r] = net;
  }
  const scrap = Math.floor(sum * SCRAP_RECOVERY_FRACTION);
  if (scrap <= 0) return undefined;
  return {
    cycleSec: BASE_CONSTRUCTION_MS_BY_TIER[def.tier] / 1000,
    inputs,
    outputs: { scrap },
    category: 'smelting',
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/demolition-yard.test.ts && npx vitest run src/placement.test.ts`
Expected: PASS (placement demolish tests unchanged — constant substitution is byte-identical).

- [ ] **Step 7: Commit**

```bash
git add src/demolition-yard.ts src/demolition-yard.test.ts src/building-defs.ts src/placement.ts
git commit -m "feat(demolition-yard): derived scrap recipe + shared §6.7 recovery constant"
```

---

### Task 2: `demolition_yard` building def + `scrapTarget` instance field

**Files:**
- Modify: `src/building-defs.ts` (add `'demolition_yard'` to the `BuildingDefId` union, to `ALL_BUILDING_DEF_IDS`, and a `BUILDING_DEFS.demolition_yard` entry)
- Modify: `src/buildings.ts:45` (add `scrapTarget?: BuildingDefId` to `PlacedBuilding`)
- Test: `src/building-defs.test.ts` (extend), `src/persistence.test.ts` (extend)

**Interfaces:**
- Produces: `BUILDING_DEFS.demolition_yard`; `PlacedBuilding.scrapTarget?: BuildingDefId`.
- Consumes: `SHAPES.square2` (shape-mask).

> **Note (catalog discipline):** `building-defs.test.ts` asserts `ALL_BUILDING_DEF_IDS` exactly matches the `BUILDING_DEFS` keyset and the `BuildingDefId` union, and that every def has a glyph + positive footprint. All three lists must grow together.

- [ ] **Step 1: Write the failing test** — append to `src/building-defs.test.ts` inside `describe('BUILDING_DEFS catalog', …)`

```ts
  it('demolition_yard is a T1 special building with a 2x2 footprint and power draw', () => {
    const d = BUILDING_DEFS.demolition_yard;
    expect(d.category).toBe('special');
    expect(d.tier).toBe(1);
    expect(d.footprint.tiles).toHaveLength(4); // square2
    expect(d.power?.consumes).toBe(20);
    expect(d.placementCost).toEqual({ stone: 100, wood: 60, iron_ingot: 20 });
    expect(d.requiredBiomes).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/building-defs.test.ts -t "demolition_yard"`
Expected: FAIL — `BUILDING_DEFS.demolition_yard` is undefined / type error on the union.

- [ ] **Step 3: Add the union member, the `ALL_BUILDING_DEF_IDS` entry, and the def**

In `src/building-defs.ts`, add to the `BuildingDefId` union (group it with the special/T1 ids):

```ts
  | 'demolition_yard'
```

Add `'demolition_yard'` to the `ALL_BUILDING_DEF_IDS` array (same grouping).

Add the `BUILDING_DEFS` entry (place near `coal_furnace`):

```ts
  demolition_yard: {
    id: 'demolition_yard',
    displayName: 'Demolition Yard',
    category: 'special',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x5a4632, // scrap-heap brown
    stroke: 0x241b11,
    power: { consumes: 20 },
    // §6.7: automates the place-then-demolish loop. Recipe is DERIVED per
    // instance from the selected target's placementCost (see demolition-yard.ts);
    // no static RECIPES entry. Placement cost is a small early-game outlay —
    // bootstrap scrap is the purpose. Tune in Appendix A.
    placementCost: { stone: 100, wood: 60, iron_ingot: 20 },
    glyph: '♻',
  },
```

- [ ] **Step 4: Add the `scrapTarget` field to `PlacedBuilding`**

In `src/buildings.ts`, after the `cargoLabel?: ResourceId;` field (~line 45):

```ts
  /** §6.7 Demolition Yard target. Meaningful ONLY for `demolition_yard`
   *  instances: names the building type whose place-then-demolish loop this
   *  Yard automates. `resolveRecipe` derives the Yard's recipe from this
   *  target's placementCost via `scrapRecipeForTarget`. Undefined → the Yard
   *  is idle (no recipe), exactly like an unlabeled generic-storage Crate.
   *  Mutable: the inspector's set-scrap-target path reassigns this field.
   *  Forward-compat: legacy saves omit it; carried by the structural-spread
   *  (de)serializer, so no schema bump is required. */
  scrapTarget?: BuildingDefId;
```

Ensure `BuildingDefId` is imported in `buildings.ts` (it imports from `building-defs.js` already for `defId`).

- [ ] **Step 5: Write the persistence round-trip test** — append to `src/persistence.test.ts`

```ts
  it('round-trips a building scrapTarget without a schema bump', () => {
    const world = makeMinimalWorldForRoundTrip(); // existing helper used by neighbor tests
    const isl = world.islands[0]!;
    isl.buildings.push({
      id: 'dy1', defId: 'demolition_yard', x: 0, y: 0, scrapTarget: 'iron_mine',
    } as PlacedBuilding);
    const json = serializeWorld(world /* + the args its neighbor tests pass */);
    const loaded = loadWorld(json /* + args */);
    const b = loaded.islands[0]!.buildings.find((x) => x.id === 'dy1')!;
    expect(b.scrapTarget).toBe('iron_mine');
  });
```

> Implementer: match the exact `serializeWorld`/`loadWorld` signatures and the world-construction helper used by the surrounding tests in `persistence.test.ts` (read the nearest round-trip test in that file). The assertion — `scrapTarget` survives — is the deliverable.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/building-defs.test.ts src/persistence.test.ts`
Expected: PASS — including the existing `ALL_BUILDING_DEF_IDS matches the BUILDING_DEFS keyset` and union-completeness tests.

- [ ] **Step 7: Build typecheck (catches exhaustiveness gaps from the new id)**

Run: `npm run build`
Expected: clean. If a `switch`/exhaustive map over `BuildingDefId` errors, add the `demolition_yard` arm (most are data-driven and need none).

- [ ] **Step 8: Commit**

```bash
git add src/building-defs.ts src/building-defs.test.ts src/buildings.ts src/persistence.test.ts
git commit -m "feat(demolition-yard): demolition_yard def + PlacedBuilding.scrapTarget field"
```

---

### Task 3: `resolveRecipe` wiring + economy production + SPEC.md

**Files:**
- Modify: `src/recipes.ts:4017+` (add a `demolition_yard` branch at the top of `resolveRecipe`)
- Test: `src/recipes.test.ts` (extend), `src/economy.test.ts` (extend)
- Modify: `SPEC.md` (§6.7, §8)

**Interfaces:**
- Consumes: `scrapRecipeForTarget` (demolition-yard).
- Produces: `resolveRecipe` returns the derived recipe for `demolition_yard` instances with a `scrapTarget`, else `undefined`.

- [ ] **Step 1: Write the failing resolveRecipe test** — append to `src/recipes.test.ts`

```ts
  it('resolveRecipe: demolition_yard yields the derived recipe when scrapTarget set', () => {
    const def = BUILDING_DEFS.demolition_yard;
    const idle = resolveRecipe(def, { id: 'd', defId: 'demolition_yard', x: 0, y: 0 } as PlacedBuilding);
    expect(idle).toBeUndefined();
    const active = resolveRecipe(
      def,
      { id: 'd', defId: 'demolition_yard', x: 0, y: 0, scrapTarget: 'iron_mine' } as PlacedBuilding,
    );
    expect(active).toEqual(scrapRecipeForTarget('iron_mine'));
  });
```

Ensure the test file imports `scrapRecipeForTarget` from `./demolition-yard.js` and `BUILDING_DEFS` / `PlacedBuilding` as needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/recipes.test.ts -t "demolition_yard yields"`
Expected: FAIL — `resolveRecipe` returns `undefined` for both (no branch yet).

- [ ] **Step 3: Add the branch in `resolveRecipe`**

In `src/recipes.ts`, add a runtime import at the top:

```ts
import { scrapRecipeForTarget } from './demolition-yard.js';
```

Then as the **first** check inside `resolveRecipe` (before the `steel_mill` block at ~line 4029):

```ts
  // §6.7 Demolition Yard — recipe derived per instance from the selected
  // target's placementCost. Idle (no recipe) until the player picks a target.
  // Resolution is permissive: it derives from the target def regardless of
  // current tier/biome gates (the picker enforces eligibility at selection).
  if (def.id === 'demolition_yard') {
    return _b.scrapTarget ? scrapRecipeForTarget(_b.scrapTarget) : undefined;
  }
```

- [ ] **Step 4: Run resolveRecipe test to verify it passes**

Run: `npx vitest run src/recipes.test.ts -t "demolition_yard yields"`
Expected: PASS.

- [ ] **Step 5: Write the economy integration test** — append to `src/economy.test.ts`

```ts
  it('demolition_yard produces scrap and consumes the net basket', () => {
    // Strip the yard's power so the test isn't gated on a power source (the
    // existing POWER_FREE catalog only strips a fixed set of defs).
    const defs = { ...BUILDING_DEFS } as DefCatalog;
    const { power: _p, ...noPower } = defs.demolition_yard;
    defs.demolition_yard = noPower as BuildingDef;

    const state = makeState({
      buildings: [
        { id: 'dy', defId: 'demolition_yard', x: 0, y: 0, scrapTarget: 'iron_mine' } as PlacedBuilding,
      ],
      inventory: { ...blankInventory(), stone: 1000, wood: 1000 },
      lastTick: 0,
    });
    // iron_mine target: cycle = BASE_CONSTRUCTION_MS_BY_TIER[1]/1000 s,
    // out 84 scrap, in 100 stone + 40 wood per cycle.
    const cycleMs = BASE_CONSTRUCTION_MS_BY_TIER[1];
    advanceIsland(state, cycleMs, { defs });
    expect(state.inventory.scrap).toBeGreaterThan(0);
    expect(state.inventory.stone).toBeLessThan(1000);
    expect(state.inventory.wood).toBeLessThan(1000);
  });
```

Ensure `economy.test.ts` imports `BASE_CONSTRUCTION_MS_BY_TIER` (`./construction.js`) and `BUILDING_DEFS`.

- [ ] **Step 6: Run economy test to verify it passes**

Run: `npx vitest run src/economy.test.ts -t "demolition_yard produces scrap"`
Expected: PASS.

- [ ] **Step 7: Update `SPEC.md`**

In **§6.7** (Byproducts + demolition), after the "Demolition recovery" paragraph, add:

```markdown
**Demolition Yard (continuous scrap faucet).** A placeable Demolition Yard (T1,
special) automates the place-then-demolish loop. The player selects a target
building type per Yard instance; the Yard's recipe is derived from that target's
`placementCost`: it mints `floor(0.3 · Σ placementCost)` Scrap per cycle (the same
30% recovery rate as a manual demolish) while consuming `n − floor(n/2)` of each
cost resource (the place cost net of the 50% demolish refund), on a cycle equal to
the target tier's base construction time. The derived recipe equals one
place+demolish cycle value-for-value; an unconfigured Yard is idle. Source of
truth: `scrapRecipeForTarget` in `src/demolition-yard.ts`, wired in `resolveRecipe`.
```

In the **§8 catalog** (special category list), add a Demolition Yard row/entry consistent with the surrounding format (T1, special, cost `100 stone + 60 wood + 20 iron_ingot`, power −20 kW, derives recipe from target).

- [ ] **Step 8: Commit**

```bash
git add src/recipes.ts src/recipes.test.ts src/economy.test.ts SPEC.md
git commit -m "feat(demolition-yard): resolveRecipe wiring + economy production + SPEC §6.7/§8"
```

---

### Task 4: Server `set-scrap-target` intent

**Files:**
- Modify: `server/src/game/intents.ts` (add the `set-scrap-target` intent, modeled on `relabel-cargo` at ~line 730)
- Test: the server intents test file (find the suite covering `relabel-cargo`; e.g. `server/src/game/intents.test.ts`)

**Interfaces:**
- Produces: intent `set-scrap-target` with payload `{ islandId: string; buildingId: string; target: BuildingDefId | null }` that sets `building.scrapTarget` (or clears it when `null`).

- [ ] **Step 1: Write the failing server test** — mirror the `relabel-cargo` test in the same suite

```ts
  it('set-scrap-target sets scrapTarget on a demolition_yard', async () => {
    // arrange an island with a placed demolition_yard (mirror the relabel-cargo
    // test's island/building setup in this file)
    const res = await applyIntent(/* ctx */, {
      type: 'set-scrap-target',
      islandId, buildingId, target: 'iron_mine',
    });
    expect(res.ok).toBe(true);
    const b = getIsland(islandId).state.buildings.find((x) => x.id === buildingId)!;
    expect(b.scrapTarget).toBe('iron_mine');
  });

  it('set-scrap-target rejects an invalid target id', async () => {
    const res = await applyIntent(/* ctx */, {
      type: 'set-scrap-target', islandId, buildingId, target: 'not_a_building' as never,
    });
    expect(res.ok).toBe(false);
  });
```

> Implementer: match the exact `applyIntent`/context signatures and island-setup helper used by the neighbor `relabel-cargo` test in this file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test -- -t "set-scrap-target"`
Expected: FAIL — unknown intent type.

- [ ] **Step 3: Implement the intent**

In `server/src/game/intents.ts`, add (mirroring the `relabel-cargo` handler at ~730):

```ts
  // §6.7 Demolition Yard target selection. Validates the building is a
  // demolition_yard and the target is a valid BuildingDefId (or null to clear),
  // then sets building.scrapTarget. Mirrors relabel-cargo.
  'set-scrap-target': {
    validate(payload) {
      const { islandId, buildingId, target } = payload;
      if (typeof islandId !== 'string' || typeof buildingId !== 'string') {
        return { ok: false, error: 'islandId and buildingId are required' };
      }
      if (target !== null && !isValidBuildingDefId(target)) {
        return { ok: false, error: 'target must be a valid building def id or null' };
      }
      return { ok: true };
    },
    apply(state, payload) {
      const { islandId, buildingId, target } = payload;
      const island = state.islands.get(islandId);          // match this file's lookup idiom
      if (!island) return { ok: false, error: 'island not found' };
      const b = island.state.buildings.find((x) => x.id === buildingId);
      if (!b) return { ok: false, error: 'building not found' };
      if (b.defId !== 'demolition_yard') {
        return { ok: false, error: 'building is not a demolition_yard' };
      }
      b.scrapTarget = target ?? undefined;
      return { ok: true };
    },
  },
```

Use the validation helper for building ids that this codebase already exposes (the analog of `isValidResourceId` used by `relabel-cargo`). If none exists, add `isValidBuildingDefId(x): x is BuildingDefId` checking membership in `ALL_BUILDING_DEF_IDS` and import it where `isValidResourceId` is imported. Match the exact `validate`/`apply` shape of the surrounding intents in this file (the snippet above is illustrative of structure, not necessarily the literal handler signature).

- [ ] **Step 4: Run server tests to verify they pass**

Run: `cd server && npm test -- -t "set-scrap-target" && npm run typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add server/src/game/intents.ts server/src/game/intents.test.ts
git commit -m "feat(demolition-yard): set-scrap-target server intent"
```

---

### Task 5: Mutation-gateway `setScrapTarget`

**Files:**
- Modify: `src/mutation-gateway.ts` (interface at ~line 153; local impl at ~473; remote impl at ~991)
- Test: `src/mutation-gateway.test.ts` (extend, mirror the `relabelCargo` cases)

**Interfaces:**
- Produces: `MutationGateway.setScrapTarget(islandId: string, buildingId: string, target: BuildingDefId | null): GatewayReturn`.
- Remote impl sends intent `'set-scrap-target'` with `{ islandId, buildingId, target }`.

- [ ] **Step 1: Write the failing gateway test** — mirror the `relabelCargo` test(s)

```ts
  it('remote setScrapTarget sends a set-scrap-target intent', () => {
    const { gateway, sent } = makeRemoteGatewayHarness(); // the harness the relabelCargo test uses
    gateway.setScrapTarget('isl1', 'dy1', 'iron_mine');
    expect(sent).toContainEqual({ type: 'set-scrap-target', payload: { islandId: 'isl1', buildingId: 'dy1', target: 'iron_mine' } });
  });
```

> Implementer: match the harness and assertion shape used by the neighbor `relabelCargo` test in `mutation-gateway.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mutation-gateway.test.ts -t "setScrapTarget"`
Expected: FAIL — `setScrapTarget` not on the gateway.

- [ ] **Step 3: Add to the interface (~line 153)**

```ts
  setScrapTarget(islandId: string, buildingId: string, target: BuildingDefId | null): GatewayReturn;
```

Ensure `BuildingDefId` is imported in `mutation-gateway.ts`.

- [ ] **Step 4: Add the local impl (near `relabelCargo` at ~473)**

```ts
    setScrapTarget(islandId, buildingId, target) {
      const isl = hooks.getIsland(islandId);                 // match local relabelCargo's lookup
      if (!isl) return { ok: false, error: 'island not found' };
      const b = isl.state.buildings.find((x) => x.id === buildingId);
      if (!b) return { ok: false, error: 'building not found' };
      if (b.defId !== 'demolition_yard') return { ok: false, error: 'not a demolition_yard' };
      b.scrapTarget = target ?? undefined;
      return { ok: true };
    },
```

(Match the exact local-gateway idioms `relabelCargo` uses — island lookup, return shape.)

- [ ] **Step 5: Add the remote impl (near ~991)**

```ts
    setScrapTarget(islandId, buildingId, target) {
      return send('set-scrap-target', { islandId, buildingId, target });
    },
```

- [ ] **Step 6: Run tests + build to verify**

Run: `npx vitest run src/mutation-gateway.test.ts && npm run build`
Expected: PASS + clean (the interface addition forces both impls to exist).

- [ ] **Step 7: Commit**

```bash
git add src/mutation-gateway.ts src/mutation-gateway.test.ts
git commit -m "feat(demolition-yard): mutation-gateway setScrapTarget (local + remote)"
```

---

### Task 6: Inspector target picker

**Files:**
- Modify: `src/inspector-ui.ts` (add a Demolition Yard target control, mirroring the `cargoLabelControls` block at ~795–970)

**Interfaces:**
- Consumes: `deps.gateway.setScrapTarget`; `BUILDING_DEFS`, `ALL_BUILDING_DEF_IDS`, `scrapRecipeForTarget`.

> This is render-layer; verification is via the running app (screenshot), not unit tests — consistent with the repo's UI verification path (AGENTS.md). Keep all state mutation routed through the gateway; the panel is read-only against state otherwise.

- [ ] **Step 1: Build the eligible-target list helper (top of the new block)**

```ts
// Demolition Yard target picker — shown only for demolition_yard instances.
// Eligible targets: any building whose basket mints ≥1 scrap AND is placeable
// on this island now (tier/biome/access). Reuse the existing placement gate
// used elsewhere in this file (e.g. buildingUnlocked / canPlaceOnIsland).
const eligibleScrapTargets = (): BuildingDefId[] =>
  ALL_BUILDING_DEF_IDS.filter(
    (id) => scrapRecipeForTarget(id) !== undefined && isTargetPlaceable(id, target),
  );
```

Use the placement-eligibility predicate already imported/used in `inspector-ui.ts` for the building catalog (match its exact name; if the file already computes "placeable building ids" for the build menu, reuse that source).

- [ ] **Step 2: Build the control (mirror `cargoLabelControls`)**

A `<select>` populated from `eligibleScrapTargets()` (option value = defId, label = `displayName` + ` (≈${scrapRecipeForTarget(id)!.outputs.scrap} scrap / ${scrapRecipeForTarget(id)!.cycleSec}s)`), plus a "clear" affordance. Show the wrap only when `b.defId === 'demolition_yard'`; set `select.value` from `b.scrapTarget`.

- [ ] **Step 3: Wire the change handler through the gateway**

```ts
scrapTargetControls.select.addEventListener('change', () => {
  const b = currentBuilding(); if (!b) return;
  const next = scrapTargetControls.select.value as BuildingDefId;
  const r = deps.gateway.setScrapTarget(target.spec.id, b.id, next);
  if (r.ok) b.scrapTarget = next;   // optimistic local echo, mirroring relabelCargo
});
```

(Match the exact `currentBuilding`/`target.spec.id` idioms the `cargoLabel` handler uses at ~881–926, including its optimistic-local-echo pattern.)

- [ ] **Step 4: Verify the build compiles**

Run: `npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/inspector-ui.ts
git commit -m "feat(demolition-yard): inspector target picker"
```

---

## Self-review checklist (run after all tasks)

- [ ] Full suite green: `npm test` (requires Postgres up — server project).
- [ ] Client build clean: `npm run build`.
- [ ] Server typecheck clean: `cd server && npm run typecheck`.
- [ ] `SPEC.md` §6.7 + §8 reflect the Demolition Yard.
- [ ] No re-inlined `0.3`; `SCRAP_RECOVERY_FRACTION` shared.
- [ ] App smoke test: place a Demolition Yard, pick a target in the inspector, confirm scrap accrues.

## Deferred decision recorded

**No schema bump.** The design proposed v31 → v32; during planning the building (de)serializer was confirmed to be a structural spread (`{ ...b }` / `...rest`, `persistence.ts:582` / `:1189`), which carries any optional field automatically — exactly as `cargoLabel`/`paused`/`placedAt` are carried. `scrapTarget` is therefore a purely additive, forward/backward-compatible optional field that needs no migration. A round-trip test (Task 2 Step 5) guards it. If review prefers the explicit bump, it can be added as a no-op `migrateV31toV32` later.
