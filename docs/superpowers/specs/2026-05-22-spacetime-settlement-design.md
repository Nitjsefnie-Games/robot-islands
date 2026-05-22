# Spacetime Anchor instant settlement — design

Date: 2026-05-22
Status: approved (brainstorming) — pending implementation plan

## Problem

SPEC §2.3 / §12.6 promises a T5 capability: *"Spacetime Anchor bypasses the
vehicle stage. A T5 island can populate any discovered island instantly,
consuming a Foundation Kit but no vehicle and no fuel."* (§12.6 line 1332;
also §147, §1284.)

It is unreachable. Settlement is 100% vehicle-based:

- `settlement.ts` — `VehicleKind` is `'ship' | 'helicopter'`; `dispatchVehicle`
  creates an in-flight `SettlementVehicle` with an `expectedArrivalTime`;
  `tickVehicles` processes arrival after transit.
- `settlement-ui.ts` — the SETTLE OPS panel has a ship/heli kind toggle, fuel
  sizing, and a max-range ring.
- The `spacetime_anchor` building def exists (`building-defs.ts:989`, tier 5)
  and is placeable, but nothing consumes it for settlement, and the
  `foundation_kit_refined` resource has no settlement consumer.

So a player can build a Spacetime Anchor and it does nothing — a dead-end
building, the same gap-pattern that route tiers had.

## Goal

A T5 island with a Spacetime Anchor can **instantly** populate any
discovered, unpopulated island — consuming **one `foundation_kit_refined`**
from the origin's inventory, no vehicle, no fuel, no transit time, no
weather/failure roll, no range limit (§12.6: "ignores distance"). The target
flips to populated the same tick the player commits.

## Decisions (locked in brainstorming)

1. **Instant, kit-only.** One `foundation_kit_refined` consumed from the
   origin island's inventory. No `SettlementVehicle` record is created, no
   fuel is debited, no transit time elapses, no §2.6 weather / §12.5 failure
   roll applies (those model a journey; there is none).

2. **Reuse the populate logic via extraction.** The island-populate core —
   flip `populated`, auto-place the dock, push starter buildings, build the
   `IslandState` via `makeInitialIslandState` — currently lives inline inside
   `tickVehicles`' arrival loop (steps 3-6 of its doc comment). It is
   extracted into a pure helper so the vehicle-arrival path and the new
   instant-settle path share one implementation. Rejected alternative:
   dispatching a phantom instant `SettlementVehicle` — it would pollute the
   vehicle ledger and force a fake `kind`.

3. **`anchor` is a third dispatch kind.** The instant-settle action lives in
   the SETTLE OPS panel (`settlement-ui.ts`) as a third kind alongside
   `ship` / `helicopter` — the panel is the home of all settlement, and the
   `anchor` kind reuses the panel's origin/target selection and the
   ARM-SETTLE → click-target reticle wholesale.

4. **Kind buttons are building-gated and fully hidden when unavailable.**
   Each dispatch-kind button (`SHIP`, `HELI`, `ANCHOR`) renders **only when
   the selected origin island has the launch building for it** — Shipyard,
   Helipad, Spacetime Anchor respectively. Unavailable kinds are hidden, not
   disabled. This is a deliberate change to existing behavior: `SHIP` /
   `HELI` were always shown; they become building-conditional too. The
   ship/heli gate reuses the existing `hasLaunchBuildingFor`.

5. **Richest starter loadout.** The Refined kit delivers the richest starting
   state per §12.3 — the instant-settle places the same starter loadout the
   top vehicle tier delivers, plus a Cargo Dock. (The exact starter-building
   list is resolved at plan time from the existing `starterDefIdsFor`.)

6. **Repeatable.** Instant-settle is an ability, not a one-shot — a T5 island
   may settle multiple islands over time, each consuming one Refined kit. No
   cooldown.

## Components

### 1. `settlement.ts` — populate-core extraction

The island-populate steps inside `tickVehicles` are extracted into a pure
helper:

```ts
/** Populate `targetSpec`: flip `populated`, auto-place the dock, push the
 *  tier's starter buildings, and construct + register the IslandState.
 *  Shared by vehicle arrival and Spacetime Anchor instant-settle. */
function populateSettledIsland(
  world: WorldState,
  islandStates: Map<string, IslandState>,
  targetSpec: IslandSpec,
  loadout: { dockDefId: BuildingDefId; starters: BuildingDefId[] },
  nowMs: number,
): void;
```

`tickVehicles`' arrival branch calls it **after** its weather/failure rolls;
behavior for ship/heli arrivals is unchanged. The `loadout` parameter carries
what the old inline code derived per-kind (dock = Cargo Dock for ship /
Helipad for heli; starters from `starterDefIdsFor`), so the extraction is
behavior-preserving.

### 2. `settlement.ts` — `settleViaSpacetimeAnchor`

```ts
export type SpacetimeSettleResult =
  | { ok: true }
  | { ok: false; reason: string };

/** §12.6 — instant T5 settlement. Re-checks every gate, consumes one
 *  foundation_kit_refined from the origin island's inventory, and populates
 *  the target via `populateSettledIsland`. No vehicle, no fuel, no transit.
 *  Returns { ok: false } WITHOUT mutating anything on any gate failure. */
export function settleViaSpacetimeAnchor(
  world: WorldState,
  islandStates: Map<string, IslandState>,
  originId: string,
  targetId: string,
  nowMs: number,
): SpacetimeSettleResult;
```

Gates (all re-checked here, guarding the paint→click race):
- origin spec + state exist; origin spec has a `spacetime_anchor` building;
- origin state inventory has ≥1 `foundation_kit_refined`;
- target spec exists, is `discovered`, and is not `populated`.

On success: decrement `foundation_kit_refined` by 1 on the origin state's
inventory, call `populateSettledIsland` with the Refined-kit loadout.

A small predicate — `originCanAnchorSettle(spec)` (origin has a
`spacetime_anchor` building) — is exported for the UI's kind-button gate, the
`anchor` sibling of `hasLaunchBuildingFor`.

### 3. `settlement-ui.ts` — `anchor` kind + dynamic kind row

- `VehicleKind` UI handling extends to a third kind `'anchor'` (a UI-local
  union — the persisted `SettlementVehicle.kind` stays `ship | helicopter`,
  since `anchor` never creates a vehicle).
- The kind-button row is **rebuilt on every origin change**: it contains only
  the kinds the current origin can launch — `SHIP` if `hasLaunchBuildingFor
  (origin, 'ship')`, `HELI` likewise, `ANCHOR` if `originCanAnchorSettle
  (origin)`. If the currently-selected `kind` is no longer present after the
  rebuild, selection falls back to the first available kind.
- When `kind === 'anchor'`: the fuel row and the max-range ring are hidden;
  the kit count is fixed at 1 Refined kit; ARM SETTLE → click-target reticle
  is unchanged; commit calls `settleViaSpacetimeAnchor` instead of
  `dispatchVehicle`; no active-vehicles ledger entry is added (there is no
  vehicle). The status row reports success / the `reason` on failure.
- Commit-enable for `anchor`: origin has the anchor AND ≥1
  `foundation_kit_refined`; target discovered + unpopulated.

### 4. No change to `persistence.ts`, `economy.ts`, `main.ts` data model

- `persistence.ts` — instant-settle mutates only already-persisted state
  (`IslandSpec.populated`, `IslandSpec.buildings`, the new `IslandState`,
  inventory). No new persisted field. The new island is registered in
  `islandStates` exactly as a vehicle arrival registers it.
- `main.ts` — the settlement UI already receives an `onSettled`-style hook /
  rebuilds world layers on arrival; the `anchor` commit reuses that same
  post-settle refresh path (resolved at plan time against the existing
  arrival wiring). No new dep callback shape beyond what arrivals use.

## Data flow

```
player picks origin (has Spacetime Anchor) → ANCHOR kind appears in the row
player picks ANCHOR → fuel row + range ring hidden
player ARM SETTLE → clicks a discovered unpopulated target
        │
        ▼
settleViaSpacetimeAnchor(world, islandStates, originId, targetId, nowMs)
   ├─ gate: origin has spacetime_anchor + ≥1 foundation_kit_refined
   ├─ gate: target discovered && !populated
   ├─ origin.inventory.foundation_kit_refined -= 1
   └─ populateSettledIsland(... refined loadout ...)
        │  target.populated = true; dock + starters placed; IslandState built
        ▼
panel status row confirms; world layers rebuild (same path as arrivals)
        │
        ▼
next economy tick integrates the new colony
```

## Error handling / edge cases

- **Origin has no launch building at all** — the kind row is empty; no kind
  is selectable; commit is impossible; the panel shows a clear "no launch
  capability on this origin" status.
- **Origin switch invalidates the selected kind** — e.g. `ship` was selected
  and the new origin has only a Helipad — selection falls back to the first
  available kind for the new origin.
- **No Refined kit** — the `ANCHOR` button still shows (origin has the
  anchor), but commit is disabled with a reason; `settleViaSpacetimeAnchor`
  also re-checks and returns `{ ok: false }` without mutating.
- **Target already populated / undiscovered** — not a valid reticle target,
  same as for ship/heli; the helper re-checks defensively.
- **Origin loses its Spacetime Anchor between selection and commit** (e.g.
  demolished) — `settleViaSpacetimeAnchor` re-checks and returns
  `{ ok: false }`.
- **Spacetime Anchor powered or not** — gating is a presence check on the
  building, consistent with the §13.3 CONVERT button's `reality_forge`
  presence check. Operational/power state is not part of the gate.

## Testing

Pure-layer unit tests in `settlement.test.ts` (UI wiring is daedalus-verified
live, per the repo's pure-layer-only test discipline):

- `populateSettledIsland` flips `populated`, registers an `IslandState`, and
  places the dock + starters — and the existing `tickVehicles` arrival tests
  still pass (behavior-preserving extraction).
- `settleViaSpacetimeAnchor` success: consumes exactly one
  `foundation_kit_refined`, target becomes populated, an `IslandState` is
  registered, no `SettlementVehicle` is created.
- `settleViaSpacetimeAnchor` returns `{ ok: false }` and mutates **nothing**
  when: origin has no `spacetime_anchor`, origin has 0 `foundation_kit_
  refined`, the target is already populated, or the target is undiscovered.
- `originCanAnchorSettle` is true iff the origin spec has a `spacetime_anchor`
  building.

## Out of scope

- The T5 `spacetime` **route** type (§2.4) — a separate unreachable-feature
  gap; not this work.
- Any change to ship / helicopter dispatch, transit, fuel, or failure rolls
  beyond the behavior-preserving `populateSettledIsland` extraction.
- A cooldown or per-island settle limit — instant-settle is repeatable, one
  Refined kit each.
- Tuning the Refined-kit starter loadout — it mirrors the existing top
  vehicle-tier loadout; rebalancing is Appendix A work.
