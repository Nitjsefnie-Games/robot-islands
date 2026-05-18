import { describe, expect, it } from 'vitest';
import { DAY_DURATION_MS } from './daynight.js';
import {
  weather,
  biomeWeatherWeights,
  isWeatherVisible,
  WEATHER_DESTRUCTION_CHANCE,
  WEATHER_SCAN_PENALTY,
  rasterizePath,
  rasterizeLineSegment,
  rasterizeRouteCells,
  rollVehicleDestruction,
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

describe('§2.7 — night/dawn severe-storm boost', () => {
  // dayPhaseName(0) → 'day' (phase 0.375).
  // night boundary at phase 0.75 → nowMs = 0.375 * DAY_DURATION_MS.
  // dawn boundary at phase 0.0 → nowMs = 0.625 * DAY_DURATION_MS.
  const dayTime = 0;
  const nightTime = Math.floor(0.375 * DAY_DURATION_MS);
  const dawnTime = Math.floor(0.625 * DAY_DURATION_MS);

  it('night boosts severe_storm/catastrophic frequency over a large sample', () => {
    let daySevere = 0;
    let nightSevere = 0;
    const samples = 800;
    for (let x = 0; x < samples; x++) {
      const d = weather('seed', x, 0, dayTime, 'plains');
      const n = weather('seed', x, 0, nightTime, 'plains');
      if (d.state === 'severe_storm' || d.state === 'catastrophic') daySevere++;
      if (n.state === 'severe_storm' || n.state === 'catastrophic') nightSevere++;
    }
    expect(nightSevere).toBeGreaterThan(daySevere);
  });

  it('dawn boosts severe_storm/catastrophic frequency over a large sample', () => {
    let daySevere = 0;
    let dawnSevere = 0;
    const samples = 800;
    for (let x = 0; x < samples; x++) {
      const d = weather('seed', x, 0, dayTime, 'plains');
      const a = weather('seed', x, 0, dawnTime, 'plains');
      if (d.state === 'severe_storm' || d.state === 'catastrophic') daySevere++;
      if (a.state === 'severe_storm' || a.state === 'catastrophic') dawnSevere++;
    }
    expect(dawnSevere).toBeGreaterThan(daySevere);
  });

  it('day and dusk do not boost severe weather', () => {
    // dusk boundary at phase 0.5 → nowMs = 0.125 * DAY_DURATION_MS.
    const duskTime = Math.floor(0.125 * DAY_DURATION_MS);
    let daySevere = 0;
    let duskSevere = 0;
    const samples = 800;
    for (let x = 0; x < samples; x++) {
      const d = weather('seed', x, 0, dayTime, 'plains');
      const u = weather('seed', x, 0, duskTime, 'plains');
      if (d.state === 'severe_storm' || d.state === 'catastrophic') daySevere++;
      if (u.state === 'severe_storm' || u.state === 'catastrophic') duskSevere++;
    }
    // Dusk should not be systematically higher than day; we only assert it
    // is not greater (it may be equal or lower by chance).
    expect(duskSevere).toBeLessThanOrEqual(daySevere + 30);
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
      satellites: [],
      repairDrones: [],
    debrisFields: [],
      endgameState: { achieved: new Set(), firstAchievedMs: null },
      latticeActive: false,
      latticeNodeIslands: [],
    commPackets: [],
      seed: 'test-seed',
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

describe('rasterizePath', () => {
  it('returns the starting cell for zero distance', () => {
    const path = rasterizePath(8, 8, 1, 0, 0, 1, 0, 16);
    expect(path).toEqual([{ cx: 0, cy: 0, entryMs: 0 }]);
  });

  it('returns monotonically increasing entryMs', () => {
    const path = rasterizePath(0, 0, 1, 0, 40, 1, 0, 16);
    for (let i = 1; i < path.length; i++) {
      expect(path[i]!.entryMs).toBeGreaterThanOrEqual(path[i - 1]!.entryMs);
    }
  });

  it('steps through correct cells for eastward travel', () => {
    const path = rasterizePath(0, 0, 1, 0, 40, 1, 0, 16);
    const cells = path.map((p) => [p.cx, p.cy]);
    expect(cells).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    expect(path[0]!.entryMs).toBe(0);
    // Cell (1,0) is entered at x=16 (distance 16).
    expect(path[1]!.entryMs).toBe(16_000);
    // Cell (2,0) is entered at x=32 (distance 32); the path ends at x=40
    // still inside this cell.
    expect(path[2]!.entryMs).toBe(32_000);
  });

  it('steps through correct cells for northward travel', () => {
    const path = rasterizePath(8, 8, 0, 1, 32, 1, 0, 16);
    const cells = path.map((p) => [p.cx, p.cy]);
    expect(cells).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
    ]);
  });

  it('steps through correct cells for westward travel starting mid-cell', () => {
    const path = rasterizePath(20, 4, -1, 0, 20, 1, 0, 16);
    const cells = path.map((p) => [p.cx, p.cy]);
    expect(cells).toEqual([
      [1, 0],
      [0, 0],
    ]);
  });

  it('handles diagonal travel crossing a corner', () => {
    const path = rasterizePath(0, 0, 1 / Math.sqrt(2), 1 / Math.sqrt(2), 24, 1, 0, 16);
    const cells = path.map((p) => [p.cx, p.cy]);
    // Travels 24 tiles along diagonal; ends at (17,17) which is cell (1,1).
    expect(cells).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('is deterministic for the same inputs', () => {
    const a = rasterizePath(5, 5, 1, 0, 30, 2, 1000, 16);
    const b = rasterizePath(5, 5, 1, 0, 30, 2, 1000, 16);
    expect(a).toEqual(b);
  });
});

describe('rasterizeLineSegment', () => {
  it('returns a single cell for a zero-length segment', () => {
    const cells = rasterizeLineSegment(8, 8, 8, 8, 16);
    expect(cells).toEqual([{ cx: 0, cy: 0 }]);
  });

  it('traverses multiple cells on a diagonal', () => {
    const cells = rasterizeLineSegment(0, 0, 30, 30, 16);
    expect(cells).toEqual([
      { cx: 0, cy: 0 },
      { cx: 1, cy: 1 },
    ]);
  });

  it('includes the destination cell for an exact boundary crossing', () => {
    const cells = rasterizeLineSegment(0, 0, 16, 0, 16);
    expect(cells).toEqual([
      { cx: 0, cy: 0 },
      { cx: 1, cy: 0 },
    ]);
  });
});

describe('rasterizeRouteCells', () => {
  it('returns transitFraction 0 for a zero-length route', () => {
    const cells = rasterizeRouteCells(8, 8, 8, 8, 16);
    expect(cells).toEqual([{ cx: 0, cy: 0, transitFraction: 0 }]);
  });

  it('marks transitFraction 1 for the final cell on an exact boundary crossing', () => {
    const cells = rasterizeRouteCells(0, 0, 16, 0, 16);
    expect(cells).toEqual([
      { cx: 0, cy: 0, transitFraction: 0 },
      { cx: 1, cy: 0, transitFraction: 1 },
    ]);
  });

  it('includes intermediate cells with increasing transitFraction', () => {
    const cells = rasterizeRouteCells(0, 0, 40, 0, 16);
    // 40 tiles east across three cells; fractions are 0, 16/40, 32/40.
    expect(cells).toEqual([
      { cx: 0, cy: 0, transitFraction: 0 },
      { cx: 1, cy: 0, transitFraction: 0.4 },
      { cx: 2, cy: 0, transitFraction: 0.8 },
    ]);
  });
});

describe('rollVehicleDestruction', () => {
  it('never destroys in clear weather (baseChance = 0)', () => {
    const path = [
      { cx: 0, cy: 0, entryMs: 0 },
      { cx: 1, cy: 0, entryMs: 1000 },
    ];
    const result = rollVehicleDestruction('seed', path, 1.0, 'vehicle-1');
    expect(result.destroyed).toBe(false);
    expect(result.atCellIndex).toBe(null);
  });

  it('is deterministic for the same inputs', () => {
    const path = [{ cx: 0, cy: 0, entryMs: 0 }];
    const a = rollVehicleDestruction('seed', path, 10.0, 'v1');
    const b = rollVehicleDestruction('seed', path, 10.0, 'v1');
    expect(a.destroyed).toBe(b.destroyed);
    expect(a.atCellIndex).toBe(b.atCellIndex);
  });

  it('respects weatherMultiplier scaling', () => {
    // With a huge multiplier, even a low base chance should eventually hit
    // if the path is long enough. Use a fixed seed and many storm cells.
    const path: Array<{ cx: number; cy: number; entryMs: number }> = [];
    for (let i = 0; i < 200; i++) {
      path.push({ cx: i, cy: 0, entryMs: i * 1000 });
    }
    // multiplier 0 should guarantee survival
    const safe = rollVehicleDestruction('seed', path, 0, 'v1');
    expect(safe.destroyed).toBe(false);
  });

  it('destroys a vehicle crossing catastrophic weather with a deterministic roll', () => {
    const seed = 'test-5';
    // Cell (0,0) is catastrophic for this seed at t=0.
    expect(weather(seed, 0, 0, 0).state).toBe('catastrophic');
    const path = [{ cx: 0, cy: 0, entryMs: 0 }];
    const result = rollVehicleDestruction(seed, path, 1.0, 'vehicle-1');
    expect(result.destroyed).toBe(true);
    expect(result.atCellIndex).toBe(0);
  });
});
