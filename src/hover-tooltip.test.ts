// §6 hover-tooltip — pure tile-info helper tests.
//
// Covers the routing of `tileInfoForHover` per the design doc §6:
//   - LAND tiles (cursor over populated island): tile granularity.
//     terrain + building + consumers list + weather (vision-gated).
//   - OCEAN cells: cell granularity.
//       rare-ocean cells (depth-revealed + revealed) → cluster bbox + occupancy
//       surface-revealed only → "Unscouted depths"
//       unrevealed ocean cell → "Open ocean"
//   - Weather only when the tile is in `visible` vision (populated tiles
//     or tiles within a populated island's vision sources).
//
// DOM rendering is exercised by the running app, not by tests
// (project convention: no jsdom). Only the pure helper is tested here.

import { describe, expect, it } from 'vitest';

import {
  tileInfoForHover,
  type OceanRareInfo,
  type LandInfo,
} from './hover-tooltip.js';
import { CELL_SIZE_TILES } from './constants.js';
import type { OceanCellSpec } from './ocean-cell.js';
import type { IslandSpec, WorldState } from './world.js';
import type { PlacedBuilding } from './buildings.js';

const NOW = 1_700_000_000_000;

function makeSpec(over: Partial<IslandSpec>): IslandSpec {
  return {
    id: 'isl',
    name: 'Isle',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 5,
    minorRadius: 5,
    populated: false,
    discovered: false,
    buildings: [],
    modifiers: [],
    ...over,
  };
}

/** Build a minimal WorldState fixture. `tileInfoForHover` reads only
 *  `oceanCells`, `revealedCells`, `depthRevealedCells`, `islands`, `seed`. */
function makeWorld(opts: {
  oceanCells?: Array<[number, number, OceanCellSpec['terrain']]>;
  revealed?: string[];
  depthRevealed?: string[];
  islands?: IslandSpec[];
  seed?: string;
}): WorldState {
  return {
    seed: opts.seed ?? 'test-seed',
    islands: opts.islands ?? [],
    oceanCells: new Map((opts.oceanCells ?? []).map(([x, y, t]) => [`${x},${y}`, { terrain: t }] as const)),
    revealedCells: new Set(opts.revealed ?? []),
    depthRevealedCells: new Set(opts.depthRevealed ?? []),
    routes: [],
    drones: [],
    vehicles: [],
    satellites: [],
    repairDrones: [],
    debrisFields: [],
    commPackets: [],
    endgameState: { activePhase: null, phases: {} } as unknown as WorldState['endgameState'],
    latticeActive: false,
    latticeNodeIslands: [],
  } as unknown as WorldState;
}

/** A populated island at the origin with a configurable terrainAt. Used
 *  for land-branch tests where we want weather to be in-vision. */
function makePopulatedHome(opts: {
  buildings?: PlacedBuilding[];
  terrainAt?: (x: number, y: number) => string;
  cx?: number;
  cy?: number;
}): IslandSpec {
  const home = makeSpec({
    id: 'home',
    name: 'Home',
    populated: true,
    cx: opts.cx ?? 8,
    cy: opts.cy ?? 8,
    majorRadius: 30,
    minorRadius: 30,
    buildings: opts.buildings ?? [],
  });
  if (opts.terrainAt) {
    (home as unknown as { terrainAt: (x: number, y: number) => string }).terrainAt = opts.terrainAt;
  }
  return home;
}

describe('§6 tileInfoForHover', () => {
  it('returns "ocean-rare" with cluster bbox + occupancy 0/1 for a 2x2 vent cluster with no buildings placed', () => {
    // 2×2 hydrothermal vent cluster at cells (5..6, 5..6).
    const cells: Array<[number, number, OceanCellSpec['terrain']]> = [
      [5, 5, 'hydrothermal_vent'], [6, 5, 'hydrothermal_vent'],
      [5, 6, 'hydrothermal_vent'], [6, 6, 'hydrothermal_vent'],
    ];
    const revealed = ['5,5', '6,5', '5,6', '6,6'];
    const world = makeWorld({
      oceanCells: cells,
      revealed,
      depthRevealed: revealed,
    });
    // Hover the top-left tile of cell (5,5).
    const tileX = 5 * CELL_SIZE_TILES;
    const tileY = 5 * CELL_SIZE_TILES;
    const info = tileInfoForHover(world, tileX, tileY, NOW) as OceanRareInfo;
    expect(info.kind).toBe('ocean-rare');
    expect(info.terrain).toBe('hydrothermal_vent');
    expect(info.clusterSize).toEqual({ width: 2, height: 2 });
    expect(info.occupancy).toEqual({ used: 0, capacity: 1 });
  });

  it('returns occupancy 1/1 for a vent cluster that already has a vent_tap placed', () => {
    // 2×2 vent cluster at cells (5,5)–(6,6). Anchor island at tile origin.
    const cells: Array<[number, number, OceanCellSpec['terrain']]> = [
      [5, 5, 'hydrothermal_vent'], [6, 5, 'hydrothermal_vent'],
      [5, 6, 'hydrothermal_vent'], [6, 6, 'hydrothermal_vent'],
    ];
    const revealed = ['5,5', '6,5', '5,6', '6,6'];
    const ventBuilding: PlacedBuilding = {
      id: 'placed-vent',
      defId: 'vent_tap',
      x: 5 * CELL_SIZE_TILES - 0,
      y: 5 * CELL_SIZE_TILES - 0,
      rotation: 0,
      lastTickMs: 0,
      anchorIslandId: 'home',
    } as PlacedBuilding;
    const anchor = makeSpec({
      id: 'home',
      name: 'Home',
      populated: true,
      cx: 0,
      cy: 0,
      buildings: [ventBuilding],
    });
    const world = makeWorld({
      oceanCells: cells,
      revealed,
      depthRevealed: revealed,
      islands: [anchor],
    });
    const tileX = 5 * CELL_SIZE_TILES;
    const tileY = 5 * CELL_SIZE_TILES;
    const info = tileInfoForHover(world, tileX, tileY, NOW) as OceanRareInfo;
    expect(info.kind).toBe('ocean-rare');
    expect(info.occupancy).toEqual({ used: 1, capacity: 1 });
  });

  it('returns "Unscouted depths" when a cell is surface-revealed but not depth-revealed', () => {
    const world = makeWorld({
      oceanCells: [[5, 5, 'hydrothermal_vent']],
      revealed: ['5,5'],
      depthRevealed: [],
    });
    const info = tileInfoForHover(world, 5 * CELL_SIZE_TILES, 5 * CELL_SIZE_TILES, NOW);
    expect(info.kind).toBe('ocean-undepthed');
    if (info.kind === 'ocean-undepthed') {
      expect(info.text).toBe('Unscouted depths');
    }
  });

  it('returns "Open ocean" when a cell is not surface-revealed', () => {
    const world = makeWorld({
      oceanCells: [[5, 5, 'hydrothermal_vent']],
      revealed: [],
      depthRevealed: [],
    });
    const info = tileInfoForHover(world, 5 * CELL_SIZE_TILES, 5 * CELL_SIZE_TILES, NOW);
    expect(info.kind).toBe('ocean-unrevealed');
    if (info.kind === 'ocean-unrevealed') {
      expect(info.text).toBe('Open ocean');
    }
  });

  it('returns land-tile info + building one-liner when a building sits on the hovered tile', () => {
    // Populated island at world tile (8, 8) (centre) with a mine at local
    // (0, 0). Mine sits at world tile (8, 8) — hover that tile.
    const mineBuilding: PlacedBuilding = {
      id: 'placed-mine',
      defId: 'mine',
      x: 0,
      y: 0,
      rotation: 0,
      lastTickMs: 0,
    } as PlacedBuilding;
    const home = makePopulatedHome({
      buildings: [mineBuilding],
      terrainAt: () => 'iron_ore',
    });
    const world = makeWorld({ islands: [home] });
    const info = tileInfoForHover(world, 8, 8, NOW) as LandInfo;
    expect(info.kind).toBe('land');
    expect(info.text).toContain('iron_ore');
    expect(info.building).not.toBeNull();
    expect(info.building).toContain('Mine');
  });

  it('returns terrain + consumers list when hovering a non-background tile with no building on it', () => {
    // Populated island, terrainAt returns 'ore' everywhere — the Mine def
    // has 'ore' in `requiredTile`, so consumers must surface. Hover a tile
    // near the centre but not at any building.
    const home = makePopulatedHome({
      buildings: [],
      terrainAt: () => 'ore',
    });
    const world = makeWorld({ islands: [home] });
    const info = tileInfoForHover(world, 10, 10, NOW) as LandInfo;
    expect(info.kind).toBe('land');
    expect(info.text).toBe('ore');
    expect(info.building).toBeNull();
    // 'ore' is consumed by at least one building (e.g. Mine).
    expect(info.consumers.length).toBeGreaterThan(0);
    expect(info.consumers.some((c) => c.displayName.toLowerCase().includes('mine'))).toBe(true);
  });

  it('returns empty consumers list for background terrain (grass)', () => {
    const home = makePopulatedHome({
      buildings: [],
      terrainAt: () => 'grass',
    });
    const world = makeWorld({ islands: [home] });
    const info = tileInfoForHover(world, 10, 10, NOW) as LandInfo;
    expect(info.kind).toBe('land');
    expect(info.text).toBe('grass');
    expect(info.consumers).toEqual([]);
  });

  it('discriminates within a cell — two tiles in cell (0,0) can return different terrains', () => {
    // Populated island at world tile origin with checker terrainAt: even
    // sum of local coords → iron_ore, odd → limestone. Demonstrates that
    // the helper truly reads per-tile, not per-cell.
    const home = makePopulatedHome({
      buildings: [],
      terrainAt: (x, y) => ((x + y) % 2 === 0 ? 'iron_ore' : 'limestone'),
      cx: 0,
      cy: 0,
    });
    const world = makeWorld({ islands: [home] });
    const a = tileInfoForHover(world, 5, 5, NOW) as LandInfo;
    const b = tileInfoForHover(world, 6, 5, NOW) as LandInfo;
    expect(a.kind).toBe('land');
    expect(b.kind).toBe('land');
    expect(a.text).toBe('iron_ore');
    expect(b.text).toBe('limestone');
  });
});

describe('§6 tileInfoForHover — weather + vision gating', () => {
  it('surfaces weather state on a populated island tile (visible vision tier)', () => {
    const home = makePopulatedHome({
      buildings: [],
      terrainAt: () => 'iron_ore',
    });
    const world = makeWorld({ islands: [home] });
    const info = tileInfoForHover(world, 8, 8, NOW);
    expect(info.weather).not.toBeNull();
    expect(info.weather!.state).toMatch(/Clear|Light fog|Storm|Severe storm|Catastrophic/);
  });

  it('returns weather: null on an unrevealed ocean tile (outside vision)', () => {
    // No populated islands → no vision sources → the hovered tile is
    // out-of-vision. Weather must NOT surface.
    const world = makeWorld({
      oceanCells: [[5, 5, 'hydrothermal_vent']],
      revealed: [],
      depthRevealed: [],
    });
    const info = tileInfoForHover(world, 5 * CELL_SIZE_TILES, 5 * CELL_SIZE_TILES, NOW);
    expect(info.kind).toBe('ocean-unrevealed');
    expect(info.weather).toBeNull();
  });

  it('returns weather: null on a depth-revealed cell that is outside current vision (discovered tier)', () => {
    // The cell was depth-revealed (so terrain reads) but no populated
    // island has vision over it any more → discovered tier → no weather.
    const world = makeWorld({
      oceanCells: [[5, 5, 'shallows']],
      revealed: ['5,5'],
      depthRevealed: ['5,5'],
    });
    const info = tileInfoForHover(world, 5 * CELL_SIZE_TILES, 5 * CELL_SIZE_TILES, NOW);
    expect(info.kind).toBe('ocean-revealed');
    expect(info.weather).toBeNull();
  });
});
