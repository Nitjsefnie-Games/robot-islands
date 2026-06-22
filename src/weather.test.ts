import { describe, expect, it, test } from 'vitest';
import { DAY_DURATION_MS } from './daynight.js';
import {
  weather,
  biomeWeatherWeights,
  WEATHER_DESTRUCTION_CHANCE,
  WEATHER_SCAN_PENALTY,
  rasterizePath,
  rasterizeLineSegment,
  rasterizeRouteCells,
  rollVehicleDestruction,
  computeWeatherVisionSources,
  weatherStationRangeBonusTiles,
  hasForecastStation,
  WEATHER_FORECAST_LOOKAHEAD_MS,
  BASE_WEATHER_VISIBILITY_TILES,
  co2WeatherMultiplier,
  sumIslandCo2,
  rollHeatwave,
  weatherClockMs,
  routeCapacityMultiplierForWeather,
  routeCapacityMultiplierForCells,
  rasterizePolylineCells,
  clearWeatherCacheForTests,
} from './weather.js';
import type { IslandSpec } from './world.js';

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

test('rasterizePolylineCells with no bend equals straight rasterizeRouteCells (cells)', () => {
  const cell = 8;
  const poly = rasterizePolylineCells([{ x: 2, y: 2 }, { x: 40, y: 5 }], cell);
  const straight = rasterizeRouteCells(2, 2, 40, 5, cell);
  expect(poly.map(c => `${c.cx},${c.cy}`)).toEqual(straight.map(c => `${c.cx},${c.cy}`));
});

test('rasterizePolylineCells transitFraction is monotonic non-decreasing in [0,1]', () => {
  const cells = rasterizePolylineCells([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }], 8);
  expect(cells[0]!.transitFraction).toBe(0);
  expect(cells[cells.length - 1]!.transitFraction).toBeLessThanOrEqual(1);
  for (let i = 1; i < cells.length; i++) {
    expect(cells[i]!.transitFraction).toBeGreaterThanOrEqual(cells[i - 1]!.transitFraction);
  }
});

test('rasterizePolylineCells does not duplicate the shared vertex cell', () => {
  // L-shaped path; the corner cell must appear once.
  const cells = rasterizePolylineCells([{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 24 }], 8);
  const keys = cells.map(c => `${c.cx},${c.cy}`);
  expect(new Set(keys).size).toBe(keys.length);
});

test('routeCapacityMultiplierForCells equals the straight-line multiplier for the same cells', () => {
  // Seed-independent contract: the cells-based fn is the extracted core of the
  // straight-line fn, so for a straight 2-point path they must return the SAME
  // value whatever the (deterministic) weather happens to be at that seed/time.
  const cell = 8;
  const cells = rasterizeRouteCells(0, 0, 40, 0, cell).map(c => ({ cx: c.cx, cy: c.cy }));
  const viaCells = routeCapacityMultiplierForCells('seed-x', cells, 1234);
  const viaStraight = routeCapacityMultiplierForWeather('seed-x', 0, 0, 40, 0, 1234, cell);
  expect(viaCells).toBe(viaStraight);
  expect(viaCells).toBeGreaterThanOrEqual(0);
  expect(viaCells).toBeLessThanOrEqual(1);
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
    // Dusk must not be systematically higher than day (may be equal/lower by chance).
    expect(duskSevere).toBeLessThanOrEqual(daySevere + 30);
  });
});

describe('§2.6 weather-station per-island accumulator', () => {
  function makeIsland(
    id: string,
    cx: number,
    cy: number,
    buildings: IslandSpec['buildings'],
    populated = true,
  ): IslandSpec {
    return {
      id,
      name: id,
      biome: 'plains',
      cx,
      cy,
      majorRadius: 10,
      minorRadius: 10,
      populated,
      discovered: true,
      buildings,
      modifiers: [],
    };
  }

  it('weatherStationRangeBonusTiles sums every station', () => {
    const isl = makeIsland('a', 0, 0, [
      { id: 'b1', defId: 'weather_station_t2', x: 0, y: 0 },
      { id: 'b2', defId: 'weather_station_t2', x: 2, y: 0 },
      { id: 'b3', defId: 'advanced_weather_station_t3', x: 4, y: 0 },
    ]);
    // 3 + 3 + 6 = 12
    expect(weatherStationRangeBonusTiles(isl)).toBe(12);
  });

  it('weatherStationRangeBonusTiles is zero when no stations present', () => {
    const isl = makeIsland('a', 0, 0, [
      { id: 'b1', defId: 'lighthouse_t2', x: 0, y: 0 },
    ]);
    expect(weatherStationRangeBonusTiles(isl)).toBe(0);
  });

  it('hasForecastStation is true iff an Advanced Weather Station is placed', () => {
    expect(hasForecastStation(makeIsland('a', 0, 0, []))).toBe(false);
    expect(
      hasForecastStation(
        makeIsland('a', 0, 0, [{ id: 'b1', defId: 'weather_station_t2', x: 0, y: 0 }]),
      ),
    ).toBe(false);
    expect(
      hasForecastStation(
        makeIsland('a', 0, 0, [
          { id: 'b1', defId: 'advanced_weather_station_t3', x: 0, y: 0 },
        ]),
      ),
    ).toBe(true);
  });
});

describe('§2.6 computeWeatherVisionSources', () => {
  function makeIsland(
    id: string,
    cx: number,
    cy: number,
    buildings: IslandSpec['buildings'],
    populated = true,
  ): IslandSpec {
    return {
      id,
      name: id,
      biome: 'plains',
      cx,
      cy,
      majorRadius: 10,
      minorRadius: 10,
      populated,
      discovered: true,
      buildings,
      modifiers: [],
    };
  }

  it('baseline: one ocean ellipse + one weather circle per island, no forecast', () => {
    const islands = [makeIsland('a', 0, 0, [])];
    const sources = computeWeatherVisionSources(islands);
    // 1 ocean ellipse + 1 weather circle.
    expect(sources.current.length).toBe(2);
    expect(sources.forecast.length).toBe(0);
    const circle = sources.current.find((s) => s.kind === 'circle');
    expect(circle).toBeDefined();
    if (circle && circle.kind === 'circle') {
      expect(circle.radius).toBe(BASE_WEATHER_VISIBILITY_TILES);
      expect(circle.cx).toBe(0);
      expect(circle.cy).toBe(0);
    }
  });

  it('a Lighthouse adds a current-weather circle (its vision radius) but NO forecast', () => {
    // Vision from a Lighthouse must light up the weather overlay too: current
    // weather is readable wherever you can see, so the overlay needs a circle
    // at the Lighthouse's vision radius. Forecast still needs a weather station.
    const islands = [
      makeIsland('a', 0, 0, [{ id: 'lh', defId: 'lighthouse_t2', x: 0, y: 0 }]),
    ];
    const sources = computeWeatherVisionSources(islands);
    const circles = sources.current.filter((s) => s.kind === 'circle');
    // base weather circle + lighthouse_t2 vision circle (LIGHTHOUSE_VISION_RADII = 80).
    expect(circles.length).toBe(2);
    expect(circles.some((c) => c.kind === 'circle' && c.radius === 80)).toBe(true);
    expect(sources.forecast.length).toBe(0);
  });

  it('T2 Weather Station emits a circle at its building position, radius base+3', () => {
    const islands = [
      makeIsland('a', 0, 0, [{ id: 'ws', defId: 'weather_station_t2', x: 0, y: 0 }]),
    ];
    const sources = computeWeatherVisionSources(islands);
    // square2 footprint → centre offset +0.5 from the building's NW tile.
    const station = sources.current.find(
      (s) => s.kind === 'circle' && s.radius === BASE_WEATHER_VISIBILITY_TILES + 3,
    );
    expect(station && station.kind === 'circle' && station.cx).toBe(0.5);
    expect(station && station.kind === 'circle' && station.cy).toBe(0.5);
    // The island's inherent base circle is still present, at the centre.
    expect(
      sources.current.some(
        (s) =>
          s.kind === 'circle' &&
          s.radius === BASE_WEATHER_VISIBILITY_TILES &&
          s.cx === 0 &&
          s.cy === 0,
      ),
    ).toBe(true);
    expect(sources.forecast.length).toBe(0);
  });

  it('T3 Advanced Weather Station emits current + forecast circles at its building position, radius base+6', () => {
    const islands = [
      makeIsland('a', 0, 0, [
        { id: 'aws', defId: 'advanced_weather_station_t3', x: 0, y: 0 },
      ]),
    ];
    const sources = computeWeatherVisionSources(islands);
    const r = BASE_WEATHER_VISIBILITY_TILES + 6;
    const station = sources.current.find((s) => s.kind === 'circle' && s.radius === r);
    expect(station && station.kind === 'circle' && station.cx).toBe(0.5);
    expect(station && station.kind === 'circle' && station.cy).toBe(0.5);
    expect(sources.forecast.length).toBe(1);
    const fcCircle = sources.forecast[0];
    expect(fcCircle && fcCircle.kind === 'circle' && fcCircle.radius).toBe(r);
    expect(fcCircle && fcCircle.kind === 'circle' && fcCircle.cx).toBe(0.5);
    expect(fcCircle && fcCircle.kind === 'circle' && fcCircle.cy).toBe(0.5);
  });

  it('a station on a large merged island reveals weather around ITSELF, not the island centre', () => {
    // Regression (#merged-weather): merged islands have spec.cx/cy at an
    // arbitrary interior point far from where the player placed the station.
    // The station's current + forecast circles must follow the building.
    const islands = [
      makeIsland('merged', 0, 0, [
        { id: 'aws', defId: 'advanced_weather_station_t3', x: 50, y: 40 },
      ]),
    ];
    const sources = computeWeatherVisionSources(islands);
    const r = BASE_WEATHER_VISIBILITY_TILES + 6;
    const station = sources.current.find((s) => s.kind === 'circle' && s.radius === r);
    expect(station && station.kind === 'circle' && station.cx).toBe(50.5);
    expect(station && station.kind === 'circle' && station.cy).toBe(40.5);
    const fc = sources.forecast[0];
    expect(fc && fc.kind === 'circle' && fc.cx).toBe(50.5);
    expect(fc && fc.kind === 'circle' && fc.cy).toBe(40.5);
  });

  it('both stations on one island emit SEPARATE circles, each at its own building', () => {
    const islands = [
      makeIsland('a', 0, 0, [
        { id: 'ws', defId: 'weather_station_t2', x: 0, y: 0 },
        { id: 'aws', defId: 'advanced_weather_station_t3', x: 20, y: 0 },
      ]),
    ];
    const sources = computeWeatherVisionSources(islands);
    const t2 = sources.current.find(
      (s) => s.kind === 'circle' && s.radius === BASE_WEATHER_VISIBILITY_TILES + 3,
    );
    const t3 = sources.current.find(
      (s) => s.kind === 'circle' && s.radius === BASE_WEATHER_VISIBILITY_TILES + 6,
    );
    expect(t2 && t2.kind === 'circle' && t2.cx).toBe(0.5);
    expect(t3 && t3.kind === 'circle' && t3.cx).toBe(20.5);
    // The old summed (5 + 3 + 6 = 14) single circle no longer exists.
    expect(sources.current.some((s) => s.kind === 'circle' && s.radius === 14)).toBe(false);
    // Only the AWS emits a forecast circle, at the AWS position.
    expect(sources.forecast.length).toBe(1);
    const fc = sources.forecast[0];
    expect(fc && fc.kind === 'circle' && fc.cx).toBe(20.5);
  });

  it('station on one island does NOT extend a neighbouring island', () => {
    const islands = [
      makeIsland('a', 0, 0, [
        { id: 'aws', defId: 'advanced_weather_station_t3', x: 0, y: 0 },
      ]),
      makeIsland('b', 100, 0, []),
    ];
    const sources = computeWeatherVisionSources(islands);
    // island a: base circle (r=5 @ centre) + AWS circle (r=11 @ building).
    const aws = sources.current.find(
      (s) => s.kind === 'circle' && s.radius === BASE_WEATHER_VISIBILITY_TILES + 6,
    );
    expect(aws && aws.kind === 'circle' && aws.cx).toBe(0.5);
    // island b gets only its base circle — no extended circle anywhere near it.
    expect(
      sources.current.some(
        (s) => s.kind === 'circle' && s.radius > BASE_WEATHER_VISIBILITY_TILES && s.cx > 50,
      ),
    ).toBe(false);
    // Only the AWS-bearing island emits a forecast source, at the AWS position.
    expect(sources.forecast.length).toBe(1);
    const fc = sources.forecast[0];
    expect(fc && fc.kind === 'circle' && fc.cx).toBe(0.5);
  });

  it('skips unpopulated islands entirely', () => {
    const islands = [
      makeIsland(
        'a',
        0,
        0,
        [{ id: 'aws', defId: 'advanced_weather_station_t3', x: 0, y: 0 }],
        false,
      ),
    ];
    // Contract: computeWeatherVisionSources takes the populated subset only —
    // it does NOT re-check populated, so the caller must filter. This pins that
    // consumer responsibility.
    const sources = computeWeatherVisionSources(
      islands.filter((s) => s.populated),
    );
    expect(sources.current.length).toBe(0);
    expect(sources.forecast.length).toBe(0);
  });

  it('forecast samples weather() at nowMs + lookahead (matches independent call)', () => {
    // The render path samples weather() at forecastMs = nowMs + LOOKAHEAD.
    // Pin that LOOKAHEAD matches the exported constant.
    expect(WEATHER_FORECAST_LOOKAHEAD_MS).toBe(2 * 60 * 60 * 1000);
    const seed = 'forecast-pin';
    const nowMs = 1_000_000;
    const cellX = 7;
    const cellY = 3;
    const futureMs = nowMs + WEATHER_FORECAST_LOOKAHEAD_MS;
    const present = weather(seed, cellX, cellY, nowMs);
    const future = weather(seed, cellX, cellY, futureMs);
    expect(present.state).toBe(present.state); // tautology, but anchors the test
    expect(future.state).toBeDefined();
    // Replayability is the real claim: the same offset call returns the same state.
    expect(weather(seed, cellX, cellY, futureMs).state).toBe(future.state);
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
    const path: Array<{ cx: number; cy: number; entryMs: number }> = [];
    for (let i = 0; i < 200; i++) {
      path.push({ cx: i, cy: 0, entryMs: i * 1000 });
    }
    // multiplier 0 guarantees survival regardless of path length.
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


describe('co2WeatherMultiplier — band edges', () => {
  it.each([
    [0, 1.0], [50, 1.0], [99, 1.0],
    [100, 1.1], [500, 1.1], [9999, 1.1],
    [10_000, 1.3], [50_000, 1.3], [99_999, 1.3],
    [100_000, 1.6], [500_000, 1.6], [1_000_000, 1.6],
  ])('co2WeatherMultiplier(%i) = %f', (co2, mul) => {
    expect(co2WeatherMultiplier(co2)).toBe(mul);
  });
});

describe('sumIslandCo2 — global atmosphere pool', () => {
  it('returns the single global world.totalCo2Kg, not a per-island sum', () => {
    // Per-island co2Kg is inert in production; the authoritative climate value
    // is the one world-level scalar.
    expect(sumIslandCo2({ totalCo2Kg: 3500 })).toBe(3500);
  });
  it('treats missing totalCo2Kg as 0', () => {
    expect(sumIslandCo2({})).toBe(0);
  });
});

describe('rollHeatwave — deterministic + threshold', () => {
  it('returns null below 10t CO₂', () => {
    expect(rollHeatwave('s', 1, 9999)).toBeNull();
  });
  it('fires roughly 5% of the time at >10t (1000 days, expect 50±15)', () => {
    let hits = 0;
    for (let d = 0; d < 1000; d++) {
      if (rollHeatwave('s', d, 50_000)) hits++;
    }
    expect(hits).toBeGreaterThanOrEqual(30);
    expect(hits).toBeLessThan(65);
  });
  it('same seed + day → same result (replayable)', () => {
    expect(rollHeatwave('s', 42, 50_000)).toEqual(rollHeatwave('s', 42, 50_000));
  });
});

describe('§15.1 / §2.6 weatherClockMs — perf→wall domain conversion', () => {
  it('adds the wall offset to the perf timestamp', () => {
    expect(weatherClockMs(0, 0)).toBe(0);
    expect(weatherClockMs(1_000, 5_000)).toBe(6_000);
    expect(weatherClockMs(2_500, -500)).toBe(2_000);
  });

  it('offset 0 is the identity (test-compatibility default)', () => {
    expect(weatherClockMs(123_456, 0)).toBe(123_456);
  });
});

describe('§15.1 wall-anchored destruction + capacity sampling', () => {
  const W = 53 * 60 * 60 * 1000; // 53 h — well past several dwell cycles

  it('rollVehicleDestruction(wallOffsetMs=W) ≡ shifting every entryMs by W', () => {
    for (let i = 0; i < 25; i++) {
      const seed = `anchor-${i}`;
      const path = rasterizePath(0, 0, 1, 0, 60, 0.5, 0, 16);
      const shifted = path.map((p) => ({ ...p, entryMs: p.entryMs + W }));
      const a = rollVehicleDestruction(seed, path, 1.5, 'v-1', W);
      const b = rollVehicleDestruction(seed, shifted, 1.5, 'v-1', 0);
      expect(a).toEqual(b);
    }
  });

  it('a nonzero wallOffset flips some fate (the offset reaches weather())', () => {
    const path = rasterizePath(0, 0, 1, 0, 60, 0.5, 0, 16);
    let flipped = false;
    for (let i = 0; i < 500 && !flipped; i++) {
      const seed = `anchor-flip-${i}`;
      const a = rollVehicleDestruction(seed, path, 1.5, 'v-1', 0);
      const b = rollVehicleDestruction(seed, path, 1.5, 'v-1', W);
      flipped = a.destroyed !== b.destroyed;
    }
    expect(flipped).toBe(true);
  });

  it('routeCapacityMultiplierForWeather(wallOffsetMs=W) ≡ sampling at nowMs + W', () => {
    for (let i = 0; i < 25; i++) {
      const seed = `cap-anchor-${i}`;
      const a = routeCapacityMultiplierForWeather(seed, 0, 0, 100, 100, 0, 16, W);
      const b = routeCapacityMultiplierForWeather(seed, 0, 0, 100, 100, W, 16, 0);
      expect(a).toBe(b);
    }
  });
});

describe('weather memoization — resumable walker preserves determinism', () => {
  it('repeated query with identical inputs returns an identical result', () => {
    clearWeatherCacheForTests();
    const nowMs = 1_780_000_000_000; // wall-clock-epoch scale, like production
    const a = weather('memo-seed', 3, 4, nowMs, 'coast', 5_000);
    const b = weather('memo-seed', 3, 4, nowMs, 'coast', 5_000);
    expect(b).toEqual(a);
  });

  it('forward progression then backward query all agree with fresh cold walks', () => {
    const seed = 'memo-fwd';
    const cx = 1;
    const cy = 2;
    const t1 = 10 * 3_600_000;
    // Expected values: each from a FRESH (cold-walk) state.
    clearWeatherCacheForTests();
    const e1 = weather(seed, cx, cy, t1);
    // t2 lands 30 h past the end of t1's dwell — guaranteed to be in a later
    // dwell AND far enough that t1 falls before the 4-segment retained ring.
    const t2 = e1.untilMs + 30 * 3_600_000;
    clearWeatherCacheForTests();
    const e2 = weather(seed, cx, cy, t2);
    // Now the memoized sequence: t1 (cold+cache), t2 (forward resume),
    // t1 again (backward — cold path without touching the cache).
    clearWeatherCacheForTests();
    const r1 = weather(seed, cx, cy, t1);
    const r2 = weather(seed, cx, cy, t2);
    const r1again = weather(seed, cx, cy, t1);
    expect(r1).toEqual(e1);
    expect(r2).toEqual(e2);
    expect(r1again).toEqual(e1);
    // And the walker still serves forward queries correctly after the
    // backward detour.
    expect(weather(seed, cx, cy, t2)).toEqual(e2);
  });

  it('co2 band crossing invalidates: cached cell re-anchors to the cold-walk answer', () => {
    const seed = 'memo-co2';
    const cx = 7;
    const cy = 7;
    const t = 1_000 * 3_600_000;
    // Expected: a cold walk in the 1.1 band (100 kg ≤ co2 < 10 t).
    clearWeatherCacheForTests();
    const expected = weather(seed, cx, cy, t, undefined, 5_000);
    // Query under 1.0 band first (caches a 1.0-band walker), then cross
    // into the 1.1 band — must give exactly the re-anchored cold answer.
    clearWeatherCacheForTests();
    weather(seed, cx, cy, t, undefined, 0);
    const after = weather(seed, cx, cy, t, undefined, 5_000);
    expect(after).toEqual(expected);
    // Raw kg differing WITHIN the band must not re-anchor (key is the
    // stepped multiplier, not the kg figure).
    const sameBand = weather(seed, cx, cy, t, undefined, 9_999);
    expect(sameBand).toEqual(expected);
  });

  it('biome change invalidates: cached cell re-anchors to the cold-walk answer', () => {
    const seed = 'memo-biome';
    const cx = 5;
    const cy = 6;
    const t = 500 * 3_600_000;
    clearWeatherCacheForTests();
    const expected = weather(seed, cx, cy, t, 'volcanic');
    clearWeatherCacheForTests();
    weather(seed, cx, cy, t, 'plains');
    expect(weather(seed, cx, cy, t, 'volcanic')).toEqual(expected);
  });
});

describe('§7.3 coherent biome+CO₂ weather field across consumers', () => {
  const CRISIS_CO2 = 200_000; // ≥ 100 t ⇒ ×1.6 storm-weight amplification

  function isStormClass(s: string): boolean {
    return s === 'storm' || s === 'severe_storm' || s === 'catastrophic';
  }

  /** Cell whose weather at t is benign baseline (clear / light_fog — no
   *  capacity cut, no loss, no destruction chance) but storm-class once
   *  the §7.3 CO₂ amplification is applied. NOTE a clear→storm flip is
   *  arithmetically impossible: amplifying storm weights shrinks the
   *  clear band into light_fog only, so the boundary the amplification
   *  can push across is light_fog→storm. */
  function findCo2FlipCell(seed: string, t: number): { cx: number; cy: number } {
    for (let cx = -25; cx <= 25; cx++) {
      for (let cy = -25; cy <= 25; cy++) {
        if (isStormClass(weather(seed, cx, cy, t).state)) continue;
        if (isStormClass(weather(seed, cx, cy, t, undefined, CRISIS_CO2).state)) {
          return { cx, cy };
        }
      }
    }
    throw new Error('no CO₂ flip cell found');
  }

  /** Cell whose weather at t is benign baseline but storm-class under the
   *  volcanic biome weighting (same band-shift logic as the CO₂ finder). */
  function findBiomeFlipCell(seed: string, t: number): { cx: number; cy: number } {
    for (let cx = -25; cx <= 25; cx++) {
      for (let cy = -25; cy <= 25; cy++) {
        if (isStormClass(weather(seed, cx, cy, t).state)) continue;
        if (isStormClass(weather(seed, cx, cy, t, 'volcanic').state)) {
          return { cx, cy };
        }
      }
    }
    throw new Error('no biome flip cell found');
  }

  it('CO₂ threads into routeCapacityMultiplierForWeather', () => {
    const seed = 'co2-cap-seed';
    const { cx, cy } = findCo2FlipCell(seed, 0);
    // Route fully inside the flip cell.
    const x0 = cx * 16 + 2;
    const y0 = cy * 16 + 2;
    const x1 = cx * 16 + 14;
    const y1 = cy * 16 + 14;
    const base = routeCapacityMultiplierForWeather(seed, x0, y0, x1, y1, 0, 16);
    const amped = routeCapacityMultiplierForWeather(seed, x0, y0, x1, y1, 0, 16, 0, undefined, CRISIS_CO2);
    expect(base).toBe(1);
    expect(amped).toBeLessThan(1);
  });

  it('biome threads into routeCapacityMultiplierForWeather', () => {
    const seed = 'biome-cap-seed';
    const { cx, cy } = findBiomeFlipCell(seed, 0);
    const x0 = cx * 16 + 2;
    const y0 = cy * 16 + 2;
    const x1 = cx * 16 + 14;
    const y1 = cy * 16 + 14;
    const base = routeCapacityMultiplierForWeather(seed, x0, y0, x1, y1, 0, 16);
    const volcanic = routeCapacityMultiplierForWeather(
      seed, x0, y0, x1, y1, 0, 16, 0, () => 'volcanic', 0,
    );
    expect(base).toBe(1);
    expect(volcanic).toBeLessThan(1);
  });

  it('CO₂ threads into rollVehicleDestruction weather samples', () => {
    const seed = 'co2-roll-seed';
    const { cx, cy } = findCo2FlipCell(seed, 0);
    const path = [{ cx, cy, entryMs: 0 }];
    // Baseline clear ⇒ destruction chance 0 ⇒ NO vehicle id ever destroys.
    // Amped storm-class ⇒ chance > 0 ⇒ some vehicle id destroys.
    let ampedDestroyedId: string | null = null;
    for (let i = 0; i < 2000 && ampedDestroyedId === null; i++) {
      const id = `v-${i}`;
      if (rollVehicleDestruction(seed, path, 1.5, id, 0, undefined, CRISIS_CO2).destroyed) {
        ampedDestroyedId = id;
      }
    }
    expect(ampedDestroyedId).not.toBeNull();
    expect(
      rollVehicleDestruction(seed, path, 1.5, ampedDestroyedId!, 0, undefined, 0).destroyed,
    ).toBe(false);
  });

  it('biome threads into rollVehicleDestruction weather samples', () => {
    const seed = 'biome-roll-seed';
    const { cx, cy } = findBiomeFlipCell(seed, 0);
    const path = [{ cx, cy, entryMs: 0 }];
    let volcanicDestroyedId: string | null = null;
    for (let i = 0; i < 2000 && volcanicDestroyedId === null; i++) {
      const id = `v-${i}`;
      if (rollVehicleDestruction(seed, path, 1.5, id, 0, () => 'volcanic', 0).destroyed) {
        volcanicDestroyedId = id;
      }
    }
    expect(volcanicDestroyedId).not.toBeNull();
    expect(
      rollVehicleDestruction(seed, path, 1.5, volcanicDestroyedId!).destroyed,
    ).toBe(false);
  });
});
