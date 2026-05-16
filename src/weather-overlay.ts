// §2.6 weather visualization layer.
//
// Each stratification cell carries a deterministic weather state (the pure
// `weather()` fn in weather.ts). The simulation uses that state for vehicle
// destruction, route capacity, and drone scan penalties — but the player
// needed a visible signal to dispatch launches strategically.
//
// Visibility: this overlay piggybacks on the SAME vision predicate the
// ocean layer uses. If a cell's AABB intersects ANY vision source
// (`computeVisionSources` — baseline padded ellipses around populated
// islands + per-Lighthouse circles), the whole cell renders. This unifies
// "what can I see" across the ocean tier, the discovery cells, and weather
// — building a Lighthouse extends weather visibility because it extends
// vision. The earlier ad-hoc BASE_VISIBILITY_CELLS disc that ignored
// Lighthouses and used a fixed-radius cell-grid disc is gone.
//
// The §2.6 Weather Station bonus is not yet wired through this path — the
// spec defines Weather Stations as extenders of weather visibility
// specifically; if we want to honour them they should appear as additional
// vision sources for weather purposes only (a follow-up).
//
// Performance: visibleCellsFromVision is bounded by the source AABBs; the
// throttled rebuild (WEATHER_OVERLAY_REBUILD_MS = 5s) keeps Graphics churn
// negligible.

import { Container, Sprite, Texture } from 'pixi.js';

import { TILE_PX } from './island.js';
import { visibleCellsFromVision, type VisionSource } from './vision-source.js';
import { weather, type WeatherState } from './weather.js';
import { CELL_SIZE_TILES, type IslandSpec, type WorldState } from './world.js';

/** Cell-size in world pixels — matches the convention in ocean.ts. */
const CELL_PX = CELL_SIZE_TILES * TILE_PX;

/** Rebuild cadence (ms). Weather dwells for hours; a sub-second refresh is
 *  wasteful. 5s keeps the overlay visibly live during transitions without
 *  per-frame Graphics churn. */
export const WEATHER_OVERLAY_REBUILD_MS = 5000;

/** Translucent tint per state. `'clear'` renders nothing (the overlay is a
 *  "weather is here" hint, not a fog mask). Alphas tuned so storms read at
 *  a glance over the cyan ocean / green island backgrounds without occluding
 *  buildings underneath. */
const STATE_TINT: Record<WeatherState, { color: number; alpha: number } | null> = {
  clear: null,
  light_fog: { color: 0xe0e8f0, alpha: 0.18 },
  storm: { color: 0x6080a0, alpha: 0.32 },
  severe_storm: { color: 0x40506a, alpha: 0.48 },
  catastrophic: { color: 0x802050, alpha: 0.6 },
};

let cellTexture: Texture | null = null;
function getCellTexture(): Texture {
  if (cellTexture !== null) return cellTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('weather-overlay: 2D context unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1, 1);
  cellTexture = Texture.from(canvas);
  return cellTexture;
}

function tileToCellInt(t: number): number {
  return Math.floor(t / CELL_SIZE_TILES);
}

/** Look up the biome for a cell, if a populated island sits in/near it.
 *  When no island matches, weather samples with the default Plains
 *  baseline (the `weather()` fn's `biome === undefined` branch). */
function biomeForCell(
  world: WorldState,
  cellX: number,
  cellY: number,
): IslandSpec['biome'] | undefined {
  // Match the island whose center cell IS this cell (exact projection).
  // Adjacent cells share Plains baseline for simplicity — biome modulation
  // is a soft hint, not a strict per-cell partition.
  for (const isl of world.islands) {
    if (tileToCellInt(isl.cx) === cellX && tileToCellInt(isl.cy) === cellY) {
      return isl.biome;
    }
  }
  return undefined;
}

export interface WeatherOverlayHandle {
  /** Render layer to add to the world container, above islands so the tint
   *  reads over land and sea both. */
  readonly layer: Container;
  /** Repaint the overlay if enough time has passed since the last rebuild.
   *  Cheap when within the throttle window — single timestamp compare.
   *  `getVisionSources` is invoked at each rebuild so a freshly-placed
   *  Lighthouse / new populated island extends weather visibility on the
   *  next refresh. */
  refresh(nowMs: number, getVisionSources: () => ReadonlyArray<VisionSource>): void;
  /** Force a rebuild on the next frame — call after a populated island
   *  flips, a Lighthouse is placed/demolished, etc. */
  invalidate(): void;
}

export function mountWeatherOverlay(world: WorldState): WeatherOverlayHandle {
  const layer = new Container();
  layer.label = 'weather-overlay';
  let lastRebuildMs = -Infinity;
  let dirty = true;

  const rebuild = (nowMs: number, sources: ReadonlyArray<VisionSource>): void => {
    layer.removeChildren();
    const cells = visibleCellsFromVision(sources);
    for (const key of cells) {
      const idx = key.indexOf(',');
      const cellX = Number(key.slice(0, idx));
      const cellY = Number(key.slice(idx + 1));
      const biome = biomeForCell(world, cellX, cellY);
      const w = weather(world.seed, cellX, cellY, nowMs, biome);
      const tint = STATE_TINT[w.state];
      if (!tint) continue;
      const sprite = new Sprite(getCellTexture());
      sprite.width = CELL_PX;
      sprite.height = CELL_PX;
      sprite.tint = tint.color;
      sprite.alpha = tint.alpha;
      sprite.position.set(cellX * CELL_PX, cellY * CELL_PX);
      layer.addChild(sprite);
    }
    lastRebuildMs = nowMs;
    dirty = false;
  };

  return {
    layer,
    refresh(nowMs: number, getVisionSources: () => ReadonlyArray<VisionSource>): void {
      if (!dirty && nowMs - lastRebuildMs < WEATHER_OVERLAY_REBUILD_MS) return;
      rebuild(nowMs, getVisionSources());
    },
    invalidate(): void {
      dirty = true;
    },
  };
}
