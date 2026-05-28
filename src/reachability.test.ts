import { describe, it, expect } from 'vitest';
import { simulateOptimalPath, makeHomeIslandSpecForReachabilityTest } from './test-helpers/reachability.js';
import { makeInitialIslandState } from './world.js';
import type { Inventory } from './economy.js';

describe('reachability invariant (rev-16 §12.9.5)', () => {
  // P4C11 BLOCKED: kimi's 3-round analog substitution didn't unblock the chain —
  // T2 steel buildings need 25-30 t steel_beam (= 1.25-1.5 Mt actual mass),
  // unreachable from the 1.8 t starter in 45 min. Per spec §07 mitigation
  // hierarchy, Phase 7 tutorial restructure is the named fix. The test
  // infrastructure lands here; Phase 7 flips this from `.todo` → `.it` once
  // the tutorial-side BOMs/chain align with the reachability deadline.
  it.todo('walks rev-9 starter → 1 battery_bank in 45 min of simulated game time (Phase 7)', () => {
    const homeSpec = makeHomeIslandSpecForReachabilityTest();
    const state = makeInitialIslandState(homeSpec, 0);
    state.inventory = {
      stone: 1200, wood: 600, iron_ore: 30, coal: 80, iron_ingot: 60, bolt: 25,
      limestone: 15, saltwater_cell: 4, foundation_kit: 1,
    } as Inventory;

    const deadline_ms = 45 * 60 * 1000;
    const outcome = simulateOptimalPath(state, deadline_ms, 'battery_bank');

    expect(outcome.reached, 'battery_bank reachable from rev-9 starter').toBe(true);
    expect(outcome.elapsedMs, 'within 45 min deadline').toBeLessThanOrEqual(deadline_ms);
  });
});
