# Relocate buildings + floor-aware demolish — design

**Date:** 2026-06-01
**Branch:** `feat/relocate-buildings`
**Status:** Approved (brainstorming), pending implementation plan

## Problem

Two connected gaps in the building lifecycle:

1. **No way to move a building.** Once placed, a building is stuck — the only
   recourse is demolish (losing scrap + half its cost) and rebuild from scratch.
   Players want to re-plan base geometry (especially now that §4.5 adjacency
   rewards clustering) without eating a full teardown.
2. **Demolish ignores floor-upgrade investment.** `demolishBuilding()`
   (`placement.ts:797`) computes scrap and refund from the **base**
   `placementCost` only. A building upgraded to floor L has additionally paid
   `L × ceil(0.8 × base)` in upgrades, and gets **none** of it back on demolish.
   A floor-9 building silently forfeits ~88% of its invested resources.

## Goal

- **Relocate**: move an existing building to a new valid tile **on the same
  island** for a fee of **half its total invested cost**, keeping all runtime
  state ("just teleport").
- **Fix demolish** to account for floor-upgrade investment, using the same
  "total invested cost" basis.

## Decisions (locked in brainstorming)

| Question | Decision |
|---|---|
| Cost basis (both features) | **Total invested** = base placementCost + floor-upgrade costs |
| Move scope | **Same island only** |
| Move UX | Inspector **"Move" button → ghost-placement mode** (reuse `placement-ui` + `validatePlacement`) |
| State on move | **Keep everything** — only `x/y` (and optional `rotation`) change |
| Fee rounding | **Floor** per resource (player-friendly, mirrors demolish's `floor`) |

## The shared cost helper

New pure function in `src/placement.ts`:

```ts
export function totalInvestedCost(
  b: PlacedBuilding,
  def: BuildingDef,
): Partial<Record<ResourceId, number>>;
```

Per resource `r`: `base[r] + floorLevel(b) × upgradeCost(def)[r]`, where
`base = placementCostFor(def)` and `upgradeCost(def)[r] = ceil(0.8 × base[r])`
(the existing `upgradeCost` helper, `placement.ts:107`). `floorLevel(b)` is the
existing `buildings.ts:187` helper (`b.floorLevel ?? 0`, clamped [0,9]).

Single source of truth for "what this building is worth," consumed by both
relocate and the demolish fix. Example: a 100-stone def at floor 3 →
`100 + 3 × ceil(0.8×100)` = `100 + 3×80` = **340 stone**.

## Relocate

New pure function in `src/placement.ts`:

```ts
export function relocateBuilding(
  spec: IslandSpec,
  state: IslandState,
  id: string,
  newX: number,
  newY: number,
  rotation?: Rotation,
): RelocateResult; // { ok: true, charged } | { ok: false, reason }
```

Steps:

1. Find the building by `id` in `spec.buildings`; `{ ok: false, reason: 'not-found' }` if absent.
2. **Validate the destination** via the existing `validatePlacement()`, extended
   with an optional `ignoreBuildingId` parameter so the moving building's own
   current footprint is excluded from the overlap check (enables 1-tile shifts
   and prevents self-collision). Every other check is unchanged: bounds
   (ellipse), overlap with **other** buildings, terrain `requiredTile`, coastal,
   biome, tier, terrain-modifier brush. Failures surface the validator's own
   reason (`'overlap'`, `'tile-requirement-not-met'`, `'out-of-bounds'`, …).
   - Consequence: a Mine can only move onto another `ore`/`coal` tile, etc.
3. **Fee** = `floor(0.5 × totalInvestedCost(b, def)[r])` per resource. Check
   affordability against `state.inventory`; `{ ok: false, reason: 'insufficient-resources', missing }`
   if short. Deduct the fee from inventory.
4. Mutate **only** `x`/`y` (and `rotation` if the ghost was rotated) via the
   `Mutable<PlacedBuilding>` cast idiom. **All other fields persist untouched**:
   `floorLevel`, `constructionRemainingMs` (a mid-construction building keeps its
   timer; an operational one stays operational), `operatingMs`, `maintainedAt`,
   `toxicityExpiryMs`, `disabled`, `cargoLabel`, `tier`, etc.
5. Return `{ ok: true, charged }`.

No work needed for routes (keyed by building `id`, which is unchanged) or
storage caps (position-independent — same island, same def, same floor).

## Demolish fix (floor-aware)

In `demolishBuilding()` (`placement.ts:797`), replace the base-cost reads with
`totalInvestedCost(b, def)`:

- Per-resource refund: `floor(totalInvested[r] / 2)` (was `floor(base[r] / 2)`).
- Scrap: `floor(0.3 × sum(totalInvested))` (was `floor(0.3 × sum(base))`).

Clamping to caps and the rest of the demolish flow (array removal, storage-cap
strip, inventory clamp) are unchanged.

Update the inspector previews to match:

- `previewRefundForBuilding(b)` (`inspector-ui.ts:122`) already receives the
  building — switch its internal calc to `totalInvestedCost`.
- `previewScrapForBuilding(defId)` (`inspector-ui.ts:110`) currently takes only
  `defId`; change its signature to take the `PlacedBuilding` (it needs
  `floorLevel`) and update the single call site.

Net effect: upgraded buildings now recover their floor investment on demolish
instead of forfeiting it.

## UI wiring

- Add `onMove(target: InspectorTarget): void` to the `InspectorDeps` interface
  (`inspector-ui.ts:168`).
- Add a **"Move"** button to the inspector footer beside Demolish
  (`inspector-ui.ts:1069`+), labelled with the fee (e.g. `✥ MOVE · −170 stone`).
  Disabled / greyed when the fee is unaffordable (parallel to how Demolish reads).
- `main.ts` wires `onMove` to enter a **relocate mode** in `placement-ui.ts`: a
  variant of the existing ghost-placement flow, parameterized by the building
  being moved. The building's footprint ghost follows the cursor; validity uses
  `validatePlacement(..., ignoreBuildingId: building.id)`; clicking a valid tile
  calls `relocateBuilding()` then rebuilds world layers; Esc / right-click
  cancels (no fee). Reuses the existing ghost render + validator rather than a
  parallel overlay.

### Architecture choice

Extend `placement-ui` with a relocate mode (chosen) over: (a) a separate
parallel relocate overlay — duplicates ghost/validation logic; (b) a
demolish-then-replace hack — would drain routes, change the building `id`, and
lose runtime state mid-flight. The relocate-mode variant reuses the most and
preserves identity/state.

## Persistence

**No schema migration.** Relocate only mutates `x`/`y` of an already-serialized
`PlacedBuilding`; the demolish fix changes refund *amounts*, not snapshot shape.

## Testing

Pure-layer (no PixiJS/DOM):

- `totalInvestedCost`: floor 0 = base; floor L = base + L×ceil(0.8×base) per
  resource; multi-resource defs.
- `relocateBuilding` happy path: fee deducted exactly (= floor(0.5×total)); only
  `x`/`y` changed; `floorLevel`/`constructionRemainingMs`/maintenance/`disabled`
  preserved; returns `{ ok, charged }`.
- relocate rejects: overlap with **another** building (`'overlap'`); destination
  fails terrain `requiredTile` (`'tile-requirement-not-met'`); out of bounds;
  `'insufficient-resources'` when fee unaffordable (inventory unchanged on
  failure); `'not-found'` for a bad id.
- relocate **allows** overlap with the building's **own** current footprint (a
  1-tile shift) via `ignoreBuildingId`.
- `validatePlacement` with `ignoreBuildingId`: excludes that building's tiles
  from the occupied set; still rejects overlap with others.
- Demolish floor-awareness: refund and scrap scale with `floorLevel` (floor-0
  matches today's values; floor-N is strictly larger), clamped to caps.

## Non-goals

- Cross-island relocation (explicitly out of scope — terrain/economy/networking
  blast radius).
- Re-entering construction on move (rejected — "just teleport").
- Drag-and-drop UX (rejected in favour of the ghost-mode button).
- Bulk / multi-building move.
