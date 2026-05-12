import { describe, expect, it } from 'vitest';
import {
  weather,
  biomeWeatherWeights,
  isWeatherVisible,
  WEATHER_DESTRUCTION_CHANCE,
  WEATHER_SCAN_PENALTY,
} from './weather.js';
import type { WorldState } from './world.js';

describe('weather determinism', () => {
  it('returns the same result for the same inputs', () => {
    const a = weather('seed', 10, 20, 3_600_000);
    const b = weather('seed', 10, 20, 3_600_000);
    expect(a.state).toBe(b.state);
    expect(a.sinceMs).toBe(b.sinceMs);
    expect(a.untilMs).toBe(b.untilMs);
  });

  it('returns different results for different cell coordinates', () => {
    const a = weather('seed', 10, 20, 3_600_000);
    const b = weather('seed', 10, 21, 3_600_000);
    expect(a.state !== b.state || a.sinceMs !== b.sinceMs || a.untilMs !== b.untilMs).toBe(true);
  });
});

describe('biomeWeatherWeights', () => {
  it('volcanic boosts storm and severe_storm weights', () => {
    const volcanic = biomeWeatherWeights('volcanic');
    const plains = biomeWeatherWeights('plains');

    const vStorm = volcanic.filter((e) => e.state === 'storm').reduce((s, e) => s + e.weight, 0);
    const pStorm = plains.filter((e) => e.state === 'storm').reduce((s, e) => s + e.weight, 0);
    expect(vStorm).toBeGreaterThan(pStorm);

    const vSevere = volcanic
      .filter((e) => e.state === 'severe_storm')
      .reduce((s, e) => s + e.weight, 0);
    const pSevere = plains
      .filter((e) => e.state === 'severe_storm')
      .reduce((s, e) => s + e.weight, 0);
    expect(vSevere).toBeGreaterThan(pSevere);
  });

  it('desert reduces storm and fog weights', () => {
    const desert = biomeWeatherWeights('desert');
    const plains = biomeWeatherWeights('plains');

    const dStorm = desert.filter((e) => e.state === 'storm').reduce((s, e) => s + e.weight, 0);
    const pStorm = plains.filter((e) => e.state === 'storm').reduce((s, e) => s + e.weight, 0);
    expect(dStorm).toBeLessThan(pStorm);

    const dFog = desert.filter((e) => e.state === 'light_fog').reduce((s, e) => s + e.weight, 0);
    const pFog = plains.filter((e) => e.state === 'light_fog').reduce((s, e) => s + e.weight, 0);
    expect(dFog).toBeLessThan(pFog);
  });

  it('volcanic has more storms than plains over a large sample', () => {
    let volcanicStorms = 0;
    let plainsStorms = 0;
    const samples = 500;
    for (let x = 0; x < samples; x++) {
      const v = weather('seed', x, 0, 3_600_000, 'volcanic');
      const p = weather('seed', x, 0, 3_600_000, 'plains');
      if (v.state === 'storm' || v.state === 'severe_storm' || v.state === 'catastrophic') {
        volcanicStorms++;
      }
      if (p.state === 'storm' || p.state === 'severe_storm' || p.state === 'catastrophic') {
        plainsStorms++;
      }
    }
    expect(volcanicStorms).toBeGreaterThan(plainsStorms);
  });
});

describe('isWeatherVisible', () => {
  function makeWorld(islands: WorldState['islands']): WorldState {
    return {
      islands,
      drones: [],
      routes: [],
      vehicles: [],
      revealedCells: new Set(),
    };
  }

  it('returns true for points within base visibility of a populated island', () => {
    const world = makeWorld([
      {
        id: 'home',
        name: 'home',
        biome: 'plains',
        cx: 0,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: [],
        modifiers: [],
      },
    ]);
    expect(isWeatherVisible(world, 0, 0)).toBe(true);
    expect(isWeatherVisible(world, 4, 0)).toBe(true);
    expect(isWeatherVisible(world, 5, 0)).toBe(true);
    expect(isWeatherVisible(world, 6, 0)).toBe(false);
  });

  it('returns false for unpopulated islands', () => {
    const world = makeWorld([
      {
        id: 'discovered',
        name: 'discovered',
        biome: 'plains',
        cx: 0,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: false,
        discovered: true,
        buildings: [],
        modifiers: [],
      },
    ]);
    expect(isWeatherVisible(world, 0, 0)).toBe(false);
  });

  it('extends range with weather stations', () => {
    const world = makeWorld([
      {
        id: 'home',
        name: 'home',
        biome: 'plains',
        cx: 0,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: [{ id: 'ws1', defId: 'weather_station_t2', x: 0, y: 0 }],
        modifiers: [],
      },
    ]);
    expect(isWeatherVisible(world, 8, 0)).toBe(true);
    expect(isWeatherVisible(world, 9, 0)).toBe(false);
  });

  it('extends range with advanced weather station', () => {
    const world = makeWorld([
      {
        id: 'home',
        name: 'home',
        biome: 'plains',
        cx: 0,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: [{ id: 'aws1', defId: 'advanced_weather_station_t3', x: 0, y: 0 }],
        modifiers: [],
      },
    ]);
    expect(isWeatherVisible(world, 11, 0)).toBe(true);
    expect(isWeatherVisible(world, 12, 0)).toBe(false);
  });

  it('stacks multiple weather stations', () => {
    const world = makeWorld([
      {
        id: 'home',
        name: 'home',
        biome: 'plains',
        cx: 0,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: [
          { id: 'ws1', defId: 'weather_station_t2', x: 0, y: 0 },
          { id: 'aws1', defId: 'advanced_weather_station_t3', x: 2, y: 0 },
        ],
        modifiers: [],
      },
    ]);
    expect(isWeatherVisible(world, 14, 0)).toBe(true);
    expect(isWeatherVisible(world, 15, 0)).toBe(false);
  });
});

describe('weather constants', () => {
  it('destruction chance increases with severity', () => {
    expect(WEATHER_DESTRUCTION_CHANCE.clear).toBe(0);
    expect(WEATHER_DESTRUCTION_CHANCE.light_fog).toBe(0);
    expect(WEATHER_DESTRUCTION_CHANCE.storm).toBe(0.02);
    expect(WEATHER_DESTRUCTION_CHANCE.severe_storm).toBe(0.08);
    expect(WEATHER_DESTRUCTION_CHANCE.catastrophic).toBe(0.2);
  });

  it('scan penalty increases with severity', () => {
    expect(WEATHER_SCAN_PENALTY.clear).toBe(0);
    expect(WEATHER_SCAN_PENALTY.light_fog).toBe(0.5);
    expect(WEATHER_SCAN_PENALTY.storm).toBe(0.25);
    expect(WEATHER_SCAN_PENALTY.severe_storm).toBe(0.75);
    expect(WEATHER_SCAN_PENALTY.catastrophic).toBe(1.0);
  });
});
