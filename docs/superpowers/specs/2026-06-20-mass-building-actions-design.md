# Mass Building Actions — Design Spec

**Date:** 2026-06-20
**Status:** Approved design → ready for implementation plan
**Scope:** Multi-building selection + batch operations (destroy, upgrade, move, enable/disable, ignore-cap) within a single island.

---

## 1. Summary

Add a **multi-select** interaction so the player can act on many buildings at
once instead of one-by-one through the single-building inspector. Selection is
built with shift-click and shift-drag-box, scoped to **one island at a time**.
With 2+ buildings selected the inspector switches to a **mass-action mode** that
batches the existing per-building `gateway.*` operations.

No new authoritative operations, no schema/persistence changes: every mass
action is a client-side loop over existing gateway calls, so REMOTE and LOCAL
boot modes work unchanged. The only authoritative-surface effect is the same
set of mutations the single inspector already issues, executed in sequence.

---

## 2. Goals / Non-goals

**Goals**

- Shift-click toggle + shift-drag rubber-band box to build a selection.
- Mass **Destroy**, **Upgrade**, **Move (group drag)**, **Enable**, **Disable**,
  and **Ignore-cap** (per-resource).
- Mass-upgrade fills available build + queue slots with the lowest-floor
  buildings it can afford.
- Selection is purely client UI state — testable pure helpers for the
  non-trivial logic (slot/affordability picker, box hit-set, group-footprint
  validation).

**Non-goals (v1)**

- Cross-island selection (single-island scope only).
- Group **rotation** during move (drop dropped — preserve orientation only).
- Any new gateway method, snapshot schema bump, or migration.
- Mass actions for inspector features that are inherently single-building
  (cargo relabel, land reclamation, servitor conversion, time-lock, etc.).

---

## 3. Selection model (`main.ts`)

`main.ts` owns selection state because it already owns the canvas click/drag
handlers, the selection-outline layer, and all `gateway` wiring.

```
selection: Set<buildingId>     // building ids on selectionSpec
selectionSpec: IslandSpec|null // the single island the selection lives on
```

**Input rules** (extend the existing mousedown/mouseup/mousemove handlers in
`main.ts`, which already host the ghost-drag and bend-drag modes):

| Gesture | Effect |
|---|---|
| Plain click on a building | Single-select: `selection = {id}`, `selectionSpec = island`. Opens inspector single-mode (unchanged path). |
| Shift-click on a building **on `selectionSpec`** | Toggle that id in/out of `selection`. |
| Shift-click on a building on a **different** island | Ignored (single-island scope). |
| Shift-drag (empty start, shift held) | Rubber-band box drag mode; on release, add every building on `selectionSpec` whose footprint intersects the box. |
| Plain click on empty ocean | Clear selection + close inspector (existing behavior). |
| Escape | Clear selection (existing dismiss path). |

The first shift-gesture on an island with no current selection sets
`selectionSpec` to that island. Box-select before any selection exists picks
`selectionSpec` from the island under the box's start point.

**Rendering.** The existing selection-outline layer iterates `selection` and
draws one outline per selected building (today it draws one). The rubber-band
box is a new lightweight overlay rect (same pattern as the ghost/bend drag
overlays), visible only during the drag.

**Inspector dispatch.** `selection.size <= 1` → existing single inspector.
`selection.size >= 2` → inspector multi-mode (§5).

---

## 4. Mass-action semantics

All mass actions operate only on selected buildings for which the corresponding
single-building op is currently legal (operational, not queued/under
construction). Buildings that don't qualify are silently skipped, and the panel
reports the effective count (e.g. "Upgrade (5 fit)").

### 4.1 Destroy

One `window.confirm` summarizing the **aggregate** scrap credit + 50% refund
across all selected buildings (reuse the existing single-building refund/scrap
preview helpers, summed). On confirm, call `gateway.demolishBuilding(islandId,
id)` for each selected building, then `drainRoutesForBuilding` per building and
`rebuildWorldLayers()` once. Clear selection + close inspector afterward.

### 4.2 Upgrade (lowest-floor-first, slot- and affordability-bounded)

Pure helper `planMassUpgrade(state, selectedIds): buildingId[]` (new, in
`placement.ts` or a new `mass-actions.ts` pure module — decide at plan time):

1. `freeSlots = (parallelBuildSlots(state) − inProgressBuildCount(state))
   + (queuedBuildSlots(state) − queuedBuildCount(state))`. If `freeSlots <= 0`,
   return `[]`.
2. From the selected buildings, take those eligible for an upgrade (operational,
   below max floor). Sort **ascending by current `floorLevel`** (laggards
   first); tie-break by `queueSeq`/id for determinism.
3. Walk the sorted list with a **running copy** of `state.inventory`. For each
   candidate, compute its `upgradeCost(def, targetLevel)`. If affordable against
   the running inventory, select it and deduct the cost from the running tally;
   else **skip** it and continue to the next candidate. Stop when `freeSlots`
   buildings are selected or the list is exhausted.
4. Return the selected ids (≤ `freeSlots`).

`main.ts` then calls `gateway.applyUpgrade(islandId, id)` for each returned id,
in order, and rebuilds layers + refreshes the inspector once. The button label
shows the planned count: "Upgrade (n fit)". Disabled when `n == 0`.

> Rationale: the running-inventory walk mirrors what sequential single-clicks
> would do, and skipping (not stopping) on an unaffordable laggard keeps cheaper
> upgrades flowing into the remaining slots.

### 4.3 Enable / Disable (two buttons)

Two separate buttons. **Disable** calls `setBuildingActiveFloors(islandId, id,
allFloors)` (disable all floors) for every selected building that has any active
floor. **Enable** calls it with `0` disabled floors for every selected building.
Each drains routes / rebuilds layers exactly as the single op's `finish()` does,
batched to one rebuild. (No cost, no confirm.)

### 4.4 Ignore-cap (per-resource checkboxes)

The multi-panel shows one checkbox per resource in the **union** of output
resources across the selected buildings. Ticking a resource's checkbox calls
`gateway.setIgnoreCap(islandId, id, resource, true)` for every selected building
that outputs that resource; unticking sets `false`. A checkbox renders checked
when **all** selected buildings that output the resource already have it set
(else unchecked). Buildings that don't output the resource are unaffected.

### 4.5 Move (group drag, all-or-nothing)

A **Move** button starts a new **group-relocate mode** in `placement-ui.ts`
(sibling to the existing single `beginRelocate`):

- The selection becomes a rigid cluster following the cursor, preserving each
  building's offset relative to the cluster anchor.
- Each frame, validate the **whole cluster footprint as a unit** via a pure
  helper `validateGroupRelocate(spec, state, members, dxTiles, dyTiles)`:
  every member's new footprint must be in-island, pass biome/tier gates, and
  not overlap any **non-selected** building or another cluster member. Ghost
  renders green (all valid) or red (any invalid).
- **Drop is all-or-nothing**: on a fully-valid drop, call
  `gateway.relocateBuilding(islandId, id, newX, newY)` for each member (each
  pays its own `relocateFee` = 50% invested cost, matching single-move). On an
  invalid drop, no-op and stay in the mode (or cancel on Escape).
- Group **rotation** is out of scope for v1.

---

## 5. Inspector multi-mode (`inspector-ui.ts` + new `inspector-multi.ts`)

The inspector visually hosts the mass panel (its mounted panel/position is
reused), but the multi-body is a focused new component `inspector-multi.ts` that
`inspector-ui.ts` delegates to when `selection.size >= 2`. This keeps the
already-large `inspector-ui.ts` from absorbing all batch logic and preserves the
"one responsibility per file" convention.

Multi-body contents:

- Header: count + type breakdown ("8 buildings — 5 Mine, 3 Smelter").
- Buttons: **Destroy**, **Upgrade (n fit)**, **Move**, **Enable**, **Disable**.
- Per-resource **Ignore-cap** checkboxes (union of outputs).

Single-mode (size ≤ 1) is unchanged. Mode is chosen by the caller (`main.ts`)
when it opens/refreshes the inspector against the current selection.

---

## 6. Data flow & trust surface

- Selection set + group-drag preview are **pure client UI state** — never
  serialized, never sent to the server.
- Every committed mutation is an existing `gateway.*` call already validated by
  the authoritative layer (REMOTE: WS intent; LOCAL: direct pure call). Mass
  actions add no new trust surface — they are sequenced existing intents.
- No `gateway` interface change, no `MutationGateway` method addition, no
  snapshot schema bump, no migration.

---

## 7. Files touched

| File | Change |
|---|---|
| `src/main.ts` | Selection `Set` + `selectionSpec`; shift-click/box-drag input; multi-outline render; box overlay; mass-action wiring (loops over gateway). |
| `src/inspector-ui.ts` | Delegate to multi-body when `selection.size >= 2`; pass selection through. |
| `src/inspector-multi.ts` | **New.** Multi-select panel: breakdown + buttons + ignore-cap checkboxes. |
| `src/mass-actions.ts` | **New (pure).** `planMassUpgrade`, box-intersection hit-set, ignore-cap union helpers. |
| `src/placement-ui.ts` | New group-relocate mode (sibling to `beginRelocate`). |
| `src/placement.ts` | New pure `validateGroupRelocate` (or in `mass-actions.ts`). |
| `SPEC.md` | New subsection under §4 documenting multi-select + mass-action semantics (esp. the upgrade slot/affordability algorithm and all-or-nothing group move). |

(Exact home of the pure helpers — `mass-actions.ts` vs `placement.ts` — is a
plan-time call; the spec only requires they be pure and unit-tested.)

---

## 8. Testing

Pure-layer unit tests (render code stays read-only, untested per convention):

- `planMassUpgrade`: lowest-floor-first ordering; skip-unaffordable with running
  inventory depletion; respects `freeSlots = running + queue` free capacity;
  returns `[]` when no slots / nothing affordable; excludes max-floor and
  under-construction buildings.
- Box-intersection hit-set: buildings whose footprint intersects the drag box
  are included; partial overlaps count; non-`selectionSpec` islands excluded.
- `validateGroupRelocate`: rejects when any member leaves the island / hits a
  biome gate / overlaps a non-selected building or another member; accepts a
  clean translation; fee is sum of per-member `relocateFee`.
- Ignore-cap union + checked-state derivation (all-output-buildings-set → checked).

---

## 9. SPEC.md alignment

A new subsection under **§4 (buildings / building operations)** will document:
the multi-select selection model (shift-click + box, single-island scope), the
mass-upgrade slot/affordability algorithm (lowest-floor-first, skip-unaffordable,
`freeSlots = running + queue`), the two-button enable/disable, per-resource mass
ignore-cap, and the all-or-nothing group move with per-member relocate fees.
Code and SPEC.md ship together in the same change.
