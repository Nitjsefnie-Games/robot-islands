// Hardcoded step-1 building placements + rendering.
//
// Per task: 4 buildings on the home island —
//   - 1 Solar Panel  (1×1)  yellow
//   - 1 Workshop     (2×2)  orange
//   - 1 Mine         (2×2)  gray w/ darker outline, on an ore vein tile
//   - 1 Cargo Dock   (2×2)  blue
//
// A building's (x, y) is its top-left tile. Footprint extends to
// (x + width - 1, y + height - 1). All footprint tiles are expected to be
// in-island; for step 1 this is verified by eyeballing the rendered scene.

import { Container, Graphics } from 'pixi.js';

import { TILE_PX } from './island.js';

export type BuildingKind = 'solar' | 'workshop' | 'mine' | 'dock';

export interface Building {
  readonly kind: BuildingKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fill: number;
  readonly stroke: number;
  readonly label: string;
}

export const HOME_ISLAND_BUILDINGS: ReadonlyArray<Building> = [
  // Solar Panel — 1×1 sitting on grass near the center.
  { kind: 'solar', x: 2, y: -1, width: 1, height: 1, fill: 0xf2c84b, stroke: 0x6a4a00, label: 'Solar' },
  // Workshop — 2×2 just south of center, on grass.
  { kind: 'workshop', x: -1, y: 1, width: 2, height: 2, fill: 0xe07b3a, stroke: 0x6b2f00, label: 'Workshop' },
  // Mine — 2×2 sitting on the ore vein cluster at (-7, 2)..(-6, 3).
  { kind: 'mine', x: -7, y: 2, width: 2, height: 2, fill: 0x9a9a9a, stroke: 0x222222, label: 'Mine' },
  // Cargo Dock — 2×2 near the east edge, on grass.
  { kind: 'dock', x: 7, y: 1, width: 2, height: 2, fill: 0x3a7bd5, stroke: 0x0a2a55, label: 'Dock' },
];

/**
 * Render buildings into a container. Coordinates align with island.ts: a
 * building's screen position is (x * TILE_PX, y * TILE_PX). A small inset
 * leaves a thin gap so the underlying terrain tile colour is still visible
 * around the building, and the stroke makes the building distinct.
 */
export function renderBuildings(buildings: ReadonlyArray<Building>): Container {
  const layer = new Container();
  layer.label = 'buildings';

  const inset = 2;
  const g = new Graphics();
  for (const b of buildings) {
    const px = b.x * TILE_PX + inset;
    const py = b.y * TILE_PX + inset;
    const w = b.width * TILE_PX - inset * 2;
    const h = b.height * TILE_PX - inset * 2;
    g.rect(px, py, w, h)
      .fill(b.fill)
      .stroke({ width: 2, color: b.stroke, alignment: 1 });
  }
  layer.addChild(g);
  return layer;
}
