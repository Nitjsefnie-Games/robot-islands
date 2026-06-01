# Relocate Buildings + Floor-Aware Demolish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let players relocate a building to a new valid tile on the same island for half its total invested cost (keeping all runtime state), and fix demolish to refund floor-upgrade investment — both via a shared `totalInvestedCost` helper.

**Architecture:** A pure `relocateBuilding()` in `placement.ts` mirrors `applyUpgrade()` (find → validate → charge → mutate); it reuses `validatePlacement()` extended with `ignoreBuildingId` (exclude self from overlap) and `skipCostGate` (relocate charges its own half-fee, not the full placement cost). `state.buildings` and `spec.buildings` are the same array reference (confirmed `world.ts:996`), so relocate mutates the building object in place. The inspector gets a Move button entering a relocate variant of the existing `placement-ui` ghost flow.

**Tech Stack:** Vite 5 + TypeScript strict + PixiJS 8 + vitest. Pure simulation layer is renderer-free and unit-tested; render/UI code (placement-ui, inspector-ui, main) is build-checked, not unit-tested (repo convention).

**Spec:** `docs/superpowers/specs/2026-06-01-relocate-buildings-design.md`

---

## File Structure

- **Modify** `src/placement.ts` — add `totalInvestedCost`; add `ignoreBuildingId` + `skipCostGate` params to `validatePlacement`; add `relocateBuilding` + `RelocateResult`; fix `demolishBuilding` to use `totalInvestedCost`.
- **Modify** `src/inspector-ui.ts` — fix the two demolish previews to use `totalInvestedCost`; add `onMove` dep + a Move button.
- **Modify** `src/placement-ui.ts` — add a relocate mode (`beginRelocate`) to the ghost flow.
- **Modify** `src/main.ts` — wire `onMove` to `beginRelocate` and rebuild layers on relocate commit.
- **Tests** `src/placement.test.ts` — `totalInvestedCost`, `validatePlacement` new params, `relocateBuilding`, floor-aware demolish.

No new files, no persistence migration.

---

### Task 1: `totalInvestedCost` helper

**Files:**
- Modify: `src/placement.ts` (add after `upgradeCost`, ~line 116)
- Test: `src/placement.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/placement.test.ts` (import `totalInvestedCost` from `'./placement.js'`; `BUILDING_DEFS` is available via `'./building-defs.js'`). `mine` has `placementCost: { stone: 200, wood: 80 }` (a 2×2 extraction def).

```ts
import { totalInvestedCost } from './placement.js';
import { BUILDING_DEFS } from './building-defs.js';

describe('totalInvestedCost', () => {
  const mineDef = BUILDING_DEFS.mine; // placementCost { stone: 200, wood: 80 }

  it('floor 0 → base placement cost', () => {
    const b = { id: 'm', defId: 'mine', x: 0, y: 0 } as never;
    expect(totalInvestedCost(b, mineDef)).toEqual({ stone: 200, wood: 80 });
  });

  it('floor 3 → base + 3 × ceil(0.8 × base) per resource', () => {
    // upgrade per floor = ceil(0.8×200)=160 stone, ceil(0.8×80)=64 wood.
    // floor 3: stone 200+3×160=680; wood 80+3×64=272.
    const b = { id: 'm', defId: 'mine', x: 0, y: 0, floorLevel: 3 } as never;
    expect(totalInvestedCost(b, mineDef)).toEqual({ stone: 680, wood: 272 });
  });

  it('undefined floorLevel is treated as 0', () => {
    const b = { id: 'm', defId: 'mine', x: 0, y: 0 } as never;
    expect(totalInvestedCost(b, mineDef)).toEqual({ stone: 200, wood: 80 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/placement.test.ts -t "totalInvestedCost"`
Expected: FAIL — `totalInvestedCost` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/placement.ts`, ensure `floorLevel` is imported from `'./buildings.js'` (the file already imports `floorScaledCapacity` from there — add `floorLevel` to that import). Add after `upgradeCost` (~line 116):

```ts
/** Pure: a building's TOTAL invested resources = base placementCost plus the
 *  per-floor upgrade cost (`ceil(0.8 × base)`) times its floor level. Shared
 *  by relocate (half this is the move fee) and demolish (refund/scrap are
 *  fractions of this). Floor 0 ⇒ just the base cost. */
export function totalInvestedCost(
  b: { readonly floorLevel?: number },
  def: BuildingDef,
): Partial<Record<ResourceId, number>> {
  const base = placementCostFor(def);
  const up = upgradeCost(def);
  const L = floorLevel(b);
  const out: Partial<Record<ResourceId, number>> = {};
  for (const [r, n] of Object.entries(base) as Array<[ResourceId, number]>) {
    out[r] = n + L * (up[r] ?? 0);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/placement.test.ts -t "totalInvestedCost"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/placement.ts src/placement.test.ts
git commit -m "feat(placement): add totalInvestedCost helper

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 2: `validatePlacement` gains `ignoreBuildingId` + `skipCostGate`

**Files:**
- Modify: `src/placement.ts` (`validatePlacement`, lines 194-331)
- Test: `src/placement.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/placement.test.ts`. Use the existing test helpers for building a spec/state — mirror how other `validatePlacement` tests in this file construct their `spec`/`state` (search the file for an existing `validatePlacement(` test and copy its fixture setup). The two new behaviours:

```ts
describe('validatePlacement — ignoreBuildingId + skipCostGate', () => {
  // Build a spec/state with one 2×2 mine at (0,0) on an ore-rich test island.
  // Reuse this file's existing fixture pattern (terrainAt returning 'ore',
  // large radii, inventory funded). Pseudocode for the two asserts:

  it('ignoreBuildingId excludes that building from the overlap check', () => {
    // Placing a mine onto tiles overlapping building "m1" normally → 'overlap'.
    // With ignoreBuildingId: 'm1', the same spot is allowed (geometry-wise).
    // ... set up spec with mine 'm1' at (0,0); validate a mine at (1,0):
    //   without ignore → reason 'overlap'
    //   with ignore 'm1' (+ skipCostGate to avoid cost noise) → ok true
  });

  it('skipCostGate bypasses the §14 affordability gate', () => {
    // Empty inventory, valid geometry. Without skipCostGate →
    // 'insufficient-resources'. With skipCostGate true → ok true.
  });
});
```

Write the two cases concretely against this file's fixture style (the spec/state builders already exist in `placement.test.ts`; do not invent new ones — read an existing `validatePlacement` test and reuse its `makeSpec`/`makeState`/`terrainAt` setup). Each asserts the `ok`/`reason` pair described in the comments.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/placement.test.ts -t "ignoreBuildingId"`
Expected: FAIL — `validatePlacement` doesn't accept the extra args, so they're ignored and the overlap/cost gates still fire.

- [ ] **Step 3: Add the parameters**

In `src/placement.ts`, change the `validatePlacement` signature (line 194-202) to append two optional params after `graph`:

```ts
export function validatePlacement(
  spec: IslandSpec,
  state: IslandState,
  defId: BuildingDefId,
  anchorX: number,
  anchorY: number,
  rotation: Rotation,
  graph: Graph = DEFAULT_GRAPH,
  ignoreBuildingId?: string,
  skipCostGate?: boolean,
): PlacementValidation {
```

In the overlap loop (line 243), skip the ignored building:

```ts
  for (const existing of spec.buildings) {
    if (existing.id === ignoreBuildingId) continue;
    const existingDef = BUILDING_DEFS[existing.defId];
```

In the terrain-modifier brush loop (line 305), also skip it:

```ts
    for (const b of state.buildings) {
      if (b.id === ignoreBuildingId) continue;
      const bdef = BUILDING_DEFS[b.defId];
```

Guard the §14 cost gate (lines 325-329) with `skipCostGate`:

```ts
  if (!skipCostGate) {
    const cost = placementCostFor(def);
    const missing = affordabilityShortfall(state.inventory, cost);
    if (Object.keys(missing).length > 0) {
      return { ok: false, reason: 'insufficient-resources', missing };
    }
  }
  return { ok: true };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/placement.test.ts -t "ignoreBuildingId"`
Then the full file to confirm no regression: `npx vitest run src/placement.test.ts`
Expected: PASS (existing callers pass neither new arg, so behaviour is unchanged for them).

- [ ] **Step 5: Commit**

```bash
git add src/placement.ts src/placement.test.ts
git commit -m "feat(placement): validatePlacement ignoreBuildingId + skipCostGate

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 3: `relocateBuilding`

**Files:**
- Modify: `src/placement.ts` (add `RelocateResult` near the other result types ~line 333; add `relocateBuilding` after `applyUpgrade`, ~line 795)
- Test: `src/placement.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/placement.test.ts` (import `relocateBuilding`). Reuse this file's spec/state fixture pattern (mine on an ore island, funded inventory). Cases:

```ts
describe('relocateBuilding', () => {
  // helper: spec with one 2×2 mine 'm1' at (0,0); ore terrain everywhere;
  // state inventory funded with stone+wood. Mirror existing fixtures here.

  it('moves the building and charges floor(0.5 × totalInvested)', () => {
    // mine floor 0: total { stone:200, wood:80 } → fee { stone:100, wood:40 }.
    // Move 'm1' from (0,0) to (4,0). Expect ok, charged {stone:100,wood:40},
    // inventory reduced by exactly that, and the building's x/y now 4/0.
    // All other fields (id, defId, floorLevel) unchanged; no NEW building added
    // (spec.buildings.length stays 1).
  });

  it('allows a 1-tile shift overlapping its own current footprint', () => {
    // Move 'm1' from (0,0) to (1,0) — footprints overlap, but ignoreBuildingId
    // excludes self → ok true.
  });

  it('rejects overlap with ANOTHER building', () => {
    // Add a second mine 'm2' at (4,0). Move 'm1' onto (4,0) → reason 'overlap',
    // inventory unchanged, 'm1' still at (0,0).
  });

  it('rejects when destination fails the terrain requiredTile', () => {
    // terrainAt returns 'grass' at the target tiles → reason
    // 'tile-requirement-not-met'; inventory unchanged.
  });

  it('rejects insufficient-resources for the fee and does not move', () => {
    // Empty inventory → reason 'insufficient-resources'; 'm1' still at (0,0).
  });

  it('returns not-found for an unknown id', () => {
    expect(relocateBuilding(spec, state, 'nope', 4, 0).ok).toBe(false);
    // reason 'not-found'
  });
});
```

Write these concretely against the file's fixtures.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/placement.test.ts -t "relocateBuilding"`
Expected: FAIL — `relocateBuilding` not exported.

- [ ] **Step 3: Implement**

In `src/placement.ts`, add the result type near the other result interfaces (after `PlacementValidation`, ~line 90, or beside `UpgradeResult`):

```ts
export type RelocateResult =
  | { readonly ok: true; readonly charged: Partial<Record<ResourceId, number>> }
  | {
      readonly ok: false;
      readonly reason: PlacementReason | 'not-found';
      readonly missing?: Partial<Record<ResourceId, number>>;
    };
```

Add the function (mirrors `applyUpgrade`'s structure), after `applyUpgrade` (~line 795):

```ts
/** Relocate an existing building to a new tile on the SAME island for a fee of
 *  half its total invested cost. Validates geometry/terrain via
 *  `validatePlacement` (ignoring the building's own footprint, skipping the
 *  full-cost gate), then charges the half-fee and mutates x/y/rotation in
 *  place. All other runtime state (floorLevel, constructionRemainingMs,
 *  maintenance timers, cargoLabel, disabled) persists. `spec.buildings` and
 *  `state.buildings` are the same array (makeInitialIslandState), so the
 *  in-place mutation is visible to the next tick. */
export function relocateBuilding(
  spec: IslandSpec,
  state: IslandState,
  id: string,
  newX: number,
  newY: number,
  rotation?: Rotation,
): RelocateResult {
  const b = spec.buildings.find((bb) => bb.id === id);
  if (!b) return { ok: false, reason: 'not-found' };
  const def = BUILDING_DEFS[b.defId];
  const rot = (rotation ?? b.rotation ?? 0) as Rotation;
  const v = validatePlacement(spec, state, b.defId, newX, newY, rot, DEFAULT_GRAPH, id, true);
  if (!v.ok) {
    return { ok: false, reason: v.reason ?? 'overlap', missing: v.missing };
  }
  // Fee = floor(0.5 × total invested), per resource.
  const fee: Partial<Record<ResourceId, number>> = {};
  for (const [r, n] of Object.entries(totalInvestedCost(b, def)) as Array<[ResourceId, number]>) {
    const half = Math.floor(n / 2);
    if (half > 0) fee[r] = half;
  }
  const missing = affordabilityShortfall(state.inventory, fee);
  if (Object.keys(missing).length > 0) {
    return { ok: false, reason: 'insufficient-resources', missing };
  }
  for (const [r, n] of Object.entries(fee) as Array<[ResourceId, number]>) {
    state.inventory[r] = (state.inventory[r] ?? 0) - n;
  }
  const mut = b as { x: number; y: number; rotation?: Rotation };
  mut.x = newX;
  mut.y = newY;
  mut.rotation = rot;
  return { ok: true, charged: fee };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/placement.test.ts -t "relocateBuilding"`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/placement.ts src/placement.test.ts
git commit -m "feat(placement): add relocateBuilding (same-island, half-fee)

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 4: Floor-aware demolish + inspector previews

**Files:**
- Modify: `src/placement.ts` (`demolishBuilding`, line 808)
- Modify: `src/inspector-ui.ts` (`previewScrapForBuilding` 110, `previewRefundForBuilding` 122, call sites 1084 + 1718)
- Test: `src/placement.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/placement.test.ts`. Reuse the demolish fixtures already in this file (find an existing `demolishBuilding` test and copy its spec/state setup; fund storage caps so refunds aren't cap-clamped).

```ts
describe('demolishBuilding — floor-aware refund/scrap', () => {
  // mine 'm1', placementCost { stone:200, wood:80 }. At floor 2, total invested
  // = stone 200+2×160=520, wood 80+2×64=208. Refund = floor(/2) = stone 260,
  // wood 104. Scrap = floor(0.3 × (520+208)) = floor(218.4) = 218.
  it('refund and scrap scale with floor level', () => {
    // Place mine 'm1' at floor 2 with generous storage caps + empty stockpiles.
    // demolishBuilding → result.refunded { stone:260, wood:104 },
    //   result.scrapReturned 218. (Contrast floor 0: refund {stone:100,wood:40},
    //   scrap floor(0.3×280)=84.)
  });

  it('floor 0 matches the pre-change base-cost values', () => {
    // mine 'm1' floor 0 → refunded {stone:100,wood:40}, scrapReturned 84.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/placement.test.ts -t "floor-aware refund"`
Expected: FAIL — demolish currently uses base cost, so the floor-2 case returns base refund/scrap, not the higher floor-adjusted values.

- [ ] **Step 3: Fix demolish + previews**

In `src/placement.ts` `demolishBuilding`, change line 808 from:

```ts
  const cost = placementCostFor(def);
```
to:
```ts
  const cost = totalInvestedCost(b, def);
```

(Everything downstream — `costSum`, `scrapReturned`, the refund loop — already reads `cost`, so this one line makes scrap and refund floor-aware.)

In `src/inspector-ui.ts`, make `previewScrapForBuilding` take the building (it needs `floorLevel`) and use `totalInvestedCost`. Replace lines 108-115:

```ts
/** Preview the §6.7 scrap credit for a building. Mirrors the
 *  `floor(sum(totalInvestedCost) * 0.3)` computation `demolishBuilding` applies. */
function previewScrapForBuilding(b: PlacedBuilding): number {
  const def = BUILDING_DEFS[b.defId];
  const cost = totalInvestedCost(b, def);
  const costSum = Object.values(cost).reduce((sum, n) => sum + n, 0);
  return Math.floor(costSum * 0.3);
}
```

Replace `previewRefundForBuilding` body (lines 122-132) to use `totalInvestedCost`:

```ts
function previewRefundForBuilding(b: PlacedBuilding): Partial<Record<ResourceId, number>> {
  const def = BUILDING_DEFS[b.defId];
  const cost = totalInvestedCost(b, def);
  const out: Partial<Record<ResourceId, number>> = {};
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    if (n <= 0) continue;
    const half = Math.floor(n / 2);
    if (half > 0) out[r as ResourceId] = half;
  }
  return out;
}
```

Add `totalInvestedCost` to the `'./placement.js'` import in `inspector-ui.ts`. Update the two `previewScrapForBuilding` call sites to pass the building:
- Line 1084: `const credit = previewScrapForBuilding(target.building.defId);` → `previewScrapForBuilding(target.building);`
- Line 1718: `const credit = previewScrapForBuilding(building.defId);` → `previewScrapForBuilding(building);` (confirm the local variable name at that site — it is `building`; adjust if the in-scope variable differs).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/placement.test.ts -t "floor-aware"`
Then build: `npm run build`
Expected: tests PASS; `tsc -b` clean (previews compile with the new signature; no other caller of `previewScrapForBuilding` remains on the old `defId` signature — confirm with `grep -n "previewScrapForBuilding" src/inspector-ui.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/placement.ts src/inspector-ui.ts src/placement.test.ts
git commit -m "fix(demolish): account for floor-upgrade investment in refund/scrap

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 5: Relocate mode in `placement-ui`

**Files:**
- Modify: `src/placement-ui.ts` (`mountPlacementUi`, the handle + `begin`/`paintOutlineAndLabel`/`attemptCommit`/`cancel`)

This is render/UI glue (not unit-tested per repo convention). Verify by `npm run build` + a browser smoke test.

- [ ] **Step 1: Add relocate state + `beginRelocate` to the handle**

In `src/placement-ui.ts`, inside `mountPlacementUi` add module-scoped state beside `let rotation: Rotation = 0;` (line 215):

```ts
  // Non-null while relocating an existing building (vs. placing a new one).
  let relocating: PlacedBuilding | null = null;
```

Add a `beginRelocate(building)` method to the returned `PlacementUiHandle` (and declare it on the `PlacementUiHandle` interface ~line 76). It arms the ghost from the building's own def + rotation, WITHOUT the cargo-label / terrain-target pickers `begin()` runs (relocate keeps the existing label/state):

```ts
  function beginRelocate(building: PlacedBuilding): void {
    cancel();                       // clear any in-flight placement
    relocating = building;
    defId = building.defId;         // same field begin() sets for the ghost def
    rotation = (building.rotation ?? 0) as Rotation;
    armed = true;                   // mirror begin()'s arm flag (use the file's actual flag name)
    paintOutlineAndLabel();
  }
```

Read `begin()` (line 484) to match its exact arming bookkeeping (the `armed`/`activeDefId` field names, cursor seeding) and replicate only the geometry-arming parts — skip the picker promises.

- [ ] **Step 2: Branch validation in `paintOutlineAndLabel`**

In `paintOutlineAndLabel` the validity call is `validatePlacement(...)` at ~line 294. When `relocating`, pass `ignoreBuildingId` + `skipCostGate`, and compute the relocate fee for the label instead of the placement cost:

```ts
    const v = relocating
      ? validatePlacement(spec, state, defId, localX, localY, rotation, DEFAULT_GRAPH, relocating.id, true)
      : validatePlacement(spec, state, defId, localX, localY, rotation);
```

For the cost label while relocating, compute `floor(0.5 × totalInvestedCost(relocating, def))` and check `affordabilityShortfall(state.inventory, fee)` to drive the red/green "fee" display (reuse the existing cost-row rendering, swapping the basket). Import `totalInvestedCost` and `affordabilityShortfall` from `'./placement.js'`.

- [ ] **Step 3: Branch commit in `attemptCommit`**

In `attemptCommit` (line 588), before the land `placeBuilding` path (line 704-726), add a relocate branch:

```ts
    if (relocating) {
      const v = validatePlacement(spec, state, defId, localX, localY, rotation, DEFAULT_GRAPH, relocating.id, true);
      if (!v.ok) { recordRejection(); return { committed: false }; } // match the existing return shape
      const result = relocateBuilding(spec, state, relocating.id, localX, localY, rotation);
      if (!result.ok) { recordRejection(); return { committed: false }; }
      deps.onRelocated?.();         // rebuild layers (new optional dep; see Task 6 / main.ts)
      cancel();
      return { committed: true };   // match attemptCommit's actual return type
    }
```

Read `attemptCommit`'s real return type and the `recordRejection()` helper (line 595) to match shapes exactly. Import `relocateBuilding` from `'./placement.js'`.

- [ ] **Step 4: Clear relocate state in `cancel`**

In `cancel()` (line 553), add `relocating = null;` alongside the other resets.

- [ ] **Step 5: Add the `onRelocated` dep**

On the `PlacementUiDeps` interface (~line 119), add:

```ts
  /** Called after a successful relocate commit so the host can rebuild world
   *  layers (mirrors the post-placement rebuild). Optional. */
  onRelocated?: () => void;
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: `tsc -b` clean.

- [ ] **Step 7: Commit**

```bash
git add src/placement-ui.ts
git commit -m "feat(placement-ui): relocate-mode ghost flow

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

### Task 6: Inspector Move button + main.ts wiring (end-to-end)

**Files:**
- Modify: `src/inspector-ui.ts` (`InspectorDeps` ~line 168; footer button ~line 1110; refresh label ~line 1718)
- Modify: `src/main.ts` (`InspectorDeps` impl ~line 1248; `mountPlacementUi` deps)

Combined into one task because adding a required `onMove` dep breaks `main.ts` compilation until it's implemented — landing both keeps the build green.

- [ ] **Step 1: Add `onMove` to `InspectorDeps`**

In `src/inspector-ui.ts`, in the `InspectorDeps` interface (beside `onDemolish`, line 180):

```ts
  onMove(target: InspectorTarget): void;
```

- [ ] **Step 2: Add the Move button (mirror the demolish button)**

After the demolish button is appended (line 1110), add a Move button. Compute the fee with a small local helper near the other previews (~line 132):

```ts
/** Preview the relocate fee = floor(0.5 × totalInvestedCost) per resource. */
function previewRelocateFee(b: PlacedBuilding): Partial<Record<ResourceId, number>> {
  const def = BUILDING_DEFS[b.defId];
  const out: Partial<Record<ResourceId, number>> = {};
  for (const [r, n] of Object.entries(totalInvestedCost(b, def)) as Array<[ResourceId, number]>) {
    const half = Math.floor(n / 2);
    if (half > 0) out[r as ResourceId] = half;
  }
  return out;
}
```

Button (model on `demolishBtn`, lines 1069-1110; use a neutral accent colour `var(--ri-accent)` rather than warn):

```ts
  const moveBtn = document.createElement('button');
  styled(
    moveBtn,
    [
      `color: ${'var(--ri-accent)'}`,
      'padding: 5px 10px',
      'font-family: ui-monospace, monospace',
      'font-size: 11px',
      'letter-spacing: 0.14em',
      'text-transform: uppercase',
    ].join(';'),
  );
  moveBtn.classList.add('ri-btn'); // use the file's neutral button class (check demolish/refresh for the class names)
  moveBtn.addEventListener('click', () => {
    if (!target) return;
    deps.onMove(target);
  });
  footerSection.appendChild(moveBtn);
```

- [ ] **Step 3: Update the Move button label each refresh**

In the refresh block where `demolishBtn.textContent` is set (line 1718-1719), set the move label with the fee (format with the existing `formatRefund`-style helper or inline). Example:

```ts
    const fee = previewRelocateFee(building);
    const feeStr = Object.entries(fee)
      .map(([r, n]) => `${n} ${r.toUpperCase().replace(/_/g, ' ')}`)
      .join(', ');
    moveBtn.textContent = feeStr ? `✥ MOVE · −${feeStr}` : '✥ MOVE';
    // Grey out when unaffordable (mirror how other buttons disable, if any):
    const cantAfford = Object.keys(affordabilityShortfall(building's island state.inventory, fee)).length > 0;
    moveBtn.disabled = cantAfford;
    moveBtn.style.opacity = cantAfford ? '0.5' : '1';
```

Use the in-scope state/inventory variable name at that refresh site (read lines ~1700-1720 for the exact locals; the demolish label uses `building` — the inventory is reachable via the same `target`/`state` in scope). Import `affordabilityShortfall` + `totalInvestedCost` from `'./placement.js'` if not already.

- [ ] **Step 4: Implement `onMove` in `main.ts`**

In `src/main.ts`, where the `InspectorDeps` object is built (beside `onDemolish`, ~line 1248), add:

```ts
  onMove: (target: InspectorTarget) => {
    inspector.close();
    placement.beginRelocate(target.building); // `placement` = the mountPlacementUi handle
  },
```

Use the actual local name of the `mountPlacementUi(...)` handle in `main.ts` (search for `mountPlacementUi(` — assign/rename as needed). Then wire the placement deps' `onRelocated` to the same world-rebuild used after placement and after demolish:

```ts
  // in the mountPlacementUi({ ... }) deps object:
  onRelocated: () => { rebuildWorldLayers(); },
```

(Use the exact rebuild function `onDemolish` calls — `rebuildWorldLayers()` per main.ts:1261.)

- [ ] **Step 5: Build + full test suite**

Run: `npm run build`
Then: `npm test`
Expected: `tsc -b` clean; full suite passes (pure relocate/demolish logic already covered in Tasks 1-4; UI is build-checked).

- [ ] **Step 6: Browser smoke test**

`npm run build`, reload `https://islands.nitjsefni.eu/`, select a building, click **Move**, move the ghost to a valid tile, click to confirm. Verify via `mcp__daedalus__screenshot`: the building appears at the new tile, the fee was deducted (HUD inventory), and an invalid tile (overlap/wrong terrain) shows the red ghost and refuses to commit.

- [ ] **Step 7: Commit**

```bash
git add src/inspector-ui.ts src/main.ts
git commit -m "feat(inspector): Move button wired to relocate-mode

Co-Authored-By: <Your Model Name> <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** shared helper (T1), validator extension (T2), relocate (T3), floor-aware demolish + previews (T4), relocate-mode UI (T5), Move button + wiring (T6). Every spec section maps to a task.
- **Type consistency:** `totalInvestedCost(b, def)` (T1) is consumed identically in T3 (relocate fee), T4 (demolish + previews), T5/T6 (fee label). `validatePlacement(..., ignoreBuildingId, skipCostGate)` (T2) is called the same way in T3 and T5. `relocateBuilding(spec, state, id, x, y, rotation?)` (T3) is called in T5's commit. `onMove`/`beginRelocate`/`onRelocated` names are consistent across T5/T6.
- **No migration:** relocate mutates x/y of an existing serialized building; demolish changes amounts only. Confirmed.
- **UI tasks (T5/T6)** intentionally lean on patterns + anchors rather than full verbatim code because the surrounding render/PixiJS code is read-and-adapt (not unit-tested); the implementer must read the cited line ranges to match exact local names (`armed`/`activeDefId` flag, `attemptCommit` return shape, the refresh-site inventory local, the `mountPlacementUi` handle name). Line numbers are approximate and will drift as earlier tasks land.
