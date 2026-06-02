import { describe, expect, it } from 'vitest';
import { advanceIsland, type DefCatalog, type IslandState } from './economy.js';
import { BUILDING_DEFS, type BuildingDef, type BuildingDefId } from './building-defs.js';
import { attachTerrainAt, makeInitialIslandState } from './world.js';

/** Strip power from the given defIds so tests exercise production/consumption
 *  without needing a generator (mirrors the powerFreeCatalog() pattern in
 *  economy.test.ts). */
function powerFree(...ids: BuildingDefId[]): DefCatalog {
  const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
  for (const id of ids) {
    const { power: _power, ...rest } = base[id];
    base[id] = rest as BuildingDef;
  }
  return base;
}
const POWER_FREE_MINE = powerFree('mine');
const POWER_FREE_WORKSHOP = powerFree('workshop');

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

/** A home island whose only relevant building is a Workshop — it CONSUMES
 *  starter iron_ore + coal and PRODUCES bolt, with no producer for the
 *  inputs. Used to prove that consumed-only resources are not recorded. */
function workshopState(nowMs = 0): IslandState {
  return makeInitialIslandState(
    attachTerrainAt({
      id: 'home', name: 'home', biome: 'plains', cx: 0, cy: 0,
      majorRadius: 16, minorRadius: 16, populated: true, discovered: true,
      buildings: [{ id: 'b-workshop', defId: 'workshop', x: 0, y: 0 }],
      modifiers: ['stable'],
    }),
    nowMs,
  );
}

describe('everProduced seen-set', () => {
  it('is empty on a fresh island except for starter inventory', () => {
    const s = homeState();
    expect(s.everProduced).toBeInstanceOf(Set);
    // A fresh plains home holds starter inventory but has produced nothing yet.
    expect(s.everProduced.size).toBe(0);
  });

  it('records a resource the first time production raises its inventory', () => {
    const s = homeState(0);
    advanceIsland(s, 5 * 60 * 1000, { defs: POWER_FREE_MINE }, 0);
    expect(s.everProduced.size).toBeGreaterThan(0);
  });

  it('does NOT record a resource that is only consumed (rate > 0 gate)', () => {
    // Workshop: -iron_ore, -coal → +bolt. iron_ore + coal come from starter
    // inventory and have no producer, so their net rate is negative; only
    // bolt is produced. Per the `rate > 0` gate, consumed-only resources must
    // stay out of everProduced.
    const s = workshopState(0);
    // Clear starter bolt so the workshop's output isn't cap-stalled (fresh
    // bolt cap is 20 < starter 25, which would freeze the building).
    s.inventory.bolt = 0;
    expect(s.inventory.iron_ore).toBeGreaterThan(0); // starter stock present
    expect(s.inventory.coal).toBeGreaterThan(0);
    advanceIsland(s, 60 * 60 * 1000, { defs: POWER_FREE_WORKSHOP }, 0);
    expect(s.inventory.bolt).toBeGreaterThan(0);         // bolt was produced
    expect(s.inventory.iron_ore).toBeLessThan(30);       // iron_ore was consumed
    expect(s.everProduced.has('bolt')).toBe(true);       // produced
    expect(s.everProduced.has('iron_ore')).toBe(false);  // consumed only
    expect(s.everProduced.has('coal')).toBe(false);      // consumed only
  });
});
