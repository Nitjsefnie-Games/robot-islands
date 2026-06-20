// Pure batch-action logic for multi-building selection (§4 mass actions).
// NO PixiJS imports — unit-tested leaf module.
import { BUILDING_DEFS } from './building-defs.js';
import { footprintTiles } from './shape-mask.js';
import { shapeWidth, shapeHeight } from './shape-mask.js';
import { CELL_SIZE_TILES } from './constants.js';
import type { Rotation } from './shape-mask.js';
import type { IslandSpec } from './world.js';
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
