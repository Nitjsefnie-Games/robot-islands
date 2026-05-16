// §2.6 weather visualization layer.
//
// Each stratification cell carries a deterministic weather state (the pure
// `weather()` fn in weather.ts). The simulation already uses that state for
// vehicle destruction, route capacity, and drone scan penalties — but the
// player couldn't SEE weather, so dispatching launches required blind
// guesswork. This module renders the cells within visibility range of any
// populated island as translucent tinted squares.
//
// Vision range: BASE_VISIBILITY_CELLS = 5 cells from each populated island,
// extended by +3 for each `weather_station_t2` and +6 for each
// `advanced_weather_station_t3` on that island (matches §2.6 spec literal).
// Distance is measured cell-to-cell using the island's tileToCell projection,
// so the unit math is consistent (the `isWeatherVisible` helper in weather.ts
// has a latent tile-vs-cell mismatch that doesn't manifest in its current
// test set — this module side-steps it rather than reuses it).
//
// Performance: scans a bounded box per island (~21×21 cells for a typical
// weather-station-equipped colony). Rebuild is throttled to once per
// WEATHER_OVERLAY_REBUILD_MS — weather dwell is hours, so a 5s refresh is
// already well under any visible transition.

import { Container, Sprite, Texture } from 'pixi.js';

import { TILE_PX } from './island.js';
import { weather, type WeatherState } from './weather.js';
import { CELL_SIZE_TILES, type IslandSpec, type WorldState } from './world.js';

/** Cell-size in world pixels — matches the convention in ocean.ts. */
const CELL_PX = CELL_SIZE_TILES * TILE_PX;

/** §2.6 baseline visibility radius from any populated island. */
export const BASE_VISIBILITY_CELLS = 5;

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

function visibilityRangeCells(spec: IslandSpec): number {
  let range = BASE_VISIBILITY_CELLS;
  for (const b of spec.buildings) {
    if (b.defId === 'weather_station_t2') range += 3;
    else if (b.defId === 'advanced_weather_station_t3') range += 6;
  }
  return range;
}

/** Build (or rebuild) the set of cell coords whose weather is currently
 *  visible to the player. Pure data — no rendering side-effects. */
export function visibleWeatherCells(world: WorldState): Set<string> {
  const cells = new Set<string>();
  for (const isl of world.islands) {
    if (!isl.populated) continue;
    const islCellX = tileToCellInt(isl.cx);
    const islCellY = tileToCellInt(isl.cy);
    const range = visibilityRangeCells(isl);
    for (let dy = -range; dy <= range; dy++) {
      for (let dx = -range; dx <= range; dx++) {
        if (dx * dx + dy * dy > range * range) continue;
        cells.add(`${islCellX + dx},${islCellY + dy}`);
      }
    }
  }
  return cells;
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
   *  Cheap when within the throttle window — single timestamp compare. */
  refresh(nowMs: number): void;
  /** Force a rebuild on the next frame — call after a populated island
   *  flips, a weather station is placed/demolished, etc. */
  invalidate(): void;
}

export function mountWeatherOverlay(world: WorldState): WeatherOverlayHandle {
  const layer = new Container();
  layer.label = 'weather-overlay';
  let lastRebuildMs = -Infinity;
  let dirty = true;

  const rebuild = (nowMs: number): void => {
    layer.removeChildren();
    const cells = visibleWeatherCells(world);
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
    refresh(nowMs: number): void {
      if (!dirty && nowMs - lastRebuildMs < WEATHER_OVERLAY_REBUILD_MS) return;
      rebuild(nowMs);
    },
    invalidate(): void {
      dirty = true;
    },
  };
}
