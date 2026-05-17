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

import { CELL_SIZE_TILES, islandCells } from './discovery.js';
import { TILE_PX } from './island.js';
import { visibleCellsFromVision, type VisionSource } from './vision-source.js';
import {
  DISCOVERED_BLUE,
  UNKNOWN_BLUE,
  VISION_BLUE,
  type IslandSpec,
} from './world.js';

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

  // Tier A — vision. Snaps to the stratification cell grid: any cell whose
  // AABB intersects a vision source paints a full VISION_BLUE square. The
  // previous smooth gradient sprites were nicer visually but produced a
  // sub-cell visibility that conflicted with the discovery / weather layers
  // which both reason about whole cells — the cell-grid snap unifies "is
  // this cell visible" across every overlay (per user request).
  const visibleCells = visibleCellsFromVision(visionSources);
  for (const k of visibleCells) {
    const { cx, cy } = parseKey(k);
    layer.addChild(makeCellSquare(cx, cy, VISION_BLUE));
  }

  return layer;
}

/**
 * Pure computation of the cell key set that the fog-overlay layer should
 * paint UNKNOWN_BLUE squares on. Split out from `renderOceanFogOverlay`
 * so the fog-set logic is testable without standing up a PixiJS renderer
 * (mirrors the pure/render split called out in AGENTS.md).
 *
 * A cell is fogged iff ALL three hold:
 *   1. it belongs to some discovered island's footprint (via `islandCells`,
 *      which walks the primary + every `extraEllipses` entry per §3.6),
 *   2. it is NOT in `revealedCells` (the player's per-cell discovery set),
 *   3. it is NOT in `visibleCellsFromVision(visionSources)` (current
 *      vision — populated-island baseline padded ellipse + Lighthouse
 *      circles).
 *
 * Condition (3) is the fix for the "drone discovery flips a neighbour's
 * footprint into the fog set, masking home's vision halo" bug. Without
 * it, an unrevealed cell of a freshly-discovered neighbour that overlaps
 * home's vision halo composes to a solid dark grey square — fog paints
 * UNKNOWN_BLUE on top of the ocean's VISION_BLUE, then the weather
 * overlay layers light_fog rgba(224,232,240,0.18) on top of fog. Vision
 * has to win on cells where both apply.
 */
export function computeFogCells(
  islands: ReadonlyArray<IslandSpec>,
  revealedCells: ReadonlySet<string>,
  visionSources: ReadonlyArray<VisionSource>,
): Set<string> {
  const visibleCells = visibleCellsFromVision(visionSources);
  // Deduplicate cells across overlapping island footprints — two islands
  // sharing a cell would otherwise emit two fog sprites at the same world
  // position. Sprite-cloning is cheap but dedup saves drawcalls.
  const fogCells = new Set<string>();
  for (const isl of islands) {
    if (!isl.discovered) continue;
    for (const k of islandCells(isl)) {
      if (revealedCells.has(k)) continue;
      if (visibleCells.has(k)) continue; // vision lights through the fog
      fogCells.add(k);
    }
  }
  return fogCells;
}

/**
 * Build the fog-overlay layer (the post-island unknown-blue mask).
 *
 * For each rendered island, enumerate its constituent cells via
 * `islandCells(spec)` (which walks the primary ellipse PLUS every
 * `extraEllipses` entry per §3.6); for every cell in that set that is
 * neither in `revealedCells` nor currently illuminated by any vision
 * source, paint an UNKNOWN_BLUE 16-tile sprite. Add the returned
 * container ABOVE the islands layer so the squares mask the unrevealed
 * portion of each partially-revealed island.
 *
 * Cells that aren't part of any island footprint are left alone — they
 * were already UNKNOWN_BLUE from the base rect, and a redundant overlay
 * there would just be drawcalls for no visual change.
 *
 * @param islands         Islands to consider. Undiscovered islands are
 *                        skipped (they don't render in the first place,
 *                        so fogging them would be wasted work).
 * @param revealedCells   Same Set used by `renderOcean`.
 * @param visionSources   Same vision sources passed to `renderOcean`.
 *                        Cells currently inside any vision source are
 *                        excluded from the fog set — otherwise a
 *                        discovered neighbour's unrevealed cells that
 *                        overlap a populated island's vision halo would
 *                        paint UNKNOWN_BLUE over the cyan VISION_BLUE.
 * @returns A `Container` carrying one Sprite per fogged cell.
 */
export function renderOceanFogOverlay(
  islands: ReadonlyArray<IslandSpec>,
  revealedCells: ReadonlySet<string>,
  visionSources: ReadonlyArray<VisionSource>,
): Container {
  const layer = new Container();
  layer.label = 'ocean-fog-overlay';
  const fogCells = computeFogCells(islands, revealedCells, visionSources);
  for (const k of fogCells) {
    const { cx, cy } = parseKey(k);
    layer.addChild(makeCellSquare(cx, cy, UNKNOWN_BLUE));
  }
  return layer;
}
