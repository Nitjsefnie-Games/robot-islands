// Building placement — pure tile math + validation + state mutation.
//
// SPEC §4 in summary:
//   §4.1 footprint shapes — buildings cover one or more tiles. Step 2.5
//        simplifies to rectangular footprints (BuildingDef.width × .height);
//        custom L-tromino / tetromino shapes per §4.1 are DEFERRED (no current
//        def uses them). The footprint mask is implicit `[(0,0)..(w-1,h-1)]`.
//   §4.2 rotation — 4-way (0/90/180/270 CW). For a rectangle this just swaps
//        width/height on rotation 1/3 (no-op on 0/2). The transform here is
//        written to also work when a non-rectangular shape mask lands later.
//   §4.3 placement rules — every footprint tile must be inscribed in the
//        island ellipse (§3.4), no tile may overlap any existing footprint,
//        and the def must be tier-unlocked (§9.2 / §13.1).
//   §4.4 adjacency — metadata only; effect computation DEFERRED (no consumer
//        wired yet — Step 11 added the heat-source flag plumbing but the
//        per-frame buff computation is still a future step).
//
// Other deferrals documented at the call sites:
//   - Terrain-tile requirements per §4.3 (Mine "should" need ore vein, Logger
//     a tree tile, etc.) — DEFERRED. No current BuildingDef carries a
//     `requiredTile` field; step 2.5 accepts any in-island tile.
//   - Adjacency effects (§4.5) — DEFERRED.
//   - Placement-time material cost — DEFERRED. Placement is free in step 2.5;
//     real costs land in step 14 alongside the cost-curve work.
//   - Demolition — DEFERRED. Placed buildings cannot be removed in step 2.5.
//
// No PixiJS, no DOM, no IslandState construction-time helpers — this module
// is pure: takes a spec + state + def id + anchor + rotation, returns a
// validation verdict, optionally appends a new PlacedBuilding.

import { BUILDING_DEFS, buildingUnlocked, canPlaceOnIsland, type BuildingDefId } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import type { IslandState } from './economy.js';
import { tileInscribedInEllipse } from './island.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { RESOURCE_STORAGE_CATEGORY } from './storage-categories.js';
import type { IslandSpec } from './world.js';

/** Default cargo label for a freshly-placed generic-storage building (Crate,
 *  Warehouse). The §4.6 spec says the player labels at placement time, but
 *  the placement modal hasn't been extended for the label picker yet — so we
 *  seed a sensible default and let the inspector's relabel path take it
 *  from there. `iron_ore` is the cheapest, earliest-game resource the player
 *  is reliably producing, so labeling defaults to it. */
const DEFAULT_CARGO_LABEL: ResourceId = 'iron_ore';

/** 4-way rotation in 90° CW increments. 0 = identity, 1 = 90° CW, etc. */
export type Rotation = 0 | 1 | 2 | 3;

/**
 * All tile coordinates a rectangular footprint of nominal `width × height`
 * covers when its anchor (top-left of the unrotated rectangle) sits at
 * `(anchorX, anchorY)` under the given rotation.
 *
 * Convention: rotation pivots around the anchor and stays anchored at the
 * top-left of the AXIS-ALIGNED bounding box that wraps the rotated shape.
 * For a w×h rectangle the bounding box is (w × h) on rotations 0/2 and
 * (h × w) on rotations 1/3. The set of tiles a 2×3 rectangle covers under
 * rotation 1 is therefore a 3×2 axis-aligned block at the same anchor —
 * just with the original "width axis" now running vertically. This matches
 * the §4.2 spec where rotation does not move the placement origin, only
 * reshapes the footprint extent.
 *
 * Implementation: enumerate the original footprint mask (implicit
 * [0..w-1] × [0..h-1] for step 2.5), rotate each (dx, dy) into the bounding
 * box coordinate system, emit (anchor + rotated). The math is general
 * enough that swapping to an explicit shape mask (when L-trominoes land)
 * only requires changing the enumeration source.
 */
export function footprintTiles(
  width: number,
  height: number,
  anchorX: number,
  anchorY: number,
  rotation: Rotation,
): ReadonlyArray<{ readonly x: number; readonly y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  // Original mask offsets are dx in [0..w-1], dy in [0..h-1]. Under rotation
  // r, the rotated offset (rx, ry) is computed so the bounding box stays
  // anchored at (0,0). The transforms (worked out from a 90° CW rotation of
  // a w×h block):
  //   0:  (dx, dy)
  //   1:  (h-1-dy, dx)            — 90° CW: x' = h-1-y, y' = x
  //   2:  (w-1-dx, h-1-dy)        — 180°
  //   3:  (dy, w-1-dx)            — 270° CW: x' = y, y' = w-1-x
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      let rx: number;
      let ry: number;
      switch (rotation) {
        case 0:
          rx = dx;
          ry = dy;
          break;
        case 1:
          rx = height - 1 - dy;
          ry = dx;
          break;
        case 2:
          rx = width - 1 - dx;
          ry = height - 1 - dy;
          break;
        case 3:
          rx = dy;
          ry = width - 1 - dx;
          break;
      }
      out.push({ x: anchorX + rx, y: anchorY + ry });
    }
  }
  return out;
}

/**
 * The effective axis-aligned bounding-box dimensions of a footprint of
 * nominal `width × height` under rotation. Rectangles: rotations 0/2 keep
 * `{w, h}`; rotations 1/3 swap to `{h, w}`.
 */
export function rotatedDims(
  width: number,
  height: number,
  rotation: Rotation,
): { readonly width: number; readonly height: number } {
  if (rotation === 1 || rotation === 3) return { width: height, height: width };
  return { width, height };
}

/** Reasons placement can fail. Mirrors the §4.3 rule set plus the §9.5
 *  biome-locked-unique gate. `out-of-bounds` covers any tile of the
 *  rotated footprint that isn't inscribed in the island ellipse (§3.4).
 *  `tile-requirement-not-met` fires when `def.requiredTile` is set and at
 *  least one footprint tile's TerrainKind isn't in the allowed set — §4.3
 *  ("All terrain-tile requirements are satisfied"). */
export type PlacementReason =
  | 'out-of-bounds'
  | 'overlap'
  | 'def-not-unlocked'
  | 'biome-locked'
  | 'tile-requirement-not-met';

export interface PlacementValidation {
  readonly ok: boolean;
  readonly reason?: PlacementReason;
}

/**
 * Validate a placement candidate. Pure: reads `spec.majorRadius/minorRadius/
 * biome/artificial/buildings` and `state.level/aiCoreCrafted`; does not
 * mutate either.
 *
 * Order matters for the reason code returned on failure — we surface the
 * "fundamental" problems first so the UI shows the most actionable message:
 *
 *   1. def-not-unlocked      (player's island level is too low; nothing they
 *      can do in the placement modal will fix this — they need to keep playing).
 *   2. biome-locked          (§9.5 unique that can't be placed here; the
 *      player needs to pick a different island).
 *   3. out-of-bounds         (geometry; the player can move the cursor).
 *   4. overlap               (geometry; the player can move the cursor).
 *   5. tile-requirement-not-met (§4.3 — placement reaches a real tile in the
 *      island but its TerrainKind isn't acceptable for this def. Geometry-
 *      adjacent: the player can move the cursor to a tile that matches.)
 *
 * The 1-2 split also has a defense-in-depth angle: `buildings-ui.ts` already
 * soft-disables biome-locked rows, but a future entry point (drag-drop?
 * keyboard placement?) could call the validator directly with no UI gate.
 */
export function validatePlacement(
  spec: IslandSpec,
  state: IslandState,
  defId: BuildingDefId,
  anchorX: number,
  anchorY: number,
  rotation: Rotation,
): PlacementValidation {
  const def = BUILDING_DEFS[defId];
  if (!buildingUnlocked(state.level, defId, state.aiCoreCrafted)) {
    return { ok: false, reason: 'def-not-unlocked' };
  }
  if (!canPlaceOnIsland(def, spec)) {
    return { ok: false, reason: 'biome-locked' };
  }
  const tiles = footprintTiles(def.width, def.height, anchorX, anchorY, rotation);
  for (const t of tiles) {
    if (!tileInscribedInEllipse(t.x, t.y, spec.majorRadius, spec.minorRadius)) {
      return { ok: false, reason: 'out-of-bounds' };
    }
  }
  // Overlap check: build a Set of (x,y) covered by existing buildings, then
  // probe each new tile. For the home island's ~10 buildings × avg 4 tiles
  // = 40 tiles, set construction is cheap; for an Ω(N²) brute-force on each
  // placement query the constant is also fine, but the set version is
  // forward-compatible to many-building islands.
  const covered = new Set<string>();
  for (const existing of spec.buildings) {
    const existingDef = BUILDING_DEFS[existing.defId];
    const existingRot = (existing.rotation ?? 0) as Rotation;
    const eTiles = footprintTiles(
      existingDef.width,
      existingDef.height,
      existing.x,
      existing.y,
      existingRot,
    );
    for (const et of eTiles) covered.add(`${et.x},${et.y}`);
  }
  for (const t of tiles) {
    if (covered.has(`${t.x},${t.y}`)) return { ok: false, reason: 'overlap' };
  }
  // §4.3 terrain-tile requirement. `def.requiredTile`, when set and
  // non-empty, demands EVERY footprint tile's TerrainKind to lie in the
  // allowed set — per the spec "Mine requires every cell of its footprint to
  // be on an ore/coal vein". For Mine the allowed set is ['ore','coal']; a
  // mixed footprint (some ore + some coal) is fine because both belong to
  // the set, but a single grass tile in the footprint fails the gate.
  //
  // If the def has no `requiredTile` (Workshop / Solar / Smelter / etc.) or
  // the spec carries no `terrainAt` closure (synthetic test specs), this
  // check is a no-op and placement passes through. The latter preserves
  // legacy test behaviour for fixtures that don't model terrain.
  if (def.requiredTile && def.requiredTile.length > 0 && spec.terrainAt) {
    const allowed = def.requiredTile;
    for (const t of tiles) {
      const k = spec.terrainAt(t.x, t.y);
      if (!allowed.includes(k)) {
        return { ok: false, reason: 'tile-requirement-not-met' };
      }
    }
  }
  return { ok: true };
}

/**
 * Append a new PlacedBuilding to the island. The caller MUST have first
 * verified `validatePlacement(...).ok` — this function does not re-check.
 *
 * Mutates:
 *   - `spec.buildings` — push the new instance. `IslandState.buildings` is
 *     a live reference to the same array (see `makeInitialIslandState`),
 *     so the economy loop sees the new building on the next tick.
 *   - `state.storageCaps` — if the def carries a `storageCap`, bump every
 *     resource's nominal cap by that amount. Mirrors `aggregateStorageCaps`
 *     used at init; the field's `readonly` modifier on the IslandState
 *     interface protects the record reference, not its key values.
 *
 * `idGenerator` returns a fresh unique id for the new instance. The caller
 * picks the id-shape (artificial-island.ts uses `art-N`; placement-ui uses
 * `placed-N`). The function takes a generator rather than an id directly so
 * the caller can lazily mint only when a placement actually commits.
 *
 * Cost deduction (§14): DEFERRED. Placement is free in step 2.5 — no
 * material cost is consumed here. Real costs land alongside the §14
 * resource-cost curves; this function will then read `def.placementCost`
 * (when it exists) and call `state.inventory[r] -= cost` per material.
 */
export function placeBuilding(
  spec: IslandSpec,
  state: IslandState,
  defId: BuildingDefId,
  anchorX: number,
  anchorY: number,
  rotation: Rotation,
  idGenerator: () => string,
  /** §4.7 maintenance: perf-domain timestamp to seed the building's
   *  placedAt / maintainedAt at. Defaults to the state's lastTick — the
   *  same perf-clock anchor `advanceIsland` integrates from, so a freshly-
   *  placed building has `operatingMs = 0` and accrues from the next tick
   *  forward. Tests can inject a specific value when they want to assert
   *  maintenance-cycle math. */
  nowMs: number = state.lastTick,
): PlacedBuilding {
  const def = BUILDING_DEFS[defId];
  // §4.6: generic-storage instances (Crate, Warehouse) carry a per-instance
  // cargoLabel naming which resource they hold. The placement modal label
  // picker isn't built yet, so we seed a sensible default; the inspector
  // exposes a relabel control afterward.
  const cargoLabel =
    def.storage?.category === 'generic' ? DEFAULT_CARGO_LABEL : undefined;
  const placed: PlacedBuilding = {
    id: idGenerator(),
    defId,
    x: anchorX,
    y: anchorY,
    rotation,
    ...(cargoLabel !== undefined ? { cargoLabel } : {}),
    // §4.7 maintenance seeds. operatingMs starts at zero; placedAt and
    // maintainedAt mark the perf-clock moment the timer began.
    placedAt: nowMs,
    operatingMs: 0,
    maintainedAt: nowMs,
  };
  spec.buildings.push(placed);
  // Bump storage caps per §4.6 categorized routing. Specialized buildings
  // bump every resource matching their category; generic buildings bump
  // only the cargoLabel resource. Both paths mirror `aggregateStorageCaps`.
  const storage = def.storage;
  if (storage) {
    if (storage.category === 'generic') {
      if (cargoLabel !== undefined) {
        state.storageCaps[cargoLabel] =
          (state.storageCaps[cargoLabel] ?? 0) + storage.capacity;
      }
    } else {
      for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
        if (RESOURCE_STORAGE_CATEGORY[r] === storage.category) {
          state.storageCaps[r] = (state.storageCaps[r] ?? 0) + storage.capacity;
        }
      }
    }
  }
  return placed;
}

// ---------------------------------------------------------------------------
// §4 / §6.7 — hit-test + demolition
// ---------------------------------------------------------------------------

/**
 * Return the placed building whose footprint covers world-tile `(wx, wy)`
 * (in island-local tile coords), or null if no building covers it.
 *
 * Pure: walks `spec.buildings`, computing each footprint via the same
 * `footprintTiles` math the placement validator uses. First-match wins —
 * footprints don't overlap by construction (the placement gate rejects
 * overlap), but a defensive first-match keeps behaviour predictable if a
 * mis-built test fixture ships overlapping placements.
 *
 * O(buildings × footprint-area). Building counts per island are small
 * (≤ ~30 on the demo islands), so a flat scan is plenty.
 */
export function buildingAtTile(
  spec: IslandSpec,
  wx: number,
  wy: number,
): PlacedBuilding | null {
  // Snap to integer tile — callers pass either integer or fractional tile
  // coords (mouse hit-test is fractional). Because tile (n) is rendered
  // centred on world pixel (n * TILE_PX), its visual extent spans
  // [n - 0.5, n + 0.5) in fractional-tile space. Math.round maps a
  // fractional coord to the tile whose visual centre is nearest — matching
  // the half-tile rendering convention in renderIslandTiles / renderBuildings
  // where tile (n) draws at (n * TILE_PX - TILE_PX/2).
  const tx = Math.round(wx);
  const ty = Math.round(wy);
  for (const b of spec.buildings) {
    const def = BUILDING_DEFS[b.defId];
    const tiles = footprintTiles(def.width, def.height, b.x, b.y, (b.rotation ?? 0) as Rotation);
    for (const t of tiles) {
      if (t.x === tx && t.y === ty) return b;
    }
  }
  return null;
}

/** Result of a demolition attempt. `scrapReturned` is the credit applied
 *  to `state.inventory.scrap` after clamping to the resource's cap. On the
 *  `not-found` branch `scrapReturned` is 0 and `reason` is populated. */
export interface DemolishResult {
  readonly ok: boolean;
  readonly scrapReturned: number;
  readonly reason?: 'not-found';
}

/**
 * Remove a placed building and credit the player with Scrap per §6.7
 * ("Demolishing any T1+ placed building produces Scrap proportional to its
 * build cost"). The §6.7 ingredient-mirror formula is DEFERRED until
 * placement-time material costs land (§14); the step-2.5 placeholder
 * formula scales with footprint area:
 *
 *   scrap = footprint-tile-count × 3
 *
 * That keeps a 1×1 Solar (3 scrap), 2×2 Mine (12), 3×3 Blast Furnace (27),
 * and 4×4 Fusion Core (48) on a sane progression curve while the proper
 * cost-based formula is unbuilt.
 *
 * Mutations on the `{ ok: true }` path:
 *   - Removes the building from `spec.buildings` (state.buildings is the
 *     same array reference, so both stay consistent).
 *   - For storage defs (def.storage defined): subtracts the `storage.capacity`
 *     contribution from every category-matching resource (specialized) or
 *     only the building's cargoLabel resource (generic). Mirrors the
 *     `placeBuilding` bump exactly, so place→demolish round-trips to the
 *     same caps. Per §4.6 last paragraph ("If current inventory of any
 *     affected resource now exceeds the reduced cap, the excess is lost —
 *     inventory clamps down to the new cap"), we then clamp `inventory[r]`
 *     to the new cap on every affected resource.
 *   - Credits `state.inventory.scrap`, clamped to the post-demolish scrap cap.
 *
 * Returns `{ ok: false, reason: 'not-found' }` when the id isn't present —
 * a defensive guard so a stale UI handle (e.g., demolition button held
 * after the building was already removed) doesn't corrupt state. Pure
 * function in the §15.3-pure-layer sense: no DOM, no PixiJS.
 */
export function demolishBuilding(
  spec: IslandSpec,
  state: IslandState,
  buildingId: string,
): DemolishResult {
  const idx = spec.buildings.findIndex((b) => b.id === buildingId);
  if (idx < 0) return { ok: false, scrapReturned: 0, reason: 'not-found' };
  const b = spec.buildings[idx]!;
  const def = BUILDING_DEFS[b.defId];
  // Footprint-area × 3 placeholder per §6.7 (proper recipe-cost mirror
  // deferred until §14 placement costs ship). `footprintTiles` returns the
  // axis-aligned tile coverage — count its length.
  const tiles = footprintTiles(
    def.width,
    def.height,
    b.x,
    b.y,
    (b.rotation ?? 0) as Rotation,
  );
  const scrapReturned = Math.floor(tiles.length * 3);
  // Splice out the building. `spec.buildings` and `state.buildings` are the
  // same array reference (see `makeInitialIslandState`), so this mutation
  // is visible to the next economy tick without an explicit sync.
  spec.buildings.splice(idx, 1);
  // Strip storage contribution if the demolished def was a storage building.
  // §4.6: after the cap reduction, inventory clamps to the new cap (the lost
  // excess models the spec's "excess is lost" rule literally). Categorized
  // routing mirrors `placeBuilding` — specialized buildings subtract from
  // every category-matching resource; generic buildings subtract only from
  // the cargoLabel resource.
  const storage = def.storage;
  if (storage) {
    const stripResource = (r: ResourceId): void => {
      const next = (state.storageCaps[r] ?? 0) - storage.capacity;
      state.storageCaps[r] = next < 0 ? 0 : next;
      const have = state.inventory[r] ?? 0;
      const newCap = state.storageCaps[r] ?? 0;
      if (have > newCap) state.inventory[r] = newCap;
    };
    if (storage.category === 'generic') {
      if (b.cargoLabel !== undefined) stripResource(b.cargoLabel);
    } else {
      for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
        if (RESOURCE_STORAGE_CATEGORY[r] === storage.category) stripResource(r);
      }
    }
  }
  // Credit the Scrap, clamped to its post-demolish cap. The clamp matches
  // `applyRates` in economy.ts — never overfill a stockpile.
  if (scrapReturned > 0) {
    const have = state.inventory.scrap ?? 0;
    const scrapCap = state.storageCaps.scrap ?? 0;
    const next = Math.min(scrapCap, have + scrapReturned);
    state.inventory.scrap = next;
  }
  return { ok: true, scrapReturned };
}
