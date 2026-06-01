# Action-Cost SI Rescale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SI-rescale the three deferred action costs — terrain-modifier resource-mapping (30-day-extraction rule) + wire its currently-unfired shot charge, and unify Land Reclamation + Platform Constructor onto one per-land-tile structural basket.

**Architecture:** A shared `LAND_TILE_COST` basket drives both land-creating buildings (reclamation bills the exact inscribed-tile delta, platform bills tileCount). Terrain-modifier rare cost becomes `ceil(baseRate/s × 30 × 86400)` of the target resource, read live from the extractor's `RECIPES` entry via a verified `target → RecipeId` table; the conversion cost is charged at terrain-modifier placement (upfront, mirroring Land Reclamation).

**Tech Stack:** Vite 5 + TypeScript strict + PixiJS 8 + vitest. Pure cost layer is renderer-free + unit-tested; placement/inspector wiring is build-checked.

**Spec:** `docs/superpowers/specs/2026-06-01-action-cost-rescale-design.md`

---

## File Structure

- **Modify** `src/building-defs.ts` — add the shared `LAND_TILE_COST` basket.
- **Modify** `src/terrain-modifier.ts` — rare-cost 30-day formula + `RARE_TARGET_EXTRACTOR_RECIPE` table + `baseRatePerSec`; drop the K/horizon/`naturalExtractionRate=1` stub.
- **Modify** `src/placement.ts` — charge the terrain-modifier conversion cost at placement (gate + deduct), on top of `placementCost`.
- **Modify** `src/land-reclamation.ts` — `landReclamationCost(major,minor,axis)` → `tileDelta × LAND_TILE_COST`; basket-based `canExpandIsland`/`expandIsland`; `inscribedTileCount` helper.
- **Modify** `src/artificial-island.ts` — `computeConstructionCost` → `tileCount × LAND_TILE_COST × surcharge` (steel_beam); basket-based validate/deduct.
- **Modify** inspector / settlement UI — cost displays that read the changed functions (reclamation expand preview; artificial-island construction cost).
- **Modify** `SPEC.md` — §3.4 / §8.9 / §2.5 cost prose.
- **Tests** `terrain-modifier.test.ts`, `placement.test.ts`, `land-reclamation.test.ts`, `artificial-island.test.ts`.

No new files, no persistence migration.

---

### Task 1: `LAND_TILE_COST` shared basket

**Files:**
- Modify: `src/building-defs.ts` (add near `CATEGORY_ADJACENCY_RATE`)
- Test: `src/building-defs.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/building-defs.test.ts` (add `LAND_TILE_COST` to the `'./building-defs.js'` import):

```ts
describe('LAND_TILE_COST', () => {
  it('is the per-land-tile structural basket', () => {
    expect(LAND_TILE_COST).toEqual({ steel_beam: 1, concrete: 10 });
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `npx vitest run src/building-defs.test.ts -t "LAND_TILE_COST"`
Expected: FAIL — not exported.

- [ ] **Step 3: Add the constant**

In `src/building-defs.ts`, after the `CATEGORY_ADJACENCY_RATE` block, add:

```ts
/**
 * §2.5 / §3.4 cost to construct ONE land tile, shared by Land Reclamation
 * (+1 radius bills `tileDelta × LAND_TILE_COST`) and Platform Constructor
 * (a new island bills `tileCount × LAND_TILE_COST × surcharge`). Placeholder
 * magnitude — tunable. `ResourceId` keys.
 */
export const LAND_TILE_COST: Readonly<Partial<Record<ResourceId, number>>> = {
  steel_beam: 1,
  concrete: 10,
};
```

(`ResourceId` is already imported in `building-defs.ts`; if not, add it to the `'./recipes.js'` import.)

- [ ] **Step 4: Run, confirm PASS**

Run: `npx vitest run src/building-defs.test.ts -t "LAND_TILE_COST"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/building-defs.ts src/building-defs.test.ts
git commit -m "feat(cost): add shared LAND_TILE_COST basket

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 2: Terrain-modifier rare cost = 30 days of base extraction

**Files:**
- Modify: `src/terrain-modifier.ts` (lines 17-162 region)
- Test: `src/terrain-modifier.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/terrain-modifier.test.ts` (import `conversionCostForTarget`, `rareShotCost`, `RARE_TARGET_EXTRACTOR_RECIPE` from `'./terrain-modifier.js'`). The 30-day cost = `ceil((outputQty/cycleSec) × 2_592_000)`; verified values: copper/ore/coal/etc. (cycleSec 20) → 129,600; limestone/clay/diamond (40) → 64,800; oil/gas (430) → 6,028; uranium/lithium/mercury (3,440) → 754; helium (1.5) → 1,728,000.

```ts
describe('rare-target cost = 30 days of base extraction', () => {
  it('copper_vein → 30d of copper_mine (cycleSec 20) = 129,600 copper_ore', () => {
    expect(conversionCostForTarget('copper_vein')).toEqual({ copper_ore: 129600 });
  });
  it('uranium_vein → 30d of uranium_mine (cycleSec 3440) = 754 uranium_ore', () => {
    expect(conversionCostForTarget('uranium_vein')).toEqual({ uranium_ore: 754 });
  });
  it('helium_vent → 30d of drilling_rig (cycleSec 1.5) = 1,728,000 helium_3', () => {
    expect(conversionCostForTarget('helium_vent')).toEqual({ helium_3: 1728000 });
  });
  it('diamond_vein → 30d of diamond_quarry (cycleSec 40) = 64,800 diamond_ore', () => {
    expect(conversionCostForTarget('diamond_vein')).toEqual({ diamond_ore: 64800 });
  });
  it('oil_well → 30d of pump_jack (cycleSec 430) = 6,028 crude_oil', () => {
    expect(conversionCostForTarget('oil_well')).toEqual({ crude_oil: 6028 });
  });
  it('every rare target has an extractor-recipe mapping', () => {
    for (const t of RARE_TARGET_TERRAINS) {
      expect(RARE_TARGET_EXTRACTOR_RECIPE[t as string]).toBeTypeOf('string');
    }
  });
});

describe('natural-target costs unchanged', () => {
  it('grass stays 16× its per-tile basket', () => {
    expect(conversionCostForTarget('grass')).toEqual({ stone: 3200, gear: 1600 });
  });
});
```

(`RARE_TARGET_TERRAINS` is already imported in this test file or add it.)

- [ ] **Step 2: Run, confirm FAIL**

Run: `npx vitest run src/terrain-modifier.test.ts -t "30 days"`
Expected: FAIL — current rare cost is a flat 2160 (the `naturalExtractionRate=1` stub), and `rareShotCost`/`RARE_TARGET_EXTRACTOR_RECIPE` don't exist.

- [ ] **Step 3: Implement the 30-day rule**

In `src/terrain-modifier.ts`:

1. Add `RECIPES` and `type RecipeId` to the `'./recipes.js'` import.
2. Remove the stub constants `K_RARE_MULT` (line 25), `PAYBACK_HORIZON_CYCLES` (line 31), and the `naturalExtractionRate` function (lines 124-131). Add:

```ts
/** 30-day horizon in seconds (30 × 24 × 3600). `cycleSec` is real seconds. */
const THIRTY_DAYS_SEC = 2_592_000;

/** For each rare target, the base extractor recipe (a `RECIPES` key) whose
 *  per-cycle output of `RARE_TARGET_INPUT[target]` defines the base extraction
 *  rate. Verified against recipes.ts: every entry exists, outputs qty 1 of the
 *  mapped resource, and carries `exogenousFlow: 'terrain'`. */
export const RARE_TARGET_EXTRACTOR_RECIPE: Readonly<Record<string, RecipeId>> = {
  ore: 'mine_on_ore',
  coal: 'mine_on_coal',
  oil_well: 'pump_jack',
  gas_seep: 'gas_extractor',
  helium_vent: 'drilling_rig',
  limestone: 'limestone_quarry',
  clay_pit: 'clay_pit_extractor',
  sulfur_vein: 'sulfur_mine',
  phosphate_deposit: 'phosphate_mine',
  graphite_vein: 'graphite_mine',
  copper_vein: 'copper_mine',
  tin_vein: 'tin_mine',
  lead_vein: 'lead_mine',
  bauxite_vein: 'bauxite_mine',
  manganese_vein: 'manganese_mine',
  zinc_vein: 'zinc_mine',
  chromium_vein: 'chromium_mine',
  nickel_vein: 'nickel_mine',
  tungsten_vein: 'tungsten_mine',
  mercury_pit: 'mercury_well',
  diamond_vein: 'diamond_quarry',
  lithium_vein: 'lithium_extractor',
  uranium_vein: 'uranium_mine',
};

/** The base extraction rate (units/sec) for a rare target: the extractor
 *  recipe's per-cycle output of the mapped resource ÷ cycleSec. 0 if missing
 *  (a classification bug the coverage test catches). */
export function baseRatePerSec(target: TerrainKind): number {
  const recipeId = RARE_TARGET_EXTRACTOR_RECIPE[target as string];
  const resource = RARE_TARGET_INPUT[target as string];
  if (recipeId === undefined || resource === undefined) return 0;
  const recipe = RECIPES[recipeId];
  if (recipe === undefined) return 0;
  const outQty = recipe.outputs[resource] ?? 0;
  return outQty / recipe.cycleSec;
}

/** Per-shot cost of mapping a tile to a rare resource = 30 days of that
 *  resource's base extraction, charged once for the 16-tile shot. */
export function rareShotCost(target: TerrainKind): Partial<Record<ResourceId, number>> {
  const resource = RARE_TARGET_INPUT[target as string];
  if (resource === undefined) return {};
  const units = Math.ceil(baseRatePerSec(target) * THIRTY_DAYS_SEC);
  return units > 0 ? { [resource]: units } : {};
}
```

3. In `conversionCostForTarget`, replace the rare branch (lines 149-159) so it delegates to `rareShotCost`:

```ts
  if (RARE_TARGET_TERRAINS.has(target)) {
    return rareShotCost(target);
  }
```

(Leave the natural branch unchanged.)

- [ ] **Step 4: Run, confirm PASS**

Run: `npx vitest run src/terrain-modifier.test.ts`
Expected: PASS (the new rare cases, the unchanged-natural case, and the existing coverage/classification tests).

- [ ] **Step 5: Build clean**

Run: `npm run build`
Expected: `tsc -b` clean (no unused `K_RARE_MULT`/`PAYBACK_HORIZON_CYCLES`).

- [ ] **Step 6: Commit**

```bash
git add src/terrain-modifier.ts src/terrain-modifier.test.ts
git commit -m "feat(terrain-modifier): rare cost = 30 days of base extraction

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 3: Charge the terrain-modifier conversion cost at placement

**Files:**
- Modify: `src/placement.ts` (`validatePlacement` cost gate ~line 322; `placeBuilding` deduction ~line 475)
- Test: `src/placement.test.ts`

The conversion cost (natural + rare) is computed and shown in the target picker but never deducted. Charge it **upfront at placement** (mirrors Land Reclamation), on top of `placementCost`, for `terrain_modifier` placements carrying a target.

- [ ] **Step 1: Write the failing test**

Add to `src/placement.test.ts` (import `placeBuilding`; `conversionCostForTarget` from `'./terrain-modifier.js'`). `placeBuilding`'s signature already threads a `terrainTarget` arg (see `placement.ts` `placeBuilding` params — the `terrainTarget` is the 11th-ish positional; read the signature and pass it). Build a spec/state via the file's `makeSpec`/`makeState`, fund inventory, place a `terrain_modifier` with a rare target and assert BOTH placement cost AND conversion cost were deducted:

```ts
describe('terrain_modifier placement charges the conversion cost upfront', () => {
  it('deducts placementCost + conversionCostForTarget(target)', () => {
    const spec = makeSpec();
    const state = makeState(spec); // funds stone/wood/etc to 10000
    state.inventory.copper_ore = 200000; // cover the 129,600 copper conversion
    // terrain_modifier placementCost: { steel_beam:200, concrete:5000, gear:100, pipe:80, microchip:10 }
    state.inventory.steel_beam = 10000;
    state.inventory.concrete = 100000;
    state.inventory.microchip = 1000;
    const beforeCopper = state.inventory.copper_ore;
    // place with target 'copper_vein' (read placeBuilding's signature for the terrainTarget arg position)
    const r = placeBuilding(spec, state, 'terrain_modifier', 0, 0, 0, () => 'tm', undefined, undefined, undefined, 'copper_vein');
    expect(r.ok).toBe(true);
    expect(state.inventory.copper_ore).toBe(beforeCopper - 129600);
  });

  it('rejects placement when the conversion cost is unaffordable', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.steel_beam = 10000;
    state.inventory.concrete = 100000;
    state.inventory.microchip = 1000;
    state.inventory.copper_ore = 0; // can't afford the 129,600 conversion
    const r = placeBuilding(spec, state, 'terrain_modifier', 0, 0, 0, () => 'tm', undefined, undefined, undefined, 'copper_vein');
    expect(r.ok).toBe(false);
    expect(spec.buildings).toHaveLength(0);
  });
});
```

(Adjust the exact `placeBuilding(...)` argument list to the real signature — read `placement.ts` `export function placeBuilding(` and place `terrainTarget` in its correct position; pass `undefined` for unrelated optional args.)

- [ ] **Step 2: Run, confirm FAIL**

Run: `npx vitest run src/placement.test.ts -t "conversion cost upfront"`
Expected: FAIL — conversion cost is not currently deducted, so `copper_ore` is unchanged and the unaffordable placement still succeeds.

- [ ] **Step 3: Implement the charge**

In `src/placement.ts`:

1. Import `conversionCostForTarget` from `'./terrain-modifier.js'`.
2. In `validatePlacement`'s §14 cost gate (the `if (!skipCostGate) { … }` block ~line 322), when the def is a terrain_modifier and a target is supplied, fold the conversion basket into the affordability check. `validatePlacement` does not currently receive the target — the simplest, localized approach is to gate + deduct inside `placeBuilding` (which DOES receive `terrainTarget`). So: leave `validatePlacement` as-is and do the combined gate in `placeBuilding`.
3. In `placeBuilding`, where it re-checks the cost gate and deducts `placementCost` (the block ~line 452-478), extend the cost basket for terrain_modifier placements. After computing the base `cost` (placementCost), add:

```ts
  // §8.9: a terrain_modifier pays its conversion cost UPFRONT at placement
  // (mirrors Land Reclamation's immediate deduct), on top of placementCost.
  const def = BUILDING_DEFS[defId];
  let fullCost: Partial<Record<ResourceId, number>> = { ...cost };
  if (def.terrainModifier === true && terrainTarget !== undefined) {
    const conv = conversionCostForTarget(terrainTarget);
    for (const [r, n] of Object.entries(conv) as Array<[ResourceId, number]>) {
      fullCost[r] = (fullCost[r] ?? 0) + n;
    }
  }
  // Re-check affordability against fullCost; reject if short.
  const missing = affordabilityShortfall(state.inventory, fullCost);
  if (Object.keys(missing).length > 0) {
    return { ok: false, reason: 'insufficient-resources', missing };
  }
```

Then deduct `fullCost` (not just `cost`) in the existing deduction loop. Read the exact local variable names (`cost`, `terrainTarget`) at the `placeBuilding` cost site and splice this in so the deduction loop iterates `fullCost`. Keep the existing id-collision refund path refunding `fullCost`.

- [ ] **Step 4: Run, confirm PASS**

Run: `npx vitest run src/placement.test.ts -t "conversion cost upfront"`
Then the whole file: `npx vitest run src/placement.test.ts`
Expected: PASS (existing terrain_modifier placement tests that DON'T fund the conversion may now need the extra inventory — if an existing test breaks because it didn't fund the conversion resource, that's the new gate working; update that test's fixture to fund it, OR confirm it uses a natural target whose basket the `makeState` 10000-stock already covers).

- [ ] **Step 5: Build + commit**

Run: `npm run build` (expect clean)
```bash
git add src/placement.ts src/placement.test.ts
git commit -m "feat(terrain-modifier): charge conversion cost upfront at placement

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 4: Land Reclamation — tile-delta × LAND_TILE_COST

**Files:**
- Modify: `src/land-reclamation.ts` (cost fn 56-58; `canExpandIsland` 86-105; `expandIsland` 120-138; `LandReclamationCost` type)
- Test: `src/land-reclamation.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/land-reclamation.test.ts` (import `landReclamationCost`, `inscribedTileCount`). The cost now depends on the inscribed-tile delta and is a basket. Use the helper to compute the expected delta so the test validates the multiplication + axis logic:

```ts
import { landReclamationCost, inscribedTileCount } from './land-reclamation.js';
import { LAND_TILE_COST } from './building-defs.js';

describe('landReclamationCost — tile-delta × LAND_TILE_COST', () => {
  it('major-axis +1 bills (tileDelta) × LAND_TILE_COST', () => {
    const major = 14, minor = 14;
    const delta = inscribedTileCount(major + 1, minor) - inscribedTileCount(major, minor);
    expect(delta).toBeGreaterThan(0);
    expect(landReclamationCost(major, minor, 'major')).toEqual({
      steel_beam: delta * (LAND_TILE_COST.steel_beam ?? 0),
      concrete: delta * (LAND_TILE_COST.concrete ?? 0),
    });
  });
  it('minor-axis +1 uses the minor delta', () => {
    const major = 14, minor = 7;
    const delta = inscribedTileCount(major, minor + 1) - inscribedTileCount(major, minor);
    expect(landReclamationCost(major, minor, 'minor')).toEqual({
      steel_beam: delta * 1,
      concrete: delta * 10,
    });
  });
});

describe('inscribedTileCount', () => {
  it('grows with radius', () => {
    expect(inscribedTileCount(15, 14)).toBeGreaterThan(inscribedTileCount(14, 14));
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `npx vitest run src/land-reclamation.test.ts -t "tile-delta"`
Expected: FAIL — `landReclamationCost` currently takes one radius and returns `{stone}`; `inscribedTileCount` not exported.

- [ ] **Step 3: Implement**

In `src/land-reclamation.ts`:

1. Import `tileInscribedInEllipse` from `'./island.js'`, `LAND_TILE_COST` from `'./building-defs.js'`, `affordabilityShortfall` from `'./placement.js'`, `type ResourceId` from `'./recipes.js'`.
2. Change the `LandReclamationCost` type to a basket: `export type LandReclamationCost = Partial<Record<ResourceId, number>>;` (find its current `{ stone: number }` definition and replace).
3. Add the count helper + rewrite the cost fn:

```ts
/** Count of fully-inscribed tiles in an axis-aligned ellipse of the given
 *  radii (same rule as `computeIslandTiles`). Pure. */
export function inscribedTileCount(major: number, minor: number): number {
  let n = 0;
  const xMin = -Math.ceil(major), xMax = Math.ceil(major) - 1;
  const yMin = -Math.ceil(minor), yMax = Math.ceil(minor) - 1;
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      if (tileInscribedInEllipse(x, y, major, minor)) n++;
    }
  }
  return n;
}

/** §3.4 cost of one +1 expansion on `axis`: the exact inscribed-tile delta
 *  (tiles gained) × the shared per-land-tile basket. */
export function landReclamationCost(
  major: number,
  minor: number,
  axis: Axis,
): LandReclamationCost {
  const before = inscribedTileCount(major, minor);
  const after = axis === 'major'
    ? inscribedTileCount(major + 1, minor)
    : inscribedTileCount(major, minor + 1);
  const delta = Math.max(0, after - before);
  const out: LandReclamationCost = {};
  for (const [r, n] of Object.entries(LAND_TILE_COST) as Array<[ResourceId, number]>) {
    out[r] = delta * n;
  }
  return out;
}
```

4. Rewrite `canExpandIsland`'s affordability check (the `landReclamationCost(current)` + `inv(state,'stone') < cost.stone` lines) to the basket:

```ts
  const cost = landReclamationCost(spec.majorRadius, spec.minorRadius, axis);
  if (Object.keys(affordabilityShortfall(state.inventory, cost)).length > 0) {
    return { ok: false, reason: 'insufficient-resources' };
  }
```

5. Rewrite `expandIsland`'s deduction (the `landReclamationCost(current)` + `state.inventory.stone -= cost.stone` lines):

```ts
  const cost = landReclamationCost(spec.majorRadius, spec.minorRadius, axis);
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    state.inventory[r] = (state.inventory[r] ?? 0) - n;
  }
  if (axis === 'major') spec.majorRadius = spec.majorRadius + 1;
  else spec.minorRadius = spec.minorRadius + 1;
```

(Keep the `canExpandIsland` guard at the top of `expandIsland`.)

- [ ] **Step 4: Update the inspector expand-cost preview**

In `src/inspector-ui.ts`, the Land Reclamation expand buttons show the stone cost (search `landReclamationCost` / the expand-cost label / `paintReclamation`). Update the call to `landReclamationCost(spec.majorRadius, spec.minorRadius, axis)` and format the returned BASKET (steel_beam/concrete) instead of `cost.stone`. Read the existing label code and mirror its formatting for a multi-resource basket (reuse a `formatShortfall`/`formatRefund`-style helper).

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run src/land-reclamation.test.ts` (expect PASS; update any existing reclamation test that asserted `{stone: 5*r*r}` to the new basket — those assertions are now wrong by design; recompute with `inscribedTileCount`).
Run: `npm run build` (expect clean — the `LandReclamationCost` type change compiles through `canExpandIsland`/`expandIsland`/inspector).

- [ ] **Step 6: Commit**

```bash
git add src/land-reclamation.ts src/land-reclamation.test.ts src/inspector-ui.ts
git commit -m "feat(reclamation): cost = inscribed-tile delta x LAND_TILE_COST

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 5: Platform Constructor — tileCount × LAND_TILE_COST

**Files:**
- Modify: `src/artificial-island.ts` (`STEEL_PER_TILE` etc. 36-38; `ConstructionCost` 56-58; `computeConstructionCost` 87-95; validate 143-145; deduct 190-192)
- Test: `src/artificial-island.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/artificial-island.test.ts` (import `computeConstructionCost`, `LAND_TILE_COST`). The cost is now `ceil(tileCount × LAND_TILE_COST[r] × surcharge)` per resource, tileCount = `π × major × minor`. Mirror the file's existing `computeConstructionCost` test setup for the request object:

```ts
import { LAND_TILE_COST } from './building-defs.js';

describe('computeConstructionCost — LAND_TILE_COST basket', () => {
  it('plains island = ceil(tileCount × basket), no surcharge', () => {
    const req = { biome: 'plains', major: 8, minor: 8 } as never; // match the real ConstructionRequirements shape
    const tileCount = Math.PI * 8 * 8;
    const cost = computeConstructionCost(req);
    expect(cost.steel_beam).toBe(Math.ceil(tileCount * (LAND_TILE_COST.steel_beam ?? 0)));
    expect(cost.concrete).toBe(Math.ceil(tileCount * (LAND_TILE_COST.concrete ?? 0)));
    expect((cost as Record<string, number>).steel).toBeUndefined();
  });
  it('volcanic island applies the ×1.5 surcharge', () => {
    const req = { biome: 'volcanic', major: 7, minor: 7 } as never;
    const tileCount = Math.PI * 7 * 7;
    const cost = computeConstructionCost(req);
    expect(cost.concrete).toBe(Math.ceil(tileCount * (LAND_TILE_COST.concrete ?? 0) * 1.5));
  });
});
```

(Read the real `ConstructionRequirements` shape and build `req` accordingly.)

- [ ] **Step 2: Run, confirm FAIL**

Run: `npx vitest run src/artificial-island.test.ts -t "LAND_TILE_COST basket"`
Expected: FAIL — current cost uses `steel`/`iron_ingot`/`wood`, not `steel_beam`/`concrete`.

- [ ] **Step 3: Implement**

In `src/artificial-island.ts`:

1. Import `LAND_TILE_COST` from `'./building-defs.js'` and `type ResourceId` from `'./recipes.js'`.
2. Remove `STEEL_PER_TILE`/`IRON_INGOT_PER_TILE`/`WOOD_PER_TILE` (lines 36-38).
3. Change `ConstructionCost` (56-58) to a basket: `export type ConstructionCost = Partial<Record<ResourceId, number>>;` (replace the `{ steel; iron_ingot; wood }` interface).
4. Rewrite `computeConstructionCost` (87-95):

```ts
export function computeConstructionCost(req: ConstructionRequirements): ConstructionCost {
  const tileCount = Math.PI * req.major * req.minor;
  const surcharge = HARD_BIOMES.includes(req.biome) ? 1.5 : 1.0;
  const out: ConstructionCost = {};
  for (const [r, n] of Object.entries(LAND_TILE_COST) as Array<[ResourceId, number]>) {
    out[r] = Math.ceil(tileCount * n * surcharge);
  }
  return out;
}
```

5. Rewrite the affordability check (143-145) and deduction (190-192) to iterate the basket:

```ts
  // validate:
  const cost = computeConstructionCost(req);
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    if ((inv[r] ?? 0) < n) return { ok: false, reason: 'insufficient-materials' };
  }
```
```ts
  // construct (deduct):
  const cost = computeConstructionCost(req);
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    founderState.inventory[r] = (founderState.inventory[r] ?? 0) - n;
  }
```

(Match the exact local names `inv` / `founderState` at those sites.)

- [ ] **Step 4: Update the construction-cost UI display**

Find where the artificial-island construction cost is shown to the player (search `computeConstructionCost` callers in `src/settlement-ui.ts` / `src/construction-ui.ts` / wherever the "build island" flow surfaces the materials). Update the display to format the returned basket (steel_beam/concrete) instead of the old `steel/iron_ingot/wood` fields.

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run src/artificial-island.test.ts` (expect PASS; update any existing test asserting the old `steel/iron_ingot/wood` cost to the new basket).
Run: `npm run build` (expect clean — the `ConstructionCost` type change compiles through validate/deduct/UI).

- [ ] **Step 6: Commit**

```bash
git add src/artificial-island.ts src/artificial-island.test.ts src/settlement-ui.ts src/construction-ui.ts
git commit -m "feat(platform): construction cost = tileCount x LAND_TILE_COST (steel_beam)

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

(Adjust the `git add` list to the actual UI file(s) touched.)

---

### Task 6: SPEC.md prose + full-suite verification

**Files:**
- Modify: `SPEC.md` (§3.4 line ~370, §8.9, §2.5 artificial island)

- [ ] **Step 1: Update §3.4 reclamation cost prose**

In `SPEC.md`, replace the §3.4 sentence (~line 370) "Each Land Reclamation expansion adds 1 to either the major or the minor radius (player-chosen) at material cost that scales superlinearly with current radius." with:

```markdown
Each Land Reclamation expansion adds 1 to either the major or the minor radius (player-chosen) at a material cost equal to the number of new inscribed tiles gained × the shared per-land-tile structural basket (`LAND_TILE_COST`, `building-defs.ts`). Rotation cannot be changed after generation.
```
Remove the "(placeholders)" tag from the §3.4 max-size table heading (~line 359) if the rescale is now considered locked, OR leave it — your call; note which you did in the commit.

- [ ] **Step 2: Update §8.9 terrain-modifier + §2.5 artificial-island prose**

Find the §8.9 Terrain Modifier row/prose and add a sentence: mapping a tile to a rare resource costs 30 days of that resource's base extraction (`ceil(baseRate/s × 2,592,000)`), charged once per 16-tile shot and deducted upfront at placement; natural clears cost their per-tile basket × 16, also charged at placement. Find the §2.5 artificial-island cost prose and update it to `tileCount × LAND_TILE_COST × biome surcharge`.

- [ ] **Step 3: Full suite + build**

Run: `npm test` (expect ALL pass; if a stray test elsewhere asserted the old costs, fix that test's expectation to the new value — these are spec-driven number changes, not relaxations).
Run: `npm run build` (expect clean).

- [ ] **Step 4: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): SI-rescale action costs in SPEC §3.4/§8.9/§2.5

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** shared basket (T1), rare 30-day rule + base-rate lookup (T2), charge wiring (T3), reclamation tile-delta (T4), platform basket (T5), SPEC prose (T6). All spec sections map to a task.
- **Type consistency:** `LAND_TILE_COST` (T1) consumed in T4/T5; `conversionCostForTarget`/`rareShotCost` (T2) consumed in T3; `landReclamationCost(major,minor,axis)` and `inscribedTileCount` (T4) used identically in their tests + inspector; `computeConstructionCost`/`ConstructionCost` basket (T5) flows through validate/deduct/UI. The `LandReclamationCost` and `ConstructionCost` type widenings (single-field → basket) are each contained to their own task with the call sites updated in the same task (build stays green per task).
- **No migration:** all changes are cost computation; no serialized shape changes.
- **Verified data:** the T2 rare costs (copper 129,600 / uranium 754 / helium 1,728,000 / diamond 64,800 / oil 6,028) were computed from the real extractor `cycleSec` values confirmed against `recipes.ts`. `2,592,000 / 3440 = 753.49 → ceil 754`.
- **UI tendrils (T4 step 4, T5 step 4)** are pattern-based — the implementer reads the exact display call sites; the pure cost functions they read are fully TDD'd. Line numbers are approximate and drift as tasks land.
