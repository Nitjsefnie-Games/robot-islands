// §2 Ocean-layer data primitives.
//
// Per §2: the world maintains a sparse map of ocean cells keyed
// `"cellX,cellY"`. Cells NOT in the map are implicit `deep` — the default
// ocean tier — so empty seas cost zero memory.
//
// Pure (no PixiJS, no DOM): holds the terrain type + the lookup helpers that
// placement, render glyphs, and sonar reveal build on. `footprintMatches`
// accepts an OR list so buildings needing "shallows OR deep" share one helper
// with strict single-terrain extractors.

export type OceanTerrain =
  | 'shallows'
  | 'deep'
  | 'trench'
  | 'hydrothermal_vent'
  | 'nodule_field';

export interface OceanCellSpec {
  readonly terrain: OceanTerrain;
}

/** Structural slice of `WorldState` that this module needs. Kept narrow so
 *  unit tests can construct minimal fixtures without standing up a whole
 *  world. The full `WorldState` (in `world.ts`) is assignable to this. */
interface OceanWorld {
  readonly oceanCells: ReadonlyMap<string, OceanCellSpec>;
}

const key = (x: number, y: number): string => `${x},${y}`;

/** Look up the terrain at an ocean cell. Returns 'deep' for cells not
 *  explicitly stored in the map (the implicit default for empty sea). */
export function terrainAt(world: OceanWorld, cellX: number, cellY: number): OceanTerrain {
  return world.oceanCells.get(key(cellX, cellY))?.terrain ?? 'deep';
}

/** Returns true iff every tile under the building's footprint
 *  (anchorX..anchorX+w-1, anchorY..anchorY+h-1) matches one of the
 *  required terrains. */
export function footprintMatches(
  world: OceanWorld,
  anchorX: number,
  anchorY: number,
  footprintW: number,
  footprintH: number,
  requiredTerrains: readonly OceanTerrain[],
): boolean {
  for (let dy = 0; dy < footprintH; dy++) {
    for (let dx = 0; dx < footprintW; dx++) {
      const t = terrainAt(world, anchorX + dx, anchorY + dy);
      if (!requiredTerrains.includes(t)) return false;
    }
  }
  return true;
}

/** §6 rare-feature terrains: the three terrain kinds that get a feature
 *  glyph rendered on the map once revealed. Bulk terrains (shallows / deep)
 *  never carry a glyph — the ocean colour itself is the indicator. */
export const RARE_TERRAINS: ReadonlySet<OceanTerrain> = new Set<OceanTerrain>([
 'hydrothermal_vent',
 'nodule_field',
 'trench',
]);

/** §6 render rule for a single ocean cell. Returns true iff:
 *   1. the cell sits in `oceanCells` (i.e. terrain explicitly stored — the
 *      implicit 'deep' default never qualifies), AND
 *   2. its terrain is one of the rare-feature terrains, AND
 *   3. both `revealedCells` (surface discovery) AND `depthRevealedCells`
 *      (depth scout) cover the cell.
 *
 *  Pure: reads three sets/maps; no PixiJS, no DOM. The render code in
 *  `ocean.ts` iterates `oceanCells` and asks this predicate per cell, then
 *  emits one glyph per *cluster* (via `clusterAnchorOf` — see below). */
export function shouldRenderFeatureGlyph(
  cellKey: string,
  revealedCells: ReadonlySet<string>,
  depthRevealedCells: ReadonlySet<string>,
  oceanCells: ReadonlyMap<string, OceanCellSpec>,
): boolean {
  if (!revealedCells.has(cellKey)) return false;
  if (!depthRevealedCells.has(cellKey)) return false;
  const cell = oceanCells.get(cellKey);
  if (cell === undefined) return false;
  return RARE_TERRAINS.has(cell.terrain);
}

/** §6 cluster anchor: walks the 4-connected component of cells matching
 *  `cellKey`'s terrain (starting from that cell) and returns the top-left
 *  representative — minimum Y, then minimum X. Returns the cell key string
 *  in `"x,y"` form. Pure flood-fill, bounded by the cluster size (vents +
 *  nodule fields are ≤9 cells; trenches are ≤24 cells per §3).
 *
 *  Returns null when:
 *   - the cell isn't in `oceanCells` (implicit-default 'deep' cells have no
 *     persisted cluster identity — they'd flood-fill the entire ocean), OR
 *   - the cell's terrain isn't a rare feature (bulk terrains aren't
 *     clustered for glyph rendering).
 *
 *  Singleton clusters return their own cell — a 1×1 isolated trench cell
 *  flood-fills to itself and returns that one cell. */
export function clusterAnchorOf(
  world: OceanWorld,
  cellKey: string,
): string | null {
  const idx = cellKey.indexOf(',');
  if (idx < 0) return null;
  const startX = Number.parseInt(cellKey.slice(0, idx), 10);
  const startY = Number.parseInt(cellKey.slice(idx + 1), 10);
  if (!Number.isFinite(startX) || !Number.isFinite(startY)) return null;
  const cell = world.oceanCells.get(cellKey);
  if (cell === undefined) return null;
  if (!RARE_TERRAINS.has(cell.terrain)) return null;
  const wanted = cell.terrain;
  // Flood-fill (4-connected) over cells whose stored terrain matches.
  const visited = new Set<string>([cellKey]);
  const stack: Array<readonly [number, number]> = [[startX, startY]];
  let minY = startY;
  let minX = startX;
  let bestKey = cellKey;
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    const [cx, cy] = next;
    if (cy < minY || (cy === minY && cx < minX)) {
      minY = cy;
      minX = cx;
      bestKey = key(cx, cy);
    }
    const neighbours: ReadonlyArray<readonly [number, number]> = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ];
    for (const n of neighbours) {
      const nk = key(n[0], n[1]);
      if (visited.has(nk)) continue;
      const nCell = world.oceanCells.get(nk);
      if (nCell === undefined) continue;
      if (nCell.terrain !== wanted) continue;
      visited.add(nk);
      stack.push(n);
    }
  }
  return bestKey;
}
