import { CELL_SIZE_TILES } from './constants.js';
import { dayPhaseName } from './daynight.js';
import { makeSeededRng } from './rng.js';
import type { VisionSource } from './vision-source.js';
import {
  VISION_PADDING_TILES,
  islandConstituents,
  type Biome,
  type IslandSpec,
  type WorldState,
} from './world.js';

export type WeatherState = 'clear' | 'light_fog' | 'storm' | 'severe_storm' | 'catastrophic';

export interface WeatherCell {
  readonly state: WeatherState;
  readonly sinceMs: number;
  readonly untilMs: number;
}

export const WEATHER_DESTRUCTION_CHANCE: Record<WeatherState, number> = {
  clear: 0,
  light_fog: 0,
  storm: 0.02,
  severe_storm: 0.08,
  catastrophic: 0.20,
};

export const WEATHER_SCAN_PENALTY: Record<WeatherState, number> = {
  clear: 0,
  light_fog: 0.50,
  storm: 0.25,
  severe_storm: 0.75,
  catastrophic: 1.0,
};

export const WEATHER_ROUTE_LOSS_RATE: Record<WeatherState, number> = {
  clear: 0,
  light_fog: 0,
  storm: 0.05,
  severe_storm: 0.15,
  catastrophic: 0.30,
};

export const WEATHER_ROUTE_CAPACITY_MULTIPLIER: Record<WeatherState, number> = {
  clear: 1,
  light_fog: 1,
  storm: 0.5,
  severe_storm: 0.1,
  catastrophic: 0,
};

const MIN_DWELL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_DWELL_MS = 4 * 60 * 60 * 1000; // 4 hours

interface WeightEntry {
  state: WeatherState;
  weight: number;
}

const BASE_WEIGHTS: ReadonlyArray<WeightEntry> = [
  { state: 'clear', weight: 40 },
  { state: 'clear', weight: 20 },
  { state: 'clear', weight: 15 },
  { state: 'light_fog', weight: 10 },
  { state: 'storm', weight: 8 },
  { state: 'severe_storm', weight: 4 },
  { state: 'catastrophic', weight: 1 },
];

export function biomeWeatherWeights(biome: Biome): ReadonlyArray<WeightEntry> {
  const mutable: WeightEntry[] = BASE_WEIGHTS.map((e) => ({ state: e.state, weight: e.weight }));
  switch (biome) {
    case 'volcanic':
      for (const e of mutable) {
        if (e.state === 'storm' || e.state === 'severe_storm') {
          e.weight *= 1.5;
        }
      }
      break;
    case 'arctic':
      for (const e of mutable) {
        if (e.state === 'severe_storm') {
          e.weight *= 1.3;
        }
      }
      break;
    case 'coast':
      for (const e of mutable) {
        if (e.state === 'light_fog') {
          e.weight *= 1.5;
        } else if (e.state === 'storm') {
          e.weight *= 1.2;
        }
      }
      break;
    case 'desert':
      for (const e of mutable) {
        if (e.state === 'storm') {
          e.weight *= 0.3;
        } else if (e.state === 'light_fog') {
          e.weight *= 0.5;
        }
      }
      break;
    case 'forest':
      for (const e of mutable) {
        if (e.state === 'storm') {
          e.weight *= 1.1;
        }
      }
      break;
    case 'plains':
      break;
    default: {
      const _exhaustive: never = biome;
      void _exhaustive;
    }
  }
  return mutable;
}

function sampleState(weights: ReadonlyArray<WeightEntry>, rng: () => number): WeatherState {
  let total = 0;
  for (const e of weights) total += e.weight;
  let r = rng() * total;
  for (const e of weights) {
    r -= e.weight;
    if (r <= 0) return e.state;
  }
  const last = weights[weights.length - 1];
  return last?.state ?? 'clear';
}

/** §7.3: CO₂-band multiplier on storm-weight summing.
 *  Bands: <100kg = 1.0; <10t = 1.1; <100t = 1.3; ≥100t = 1.6 (crisis). */
export function co2WeatherMultiplier(totalCo2Kg: number): number {
  if (totalCo2Kg < 100) return 1.0;
  if (totalCo2Kg < 10_000) return 1.1;
  if (totalCo2Kg < 100_000) return 1.3;
  return 1.6;
}

/** §7.4 Heatwave roll. Returns 'heatwave' state or null based on CO₂ threshold + RNG.
 *  Bands: <10t = always null; ≥10t = ~5% per dwell; deterministic by (seed, day).  */
export function rollHeatwave(seed: string, day: number, totalCo2Kg: number): 'heatwave' | null {
  if (totalCo2Kg < 10_000) return null;
  const rng = makeSeededRng(`${seed}::heatwave::${day}`);
  return (rng() < 0.05) ? 'heatwave' : null;
}

export function sumIslandCo2(world: { islandStates?: Map<string, { co2Kg?: number }> }): number {
  let sum = 0;
  if (world.islandStates) {
    for (const [, state] of world.islandStates) {
      sum += state.co2Kg ?? 0;
    }
  }
  return sum;
}

export function weather(
  seed: string,
  cx: number,
  cy: number,
  nowMs: number,
  biome?: Biome,
  totalCo2Kg: number = 0,
): WeatherCell {
  const rng = makeSeededRng(`${seed}_weather_${cx}_${cy}`);
  const baseWeights = biome ? biomeWeatherWeights(biome) : BASE_WEIGHTS;
  let t = 0;
  const MAX_ITERATIONS = 1_000_000;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // §2.7: severe-storm formation rate increases ~25% during Night and Dawn.
    // Determine the phase at the START of this interval so boosted weights
    // only apply to intervals that actually fall in night/dawn, preserving
    // historical determinism.
    const phase = dayPhaseName(t);
    let weights: ReadonlyArray<WeightEntry> = baseWeights;
    if (phase === 'night' || phase === 'dawn') {
      const mutable: WeightEntry[] = baseWeights.map((e) => ({ state: e.state, weight: e.weight }));
      for (const e of mutable) {
        if (e.state === 'severe_storm' || e.state === 'catastrophic') {
          e.weight *= 1.25;
        }
      }
      weights = mutable;
    }
    const co2Mul = co2WeatherMultiplier(totalCo2Kg);
    if (co2Mul !== 1.0) {
      const mutable: WeightEntry[] = weights.map((e) => ({ state: e.state, weight: e.weight }));
      for (const e of mutable) {
        if (e.state === 'storm' || e.state === 'severe_storm' || e.state === 'catastrophic') {
          e.weight *= co2Mul;
        }
      }
      weights = mutable;
    }
    const dwell = MIN_DWELL_MS + Math.floor(rng() * (MAX_DWELL_MS - MIN_DWELL_MS + 1));
    const state = sampleState(weights, rng);
    const until = t + dwell;
    if (nowMs < until) {
      return { state, sinceMs: t, untilMs: until };
    }
    t = until;
  }
  return { state: 'clear', sinceMs: nowMs, untilMs: nowMs + MIN_DWELL_MS };
}

/** Baseline weather visibility radius around any populated island, in tile
 *  units. SPEC §2.6 calls this `R_weather` and quotes "5 cells" as a
 *  placeholder; the implementation uses tile units throughout the vision
 *  graph (matches `BASE_VISIBILITY_TILES` semantics and ocean-padding
 *  conventions in `lighthouse.ts`). */
export const BASE_WEATHER_VISIBILITY_TILES = 5;

/** Per-defId weather visibility range bonus in tile units (§2.6). Mirrors
 *  the `LIGHTHOUSE_VISION_RADII` table in `lighthouse.ts`. Bonuses STACK
 *  additively (multiple stations on one island sum) per the pre-existing
 *  pinned test surface — see `weather.test.ts` "stacks multiple weather
 *  stations". */
export const WEATHER_STATION_RANGE_BONUS_TILES: Readonly<Record<string, number>> = {
  weather_station_t2: 3,
  advanced_weather_station_t3: 6,
};

/** Defs whose presence on an island unlocks the §2.6 1-cycle-ahead
 *  forecast overlay. Only Advanced Weather Station today; Scanner Sat
 *  forecast is wired separately through `satellite-overlay.ts`. */
const FORECAST_DEF_IDS: ReadonlySet<string> = new Set(['advanced_weather_station_t3']);

/** Lookahead used by §2.6 "1-cycle ahead" Advanced Weather Station
 *  forecasting. The weather model has no fixed cycle (dwell varies
 *  30 min – 4 h, see `MIN_DWELL_MS` / `MAX_DWELL_MS`); we sample at the
 *  arithmetic midpoint (~2 h) so the forecast lands one typical dwell
 *  ahead of `nowMs`. */
export const WEATHER_FORECAST_LOOKAHEAD_MS = 2 * 60 * 60 * 1000;

/** Look up the biome for a cell, if a populated-or-not island's centre lies
 *  exactly in that cell. When no island matches, `weather()` falls back to
 *  the Plains baseline (the `biome === undefined` branch). Used by both the
 *  visual overlay (`weather-overlay.ts`) and the hover-tooltip readout
 *  (`hover-tooltip.ts`) — same logic, single source of truth. Pure. */
export function biomeForCell(
  world: Pick<WorldState, 'islands'>,
  cellX: number,
  cellY: number,
): IslandSpec['biome'] | undefined {
  for (const isl of world.islands) {
    if (Math.floor(isl.cx / CELL_SIZE_TILES) === cellX && Math.floor(isl.cy / CELL_SIZE_TILES) === cellY) {
      return isl.biome;
    }
  }
  return undefined;
}

/** Sum of station bonuses on an island, in tiles. Walks the spec's
 *  building array and uses `WEATHER_STATION_RANGE_BONUS_TILES`. Pure. */
export function weatherStationRangeBonusTiles(spec: IslandSpec): number {
  let bonus = 0;
  for (const b of spec.buildings) {
    const add = WEATHER_STATION_RANGE_BONUS_TILES[b.defId];
    if (add !== undefined) bonus += add;
  }
  return bonus;
}

/** True iff this island has at least one §2.6 forecast-capable station
 *  (Advanced Weather Station). Pure. */
export function hasForecastStation(spec: IslandSpec): boolean {
  for (const b of spec.buildings) {
    if (FORECAST_DEF_IDS.has(b.defId)) return true;
  }
  return false;
}

export function isWeatherVisible(world: WorldState, cx: number, cy: number): boolean {
  for (const island of world.islands) {
    if (!island.populated) continue;
    const dx = island.cx - cx;
    const dy = island.cy - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const range = BASE_WEATHER_VISIBILITY_TILES + weatherStationRangeBonusTiles(island);
    if (dist <= range) return true;
  }
  return false;
}

/**
 * §2.6 — build the vision-source set used by the weather overlay. Distinct
 * from `computeVisionSources` (ocean + Lighthouse) because:
 *
 *   1. Weather has its own per-island baseline (R_weather = 5 tiles)
 *      independent of the ocean's `VISION_PADDING_TILES = 10`.
 *   2. Weather Stations (T2 +3, T3 +6) extend it; Lighthouses do NOT.
 *   3. The Advanced Weather Station also unlocks a separate `forecast`
 *      circle for the same radius, sampled at `nowMs + LOOKAHEAD`.
 *
 * The returned object has parallel arrays:
 *
 *   - `current` — sources used to determine which cells render at
 *      `nowMs`. Includes the ocean ellipse for each constituent (so the
 *      ocean-padded halo also reveals weather, matching the pre-existing
 *      docstring intent) plus a per-island weather-station circle.
 *   - `forecast` — sources used to determine which cells render the
 *      lookahead layer. Only emitted for islands with a forecast-capable
 *      station; ocean ellipses are NOT included here (the +1-cycle bonus
 *      is exclusively the station's gift).
 *
 * Pure — no PixiJS, no DOM, no mutations.
 */
export interface WeatherVisionSources {
  readonly current: ReadonlyArray<VisionSource>;
  readonly forecast: ReadonlyArray<VisionSource>;
}

export function computeWeatherVisionSources(
  populated: ReadonlyArray<IslandSpec>,
): WeatherVisionSources {
  const current: VisionSource[] = [];
  const forecast: VisionSource[] = [];
  for (const spec of populated) {
    // 1) Ocean-equivalent ellipses — keeps the overlay aligned with the
    //    visible water around the coast, matching the prior behaviour
    //    where the overlay piggybacked on `computeVisionSources`.
    for (const c of islandConstituents(spec)) {
      current.push({
        kind: 'ellipse',
        cx: spec.cx,
        cy: spec.cy,
        major: c.major + VISION_PADDING_TILES,
        minor: c.minor + VISION_PADDING_TILES,
        offsetX: c.offsetX,
        offsetY: c.offsetY,
      });
    }
    // 2) Per-island weather circle: baseline + station stack.
    const stationBonus = weatherStationRangeBonusTiles(spec);
    const radius = BASE_WEATHER_VISIBILITY_TILES + stationBonus;
    current.push({
      kind: 'circle',
      cx: spec.cx,
      cy: spec.cy,
      radius,
    });
    // 3) Forecast circle (Advanced Weather Station only). Same radius as
    //    the current-cycle circle — the station unlocks a temporal lookup,
    //    not a wider spatial range.
    if (hasForecastStation(spec)) {
      forecast.push({
        kind: 'circle',
        cx: spec.cx,
        cy: spec.cy,
        radius,
      });
    }
  }
  return { current, forecast };
}

/** DDA line rasterization for vehicle paths. Shares core DDA logic with
 *  `lineSegmentCells` (used by `rasterizeLineSegment`/`rasterizeRouteCells`);
 *  keep the two in sync if the stepping algorithm changes. */
export function rasterizePath(
  originX: number,
  originY: number,
  dirX: number,
  dirY: number,
  totalTiles: number,
  speedTilesPerSec: number,
  launchTimeMs: number,
  cellSizeTiles: number,
): Array<{ cx: number; cy: number; entryMs: number }> {
  const result: Array<{ cx: number; cy: number; entryMs: number }> = [];

  if (totalTiles <= 0 || speedTilesPerSec <= 0) {
    result.push({
      cx: Math.floor(originX / cellSizeTiles),
      cy: Math.floor(originY / cellSizeTiles),
      entryMs: launchTimeMs,
    });
    return result;
  }

  let cx = Math.floor(originX / cellSizeTiles);
  let cy = Math.floor(originY / cellSizeTiles);

  const stepX = Math.sign(dirX);
  const stepY = Math.sign(dirY);

  const tDeltaX = stepX !== 0 ? cellSizeTiles / Math.abs(dirX) : Infinity;
  const tDeltaY = stepY !== 0 ? cellSizeTiles / Math.abs(dirY) : Infinity;

  const nextBorderX = stepX > 0 ? (cx + 1) * cellSizeTiles : cx * cellSizeTiles;
  const nextBorderY = stepY > 0 ? (cy + 1) * cellSizeTiles : cy * cellSizeTiles;

  let tMaxX = stepX !== 0 ? (nextBorderX - originX) / dirX : Infinity;
  let tMaxY = stepY !== 0 ? (nextBorderY - originY) / dirY : Infinity;

  let dist = 0;
  result.push({ cx, cy, entryMs: launchTimeMs });

  while (dist < totalTiles) {
    let nextDist: number;
    let nextCx = cx;
    let nextCy = cy;

    if (tMaxX < tMaxY) {
      nextDist = tMaxX;
      nextCx = cx + stepX;
      nextCy = cy;
      tMaxX += tDeltaX;
    } else if (tMaxY < tMaxX) {
      nextDist = tMaxY;
      nextCx = cx;
      nextCy = cy + stepY;
      tMaxY += tDeltaY;
    } else {
      nextDist = tMaxX;
      nextCx = cx + stepX;
      nextCy = cy + stepY;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    }

    if (nextDist > totalTiles) break;

    if (nextDist === totalTiles) {
      dist = nextDist;
      break;
    }

    dist = nextDist;
    cx = nextCx;
    cy = nextCy;

    const last = result[result.length - 1];
    if (!last || last.cx !== cx || last.cy !== cy) {
      result.push({
        cx,
        cy,
        entryMs: launchTimeMs + (dist / speedTilesPerSec) * 1000,
      });
    }
  }

  const endX = originX + dirX * totalTiles;
  const endY = originY + dirY * totalTiles;
  const endCx = Math.floor(endX / cellSizeTiles);
  const endCy = Math.floor(endY / cellSizeTiles);
  const last = result[result.length - 1];
  if (last && (last.cx !== endCx || last.cy !== endCy)) {
    result.push({
      cx: endCx,
      cy: endCy,
      entryMs: launchTimeMs + (totalTiles / speedTilesPerSec) * 1000,
    });
  }

  return result;
}

export function rollVehicleDestruction(
  seed: string,
  path: Array<{ cx: number; cy: number; entryMs: number }>,
  weatherMultiplier: number,
  vehicleId: string,
): { destroyed: boolean; atCellIndex: number | null } {
  const rng = makeSeededRng(`${seed}_vehicle_${vehicleId}`);
  for (let i = 0; i < path.length; i++) {
    const { cx, cy, entryMs } = path[i]!;
    const cell = weather(seed, cx, cy, entryMs);
    const baseChance = WEATHER_DESTRUCTION_CHANCE[cell.state];
    if (baseChance === undefined || baseChance === 0) continue;
    const finalChance = baseChance * weatherMultiplier;
    if (rng() < finalChance) {
      return { destroyed: true, atCellIndex: i };
    }
  }
  return { destroyed: false, atCellIndex: null };
}

// ---------------------------------------------------------------------------
// Route rasterization + weather modulation §2.6
// ---------------------------------------------------------------------------

/** DDA line rasterization for route cells. Shares core DDA logic with
 *  `rasterizePath`; keep the two in sync if the stepping algorithm changes. */
function lineSegmentCells(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  cellSizeTiles: number,
): Array<{ cx: number; cy: number; transitFraction: number }> {
  const result: Array<{ cx: number; cy: number; transitFraction: number }> = [];

  const dx = toX - fromX;
  const dy = toY - fromY;
  const totalLen = Math.hypot(dx, dy);

  if (totalLen === 0) {
    result.push({
      cx: Math.floor(fromX / cellSizeTiles),
      cy: Math.floor(fromY / cellSizeTiles),
      transitFraction: 0,
    });
    return result;
  }

  const dirX = dx / totalLen;
  const dirY = dy / totalLen;

  let cx = Math.floor(fromX / cellSizeTiles);
  let cy = Math.floor(fromY / cellSizeTiles);

  const stepX = Math.sign(dirX);
  const stepY = Math.sign(dirY);

  const tDeltaX = stepX !== 0 ? cellSizeTiles / Math.abs(dirX) : Infinity;
  const tDeltaY = stepY !== 0 ? cellSizeTiles / Math.abs(dirY) : Infinity;

  const nextBorderX = stepX > 0 ? (cx + 1) * cellSizeTiles : cx * cellSizeTiles;
  const nextBorderY = stepY > 0 ? (cy + 1) * cellSizeTiles : cy * cellSizeTiles;

  let tMaxX = stepX !== 0 ? (nextBorderX - fromX) / dirX : Infinity;
  let tMaxY = stepY !== 0 ? (nextBorderY - fromY) / dirY : Infinity;

  let dist = 0;
  result.push({ cx, cy, transitFraction: 0 });

  while (dist < totalLen) {
    let nextDist: number;
    let nextCx = cx;
    let nextCy = cy;

    if (tMaxX < tMaxY) {
      nextDist = tMaxX;
      nextCx = cx + stepX;
      nextCy = cy;
      tMaxX += tDeltaX;
    } else if (tMaxY < tMaxX) {
      nextDist = tMaxY;
      nextCx = cx;
      nextCy = cy + stepY;
      tMaxY += tDeltaY;
    } else {
      nextDist = tMaxX;
      nextCx = cx + stepX;
      nextCy = cy + stepY;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    }

    if (nextDist > totalLen) break;
    if (nextDist === totalLen) {
      dist = nextDist;
      break;
    }

    dist = nextDist;
    cx = nextCx;
    cy = nextCy;

    const last = result[result.length - 1];
    if (!last || last.cx !== cx || last.cy !== cy) {
      result.push({ cx, cy, transitFraction: dist / totalLen });
    }
  }

  const endCx = Math.floor(toX / cellSizeTiles);
  const endCy = Math.floor(toY / cellSizeTiles);
  const last = result[result.length - 1];
  if (last && (last.cx !== endCx || last.cy !== endCy)) {
    result.push({ cx: endCx, cy: endCy, transitFraction: 1 });
  }

  return result;
}

/** Rasterize a line segment between two endpoints into stratification cells.
 *  Returns each unique cell once, in traversal order. */
export function rasterizeLineSegment(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  cellSizeTiles: number,
): Array<{ cx: number; cy: number }> {
  return lineSegmentCells(fromX, fromY, toX, toY, cellSizeTiles).map(({ cx, cy }) => ({ cx, cy }));
}

/** Same as `rasterizeLineSegment` but carries the transit fraction [0,1]
 *  at which the batch enters each cell. Used by `routes.ts` for per-cell
 *  weather-loss sampling. */
export function rasterizeRouteCells(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  cellSizeTiles: number,
): Array<{ cx: number; cy: number; transitFraction: number }> {
  return lineSegmentCells(fromX, fromY, toX, toY, cellSizeTiles);
}

/** Returns capacity multiplier [0,1] for a route crossing given cells at nowMs. */
export function routeCapacityMultiplierForWeather(
  seed: string,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  nowMs: number,
  cellSizeTiles: number,
): number {
  const cells = rasterizeLineSegment(fromX, fromY, toX, toY, cellSizeTiles);
  let minMul = 1;
  for (const { cx, cy } of cells) {
    const w = weather(seed, cx, cy, nowMs);
    const mul = WEATHER_ROUTE_CAPACITY_MULTIPLIER[w.state];
    if (mul !== undefined) minMul = Math.min(minMul, mul);
  }
  return minMul;
}
