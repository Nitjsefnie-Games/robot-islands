// Three-tier ocean colour rendering with soft tier boundaries (§11).
// The "discovered ocean" tier is driven by the per-cell `revealedCells`
// set rather than per-island halos. Rendering layout:
//
//   1. UNKNOWN_BLUE rect filling the world bounds — floor of the scene.
//   2. one DISCOVERED_BLUE 16-tile square sprite per revealed cell.
//   3. vision sources (cell-snapped VISION_BLUE squares).
//   4. (Outside this module: the islands draw on top of the ocean.)
//   5. Fog overlay: post-island UNKNOWN_BLUE squares on cells NOT in
//      `revealedCells` whose AABB overlaps a rendered island's footprint,
//      masking the unrevealed portion of each partially-revealed island.
//
// Straight semi-transparent sprites over a solid background — NOT Canvas2D
// radial gradients with `blendMode: 'erase'`, whose erase blend failed.

import { Container, Graphics, Sprite, Texture } from 'pixi.js';

import { CELL_SIZE_TILES, islandCells } from './discovery.js';
import { TILE_PX } from './island.js';
import {
  clusterAnchorOf,
  shouldRenderFeatureGlyph,
  type OceanCellSpec,
  type OceanTerrain,
} from './ocean-cell.js';
import { visibleCellsFromVision, type VisionSource } from './vision-source.js';
import {
  DISCOVERED_BLUE,
  UNKNOWN_BLUE,
  VISION_BLUE,
  type IslandSpec,
} from './world.js';

/** Cell-size in world pixels (CELL_SIZE_TILES × TILE_PX). */
const CELL_PX = CELL_SIZE_TILES * TILE_PX;

/** Lazily-built 1×1 white texture, sprite-clone base for the cell squares.
 *  Colour is set via `sprite.tint` so one texture backs both the
 *  DISCOVERED_BLUE reveals and the UNKNOWN_BLUE fog squares. */
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

/** Cell-sized sprite tinted `colorHex`, top-left at the cell's top-left
 *  world pixel. Cell `(cx, cy)` covers world tiles `[cx*16, (cx+1)*16)`. */
function makeCellSquare(cx: number, cy: number, colorHex: number): Sprite {
  const s = new Sprite(getCellSquareTexture());
  s.width = CELL_PX;
  s.height = CELL_PX;
  s.tint = colorHex;
  s.position.set(cx * CELL_PX, cy * CELL_PX);
  return s;
}

/** Parse a `"cx,cy"` cell key. Mirrors `discovery.ts → parseCellKey` but
 *  avoids the import cycle. */
function parseKey(key: string): { cx: number; cy: number } {
  const i = key.indexOf(',');
  return { cx: Number(key.slice(0, i)), cy: Number(key.slice(i + 1)) };
}

/**
 * Build the bottom-of-the-stack ocean container.
 *
 * @param revealedCells  Cell keys (`"cellX,cellY"`) the player has revealed;
 *                       each gets a DISCOVERED_BLUE 16-tile square over the floor.
 * @param visionSources  Vision sources from `lighthouse.ts → computeVisionSources`.
 * @param halfSizeTiles  Half-extent of the unknown rectangle, in tiles.
 * @returns A `Container` to add as the first (bottom) child of the world
 *          container so islands render on top. The matching post-island fog
 *          mask is `renderOceanFogOverlay`, added AFTER the islands layer.
 */
export function renderOcean(
  revealedCells: ReadonlySet<string>,
  visionSources: ReadonlyArray<VisionSource>,
  halfSizeTiles: number,
): Container {
  const layer = new Container();
  layer.label = 'ocean';

  // Tier C — unknown ocean. Solid rect; floor of the scene, everything paints over it.
  const halfPx = halfSizeTiles * TILE_PX;
  const bg = new Graphics();
  bg.rect(-halfPx, -halfPx, halfPx * 2, halfPx * 2).fill({
    color: UNKNOWN_BLUE,
    alpha: 1,
  });
  layer.addChild(bg);

  // Tier B — per-cell discovery squares. One DISCOVERED_BLUE 16-tile sprite
  // per revealed cell; the per-cell granularity is what makes "I scanned
  // here and found nothing" a visible piece of information.
  for (const k of revealedCells) {
    const { cx, cy } = parseKey(k);
    layer.addChild(makeCellSquare(cx, cy, DISCOVERED_BLUE));
  }

  // Tier A — vision. Snaps to the stratification cell grid: any cell whose
  // AABB intersects a vision source paints a full VISION_BLUE square. The
  // cell-grid snap unifies "is this cell visible" across the discovery /
  // weather overlays, which both reason about whole cells.
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
 * Condition (3) fixes the "drone discovery flips a neighbour's footprint
 * into the fog set, masking home's vision halo" bug: without it, fog paints
 * UNKNOWN_BLUE over the ocean's VISION_BLUE on cells where both apply.
 * Vision has to win there.
 */
export function computeFogCells(
  islands: ReadonlyArray<IslandSpec>,
  revealedCells: ReadonlySet<string>,
  visionSources: ReadonlyArray<VisionSource>,
): Set<string> {
  const visibleCells = visibleCellsFromVision(visionSources);
  // Set dedups cells shared across overlapping island footprints, saving
  // duplicate fog sprites (drawcalls) at the same world position.
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
 * Build the fog-overlay layer (the post-island unknown-blue mask): one
 * UNKNOWN_BLUE 16-tile sprite per cell in `computeFogCells`. Add the
 * returned container ABOVE the islands layer so the squares mask the
 * unrevealed portion of each partially-revealed island. Cells outside any
 * island footprint are left alone — already UNKNOWN_BLUE from the base rect.
 *
 * @param islands         Islands to consider; undiscovered ones are skipped.
 * @param revealedCells   Same Set used by `renderOcean`.
 * @param visionSources   Same vision sources passed to `renderOcean`.
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

// §6 Feature glyph render pass.
//
// Renders one ∿ / ⋮ / ▭ glyph per rare-feature cluster (vent / nodule /
// trench) whose anchor cell satisfies `shouldRenderFeatureGlyph` — both the
// surface reveal AND the depth scout flags are set. Sits between the fog
// overlay and the weather overlay so storms visually occlude glyphs (§6:
// "a storm visually hides what's underneath").
//
// Pixel-size invariance: glyph sprites are sized in world pixels and the
// outer container counter-scales to `1 / cam.zoom` each frame (see main.ts
// ticker — `featureGlyphs.setZoom(cam.zoom)`).

/** §6 glyph dictionary — pale-cyan, fixed pixel size, scale-invariant. */
const GLYPH_CHARS: Readonly<Record<OceanTerrain, string | null>> = {
  hydrothermal_vent: '∿',
  nodule_field: '⋮',
  trench: '▭',
  shallows: null,
  deep: null,
};

/** Pale-cyan tint that contrasts with both fog tiers (VISION_BLUE 0x7dd3e8
 *  on the bright side, UNKNOWN_BLUE 0x0a0e14 on the dark side). */
const GLYPH_COLOR_CSS = '#cfeef5';

/** Sprite pixel size — middle of the 12-16 px target range per §6. */
const GLYPH_PX = 14;

/** Memoised glyph textures keyed by char + size. Glyph chars are short
 *  string literals; sharing across clusters keeps GPU upload count to ≤3. */
const glyphTextureCache = new Map<string, Texture>();

function getGlyphTexture(char: string, pxSize: number): Texture {
  const key = `${char}@${pxSize}`;
  const cached = glyphTextureCache.get(key);
  if (cached !== undefined) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = pxSize;
  canvas.height = pxSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('getGlyphTexture: 2D context unavailable');
  ctx.fillStyle = GLYPH_COLOR_CSS;
  ctx.font = `bold ${pxSize}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(char, pxSize / 2, pxSize / 2);
  const tex = Texture.from(canvas);
  glyphTextureCache.set(key, tex);
  return tex;
}

/** Handle for the §6 feature-glyph layer. The main ticker drives `refresh`
 *  on world rebuild + `setZoom` per frame so the glyphs stay scale-invariant. */
export interface FeatureGlyphsHandle {
  readonly layer: Container;
  /** Rebuild the glyph sprites from current world state. Cheap — a handful
   *  of clusters per world, each one Sprite. */
  refresh(
    oceanCells: ReadonlyMap<string, OceanCellSpec>,
    revealedCells: ReadonlySet<string>,
    depthRevealedCells: ReadonlySet<string>,
  ): void;
  /** Counter-scale the inner sprite container to keep glyphs at a fixed
   *  pixel size as the camera zooms. Called per frame from the main ticker
   *  alongside the existing camera sync. */
  setZoom(zoom: number): void;
}

/** Mount the §6 feature-glyph layer. Returns a handle whose `layer` should
 *  be added to the world container between fog (slot 2) and weather.
 *
 *  Pixel-size invariance: set `sprite.width = sprite.height = GLYPH_PX / zoom`
 *  each frame. The container inherits world-scale (= cam.zoom), so on-screen
 *  size is `zoom * (GLYPH_PX / zoom) = GLYPH_PX` regardless of zoom. Positions
 *  are world-pixel coords (cell centre) and scale naturally with the world. */
export function mountFeatureGlyphs(): FeatureGlyphsHandle {
  const layer = new Container();
  layer.label = 'ocean-feature-glyphs';
  // Currently-applied counter-scale, so `refresh` can size newly-minted
  // sprites without waiting for the next `setZoom` call.
  let currentZoom = 1;

  function applyCounterScaleTo(sprite: Sprite): void {
    sprite.width = GLYPH_PX / currentZoom;
    sprite.height = GLYPH_PX / currentZoom;
  }

  function rebuild(
    oceanCells: ReadonlyMap<string, OceanCellSpec>,
    revealedCells: ReadonlySet<string>,
    depthRevealedCells: ReadonlySet<string>,
  ): void {
    layer.removeChildren();
    // Track each cluster anchor we've already emitted so we don't draw N
    // glyphs for an N-cell cluster (one per cluster anchor per §6).
    const emittedAnchors = new Set<string>();
    for (const [cellKey, cell] of oceanCells) {
      if (!shouldRenderFeatureGlyph(cellKey, revealedCells, depthRevealedCells, oceanCells)) {
        continue;
      }
      // Anchor from the depth-revealed subset so the glyph never leaks the
      // position of un-scouted rare-terrain cells (#86).
      const anchor = clusterAnchorOf({ oceanCells }, cellKey, depthRevealedCells);
      if (anchor === null) continue;
      if (emittedAnchors.has(anchor)) continue;
      emittedAnchors.add(anchor);
      const char = GLYPH_CHARS[cell.terrain];
      if (char === null) continue;
      const ac = parseKey(anchor);
      const tex = getGlyphTexture(char, GLYPH_PX);
      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5);
      // Centre the glyph on the anchor cell — half-cell offset.
      const wx = (ac.cx + 0.5) * CELL_PX;
      const wy = (ac.cy + 0.5) * CELL_PX;
      sprite.position.set(wx, wy);
      applyCounterScaleTo(sprite);
      layer.addChild(sprite);
    }
  }

  function setZoom(zoom: number): void {
    if (zoom <= 0 || !Number.isFinite(zoom)) return;
    if (currentZoom === zoom) return;
    currentZoom = zoom;
    for (const child of layer.children) {
      if (child instanceof Sprite) {
        applyCounterScaleTo(child);
      }
    }
  }

  return {
    layer,
    refresh: rebuild,
    setZoom,
  };
}
