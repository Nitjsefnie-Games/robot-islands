# Map-placement UI for artificial island construction — design

**Date:** 2026-06-20
**Status:** Approved (brainstorm) — pending spec review → implementation plan
**Relates to:** SPEC.md §2.5 (Artificial Islands), §15 (UI), Appendix C (trust surface)

## Context

Artificial-island construction (§2.5) today uses a **blocking centered modal**
(`construction-ui.ts` → `mountModal` from `ui-modal.ts`, `ri-modal` shell). The
target position is entered as two **blind `<input type="number">` fields**
("Target X" / "Target Y", default `(100,100)`) with **no map preview** — no
ghost, no ring, no click-to-place. Overlap is only reported as amber status text
*after* typing, via `positionIsFree` (`construction-gate.ts`, 4-tile buffer).

By contrast the drone panel (and every other HUD panel) uses `mountPanel`
(`ui-zones.ts`) + `makePanelDraggable` (`window-manager.ts`): header-drag to
free-position, resizable, position **persisted** to `localStorage`
(`ri-ui-layout-v1`), and **non-blocking**.

This spec makes construction match that windowing model and adds a **live,
draggable ghost ellipse** on the map, plus a **new placement rule**: the island
footprint must lie entirely in discovered-or-visible space.

## Decision

Convert the construction UI from a blocking modal to a **drone-style movable /
resizable / persisted HUD panel**, and pair it with a **world-space PixiJS ghost
ellipse** the player drags to move and resizes via handles. Panel controls and
the ghost stay synced both ways. Validity (overlap / off-map / unknown-space) is
shown by ghost color (cyan valid / red invalid) plus a specific reason; the
discovery rule is enforced in the **pure layer** so the server honors it.

Rejected: bending `placement.ts` (building-footprint preview) to draw an
ellipse; a DOM/CSS ghost over the canvas (fights the camera transform); a
"click-center, drag-out to draw" gesture; collision-blocked dragging.

## Locked design decisions (from brainstorm)

1. **Window model** — construction becomes a `mountPanel`/`ri-panel` window
   registered with `window-manager.ts`: draggable, resizable, persisted,
   non-blocking. Still toggled by **C** and the existing toolbar button.
2. **Live ghost** — a world-space ellipse (scales/pans with the camera like
   islands): **drag body = move center**, **corner/edge handles = resize
   major/minor**, synced both ways with the panel sliders.
3. **Validity feedback** — **color + reason, free drag**: cyan valid / red
   invalid; the player can drag anywhere (red allowed); Construct stays disabled
   with the specific reason. Resize handles (and sliders) clamp at the tier cap.
   Affordability stays in the panel cost grid, not the ghost color.
4. **Discovery rule** — the **entire footprint** must be discovered or visible;
   any cell in unknown fog → red, reason "extends into unknown space".
5. **Coordinate inputs** — X/Y stay **editable and synced** with the ghost (for
   precise keyboard entry), not removed.

## Architecture / components

| Unit | Layer | Responsibility |
|---|---|---|
| `construction-ui.ts` (rework) | DOM | Mount via `mountPanel` (was `mountModal`); push biome/size/coord edits into the shared placement state; render from it. Panel id `construction-panel`. |
| `construction-overlay.ts` (**new**) | Pixi render | Draw the ghost ellipse + resize handles in the **world** container; hit-test body-drag and handle-drag; color by validity. Follows the `*-overlay.ts` convention (cf. `lobe-badge-overlay.ts`). |
| `construction-placement.ts` (**new**) | **pure** | Shared placement state `{founderId, biome, major, minor, cx, cy}` + `computePlacementValidity(world, states, state)` → `{ok, reason}`. The seam both panel and overlay read/write. Unit-tested. |
| `artificial-island.ts` (extend) | pure | Add `ValidationReason: 'in-unknown-space'`. Discovery check is NOT threaded through `validateConstruction` — the signature was not changed. |
| `regionDiscoveredOrVisible` (in `construction-gate.ts`) | pure | `regionDiscoveredOrVisible(world, cx, cy, major, minor)` → true iff **every** cell the inscribed footprint occupies is in `world.revealedCells`. Added as a **sibling gate** next to `positionIsFree`, NOT threaded through `validateConstruction`. |
| `mutation-gateway.ts` (touch) | seam | LOCAL `constructIsland` calls the spatial gates (`positionIsFree` + `regionDiscoveredOrVisible`) directly; REMOTE already routes the `construct-island` intent. |
| `server/src/game/intents.ts` (touch) | server | `construct-island` re-runs `validateConstruction` + calls spatial gates directly — discovery check is a separate gate call, not a `validateConstruction` parameter. |
| `SPEC.md` §2.5 | spec | Document the discovery/vision placement constraint. |

### Why the discovery rule is one predicate

The three ocean tiers are **visible / discovered / unknown**. Both visible and
discovered cells live in `WorldState.revealedCells` (a `Set<"cellX,cellY">`);
"unknown" means *not in that set* (vision write-through: `revealOceanCells` and
`markIslandDiscovered` both add to `revealedCells`). So "discovered or visible,
not unknown" collapses to: **every footprint cell ∈ `world.revealedCells`**. The
server's authoritative snapshot already carries `revealedCells` (and
`depthRevealedCells`) — see `server/src/game/projection.ts:43` — so the same
predicate runs identically on client and server. (Planning must confirm the
vision→`revealedCells` write-through holds for transient lighthouse/drone vision;
if a "visible but not revealed" state exists, the predicate also consults
computed vision via `vision-source.ts`.)

## Interaction flow

1. Press **C** / click **Construct** → the construction **panel** opens
   (movable, resizable, restored to its last persisted position). A ghost
   ellipse spawns at a default **valid** spot near the selected founder island.
2. Pick **Founder** (dropdown of T3+ islands with an operational
   `platform_constructor`), **Biome** (chips), **Size** (sliders, max = tier
   cap T3=8 / T4=12 / T5=16). Ghost updates live.
3. **Drag the ghost body** to move its center; **drag handles** to resize
   (clamped to the tier cap). Sliders and the X/Y fields stay synced both ways.
4. Ghost is **cyan** when valid, **red** when invalid (overlap / off-map /
   extends-into-unknown). The panel status line shows the specific reason.
5. The **cost grid** shows `have / need` per resource (amber when short);
   Construct is enabled only when placement is valid **and** affordable.
6. Click **Construct** → `gateway.constructIsland` (LOCAL direct call / REMOTE
   `construct-island` intent) → server re-validates (incl. discovery) → island
   is inserted and `rebuildWorldLayers()` runs. **On a successful construct the
   panel closes (the ghost clears); reopen it (key C) to place another island.**

## Validity model

Ghost color is driven by `computePlacementValidity`, which returns the first
failing reason in this order:

| Reason | Source | Ghost |
|---|---|---|
| `tier-too-low` | founder < T3 | (founder dropdown gates this; not a ghost state) |
| `no-platform-constructor` | founder lacks PC | (founder dropdown gates this) |
| `radius-too-large` | over tier cap | prevented — handles & sliders clamp |
| `position-occupied` | `positionIsFree` overlap | **red** |
| off-map | center/footprint outside world bounds | **red** |
| `in-unknown-space` (**new**) | footprint ⊄ `revealedCells` | **red** |
| `insufficient-materials` | cost > inventory | cyan ghost, Construct disabled (affordability is panel-only) |

## SPEC.md update (§2.5)

Add a placement-constraint paragraph: *"An artificial island may only be
constructed where its entire footprint lies in discovered or currently-visible
space — every cell the island would occupy must already be revealed. Placement
into unknown ocean is rejected (`in-unknown-space`)."* Note the UI is a movable
panel with a live map ghost (the placement *rule* is the normative part; the UI
mechanism is descriptive).

## Verification

- **Pure**: `construction-placement.test.ts` — validity precedence (overlap vs
  unknown-space vs affordable), and `regionDiscoveredOrVisible` returns false
  when any footprint cell is missing from `revealedCells`, true when all present.
- **Pure**: `artificial-island.test.ts` — new `in-unknown-space` reason from
  `validateConstruction`; existing reasons unchanged.
- **Server**: `intents.test.ts` — `construct-island` rejects a footprint that
  extends into unrevealed cells; accepts one fully within `revealedCells`.
- **Gateway**: `mutation-gateway.test.ts` — LOCAL `constructIsland` surfaces the
  new reason.
- **Manual** (render layer, not unit-tested per repo convention): build, reload
  `islands.nitjsefni.eu`, open Construct, confirm draggable/resizable/persisted
  panel + live ghost that reds out over islands and fog.

## Risks

| Risk | Sev | Mitigation |
|---|---|---|
| ~~`validateConstruction` signature grows (needs `world`/`revealedCells`) → ripples to UI, gateway, server intent, tests~~ | ~~MED~~ | **RESOLVED** — `validateConstruction` signature was NOT changed. `regionDiscoveredOrVisible` was added as a sibling gate in `construction-gate.ts` next to `positionIsFree`; the new `construction-placement.ts` (`computePlacementValidity`) combines both gates without touching `validateConstruction`. |
| Discovery check over a 16-radius footprint is many cells; per-frame validity could be heavy | LOW/MED | Recompute validity only on state change (debounced), not per frame; cells are coarse (`CELL_SIZE_TILES`). |
| Assumed vision→`revealedCells` write-through; a transient "visible but not revealed" state would slip through | LOW | Confirm write-through in planning; if it exists, also consult computed `vision-source.ts`. |
| Coordination with the parallel cost-×5 session — both edit SPEC §2.5 (and possibly `artificial-island.ts`/cost tests) | MED | Additive edits in different §2.5 paragraphs; rebase/fast-forward per CONTRIBUTING; sequence the two branches. |

## Out of scope

- **Drag-to-draw** (click-center-then-drag-out) gesture and **collision-blocked
  drag** — both considered and rejected in the brainstorm.
- **Map ghost for Land Reclamation Hub** expansion (separate §3.4 mechanic) —
  the overlay could be reused later, but not in this slice.
- **Platform Constructor power/heat enforcement** — separately deferred
  (`building-defs.ts:1767`, "STILL-DEFERRED").
- **Cost rebalance (×5)** — handled by the parallel session; not this spec.
