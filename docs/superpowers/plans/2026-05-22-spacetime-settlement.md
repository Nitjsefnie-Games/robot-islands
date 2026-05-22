# Spacetime Anchor instant settlement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A T5 island with a Spacetime Anchor can instantly populate any discovered island for one `foundation_kit_refined` — no vehicle, no fuel, no transit (SPEC §12.6).

**Architecture:** Extract the island-populate block from `tickVehicles` into a shared pure helper `populateSettledIsland`. Add a pure `settleViaSpacetimeAnchor` (gates + kit consume + populate) and an `originCanAnchorSettle` predicate. `settlement-ui.ts` gains an `anchor` dispatch kind; the kind-button row becomes building-gated (each kind shown only when the origin has its launch building).

**Tech Stack:** TypeScript (strict), Vite 5, PixiJS 8, vitest. Pure layer unit-tested; UI verified by clean build + daedalus.

**Spec:** `docs/superpowers/specs/2026-05-22-spacetime-settlement-design.md`

---

## File structure

| File | Change |
|---|---|
| `src/settlement.ts` | Extract `populateSettledIsland` from `tickVehicles`; add `originCanAnchorSettle` + `settleViaSpacetimeAnchor` + the `SpacetimeSettleResult` type. |
| `src/settlement.test.ts` | New tests for `settleViaSpacetimeAnchor` / `originCanAnchorSettle`; existing `tickVehicles` tests must still pass (behavior-preserving extraction). |
| `src/settlement-ui.ts` | `anchor` dispatch kind; dynamic building-gated kind row; commit routes to `settleViaSpacetimeAnchor`. |
| `src/main.ts` | Wire a post-settle world-layer rebuild for the instant-settle path. |

---

## Task 1: Extract `populateSettledIsland` from `tickVehicles`

Behavior-preserving refactor — no new behavior. Verified by the existing settlement test suite staying green.

**Files:**
- Modify: `src/settlement.ts` (`tickVehicles` arrival block, ~line 616-674)
- Test: `src/settlement.test.ts` (existing tests only)

- [ ] **Step 1: Add the helper**

In `src/settlement.ts`, add this function immediately **before** `tickVehicles`:

```ts
/** Populate a freshly-settled island: flip `populated`, auto-place the dock,
 *  push the tier's starter buildings, build + register the IslandState, run
 *  §9.6 Auto-Patronage, decompose the Foundation Kit(s) into colony
 *  inventory, and grant §12.6 free skill points. Shared by vehicle arrival
 *  (`tickVehicles`) and Spacetime Anchor instant-settle
 *  (`settleViaSpacetimeAnchor`).
 *
 *  `kind` / `tier` drive the dock def + starter loadout exactly as a vehicle
 *  arrival would; `foundationKitCount` drives the §12.4 kit decomposition.
 *  The caller must have already confirmed `target` is unpopulated. */
function populateSettledIsland(
  world: WorldState,
  islandStates: Map<string, IslandState>,
  target: IslandSpec,
  kind: VehicleKind,
  tier: VehicleTier,
  foundationKitCount: number,
  nowMs: number,
): void {
  target.populated = true;
  const autoBuildingDefId = kind === 'ship' ? 'dock' : 'helipad';
  const dropTile = kind === 'ship' ? findCoastalTile(target) : { x: 0, y: 0 };
  target.buildings.push({
    id: `${target.id}-auto-${autoBuildingDefId}-1`,
    defId: autoBuildingDefId,
    x: dropTile.x,
    y: dropTile.y,
  });

  const starters = computeStarterBuildings(kind, tier, target);
  for (const b of starters) {
    target.buildings.push({ id: `${target.id}-starter-${b.defId}`, defId: b.defId, x: b.x, y: b.y });
  }

  const newState = makeInitialIslandState(target, nowMs);
  islandStates.set(target.id, newState);

  // §9.6 / §12.7 Auto-Patronage.
  world.islandStates = islandStates;
  const ncState = computeNcState(world);
  if (ncState.milestone >= 3) {
    spawnAutoPatronageRoutes(world, target.id);
  }

  // §12.4 Foundation Kit decomposition: credit recipe inputs to the colony.
  const kitRecipe = RECIPES['kit_assembler'];
  if (kitRecipe) {
    for (const [r, amount] of Object.entries(kitRecipe.inputs)) {
      const id = r as ResourceId;
      const total = (amount ?? 0) * foundationKitCount;
      if (total > 0) {
        newState.inventory[id] = (newState.inventory[id] ?? 0) + total;
        newState.starterInventoryGrace[id] =
          (newState.starterInventoryGrace[id] ?? 0) + total;
      }
    }
  }

  // §12.6 free skill points for T3+ arrivals.
  const freePoints = computeFreeSkillPoints(tier);
  if (freePoints > 0) {
    newState.unspentSkillPoints += freePoints;
  }
}
```

This is the verbatim arrival block (`settlement.ts` ~616-674) lifted into a function, with `v.kind`/`v.tier`/`v.foundationKitCount` replaced by the parameters `kind`/`tier`/`foundationKitCount`.

- [ ] **Step 2: Call it from `tickVehicles`**

In `tickVehicles`, replace the inline arrival block — everything from `// Mutate spec: populated + auto-placed building.` / `target.populated = true;` down through the `§12.6 free skill points` block (`newState.unspentSkillPoints += freePoints;`) — with a single call:

```ts
    // Populate the target (shared with the Spacetime Anchor instant path).
    populateSettledIsland(world, islandStates, target, v.kind, v.tier, v.foundationKitCount, nowMs);
```

Leave the lines that follow unchanged:

```ts
    v.status = 'arrived';
    arrivals.push({ targetIslandId: target.id, fromIslandId: v.from, kind: v.kind });
    remaining.push(v);
```

(The `if (target.populated) { ... continue; }` race-guard above the block also stays unchanged.)

- [ ] **Step 3: Run the settlement suite to verify nothing changed**

Run: `npx vitest run src/settlement.test.ts`
Expected: PASS — all existing tests green. The extraction is behavior-preserving; any failure means the lift was not verbatim.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS — all test files.

- [ ] **Step 5: Commit**

```bash
git add src/settlement.ts
git commit -m "refactor(settlement): extract populateSettledIsland from tickVehicles

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 2: `originCanAnchorSettle` + `settleViaSpacetimeAnchor`

**Files:**
- Modify: `src/settlement.ts` (add after `populateSettledIsland` / near `hasLaunchBuildingFor`)
- Test: `src/settlement.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/settlement.test.ts`. These use the file's existing `makeIslandSpec`, `makeIslandState`, `freshWorld` helpers:

```ts
describe('originCanAnchorSettle', () => {
  it('is true only when the spec has a spacetime_anchor building', () => {
    const bare = makeIslandSpec({ id: 'o' });
    expect(originCanAnchorSettle(bare)).toBe(false);
    const withAnchor = makeIslandSpec({
      id: 'o',
      buildings: [{ id: 'a1', defId: 'spacetime_anchor', x: 0, y: 0 }],
    });
    expect(originCanAnchorSettle(withAnchor)).toBe(true);
  });
});

describe('settleViaSpacetimeAnchor', () => {
  function setup(opts: { anchor: boolean; kits: number; targetDiscovered: boolean; targetPopulated: boolean }) {
    const origin = makeIslandSpec({
      id: 'origin',
      populated: true,
      buildings: opts.anchor ? [{ id: 'a1', defId: 'spacetime_anchor', x: 0, y: 0 }] : [],
    });
    const target = makeIslandSpec({
      id: 'target',
      discovered: opts.targetDiscovered,
      populated: opts.targetPopulated,
    });
    const world = freshWorld([origin, target]);
    const originState = makeIslandState({ id: 'origin' });
    originState.inventory.foundation_kit_refined = opts.kits;
    const islandStates = new Map<string, IslandState>([['origin', originState]]);
    return { world, islandStates, origin, target, originState };
  }

  it('settles the target: consumes 1 Refined kit, populates, creates IslandState', () => {
    const s = setup({ anchor: true, kits: 1, targetDiscovered: true, targetPopulated: false });
    const res = settleViaSpacetimeAnchor(s.world, s.islandStates, 'origin', 'target', 5000);
    expect(res.ok).toBe(true);
    expect(s.originState.inventory.foundation_kit_refined).toBe(0);
    expect(s.target.populated).toBe(true);
    expect(s.islandStates.has('target')).toBe(true);
    expect(s.world.vehicles.length).toBe(0); // no vehicle created
  });

  it('refuses and mutates nothing when the origin has no Spacetime Anchor', () => {
    const s = setup({ anchor: false, kits: 1, targetDiscovered: true, targetPopulated: false });
    const res = settleViaSpacetimeAnchor(s.world, s.islandStates, 'origin', 'target', 5000);
    expect(res.ok).toBe(false);
    expect(s.originState.inventory.foundation_kit_refined).toBe(1);
    expect(s.target.populated).toBe(false);
    expect(s.islandStates.has('target')).toBe(false);
  });

  it('refuses when the origin has no Refined kit', () => {
    const s = setup({ anchor: true, kits: 0, targetDiscovered: true, targetPopulated: false });
    expect(settleViaSpacetimeAnchor(s.world, s.islandStates, 'origin', 'target', 5000).ok).toBe(false);
    expect(s.target.populated).toBe(false);
  });

  it('refuses when the target is already populated', () => {
    const s = setup({ anchor: true, kits: 1, targetDiscovered: true, targetPopulated: true });
    const res = settleViaSpacetimeAnchor(s.world, s.islandStates, 'origin', 'target', 5000);
    expect(res.ok).toBe(false);
    expect(s.originState.inventory.foundation_kit_refined).toBe(1);
  });

  it('refuses when the target is not discovered', () => {
    const s = setup({ anchor: true, kits: 1, targetDiscovered: false, targetPopulated: false });
    const res = settleViaSpacetimeAnchor(s.world, s.islandStates, 'origin', 'target', 5000);
    expect(res.ok).toBe(false);
    expect(s.originState.inventory.foundation_kit_refined).toBe(1);
  });
});
```

Add `originCanAnchorSettle` and `settleViaSpacetimeAnchor` to the test file's `import { ... } from './settlement.js'` block.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/settlement.test.ts -t "originCanAnchorSettle|settleViaSpacetimeAnchor"`
Expected: FAIL — `originCanAnchorSettle is not a function`.

- [ ] **Step 3: Implement**

In `src/settlement.ts`, add:

```ts
/** Whether `origin` can launch a Spacetime Anchor instant-settle — i.e. it
 *  has a `spacetime_anchor` building. The `anchor`-kind sibling of
 *  `hasLaunchBuildingFor`. */
export function originCanAnchorSettle(origin: IslandSpec): boolean {
  return origin.buildings.some((b) => b.defId === 'spacetime_anchor');
}

export type SpacetimeSettleResult =
  | { ok: true }
  | { ok: false; reason: string };

/** §12.6 — instant T5 settlement via a Spacetime Anchor. Re-checks every
 *  gate, consumes one `foundation_kit_refined` from the origin island's
 *  inventory, and populates the target via `populateSettledIsland` with the
 *  richest (T4-ship-equivalent) loadout. No vehicle, no fuel, no transit.
 *  Returns `{ ok: false }` WITHOUT mutating anything on any gate failure. */
export function settleViaSpacetimeAnchor(
  world: WorldState,
  islandStates: Map<string, IslandState>,
  originId: string,
  targetId: string,
  nowMs: number,
): SpacetimeSettleResult {
  const originSpec = world.islands.find((s) => s.id === originId);
  const originState = islandStates.get(originId);
  if (!originSpec || !originState) return { ok: false, reason: 'origin missing' };
  if (!originCanAnchorSettle(originSpec)) {
    return { ok: false, reason: 'no Spacetime Anchor on origin' };
  }
  if ((originState.inventory.foundation_kit_refined ?? 0) < 1) {
    return { ok: false, reason: 'need 1 Refined Foundation Kit' };
  }
  const targetSpec = world.islands.find((s) => s.id === targetId);
  if (!targetSpec) return { ok: false, reason: 'target missing' };
  if (!targetSpec.discovered) return { ok: false, reason: 'target not discovered' };
  if (targetSpec.populated) return { ok: false, reason: 'target already populated' };

  originState.inventory.foundation_kit_refined =
    (originState.inventory.foundation_kit_refined ?? 0) - 1;
  // Richest loadout per §12.3: T4 ship-equivalent dock + starters, one kit.
  populateSettledIsland(world, islandStates, targetSpec, 'ship', 4, 1, nowMs);
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/settlement.test.ts`
Expected: PASS — all settlement tests, including the new blocks.

- [ ] **Step 5: Commit**

```bash
git add src/settlement.ts src/settlement.test.ts
git commit -m "feat(settlement): settleViaSpacetimeAnchor — §12.6 instant settlement

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 3: `anchor` dispatch kind in the settlement UI

Render/integration task — no unit test; verified by clean build + a daedalus live check.

**Files:**
- Modify: `src/settlement-ui.ts` (kind type, `kindBtn`/`kindRow`, the per-origin refresh, the fuel/range rows, the commit path `attemptLaunch`, `SettlementUiDeps`)
- Modify: `src/main.ts` (wire the post-instant-settle layer rebuild)

- [ ] **Step 1: UI-local kind type**

In `src/settlement-ui.ts`, the panel's `kind` state is typed `VehicleKind` (`'ship' | 'helicopter'`). Introduce a UI-local widening — do NOT change the exported `VehicleKind` in `settlement.ts` (a persisted `SettlementVehicle.kind` must stay `ship | helicopter`; `anchor` never creates a vehicle):

```ts
type DispatchKind = VehicleKind | 'anchor';
```

Change the panel's `let kind: VehicleKind = 'ship';` to `let kind: DispatchKind = 'ship';`. `kindBtn` and the kind-change handler take `DispatchKind`.

- [ ] **Step 2: Add the ANCHOR kind button**

Alongside the existing `shipBtn` / `heliBtn` (created via `kindBtn('◗ SHIP', 'ship')` / `kindBtn('✈ HELI', 'helicopter')`), add:

```ts
  const anchorBtn = kindBtn('⧗ ANCHOR', 'anchor');
```

and append it to `kindRow` after `heliBtn`:

```ts
  kindRow.appendChild(shipBtn);
  kindRow.appendChild(heliBtn);
  kindRow.appendChild(anchorBtn);
```

- [ ] **Step 3: Building-gate the kind buttons (dynamic, per origin)**

The kind row currently shows SHIP + HELI unconditionally. Make each kind button's visibility depend on the selected origin's launch buildings. Add a function next to the panel's other refresh helpers:

```ts
  /** Show only the dispatch kinds the current origin can launch:
   *  SHIP needs a Shipyard, HELI a Helipad, ANCHOR a Spacetime Anchor.
   *  If the current `kind` is no longer available, fall back to the first
   *  available kind. */
  function refreshKindButtons(): void {
    const originSpec = originId ? deps.islandSpecs.get(originId) ?? null : null;
    const canShip = originSpec ? hasLaunchBuildingFor(originSpec, 'ship') : false;
    const canHeli = originSpec ? hasLaunchBuildingFor(originSpec, 'helicopter') : false;
    const canAnchor = originSpec ? originCanAnchorSettle(originSpec) : false;
    shipBtn.style.display = canShip ? '' : 'none';
    heliBtn.style.display = canHeli ? '' : 'none';
    anchorBtn.style.display = canAnchor ? '' : 'none';
    const available: DispatchKind[] = [
      ...(canShip ? ['ship' as const] : []),
      ...(canHeli ? ['helicopter' as const] : []),
      ...(canAnchor ? ['anchor' as const] : []),
    ];
    if (!available.includes(kind)) {
      kind = available[0] ?? 'ship';
    }
  }
```

Import `hasLaunchBuildingFor` and `originCanAnchorSettle` from `./settlement.js` (extend the existing import block).

Call `refreshKindButtons()` wherever the origin changes — in the panel's existing `refresh()` / origin-selector change handler (the place that already reacts to `originId` changes). It must also run once at mount after the origin defaults are set.

- [ ] **Step 4: Hide fuel + range when `kind === 'anchor'`**

The panel has a fuel row and draws a max-range ring around the origin. When `kind === 'anchor'`, both are meaningless (no fuel, ignores distance). In the panel's `refresh()`, after `refreshKindButtons()`:

```ts
    const isAnchor = kind === 'anchor';
    fuelRow.style.display = isAnchor ? 'none' : '';
    rangeRing.visible = !isAnchor;
```

(Use the actual identifiers in the file for the fuel row element and the range-ring graphic — locate them by the existing fuel/range code. If the range ring is drawn imperatively each frame rather than toggled, gate that draw call on `!isAnchor`.)

- [ ] **Step 5: Route the commit to `settleViaSpacetimeAnchor`**

The commit path is `attemptLaunch(x, y, nowMs)` — it resolves the clicked target and currently runs `dispatchVehicle`. Branch on the kind: when `kind === 'anchor'`, call the instant-settle helper instead.

In `attemptLaunch`, after the target island is resolved (the discovered/unpopulated island nearest the click) and `originId` is known, before the `dispatchVehicle` call:

```ts
    if (kind === 'anchor') {
      const res = settleViaSpacetimeAnchor(deps.world, deps.islandStates, originId, targetId, nowMs);
      if (res.ok) {
        deps.onInstantSettled?.();
        // status row: success
      } else {
        // status row: res.reason
      }
      return;
    }
```

(Use the panel's existing status-row update mechanism for the success / `res.reason` messages — match how `dispatchVehicle` reject reasons are surfaced. `targetId` is the resolved target island's id.)

Import `settleViaSpacetimeAnchor` from `./settlement.js`.

- [ ] **Step 6: Add the `onInstantSettled` dep + wire it in main.ts**

In `src/settlement-ui.ts`, add to the `SettlementUiDeps` interface:

```ts
  /** Called after a successful Spacetime Anchor instant-settle so the host
   *  can rebuild world render layers (a vehicle arrival rebuilds via the
   *  ticker; an instant-settle happens on a click and has no ticker hook). */
  onInstantSettled?: () => void;
```

In `src/main.ts`, at the `mountSettlementUi({ ... })` call site, add to the deps object:

```ts
    onInstantSettled: () => { rebuildWorldLayers(); },
```

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: `tsc -b` clean, `vite build` succeeds. Fix any error and rebuild until clean.

- [ ] **Step 8: Live verification**

Reload `https://islands.nitjsefni.eu/`. Open SETTLE OPS. Confirm:
- The kind row shows only kinds the selected origin can launch (e.g. an island with just a Shipyard shows only SHIP). An origin with a Spacetime Anchor shows ANCHOR.
- Selecting ANCHOR hides the fuel row and the max-range ring.
- ARM SETTLE → clicking a discovered unpopulated island instant-settles it (it becomes populated immediately, no vehicle appears in the ledger); the status row confirms.
- With no Refined kit on the origin, the commit is refused with a clear reason.

Screenshot via `mcp__daedalus__screenshot`.

- [ ] **Step 9: Commit**

```bash
git add src/settlement-ui.ts src/main.ts
git commit -m "feat(settlement): anchor dispatch kind — instant-settle in SETTLE OPS

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Notes for the implementer

- The `Co-Authored-By` trailer must name the model that authored the commit (`Kimi K2.6 <noreply@kimi.com>` for a kimi subagent).
- Task 1 is a behavior-preserving extraction — its bar is the existing settlement suite staying green, not a new test.
- Tasks 1-2 are pure layer (unit-tested). Task 3 is render/integration: clean build + a daedalus screenshot, per the repo's pure-layer-only test discipline.
- `persistence.ts` needs no change — instant-settle mutates only already-persisted state (`IslandSpec.populated`/`.buildings`, the new `IslandState`, inventory). No vehicle record is created, so the `SettlementVehicle` persistence path is untouched.
- The `dispatchVehicle` path for ship/helicopter is unchanged — only the kind-row visibility and the `anchor` branch are added.
