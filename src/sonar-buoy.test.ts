// Ocean-layer §5 — Sonar Buoy per-tick depth-discovery tests.
//
// Pure-layer fixtures: a minimal `WorldState` with one or two populated
// islands, each carrying placed buildings. The buoy is a 1×1 building at a
// known island-local tile; powered status is derived from the island's
// own production vs consumption sum (no `IslandState` needed — `tickSonarBuoys`
// gates on the spec's building list alone, mirroring antenna/lighthouse).

import { describe, expect, it } from 'vitest';

import { CELL_SIZE_TILES, cellKey, tileToCell } from './discovery.js';
import type { PlacedBuilding } from './buildings.js';
import type { IslandSpec, WorldState } from './world.js';
import { tickSonarBuoys, SONAR_BUOY_DEF_ID, SONAR_BUOY_RADIUS_TILES } from './sonar-buoy.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeIslandSpec(over: Partial<IslandSpec>): IslandSpec {
  return {
    id: 'spec',
    name: 'spec',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: ['stable'],
    ...over,
  };
}

function makeWorld(islands: IslandSpec[]): WorldState {
  return {
    islands,
    drones: [],
    routes: [],
    vehicles: [],
    revealedCells: new Set<string>(),
    seed: 'sonar-test',
    satellites: [],
    repairDrones: [],
    debrisFields: [],
    endgameState: { achieved: new Set(), firstAchievedMs: null },
    latticeActive: false,
    latticeNodeIslands: [],
    commPackets: [],
    oceanCells: new Map(),
    depthRevealedCells: new Set<string>(),
  } as WorldState;
}

/** A 100W Coal Gen with footprint (0, 0) — far enough from any sonar buoy
 *  in these fixtures that it doesn't interfere with the per-buoy reveal
 *  geometry, but supplies enough power to satisfy "powered" gates. */
function powerSource(id: string, x = 0, y = 0): PlacedBuilding {
  return { id, defId: 'coal_gen', x, y };
}

function sonarBuoy(id: string, x: number, y: number): PlacedBuilding {
  return { id, defId: SONAR_BUOY_DEF_ID, x, y };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sonar Buoy', () => {
  it('powered buoy writes both revealedCells and depthRevealedCells within radius', () => {
    // Buoy at island-local (5, 5); island centered at (0, 0) → world tile (5, 5).
    const buoyTileX = 5;
    const buoyTileY = 5;
    const island = makeIslandSpec({
      buildings: [powerSource('gen'), sonarBuoy('buoy', buoyTileX, buoyTileY)],
    });
    const world = makeWorld([island]);

    tickSonarBuoys(world);

    // The buoy's footprint center is at island-local (buoyTileX + 0.5, buoyTileY + 0.5)
    // = world tile (5.5, 5.5). `tileToCell` floors → cell (0, 0).
    const { cellX, cellY } = tileToCell(buoyTileX + 0.5, buoyTileY + 0.5);
    let inRangeCount = 0;
    for (let dy = -SONAR_BUOY_RADIUS_TILES; dy <= SONAR_BUOY_RADIUS_TILES; dy++) {
      for (let dx = -SONAR_BUOY_RADIUS_TILES; dx <= SONAR_BUOY_RADIUS_TILES; dx++) {
        if (dx * dx + dy * dy > SONAR_BUOY_RADIUS_TILES * SONAR_BUOY_RADIUS_TILES) continue;
        const key = cellKey(cellX + dx, cellY + dy);
        expect(world.revealedCells.has(key)).toBe(true);
        expect(world.depthRevealedCells.has(key)).toBe(true);
        inRangeCount++;
      }
    }
    expect(inRangeCount).toBeGreaterThan(0);
    // Sanity: a cell just outside the disk is NOT revealed by this buoy.
    const farX = cellX + SONAR_BUOY_RADIUS_TILES + 5;
    const farY = cellY + SONAR_BUOY_RADIUS_TILES + 5;
    expect(world.depthRevealedCells.has(cellKey(farX, farY))).toBe(false);
  });

  it('unpowered buoy does not reveal', () => {
    // Island with a buoy but NO generator: produced=0, consumed=50 → not powered.
    const island = makeIslandSpec({
      buildings: [sonarBuoy('buoy', 5, 5)],
    });
    const world = makeWorld([island]);

    tickSonarBuoys(world);

    expect(world.depthRevealedCells.size).toBe(0);
    expect(world.revealedCells.size).toBe(0);
  });

  it('multiple buoys union their coverage (Set semantics)', () => {
    // Two buoys on the same island, well separated so their disks don't
    // overlap. Both should be powered (one Coal Gen produces 100W; two
    // buoys at 50W each = 100W consumed → produced >= consumed).
    const a = 5;
    const b = a + SONAR_BUOY_RADIUS_TILES * 2 + CELL_SIZE_TILES * 3; // far apart
    const island = makeIslandSpec({
      buildings: [
        powerSource('gen'),
        sonarBuoy('buoy-a', a, a),
        sonarBuoy('buoy-b', b, b),
      ],
    });
    const world = makeWorld([island]);

    tickSonarBuoys(world);

    const cellA = tileToCell(a + 0.5, a + 0.5);
    const cellB = tileToCell(b + 0.5, b + 0.5);
    expect(world.depthRevealedCells.has(cellKey(cellA.cellX, cellA.cellY))).toBe(true);
    expect(world.depthRevealedCells.has(cellKey(cellB.cellX, cellB.cellY))).toBe(true);
    // The two centers are far apart → distinct cells.
    expect(cellKey(cellA.cellX, cellA.cellY)).not.toBe(cellKey(cellB.cellX, cellB.cellY));
  });

  it('non-buoy buildings do not write to discovery sets', () => {
    const island = makeIslandSpec({
      buildings: [powerSource('gen'), { id: 'mine', defId: 'mine', x: 5, y: 5 }],
    });
    const world = makeWorld([island]);

    tickSonarBuoys(world);

    expect(world.depthRevealedCells.size).toBe(0);
    expect(world.revealedCells.size).toBe(0);
  });
});
