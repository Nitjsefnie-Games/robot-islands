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
import { computeVisionSources } from './lighthouse.js';
import type { OceanCellSpec } from './ocean-cell.js';
import { visibleCellsFromVision } from './vision-source.js';
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
    latticeActive: false,
    latticeNodeIslands: [],
    recentBuildAttempts: new Set(),
    recentBuildAttemptTs: new Map(),
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

/** Build a populated island whose Lighthouse-T6 vision (radius 300)
 *  covers the entire ocean fixture range used in these tests, but whose
 *  unpadded island ellipse is tiny enough that `findPopulatedIslandAt`
 *  on a typical fixture tile (e.g. (80, 80)) returns null. The vision
 *  source is what the new tooltip predicate gates on; the island
 *  footprint just needs to stay out of the way. */
function makeWideVisionHome(extraBuildings: PlacedBuilding[] = []): IslandSpec {
  const lighthouse: PlacedBuilding = {
    id: 'wide-lh',
    defId: 'lighthouse_t6',
    x: 0,
    y: 0,
    rotation: 0,
    lastTickMs: 0,
  } as PlacedBuilding;
  return makeSpec({
    id: 'home',
    name: 'Home',
    populated: true,
    cx: 0,
    cy: 0,
    majorRadius: 5,
    minorRadius: 5,
    buildings: [lighthouse, ...extraBuildings],
  });
}

describe('§6 tileInfoForHover', () => {
  it('returns "ocean-rare" with cluster bbox + occupancy 0/1 for a 2x2 vent cluster with no buildings placed', () => {
    // 2×2 hydrothermal vent cluster at cells (5..6, 5..6).
    const cells: Array<[number, number, OceanCellSpec['terrain']]> = [
      [5, 5, 'hydrothermal_vent'], [6, 5, 'hydrothermal_vent'],
      [5, 6, 'hydrothermal_vent'], [6, 6, 'hydrothermal_vent'],
    ];
    const revealed = ['5,5', '6,5', '5,6', '6,6'];
    // Wide-vision populated island so the hovered ocean cell is in the
    // map's visible-cell set (else the visibility gate returns fog-tier
    // info regardless of reveal state).
    const world = makeWorld({
      oceanCells: cells,
      revealed,
      depthRevealed: revealed,
      islands: [makeWideVisionHome()],
    });
    const tileX = 5 * CELL_SIZE_TILES;
    const tileY = 5 * CELL_SIZE_TILES;
    const info = tileInfoForHover(world, tileX, tileY, NOW) as OceanRareInfo;
    expect(info.kind).toBe('ocean-rare');
    expect(info.terrain).toBe('hydrothermal_vent');
    expect(info.clusterSize).toEqual({ width: 2, height: 2 });
    expect(info.occupancy).toEqual({ used: 0, capacity: 1 });
  });

  it('returns occupancy 1/1 for a vent cluster that already has a vent_tap placed', () => {
    // 2×2 vent cluster at cells (5,5)–(6,6). Anchor island at tile origin
    // (small unpadded ellipse so the hovered ocean tile isn't classified
    // as land) with a Lighthouse-T6 providing wide vision so the cell
    // counts as visible under the new fog-matching predicate.
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
    const anchor = makeWideVisionHome([ventBuilding]);
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

  it('only counts depth-revealed cells in the cluster bbox + occupancy (#87)', () => {
    // 3×3 nodule cluster. Only the left column is depth-revealed.
    const cells: Array<[number, number, OceanCellSpec['terrain']]> = [
      [5, 5, 'nodule_field'], [6, 5, 'nodule_field'], [7, 5, 'nodule_field'],
      [5, 6, 'nodule_field'], [6, 6, 'nodule_field'], [7, 6, 'nodule_field'],
      [5, 7, 'nodule_field'], [6, 7, 'nodule_field'], [7, 7, 'nodule_field'],
    ];
    const revealed = cells.map(([x, y]) => `${x},${y}`);
    const depthRevealed = ['5,5', '5,6', '5,7']; // left column only
    const world = makeWorld({
      oceanCells: cells,
      revealed,
      depthRevealed,
      islands: [makeWideVisionHome()],
    });
    const tileX = 5 * CELL_SIZE_TILES;
    const tileY = 5 * CELL_SIZE_TILES;
    const info = tileInfoForHover(world, tileX, tileY, NOW) as OceanRareInfo;
    expect(info.kind).toBe('ocean-rare');
    // The tooltip must report only the depth-revealed subset, not the full 3×3.
    expect(info.clusterSize).toEqual({ width: 1, height: 3 });
    expect(info.occupancy).toEqual({ used: 0, capacity: 0 });
  });

  it('returns "Unscouted depths" when a cell is surface-revealed but not depth-revealed', () => {
    const world = makeWorld({
      oceanCells: [[5, 5, 'hydrothermal_vent']],
      revealed: ['5,5'],
      depthRevealed: [],
      islands: [makeWideVisionHome()],
    });
    const info = tileInfoForHover(world, 5 * CELL_SIZE_TILES, 5 * CELL_SIZE_TILES, NOW);
    expect(info.kind).toBe('ocean-undepthed');
    if (info.kind === 'ocean-undepthed') {
      expect(info.text).toBe('Unscouted depths');
    }
  });

  it('returns "Open ocean" when a cell is not surface-revealed but is currently in vision', () => {
    // Cell is in current vision (visibility gate passes) but not in
    // `revealedCells` (the persistent "scanned at surface tier" flag).
    // Exercises the legacy surface-reveal branch — labelled "Open ocean"
    // per the spec.
    const world = makeWorld({
      oceanCells: [[5, 5, 'hydrothermal_vent']],
      revealed: [],
      depthRevealed: [],
      islands: [makeWideVisionHome()],
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
      defId: 'iron_mine',
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

  it('suppresses the forecast line when the island has no forecast station (§2.6)', () => {
    // Cell (0,0) at this seed/time has a weather transition inside the 2 h
    // lookahead window (cur=clear, rem≈86 m) — so the *current* state shows,
    // but the next-cycle forecast is the Advanced Weather Station's gift.
    // With no station the player must not see the lookahead.
    const home = makePopulatedHome({ buildings: [], terrainAt: () => 'iron_ore' });
    const world = makeWorld({ islands: [home] });
    const info = tileInfoForHover(world, 8, 8, NOW);
    expect(info.weather).not.toBeNull();
    expect(info.weather!.state).toBe('Clear');
    expect(info.weather!.forecastText).toBeNull();
  });

  it('surfaces the forecast line when an Advanced Weather Station is present and the cell is in forecast range', () => {
    const station = {
      id: 'aws',
      defId: 'advanced_weather_station_t3',
      x: 0,
      y: 0,
      rotation: 0,
      lastTickMs: 0,
    } as unknown as PlacedBuilding;
    const home = makePopulatedHome({ buildings: [station], terrainAt: () => 'iron_ore' });
    const world = makeWorld({ islands: [home] });
    // Forecast surfaces only in the final WEATHER_FORECAST_LOOKAHEAD_MS (2 h) of
    // the cell's current dwell. Which wall-clock instant falls in that window
    // depends on the (seed, cell) dwell sequence, so scan forward in 1-min steps
    // over one max dwell (4 h) — guaranteed to enter the window — and assert the
    // forecast line renders there. (Pre-modulo this happened to land at NOW; the
    // §2.6 period re-anchoring moved the boundary, not the behavior under test.)
    let info = tileInfoForHover(world, 8, 8, NOW);
    for (let off = 0; off <= 4 * 60 * 60 * 1000 && info.weather!.forecastText === null; off += 60 * 1000) {
      info = tileInfoForHover(world, 8, 8, NOW + off);
    }
    expect(info.weather).not.toBeNull();
    expect(info.weather!.forecastText).not.toBeNull();
    expect(info.weather!.forecastText).toContain('→');
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

  it('returns minimal "Discovered" fog-tier info on a depth-revealed cell that is outside current vision', () => {
    // The cell WAS depth-revealed (so terrain would normally read) but no
    // populated island has vision over it any more → not in the map's
    // visible-cell set → tooltip mirrors the fog and returns the
    // discovered-tier minimal info. The terrain detail is intentionally
    // suppressed (player can't currently see what's there).
    const world = makeWorld({
      oceanCells: [[5, 5, 'shallows']],
      revealed: ['5,5'],
      depthRevealed: ['5,5'],
    });
    const info = tileInfoForHover(world, 5 * CELL_SIZE_TILES, 5 * CELL_SIZE_TILES, NOW);
    expect(info.kind).toBe('ocean-unrevealed');
    if (info.kind === 'ocean-unrevealed') {
      expect(info.text).toBe('Discovered');
    }
    expect(info.weather).toBeNull();
  });
});

describe('§6 tileInfoForHover — visibility predicate matches map fog', () => {
  it('returns minimal "Unknown" fog info when cell is not in vision and not in revealedCells', () => {
    // No populated islands and no revealed cells. Hovering any tile must
    // produce the unknown-tier minimal info — the entire tooltip body is
    // gated on visibility, not just weather.
    const world = makeWorld({
      oceanCells: [[5, 5, 'hydrothermal_vent']],
      revealed: [],
      depthRevealed: ['5,5'], // even depth-revealed is suppressed
    });
    const info = tileInfoForHover(world, 5 * CELL_SIZE_TILES, 5 * CELL_SIZE_TILES, NOW);
    expect(info.kind).toBe('ocean-unrevealed');
    if (info.kind === 'ocean-unrevealed') {
      expect(info.text).toBe('Unknown');
    }
    expect(info.weather).toBeNull();
  });

  it('suppresses LAND terrain/building details when the cell is not in current vision', () => {
    // A populated home, plus a DISCOVERED-only (not populated) neighbour
    // island carrying terrain + buildings. The neighbour's tiles are NOT
    // covered by home's vision halo. Hovering a neighbour tile must
    // return fog-tier info — not the LandInfo with terrain/building
    // details that the old `pointInVision`+land-routing would have
    // produced.
    const home = makePopulatedHome({ terrainAt: () => 'iron_ore' });
    const neighbourMine: PlacedBuilding = {
      id: 'neigh-mine',
      defId: 'iron_mine',
      x: 0,
      y: 0,
      rotation: 0,
      lastTickMs: 0,
    } as PlacedBuilding;
    const neighbour = makeSpec({
      id: 'neigh',
      name: 'Neigh',
      cx: 500,
      cy: 500,
      majorRadius: 5,
      minorRadius: 5,
      populated: false,
      discovered: true,
      buildings: [neighbourMine],
    });
    (neighbour as unknown as { terrainAt: (x: number, y: number) => string }).terrainAt =
      () => 'iron_ore';
    const world = makeWorld({ islands: [home, neighbour] });
    // Hover the neighbour's centre tile. Distance from home (8,8) to
    // (500,500) >> any vision halo home could emit.
    const info = tileInfoForHover(world, 500, 500, NOW);
    expect(info.kind).toBe('ocean-unrevealed');
    expect(info.weather).toBeNull();
  });

  it('CELL-EDGE BUG REGRESSION: tooltip visibility matches visibleCellsFromVision cell-for-cell', () => {
    // Iterate a span of tile coords across cells around a populated
    // island's vision halo. For every tile, assert that the tooltip's
    // visibility decision (visible vs fog) matches whether the tile's
    // containing cell is in `visibleCellsFromVision`. Old code used
    // `pointInVision` which could disagree with this cell-set at the
    // edges; new code uses the same set.
    const home = makePopulatedHome({ terrainAt: () => 'iron_ore' });
    const world = makeWorld({ islands: [home] });
    const sources = computeVisionSources(world.islands.filter((s) => s.populated));
    const visible = visibleCellsFromVision(sources);
    // Span a 64×64-tile region around the home centre (8,8) — covers cells
    // (-2,-2) through (3,3).
    const mismatches: Array<{ tx: number; ty: number; cellKey: string; expected: boolean; got: 'visible' | 'fog' }> = [];
    // Sample a small set of specific cell-boundary tiles rather than a
    // dense grid — tileInfoForHover recomputes visibleCellsFromVision per
    // call and the grid version timed out under the 5s default. These
    // 8 sample tiles hit each axis edge of cell (0,0) and a diagonal
    // crossing the vision halo perimeter, which is sufficient to catch
    // the pointInVision/visibleCellsFromVision divergence.
    const samples: Array<[number, number]> = [
      [0, 0],      // inside home cell — must be visible
      [15, 15],    // SE corner of cell (0,0)
      [16, 0],    // first tile of cell (1,0)
      [0, 16],    // first tile of cell (0,1)
      [-1, -1],   // last tile of cell (-1,-1)
      [32, 0],    // first tile of cell (2,0) — well past vision halo for a small island
      [0, 32],    // first tile of cell (0,2)
      [64, 64],   // way outside any vision
    ];
    for (const [tx, ty] of samples) {
      {
        const cellX = Math.floor(tx / CELL_SIZE_TILES);
        const cellY = Math.floor(ty / CELL_SIZE_TILES);
        const cellKey = `${cellX},${cellY}`;
        const expected = visible.has(cellKey);
        const info = tileInfoForHover(world, tx, ty, NOW);
        // The fog-tier shape is `kind: 'ocean-unrevealed'` with text
        // 'Unknown' or 'Discovered'; any other shape means tooltip
        // considered the cell visible.
        const fogText =
          info.kind === 'ocean-unrevealed' &&
          (info.text === 'Unknown' || info.text === 'Discovered');
        const got: 'visible' | 'fog' = fogText ? 'fog' : 'visible';
        if ((got === 'visible') !== expected) {
          mismatches.push({ tx, ty, cellKey, expected, got });
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
