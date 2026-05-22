# Building-gated tiered routes — design

Date: 2026-05-22
Status: approved (brainstorming) — pending implementation plan

## Problem

Routes have a `type` field spanning tiers (`cargo`, `drone`, `airship`,
`mass_driver`, `teleporter`, …) and `routes.ts` dispatch handles all of them
(mass-driver Diesel debit, teleporter biofuel, airship skill multiplier). But
nothing in the game ever *creates* a non-`cargo` route:

- `commissionRoute` (`routes-ui.ts`) and the three constructors in
  `settlement.ts` all hardcode `type: 'cargo'` at T1 capacity (0.5 u/s).
- The route form has no tier picker.
- `Route.type`/`capacityPerSec`/`transitTimeSec` are `readonly` — a route's
  tier is fixed at creation.

So higher-tier routes are unreachable. There is also no route-upgrade
mechanic and no way to obtain more throughput between islands.

Separately: route creation currently costs nothing — no resources, no
building requirement, no upkeep. The only gate is "two distinct populated
islands".

## Goal

Let the player obtain higher-throughput routes by building higher-tier
transport buildings. The "upgrade" is: place a better dock, route from it.

## Decisions (locked in brainstorming)

1. **Building-gated.** Every route requires its tier's transport building on
   the source island. This also closes the "T1 routes are free" gap — a
   `cargo` route now needs a Cargo Dock.
2. **Route owned by a building.** A route is hosted by one transport
   building; the building's def determines the route's tier (rate + transit).
3. **One route per building.** A building hosts at most one route. To run a
   second route, place a second building. (Consistent with SPEC §9.5's
   existing "one Mass Driver = one outbound route per island" rule.)
4. **Cost = the building's `placementCost`.** Route creation itself stays
   free; the player pays by placing the building. All five transport
   buildings already carry a `placementCost` in `building-defs.ts`.
5. **Teleporter is gate-only paired.** A `teleporter` route requires a
   Teleporter Pad on the destination island too, but that dest pad is only an
   eligibility check — it is not consumed and can still host its own route.
6. **Demolish drains.** Demolishing a route's source building sets
   `route.draining = true`; in-flight cargo finishes, then the route
   auto-prunes (mechanism shipped in commit `34594a6`).
7. **UI surface = Approach A.** Route creation stays in the FREIGHT GRID
   panel form; the `FROM` control gains a building sub-select.
8. **Old saved routes are grandfathered.** A route with no `sourceBuildingId`
   keeps running as plain `cargo`; it is not building-linked and not
   demolish-coupled. (No live save currently has such a route.)

## Tier → building map

| Building       | defId            | Tier | Route `type`  |
|----------------|------------------|------|---------------|
| Cargo Dock     | `dock`           | T1   | `cargo`       |
| Drone Pad      | `dronepad`       | T2   | `drone`       |
| Airship Dock   | `airship_dock`   | T3   | `airship`     |
| Mass Driver    | `mass_driver`    | T4   | `mass_driver` |
| Teleporter Pad | `teleporter_pad` | T4   | `teleporter`  |

All five defIds already exist in `building-defs.ts`. No new building is
introduced. The `cable` / `submarine_cable` power-link types are out of
scope — they are the power network, not cargo routes.

## Components

### 1. `routes.ts` — tier profile

New pure helper:

```
routeProfileForBuilding(defId: BuildingDefId):
  { type: RouteType; capacityPerSec: number; speedTilesPerSec: number } | null
```

Returns `null` for a defId that is not a transport building. `speedTilesPerSec`
is `0`/sentinel for `teleporter` (instant; `transitTimeSec` becomes 0).

Per-tier capacity + speed constants live alongside the existing
`T1_CARGO_CAPACITY_UNITS_PER_SEC` (0.5), `T1_CARGO_SPEED_TILES_PER_SEC` (1),
and `MASS_DRIVER_CAPACITY_UNITS_PER_SEC` (2.5). New constants are needed for
`drone` and `airship` capacity + speed. All are placeholders, tuned later per
SPEC Appendix A — following the existing placeholder convention in the file.

Dispatch (the `tickRoutes` loop) needs **no change**: `drone`/`airship`/
`teleporter` types and their fuel debits are already implemented; capacity and
transit are read from the per-route fields, which are set at creation from the
profile.

### 2. `routes.ts` — `Route` data model

`Route` gains:

```
/** PlacedBuilding id of the transport building that owns this route.
 *  Absent on legacy saved routes (grandfathered as plain cargo). */
sourceBuildingId?: string;
```

`type` / `capacityPerSec` / `transitTimeSec` remain set-at-creation (derived
from the source building's profile — not re-resolved each tick).

Persistence: the optional field rides the existing `...r` spread in both the
snapshot and restore paths of `persistence.ts` — no change there.

### 3. `routes-ui.ts` — creation form (Approach A)

- `FROM` becomes two `<select>`s: **island**, then **transport building** on
  that island. The building select lists only transport buildings that do not
  already own a route (no route has `sourceBuildingId === building.id`). Each
  `<option>` shows tier + rate, e.g. `Airship Dock · airship · 1.2 u/s`.
- `TO` stays an island select.
- `transitTimeSec` = endpoint distance ÷ the tier's `speedTilesPerSec`
  (`teleporter` → 0).
- Commit validation: an eligible building must be selected; if the source
  building's type is `teleporter`, the `TO` island must have a Teleporter Pad.
  Commit is refused (button disabled, readout explains) otherwise.
- `commissionRoute` constructs the `Route` with `sourceBuildingId`, and
  `type` / `capacityPerSec` / `transitTimeSec` from the profile.

The form reads placed transport buildings from island building data and
cross-references `world.routes` for the one-route-per-building check.

### 4. `routes-ui.ts` — active ledger island filter

A `<select>` above the ACTIVE list: **"All islands"** + one entry per
populated island, shown by `IslandSpec.name` (consistent with the recent HUD
island-dropdown convention, commit `3b14ede`). It filters ledger rows to
routes whose `from` equals the selected island. Default "All islands".

The filter value is joined into the ledger's structural signature so changing
it triggers a rebuild through the existing reconcile path in `repaintLedger`
(commit `34594a6`).

### 5. Demolish coupling

The building-demolish path (the inspector's DEMOLISH action) gains a step:
after a transport building is removed, find the route with
`sourceBuildingId === building.id` and set `route.draining = true`. The route
then drains its in-flight cargo and is pruned by `tickRoutes`.

## Data flow

```
place transport building (pays placementCost)
        │
        ▼
FREIGHT GRID form: pick island → pick building (untaken) → pick TO → commit
        │  profile = routeProfileForBuilding(building.defId)
        ▼
Route { sourceBuildingId, type, capacityPerSec, transitTimeSec } → world.routes
        │
        ▼
tickRoutes dispatch (unchanged) — capacity/transit per the tier
        │
        ▼
demolish source building → route.draining = true → drains → pruned
```

## Error handling / edge cases

- **No eligible building on the FROM island** — commit disabled; readout says
  why.
- **All transport buildings on the FROM island already host routes** — same.
- **Teleporter source, no pad on TO island** — commit disabled; readout says
  why.
- **Legacy route (no `sourceBuildingId`)** — runs as before; ledger shows it;
  it is simply not demolish-coupled.
- **Building demolished while its route has cargo in flight** — route drains,
  cargo lands, route pruned. No cargo lost.

## Testing

- Pure (`routes.test.ts`): `routeProfileForBuilding` returns the correct
  type/capacity/speed for each transport defId and `null` for a non-transport
  defId; per-tier `transitTimeSec` math (distance ÷ speed; teleporter 0).
- Pure: a route built from a profile carries the expected `type` /
  `capacityPerSec` and dispatches at that tier's rate.
- The creation form, ledger island filter, and demolish coupling are
  render/UI layer — verified live in the browser via daedalus, not unit tests
  (consistent with the repo's pure-layer-only test discipline).

## Out of scope

- Re-tiering an existing route in place (no in-place upgrade — the model is
  build-a-better-building).
- `cable` / `submarine_cable` power links.
- Tuning the placeholder capacity/speed constants (Appendix A work).
- Auto-Patronage default routes (§9.6) — unaffected; those constructors keep
  emitting legacy `cargo` routes unless separately updated.
