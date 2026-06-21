// Pure batch-action logic for multi-building selection (§4 mass actions).
// NO PixiJS imports — unit-tested leaf module.
import { BUILDING_DEFS } from './building-defs.js';
import { footprintTiles } from './shape-mask.js';
import { shapeWidth, shapeHeight } from './shape-mask.js';
import { CELL_SIZE_TILES } from './constants.js';
import {
  parallelBuildSlots, inProgressBuildCount, queuedBuildSlots, queuedBuildCount,
  upgradeCost, topUpgradeLevel, affordabilityShortfall,
  validatePlacement, relocateFee,
} from './placement.js';
import { DEFAULT_GRAPH } from './skilltree.js';
import { resolveRecipe } from './recipes.js';
import type { Rotation } from './shape-mask.js';
import type { BuildingDef } from './building-defs.js';
import type { IslandSpec } from './world.js';
import type { IslandState } from './economy.js';
import type { ResourceId } from './recipes.js';
import type { PlacedBuilding } from './buildings.js';

/** World-tile footprint of a building (island-local tiles shifted by spec.cx/cy).
 *  Ocean defs use CELL-unit footprints (1 cell = CELL_SIZE_TILES tiles); land
 *  defs use the shape-mask tiles. Mirrors paintBuildingOutline in main.ts. */
export function buildingFootprintTilesWorld(
  spec: IslandSpec,
  b: PlacedBuilding,
): { x: number; y: number }[] {
  const def = BUILDING_DEFS[b.defId];
  if (def.oceanPlacement === true) {
    const w = shapeWidth(def.footprint) * CELL_SIZE_TILES;
    const h = shapeHeight(def.footprint) * CELL_SIZE_TILES;
    const out: { x: number; y: number }[] = [];
    for (let dx = 0; dx < w; dx++)
      for (let dy = 0; dy < h; dy++) out.push({ x: spec.cx + b.x + dx, y: spec.cy + b.y + dy });
    return out;
  }
  return footprintTiles(def.footprint, b.x, b.y, (b.rotation ?? 0) as Rotation).map((t) => ({
    x: spec.cx + t.x,
    y: spec.cy + t.y,
  }));
}

export interface TileBox { x0: number; y0: number; x1: number; y1: number }

function norm(box: TileBox): TileBox {
  return {
    x0: Math.min(box.x0, box.x1), x1: Math.max(box.x0, box.x1),
    y0: Math.min(box.y0, box.y1), y1: Math.max(box.y0, box.y1),
  };
}

/** Ids of buildings on `spec` with any footprint tile inside `box` (world tiles). */
export function buildingsInBox(spec: IslandSpec, box: TileBox): string[] {
  const n = norm(box);
  const out: string[] = [];
  for (const b of spec.buildings) {
    const tiles = buildingFootprintTilesWorld(spec, b);
    if (tiles.some((t) => t.x >= n.x0 && t.x <= n.x1 && t.y >= n.y0 && t.y <= n.y1)) out.push(b.id);
  }
  return out;
}

/** Plan a mass floor-upgrade: lowest current floor first, fill the free
 *  build+queue slots, skipping any building whose upgrade cost can't be paid
 *  from the RUNNING (depleting) inventory copy. One upgrade per building.
 *  Candidates are restricted to operational (not under construction, not
 *  queued), selected buildings. Returns ids in apply order. */
export function planMassUpgrade(state: IslandState, selectedIds: Iterable<string>): string[] {
  const free = (parallelBuildSlots(state) - inProgressBuildCount(state))
    + (queuedBuildSlots(state) - queuedBuildCount(state));
  if (free <= 0) return [];

  const ids = new Set(selectedIds);
  const candidates = state.buildings
    .filter((b) => ids.has(b.id) && (b.constructionRemainingMs ?? 0) <= 0 && b.queued !== true)
    .sort((a, b) => ((a.floorLevel ?? 0) - (b.floorLevel ?? 0)) || (a.id < b.id ? -1 : 1));

  const running: Record<ResourceId, number> = { ...state.inventory };
  const plan: string[] = [];
  for (const b of candidates) {
    if (plan.length >= free) break;
    const def = BUILDING_DEFS[b.defId];
    const cost = upgradeCost(def, topUpgradeLevel(state, b) + 2);
    if (Object.keys(affordabilityShortfall(running, cost)).length > 0) continue; // skip unaffordable
    for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
      running[r] = (running[r] ?? 0) - n;
    }
    plan.push(b.id);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// §4 group relocate / ignore-cap union / selection breakdown
// ---------------------------------------------------------------------------

/** Validate a rigid translation of `members` by (dx,dy) island-local tiles.
 *
 *  Two independent checks:
 *   1. Moved-member vs moved-member overlap — done HERE on post-move world
 *      footprints (`buildingFootprintTilesWorld`), NOT via `validatePlacement`.
 *   2. Each member valid against the island: in-bounds, biome/tier gate, and
 *      no overlap with a NON-selected building.
 *
 *  Sibling caveat (resolved): `validatePlacement` reads overlap from
 *  `spec.buildings`, and with `ignoreBuildingId = m.id` it still sees the OTHER
 *  moving members at their OLD positions — so a member translating into a tile
 *  a sibling is vacating would be falsely rejected as `overlap`. We resolve by
 *  validating each member against a CLONED spec/state in which every moving
 *  member has been REMOVED (positions are not pre-applied; the post-move
 *  member-vs-member overlap is owned entirely by check 1 above). A clean rigid
 *  translation into freed tiles therefore passes, while overlap with any
 *  stationary (non-selected) building still surfaces via `validatePlacement`.
 *  The real `spec`/`state` are never mutated. */
export function validateGroupRelocate(
  spec: IslandSpec,
  state: IslandState,
  members: PlacedBuilding[],
  dx: number,
  dy: number,
): { ok: boolean; reason?: string } {
  // 1) overlap among moved members on post-move world tiles.
  const seen = new Set<string>();
  for (const m of members) {
    for (const t of buildingFootprintTilesWorld(spec, { ...m, x: m.x + dx, y: m.y + dy })) {
      const key = `${t.x},${t.y}`;
      if (seen.has(key)) return { ok: false, reason: 'member-overlap' };
      seen.add(key);
    }
  }

  // 2) validate each member against a CLONE with all moving members removed, so
  //    a sibling's vacated tile reads as free (see the sibling caveat above).
  const movingIds = new Set(members.map((m) => m.id));
  const remaining = spec.buildings.filter((b) => !movingIds.has(b.id));
  const cloneSpec: IslandSpec = { ...spec, buildings: remaining };
  const cloneState: IslandState = { ...state, buildings: remaining };

  for (const m of members) {
    const v = validatePlacement(
      cloneSpec, cloneState, m.defId, m.x + dx, m.y + dy,
      (m.rotation ?? 0) as Rotation, DEFAULT_GRAPH, m.id, true,
    );
    if (!v.ok) return { ok: false, reason: v.reason ?? 'invalid' };
  }
  return { ok: true };
}

/** Summed relocate fee across `members` (half the invested cost each, §relocate).
 *  `defOf` lets callers inject a def lookup; defaults to `BUILDING_DEFS`. */
export function groupRelocateFee(
  members: PlacedBuilding[],
  defOf: (defId: PlacedBuilding['defId']) => BuildingDef = (id) => BUILDING_DEFS[id],
): Partial<Record<ResourceId, number>> {
  const total: Partial<Record<ResourceId, number>> = {};
  for (const m of members) {
    for (const [r, n] of Object.entries(relocateFee(m, defOf(m.defId))) as Array<[ResourceId, number]>) {
      total[r] = (total[r] ?? 0) + n;
    }
  }
  return total;
}

export interface IgnoreCapRow { resource: ResourceId; allSet: boolean }

/** Union of output resources across `targets`, each row's `allSet` true iff
 *  EVERY target that outputs that resource has `ignoreCapOverrides[resource]
 *  === true`. A target's outputs come from `resolveRecipe(def, b, terrainAt)`. */
export function ignoreCapUnion(
  targets: { spec: IslandSpec; building: PlacedBuilding }[],
): IgnoreCapRow[] {
  // Per resource: track whether every producing target has the override set.
  const allSet = new Map<ResourceId, boolean>();
  for (const { spec, building } of targets) {
    const def = BUILDING_DEFS[building.defId];
    const recipe = resolveRecipe(def, building, spec.terrainAt);
    if (!recipe) continue;
    for (const r of Object.keys(recipe.outputs) as ResourceId[]) {
      const set = building.ignoreCapOverrides?.[r] === true;
      allSet.set(r, (allSet.get(r) ?? true) && set);
    }
  }
  return [...allSet.entries()].map(([resource, set]) => ({ resource, allSet: set }));
}

/** Count buildings per `defId`, sorted descending by count (ties: defId asc). */
export function selectionBreakdown(
  buildings: PlacedBuilding[],
): { defId: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const b of buildings) counts.set(b.defId, (counts.get(b.defId) ?? 0) + 1);
  return [...counts.entries()]
    .map(([defId, count]) => ({ defId, count }))
    .sort((a, b) => (b.count - a.count) || (a.defId < b.defId ? -1 : 1));
}
