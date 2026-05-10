// Island tile-grid math and rendering.
//
// Per SPEC §3.4: islands are ellipses on the tile grid. A tile (x, y) — meaning
// the unit square from (x, y) to (x+1, y+1) — belongs to the island iff all four
// corners of that square lie strictly inside the ellipse
//   (x²/major²) + (y²/minor²) < 1
// This produces a slightly puffy boundary at the tile-grid scale.
//
// For step 1 we render a circular Plains island (major = minor = 14) centered at
// world origin, with a hardcoded deterministic terrain assignment.

import { Container, Graphics } from 'pixi.js';

export type TerrainKind = 'grass' | 'stone' | 'ore' | 'coal' | 'water';

export interface Tile {
  /** Tile grid x. The tile occupies the unit square [x, x+1) × [y, y+1). */
  readonly x: number;
  readonly y: number;
  readonly terrain: TerrainKind;
}

/** Tile size in pixels for the screen render. */
export const TILE_PX = 24;

const TERRAIN_COLOR: Readonly<Record<TerrainKind, number>> = {
  grass: 0x4a7c44,
  stone: 0x8a8a8a,
  ore: 0x5a4a3a,
  coal: 0x1a1a1a,
  water: 0x3b6fa3,
};

/**
 * Returns true iff all four corners of the unit square [x, x+1) × [y, y+1)
 * lie strictly inside the ellipse (px²/major²) + (py²/minor²) < 1.
 *
 * Strictly-inside means corners on the ellipse don't qualify; only fully
 * inscribed tiles are buildable terrain (SPEC §3.4).
 */
export function tileInscribedInEllipse(
  x: number,
  y: number,
  majorRadius: number,
  minorRadius: number,
): boolean {
  const a2 = majorRadius * majorRadius;
  const b2 = minorRadius * minorRadius;
  const corners: Array<[number, number]> = [
    [x, y],
    [x + 1, y],
    [x, y + 1],
    [x + 1, y + 1],
  ];
  for (const c of corners) {
    const px = c[0];
    const py = c[1];
    if ((px * px) / a2 + (py * py) / b2 >= 1) return false;
  }
  return true;
}

/**
 * Compute the set of tiles belonging to a circular/elliptical island centered
 * at the world origin. Result is in scan order (ascending y, then ascending x).
 */
export function computeIslandTiles(
  majorRadius: number,
  minorRadius: number,
  terrainAt: (x: number, y: number) => TerrainKind,
): Tile[] {
  const tiles: Tile[] = [];
  // Bounding box: a tile fully inside the ellipse must satisfy |x|, |x+1| < major
  // and |y|, |y+1| < minor. So x ∈ [-major, major-1] is a safe over-approximation.
  const xMin = -Math.ceil(majorRadius);
  const xMax = Math.ceil(majorRadius);
  const yMin = -Math.ceil(minorRadius);
  const yMax = Math.ceil(minorRadius);
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      if (tileInscribedInEllipse(x, y, majorRadius, minorRadius)) {
        tiles.push({ x, y, terrain: terrainAt(x, y) });
      }
    }
  }
  return tiles;
}

/**
 * Hardcoded deterministic terrain assignment for the step-1 home island.
 * Defaults to grass, with a small set of named tile coordinates promoted to
 * stone / ore / coal / water clusters. The exact positions don't have to mean
 * anything — they just need to look varied and live on tiles that exist within
 * a radius-14 disk inscribed grid.
 */
export function defaultTerrainAt(x: number, y: number): TerrainKind {
  // Stone outcrops — scattered.
  const stoneTiles: ReadonlyArray<readonly [number, number]> = [
    [-9, -2], [-8, 5], [3, 9], [7, -6], [10, 1], [-2, -10],
  ];
  // Ore vein cluster — needs to sit under the Mine (placed at top-left of a 2×2).
  const oreTiles: ReadonlyArray<readonly [number, number]> = [
    [-7, 2], [-6, 2], [-7, 3], [-6, 3], [-5, 2], [-5, 3],
  ];
  // Coal vein.
  const coalTiles: ReadonlyArray<readonly [number, number]> = [
    [5, 6], [6, 6], [5, 7],
  ];
  // Small fresh-water cluster.
  const waterTiles: ReadonlyArray<readonly [number, number]> = [
    [-1, -5], [0, -5], [-1, -4], [0, -4],
  ];

  for (const t of waterTiles) if (t[0] === x && t[1] === y) return 'water';
  for (const t of coalTiles) if (t[0] === x && t[1] === y) return 'coal';
  for (const t of oreTiles) if (t[0] === x && t[1] === y) return 'ore';
  for (const t of stoneTiles) if (t[0] === x && t[1] === y) return 'stone';
  return 'grass';
}

/**
 * Render the tile grid into a fresh container. The container is positioned so
 * that the world-origin (tile-grid (0, 0) corner) sits at its local (0, 0); the
 * caller is responsible for centering the container in the viewport.
 *
 * Each tile is drawn at local pixel coordinates (x * TILE_PX, y * TILE_PX). Tiles
 * with negative x or y therefore end up to the upper-left of the container origin.
 */
export function renderIslandTiles(tiles: ReadonlyArray<Tile>): Container {
  const layer = new Container();
  layer.label = 'island-tiles';

  const g = new Graphics();
  for (const t of tiles) {
    const px = t.x * TILE_PX;
    const py = t.y * TILE_PX;
    g.rect(px, py, TILE_PX, TILE_PX).fill(TERRAIN_COLOR[t.terrain]);
  }

  // Subtle tile grid lines on top of fills, drawn per-tile so only in-island
  // tiles get a border (the boundary outline emerges naturally from this).
  for (const t of tiles) {
    const px = t.x * TILE_PX;
    const py = t.y * TILE_PX;
    g.rect(px, py, TILE_PX, TILE_PX).stroke({ width: 1, color: 0x000000, alpha: 0.18 });
  }

  layer.addChild(g);
  return layer;
}
