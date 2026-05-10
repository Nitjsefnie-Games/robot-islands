// Vision / fog rendering and the pure alpha math behind it.
//
// Vision is a soft-edged disc around each populated island. Inside the disc
// the world is fully visible; outside it is fully covered by a dark fog. The
// transition happens over the last VISION_EDGE_TILES of the radius.
//
// Implementation: Canvas2D radial gradient → Texture → Sprite, one per
// vision source, anchored at the source centre. Plus a dark world-space
// rectangle of the page background colour acting as the base fog. Each
// vision sprite uses blend mode 'erase' which is reliable for Sprites
// because they render into the parent render group's framebuffer; with the
// fog layer marked isRenderGroup, the erase composites against the local
// fog rect rather than the island layer below.
//
// This avoids PixiJS Graphics's alpha-stack quirks and produces a true
// smooth gradient (Canvas2D radial gradient interpolation is GPU-friendly
// once uploaded as a texture).
//
// World-space: the fog container lives inside the world container, so it
// pans and zooms with the camera.

import { AlphaFilter, Container, Graphics, Sprite, Texture } from 'pixi.js';

import { TILE_PX } from './island.js';
import { VISION_EDGE_TILES, VISION_RADIUS_TILES } from './world.js';

/**
 * Pure: visibility alpha at a given world-tile distance from a vision source.
 *
 *   d ≤ R - EDGE          → 1.0 (fully visible)
 *   R - EDGE < d < R      → linear ramp from 1.0 to 0.0
 *   d ≥ R                 → 0.0 (fully fogged)
 */
export function visionAlpha(
  distanceTiles: number,
  radiusTiles: number = VISION_RADIUS_TILES,
  edgeTiles: number = VISION_EDGE_TILES,
): number {
  if (distanceTiles <= 0) return 1;
  const inner = radiusTiles - edgeTiles;
  if (distanceTiles <= inner) return 1;
  if (distanceTiles >= radiusTiles) return 0;
  return (radiusTiles - distanceTiles) / edgeTiles;
}

export function tilesToPx(t: number): number {
  return t * TILE_PX;
}

export interface VisionSource {
  /** World-tile centre of the source. */
  readonly cx: number;
  readonly cy: number;
  /** Radius in world-tiles. Defaults to VISION_RADIUS_TILES. */
  readonly radiusTiles?: number;
}

/**
 * Build a Canvas2D-backed Texture containing a radial gradient that mirrors
 * the visionAlpha curve: white (alpha=1) at the centre, fading to
 * transparent (alpha=0) at the rim. Used as the "eraser" image for fog.
 *
 * The texture is sized to 2×radiusPx so a Sprite anchored at 0.5 lines up
 * with its world centre at the vision source.
 */
function buildVisionTexture(radiusPx: number, edgePx: number): Texture {
  const size = Math.ceil(radiusPx * 2);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // Browsers always provide a 2d context for HTMLCanvasElement, but TS
    // makes us check; fall back to an empty texture if not.
    return Texture.EMPTY;
  }
  // Centre of canvas = vision centre.
  const cx = size / 2;
  const cy = size / 2;
  // Three-stop gradient: solid white inside the inner flat band, linear
  // ramp through the edge band, transparent at and beyond the outer rim.
  const innerStop = (radiusPx - edgePx) / radiusPx;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radiusPx);
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
  grad.addColorStop(Math.max(0, Math.min(1, innerStop)), 'rgba(255, 255, 255, 1)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return Texture.from(canvas);
}

/** Fog colour — matches the page background in index.html so fogged areas
 *  read as "unseen" rather than "shaded over". */
const FOG_COLOR = 0x0a0e14;

/**
 * Build the fog layer container. An AlphaFilter forces the layer to render
 * to an intermediate texture so the child Sprites' 'erase' blend mode cuts
 * holes in the local fog rect rather than the underlying island layer.
 *
 * Bounds: the dark base rect spans [-halfPx, halfPx]² in world coords;
 * pass a `worldHalfSizeTiles` large enough that the player can't pan past
 * its edge in practice. AlphaFilter sizes its intermediate render texture
 * to the filter's bounds intersected with the screen, so we don't pay
 * full-world-rect memory.
 */
export function renderFogLayer(
  sources: ReadonlyArray<VisionSource>,
  worldHalfSizeTiles: number,
): Container {
  const layer = new Container();
  layer.label = 'fog';
  // AlphaFilter forces the layer to render to an intermediate texture before
  // composition. This is what makes the 'erase' blend mode below operate on
  // the local fog rect, not on the underlying island layer. (filter alpha 1
  // is the identity for the visible output.) isRenderGroup alone is not
  // enough — render groups don't allocate a backing texture, so blend
  // modes still operate against the parent framebuffer; a filter does.
  layer.filters = [new AlphaFilter({ alpha: 1 })];

  const halfPx = tilesToPx(worldHalfSizeTiles);
  const base = new Graphics();
  base.rect(-halfPx, -halfPx, halfPx * 2, halfPx * 2).fill({ color: FOG_COLOR, alpha: 1.0 });
  layer.addChild(base);

  const edgePx = tilesToPx(VISION_EDGE_TILES);
  for (const src of sources) {
    const radiusTiles = src.radiusTiles ?? VISION_RADIUS_TILES;
    const radiusPx = tilesToPx(radiusTiles);
    const tex = buildVisionTexture(radiusPx, edgePx);
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 0.5);
    sprite.position.set(src.cx * TILE_PX, src.cy * TILE_PX);
    sprite.blendMode = 'erase';
    layer.addChild(sprite);
  }

  return layer;
}
