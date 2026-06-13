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
//        Tower → Crystal Lab unlock remains deferred.
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
import { floorScaledCapacity, hasOperationalBuilding, rawFloorLevel, type PlacedBuilding } from './buildings.js';
import { constructionTimeFor, upgradeConstructionMs } from './construction.js';
import type { BuildJob, IslandState } from './economy.js';
import { islandInscribedAny } from './island.js';
import { footprintMatches } from './ocean-cell.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { effectiveSkillMultipliers, hasBiomeBypass, effectiveTierShift, tierForLevel, DEFAULT_GRAPH } from './skilltree.js';
import { hasStructuralEffect } from './structural.js';
import type { Graph } from './skilltree-graph.js';
import { RESOURCE_STORAGE_CATEGORY, storageBaseFor } from './storage-categories.js';
import { candidateAnchors } from './anchor-picker.js';
import { isOceanTile, type IslandSpec, type WorldState } from './world.js';
import { CELL_SIZE_TILES } from './constants.js';
import { brushTilesAt, conversionCostForTarget } from './terrain-modifier.js';

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

export type RelocateResult =
  | { readonly ok: true; readonly charged: Partial<Record<ResourceId, number>> }
  | {
      readonly ok: false;
      readonly reason: PlacementReason | 'not-found';
      readonly missing?: Partial<Record<ResourceId, number>>;
    };

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

/** Pure: compute the upgrade-cost basket for raising a building INTO the
 *  displayed floor level `targetLevel` (1 = fresh, 2..10 = legacy floors,
 *  11+ = exponential). Undefined or ≤10 keeps the legacy 0.8× placementCost;
 *  >10 uses `0.08 × 1.15^(targetLevel − 10) × placementCost`, rounded up per
 *  resource. Empty if the def has no placementCost. */
export function upgradeCost(
  def: BuildingDef,
  targetLevel?: number,
): Partial<Record<ResourceId, number>> {
  const base = placementCostFor(def);
  const cost: Partial<Record<ResourceId, number>> = {};
  const factor =
    targetLevel === undefined || targetLevel <= 10
      ? 0.8
      : 0.8 * (1.15 ** (targetLevel - 10));
  for (const [r, n] of Object.entries(base) as Array<[ResourceId, number]>) {
    if (n > 0) cost[r] = Math.ceil(n * factor);
  }
  return cost;
}

/** Pure: a building's TOTAL invested resources = base placementCost plus the
 *  sum of per-floor upgrade costs for every completed floor upgrade. Shared
 *  by relocate (half this is the move fee) and demolish (refund/scrap are
 *  fractions of this). Floor 0 ⇒ just the base cost. Mirrors the per-level
 *  `upgradeCost(def, targetLevel)` curve, including the L>10 exponential. */
export function totalInvestedCost(
  b: { readonly floorLevel?: number },
  def: BuildingDef,
): Partial<Record<ResourceId, number>> {
  const base = placementCostFor(def);
  const rawL = rawFloorLevel(b);
  const displayed = rawL + 1;
  const out: Partial<Record<ResourceId, number>> = {};
  for (const [r, n] of Object.entries(base) as Array<[ResourceId, number]>) {
    if (n <= 0) {
      out[r] = n;
      continue;
    }
    let invested = n;
    // Each upgrade raises the displayed floor from 2 up to `displayed`.
    for (let target = 2; target <= displayed; target++) {
      invested += upgradeCost(def, target)[r] ?? 0;
    }
    out[r] = invested;
  }
  return out;
}

/** Pure: the relocate fee = floor(0.5 × totalInvestedCost) per resource (drops
 *  zero/negative entries). Shared by `relocateBuilding` (what it charges) and
 *  the placement-ui relocate ghost (what it previews) so the two never drift. */
export function relocateFee(
  b: { readonly floorLevel?: number },
  def: BuildingDef,
): Partial<Record<ResourceId, number>> {
  const fee: Partial<Record<ResourceId, number>> = {};
  for (const [r, n] of Object.entries(totalInvestedCost(b, def)) as Array<[ResourceId, number]>) {
    const half = Math.floor(n / 2);
    if (half > 0) fee[r] = half;
  }
  return fee;
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

/** Format a shortfall record (from `affordabilityShortfall`) as a display body
 *  like "8 STONE, 3 PIG IRON" — amounts ceiled. Inventory accrues in fractional
 *  trickles so `needed - have` is fractional; the player needs whole units, and
 *  a raw "7.2315… STONE" on an upgrade/place button reads as a bug. Returns ""
 *  for a record with no positive entries (callers add their own "NEED " prefix
 *  / empty-state fallback). */
export function formatShortfall(missing: Partial<Record<ResourceId, number>>): string {
  const parts: string[] = [];
  for (const [r, n] of Object.entries(missing) as Array<[ResourceId, number]>) {
    if (n <= 0) continue;
    parts.push(`${Math.ceil(n)} ${r.toUpperCase().replace(/_/g, ' ')}`);
  }
  return parts.join(', ');
}

/** Order resources by fill % (descending; alphabetical tiebreak for stable,
 *  deterministic rows). Pure — returns a NEW array, never mutates the input.
 *  `fillPct(r)` supplies each resource's current inventory-vs-cap percentage;
 *  the crate cargo-label picker uses it so the resources an island is closest
 *  to overflowing on surface first instead of an alphabetical wall. */
export function sortByFillDesc(
  resources: readonly ResourceId[],
  fillPct: (r: ResourceId) => number,
): ResourceId[] {
  return [...resources].sort((a, b) => fillPct(b) - fillPct(a) || a.localeCompare(b));
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
  ignoreBuildingId?: string,
  skipCostGate?: boolean,
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
    if (!islandInscribedAny(spec, t.x, t.y)) {
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
    if (existing.id === ignoreBuildingId) continue;
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
      if (b.id === ignoreBuildingId) continue;
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
  if (!skipCostGate) {
    const cost = placementCostFor(def);
    const missing = affordabilityShortfall(state.inventory, cost);
    if (Object.keys(missing).length > 0) {
      return { ok: false, reason: 'insufficient-resources', missing };
    }
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

/** Credit a storage building's contribution to `state.storageCaps`, using the
 *  §4.6 categorized routing: a generic-category building bumps ONLY the
 *  resource named on its `cargoLabel`; a specialized-category building bumps
 *  every resource whose `RESOURCE_STORAGE_CATEGORY` matches `def.storage.category`.
 *
 *  `mult` is the percentage MULTIPLIER (`def.storage.capacity`, floor-scaled by
 *  the caller), NOT an absolute unit count: the per-resource credit is
 *  `mult × storageBaseFor(r)`. No-op when the def carries no `storage` block.
 *  Shared by the construction-completion hook in economy.ts so the
 *  place/upgrade-completion credit and the demolish/cancel strip can't drift on
 *  which resources a storage building affects. Pure mutation on
 *  `state.storageCaps`. */
export function creditStorageCaps(
  state: IslandState,
  building: PlacedBuilding,
  def: BuildingDef,
  mult: number,
): void {
  const storage = def.storage;
  if (!storage) return;
  if (storage.category === 'generic') {
    const label = building.cargoLabel;
    if (label !== undefined) {
      state.storageCaps[label] = (state.storageCaps[label] ?? 0) + mult * storageBaseFor(label);
    }
  } else {
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      if (RESOURCE_STORAGE_CATEGORY[r] === storage.category) {
        state.storageCaps[r] = (state.storageCaps[r] ?? 0) + mult * storageBaseFor(r);
      }
    }
  }
}

/** §4.6 relabel: move a generic-storage building's storage cap from one
 *  resource label to another, guarded on construction-complete state.
 *
 *  The guard "cap was actually credited" is:
 *    construction complete  →  (building.constructionRemainingMs ?? 0) <= 0
 *    AND not queued         →  building.queued !== true
 *
 *  A disabled building HAS already been credited its cap (disable is a
 *  per-tick production toggle; it does NOT strip storageCaps), so the
 *  disable flag is intentionally excluded from this guard.
 *
 *  When the building is under construction / queued: only `cargoLabel` is
 *  updated; cap arithmetic is skipped. `creditStorageCaps` in economy.ts
 *  will credit the correct (post-relabel) label at completion.
 *
 *  When the building is operational (construction complete, not queued):
 *  the cap is moved — subtract from old label, add to new label — and
 *  inventory is clamped if the old label's stock would exceed the reduced
 *  cap.
 *
 *  Does NOT set `building.cargoLabel` — the caller is responsible for that
 *  (keeps this function pure with respect to the building object).
 *  Returns `'moved'` when cap arithmetic ran, `'label-only'` when it was
 *  skipped (so callers can assert the correct path in tests). */
export function applyRelabelStorageCap(
  state: IslandState,
  building: PlacedBuilding,
  def: BuildingDef,
  oldLabel: ResourceId | undefined,
  newLabel: ResourceId,
): 'moved' | 'label-only' {
  if (!def.storage || def.storage.category !== 'generic') return 'label-only';
  const constructionComplete =
    (building.constructionRemainingMs ?? 0) <= 0 && building.queued !== true;
  if (!constructionComplete) {
    // Under construction / queued: cap hasn't been credited yet.
    // Skip cap arithmetic; completion will credit the (new) cargoLabel.
    return 'label-only';
  }
  // §4.6 percentage model: the cap moved differs per resource — subtract the
  // old label's contribution (mult × its base) and add the new label's.
  const mult = floorScaledCapacity(building, def.storage.capacity);
  if (oldLabel !== undefined) {
    const next = (state.storageCaps[oldLabel] ?? 0) - mult * storageBaseFor(oldLabel);
    state.storageCaps[oldLabel] = next < 0 ? 0 : next;
    const have = state.inventory[oldLabel] ?? 0;
    const newCap = state.storageCaps[oldLabel] ?? 0;
    if (have > newCap) state.inventory[oldLabel] = newCap;
  }
  state.storageCaps[newLabel] = (state.storageCaps[newLabel] ?? 0) + mult * storageBaseFor(newLabel);
  return 'moved';
}

/** §9.3 Robotics: how many concurrent under-construction slots this island
 *  has right now. Base 1 + Robotics `parallelBuildBonus` (additive) +
 *  structural keystone `parallelConstruction` (+1 when owned). */
export function parallelBuildSlots(state: IslandState): number {
  const skillBonus = Math.floor(effectiveSkillMultipliers(state).parallelBuildBonus);
  const structuralBonus = hasStructuralEffect('parallelConstruction', state, DEFAULT_GRAPH) ? 1 : 0;
  return 1 + skillBonus + structuralBonus;
}

/** Count of currently-RUNNING (ticking) construction jobs — excludes queued. */
export function inProgressBuildCount(state: IslandState): number {
  let n = 0;
  for (const b of state.buildings) {
    if ((b.constructionRemainingMs ?? 0) > 0 && b.queued !== true) n++;
  }
  return n;
}

/** Count of builds currently waiting in the queue: queued placements
 *  (`b.queued === true`) PLUS queued upgrade jobs in `state.buildJobs`. */
export function queuedBuildCount(state: IslandState): number {
  let n = 0;
  for (const b of state.buildings) {
    if (b.queued === true) n++;
  }
  return n + (state.buildJobs?.length ?? 0);
}

/** §4.8 number of QUEUED (not-yet-running) upgrade jobs for `buildingId`. */
export function countQueuedUpgrades(state: IslandState, buildingId: string): number {
  let n = 0;
  for (const j of state.buildJobs ?? []) if (j.buildingId === buildingId) n++;
  return n;
}

/** §4.8 the highest RAW floor level a building is heading toward: its current
 *  rawFloorLevel (which already includes any running upgrade's pre-bumped
 *  target) plus every queued upgrade for it. The next upgrade's target DISPLAYED
 *  floor is `topUpgradeLevel + 2` (raw→raw+1, displayed = raw+1). */
export function topUpgradeLevel(state: IslandState, b: { id: string; floorLevel?: number }): number {
  return rawFloorLevel(b) + countQueuedUpgrades(state, b.id);
}

/** §queue mirror of `parallelBuildSlots`: base 2 + floor(queueCapBonus)
 *  + structural `parallelQueue` (+2 when owned). Holds a 1:2 ratio with
 *  running slots at empty and full skill tree. */
export function queuedBuildSlots(state: IslandState): number {
  const skillBonus = Math.floor(effectiveSkillMultipliers(state).queueCapBonus);
  const structural = hasStructuralEffect('parallelQueue', state, DEFAULT_GRAPH) ? 2 : 0;
  return 2 + skillBonus + structural;
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
 *
 * §storage-timing: `placeBuilding` does NOT credit `state.storageCaps`. A
 * fresh placement starts under construction; its storage cap is granted by
 * the construction-completion hook in `advanceIsland` the tick the build
 * becomes operational (base `floorScaledCapacity` at floorLevel 0). This
 * defers the cap to match production/power, which also wait for the timer.
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
  // §8.9: a terrain_modifier pays its conversion cost UPFRONT at placement,
  // on top of placementCost (mirrors Land Reclamation's immediate deduct).
  const fullCost: Partial<Record<ResourceId, number>> = { ...cost };
  if (def.terrainModifier === true && terrainTargetOverride !== undefined) {
    for (const [r, n] of Object.entries(conversionCostForTarget(terrainTargetOverride)) as Array<[ResourceId, number]>) {
      fullCost[r] = (fullCost[r] ?? 0) + n;
    }
  }
  const missing = affordabilityShortfall(state.inventory, fullCost);
  if (Object.keys(missing).length > 0) {
    return { ok: false, reason: 'insufficient-resources', missing };
  }
  // §9.3 Robotics parallel-build cap. Base 1 + per-island skill bonus. When
  // running slots are full but the build queue has room, the build is committed
  // as `queued` (paid, FIFO-stamped). Only when the queue is also full do we
  // hard-reject.
  const slots = parallelBuildSlots(state);
  const inProgress = inProgressBuildCount(state);
  const mustQueue = inProgress >= slots;
  if (mustQueue && queuedBuildCount(state) >= queuedBuildSlots(state)) {
    return { ok: false, reason: 'queue-full', inProgress, slots };
  }
  // Deduct cost BEFORE committing the building so any subsequent error
  // path can't leave inventory paid + no building. (No fallible operations
  // sit between this and the push — but writing it this way makes the
  // invariant explicit and survives later refactors.)
  for (const [r, n] of Object.entries(fullCost) as Array<[ResourceId, number]>) {
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
    for (const [r, n] of Object.entries(fullCost) as Array<[ResourceId, number]>) {
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
    ...(construction > 0 && def.instantBuild !== true
      ? { constructionRemainingMs: construction, constructionTotalMs: construction }
      : {}),
    ...(mustQueue ? { queued: true as const, queueSeq: state.nextQueueSeq ?? 0 } : {}),
  };
  spec.buildings.push(placed);
  if (mustQueue) state.nextQueueSeq = (state.nextQueueSeq ?? 0) + 1;
  // §storage-timing: storage caps are NO LONGER credited here. A freshly-
  // placed building starts under construction and grants no cap until it
  // becomes operational — the construction-completion hook in economy.ts
  // (`advanceIsland`) credits `floorScaledCapacity(b, storage.capacity)` the
  // tick the build crosses to operational. See `creditStorageCaps`.
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
 * can't overlap by construction (the validator's `land-overlap`,
 * `ocean-overlap`, and anchor-range gates jointly prevent overlap).
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
export type UpgradeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'not-found'
        | 'queue-full'
        | 'insufficient-resources';
      readonly missing?: Partial<Record<ResourceId, number>>;
      /** Set on `queue-full` — current in-progress count and the slot cap. */
      readonly inProgress?: number;
      readonly slots?: number;
    };

/** Apply one floor-upgrade to an existing building.
 *
 *  Pinned behaviour (lead decisions):
 *  - Rejects when inventory can't afford `upgradeCost(def, targetLevel)`.
 *  - On success: deducts cost, increments floorLevel by 1, sets
 *    constructionRemainingMs = upgradeConstructionMs(def, newL). It does NOT
 *    credit storageCaps — the +storage.capacity delta is granted by the
 *    construction-completion hook in `advanceIsland` once the upgrade
 *    becomes operational (§storage-timing), matching the deferred-cap
 *    treatment of a fresh placement.
 *  - The building pauses during construction (existing isOperational gating).
 *  - Floor upgrades are uncapped: a building can be upgraded past floor 10,
 *    with costs following the §4.9 exponential curve for targetLevel > 10.
 */
export function applyUpgrade(
  spec: IslandSpec,
  state: IslandState,
  buildingId: string,
): UpgradeResult {
  const b = spec.buildings.find((bb) => bb.id === buildingId);
  if (!b) return { ok: false, reason: 'not-found' };
  const def = BUILDING_DEFS[b.defId];

  // An upgrade IS a construction job (§9.3) and consumes a parallel-build slot
  // like a placement. Stacking is supported (#31): if the building is already
  // building, OR every running slot is taken, the upgrade QUEUES as a BuildJob
  // in `state.buildJobs` instead of hard-rejecting. The running construction
  // stays on the building; the queued job carries the next upgrade.
  const buildingBusy = (b.constructionRemainingMs ?? 0) > 0;
  const slots = parallelBuildSlots(state);
  const inProgress = inProgressBuildCount(state);
  const mustQueue = buildingBusy || inProgress >= slots;

  if (mustQueue && queuedBuildCount(state) >= queuedBuildSlots(state)) {
    return { ok: false, reason: 'queue-full', inProgress, slots };
  }

  // The displayed target floor for THIS upgrade accounts for the building's
  // raw floor (including any pre-bumped running upgrade) plus every already-
  // queued upgrade, so successive enqueues charge ascending floor costs.
  const targetLevel = topUpgradeLevel(state, b) + 2;
  const cost = upgradeCost(def, targetLevel);
  const missing = affordabilityShortfall(state.inventory, cost);
  if (Object.keys(missing).length > 0) {
    return { ok: false, reason: 'insufficient-resources', missing };
  }
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    if (n <= 0) continue;
    state.inventory[r] = (state.inventory[r] ?? 0) - n;
  }

  if (mustQueue) {
    const job: BuildJob = { seq: state.nextQueueSeq ?? 0, buildingId, kind: 'upgrade' };
    (state.buildJobs ??= []).push(job);
    state.nextQueueSeq = (state.nextQueueSeq ?? 0) + 1;
    return { ok: true };
  }

  // Immediate-start path: pre-bump the raw floor to the running upgrade's
  // target and arm the construction timer (folding in the Swarm Assembly
  // `constructionTime` multiplier).
  const newL = rawFloorLevel(b) + 1;
  b.floorLevel = newL;
  const upgradeMs = upgradeConstructionMs(def, newL, effectiveSkillMultipliers(state).constructionTime);
  b.constructionRemainingMs = upgradeMs;
  b.constructionTotalMs = upgradeMs;
  // §storage-timing: the +storage.capacity cap delta is NOT credited here. An
  // upgrade IS a construction job; the cap delta is granted by the construction-
  // completion hook in `advanceIsland` the tick the upgrade becomes operational.
  return { ok: true };
}

/** Relocate an existing building to a new tile on the SAME island for a fee of
 *  half its total invested cost. Validates geometry/terrain via
 *  `validatePlacement` (ignoring the building's own footprint, skipping the
 *  full-cost gate since relocate charges its own half-fee), then charges the
 *  fee and mutates x/y/rotation in place — all other runtime state persists.
 *  `spec.buildings` and `state.buildings` are the same array, so the in-place
 *  mutation is visible to the next tick. */
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
  const fee = relocateFee(b, def);
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
  const cost = totalInvestedCost(b, def);
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
    const mult = floorScaledCapacity(b, storage.capacity);
    const stripResource = (r: ResourceId): void => {
      const next = (state.storageCaps[r] ?? 0) - mult * storageBaseFor(r);
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

/** Result of a `cancelConstruction` call. `refunded` is the per-resource
 *  amount actually credited back (post-cap-clamp). On the failure branches
 *  `refunded` is empty and `reason` is populated. */
export interface CancelResult {
  readonly ok: boolean;
  /** Resources actually credited back (post-cap-clamp). */
  readonly refunded: Partial<Record<ResourceId, number>>;
  readonly reason?: 'not-found' | 'not-building';
}

/** Cancel an in-progress (running OR queued) construction job for a 100%
 *  material refund. Distinct from §6.7 demolish (30% scrap) and relocate
 *  (half-fee). Two shapes by floorLevel:
 *    - floorLevel 0 → fresh placement: remove building, refund placement cost
 *      (incl. terrain-modifier upfront cost), free slot.
 *    - floorLevel >= 1 → in-progress upgrade: keep building, revert to
 *      floorLevel-1, clear the timer + queued flag, refund the upgrade cost.
 *  §storage-timing: NO storage strip in either branch — storage caps are
 *  credited only at construction completion, so an unfinished build never
 *  held a cap to strip.
 *  Valid only while constructionRemainingMs > 0. Pure mutation. */
export function cancelConstruction(
  spec: IslandSpec,
  state: IslandState,
  buildingId: string,
): CancelResult {
  const idx = spec.buildings.findIndex((b) => b.id === buildingId);
  if (idx < 0) return { ok: false, refunded: {}, reason: 'not-found' };
  const b = spec.buildings[idx]!;
  if ((b.constructionRemainingMs ?? 0) <= 0) {
    return { ok: false, refunded: {}, reason: 'not-building' };
  }
  const def = BUILDING_DEFS[b.defId];
  const L = rawFloorLevel(b);

  // Helper: credit resources back into inventory, clamped to storageCaps.
  // Returns the actually-credited amounts (what actually landed in inventory).
  const creditRefund = (cost: Partial<Record<ResourceId, number>>): Partial<Record<ResourceId, number>> => {
    const refunded: Partial<Record<ResourceId, number>> = {};
    for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
      if (n <= 0) continue;
      const have = state.inventory[r] ?? 0;
      const cap = state.storageCaps[r] ?? 0;
      const next = Math.min(cap, have + n);
      const credited = next - have;
      if (credited > 0) {
        state.inventory[r] = next;
        refunded[r] = credited;
      }
    }
    return refunded;
  };

  if (L === 0) {
    // Fresh placement cancel: build the same fullCost basket placeBuilding paid.
    const fullCost: Partial<Record<ResourceId, number>> = { ...placementCostFor(def) };
    if (def.terrainModifier === true && b.terrainTarget !== undefined) {
      for (const [r, n] of Object.entries(conversionCostForTarget(b.terrainTarget)) as Array<[ResourceId, number]>) {
        fullCost[r] = (fullCost[r] ?? 0) + n;
      }
    }
    // §storage-timing: no storage strip. A fresh placement never received a
    // storage cap while under construction (the cap is credited only at
    // construction completion), so there is nothing to strip on cancel —
    // just splice out the building and refund the materials.
    spec.buildings.splice(idx, 1);
    return { ok: true, refunded: creditRefund(fullCost) };
  }

  // In-progress upgrade cancel: revert to floorLevel-1, clear timer + queued,
  // refund the upgrade cost that was paid for the displayed level L+1.
  const newL = L - 1;
  b.floorLevel = newL;
  b.constructionRemainingMs = 0;
  b.queued = false;
  // §storage-timing: no storage strip. The +storage.capacity delta was never
  // credited while the upgrade was under construction (it lands only at
  // completion), so reverting the level is all that's needed.
  return { ok: true, refunded: creditRefund(upgradeCost(def, L + 1)) };
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
  | 'land-overlap'
  /** The placement cell footprint intersects an existing ocean building's
   *  cell footprint. Ocean platforms are stored on their anchor island's
   *  `buildings[]`; this guard prevents two platforms from occupying the
   *  same ocean cell regardless of which anchor they belong to. */
  | 'ocean-overlap';

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
  // Ocean-vs-ocean overlap: walk every populated island's buildings and
  // reject if any existing ocean-building footprint intersects the new
  // footprint in cell coordinates. This prevents two platforms (from
  // different anchors) from sharing the same cell.
  for (const spec of world.islands) {
    if (!spec.populated) continue;
    for (const b of spec.buildings) {
      const existingDef = BUILDING_DEFS[b.defId];
      if (existingDef.oceanPlacement !== true) continue;
      const ew = shapeWidth(existingDef.footprint);
      const eh = shapeHeight(existingDef.footprint);
      const ex = (spec.cx + b.x) / CELL_SIZE_TILES;
      const ey = (spec.cy + b.y) / CELL_SIZE_TILES;
      const overlapX = cellX < ex + ew && cellX + w > ex;
      const overlapY = cellY < ey + eh && cellY + h > ey;
      if (overlapX && overlapY) {
        return { ok: false, reason: 'ocean-overlap' };
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

/** Promote queued builds into free running slots, FIFO by queueSeq, until
 *  slots are full or the queue is empty. A promoted build clears its `queued`
 *  flag and begins ticking on the next segment. Pure mutation on `state`. */
export function promoteQueuedBuilds(state: IslandState): void {
  let free = parallelBuildSlots(state) - inProgressBuildCount(state);
  if (free <= 0) return;
  type Cand =
    | { seq: number; kind: 'place'; b: PlacedBuilding }
    | { seq: number; kind: 'upgrade'; job: BuildJob };
  const cands: Cand[] = [];
  for (const b of state.buildings) {
    if (b.queued === true) cands.push({ seq: b.queueSeq ?? 0, kind: 'place', b });
  }
  for (const job of state.buildJobs ?? []) cands.push({ seq: job.seq, kind: 'upgrade', job });
  cands.sort((a, b) => a.seq - b.seq);
  for (const c of cands) {
    if (free <= 0) break;
    if (c.kind === 'place') { c.b.queued = false; free--; continue; }
    const b = state.buildings.find((bb) => bb.id === c.job.buildingId);
    if (!b) { state.buildJobs = (state.buildJobs ?? []).filter((j) => j !== c.job); continue; }
    if ((b.constructionRemainingMs ?? 0) > 0) continue; // building busy — wait
    const def = BUILDING_DEFS[b.defId];
    const newL = rawFloorLevel(b) + 1;
    b.floorLevel = newL;
    const upgradeMs = upgradeConstructionMs(def, newL, effectiveSkillMultipliers(state).constructionTime);
    b.constructionRemainingMs = upgradeMs;
    b.constructionTotalMs = upgradeMs;
    state.buildJobs = (state.buildJobs ?? []).filter((j) => j !== c.job);
    free--;
  }
}
