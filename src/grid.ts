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

  const g = new Graphics();
  const style = { width: 1, color: 0x808080, alpha: 0.25 } as const;

  // Vertical lines at every multiple of cellPx within [-halfPx, halfPx].
  const startCell = Math.floor(-halfPx / cellPx);
  const endCell = Math.ceil(halfPx / cellPx);
  for (let i = startCell; i <= endCell; i++) {
    const x = i * cellPx;
    g.moveTo(x, -halfPx).lineTo(x, halfPx).stroke(style);
  }
  for (let i = startCell; i <= endCell; i++) {
    const y = i * cellPx;
    g.moveTo(-halfPx, y).lineTo(halfPx, y).stroke(style);
  }

  layer.addChild(g);
  return layer;
}
