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
//   §4.4 adjacency — metadata flagged on each PlacedBuilding; the heat-source
//        side (§5.2) and reactor toxicity are wired. §4.5 Wastewater
//        Treatment and Exhaust Scrubber soft-gates are live. The Cooling
//        Tower → Crystal Lab unlock remains STILL-DEFERRED.
//
// Other deferrals documented at the call sites:
//   - Terrain-tile requirements per §4.3 / §8.1 are implemented.
//     `validatePlacement` checks `def.requiredTile` against `spec.terrainAt`.
//   - Placement-time material cost is wired alongside the §15 cost-curve.
//   - Demolition is wired (refund per §4.6).
//
// No PixiJS, no DOM, no IslandState construction-time helpers — this module
// is pure: takes a spec + state + def id + anchor + rotation, returns a
// validation verdict, optionally appends a new PlacedBuilding.

import { BUILDING_DEFS, buildingUnlocked, canPlaceOnIsland, type BuildingDef, type BuildingDefId } from './building-defs.js';
import {
  rotateShape,
  shapeWidth,
  shapeHeight,
  type ShapeMask,
  type Rotation,
  footprintTiles,
} from './shape-mask.js';
export { rotateShape, type ShapeMask };
import { hasOperationalBuilding, type PlacedBuilding } from './buildings.js';
import { constructionTimeFor } from './construction.js';
import type { IslandState } from './economy.js';
import { tileInscribedInEllipse } from './island.js';
import { footprintMatches } from './ocean-cell.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { effectiveSkillMultipliers, hasBiomeBypass, effectiveTierShift, tierForLevel, DEFAULT_GRAPH } from './skilltree.js';
import type { Graph } from './skilltree-graph.js';
import { RESOURCE_STORAGE_CATEGORY } from './storage-categories.js';
import { candidateAnchors } from './anchor-picker.js';
import { isOceanTile, type IslandSpec, type WorldState } from './world.js';
import { CELL_SIZE_TILES } from './constants.js';
import { brushTilesAt } from './terrain-modifier.js';

/** Fallback cargo label for a freshly-placed generic-storage building (Crate,
 *  Warehouse) when the caller of `placeBuilding` does NOT supply an explicit
 *  `cargoLabel` argument. The §4.6-mandated placement-time picker lives in
 *  `placement-ui.ts` (mounted via `mountCargoLabelPicker`) and always passes
 *  the player's choice through to `placeBuilding`, so this fallback only
 *  applies on programmatic paths — synthetic test fixtures and any future
 *  scripted placement that doesn't run the picker. `iron_ore` is the
 *  earliest-game resource the player is reliably producing, mirroring the
 *  picker's own default selection so behaviour is consistent across paths. */
export const DEFAULT_CARGO_LABEL: ResourceId = 'iron_ore';

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
  | 'queue-full'
  /** Defense-in-depth: the def carries `oceanPlacement: true` and must route
   *  through `validateOceanPlacement` + the anchor picker, not the land
   *  validator. The UI (buildings-ui.ts) filters ocean defs out of the land
   *  catalog so the player never reaches this path — this reason fires only
   *  on programmatic / test paths that bypass the catalog. Surfaced FIRST so
   *  the routing bug is visible even when other gates (tier, biome) would
   *  also fail. */
  | 'def-is-ocean';

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
  graph: Graph = DEFAULT_GRAPH,
): PlacementValidation {
  const def = BUILDING_DEFS[defId];
  // Defense-in-depth routing guard: an ocean def must NEVER be validated
  // through the land path. The catalog UI (buildings-ui.ts) filters them
  // out, but a programmatic caller (test fixture, future drag-drop API)
  // could still reach this path. Bail out FIRST — before tier/biome so the
  // routing bug surfaces as `def-is-ocean` rather than getting masked by
  // `def-not-unlocked` on an island that hasn't reached the def's tier.
  if (def.oceanPlacement === true) {
    return { ok: false, reason: 'def-is-ocean' };
  }
  const hasSpaceport = hasOperationalBuilding(spec.buildings, 'spaceport');
  const tierShift = effectiveTierShift(state, defId, graph);
  let isUnlocked = buildingUnlocked(
    state.level,
    defId,
    state.aiCoreCrafted,
    state.ascendantCoreCrafted,
    hasSpaceport,
  );
  if (!isUnlocked && tierShift > 0 && def.tier <= 4) {
    isUnlocked = tierForLevel(state.level) >= def.tier - tierShift;
  }
  if (!isUnlocked) {
    return { ok: false, reason: 'def-not-unlocked' };
  }
  if (!canPlaceOnIsland(def, spec) && !hasBiomeBypass(state, defId, graph)) {
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
  // terrain_modifier v5: the brush is 16 tiles (2×2 footprint + 12 ring).
  // Per p2_block_vs_brush = abort_if_any_occupied, ANY occupied tile in the
  // brush aborts placement — not just the 4 footprint tiles. Per
  // p2_water_ellipse = inside_ellipse_only, every brush tile must lie
  // inside the island's union ellipse (out-of-ellipse tiles do NOT abort
  // placement — they are SKIPPED at shot resolution per
  // p3_ellipse_boundary = skip_outside_full_charge — but at least the
  // 4 footprint tiles must be inside, that's the standard footprint
  // constraint and already enforced above).
  if (def.terrainModifier === true) {
    const brush = brushTilesAt(anchorX, anchorY);
    // Build a set of occupied tile keys from all existing buildings on the
    // island. Mirrors the footprint-overlap loop above but indexes once for
    // the O(brush × existing) lookup to drop to O(brush + existing).
    const occupied = new Set<string>();
    for (const b of state.buildings) {
      const bdef = BUILDING_DEFS[b.defId];
      const btiles = footprintTiles(
        bdef.footprint, b.x, b.y, (b.rotation ?? 0) as Rotation,
      );
      for (const t of btiles) occupied.add(`${t.x},${t.y}`);
    }
    for (const t of brush) {
      if (occupied.has(`${t.x},${t.y}`)) {
        return { ok: false, reason: 'overlap' };
      }
    }
    // Note: out-of-ellipse brush tiles are intentionally NOT rejected here.
    // Spec p3_ellipse_boundary = skip_outside_full_charge: those tiles are
    // charged for but silently skipped at shot resolution (Task 4).
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
    }
  /** Defense-in-depth (Task 10 review): the id-generator returned an id
   *  already present in `spec.buildings`. Currently unreachable because
   *  `validatePlacement`'s overlap gate and `validateOceanPlacement`'s
   *  `land-overlap` gate together ensure no two buildings can share an
   *  anchor (so the coords-derived `placed-${x},${y}` id is unique). If a
   *  future change loosens either gate this surfaces the collision instead
   *  of letting two buildings share an id silently. */
  | { readonly ok: false; readonly reason: 'overlap' };

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
  /** §4.6: explicit cargo label for generic-storage defs (Crate, Warehouse).
   *  Production callers route through the placement-UI picker
   *  (`mountCargoLabelPicker`) and pass the player's selection here. When
   *  omitted on a generic-storage def, falls back to `DEFAULT_CARGO_LABEL`
   *  (iron_ore) — preserves backward-compat for programmatic / test
   *  placement paths that bypass the picker. Ignored entirely for non-
   *  generic-storage defs (specialized storage uses category-routing; non-
   *  storage defs carry no cargo label at all). */
  cargoLabelOverride?: ResourceId,
  /** §4 ocean-layer (Task 10) — anchor island id for an ocean-placed
   *  building. Required for any def with `oceanPlacement: true` (the
   *  placement-UI ocean path threads the player's pick from the anchor
   *  modal); ignored / unused on land defs. Stored verbatim on the minted
   *  PlacedBuilding so the economy tick can resolve the anchor at every
   *  segment via `oceanPlatformPausedReason`. Optional so non-ocean
   *  callers (test fixtures, land placement) can omit it without churn. */
  anchorIslandId?: string,
  terrainTargetOverride?: import('./island.js').TerrainKind,
  terrainShotRemainingMsOverride?: number,
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
  // cargoLabel naming which resource they hold. The placement-UI picker
  // (`mountCargoLabelPicker`) feeds the player's choice via the
  // `cargoLabelOverride` argument; programmatic callers that omit it land
  // on the `DEFAULT_CARGO_LABEL` fallback. The inspector exposes a relabel
  // control if the player wants to change it after placement.
  const cargoLabel =
    def.storage?.category === 'generic'
      ? (cargoLabelOverride ?? DEFAULT_CARGO_LABEL)
      : undefined;
  // §9.3 Robotics: construction time at placement, scaled by skill mul.
  // Operating time only begins accruing after construction completes
  // (the maintenance-tick loop honours constructionRemainingMs > 0 by
  // skipping accrual; computeRates honours it by zeroing production).
  const skillMul = effectiveSkillMultipliers(state);
  const construction = constructionTimeFor(def, skillMul.constructionTime);
  const id = idGenerator();
  // Task 10 review defense-in-depth: id collisions are currently impossible
  // because `validatePlacement`'s `overlap` gate + `validateOceanPlacement`'s
  // `land-overlap` gate jointly ensure no two buildings share an anchor, and
  // the placement-UI mints ids from anchor coords. If a future change loosens
  // either gate this catches the collision instead of letting two buildings
  // share an id silently (which would break selection / inspect / persistence).
  // Cost has been deducted above — refund it before returning so the rejection
  // doesn't leave a "paid but no building" hole. (Unreachable today, but
  // future-proofs the path so it's a true error return rather than silent
  // inventory loss if the underlying invariant ever shifts.)
  if (spec.buildings.some((existing) => existing.id === id)) {
    for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
      if (n <= 0) continue;
      state.inventory[r] = (state.inventory[r] ?? 0) + n;
    }
    return { ok: false, reason: 'overlap' };
  }
  const placed: PlacedBuilding = {
    id,
    defId,
    x: anchorX,
    y: anchorY,
    rotation,
    ...(cargoLabel !== undefined ? { cargoLabel } : {}),
    // §4 ocean-layer: persist the player-picked anchor island id for any
    // def with `oceanPlacement: true`. The economy tick reads this on
    // every segment to credit the anchor's inventory and power pool
    // (`oceanPlatformPausedReason` in economy.ts).
    ...(anchorIslandId !== undefined ? { anchorIslandId } : {}),
    // terrain_modifier v5 — thread the target + shot timer when the def
    // opts in. The placement-ui (Task 3/5) supplies both overrides; a
    // programmatic caller that omits them leaves the building inert
    // (terrainShotRemainingMs === undefined → no shot resolution).
    ...(def.terrainModifier === true
      ? {
          terrainTarget: terrainTargetOverride,
          terrainShotRemainingMs: terrainShotRemainingMsOverride,
        }
      : {}),
    // §4.7 maintenance seeds. operatingMs starts at zero; placedAt and
    // maintainedAt mark the perf-clock moment the timer began.
    placedAt: nowMs,
    operatingMs: 0,
    maintainedAt: nowMs,
    ...(construction > 0 && def.instantBuild !== true ? { constructionRemainingMs: construction } : {}),
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

/**
 * §6 click-to-inspect at ocean cells. Mirrors `buildingAtTile` / the
 * `findPopulatedIslandAt → buildingAtTile` flow in main.ts but for
 * `oceanPlacement === true` defs whose footprints sit OUTSIDE any island
 * ellipse and therefore can't be reached by the land click path.
 *
 * Ocean-building coordinate convention (see placement-ui.ts attemptCommit
 * + placeBuilding):
 *  - `b.x, b.y` are anchor-local *tile* coords: `b.x = cellX * CELL_SIZE_TILES
 *    - anchor.cx`. World-tile origin of the footprint is therefore
 *    `(anchor.cx + b.x, anchor.cy + b.y)`.
 *  - `def.footprint` dims are in *cell* units for ocean defs (e.g. SHAPES.single
 *    = 1×1 cells, SHAPES.square2 = 2×2 cells). The world-tile bbox extent is
 *    `shapeWidth(def.footprint) * CELL_SIZE_TILES` × `shapeHeight(..) * ..`.
 *    (This is the subtle bit that previously caught the sonar_buoy click —
 *    a 1×1-cell buoy hit-target spans a 16×16-tile bbox, not 1×1 tile.)
 *
 * Walks every populated island's `buildings[]` (ocean platforms are stored
 * on their anchor's array per Task 10). First-match wins; ocean footprints
 * can't overlap by construction (the validator's `land-overlap` +
 * anchor-range gate joint-prevents overlap across multiple anchors too).
 *
 * Returns `{ spec, building }` to mirror what main.ts needs (the anchor
 * spec, so the inspector can resolve the anchor's `IslandState`). Returns
 * null when no ocean platform covers the tile.
 *
 * Pure — no PixiJS, no DOM.
 */
export function findOceanBuildingAt(
  islands: ReadonlyArray<IslandSpec>,
  worldTileX: number,
  worldTileY: number,
): { readonly spec: IslandSpec; readonly building: PlacedBuilding } | null {
  // Snap to integer tile (same convention as `buildingAtTile`). Ocean
  // footprints are 16-tile-aligned cell blocks, but the click can land
  // anywhere inside — round-to-nearest matches the half-tile visual rule.
  const tx = Math.round(worldTileX);
  const ty = Math.round(worldTileY);
  for (const spec of islands) {
    if (!spec.populated) continue;
    for (const b of spec.buildings) {
      const def = BUILDING_DEFS[b.defId];
      if (def.oceanPlacement !== true) continue;
      const widthTiles = shapeWidth(def.footprint) * CELL_SIZE_TILES;
      const heightTiles = shapeHeight(def.footprint) * CELL_SIZE_TILES;
      const x0 = spec.cx + b.x;
      const y0 = spec.cy + b.y;
      const x1 = x0 + widthTiles;
      const y1 = y0 + heightTiles;
      if (tx >= x0 && tx < x1 && ty >= y0 && ty < y1) {
        return { spec, building: b };
      }
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

// ---------------------------------------------------------------------------
// Ocean-layer §3 / §4 — sibling validator for ocean-placed buildings.
// ---------------------------------------------------------------------------
//
// Ocean buildings are a SIBLING placement universe from the land
// `validatePlacement` flow: they're indexed by cell coords (not island-local
// tile coords), they validate against `world.oceanCells` (not an island's
// ellipse / terrain closure), and they anchor to a PICKED island (not the
// island whose footprint they sit on). Mixing the two flows into one
// validator would force every land caller to thread a `world` reference; a
// sibling function keeps the existing land path untouched.
//
// What this function gates (per §3 / §4 design doc):
//   1. defNotOcean   — defensive: caller routed a non-ocean def here.
//   2. terrainMismatch — at least one footprint cell's terrain isn't in
//                        `def.terrainReqs`. Uses `footprintMatches` from
//                        ocean-cell.ts so the rule is shared with sonar /
//                        future ocean-placement consumers.
//   3. noAnchorInRange — no populated island sits within
//                        ANCHOR_MAX_RANGE_CELLS of the placement cell. The
//                        anchor PICKER UI (mountAnchorPicker) consumes the
//                        same candidate list returned by `candidateAnchors`;
//                        rejecting up-front spares the player an empty
//                        modal.
//
// NOT gated here (and why):
//   - Cell overlap with other ocean buildings: ocean placements all flow
//     through the same `PlacedBuilding` array on whichever island they
//     anchor to; overlap detection lives downstream once the anchor is
//     picked. This stays out of the pure pre-anchor validator.
//   - Tier / unlock gates: caller has the island context (anchor candidate
//     list); the per-island level gate fires after the anchor is picked
//     via the existing `buildingUnlocked` path the UI already runs.
//   - Placement cost: same reason — costs come out of the anchor island's
//     inventory; checked at placeBuilding time.
//
// Footprint dims: `shapeWidth` / `shapeHeight` from shape-mask. Ocean
// buildings ignore rotation in the initial scope (every shipped def is a
// 2×2 square; rotation is a no-op for squares anyway). If a non-square
// ocean def ships later, thread a Rotation parameter through and call
// `rotatedDims` instead.

/** Reasons ocean placement can fail. Disjoint from `PlacementReason` so
 *  callers don't confuse a land-placement land-mine with an ocean one. */
export type OceanPlacementReason =
  | 'def-not-ocean'
  | 'terrain-mismatch'
  | 'no-anchor-in-range'
  /** At least one tile under the placement cell footprint falls inside an
   *  island's union ellipse — the player tried to anchor an ocean building
   *  on top of land. Detected BEFORE the terrain-match check because
   *  `terrainAt` defaults unmapped cells to `'deep'` (the ocean default),
   *  which means cells INSIDE an island's tile grid would otherwise satisfy
   *  `['shallows', 'deep']` terrainReqs and silently accept the placement.
   *  See `isOceanTile` in world.ts. */
  | 'land-overlap';

export interface OceanPlacementValidation {
  readonly ok: boolean;
  readonly reason?: OceanPlacementReason;
}

/** Validate an ocean placement at cell coords (`cellX`, `cellY`).
 *
 *  Pure: reads `world.oceanCells` and `world.islands`; mutates nothing.
 *  Caller is responsible for routing only `def.oceanPlacement === true`
 *  buildings here — passing a land def returns `def-not-ocean` defensively
 *  so test mistakes surface fast.
 *
 *  Cell coords convention: matches `ocean-cell.ts:terrainAt` — the
 *  footprint covers the AABB `(cellX..cellX+w-1, cellY..cellY+h-1)`. A 2×2
 *  building covers a 2×2 block of cells (= 32×32 tiles), consistent with
 *  the §3 design-doc catalog table where vent / nodule / trench feature
 *  sizes are expressed in cells.
 */
export function validateOceanPlacement(
  world: WorldState,
  defId: BuildingDefId,
  cellX: number,
  cellY: number,
): OceanPlacementValidation {
  const def = BUILDING_DEFS[defId];
  if (def.oceanPlacement !== true) {
    return { ok: false, reason: 'def-not-ocean' };
  }
  // Footprint dims in cell-units. Squares (current scope) are
  // rotation-invariant — pass the unrotated mask.
  const w = shapeWidth(def.footprint);
  const h = shapeHeight(def.footprint);
  // Land-overlap guard — BEFORE the terrain match. `terrainAt` defaults
  // unmapped cells to `'deep'` (see ocean-cell.ts), so a placement whose
  // footprint cells fall INSIDE an island's tile grid (and therefore are
  // not stored in `world.oceanCells`) would silently satisfy any
  // terrainReqs that include `'deep'` — letting an Open-Water Extractor
  // place in the middle of an island. We walk the footprint cell-by-cell
  // and reject if any tile under any cell sits inside any island's union
  // footprint.
  //
  // Sampling strategy per cell: the four corner tiles + the center tile
  // are enough to catch any island whose footprint covers a region of
  // useful size (islands have major/minor ≥ ~7 tiles; the 5-sample test
  // catches any ellipse whose interior overlaps the 16×16 cell). Walking
  // every tile in the cell (256/cell × 4 cells = 1024 ops) would be
  // wasteful for a per-cursor-hover validator. Falls through to the
  // terrain check only when the entire footprint is on open ocean.
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const cx = cellX + dx;
      const cy = cellY + dy;
      const tx0 = cx * CELL_SIZE_TILES;
      const ty0 = cy * CELL_SIZE_TILES;
      const tx1 = tx0 + CELL_SIZE_TILES - 1;
      const ty1 = ty0 + CELL_SIZE_TILES - 1;
      const txc = tx0 + Math.floor(CELL_SIZE_TILES / 2);
      const tyc = ty0 + Math.floor(CELL_SIZE_TILES / 2);
      const samples: ReadonlyArray<readonly [number, number]> = [
        [tx0, ty0],
        [tx1, ty0],
        [tx0, ty1],
        [tx1, ty1],
        [txc, tyc],
      ];
      for (const [sx, sy] of samples) {
        if (!isOceanTile(world, sx, sy)) {
          return { ok: false, reason: 'land-overlap' };
        }
      }
    }
  }
  // Terrain match. If `terrainReqs` is undefined / empty, the def accepts
  // any ocean terrain (matches the sonar_buoy "any discovered ocean" rule
  // in the §3 table). `footprintMatches` short-circuits on the first
  // non-matching cell.
  if (def.terrainReqs && def.terrainReqs.length > 0) {
    if (!footprintMatches(world, cellX, cellY, w, h, def.terrainReqs)) {
      return { ok: false, reason: 'terrain-mismatch' };
    }
  }
  // Anchor candidates. Reuses the same helper the picker UI consumes —
  // a placement is only valid when at least one populated island sits
  // within ANCHOR_MAX_RANGE_CELLS (§4 Anchor island rule).
  const anchors = candidateAnchors(world, cellX, cellY);
  if (anchors.length === 0) {
    return { ok: false, reason: 'no-anchor-in-range' };
  }
  return { ok: true };
}
