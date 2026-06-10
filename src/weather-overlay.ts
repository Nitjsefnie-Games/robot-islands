// §2.6 weather visualization layer.
//
// Each stratification cell carries a deterministic weather state (the pure
// `weather()` fn in weather.ts). The simulation uses that state for vehicle
// destruction, route capacity, and drone scan penalties — but the player
// needed a visible signal to dispatch launches strategically.
//
// Visibility: this overlay uses a *weather-specific* vision-source set
// (`computeWeatherVisionSources`), distinct from the ocean / Lighthouse
// vision graph. The current-cycle layer reveals cells that intersect:
//
//   (a) any populated island's ocean-padded ellipse (keeps the overlay
//       aligned with the visible water around each coast), AND
//   (b) a per-island weather circle of radius
//       `BASE_WEATHER_VISIBILITY_TILES (=5) + Σ station bonuses`. §2.6
//       station bonuses: T2 Weather Station +3 tiles, T3 Advanced Weather
//       Station +6 tiles. Multiple stations on the same island STACK
//       additively (matches the pinned `isWeatherVisible` test surface in
//       `weather.test.ts`).
//
// In addition, every island carrying an Advanced Weather Station (T3) emits
// a parallel *forecast* circle of the same radius. Cells in that forecast
// set get a second, lower-opacity sprite drawn on top, tinted by the
// weather state `WEATHER_FORECAST_LOOKAHEAD_MS` in the future — the
// "+1-cycle ahead forecasting" §2.6 promise. The lookahead is the
// arithmetic midpoint of the cell-dwell range (~2 h) since dwell is
// variable per cell and the spec doesn't pin a fixed cycle length.
//
// Lighthouses do NOT extend weather visibility — only the ocean ellipse
// (always present) and weather stations do.
//
// Performance: visibleCellsFromVision is bounded by the source AABBs; the
// throttled rebuild (WEATHER_OVERLAY_REBUILD_MS = 5s) keeps Graphics churn
// negligible.

import { Container, Sprite, Texture } from 'pixi.js';

import { TILE_PX } from './island.js';
import { visibleCellsFromVision } from './vision-source.js';
import {
  WEATHER_FORECAST_LOOKAHEAD_MS,
  biomeForCell,
  sumIslandCo2,
  weather,
  weatherClockMs,
  type WeatherState,
  type WeatherVisionSources,
} from './weather.js';
import { CELL_SIZE_TILES, type WorldState } from './world.js';

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

/** Alpha multiplier applied to forecast-layer sprites so the +1-cycle
 *  ahead lookahead reads as a "preview" rather than the current state.
 *  0.5 was tuned against the existing STATE_TINT alphas (0.18-0.6) so a
 *  forecast storm draws at ~0.16 final alpha — clearly visible without
 *  competing with the live cell tint underneath. */
export const FORECAST_ALPHA_MULTIPLIER = 0.5;

export interface WeatherOverlayHandle {
  /** Render layer to add to the world container, above islands so the tint
   *  reads over land and sea both. */
  readonly layer: Container;
  /** Repaint the overlay if enough time has passed since the last rebuild.
   *  Cheap when within the throttle window — single timestamp compare.
   *  `getVisionSources` is invoked at each rebuild so a freshly-placed
   *  Weather Station / Advanced Weather Station / new populated island
   *  extends weather visibility on the next refresh.
   *
   *  `wallOffsetMs` is the §15.1 wall anchor (`weatherClockMs`): the
   *  throttle compares perf-domain `nowMs`, but every weather SAMPLE is
   *  taken at `nowMs + wallOffsetMs` so the tint agrees with the
   *  simulation's wall-anchored vehicle / route consumers. */
  refresh(nowMs: number, getVisionSources: () => WeatherVisionSources, wallOffsetMs?: number): void;
  /** Force a rebuild on the next frame — call after a populated island
   *  flips, a Weather Station is placed/demolished, etc. */
  invalidate(): void;
}

export function mountWeatherOverlay(world: WorldState): WeatherOverlayHandle {
  const layer = new Container();
  layer.label = 'weather-overlay';
  let lastRebuildMs = -Infinity;
  let dirty = true;

  /** Draw one cell's tinted sprite at world-pixel position. Factored out so
   *  the current-cycle and forecast passes share the geometry. */
  const drawCell = (
    cellX: number,
    cellY: number,
    state: WeatherState,
    alphaScale: number,
  ): void => {
    const tint = STATE_TINT[state];
    if (!tint) return;
    const sprite = new Sprite(getCellTexture());
    sprite.width = CELL_PX;
    sprite.height = CELL_PX;
    sprite.tint = tint.color;
    sprite.alpha = tint.alpha * alphaScale;
    sprite.position.set(cellX * CELL_PX, cellY * CELL_PX);
    layer.addChild(sprite);
  };

  const rebuild = (nowMs: number, sources: WeatherVisionSources, wallOffsetMs: number): void => {
    for (const c of layer.removeChildren()) c.destroy(true);
    const totalCo2Kg = sumIslandCo2(world);
    // §15.1: weather samples are wall-anchored; the throttle bookkeeping
    // below stays in the perf domain (`nowMs`).
    const sampleMs = weatherClockMs(nowMs, wallOffsetMs);
    // 1) Current-cycle layer — every cell intersecting ocean ellipses or
    //    per-island weather circles.
    const currentCells = visibleCellsFromVision(sources.current);
    for (const key of currentCells) {
      const idx = key.indexOf(',');
      const cellX = Number(key.slice(0, idx));
      const cellY = Number(key.slice(idx + 1));
      const biome = biomeForCell(world, cellX, cellY);
      const w = weather(world.seed, cellX, cellY, sampleMs, biome, totalCo2Kg);
      drawCell(cellX, cellY, w.state, 1);
    }
    // 2) Forecast layer — only islands carrying an Advanced Weather Station
    //    emit sources here. Sample the weather model at `sampleMs +
    //    LOOKAHEAD` and stamp the cell at reduced alpha so the live tint
    //    underneath stays the dominant read.
    if (sources.forecast.length > 0) {
      const forecastCells = visibleCellsFromVision(sources.forecast);
      const forecastMs = sampleMs + WEATHER_FORECAST_LOOKAHEAD_MS;
      for (const key of forecastCells) {
        const idx = key.indexOf(',');
        const cellX = Number(key.slice(0, idx));
        const cellY = Number(key.slice(idx + 1));
        const biome = biomeForCell(world, cellX, cellY);
        const w = weather(world.seed, cellX, cellY, forecastMs, biome, totalCo2Kg);
        drawCell(cellX, cellY, w.state, FORECAST_ALPHA_MULTIPLIER);
      }
    }
    lastRebuildMs = nowMs;
    dirty = false;
  };

  return {
    layer,
    refresh(nowMs: number, getVisionSources: () => WeatherVisionSources, wallOffsetMs: number = 0): void {
      if (!dirty && nowMs - lastRebuildMs < WEATHER_OVERLAY_REBUILD_MS) return;
      rebuild(nowMs, getVisionSources(), wallOffsetMs);
    },
    invalidate(): void {
      dirty = true;
    },
  };
}
