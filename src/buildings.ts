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

export type BuildingKind = 'solar' | 'workshop' | 'mine' | 'dock' | 'coal_gen' | 'dronepad';

export interface Building {
  readonly kind: BuildingKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fill: number;
  readonly stroke: number;
  readonly label: string;
  /** Per-§5.1 electrical contribution. Independent of `recipe`: a building may
   *  produce, consume, both, or neither. Missing/undefined = no contribution. */
  readonly power?: { readonly produces?: number; readonly consumes?: number };
}

export const HOME_ISLAND_BUILDINGS: ReadonlyArray<Building> = [
  // Solar Panel — 1×1 sitting on grass near the center. Recipe-less producer.
  { kind: 'solar', x: 2, y: -1, width: 1, height: 1, fill: 0xf2c84b, stroke: 0x6a4a00, label: 'Solar', power: { produces: 50 } },
  // Workshop — 2×2 just south of center, on grass.
  { kind: 'workshop', x: -1, y: 1, width: 2, height: 2, fill: 0xe07b3a, stroke: 0x6b2f00, label: 'Workshop', power: { consumes: 60 } },
  // Mine — 2×2 sitting on the ore vein cluster at (-7, 2)..(-6, 3).
  { kind: 'mine', x: -7, y: 2, width: 2, height: 2, fill: 0x9a9a9a, stroke: 0x222222, label: 'Mine', power: { consumes: 40 } },
  // Cargo Dock — 2×2 near the east edge, on grass. Power deferred to step 7.
  { kind: 'dock', x: 7, y: 1, width: 2, height: 2, fill: 0x3a7bd5, stroke: 0x0a2a55, label: 'Dock' },
  // Coal Generator — 2×2 east of the workshop, burns 1 coal/5s for 100W while active.
  { kind: 'coal_gen', x: 3, y: 4, width: 2, height: 2, fill: 0xd97a18, stroke: 0x4a2400, label: 'Coal Gen', power: { produces: 100 } },
  // Drone Pad — 1×1 on grass at (5, -3). Tier-gating (Drone Pad is T2 per
  // SPEC §11.7) is deferred to step 9; for step 6 we hardcode placement on
  // the home island, mirroring how Mine/Workshop are hardcoded above. No
  // recipe — Drone Pad has no resource flow, only dispatch (handled in
  // drones.ts). No power draw for step 6 (placeholder).
  { kind: 'dronepad', x: 5, y: -3, width: 1, height: 1, fill: 0x4a6b78, stroke: 0x14222a, label: 'Drone Pad' },
];

/**
 * Render buildings into a container. Coordinates align with island.ts: a
 * building's footprint origin is shifted by -TILE_PX/2 in both axes so that
 * world (0, 0) is the centre of tile (0, 0) — matching renderIslandTiles. A
 * building's screen position is therefore
 *   (x * TILE_PX - TILE_PX/2, y * TILE_PX - TILE_PX/2)
 * (plus the inset). The inset leaves a thin gap so the underlying terrain tile
 * colour is still visible around the building, and the stroke makes the
 * building distinct.
 */
export function renderBuildings(buildings: ReadonlyArray<Building>): Container {
  const layer = new Container();
  layer.label = 'buildings';

  const half = TILE_PX / 2;
  const inset = 2;
  const g = new Graphics();
  for (const b of buildings) {
    const px = b.x * TILE_PX - half + inset;
    const py = b.y * TILE_PX - half + inset;
    const w = b.width * TILE_PX - inset * 2;
    const h = b.height * TILE_PX - inset * 2;
    g.rect(px, py, w, h)
      .fill(b.fill)
      .stroke({ width: 2, color: b.stroke, alignment: 1 });
  }
  layer.addChild(g);
  return layer;
}
