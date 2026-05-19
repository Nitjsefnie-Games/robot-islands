// §6 hover-tooltip — pure cell-info helper tests.
//
// Covers the routing of `cellInfoForHover` per the design doc §6:
//   - rare-ocean cells (depth-revealed + revealed) → cluster bbox + occupancy
//   - surface-revealed only → "Unscouted depths"
//   - unrevealed ocean cell → "Open ocean"
//   - land cell → tile type + (if a building covers the tile) one-line def
//   - weather always surfaces (current cycle + forecast)
//
// DOM rendering is exercised by the running app, not by tests
// (project convention: no jsdom). Only the pure helper is tested here.

import { describe, expect, it } from 'vitest';

import {
  cellInfoForHover,
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

/** Build a minimal WorldState fixture. `cellInfoForHover` reads only
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

describe('§6 cellInfoForHover', () => {
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
    const info = cellInfoForHover(world, '5,5', NOW) as OceanRareInfo;
    expect(info.kind).toBe('ocean-rare');
    expect(info.terrain).toBe('hydrothermal_vent');
    expect(info.clusterSize).toEqual({ width: 2, height: 2 });
    expect(info.occupancy).toEqual({ used: 0, capacity: 1 });
  });

  it('returns occupancy 1/1 for a vent cluster that already has a vent_tap placed', () => {
    // 2×2 vent cluster at cell origin (5,5)–(6,6). Anchor island at tile origin.
    // Ocean building convention: b.x/y are anchor-local TILE coords.
    // Place a vent_tap at cell anchor (5,5) — tile origin (80, 80).
    const cells: Array<[number, number, OceanCellSpec['terrain']]> = [
      [5, 5, 'hydrothermal_vent'], [6, 5, 'hydrothermal_vent'],
      [5, 6, 'hydrothermal_vent'], [6, 6, 'hydrothermal_vent'],
    ];
    const revealed = ['5,5', '6,5', '5,6', '6,6'];
    const ventBuilding: PlacedBuilding = {
      id: 'placed-vent',
      defId: 'vent_tap',
      x: 5 * CELL_SIZE_TILES - 0, // anchor-local tile origin (anchor.cx === 0)
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
    const info = cellInfoForHover(world, '5,5', NOW) as OceanRareInfo;
    expect(info.kind).toBe('ocean-rare');
    expect(info.occupancy).toEqual({ used: 1, capacity: 1 });
  });

  it('returns "Unscouted depths" when a cell is surface-revealed but not depth-revealed', () => {
    const world = makeWorld({
      oceanCells: [[5, 5, 'hydrothermal_vent']],
      revealed: ['5,5'],
      depthRevealed: [],
    });
    const info = cellInfoForHover(world, '5,5', NOW);
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
    const info = cellInfoForHover(world, '5,5', NOW);
    expect(info.kind).toBe('ocean-unrevealed');
    if (info.kind === 'ocean-unrevealed') {
      expect(info.text).toBe('Open ocean');
    }
  });

  it('returns land-tile info + building one-liner when a building sits on the cell', () => {
    // Populated island at tile origin with a mine at local (0, 0).
    const mineBuilding: PlacedBuilding = {
      id: 'placed-mine',
      defId: 'mine',
      x: 0,
      y: 0,
      rotation: 0,
      lastTickMs: 0,
    } as PlacedBuilding;
    const home = makeSpec({
      id: 'home',
      name: 'Home',
      populated: true,
      cx: 8,
      cy: 8,
      majorRadius: 30,
      minorRadius: 30,
      buildings: [mineBuilding],
      // Terrain function: every land tile reports 'iron_ore'.
      // Cast keeps the test fixture free of the full IslandSpec shape.
    });
    // Inject a terrain function the helper can read for the hovered tile.
    (home as unknown as { terrainAt: (x: number, y: number) => string }).terrainAt = () => 'iron_ore';
    const world = makeWorld({
      islands: [home],
    });
    // Cell (0, 0) — covers tiles (0..15, 0..15). The mine at local (0, 0) sits inside.
    const info = cellInfoForHover(world, '0,0', NOW) as LandInfo;
    expect(info.kind).toBe('land');
    expect(info.text).toContain('iron_ore');
    expect(info.building).not.toBeNull();
    expect(info.building).toContain('Mine');
  });

  it('surfaces weather state for any cell (current cycle text always present)', () => {
    const world = makeWorld({
      oceanCells: [[5, 5, 'hydrothermal_vent']],
      revealed: [],
      depthRevealed: [],
    });
    const info = cellInfoForHover(world, '5,5', NOW);
    expect(info.weather).not.toBeNull();
    // Current-cycle string must mention one of the five state labels.
    expect(info.weather!.state).toMatch(/Clear|Light fog|Storm|Severe storm|Catastrophic/);
  });
});
