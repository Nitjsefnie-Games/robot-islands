import { describe, expect, it } from 'vitest';

import type { IslandState } from './economy.js';
import { type ResourceId } from './recipes.js';
import type { PlacedBuilding } from './buildings.js';
import {
  TUTORIAL_STEPS,
  currentStep,
  checkDismissals,
  markCompleted,
  markShown,
  markBumpClaimed,
  skipAll,
  restart,
  completeTutorialStep,
  xpBumpPercentForCompletion,
} from './tutorial.js';
import { xpForLevel } from './economy.js';
import { serializeWorld, deserializeWorld, type SaveSnapshot } from './persistence.js';
import { makeInitialWorld } from './world.js';
import type { IslandSpec, WorldState } from './world.js';
import { BUILDING_DEFS } from './building-defs.js';

function makeTestWorld(over: Partial<WorldState> = {}): WorldState {
  const { spec, state } = makeTestIsland('home');
  return {
    islands: [spec],
    islandStates: new Map([['home', state]]),
    drones: [],
    routes: [],
    vehicles: [],
    revealedCells: new Set(),
    satellites: [],
    repairDrones: [],
    debrisFields: [],
    seed: 'test-seed',
    latticeActive: false,
    latticeNodeIslands: [],
    commPackets: [],
    totalCo2Kg: 0,
    playerLat: null,
    playerLon: null,
    oceanCells: new Map(),
    depthRevealedCells: new Set(),
    recentBuildAttempts: new Set(),
    recentBuildAttemptTs: new Map(),
    ...over,
  };
}

function makeTestIsland(id: string): { spec: IslandSpec; state: IslandState } {
  const buildings: PlacedBuilding[] = [];
  const spec: IslandSpec = {
    id,
    name: id,
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
    buildings,
    modifiers: [],
  };
  const state: IslandState = {
    id,
    buildings,
    inventory: {} as Record<ResourceId, number>,
    storageCaps: {} as Record<ResourceId, number>,
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
    auraAmpVersion: 0,
    auraAmpCache: null,
    auraAmpCacheVersion: -1,
    co2Kg: 0,
    funnelPending: {} as Record<ResourceId, number>,
    aiCoreCrafted: false,
    ascendantCoreCrafted: false,
    lastResetAt: null,
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    genesisTarget: null,
    batteryStoredWs: 0,
    starterInventoryGrace: {} as Record<ResourceId, number>,
    socketBindings: new Map(),
    everProduced: new Set(),
    tradeCooldownMs: 0,
    tradeAcceptCount: 0,
    lastTick: 0,
  };
  return { spec, state };
}

describe('TUTORIAL_STEPS — integrity', () => {
  it('has exactly 72 entries with unique ids', () => {
    expect(TUTORIAL_STEPS.length).toBe(72);
    const ids = new Set(TUTORIAL_STEPS.map((s) => s.id));
    expect(ids.size).toBe(72);
  });
});

describe('TUTORIAL_STEPS — guard', () => {
  it('every targetDefId resolves to a real BUILDING_DEFS entry', () => {
    for (const step of TUTORIAL_STEPS) {
      if (step.targetDefId == null) continue;
      expect(BUILDING_DEFS[step.targetDefId], `${step.id} → ${step.targetDefId}`).toBeDefined();
    }
  });

  it("each build step's hint/expectedAction names the target's requiredTile (when it has one)", () => {
    for (const step of TUTORIAL_STEPS) {
      if (step.targetDefId == null) continue;
      const def: { requiredTile?: readonly string[] } = BUILDING_DEFS[step.targetDefId];
      const tiles = def.requiredTile ?? [];
      if (tiles.length === 0) continue; // target has no tile gate (e.g. smelter, copper_smelter)
      const text = `${step.hint} ${step.expectedAction ?? ''}`.toLowerCase();
      const named = tiles.some((t) => text.includes(t.toLowerCase()));
      expect(named, `${step.id} (${step.targetDefId}) must name one of ${tiles.join('/')}`).toBe(true);
    }
  });

  it('every step has real trigger + dismissal functions (no () => false stubs)', () => {
    for (const step of TUTORIAL_STEPS) {
      expect(typeof step.triggerCondition).toBe('function');
      expect(typeof step.dismissalCondition).toBe('function');
      // A trivial `() => false` body is forbidden — reject the literal.
      const tBody = step.triggerCondition.toString().replace(/\s/g, '');
      const dBody = step.dismissalCondition.toString().replace(/\s/g, '');
      expect(tBody, `${step.id} trigger is a dead stub`).not.toMatch(/=>false$/);
      expect(dBody, `${step.id} dismissal is a dead stub`).not.toMatch(/=>false$/);
    }
  });
});

describe('TUTORIAL_STEPS — ordering', () => {
  it('currentStep returns step 1 on a fresh world', () => {
    const w = makeTestWorld();
    expect(currentStep(w)?.id).toBe('01_location');
  });

  it('currentStep returns step N+1 after step N is marked completed', () => {
    const w = makeTestWorld({ playerLat: 40 });
    markCompleted(w, '01_location');
    expect(currentStep(w)?.id).toBe('02_inventory');
  });

  it('mid-tutorial state resumes at the right step', () => {
    // playerLat set (01 dismissed) and 02 completed, but NO power building yet
    // — so 03_power is the live step. (Pushing a water_wheel here would
    // satisfy 03's dismissal and surface 04 instead.)
    const w = makeTestWorld({ playerLat: 40 });
    w.tutorialState = {
      completed: new Set(['01_location', '02_inventory']),
      current: '03_power',
    };
    expect(currentStep(w)?.id).toBe('03_power');
  });

  it('the whole chain is walkable in order — every step reachable in sequence', () => {
    // A single forward walk: assert the live step, satisfy its target/gate,
    // mark it complete, repeat. If any trigger were dead/unreachable,
    // currentStep would skip past it and the assert fails AT that step,
    // naming it. Subsumes per-step trigger reachability + ordering.
    const w = makeTestWorld();
    const homeState = w.islandStates!.get('home')!;
    homeState.inventory = {} as Record<ResourceId, number>;

    const placeOnHome = (defId: string, x = 0, y = 0) => {
      w.islands[0]!.buildings.push({
        id: `${defId}_${x}_${y}`,
        defId: defId as PlacedBuilding['defId'],
        x,
        y,
      });
    };

    for (const expected of TUTORIAL_STEPS) {
      expect(currentStep(w)?.id, `chain stalled before ${expected.id}`).toBe(expected.id);
      if (expected.targetDefId) placeOnHome(expected.targetDefId);
      switch (expected.id) {
        case '01_location':
          w.playerLat = 40;
          break;
        case '07_mine':
          placeOnHome('iron_mine', 1, 0); // 2nd mine → hasAdjacentSameType for 12_adjacency
          homeState.inventory.iron_ore = 100; // → 10_smelter trigger
          homeState.inventory.coal = 100;
          break;
        case '16_tier2':
          homeState.level = 5;
          break;
        case '38_settle': {
          const i2 = makeTestIsland('isl2');
          i2.spec.populated = true;
          w.islands.push(i2.spec);
          w.islandStates!.set('isl2', i2.state);
          break;
        }
        case '41_tier3':
          homeState.level = 15;
          break;
        case '61_tier4':
          homeState.level = 30;
          break;
        case '63_ai_core':
          homeState.inventory.ai_core = 1;
          break;
        case '69_tier5':
          homeState.level = 50; // ai_core already seen at step 63
          break;
        case '71_reality_anchor':
          homeState.inventory.reality_anchor = 1;
          break;
        default:
          break;
      }
      markCompleted(w, expected.id);
    }
    expect(currentStep(w)).toBeNull();
  });
});

describe('checkDismissals', () => {
  it('reports a build step as dismissable once its target is placed', () => {
    const w = makeTestWorld({ playerLat: 40 });
    expect(checkDismissals(w)).not.toContain('03_power');
    w.islands[0]!.buildings.push({ id: 'b1', defId: 'water_wheel', x: 0, y: 0 });
    expect(checkDismissals(w)).toContain('03_power');
  });

  it('auto-dismisses a sole-TTL concept step after its TTL elapses since first show', () => {
    // 02_inventory is a sole-TTL concept step: its only dismissal path is the
    // TTL. Drive the real show path — currentStep surfaces it, the poll stamps
    // shownAt — then assert it becomes dismissable only after the TTL elapses.
    const w = makeTestWorld({ playerLat: 40 });
    const step = currentStep(w);
    expect(step?.id).toBe('02_inventory');

    // First show stamps shownAt via the same helper the main poll calls.
    markShown(w, step!.id);
    expect(w.tutorialState?.shownAt?.['02_inventory']).toBeDefined();

    // Freshly shown → TTL (8 s) not yet elapsed → not dismissable.
    expect(checkDismissals(w)).not.toContain('02_inventory');

    // Backdate the first-show time beyond the TTL → now dismissable.
    w.tutorialState!.shownAt!['02_inventory'] = Date.now() - 8_000;
    expect(checkDismissals(w)).toContain('02_inventory');

    // The main loop dismisses it via markCompleted (which is what grants the
    // XP bump); after that the step is gone and the chain advances.
    markCompleted(w, '02_inventory');
    expect(checkDismissals(w)).not.toContain('02_inventory');
    expect(currentStep(w)?.id).not.toBe('02_inventory');
  });
});

describe('skipAll + restart', () => {
  it('skipAll fills completed with all 72 ids', () => {
    const w = makeTestWorld();
    skipAll(w);
    expect(w.tutorialState!.completed.size).toBe(72);
    for (const step of TUTORIAL_STEPS) {
      expect(w.tutorialState!.completed.has(step.id)).toBe(true);
    }
  });

  it('skipAll causes currentStep to return null', () => {
    const w = makeTestWorld();
    skipAll(w);
    expect(currentStep(w)).toBeNull();
  });

  it('restart resets completed to empty', () => {
    const w = makeTestWorld();
    skipAll(w);
    restart(w);
    expect(w.tutorialState!.completed.size).toBe(0);
  });

  it('restart causes step 1 to reappear', () => {
    const w = makeTestWorld();
    skipAll(w);
    restart(w);
    expect(currentStep(w)?.id).toBe('01_location');
  });
});

describe('persistence — tutorialState', () => {
  it('pre-Phase-7 save (tutorialState undefined) loads with empty completed', () => {
    const world = makeInitialWorld(0);
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    delete (json.world as unknown as Record<string, unknown>).tutorialState;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.tutorialState?.completed.size).toBe(0);
    expect(currentStep(restored)?.id).toBe('01_location');
  });

  it('mid-tutorial state round-trips identity', () => {
    const world = makeInitialWorld(0);
    world.tutorialState = {
      completed: new Set(['01_location', '02_inventory']),
      current: '03_power',
    };
    const snap = serializeWorld(world, new Map(), 0);
    const json = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    const { world: restored } = deserializeWorld(json, 0, 0);
    expect(restored.tutorialState?.completed).toEqual(
      new Set(['01_location', '02_inventory']),
    );
    expect(restored.tutorialState?.current).toBe('03_power');
  });
});

describe('xpBumpClaimed ledger (restart/skip XP-farm fix)', () => {
  it('markBumpClaimed lazy-inits the set and records the id', () => {
    const w = makeTestWorld();
    markBumpClaimed(w, '01_location');
    expect(w.tutorialState?.xpBumpClaimed?.has('01_location')).toBe(true);
  });

  it('restart clears completed/current but PRESERVES xpBumpClaimed', () => {
    const w = makeTestWorld();
    markCompleted(w, '01_location');
    markBumpClaimed(w, '01_location');
    restart(w);
    expect(w.tutorialState?.completed.size).toBe(0);
    expect(w.tutorialState?.current).toBeNull();
    expect(w.tutorialState?.xpBumpClaimed?.has('01_location')).toBe(true);
  });

  it('skipAll fills xpBumpClaimed with every objective id', () => {
    const w = makeTestWorld();
    skipAll(w);
    expect(w.tutorialState?.xpBumpClaimed?.size).toBe(TUTORIAL_STEPS.length);
    expect(w.tutorialState?.completed.size).toBe(TUTORIAL_STEPS.length);
  });
});

describe('completeTutorialStep helper', () => {
  it('marks the step completed', () => {
    const w = makeTestWorld();
    completeTutorialStep(w, '01_location');
    expect(w.tutorialState?.completed.has('01_location')).toBe(true);
  });

  it('grants the home island XP once using the 1%..N% ramp', () => {
    const w = makeTestWorld();
    const home = w.islandStates!.get('home')!;
    const before = home.xp;

    const granted1 = completeTutorialStep(w, '01_location');
    const expected1 = (xpBumpPercentForCompletion(1) / 100) * xpForLevel(home.level + 1);
    expect(granted1).toBe(expected1);
    expect(home.xp).toBe(before + expected1);

    const xpAfterFirst = home.xp;
    const granted2 = completeTutorialStep(w, '02_inventory');
    const expected2 = (xpBumpPercentForCompletion(2) / 100) * xpForLevel(home.level + 1);
    expect(granted2).toBe(expected2);
    expect(home.xp).toBe(xpAfterFirst + expected2);
  });

  it('grants XP only once per step (idempotent)', () => {
    const w = makeTestWorld();
    const home = w.islandStates!.get('home')!;
    completeTutorialStep(w, '01_location');
    const afterFirst = home.xp;
    const grantedAgain = completeTutorialStep(w, '01_location');
    expect(grantedAgain).toBe(0);
    expect(home.xp).toBe(afterFirst);
    expect(w.tutorialState?.xpBumpClaimed?.has('01_location')).toBe(true);
  });
});

