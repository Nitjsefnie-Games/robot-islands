// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { buildingCardLockState } from './buildings-ui.js';
import { BUILDING_DEFS } from './building-defs.js';
import { makeInitialIslandState } from './world.js';
import type { IslandSpec } from './world.js';
import type { IslandState } from './economy.js';
import type { NodeId } from './skilltree.js';

function makeSpec(overrides: Partial<IslandSpec> = {}): IslandSpec {
  return {
    id: 'test',
    name: 'test',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: [],
    ...overrides,
  };
}

function makeState(spec: IslandSpec, level: number): IslandState {
  const s = makeInitialIslandState(spec, 0);
  s.level = level;
  return s;
}

// The buildings catalog must mirror validatePlacement's skill relaxations
// (placement.ts:282-289). These tests assert the card lock state honors the
// tier-bypass (#146) and biome-bypass (#145) keystones.
describe('buildingCardLockState — skill bypass parity with validatePlacement', () => {
  it('#146 earlyRig (tierBypass) unlocks Drilling Rig one tier early', () => {
    const spec = makeSpec();
    // Drilling Rig is tier 3 (needs level >= 15). Level 5 is tier 2 → locked.
    const state = makeState(spec, 5);
    expect(buildingCardLockState(BUILDING_DEFS.drilling_rig, state, spec).unlocked).toBe(false);

    state.unlockedNodes.add('drilling.keystone.earlyRig' as NodeId);
    // tierShift 1 ⇒ unlocked when tierForLevel(5)=2 >= 3-1=2.
    expect(buildingCardLockState(BUILDING_DEFS.drilling_rig, state, spec).unlocked).toBe(true);
  });

  it('#145 pyroforgeBypass (biomeBypass) clears the biome lock off-volcanic', () => {
    // Pyroforge is tier 4 (requiredBiomes: ['volcanic']). Level 30 passes the
    // tier gate; a plains island biome-locks it.
    const spec = makeSpec({ biome: 'plains' });
    const state = makeState(spec, 30);
    const before = buildingCardLockState(BUILDING_DEFS.pyroforge, state, spec);
    expect(before.unlocked).toBe(true);
    expect(before.placementLocked).toBe(true);

    state.unlockedNodes.add('smelting.keystone.pyroforgeBypass' as NodeId);
    const after = buildingCardLockState(BUILDING_DEFS.pyroforge, state, spec);
    expect(after.biomeOk).toBe(true);
    expect(after.placementLocked).toBe(false);
  });
});
