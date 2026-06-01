// terrain_modifier (v5 spec) — pure helpers. SINGLE source of truth for:
// the cost formula (§04), rare-vs-natural target classification, the 16-tile
// brush geometry (4 footprint + 12 ring), SHOT_DURATION_MS, and the
// applyTileOverride primitive (mutates spec.tileOverrides).
//
// Keep this file pure — no rendering, no IslandState mutation beyond the
// documented shot-resolution primitive.

import { BUILDING_DEFS } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import type { IslandState } from './economy.js';
import type { TerrainKind } from './island.js';
import { RECIPES, type RecipeId, type ResourceId } from './recipes.js';
import { footprintTiles, type Rotation } from './shape-mask.js';
import type { IslandSpec } from './world.js';

// Constants — Appendix-A placeholders per spec §04. Tunable post-first-play.

/** Animation duration of the shot in ms. Reused by the tick (decrements in
 *  advanceIsland) and the building-arc render (progress fraction). */
export const SHOT_DURATION_MS = 4000;

/** Number of tiles in one terrain_modifier brush shot. */
const BRUSH_TILES = 16;

/** 30-day horizon in seconds (30 × 24 × 3600). `cycleSec` is real seconds. */
const THIRTY_DAYS_SEC = 2_592_000;

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

/** For each rare-vein terrain, the ResourceId the player must pay to manufacture
 *  one such tile (v4 lock `rare_target_costs_rare_resource`). The mapping is the
 *  ResourceId the building-defs.ts extractor bound to this tile via `requiredTile`
 *  produces in recipes.ts — one row per kind in RARE_TARGET_TERRAINS, single-output
 *  extractors only. */
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

/** For each rare target, the base extractor recipe (a `RECIPES` key) whose
 *  per-cycle output of `RARE_TARGET_INPUT[target]` defines the base extraction
 *  rate. Verified against recipes.ts: every entry exists, outputs qty 1 of the
 *  mapped resource, and carries `exogenousFlow: 'terrain'`. */
export const RARE_TARGET_EXTRACTOR_RECIPE: Readonly<Record<string, RecipeId>> = {
  ore: 'mine_on_ore',
  coal: 'mine_on_coal',
  oil_well: 'pump_jack',
  gas_seep: 'gas_extractor',
  helium_vent: 'drilling_rig',
  limestone: 'limestone_quarry',
  clay_pit: 'clay_pit_extractor',
  sulfur_vein: 'sulfur_mine',
  phosphate_deposit: 'phosphate_mine',
  graphite_vein: 'graphite_mine',
  copper_vein: 'copper_mine',
  tin_vein: 'tin_mine',
  lead_vein: 'lead_mine',
  bauxite_vein: 'bauxite_mine',
  manganese_vein: 'manganese_mine',
  zinc_vein: 'zinc_mine',
  chromium_vein: 'chromium_mine',
  nickel_vein: 'nickel_mine',
  tungsten_vein: 'tungsten_mine',
  mercury_pit: 'mercury_well',
  diamond_vein: 'diamond_quarry',
  lithium_vein: 'lithium_extractor',
  uranium_vein: 'uranium_mine',
};

/** Base extraction rate (units/sec) for a rare target: the extractor recipe's
 *  per-cycle output of the mapped resource ÷ cycleSec. 0 if missing. */
export function baseRatePerSec(target: TerrainKind): number {
  const recipeId = RARE_TARGET_EXTRACTOR_RECIPE[target as string];
  const resource = RARE_TARGET_INPUT[target as string];
  if (recipeId === undefined || resource === undefined) return 0;
  const recipe = RECIPES[recipeId];
  if (recipe === undefined) return 0;
  const outQty = recipe.outputs[resource] ?? 0;
  return outQty / recipe.cycleSec;
}

/** Per-shot cost of mapping a tile to a rare resource = 30 days of that
 *  resource's base extraction, charged once for the 16-tile shot. */
export function rareShotCost(target: TerrainKind): Partial<Record<ResourceId, number>> {
  const resource = RARE_TARGET_INPUT[target as string];
  if (resource === undefined) return {};
  const units = Math.ceil(baseRatePerSec(target) * THIRTY_DAYS_SEC);
  return units > 0 ? { [resource]: units } : {};
}

/** Total cost (basket) for a single shot at `target`. The shot covers 16
 *  brush tiles; the cost is "16 × per-tile" for natural targets and 30 days of
 *  the corresponding rare resource's base extraction for rare targets. */
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
    return rareShotCost(target);
  }
  // Unclassified kind — return an empty basket. The coverage test catches this.
  return {};
}

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

// Shot resolution — pure mutation primitive.

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
