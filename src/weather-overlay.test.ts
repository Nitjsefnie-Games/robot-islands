// Unit tests for visibleWeatherCells — the pure data half of the weather
// overlay. The render side is happy-dom-free PixiJS and stays out of test
// scope (the project convention is "tests target the pure layer only", per
// AGENTS.md).

import { describe, expect, it } from 'vitest';

import { BASE_VISIBILITY_CELLS, visibleWeatherCells } from './weather-overlay.js';
import { CELL_SIZE_TILES, type WorldState } from './world.js';

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
    endgameState: { achieved: new Set(), firstAchievedMs: null, victoryBannerShown: false },
    latticeActive: false,
    latticeNodeIslands: [],
    commPackets: [],
    seed: 'test-seed',
  };
}

describe('visibleWeatherCells', () => {
  it('returns empty when no island is populated', () => {
    const cells = visibleWeatherCells(makeWorld([]));
    expect(cells.size).toBe(0);
  });

  it('covers a circular footprint of BASE_VISIBILITY_CELLS around a populated island', () => {
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
    const cells = visibleWeatherCells(world);
    // Centre cell is included.
    expect(cells.has('0,0')).toBe(true);
    // Cell exactly at BASE_VISIBILITY_CELLS along an axis is inside the disc.
    expect(cells.has(`${BASE_VISIBILITY_CELLS},0`)).toBe(true);
    expect(cells.has(`0,${BASE_VISIBILITY_CELLS}`)).toBe(true);
    // One beyond is outside.
    expect(cells.has(`${BASE_VISIBILITY_CELLS + 1},0`)).toBe(false);
    // Diagonal outside the disc.
    expect(cells.has(`${BASE_VISIBILITY_CELLS},${BASE_VISIBILITY_CELLS}`)).toBe(false);
  });

  it('does not cover cells for unpopulated islands', () => {
    const world = makeWorld([
      {
        id: 'home',
        name: 'home',
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
    expect(visibleWeatherCells(world).size).toBe(0);
  });

  it('extends range by +3 cells per weather_station_t2', () => {
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
          {
            defId: 'weather_station_t2',
            x: 0,
            y: 0,
            rotation: 0,
            id: 'w1',
          },
        ],
        modifiers: [],
      },
    ]);
    const cells = visibleWeatherCells(world);
    expect(cells.has(`${BASE_VISIBILITY_CELLS + 3},0`)).toBe(true);
    expect(cells.has(`${BASE_VISIBILITY_CELLS + 4},0`)).toBe(false);
  });

  it('places cells in the correct cell-coord space when island sits off-origin', () => {
    // CELL_SIZE_TILES = 16; an island at tile (32, 0) lives in cell (2, 0).
    const offsetTiles = CELL_SIZE_TILES * 2;
    const world = makeWorld([
      {
        id: 'home',
        name: 'home',
        biome: 'plains',
        cx: offsetTiles,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: [],
        modifiers: [],
      },
    ]);
    const cells = visibleWeatherCells(world);
    expect(cells.has('2,0')).toBe(true);
    expect(cells.has(`${2 + BASE_VISIBILITY_CELLS},0`)).toBe(true);
    expect(cells.has(`${2 - BASE_VISIBILITY_CELLS},0`)).toBe(true);
    expect(cells.has(`${2 + BASE_VISIBILITY_CELLS + 1},0`)).toBe(false);
  });
});
