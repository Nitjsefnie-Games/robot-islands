import { describe, expect, it } from 'vitest';
import { advanceIsland, type DefCatalog, type IslandState } from './economy.js';
import { BUILDING_DEFS, type BuildingDef, type BuildingDefId } from './building-defs.js';
import { attachTerrainAt, makeInitialIslandState } from './world.js';

/** Strip power from the mine so tests exercise production without needing a
 *  generator (mirrors the powerFreeCatalog() pattern in economy.test.ts). */
function powerFreeMine(): DefCatalog {
  const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
  const { power: _power, ...rest } = base.mine;
  base.mine = rest as BuildingDef;
  return base;
}
const POWER_FREE_MINE = powerFreeMine();

function homeState(nowMs = 0): IslandState {
  return makeInitialIslandState(
    attachTerrainAt({
      id: 'home', name: 'home', biome: 'plains', cx: 0, cy: 0,
      majorRadius: 16, minorRadius: 16, populated: true, discovered: true,
      buildings: [{ id: 'b-mine', defId: 'mine', x: 0, y: 0 }],
      modifiers: ['stable'],
    }),
    nowMs,
  );
}

describe('everProduced seen-set', () => {
  it('is empty on a fresh island except for starter inventory', () => {
    const s = homeState();
    expect(s.everProduced).toBeInstanceOf(Set);
  });

  it('records a resource the first time production raises its inventory', () => {
    const s = homeState(0);
    advanceIsland(s, 5 * 60 * 1000, { defs: POWER_FREE_MINE }, 0);
    expect(s.everProduced.size).toBeGreaterThan(0);
  });
});
