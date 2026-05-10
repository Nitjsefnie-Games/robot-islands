// Multi-island world data + render coordination.
//
// Step-1 had a single home island rendered at world origin. Step-2 generalises:
// the world is a flat list of placed islands, each with its own centre in
// world-tile coordinates, its biome ellipse parameters, and any buildings
// sitting on it.
//
// Per SPEC §2.1 the world is partitioned into stratification cells of side R
// (the discovery guarantee radius). We use R=16 tiles as a placeholder cell
// size — enough to space the demo islands out and exercise the cell-grid
// overlay, but small enough that the home island's vision radius of 5 cells =
// 80 tiles spans a few neighbours.
//
// Vision model (three states):
//   - 'visible'    — populated, OR discovered AND inside some populated
//                    island's vision radius. Rendered at full color/alpha.
//   - 'discovered' — discovered but outside all vision radii. Rendered dimmed
//                    (alpha + cool tint) to read as "known, but no current
//                    info".
//   - 'unknown'    — not discovered. Not rendered at all; the dark page
//                    background shows through.

import { Container } from 'pixi.js';

import type { Building } from './buildings.js';
import { HOME_ISLAND_BUILDINGS, renderBuildings } from './buildings.js';
import type { Tile, TerrainKind } from './island.js';
import {
  computeIslandTiles,
  defaultTerrainAt,
  renderIslandTiles,
  TILE_PX,
} from './island.js';

/** Stratification cell side length, in tiles. SPEC §2.1 calls this R. */
export const CELL_SIZE_TILES = 16;
/** Vision radius from a populated island, in tiles. Placeholder: 5 cells. */
export const VISION_RADIUS_TILES = 5 * CELL_SIZE_TILES;

export type Biome = 'plains' | 'forest' | 'coast' | 'volcanic' | 'desert' | 'arctic';

export type IslandRenderState = 'visible' | 'discovered' | 'unknown';

export interface IslandSpec {
  readonly id: string;
  readonly biome: Biome;
  /** Centre of the island in world-tile coordinates. */
  readonly cx: number;
  readonly cy: number;
  /** Ellipse half-axes in tiles. */
  readonly majorRadius: number;
  readonly minorRadius: number;
  /** Whether the island is populated (origin of vision). Implies discovered. */
  readonly populated: boolean;
  /** Whether the player knows this island exists at all. Populated → discovered
   *  by definition (the classification function short-circuits on populated). */
  readonly discovered: boolean;
  /** Buildings placed on this island, in island-local tile coords. */
  readonly buildings: ReadonlyArray<Building>;
  /** Terrain function in island-local coords. Defaults to grass everywhere. */
  readonly terrainAt?: (x: number, y: number) => TerrainKind;
}

/** Convenience: world-tile coords → world-pixel coords. */
export function tileToWorldPx(cxTiles: number, cyTiles: number): { x: number; y: number } {
  return { x: cxTiles * TILE_PX, y: cyTiles * TILE_PX };
}

/**
 * Squared world-tile distance from an island's centre to a point. Pure helper
 * for vision-radius checks (avoids sqrt when only comparing to a radius).
 */
export function distSqTiles(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * Classify a single island into one of three render states.
 *
 * Logic (the population short-circuit means we don't have to set
 * `discovered: true` redundantly on populated islands — they're discovered
 * by definition):
 *
 *   1. populated                                 → 'visible'
 *   2. !discovered                               → 'unknown'
 *   3. inside any populated island's vision      → 'visible'
 *   4. otherwise                                 → 'discovered'
 */
export function islandRenderState(
  spec: IslandSpec,
  populatedCentres: ReadonlyArray<{ cx: number; cy: number }>,
  radiusTiles: number,
): IslandRenderState {
  if (spec.populated) return 'visible';
  if (!spec.discovered) return 'unknown';
  const r2 = radiusTiles * radiusTiles;
  for (const p of populatedCentres) {
    if (distSqTiles(spec.cx, spec.cy, p.cx, p.cy) <= r2) return 'visible';
  }
  return 'discovered';
}

/** "Discovered, no current info" tint — cool desaturated blue-grey. Combined
 *  with reduced alpha this reads as a ghost of the island against the dark
 *  page background. */
export const DISCOVERED_TINT = 0xa0b0c0;
/** Alpha for the 'discovered' state. */
export const DISCOVERED_ALPHA = 0.5;

/**
 * Render a single island's terrain + buildings into a fresh container, with
 * the container positioned at the island's world-pixel centre. The contents
 * are drawn in island-local coordinates (matching `renderIslandTiles` /
 * `renderBuildings` from step 1), and the container translation handles the
 * world placement.
 *
 * The render state controls visual modulation:
 *   - 'visible'    → full color / alpha 1
 *   - 'discovered' → dimmed + cool tint (read as "ghost")
 *   - 'unknown'    → null (caller skips it)
 *
 * Note: Container.tint in Pixi v8 multiplies through to child Graphics fills,
 * so we apply both tint and alpha to the wrapper container and the tile +
 * building children inherit. If a future Pixi upgrade breaks the propagation
 * we'd need to switch to applying tint on the inner Graphics directly or
 * use a ColorMatrixFilter.
 */
export function renderIsland(spec: IslandSpec, state: IslandRenderState = 'visible'): Container | null {
  if (state === 'unknown') return null;
  const c = new Container();
  c.label = `island:${spec.id}:${state}`;
  const tiles: Tile[] = computeIslandTiles(
    spec.majorRadius,
    spec.minorRadius,
    spec.terrainAt ?? (() => 'grass'),
  );
  c.addChild(renderIslandTiles(tiles));
  if (spec.buildings.length > 0) c.addChild(renderBuildings(spec.buildings));
  const px = tileToWorldPx(spec.cx, spec.cy);
  c.position.set(px.x, px.y);
  if (state === 'discovered') {
    c.alpha = DISCOVERED_ALPHA;
    c.tint = DISCOVERED_TINT;
  }
  return c;
}

/**
 * Hand-placed demo islands, laid out so the default view shows all three
 * render states:
 *
 *   - home plains (0, 0) populated                            → 'visible'  (state a)
 *   - forest-ne (40, -10) discovered, dist≈41 < 80 (vision)   → 'visible'  (state a, via vision)
 *   - desert-far (80, 60) discovered, dist=100 > 80           → 'discovered' (state b, dimmed)
 *   - coast-unknown (180, 0) !discovered                      → 'unknown'  (state c, not rendered)
 */
export const DEMO_ISLANDS: ReadonlyArray<IslandSpec> = [
  {
    id: 'home',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
    buildings: HOME_ISLAND_BUILDINGS,
    terrainAt: defaultTerrainAt,
  },
  {
    id: 'forest-ne',
    biome: 'forest',
    cx: 40,
    cy: -10,
    majorRadius: 10,
    minorRadius: 10,
    populated: false,
    discovered: true,
    buildings: [],
    terrainAt: () => 'grass',
  },
  {
    id: 'desert-far',
    biome: 'desert',
    cx: 80,
    cy: 60,
    majorRadius: 12,
    minorRadius: 12,
    populated: false,
    discovered: true,
    buildings: [],
    terrainAt: () => 'stone',
  },
  {
    id: 'coast-unknown',
    biome: 'coast',
    cx: 180,
    cy: 0,
    majorRadius: 14,
    minorRadius: 7,
    populated: false,
    discovered: false,
    buildings: [],
    terrainAt: () => 'water',
  },
];
