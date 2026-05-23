// terrain_modifier (v5 spec) — pure helpers.
//
// This module is the SINGLE source of truth for:
//   - the cost formula (spec §04 duplication-glitch framing)
//   - the rare-vs-natural target classification
//   - the 16-tile brush geometry (4 footprint + 12 ring)
//   - the SHOT_DURATION_MS animation budget
//   - the applyTileOverride primitive (mutates spec.tileOverrides)
//
// Tasks 3 (placement-ui brush preview), 4 (shot tick + resolution),
// and 5 (target-biome picker) all import from here. Keep this file
// pure — no rendering, no IslandState mutation. The shot-resolution
// helper consumes a spec + the tile to set; everything else (removing
// the building, invalidation pass, rebuildWorldLayers) is Task 4's
// orchestration in main.ts.

import { BUILDING_DEFS } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import type { IslandState } from './economy.js';
import type { TerrainKind } from './island.js';
import type { ResourceId } from './recipes.js';
import { footprintTiles, type Rotation } from './shape-mask.js';
import type { IslandSpec } from './world.js';

// ---------------------------------------------------------------------------
// Constants — Appendix-A placeholders per spec §04. Tunable post-first-play.
// ---------------------------------------------------------------------------

/** Animation duration of the shot in ms. Reused by Task 4's tick (decrements
 *  in advanceIsland) and the building-arc render (progress fraction). */
export const SHOT_DURATION_MS = 4000;

/** Multiplier `K` in the rare-target cost formula. K = 1.5 means a manufactured
 *  vein never net-produces its input at break-even for at least 90 cycles. */
export const K_RARE_MULT = 1.5;

/** Payback horizon in production cycles for the rare-target cost. Cycle =
 *  one production tick of the natural extractor on a natural tile of the
 *  target kind. 90 cycles ≈ 30-60 min of real play depending on the recipe's
 *  cycleSec. */
export const PAYBACK_HORIZON_CYCLES = 90;

/** Number of tiles in one terrain_modifier brush shot. */
const BRUSH_TILES = 16;

/** Per-natural-target input cost (per tile). Per-shot cost = entries × 16 tiles.
 *  Heavy magnitudes by design — modifier is a strategic placement-cost unlock,
 *  not a scaling lever. Each natural-target tile costs the resource it would
 *  produce, except grass + magma_vent which have no direct extractor (blanket). */
export const NATURAL_TARGET_INPUT_PER_TILE: Readonly<
  Record<'grass' | 'stone' | 'tree' | 'sand' | 'ice' | 'water' | 'magma_vent', Partial<Record<ResourceId, number>>>
> = {
  grass:       { stone: 200, gear: 100 },        // no extractor; blanket
  stone:       { stone: 500 },                    // self-cost
  tree:        { wood: 500 },                     // logger output
  sand:        { sand: 500 },                     // quarry output
  ice:         { stone: 200, gear: 100 },         // no Ice ResourceId; blanket fallback
  water:       { fresh_water: 500 },              // well output
  magma_vent:  { stone: 300, coal: 50 },          // no extractor; coal heat-source proxy
};

// ---------------------------------------------------------------------------
// Target classification
// ---------------------------------------------------------------------------

/** "Natural" targets — the biome-default kinds. Cost = NATURAL_PER_TILE_BASKET × 16. */
export const NATURAL_TARGET_TERRAINS: ReadonlySet<TerrainKind> = new Set<TerrainKind>([
  'grass',
  'sand',
  'stone',
  'water',
  'tree',
  'ice',
  'magma_vent',
]);

/** "Rare" targets — geological-resource kinds. Cost scales by the formula. The
 *  union of this set + NATURAL_TARGET_TERRAINS covers every TerrainKind today
 *  (the test in terrain-modifier.test.ts asserts coverage so a new kind added
 *  to TerrainKind without a classification fails CI loudly). */
export const RARE_TARGET_TERRAINS: ReadonlySet<TerrainKind> = new Set<TerrainKind>([
  'ore',
  'coal',
  'oil_well',
  'gas_seep',
  'helium_vent',
  'limestone',
  'clay_pit',
  'sulfur_vein',
  'phosphate_deposit',
  'graphite_vein',
  'copper_vein',
  'tin_vein',
  'lead_vein',
  'bauxite_vein',
  'manganese_vein',
  'zinc_vein',
  'chromium_vein',
  'nickel_vein',
  'tungsten_vein',
  'mercury_pit',
  'diamond_vein',
  'lithium_vein',
  'uranium_vein',
]);

// ---------------------------------------------------------------------------
// Rare-target → input resource mapping
// ---------------------------------------------------------------------------

/** For each rare-vein terrain, the ResourceId the player must pay to manufacture
 *  one such tile. The rule per v4 lock (`rare_target_costs_rare_resource`):
 *  "targets in the rare-vein set cost a heavy stack of the corresponding
 *  resource". The mapping is "the ResourceId the building-defs.ts extractor
 *  bound to this tile via `requiredTile` actually produces in recipes.ts".
 *  Verified 2026-05-23 against building-defs.ts and recipes.ts — one row per
 *  TerrainKind in RARE_TARGET_TERRAINS, cross-checked extractor defId →
 *  recipe outputs (single-output extractors only; every rare extractor in
 *  the current catalog has exactly one output). */
export const RARE_TARGET_INPUT: Readonly<Record<string, ResourceId>> = {
  ore: 'iron_ore',          // mine / deep_mine → iron_ore
  coal: 'coal',             // mine (mine_on_coal recipe) → coal
  oil_well: 'crude_oil',    // pump_jack → crude_oil
  gas_seep: 'natural_gas',  // gas_extractor → natural_gas
  helium_vent: 'helium_3',  // drilling_rig → helium_3
  limestone: 'limestone',   // limestone_quarry → limestone
  clay_pit: 'clay',         // clay_pit_extractor → clay
  sulfur_vein: 'sulfur',    // sulfur_mine → sulfur
  phosphate_deposit: 'phosphate',  // phosphate_mine → phosphate
  graphite_vein: 'graphite',       // graphite_mine → graphite
  copper_vein: 'copper_ore',       // copper_mine → copper_ore
  tin_vein: 'tin_ore',             // tin_mine → tin_ore
  lead_vein: 'lead_ore',           // lead_mine → lead_ore
  bauxite_vein: 'bauxite',         // bauxite_mine → bauxite
  manganese_vein: 'manganese_ore', // manganese_mine → manganese_ore
  zinc_vein: 'zinc_ore',           // zinc_mine → zinc_ore
  chromium_vein: 'chromium_ore',   // chromium_mine → chromium_ore
  nickel_vein: 'nickel_ore',       // nickel_mine → nickel_ore
  tungsten_vein: 'tungsten_ore',   // tungsten_mine → tungsten_ore
  mercury_pit: 'mercury',          // mercury_well → mercury
  diamond_vein: 'diamond_ore',     // diamond_quarry → diamond_ore
  lithium_vein: 'lithium',         // lithium_extractor → lithium
  uranium_vein: 'uranium_ore',     // uranium_mine → uranium_ore
};

// ---------------------------------------------------------------------------
// Cost helpers
// ---------------------------------------------------------------------------

/** Per-cycle extraction rate of the natural extractor on a natural tile of
 *  `target`. Placeholder = 1 unit/cycle for every rare kind; a follow-up tuning
 *  pass can wire this against the actual recipe table. The cost formula is
 *  `cost = K × rate × horizon`, so a placeholder of 1 yields a flat
 *  `1.5 × 1 × 90 = 135` units of the corresponding input resource. */
function naturalExtractionRate(_target: TerrainKind): number {
  return 1;
}

/** Total cost (basket) for a single shot at `target`. The shot covers 16
 *  brush tiles; the cost is "16 × per-tile" for natural targets and "K × rate
 *  × horizon × 16" of the corresponding rare resource for rare targets per
 *  p2_brush_target_mismatch = full_brush_charge. */
export function conversionCostForTarget(
  target: TerrainKind,
): Partial<Record<ResourceId, number>> {
  if (NATURAL_TARGET_TERRAINS.has(target)) {
    const perTile = NATURAL_TARGET_INPUT_PER_TILE[target as keyof typeof NATURAL_TARGET_INPUT_PER_TILE];
    if (perTile === undefined) return {};
    const out: Partial<Record<ResourceId, number>> = {};
    for (const [r, qty] of Object.entries(perTile)) {
      if (qty !== undefined) out[r as ResourceId] = qty * BRUSH_TILES;
    }
    return out;
  }
  if (RARE_TARGET_TERRAINS.has(target)) {
    const input = RARE_TARGET_INPUT[target];
    if (input === undefined) {
      // Defense-in-depth: a TerrainKind in RARE_TARGET_TERRAINS without an
      // RARE_TARGET_INPUT row is a classification bug. The test in
      // terrain-modifier.test.ts asserts every rare kind has a mapping.
      return {};
    }
    const perTile = K_RARE_MULT * naturalExtractionRate(target) * PAYBACK_HORIZON_CYCLES;
    return { [input]: Math.ceil(perTile * BRUSH_TILES) };
  }
  // Unclassified kind — return an empty basket. The coverage test catches this.
  return {};
}

// ---------------------------------------------------------------------------
// Brush geometry
// ---------------------------------------------------------------------------

/** The 16-tile brush footprint per the v3 user lock
 *  (`scope_is_16_tiles_footprint_plus_ring`). The terrain_modifier's footprint
 *  is SHAPES.square2 anchored at (anchorX, anchorY), covering tiles
 *  (anchorX, anchorY) / (anchorX+1, anchorY) / (anchorX, anchorY+1) /
 *  (anchorX+1, anchorY+1). The "ring" is the 12 tiles directly adjacent to
 *  the 2×2 block (the outer rim of the 4×4 square that contains the footprint
 *  + ring). Coords are island-local (the same domain as PlacedBuilding.x/y). */
export function brushTilesAt(anchorX: number, anchorY: number): Array<{ x: number; y: number }> {
  const tiles: Array<{ x: number; y: number }> = [];
  // 4×4 block centred on the 2×2 footprint = the union of footprint + ring.
  for (let dy = -1; dy <= 2; dy++) {
    for (let dx = -1; dx <= 2; dx++) {
      tiles.push({ x: anchorX + dx, y: anchorY + dy });
    }
  }
  return tiles; // 16 tiles, guaranteed by the loop bounds.
}

// ---------------------------------------------------------------------------
// Override write — mutates spec in place
// ---------------------------------------------------------------------------

/** Write a single tile override onto `spec.tileOverrides`. Creates the record
 *  lazily if absent. Key format `${x},${y}` in island-local coords, matching
 *  the format the attachTerrainAt closure (Task 1) reads. last-write-wins:
 *  the second modifier whose brush covers an already-overridden tile silently
 *  replaces the prior kind (p3_overlap_simultaneous = last_placed_wins). */
export function applyTileOverride(
  spec: IslandSpec,
  x: number,
  y: number,
  kind: TerrainKind,
): void {
  if (spec.tileOverrides === undefined) {
    spec.tileOverrides = {};
  }
  spec.tileOverrides[`${x},${y}`] = kind;
}

// ---------------------------------------------------------------------------
// Shot resolution — Task 4's pure mutation primitive
// ---------------------------------------------------------------------------

/** Resolve a terrain_modifier shot: write tile overrides for every brush
 *  tile inside the ellipse, remove the modifier from state.buildings, and
 *  re-run the requiredTile invalidation pass against every other building
 *  on the island.
 *
 *  `inscribed` receives island-local tile coords (NOT world coords). The
 *  typical shape is `(x,y) => islandInscribedAny(spec, x, y)` — brushTilesAt
 *  already emits local tiles, and islandInscribedAny expects local coords.
 *  Tiles outside the predicate are SKIPPED, not refunded — spec
 *  p3_ellipse_boundary = skip_outside_full_charge.
 *
 *  Returns the count of (a) tiles actually written and (b) buildings newly
 *  marked invalid, mostly for testing and for the main.ts callback to log. */
export function resolveShot(
  spec: IslandSpec,
  state: IslandState,
  modifier: PlacedBuilding,
  inscribed: (localX: number, localY: number) => boolean,
): { tilesWritten: number; buildingsInvalidated: number } {
  let tilesWritten = 0;
  if (modifier.terrainTarget !== undefined) {
    const brush = brushTilesAt(modifier.x, modifier.y);
    for (const t of brush) {
      if (!inscribed(t.x, t.y)) continue;
      applyTileOverride(spec, t.x, t.y, modifier.terrainTarget);
      tilesWritten += 1;
    }
  }
  // Remove the modifier from state.buildings. The same array is shared by
  // reference with spec.buildings (see makeInitialIslandState); splicing on
  // either reflects on both.
  const idx = state.buildings.findIndex((b) => b.id === modifier.id);
  if (idx !== -1) state.buildings.splice(idx, 1);
  // Invalidation pass — mirror universe-editor.ts:91-110.
  let buildingsInvalidated = 0;
  const terrainAt = spec.terrainAt;
  if (terrainAt !== undefined) {
    for (const b of state.buildings) {
      const def = BUILDING_DEFS[b.defId];
      if (!def.requiredTile || def.requiredTile.length === 0) continue;
      const rotation = (b.rotation ?? 0) as Rotation;
      const ftiles = footprintTiles(def.footprint, b.x, b.y, rotation);
      let allMatch = true;
      for (const ft of ftiles) {
        if (!def.requiredTile.includes(terrainAt(ft.x, ft.y))) { allMatch = false; break; }
      }
      const wasInvalid = b.invalid === true;
      (b as { invalid?: boolean }).invalid = !allMatch;
      if (!allMatch && !wasInvalid) buildingsInvalidated += 1;
    }
  }
  return { tilesWritten, buildingsInvalidated };
}
