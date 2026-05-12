import { makeSeededRng } from './rng.js';
import type { Biome, WorldState } from './world.js';

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

export function weather(
  seed: string,
  cx: number,
  cy: number,
  nowMs: number,
  biome?: Biome,
): WeatherCell {
  const rng = makeSeededRng(`${seed}_weather_${cx}_${cy}`);
  const weights = biome ? biomeWeatherWeights(biome) : BASE_WEIGHTS;
  let t = 0;
  const MAX_ITERATIONS = 1_000_000;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
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

const BASE_VISIBILITY_TILES = 5;

export function isWeatherVisible(world: WorldState, cx: number, cy: number): boolean {
  for (const island of world.islands) {
    if (!island.populated) continue;
    const dx = island.cx - cx;
    const dy = island.cy - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    let range = BASE_VISIBILITY_TILES;
    for (const b of island.buildings) {
      if (b.defId === 'weather_station_t2') {
        range += 3;
      } else if (b.defId === 'advanced_weather_station_t3') {
        range += 6;
      }
    }
    if (dist <= range) return true;
  }
  return false;
}
