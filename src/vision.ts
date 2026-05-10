// Vision-edge overlay.
//
// Draws a faint outline ring at each populated island's vision radius. This
// is purely a UI affordance so the player can see where their "current
// info" boundary lies — there is no fog rendering or alpha-stack involved.
//
// Lives in world space (added to the world container above the island layer
// and below the grid layer), so it pans and zooms with the camera.

import { Container, Graphics } from 'pixi.js';

import { TILE_PX } from './island.js';
import { VISION_RADIUS_TILES } from './world.js';

export interface VisionSource {
  /** World-tile centre of the source. */
  readonly cx: number;
  readonly cy: number;
  /** Radius in world-tiles. Defaults to VISION_RADIUS_TILES. */
  readonly radiusTiles?: number;
}

/**
 * Build a container that draws a thin stroked circle at each vision source's
 * radius. No fill — just the boundary line, faint enough to read as a UI hint
 * rather than a hard wall.
 */
export function renderVisionRings(sources: ReadonlyArray<VisionSource>): Container {
  const layer = new Container();
  layer.label = 'vision-rings';
  const g = new Graphics();
  const stroke = { color: 0x88aabb, alpha: 0.4, width: 2 } as const;
  for (const src of sources) {
    const r = (src.radiusTiles ?? VISION_RADIUS_TILES) * TILE_PX;
    const cx = src.cx * TILE_PX;
    const cy = src.cy * TILE_PX;
    g.circle(cx, cy, r).stroke(stroke);
  }
  layer.addChild(g);
  return layer;
}
