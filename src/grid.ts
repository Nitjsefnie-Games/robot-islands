// Stratification cell-grid debug overlay.
//
// Per SPEC §2.1 the cell grid is invisible to the player. This module renders
// it on demand for development: faint gray lines on every cell boundary
// across a generous slice of the world. The grid lives in world space so it
// pans/zooms with the camera; main.ts adds it above the vision-ring overlay
// so its lines stay visible whenever toggled on.
//
// The grid spans a hardcoded world box (no per-frame visible-bounds computation)
// — adequate for the area the user can realistically explore.

import { Container, Graphics } from 'pixi.js';

import { TILE_PX } from './island.js';
import { CELL_SIZE_TILES } from './world.js';

/**
 * Render the cell grid as a Container of faint lines. `halfSizeTiles`
 * controls how far from world-origin the grid extends in each direction.
 *
 * The returned container has `visible = false` by default — callers toggle
 * it on/off via `container.visible = !container.visible`.
 */
export function renderCellGrid(halfSizeTiles: number): Container {
  const layer = new Container();
  layer.label = 'cell-grid';
  layer.visible = false;

  const cellPx = CELL_SIZE_TILES * TILE_PX;
  const halfPx = halfSizeTiles * TILE_PX;
  // Render convention (AGENTS.md "Tile index has TWO conventions"): tile (x,y)
  // is drawn CENTRED at x*TILE_PX, so a cell boundary — the left edge of tile
  // cellX*16 — sits at cellX*cellPx − TILE_PX/2. Without the −half the grid
  // (and every per-cell tint keyed to it) lands half a tile off the
  // buildings/land it should bound.
  const half = TILE_PX / 2;

  const g = new Graphics();
  const style = { width: 1, color: 0x808080, alpha: 0.25 } as const;

  // Vertical lines at every multiple of cellPx within [-halfPx, halfPx].
  const startCell = Math.floor(-halfPx / cellPx);
  const endCell = Math.ceil(halfPx / cellPx);
  for (let i = startCell; i <= endCell; i++) {
    const x = i * cellPx - half;
    g.moveTo(x, -halfPx - half).lineTo(x, halfPx - half).stroke(style);
  }
  for (let i = startCell; i <= endCell; i++) {
    const y = i * cellPx - half;
    g.moveTo(-halfPx - half, y).lineTo(halfPx - half, y).stroke(style);
  }

  layer.addChild(g);
  return layer;
}
