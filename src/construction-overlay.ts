// §2.5 construction ghost — a draggable/resizable preview ellipse for
// artificial-island placement. Parented to the WORLD container so it scales
// with the camera like islands. Render layer only; the authoritative state is
// the ConstructionCandidate owned by main.ts. Body-drag moves the centre;
// the four corner handles resize major/minor.

import { Container, Graphics } from 'pixi.js';

import { TILE_PX, tileInscribedInEllipse } from './island.js';
import type { ConstructionCandidate } from './construction-placement.js';

const GHOST_VALID = 0x4ade80;
const GHOST_RED = 0xe06b5a;
const HANDLE_PX = 8;

export interface ConstructionGhostHandle {
  update(cand: ConstructionCandidate | null, red: boolean): void;
  destroy(): void;
}

export function createConstructionGhostOverlay(parent: Container): ConstructionGhostHandle {
  const layer = new Container();
  layer.label = 'construction-ghost';
  parent.addChild(layer);

  const body = new Graphics();
  layer.addChild(body);

  // Four corner handles: TL, TR, BL, BR. Each resizes by dragging.
  const handles = [0, 1, 2, 3].map(() => {
    const g = new Graphics();
    layer.addChild(g);
    return g;
  });

  let current: ConstructionCandidate | null = null;

  function redraw(red: boolean): void {
    body.clear();
    handles.forEach((g) => g.clear());
    if (!current) { layer.visible = false; return; }
    layer.visible = true;
    const color = red ? GHOST_RED : GHOST_VALID;
    const px = current.cx * TILE_PX;
    const py = current.cy * TILE_PX;
    const rx = current.major * TILE_PX;
    const ry = current.minor * TILE_PX;

    // Draw the ACTUAL inscribed-tile footprint (the stair-stepped shape the
    // finished island will occupy), not a smooth ellipse — same inscription test
    // (`tileInscribedInEllipse`) the island renderer and placement use. Fill each
    // inscribed tile, then stroke only boundary edges (an edge whose neighbour
    // tile is NOT inscribed) so the outline traces the tile silhouette.
    const maj = current.major;
    const min = current.minor;
    const xMin = -Math.ceil(maj), xMax = Math.ceil(maj) - 1;
    const yMin = -Math.ceil(min), yMax = Math.ceil(min) - 1;
    const inside = (dx: number, dy: number): boolean =>
      dx >= xMin && dx <= xMax && dy >= yMin && dy <= yMax &&
      tileInscribedInEllipse(dx, dy, maj, min);
    for (let dy = yMin; dy <= yMax; dy++) {
      for (let dx = xMin; dx <= xMax; dx++) {
        if (!inside(dx, dy)) continue;
        const tx = (current.cx + dx) * TILE_PX;
        const ty = (current.cy + dy) * TILE_PX;
        body.rect(tx, ty, TILE_PX, TILE_PX);
      }
    }
    body.fill({ color, alpha: 0.22 });
    for (let dy = yMin; dy <= yMax; dy++) {
      for (let dx = xMin; dx <= xMax; dx++) {
        if (!inside(dx, dy)) continue;
        const tx = (current.cx + dx) * TILE_PX;
        const ty = (current.cy + dy) * TILE_PX;
        if (!inside(dx, dy - 1)) { body.moveTo(tx, ty); body.lineTo(tx + TILE_PX, ty); }
        if (!inside(dx, dy + 1)) { body.moveTo(tx, ty + TILE_PX); body.lineTo(tx + TILE_PX, ty + TILE_PX); }
        if (!inside(dx - 1, dy)) { body.moveTo(tx, ty); body.lineTo(tx, ty + TILE_PX); }
        if (!inside(dx + 1, dy)) { body.moveTo(tx + TILE_PX, ty); body.lineTo(tx + TILE_PX, ty + TILE_PX); }
      }
    }
    body.stroke({ color, width: 3, alpha: 0.9 });

    // Corner handles stay at the ellipse bounding-box corners (the drag/resize
    // hit-test in construction-placement.ts is unchanged).
    const corners: Array<[number, number]> = [
      [px - rx, py - ry], [px + rx, py - ry], [px - rx, py + ry], [px + rx, py + ry],
    ];
    handles.forEach((g, i) => {
      const [hx, hy] = corners[i]!;
      g.rect(hx - HANDLE_PX / 2, hy - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
      g.fill({ color, alpha: 0.95 });
    });
  }

  return {
    update(cand, red) { current = cand; redraw(red); },
    destroy() {
      layer.destroy({ children: true });
    },
  };
}
