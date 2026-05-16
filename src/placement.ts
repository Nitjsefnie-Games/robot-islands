// Building placement — pure tile math + validation + state mutation.
//
// SPEC §4 in summary:
//   §4.1 footprint shapes — buildings cover one or more tiles via an explicit
//        `ShapeMask` (a set of tile offsets). Rectangular masks are provided
//        by the `SHAPES` library in `shape-mask.ts`; L-tromino / tetromino
//        variants are available for future defs.
//   §4.2 rotation — 4-way (0/90/180/270 CW). For a rectangle this just swaps
//        width/height on rotation 1/3 (no-op on 0/2). The transform here is
//        written to also work when a non-rectangular shape mask lands later.
//   §4.3 placement rules — every footprint tile must be inscribed in the
//        island ellipse (§3.4), no tile may overlap any existing footprint,
//        and the def must be tier-unlocked (§9.2 / §13.1).
//   §4.4 adjacency — metadata only; effect computation STILL-DEFERRED (no consumer
//        wired yet — Step 11 added the heat-source flag plumbing but the
//        per-frame buff computation is still a future step).
//
// Other deferrals documented at the call sites:
//   - Terrain-tile requirements per §4.3 / §8.1 are implemented.
//     `validatePlacement` checks `def.requiredTile` against `spec.terrainAt`.
//   - Adjacency effects (§4.5) — STILL-DEFERRED.
//   - Placement-time material cost — STILL-DEFERRED. Placement is free in step 2.5;
//     real costs land in step 14 alongside the cost-curve work.
//   - Demolition — STILL-DEFERRED. Placed buildings cannot be removed in step 2.5.
//
// No PixiJS, no DOM, no IslandState construction-time helpers — this module
// is pure: takes a spec + state + def id + anchor + rotation, returns a
// validation verdict, optionally appends a new PlacedBuilding.

import { BUILDING_DEFS, buildingUnlocked, canPlaceOnIsland, type BuildingDef, type BuildingDefId } from './building-defs.js';
import {
  rotateShape,
  type ShapeMask,
  type Rotation,
  footprintTiles,
} from './shape-mask.js';
export { rotateShape, type ShapeMask };
import type { PlacedBuilding } from './buildings.js';
import { constructionTimeFor } from './construction.js';
import type { IslandState } from './economy.js';
import { tileInscribedInEllipse } from './island.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { effectiveSkillMultipliers } from './skilltree.js';
import { RESOURCE_STORAGE_CATEGORY } from './storage-categories.js';
import type { IslandSpec } from './world.js';

/** Default cargo label for a freshly-placed generic-storage building (Crate,
 *  Warehouse). The §4.6 spec says the player labels at placement time, but
 *  the placement modal hasn't been extended for the label picker yet — so we
 *  seed a sensible default and let the inspector's relabel path take it
 *  from there. `iron_ore` is the cheapest, earliest-game resource the player
 *  is reliably producing, so labeling defaults to it. */
const DEFAULT_CARGO_LABEL: ResourceId = 'iron_ore';

/** Reasons placement can fail. Mirrors the §4.3 rule set plus the §9.5
 *  biome-locked-unique gate. `out-of-bounds` covers any tile of the
 *  rotated footprint that isn't inscribed in the island ellipse (§3.4).
 *  `tile-requirement-not-met` fires when `def.requiredTile` is set and at
 *  least one footprint tile's TerrainKind isn't in the allowed set — §4.3
 *  ("All terrain-tile requirements are satisfied"). §14 adds
 *  `insufficient-resources` for the placement-cost gate. */
export type PlacementReason =
  | 'out-of-bounds'
  | 'overlap'
  | 'def-not-unlocked'
  | 'biome-locked'
  | 'tile-requirement-not-met'
  | 'insufficient-resources'
  | 'queue-full';

export interface PlacementValidation {
  readonly ok: boolean;
  readonly reason?: PlacementReason;
  /** When `reason === 'insufficient-resources'`, lists shortfall per
   *  resource (needed − have, > 0 entries only). Undefined otherwise. */
  readonly missing?: Partial<Record<ResourceId, number>>;
}

// ---------------------------------------------------------------------------
// §14 placement-cost helpers
// ---------------------------------------------------------------------------

/** Pure: given a def, return its placement-cost basket (empty record if the
 *  def has no `placementCost`). Wraps the optional field so callers can
 *  iterate `Object.entries` without an `??` everywhere. */
export function placementCostFor(
  def: BuildingDef,
): Partial<Record<ResourceId, number>> {
  return def.placementCost ?? {};
}

/** Pure: compute the shortfall per resource for a placement cost against the
 *  player's current inventory. Returns the empty record when the player can
 *  afford the placement (every cost entry covered).
 *
 *  Used by `validatePlacement` for the §14 gate and by `placement-ui.ts`
 *  for the cost-row red/green colouring and the "NEED N STONE" disabled-
 *  button label. Keeping it as a single helper means the UI and the
 *  validator can't drift on what "afford" means. */
export function affordabilityShortfall(
  inventory: Readonly<Record<ResourceId, number>>,
  cost: Partial<Record<ResourceId, number>>,
): Partial<Record<ResourceId, number>> {
  const missing: Partial<Record<ResourceId, number>> = {};
  for (const [r, needed] of Object.entries(cost) as Array<[ResourceId, number]>) {
    if (needed <= 0) continue;
    const have = inventory[r] ?? 0;
    if (have < needed) missing[r] = needed - have;
  }
  return missing;
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
 *   5. tile-requirement-not-met (§4.3 — def.requiredTile or def.coastal
 *      isn't satisfied. Geometry-adjacent: the player can move the cursor
 *      to a tile that matches.)
 *   6. insufficient-resources (§14 — every other gate passed but the
 *      player's inventory is below `def.placementCost`. Returned LAST so
 *      that an out-of-bounds cursor still surfaces the geometry error
 *      instead of mis-blaming inventory. `missing` carries the shortfall
 *      per resource so the UI can label "NEED 5 STONE" without
 *      recomputing the basket.)
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
  const hasSpaceport = spec.buildings.some((b) => b.defId === 'spaceport');
  if (
    !buildingUnlocked(
      state.level,
      defId,
      state.aiCoreCrafted,
      state.ascendantCoreCrafted,
      hasSpaceport,
    )
  ) {
    return { ok: false, reason: 'def-not-unlocked' };
  }
  if (!canPlaceOnIsland(def, spec)) {
    return { ok: false, reason: 'biome-locked' };
  }
  const tiles = footprintTiles(def.footprint, anchorX, anchorY, rotation);
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
      existingDef.footprint,
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
  // §8.8 coastal placement: at least one footprint tile must be water.
  if (def.coastal && spec.terrainAt) {
    let hasWater = false;
    for (const t of tiles) {
      if (spec.terrainAt(t.x, t.y) === 'water') {
        hasWater = true;
        break;
      }
    }
    if (!hasWater) {
      return { ok: false, reason: 'tile-requirement-not-met' };
    }
  }
  // §14 placement-cost gate. Computed LAST so the geometry/biome/tier
  // reasons take priority — if the cursor is out of bounds, "out of bounds"
  // is more actionable to surface than "you also can't afford this".
  const cost = placementCostFor(def);
  const missing = affordabilityShortfall(state.inventory, cost);
  if (Object.keys(missing).length > 0) {
    return { ok: false, reason: 'insufficient-resources', missing };
  }
  return { ok: true };
}

/** Result of a `placeBuilding` call. On success carries the freshly-minted
 *  `PlacedBuilding` so the caller can immediately read its id / coords /
 *  maintenance stamps. On failure the only currently-reachable reason is
 *  `'insufficient-resources'` (every other §4.3 / §9.5 / tier gate is
 *  validated up-front by `validatePlacement` and the placement-UI never
 *  invokes `placeBuilding` past `validatePlacement.ok`); the `missing`
 *  record describes the per-resource shortfall so callers (UI label) can
 *  surface "NEED 5 STONE" without recomputing the basket. */
export type PlaceBuildingResult =
  | { readonly ok: true; readonly placed: PlacedBuilding }
  | {
      readonly ok: false;
      readonly reason: 'insufficient-resources';
      readonly missing: Partial<Record<ResourceId, number>>;
    }
  | {
      readonly ok: false;
      readonly reason: 'queue-full';
      readonly inProgress: number;
      readonly slots: number;
    };

/** §9.3 Robotics: how many concurrent under-construction slots this island
 *  has right now. Base 1 + Robotics `parallelBuildBonus` (additive). */
export function parallelBuildSlots(state: IslandState): number {
  return 1 + Math.floor(effectiveSkillMultipliers(state).parallelBuildBonus);
}

/** Count of currently-under-construction buildings on the island. */
export function inProgressBuildCount(state: IslandState): number {
  let n = 0;
  for (const b of state.buildings) {
    if ((b.constructionRemainingMs ?? 0) > 0) n++;
  }
  return n;
}

/**
 * Append a new PlacedBuilding to the island, after paying the §14 placement
 * cost from `state.inventory`. The caller MUST have first verified
 * `validatePlacement(...).ok` for the geometry / tier / biome / tile gates
 * — this function does not re-check those. It DOES re-check the §14 cost
 * gate (cheap, prevents state corruption from a race between validate and
 * place).
 *
 * §14 cost deduction:
 *   - Reads `def.placementCost` (empty / undefined → free placement).
 *   - If the player's inventory is short on any cost resource, returns
 *     `{ok: false, reason: 'insufficient-resources', missing}` WITHOUT
 *     mutating `spec.buildings`, inventory, or storage caps.
 *   - On the success path the cost is deducted from `state.inventory`
 *     BEFORE the building is committed, so a mid-flight failure cannot
 *     leave a "paid but no building" hole.
 *
 * Mutations on the success path:
 *   - `state.inventory[r] -= cost[r]` for every entry in `def.placementCost`.
 *   - `spec.buildings` — push the new instance. `IslandState.buildings` is
 *     a live reference to the same array (see `makeInitialIslandState`),
 *     so the economy loop sees the new building on the next tick.
 *   - `state.storageCaps` — if the def carries a `storage` block, bump every
 *     resource's nominal cap by the contribution. Mirrors
 *     `aggregateStorageCaps` used at init; the field's `readonly` modifier
 *     on the IslandState interface protects the record reference, not its
 *     key values.
 *
 * `idGenerator` returns a fresh unique id for the new instance. The caller
 * picks the id-shape (artificial-island.ts uses `art-N`; placement-ui uses
 * `placed-N`). The function takes a generator rather than an id directly so
 * the caller can lazily mint only when a placement actually commits — and,
 * since the cost gate is checked BEFORE mint, a rejected placement still
 * does not consume an id-counter slot.
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
): PlaceBuildingResult {
  const def = BUILDING_DEFS[defId];
  // §14 placement-cost gate. Re-checked here even though validatePlacement
  // also gates: between the validator returning ok and the player clicking
  // commit, a sibling production tick could have consumed inventory. The
  // re-check is cheap (small basket, integer compares) and prevents a
  // race that would otherwise let the player place at -N stone.
  const cost = placementCostFor(def);
  const missing = affordabilityShortfall(state.inventory, cost);
  if (Object.keys(missing).length > 0) {
    return { ok: false, reason: 'insufficient-resources', missing };
  }
  // §9.3 Robotics parallel-build cap. Base 1 + per-island skill bonus. The
  // player can only place when there's a free construction slot on the
  // island. Refunding the cost on a queue-full reject is handled below
  // (we reject BEFORE the deduction).
  const slots = parallelBuildSlots(state);
  const inProgress = inProgressBuildCount(state);
  if (inProgress >= slots) {
    return { ok: false, reason: 'queue-full', inProgress, slots };
  }
  // Deduct cost BEFORE committing the building so any subsequent error
  // path can't leave inventory paid + no building. (No fallible operations
  // sit between this and the push — but writing it this way makes the
  // invariant explicit and survives later refactors.)
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    if (n <= 0) continue;
    state.inventory[r] = (state.inventory[r] ?? 0) - n;
  }
  // §4.6: generic-storage instances (Crate, Warehouse) carry a per-instance
  // cargoLabel naming which resource they hold. The placement modal label
  // picker isn't built yet, so we seed a sensible default; the inspector
  // exposes a relabel control afterward.
  const cargoLabel =
    def.storage?.category === 'generic' ? DEFAULT_CARGO_LABEL : undefined;
  // §9.3 Robotics: construction time at placement, scaled by skill mul.
  // Operating time only begins accruing after construction completes
  // (the maintenance-tick loop honours constructionRemainingMs > 0 by
  // skipping accrual; computeRates honours it by zeroing production).
  const skillMul = effectiveSkillMultipliers(state);
  const construction = constructionTimeFor(def, skillMul.constructionTime);
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
    ...(construction > 0 ? { constructionRemainingMs: construction } : {}),
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
  return { ok: true, placed };
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
    const tiles = footprintTiles(def.footprint, b.x, b.y, (b.rotation ?? 0) as Rotation);
    for (const t of tiles) {
      if (t.x === tx && t.y === ty) return b;
    }
  }
  return null;
}

/** Result of a demolition attempt. `scrapReturned` is the §6.7 build-cost scrap credit
 *  (`floor(sum(placementCost) * 0.3)`) applied to `state.inventory.scrap` after clamping to
 *  the resource's cap. `refunded` is the §14 50%-of-placement-cost return
 *  applied per-resource (each entry clamped to its respective cap, so the
 *  reported number reflects what actually landed in inventory). On the
 *  `not-found` branch both fields are zero/empty and `reason` is populated. */
export interface DemolishResult {
  readonly ok: boolean;
  readonly scrapReturned: number;
  /** §14: per-resource refund (50% of placementCost, floor). Each entry is
   *  the amount that actually landed in `state.inventory` after clamping to
   *  the resource cap. Empty record on the failure branch or when the
   *  demolished building had no placementCost (e.g. legacy save). */
  readonly refunded: Partial<Record<ResourceId, number>>;
  readonly reason?: 'not-found';
}

/**
 * Remove a placed building and credit the player with two compensations:
 *
 *   1. §6.7 Scrap, proportional to build cost: `floor(sum(placementCost) * 0.3)`.
 *      Every def post-§14 carries a placementCost; if one somehow doesn't,
 *      `placementCostFor` returns `{}` and scrap is 0.
 *
 *   2. §14 placement-cost refund: 50% of `def.placementCost`, floored
 *      per-resource. A 30-stone Mine demolition refunds 15 stone; a
 *      15-wood Mine refunds 7 wood. Each refund entry is clamped to its
 *      resource cap (the §4.6 "excess is lost" rule applies to refunds
 *      the same way it applies to recipe production). Buildings without
 *      a `placementCost` (defensively — every shipped def carries one
 *      post-§14) demolish without a placement-cost refund but still earn
 *      the Scrap credit.
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
 *     to the new cap on every affected resource. The storage strip runs
 *     BEFORE the §14 refund credit so refunds land into the post-demolish
 *     caps, not the pre-demolish caps (matters when demolishing a Crate
 *     whose own placement cost would have been refundable into the same
 *     resource it stored).
 *   - Credits `state.inventory.scrap`, clamped to the post-demolish scrap cap.
 *   - Credits each §14 refund resource to `state.inventory[r]`, clamped to
 *     the post-demolish cap on that resource.
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
  if (idx < 0) {
    return { ok: false, scrapReturned: 0, refunded: {}, reason: 'not-found' };
  }
  const b = spec.buildings[idx]!;
  const def = BUILDING_DEFS[b.defId];
  const cost = placementCostFor(def);
  const costSum = Object.values(cost).reduce((sum, n) => sum + n, 0);
  const scrapReturned = Math.floor(costSum * 0.3);
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
  // §14 50% placement-cost refund, floored per-resource. Each line is
  // clamped to the resource's post-demolish cap (so a refund into a full
  // stone stockpile lands the available headroom and the rest is lost,
  // mirroring §4.6's "excess is lost" rule for production overflow). The
  // `refunded` record reports the ACTUAL credit, not the raw 50% — useful
  // for the UI to surface "12 stone clamped to cap, 6 wood refunded".
  // Buildings without a placementCost (defensive forward-compat for legacy
  // saves) refund nothing here; the Scrap credit above still fires.
  const refunded: Partial<Record<ResourceId, number>> = {};
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    if (n <= 0) continue;
    const half = Math.floor(n / 2);
    if (half <= 0) continue;
    const have = state.inventory[r] ?? 0;
    const cap = state.storageCaps[r] ?? 0;
    const next = Math.min(cap, have + half);
    const credited = next - have;
    if (credited > 0) {
      state.inventory[r] = next;
      refunded[r] = credited;
    }
  }
  return { ok: true, scrapReturned, refunded };
}
