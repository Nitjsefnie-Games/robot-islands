// §2.5 construction ghost — a draggable/resizable preview ellipse for
// artificial-island placement. Parented to the WORLD container so it scales
// with the camera like islands. Render layer only; the authoritative state is
// the ConstructionCandidate owned by main.ts. Body-drag moves the centre;
// the four corner handles resize major/minor.

import { Container, Graphics, type FederatedPointerEvent } from 'pixi.js';

import { TILE_PX } from './island.js';
import type { ConstructionCandidate } from './construction-placement.js';

const GHOST_CYAN = 0x7dd3e8;
const GHOST_RED = 0xe06b5a;
const HANDLE_PX = 8;

export interface ConstructionGhostHandle {
  update(cand: ConstructionCandidate | null, red: boolean): void;
  setHandlers(h: {
    onMove(cx: number, cy: number): void;
    onResize(major: number, minor: number): void;
  }): void;
  setToTile(fn: (globalX: number, globalY: number) => { x: number; y: number }): void;
  destroy(): void;
}

export function createConstructionGhostOverlay(parent: Container): ConstructionGhostHandle {
  const layer = new Container();
  layer.label = 'construction-ghost';
  parent.addChild(layer);

  const body = new Graphics();
  body.eventMode = 'static';
  body.cursor = 'move';
  layer.addChild(body);

  // Four corner handles: TL, TR, BL, BR. Each resizes by dragging.
  const handles = [0, 1, 2, 3].map(() => {
    const g = new Graphics();
    g.eventMode = 'static';
    g.cursor = 'nwse-resize';
    layer.addChild(g);
    return g;
  });

  let current: ConstructionCandidate | null = null;
  let handlers: { onMove(cx: number, cy: number): void; onResize(major: number, minor: number): void } | null = null;
  let toTile: ((gx: number, gy: number) => { x: number; y: number }) | null = null;

  // ----- drag state -----
  let dragKind: 'body' | number | null = null; // number = handle index

  function pointerDownBody(e: FederatedPointerEvent): void {
    dragKind = 'body';
    e.stopPropagation();
  }
  function pointerDownHandle(idx: number) {
    return (e: FederatedPointerEvent): void => { dragKind = idx; e.stopPropagation(); };
  }
  function pointerMove(e: FederatedPointerEvent): void {
    if (dragKind === null || !current || !toTile || !handlers) return;
    const t = toTile(e.global.x, e.global.y);
    if (dragKind === 'body') {
      handlers.onMove(Math.round(t.x), Math.round(t.y));
    } else {
      // Handle drag: new radius = |tile - centre| on each axis, min 1.
      const major = Math.max(1, Math.round(Math.abs(t.x - current.cx)));
      const minor = Math.max(1, Math.round(Math.abs(t.y - current.cy)));
      handlers.onResize(major, minor);
    }
  }
  function pointerUp(): void { dragKind = null; }

  body.on('pointerdown', pointerDownBody);
  handles.forEach((g, i) => g.on('pointerdown', pointerDownHandle(i)));
  // Listen on the parent (world container is interactive) for move/up so the
  // drag continues even when the cursor leaves the small handle/body hit area.
  parent.eventMode = 'static';
  parent.on('globalpointermove', pointerMove);
  parent.on('pointerup', pointerUp);
  parent.on('pointerupoutside', pointerUp);

  function redraw(red: boolean): void {
    body.clear();
    handles.forEach((g) => g.clear());
    if (!current) { layer.visible = false; return; }
    layer.visible = true;
    const color = red ? GHOST_RED : GHOST_CYAN;
    const px = current.cx * TILE_PX;
    const py = current.cy * TILE_PX;
    const rx = current.major * TILE_PX;
    const ry = current.minor * TILE_PX;

    body.ellipse(px, py, rx, ry);
    body.fill({ color, alpha: 0.18 });
    body.stroke({ color, width: 2, alpha: 0.9 });

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
    setHandlers(h) { handlers = h; },
    setToTile(fn) { toTile = fn; },
    destroy() {
      parent.off('globalpointermove', pointerMove);
      parent.off('pointerup', pointerUp);
      parent.off('pointerupoutside', pointerUp);
      layer.destroy({ children: true });
    },
  };
}
