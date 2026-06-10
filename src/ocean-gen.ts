// Ocean-layer §2 — procedural terrain seeding.
//
// `generateOceanTerrain(seed, islands)` returns a sparse map of ocean
// cells keyed `"cellX,cellY"`. Cells NOT in the map are implicit `deep`
// (see `terrainAt` in `ocean-cell.ts`); we only store cells whose
// terrain differs from the default. The four explicit terrains are
// seeded in a fixed order so each step can reject overlap with prior
// placements:
//
//   1. shallows         — within R=2 cells of any island edge
//   2. trenches         — 0-3 per world; 2×N rectangles (N=4-8); rare 3×N (10%)
//   3. nodule fields    — 2-5 per world; 3×3 clusters in deep zones
//   4. hydrothermal vents — 0-3 per Volcanic island; 2×2 / 3×2 / 2×3 clusters
//
// Non-overlap rules (per spec §2 + Task-2 brief):
//   - nodule_field never overlaps a trench
//   - hydrothermal_vent never overlaps a trench OR a nodule_field
//   - shallows are placed first; later features may overwrite a shallows
//     cell (the spec only prohibits trench/nodule/vent mutual overlap)
//
// Per-feature RNG streams (`${seed}_ocean_<feature>`) isolate each step:
// adding a future generation step (e.g. underwater ruins) won't perturb
// existing terrain for any seed already in the wild. Same isolation
// pattern as `rollCoastRotation` in `world-gen.ts` (commit a6578df).
// Vent placement uses a per-island sub-stream
// (`${seed}_ocean_vent_${island.id}`) so adding/removing one Volcanic
// island doesn't shift vent rolls on the others.
//
// Pure: no DOM, no PixiJS, no `Math.random`.

import { CELL_SIZE_TILES } from './constants.js';
import type { OceanCellSpec, OceanTerrain } from './ocean-cell.js';
import { makeSeededRng } from './rng.js';
import type { IslandSpec } from './world.js';

// Tuning constants — all spec §2 / Task-2 brief defaults.

/** R for shallows: any cell within R cells of an island edge is shallows. */
const SHALLOWS_RADIUS_CELLS = 2;
/** R for nodule-field deep zone: cell must be > R cells from any island edge. */
const NODULE_DEEP_RADIUS_CELLS = 8;
/** R for vent placement: cluster anchor within R cells of the island edge. */
const VENT_ANCHOR_RADIUS_CELLS = 5;

/** Trench placement caps. 0-3 attempted per world; each rolled
 *  independently. */
const TRENCH_MAX_ATTEMPTS = 3;
const TRENCH_MIN_LEN = 4;
const TRENCH_MAX_LEN = 8;
/** Probability of a rare 3-wide trench (vs the default 2-wide). */
const TRENCH_WIDE_PROB = 0.1;
/** Max rejection attempts per trench when the candidate rectangle
 *  collides with land OR a prior-placed trench (the latter prevents
 *  two trenches merging into a non-rectangular blob). */
const TRENCH_PLACE_ATTEMPTS = 10;
/** Minimum edge distance (in cells) the trench anchor must clear —
 *  pushes trenches into the deep zone away from shallows. */
const TRENCH_MIN_EDGE_DIST_CELLS = 2;

/** Nodule-field placement: 2-5 fields per world. Per spec §2. */
const NODULE_MIN_FIELDS = 2;
const NODULE_MAX_FIELDS = 5;
/** Max rejection attempts when a chosen anchor lands on a trench. */
const NODULE_PLACE_ATTEMPTS = 10;

/** Per-island vent cluster cap: 0-3 attempted. */
const VENT_MAX_PER_ISLAND = 3;
/** Max rejection attempts per vent cluster (overlap with trench / nodule
 *  field forces re-roll). */
const VENT_PLACE_ATTEMPTS = 10;

/**
 * Generate ocean terrain for a world's island layout. Returns a sparse
 * map keyed `"cellX,cellY"` — cells not in the map are implicit `deep`
 * (the default tier; see `ocean-cell.ts`).
 *
 * Deterministic: same `(seed, islands)` always produces the same map.
 * The four feature passes use isolated RNG streams so future inserts
 * don't perturb existing seeds.
 *
 * Pure — does not mutate `islands`.
 */
export function generateOceanTerrain(
  seed: string,
  islands: readonly IslandSpec[],
): Map<string, OceanCellSpec> {
  const cells = new Map<string, OceanCellSpec>();
  seedShallows(cells, islands);
  seedTrenches(cells, seed, islands);
  seedNoduleFields(cells, seed, islands);
  seedVents(cells, seed, islands);
  return cells;
}

const keyOf = (x: number, y: number): string => `${x},${y}`;

const setTerrain = (
  cells: Map<string, OceanCellSpec>,
  x: number,
  y: number,
  terrain: OceanTerrain,
): void => {
  cells.set(keyOf(x, y), { terrain });
};

// Geometry — cell ↔ island-edge distance

/** Distance (in cells) from cell centre `(cx, cy)` to the nearest point
 *  on an island's ellipse edge. Returns 0 if the cell centre is inside
 *  the ellipse; negative-clamped values are folded to 0 so callers
 *  can treat the return as "how far OUTSIDE the island am I." */
function cellDistanceToIslandEdgeCells(
  cellX: number,
  cellY: number,
  island: IslandSpec,
): number {
  // Cell centre in tile coords.
  const tileX = cellX * CELL_SIZE_TILES + CELL_SIZE_TILES / 2;
  const tileY = cellY * CELL_SIZE_TILES + CELL_SIZE_TILES / 2;
  // Distance from island centre to cell centre (in tiles).
  const dx = tileX - island.cx;
  const dy = tileY - island.cy;
  const centreDistTiles = Math.hypot(dx, dy);
  // Use the larger semi-axis as a conservative "radius" — over-estimates
  // distance into the ellipse for narrow biomes, but matches the
  // existing overlap helper's convention (`overlapsAny` in `world-gen.ts`
  // uses `Math.max(major, minor)` for the same reason).
  const edgeRadiusTiles = Math.max(island.majorRadius, island.minorRadius);
  const distOutsideTiles = Math.max(0, centreDistTiles - edgeRadiusTiles);
  return distOutsideTiles / CELL_SIZE_TILES;
}

/** Smallest distance (in cells) from a cell to ANY island's edge. */
function minCellDistanceToAnyIslandEdge(
  cellX: number,
  cellY: number,
  islands: readonly IslandSpec[],
): number {
  let best = Infinity;
  for (const isl of islands) {
    const d = cellDistanceToIslandEdgeCells(cellX, cellY, isl);
    if (d < best) best = d;
  }
  return best;
}

/** Axis-aligned bounding box (in cell coords) covering every island's
 *  footprint padded by `paddingCells`. Used to bound the otherwise-
 *  infinite cell space: we only need to consider cells that COULD be
 *  within R cells of an island edge. */
function islandsBoundingCellRect(
  islands: readonly IslandSpec[],
  paddingCells: number,
): { x0: number; x1: number; y0: number; y1: number } {
  if (islands.length === 0) {
    return { x0: 0, x1: 0, y0: 0, y1: 0 };
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const isl of islands) {
    const r = Math.max(isl.majorRadius, isl.minorRadius);
    const minTileX = isl.cx - r - paddingCells * CELL_SIZE_TILES;
    const maxTileX = isl.cx + r + paddingCells * CELL_SIZE_TILES;
    const minTileY = isl.cy - r - paddingCells * CELL_SIZE_TILES;
    const maxTileY = isl.cy + r + paddingCells * CELL_SIZE_TILES;
    x0 = Math.min(x0, Math.floor(minTileX / CELL_SIZE_TILES));
    x1 = Math.max(x1, Math.floor(maxTileX / CELL_SIZE_TILES));
    y0 = Math.min(y0, Math.floor(minTileY / CELL_SIZE_TILES));
    y1 = Math.max(y1, Math.floor(maxTileY / CELL_SIZE_TILES));
  }
  return { x0, x1, y0, y1 };
}

// Pass 1: shallows

/** Any cell within `SHALLOWS_RADIUS_CELLS` of an island edge becomes
 *  shallows. We scan a bounding rect derived from island footprints
 *  padded by the shallows radius — the cell space is conceptually
 *  infinite, but only cells inside this rect can possibly qualify. */
function seedShallows(
  cells: Map<string, OceanCellSpec>,
  allIslands: readonly IslandSpec[],
  targetIslands?: readonly IslandSpec[],
): void {
  const targets = targetIslands ?? allIslands;
  const rect = islandsBoundingCellRect(targets, SHALLOWS_RADIUS_CELLS);
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      const d = minCellDistanceToAnyIslandEdge(x, y, allIslands);
      if (d === 0) continue; // cell sits on/inside an island — not ocean
      if (d <= SHALLOWS_RADIUS_CELLS) {
        const existing = cells.get(keyOf(x, y));
        if (existing === undefined) {
          setTerrain(cells, x, y, 'shallows');
        }
      }
    }
  }
}

// Pass 2: trenches

/** Pick a random integer in `[lo, hi]` (inclusive) from a uniform PRNG. */
const rollInt = (rng: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

/** Pick a deep-zone cell: must NOT lie on/inside an island, and must NOT
 *  already be a shallows cell. Returns null if the chosen anchor doesn't
 *  qualify (caller retries with a fresh roll). */
function rollDeepZoneCell(
  cells: ReadonlyMap<string, OceanCellSpec>,
  islands: readonly IslandSpec[],
  rng: () => number,
  rect: { x0: number; x1: number; y0: number; y1: number },
  minEdgeDistCells: number,
): [number, number] | null {
  const x = rollInt(rng, rect.x0, rect.x1);
  const y = rollInt(rng, rect.y0, rect.y1);
  if (minCellDistanceToAnyIslandEdge(x, y, islands) < minEdgeDistCells) {
    return null;
  }
  const existing = cells.get(keyOf(x, y))?.terrain;
  if (existing !== undefined && existing !== 'shallows') {
    return null;
  }
  return [x, y];
}

/** Build a 2×N or 3×N rectangle anchored at `(ax, ay)` extending along
 *  an axis chosen by `axisRoll`. Width chosen from `widthRoll`. */
function trenchCells(
  ax: number,
  ay: number,
  length: number,
  width: number,
  horizontal: boolean,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (horizontal) {
    for (let dx = 0; dx < length; dx++) {
      for (let dy = 0; dy < width; dy++) {
        out.push([ax + dx, ay + dy]);
      }
    }
  } else {
    for (let dy = 0; dy < length; dy++) {
      for (let dx = 0; dx < width; dx++) {
        out.push([ax + dx, ay + dy]);
      }
    }
  }
  return out;
}

/** Trenches: 0-3 per world. Each is a 2×N (or rare 3×N at 10%) strip
 *  with N=4-8, anchored in a deep-zone cell. The brief says "drawn
 *  between two random deep-zone endpoints" — we honour the spirit by
 *  picking a deep anchor + length + axis. Trench cells must each lie
 *  outside islands; we reject the whole rectangle if any cell fails. */
function seedTrenches(
  cells: Map<string, OceanCellSpec>,
  seed: string,
  islands: readonly IslandSpec[],
): void {
  const rng = makeSeededRng(`${seed}_ocean_trench`);
  // Bounding rect with enough padding to fit a trench of max length.
  const rect = islandsBoundingCellRect(islands, TRENCH_MAX_LEN);

  // Roll how many trenches to attempt (0-3 inclusive).
  const target = rollInt(rng, 0, TRENCH_MAX_ATTEMPTS);

  for (let i = 0; i < target; i++) {
    const length = rollInt(rng, TRENCH_MIN_LEN, TRENCH_MAX_LEN);
    const width = rng() < TRENCH_WIDE_PROB ? 3 : 2;
    const horizontal = rng() < 0.5;

    // Roll an anchor — must be a deep-zone cell. Up to a few retries
    // for this trench; if every attempt fails we just skip it.
    let placed = false;
    for (let attempt = 0; attempt < TRENCH_PLACE_ATTEMPTS && !placed; attempt++) {
      const anchor = rollDeepZoneCell(
        cells,
        islands,
        rng,
        rect,
        TRENCH_MIN_EDGE_DIST_CELLS,
      );
      if (!anchor) continue;
      const [ax, ay] = anchor;
      const candidate = trenchCells(ax, ay, length, width, horizontal);

      // Reject if any cell of the candidate sits on/inside an island
      // OR is within a 1-cell 4-neighbour buffer of a prior-placed
      // trench. The buffer mirrors the nodule-field pass below — without
      // it, two trenches placed edge-adjacent stay valid rectangles
      // individually but merge into a non-rectangular blob under
      // 4-connected flood fill (the shape invariant the trench-shape
      // test pins). Shallows overwrite is still allowed (spec only
      // restricts trench / nodule / vent mutual overlap).
      let valid = true;
      for (const [cx, cy] of candidate) {
        if (minCellDistanceToAnyIslandEdge(cx, cy, islands) === 0) {
          valid = false;
          break;
        }
        for (const [ndx, ndy] of [
          [0, 0],
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          if (cells.get(keyOf(cx + ndx, cy + ndy))?.terrain === 'trench') {
            valid = false;
            break;
          }
        }
        if (!valid) break;
      }
      if (!valid) continue;

      for (const [cx, cy] of candidate) setTerrain(cells, cx, cy, 'trench');
      placed = true;
    }
  }
}

// Pass 3: nodule fields

/** Nodule fields: 2-5 per world, each a 3×3 cluster in deep zones (cell
 *  > R=8 cells from any island edge). Reject (re-roll position) if any
 *  cluster cell overlaps an existing trench. */
function seedNoduleFields(
  cells: Map<string, OceanCellSpec>,
  seed: string,
  islands: readonly IslandSpec[],
): void {
  const rng = makeSeededRng(`${seed}_ocean_nodule`);
  // Bounding rect: must cover anchors up to NODULE_DEEP_RADIUS_CELLS
  // beyond island edges. Add the 3-cell cluster extent for safety.
  const rect = islandsBoundingCellRect(islands, NODULE_DEEP_RADIUS_CELLS + 3);

  const fieldCount = rollInt(rng, NODULE_MIN_FIELDS, NODULE_MAX_FIELDS);

  for (let i = 0; i < fieldCount; i++) {
    // 3×3 cluster anchored at (ax, ay) covers cells in [ax, ax+2] × [ay, ay+2].
    let placed = false;
    for (let attempt = 0; attempt < NODULE_PLACE_ATTEMPTS && !placed; attempt++) {
      const ax = rollInt(rng, rect.x0, rect.x1);
      const ay = rollInt(rng, rect.y0, rect.y1);

      // Every cell of the cluster must lie in the deep zone (> R=8 from
      // any island edge) and must not overlap an existing trench. We
      // also reject if any cluster cell — or any 4-neighbour thereof —
      // is already a nodule field, so two clusters can't blob into a
      // 6-cell-tall amorphous mass. The player loop is "find the
      // feature, claim it with one Harvester"; distinct features keep
      // that loop legible.
      let valid = true;
      for (let dy = 0; dy < 3 && valid; dy++) {
        for (let dx = 0; dx < 3 && valid; dx++) {
          const cx = ax + dx;
          const cy = ay + dy;
          if (
            minCellDistanceToAnyIslandEdge(cx, cy, islands) <
            NODULE_DEEP_RADIUS_CELLS
          ) {
            valid = false;
            break;
          }
          if (cells.get(keyOf(cx, cy))?.terrain === 'trench') {
            valid = false;
            break;
          }
          // 1-cell buffer ring: reject if this cell OR any 4-neighbour
          // is already nodule_field (keeps separate clusters separate).
          for (const [ndx, ndy] of [
            [0, 0],
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            if (cells.get(keyOf(cx + ndx, cy + ndy))?.terrain === 'nodule_field') {
              valid = false;
              break;
            }
          }
        }
      }
      if (!valid) continue;

      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          setTerrain(cells, ax + dx, ay + dy, 'nodule_field');
        }
      }
      placed = true;
    }
  }
}

// Pass 4: hydrothermal vents

/** Vent cluster shape — width × height, chosen from a weighted table.
 *  Per the Task-2 brief: 2×2 (60%) / 3×2 (30%) / 2×3 (10%). */
function rollVentClusterShape(rng: () => number): { w: number; h: number } {
  const r = rng();
  if (r < 0.6) return { w: 2, h: 2 };
  if (r < 0.9) return { w: 3, h: 2 };
  return { w: 2, h: 3 };
}

/** Hydrothermal vents: per Volcanic island, roll 0-3 cluster attempts.
 *  Each cluster anchor sits within R=5 cells of the island edge; cluster
 *  shape is 2×2 (60%), 3×2 (30%), 2×3 (10%). Reject (re-roll anchor) if
 *  any cluster cell overlaps a trench or nodule field. */
function seedVents(
  cells: Map<string, OceanCellSpec>,
  seed: string,
  allIslands: readonly IslandSpec[],
  targetIslands?: readonly IslandSpec[],
): void {
  const targets = targetIslands ?? allIslands;
  for (const isl of targets) {
    if (isl.biome !== 'volcanic') continue;
    // Per-island sub-stream — adding/removing a Volcanic island elsewhere
    // doesn't shift vent rolls on this one.
    const rng = makeSeededRng(`${seed}_ocean_vent_${isl.id}`);
    const target = rollInt(rng, 0, VENT_MAX_PER_ISLAND);

    // Island cell coords (rough centre).
    const islandCellX = Math.floor(isl.cx / CELL_SIZE_TILES);
    const islandCellY = Math.floor(isl.cy / CELL_SIZE_TILES);
    // Search rect: ±(R + 3) around island cell — covers any 3-cell cluster
    // anchored within R=5 of the island edge.
    const search = {
      x0: islandCellX - (VENT_ANCHOR_RADIUS_CELLS + 3),
      x1: islandCellX + (VENT_ANCHOR_RADIUS_CELLS + 3),
      y0: islandCellY - (VENT_ANCHOR_RADIUS_CELLS + 3),
      y1: islandCellY + (VENT_ANCHOR_RADIUS_CELLS + 3),
    };

    for (let i = 0; i < target; i++) {
      const { w, h } = rollVentClusterShape(rng);
      let placed = false;
      for (let attempt = 0; attempt < VENT_PLACE_ATTEMPTS && !placed; attempt++) {
        const ax = rollInt(rng, search.x0, search.x1);
        const ay = rollInt(rng, search.y0, search.y1);

        // Anchor must sit within R cells of THIS island's edge.
        if (cellDistanceToIslandEdgeCells(ax, ay, isl) > VENT_ANCHOR_RADIUS_CELLS) {
          continue;
        }

        // Every cluster cell must:
        //   - not sit on/inside any island
        //   - not overlap an existing trench or nodule field
        let valid = true;
        for (let dy = 0; dy < h && valid; dy++) {
          for (let dx = 0; dx < w && valid; dx++) {
            const cx = ax + dx;
            const cy = ay + dy;
            if (minCellDistanceToAnyIslandEdge(cx, cy, allIslands) === 0) {
              valid = false;
              break;
            }
            const existing = cells.get(keyOf(cx, cy))?.terrain;
            if (existing === 'trench' || existing === 'nodule_field') {
              valid = false;
              break;
            }
          }
        }
        if (!valid) continue;

        for (let dy = 0; dy < h; dy++) {
          for (let dx = 0; dx < w; dx++) {
            setTerrain(cells, ax + dx, ay + dy, 'hydrothermal_vent');
          }
        }
        placed = true;
      }
    }
  }
}

/** Seed ocean terrain for newly-generated islands. Adds shallows and vents
 * for `newIslands` while respecting the full `allIslands` context (so a
 * new island's shallows don't overwrite land, and its vents don't spawn on
 * existing islands). Safe to call multiple times as islands are added
 * lazily — existing terrain is never removed.
 *
 * To keep vent placement deterministic we also synchronize trench and
 * nodule cells from a full-world regenerate. This is approximate: if a
 * boot-time shallows cell conflicts with a full-world trench, the trench
 * is skipped and vent placement may still diverge for that edge case.
 *
 * Pure with respect to `allIslands`; mutates `cells`. */
export function seedOceanTerrainForIslands(
  cells: Map<string, OceanCellSpec>,
  seed: string,
  allIslands: readonly IslandSpec[],
  newIslands: readonly IslandSpec[],
): void {
  seedShallows(cells, allIslands, newIslands);

  // Vents only roll for volcanic islands, so the expensive full-world
  // trench/nodule sync is only needed when a volcanic island is among the
  // new mints. Non-volcanic mints need only their shallows ring — skip the
  // sync (and the seedVents no-op that follows) entirely.
  if (!newIslands.some((i) => i.biome === 'volcanic')) return;

  // Synchronize trench/nodule context so vent validity checks match boot.
  // We call seedTrenches + seedNoduleFields directly on a fresh temp map
  // rather than going through generateOceanTerrain (which also runs
  // seedShallows over the full world bounding rect — an O(bounding_area ×
  // n_islands) scan that becomes prohibitively expensive as the world grows
  // to hundreds of islands spread across a large area). Trenches and nodules
  // are determined only by the seed + island positions used for deep-zone
  // checks; their RNG streams are identical to the boot path, so the result
  // is the same as generateOceanTerrain minus the shallows pass.
  const tmpCells = new Map<string, OceanCellSpec>();
  seedTrenches(tmpCells, seed, allIslands);
  seedNoduleFields(tmpCells, seed, allIslands);
  for (const [k, v] of tmpCells) {
    if (!cells.has(k)) cells.set(k, v);
  }

  seedVents(cells, seed, allIslands, newIslands);
}
