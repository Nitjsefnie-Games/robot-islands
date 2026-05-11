// Three-tier ocean colour rendering with soft tier boundaries.
//
// §11 telemetry redesign: the medium-blue "discovered ocean" tier is now
// driven by the per-cell `revealedCells` set rather than per-island halos.
// Rendering layout:
//
//   1. one big rect filling the world bounds in UNKNOWN_BLUE (alpha 1) —
//      the floor of the entire scene.
//   2. one DISCOVERED_BLUE square sprite per cell in `revealedCells`
//      (16×16 tiles, sprite-cloned from a single shared texture). This
//      replaces the per-island radial-gradient aura — the cell-by-cell
//      squares ARE the new "you've been here" tier.
//   3. vision sources (ellipse + circle gradient sprites) — unchanged.
//      Caller-side responsibility (`main.ts`): add the islands layer on
//      top of the ocean container.
//   4. (Outside this module: the islands draw on top of the ocean.)
//   5. Fog overlay: a post-island layer paints UNKNOWN_BLUE squares on
//      cells NOT in `revealedCells` whose AABB overlaps any rendered
//      island's footprint bbox. This masks the unrevealed portion of each
//      island so partial-reveal looks correct (the island's pixels under
//      an unrevealed cell get covered by the fog square).
//
// Per-island legacy aura (24-tile soft circle around discovered islands)
// is REMOVED — the cell-by-cell DISCOVERED_BLUE squares now carry that
// indicator at finer granularity.
//
// The earlier fog attempt used Canvas2D radial gradients combined with
// `blendMode: 'erase'` against an opaque sheet — the erase blend was the
// failing piece. Here we layer straight semi-transparent sprites over a
// solid background, which Just Works.

import { Container, Graphics, Sprite, Texture } from 'pixi.js';

import { CELL_SIZE_TILES } from './discovery.js';
import { TILE_PX } from './island.js';
import type { VisionSource } from './lighthouse.js';
import {
  DISCOVERED_BLUE,
  UNKNOWN_BLUE,
  VISION_BLUE,
} from './world.js';

/** Shape consumed by the fog-overlay layer (step 5 above). The renderer
 *  computes each rendered island's AABB in world-tile coords from
 *  `(cx, cy, majorRadius, minorRadius)` and paints UNKNOWN_BLUE on any
 *  unrevealed cell intersecting that AABB. Discovered/populated flag is
 *  retained for forward compatibility (and to let the caller drop
 *  not-yet-discovered islands cheaply). */
export interface OceanIsland {
  /** Centre of the island in world-tile coordinates. */
  readonly cx: number;
  readonly cy: number;
  /** Whether the player has discovered this island. (Populated → discovered.) */
  readonly discovered: boolean;
  /** Ellipse semi-axes in tiles — used for the fog-overlay bbox. */
  readonly majorRadius: number;
  readonly minorRadius: number;
}

/** Width of the soft fade band at the rim, in pixels. The inner
 *  `radius - EDGE_FADE_PX` is solid colour; the outer EDGE_FADE_PX fades
 *  to transparent. Sized as an anti-aliasing band, not a visible gradient
 *  — the tier boundary should read as a crisp circle with the rim softened
 *  just enough to avoid pixel staircase. */
const EDGE_FADE_PX = 24;

/**
 * Build a radial-gradient texture: a square canvas of side `2 * radiusPx`
 * holding a three-stop radial gradient centred on the canvas:
 *
 *   stop 0           — colour @ alpha 1
 *   stop innerSolid  — colour @ alpha 1   (flat plateau out to this radius)
 *   stop 1           — colour @ alpha 0   (fully transparent at the rim)
 *
 * `edgePx` is the absolute pixel width of the fade band; `innerSolid` is
 * computed as `(radiusPx - edgePx) / radiusPx`. Using an absolute pixel
 * width (rather than a fraction) keeps the fade looking the same on every
 * sprite regardless of radius — a tiny soft AA edge on both the 24-tile
 * discovery halo and the 80-tile vision halo, instead of a fraction-based
 * fade that scales up dramatically on the larger sprite.
 *
 * The colour stays the same across stops; only alpha animates. Drawing as
 * a Sprite anchored at (0.5, 0.5) places the gradient's centre at the
 * sprite's transform position, so the caller just sets `sprite.position`
 * to the island centre in world pixels.
 */
function buildRadialGradientTexture(
  radiusPx: number,
  edgePx: number,
  colorHex: number,
): Texture {
  const size = Math.ceil(radiusPx * 2);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('buildRadialGradientTexture: 2D context unavailable');

  const cx = size / 2;
  const cy = size / 2;
  // Decompose 0xRRGGBB → "rgba(r,g,b,a)" string for canvas gradient stops.
  const r = (colorHex >> 16) & 0xff;
  const g = (colorHex >> 8) & 0xff;
  const b = colorHex & 0xff;
  const rgb = (alpha: number): string => `rgba(${r}, ${g}, ${b}, ${alpha})`;

  // Clamp innerStop to a valid range. If edgePx >= radiusPx the whole
  // sprite is fade with no solid centre; if edgePx <= 0 there's no fade
  // at all. Neither is expected in normal use but we guard anyway so
  // canvas doesn't throw on out-of-order stops.
  const innerStop = Math.max(0, Math.min(1, (radiusPx - edgePx) / radiusPx));

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radiusPx);
  grad.addColorStop(0, rgb(1));
  grad.addColorStop(innerStop, rgb(1));
  grad.addColorStop(1, rgb(0));

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  return Texture.from(canvas);
}

/** Helper: build a centred sprite from a freshly-baked CIRCULAR gradient
 *  texture. Used by the discovery aura (which stays a true circle).
 */
function makeGradientSprite(
  centreXTiles: number,
  centreYTiles: number,
  radiusTiles: number,
  colorHex: number,
): Sprite {
  const radiusPx = radiusTiles * TILE_PX;
  const tex = buildRadialGradientTexture(radiusPx, EDGE_FADE_PX, colorHex);
  const s = new Sprite(tex);
  s.anchor.set(0.5);
  s.position.set(centreXTiles * TILE_PX, centreYTiles * TILE_PX);
  return s;
}

/** Helper: build a centred sprite shaped as an axis-aligned ellipse with
 *  semi-axes `(majorTiles, minorTiles)`. The underlying texture is a circular
 *  radial gradient sized for the LARGER axis, then non-uniformly scaled so
 *  the shorter axis squashes the circle into an ellipse. Circular biomes
 *  (`major === minor`) stay perfectly circular (scale 1, 1).
 *
 *  Trade-off: `EDGE_FADE_PX` is in screen pixels of the baked texture, so it
 *  also gets squashed by the non-uniform scale on the shorter axis. For
 *  shapes like Coast (14, 7) → vision (64, 57) the minor-axis fade band
 *  reads as ~21px instead of 24px — within AA-band tolerance, no visible
 *  staircase. Worth accepting versus the cost of baking a dedicated
 *  ellipse-shaped gradient texture per source island.
 */
function makeEllipseGradientSprite(
  centreXTiles: number,
  centreYTiles: number,
  majorTiles: number,
  minorTiles: number,
  colorHex: number,
): Sprite {
  const maxAxisTiles = Math.max(majorTiles, minorTiles);
  const radiusPx = maxAxisTiles * TILE_PX;
  const tex = buildRadialGradientTexture(radiusPx, EDGE_FADE_PX, colorHex);
  const s = new Sprite(tex);
  s.anchor.set(0.5);
  s.position.set(centreXTiles * TILE_PX, centreYTiles * TILE_PX);
  s.scale.set(majorTiles / maxAxisTiles, minorTiles / maxAxisTiles);
  return s;
}

/** Cell-size in world pixels. CELL_SIZE_TILES from discovery.ts × TILE_PX. */
const CELL_PX = CELL_SIZE_TILES * TILE_PX;

/** Build (lazily) a 1×1 white texture used as a sprite-clone base for the
 *  16-tile cell squares. The actual colour is set via `sprite.tint` so a
 *  single texture backs both the DISCOVERED_BLUE reveals AND the
 *  UNKNOWN_BLUE fog squares. */
let cellSquareTexture: Texture | null = null;
function getCellSquareTexture(): Texture {
  if (cellSquareTexture !== null) return cellSquareTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('getCellSquareTexture: 2D context unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1, 1);
  cellSquareTexture = Texture.from(canvas);
  return cellSquareTexture;
}

/** Make a 16-tile-square cell-sized sprite tinted to `colorHex` and
 *  positioned with its top-left at the cell's top-left world pixel. The
 *  cell coord `(cx, cy)` covers world tiles `[cx*16, (cx+1)*16)`. */
function makeCellSquare(cx: number, cy: number, colorHex: number): Sprite {
  const s = new Sprite(getCellSquareTexture());
  s.width = CELL_PX;
  s.height = CELL_PX;
  s.tint = colorHex;
  s.position.set(cx * CELL_PX, cy * CELL_PX);
  return s;
}

/** Parse a `"cx,cy"` cell key. Mirrors `discovery.ts → parseCellKey` but
 *  avoids the import cycle (`ocean.ts` is the renderer, kept lightweight). */
function parseKey(key: string): { cx: number; cy: number } {
  const i = key.indexOf(',');
  return { cx: Number(key.slice(0, i)), cy: Number(key.slice(i + 1)) };
}

/**
 * Build the bottom-of-the-stack ocean container.
 *
 * @param revealedCells  Set of cell keys (`"cellX,cellY"`) the player has
 *                       revealed. Each gets a DISCOVERED_BLUE 16-tile square
 *                       sprite painted over the unknown floor.
 * @param visionSources  Vision sources from `lighthouse.ts → computeVisionSources`.
 *                       Painted on top of the cell tier as gradient ellipses
 *                       / circles.
 * @param halfSizeTiles  Half-extent of the unknown rectangle, in tiles.
 * @returns A `Container` to add as the first (bottom) child of your world
 *          container so islands render on top. The matching fog overlay (the
 *          UNKNOWN_BLUE squares that mask unrevealed portions of rendered
 *          islands) is `renderOceanFogOverlay`, intended to be added AFTER
 *          the islands layer.
 */
export function renderOcean(
  revealedCells: ReadonlySet<string>,
  visionSources: ReadonlyArray<VisionSource>,
  halfSizeTiles: number,
): Container {
  const layer = new Container();
  layer.label = 'ocean';

  // Tier C — unknown ocean. Solid rect across the world bounds. Floor of
  // the entire scene; everything else paints over it.
  const halfPx = halfSizeTiles * TILE_PX;
  const bg = new Graphics();
  bg.rect(-halfPx, -halfPx, halfPx * 2, halfPx * 2).fill({
    color: UNKNOWN_BLUE,
    alpha: 1,
  });
  layer.addChild(bg);

  // Tier B — per-cell discovery squares. One DISCOVERED_BLUE 16-tile sprite
  // per revealed cell. Replaces the old per-discovered-island aura — the
  // per-cell granularity is what makes "I scanned here and found nothing"
  // a visible piece of information.
  for (const k of revealedCells) {
    const { cx, cy } = parseKey(k);
    layer.addChild(makeCellSquare(cx, cy, DISCOVERED_BLUE));
  }

  // Tier A — vision sprites. One per VisionSource. Baseline ellipses bake
  // an elliptical gradient (axis-aligned); Lighthouse circles bake a true
  // circle. Overpaint where sources overlap is harmless — the soft edge
  // fade keeps tier boundaries crisp visually while the union semantics
  // are exact.
  for (const src of visionSources) {
    if (src.kind === 'ellipse') {
      layer.addChild(
        makeEllipseGradientSprite(
          src.cx + src.offsetX,
          src.cy + src.offsetY,
          src.major,
          src.minor,
          VISION_BLUE,
        ),
      );
    } else {
      layer.addChild(
        makeGradientSprite(src.cx, src.cy, src.radius, VISION_BLUE),
      );
    }
  }

  return layer;
}

/**
 * Build the fog-overlay layer (the post-island unknown-blue mask).
 *
 * For each rendered island, compute its AABB in cell coords; for every cell
 * in that AABB NOT in `revealedCells`, paint an UNKNOWN_BLUE 16-tile sprite.
 * Add the returned container ABOVE the islands layer so the squares mask
 * the unrevealed portion of each partially-revealed island.
 *
 * Cells that aren't part of any island bbox are left alone — they were
 * already UNKNOWN_BLUE from the base rect, and a redundant overlay there
 * would just be drawcalls for no visual change.
 *
 * @param islands         Islands to consider (skip 'unknown' islands which
 *                        the renderer already short-circuits to null).
 * @param revealedCells   Same Set used by `renderOcean`.
 * @returns A `Container` carrying one Sprite per fogged cell.
 */
export function renderOceanFogOverlay(
  islands: ReadonlyArray<OceanIsland>,
  revealedCells: ReadonlySet<string>,
): Container {
  const layer = new Container();
  layer.label = 'ocean-fog-overlay';
  // Deduplicate cells across overlapping island bboxes — two islands sharing
  // a bbox cell would otherwise emit two fog sprites at the same world
  // position. Sprite-cloning is cheap but dedup saves drawcalls.
  const fogCells = new Set<string>();
  for (const isl of islands) {
    if (!isl.discovered) continue;
    const xMin = Math.floor(isl.cx - isl.majorRadius);
    const xMax = Math.ceil(isl.cx + isl.majorRadius);
    const yMin = Math.floor(isl.cy - isl.minorRadius);
    const yMax = Math.ceil(isl.cy + isl.minorRadius);
    const cMinX = Math.floor(xMin / CELL_SIZE_TILES);
    const cMaxX = Math.floor(xMax / CELL_SIZE_TILES);
    const cMinY = Math.floor(yMin / CELL_SIZE_TILES);
    const cMaxY = Math.floor(yMax / CELL_SIZE_TILES);
    for (let cy = cMinY; cy <= cMaxY; cy++) {
      for (let cx = cMinX; cx <= cMaxX; cx++) {
        const k = `${cx},${cy}`;
        if (revealedCells.has(k)) continue;
        fogCells.add(k);
      }
    }
  }
  for (const k of fogCells) {
    const { cx, cy } = parseKey(k);
    layer.addChild(makeCellSquare(cx, cy, UNKNOWN_BLUE));
  }
  return layer;
}
