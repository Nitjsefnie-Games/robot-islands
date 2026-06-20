// §2.5 construction ghost — a draggable/resizable preview ellipse for
// artificial-island placement. Parented to the WORLD container so it scales
// with the camera like islands. Render layer only; the authoritative state is
// the ConstructionCandidate owned by main.ts. Body-drag moves the centre;
// the four corner handles resize major/minor.

import { Container, Graphics } from 'pixi.js';

import { TILE_PX } from './island.js';
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

    body.ellipse(px, py, rx, ry);
    body.fill({ color, alpha: 0.22 });
    body.stroke({ color, width: 3, alpha: 0.9 });

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
