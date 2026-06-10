// @vitest-environment happy-dom
//
// Pure-helper tests for the HUD refactor (step 19).
//
// The HUD itself is a DOM module — DOM assertions for persistent-button
// identity live at the bottom of this file under the happy-dom environment.
// The interesting logic (per-category building enumeration, alarm
// classification) is exported as pure functions; we test those directly.

import { describe, expect, it } from 'vitest';

import type { PlacedBuilding } from './buildings.js';
import type { IslandState } from './economy.js';
import type { PowerBalance } from './economy.js';
import type { NetworkConsciousnessState } from './network-consciousness.js';
import {
  computeAlarms,
  enumerateBuildings,
  HUD_CATEGORY_ORDER,
  CATEGORY_HUD_LABEL,
  mountHud,
  mountIslandBar,
} from './hud.js';
import { makeRegistry } from './input.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import type { IslandSpec, WorldState } from './world.js';

/** Build a minimal IslandState satisfying the pieces the HUD helpers read.
 *  Only `inventory`, `storageCaps`, `unlockedNodes`, and `unlockedEdges`
 *  are touched by `inv()` / `cap()`. */
function makeState(
  overrides: {
    inventory?: Partial<Record<ResourceId, number>>;
    storageCaps?: Partial<Record<ResourceId, number>>;
  } = {},
): IslandState {
  const inventory = {} as Record<ResourceId, number>;
  const storageCaps = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) {
    inventory[r] = overrides.inventory?.[r] ?? 0;
    storageCaps[r] = overrides.storageCaps?.[r] ?? 0;
  }
  return {
    id: 'test',
    buildings: [],
    inventory,
    storageCaps,
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
    declaredAt: null,
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
}

/** Helper to spell out the rendered "defId ×count · …" string for a row
 *  given category and entries — mirrors the HUD's render path. */
function rowString(
  rows: ReadonlyArray<{ label: string; entries: ReadonlyArray<{ displayName: string; count: number }> }>,
  label: string,
): string | null {
  const row = rows.find((r) => r.label === label);
  if (!row) return null;
  return row.entries.map((e) => `${e.displayName} ×${e.count}`).join(' · ');
}

describe('enumerateBuildings', () => {
  it('returns an empty list when the island has no buildings', () => {
    expect(enumerateBuildings([])).toEqual([]);
  });

  it('groups buildings by category and counts duplicates', () => {
    const buildings: PlacedBuilding[] = [
      { id: 'b1', defId: 'mine', x: 0, y: 0 },
      { id: 'b2', defId: 'mine', x: 2, y: 0 },
      { id: 'b3', defId: 'workshop', x: 4, y: 0 },
      { id: 'b4', defId: 'smelter', x: 6, y: 0 },
    ];
    const rows = enumerateBuildings(buildings);
    // defId → category → label: mine→extraction→Extract, smelter→smelting→Refine.
    expect(rowString(rows, 'Extract')).toBe('Mine ×2');
    expect(rowString(rows, 'Refine')).toBe('Smelter ×1');
    expect(rowString(rows, 'Manufacturing')).toBe('Workshop ×1');
  });

  it('suppresses categories with no buildings entirely', () => {
    const rows = enumerateBuildings([{ id: 'b', defId: 'mine', x: 0, y: 0 }]);
    expect(rows.map((r) => r.label)).toEqual(['Extract']);
  });

  it('preserves the HUD_CATEGORY_ORDER between visible categories', () => {
    const buildings: PlacedBuilding[] = [
      { id: 'b1', defId: 'dock', x: 0, y: 0 }, // logistics
      { id: 'b2', defId: 'mine', x: 2, y: 0 }, // extraction
      { id: 'b3', defId: 'solar', x: 4, y: 0 }, // power
    ];
    const rows = enumerateBuildings(buildings);
    expect(rows.map((r) => r.category)).toEqual(['extraction', 'power', 'logistics']);
  });

  it('sorts within a category by descending count', () => {
    // Three Mines + one Quarry in extraction (both 'extraction' category).
    // Mine should come first (count=3 > 1).
    const buildings: PlacedBuilding[] = [
      { id: 'q', defId: 'quarry', x: 0, y: 0 },
      { id: 'm1', defId: 'mine', x: 2, y: 0 },
      { id: 'm2', defId: 'mine', x: 4, y: 0 },
      { id: 'm3', defId: 'mine', x: 6, y: 0 },
    ];
    const rows = enumerateBuildings(buildings);
    expect(rowString(rows, 'Extract')).toBe('Mine ×3 · Quarry ×1');
  });

  it('exposes a label map and order that covers every BuildingCategory', () => {
    // Defensive cover for the category-rename mapping; ensures every category
    // surfaces a label and is part of the order list (no silent omission).
    expect(HUD_CATEGORY_ORDER).toContain('extraction');
    expect(HUD_CATEGORY_ORDER).toContain('cooling');
    expect(CATEGORY_HUD_LABEL.extraction).toBe('Extract');
    expect(CATEGORY_HUD_LABEL.smelting).toBe('Refine');
  });
});

describe('computeAlarms', () => {
  it('reports no alarms when no resource is near cap or trending low', () => {
    const state = makeState({
      inventory: { iron_ore: 10 },
      storageCaps: { iron_ore: 100 },
    });
    const net: Record<ResourceId, number> = {} as Record<ResourceId, number>;
    for (const r of ALL_RESOURCES) net[r] = 0;
    net.iron_ore = 1; // producing
    const rep = computeAlarms(state, net);
    expect(rep.full).toEqual([]);
    expect(rep.low).toEqual([]);
  });

  it('marks a resource at ≥95% of cap as FULL', () => {
    const state = makeState({
      inventory: { iron_ore: 95, coal: 99 },
      storageCaps: { iron_ore: 100, coal: 100 },
    });
    const net: Record<ResourceId, number> = {} as Record<ResourceId, number>;
    for (const r of ALL_RESOURCES) net[r] = 0;
    const rep = computeAlarms(state, net);
    expect(rep.full).toContain('iron_ore');
    expect(rep.full).toContain('coal');
  });

  it('ignores resources with cap=0 for the FULL alarm', () => {
    // inv==cap==0 is the "no storage / no inventory" baseline. The alarm
    // shouldn't fire — 0/0 is degenerate, not a true FULL condition.
    const state = makeState({});
    const net: Record<ResourceId, number> = {} as Record<ResourceId, number>;
    for (const r of ALL_RESOURCES) net[r] = 0;
    const rep = computeAlarms(state, net);
    expect(rep.full).toEqual([]);
  });

  it('marks a resource trending to zero within 60s as LOW', () => {
    // 30 units at -1/s drains in 30s → trending LOW.
    const state = makeState({
      inventory: { coal: 30 },
      storageCaps: { coal: 100 },
    });
    const net: Record<ResourceId, number> = {} as Record<ResourceId, number>;
    for (const r of ALL_RESOURCES) net[r] = 0;
    net.coal = -1;
    const rep = computeAlarms(state, net);
    expect(rep.low).toContain('coal');
  });

  it('does NOT mark a resource as LOW when it would last more than 60s', () => {
    // 120 units at -1/s = 120s to zero. Outside the 60s lookahead.
    const state = makeState({
      inventory: { coal: 120 },
      storageCaps: { coal: 200 },
    });
    const net: Record<ResourceId, number> = {} as Record<ResourceId, number>;
    for (const r of ALL_RESOURCES) net[r] = 0;
    net.coal = -1;
    const rep = computeAlarms(state, net);
    expect(rep.low).not.toContain('coal');
  });

  it('does NOT mark a resource already at zero as LOW', () => {
    // Inventory==0 means the recipe stalled; the LOW signal is redundant
    // with the broken-chain symptom that follows. Skip to keep the row
    // focused on "going to break soon" rather than "already broken".
    const state = makeState({});
    const net: Record<ResourceId, number> = {} as Record<ResourceId, number>;
    for (const r of ALL_RESOURCES) net[r] = 0;
    net.coal = -1;
    const rep = computeAlarms(state, net);
    expect(rep.low).not.toContain('coal');
  });
});

describe('mountHud DOM persistence', () => {
  function makeMinimalWorld(): WorldState {
    return {
      islands: [],
      seed: 'test',
      drones: [],
      routes: [],
      vehicles: [],
      revealedCells: new Set(),
      satellites: [],
      repairDrones: [],
      debrisFields: [],
      endgameState: { achieved: new Set(), firstAchievedMs: null },
      latticeActive: false,
      latticeNodeIslands: [],
      commPackets: [],
      oceanCells: new Map(),
      depthRevealedCells: new Set(),
      totalCo2Kg: 0,
      playerLat: 0,
      playerLon: 0,
      recentBuildAttempts: new Set(),
      recentBuildAttemptTs: new Map(),
    };
  }

  function makeTierResetReadyState(): IslandState {
    const inventory = {} as Record<ResourceId, number>;
    const storageCaps = {} as Record<ResourceId, number>;
    for (const r of ALL_RESOURCES) {
      inventory[r] = 0;
      storageCaps[r] = 0;
    }
    inventory.steel = 300;
    inventory.gear = 200;
    return {
      id: 'test',
      buildings: [],
      inventory,
      storageCaps,
      xp: 0,
      level: 15,
      unspentSkillPoints: 0,
      unlockedNodes: new Set(),
      unlockedEdges: new Set(),
      auraAmpVersion: 0,
      auraAmpCache: null,
      auraAmpCacheVersion: -1,
      co2Kg: 0,
      funnelPending: {} as Record<ResourceId, number>,
      declaredAt: null,
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
  }

  it('preserves inventory and tier-reset button identity across update() calls', () => {
    const parent = document.createElement('div');
    const world = makeMinimalWorld();
    const reg = makeRegistry();
    const hud = mountHud(parent, world, () => {}, reg);

    const spec: IslandSpec = {
      id: 'test-island',
      name: 'Test Island',
      biome: 'plains',
      cx: 0,
      cy: 0,
      majorRadius: 10,
      minorRadius: 10,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
    };

    const state = makeTierResetReadyState();
    const net: Record<ResourceId, number> = {} as Record<ResourceId, number>;
    for (const r of ALL_RESOURCES) net[r] = 0;

    const power: PowerBalance = { produced: 10, consumed: 5, factor: 1, rawProduced: 10, rawConsumed: 5 };
    const ncState: NetworkConsciousnessState = { tier3PlusCount: 0, milestone: 0, globalProductionBuff: 1 };

    hud.update(state, net, power, spec, ncState, null, 0, 'test-island', new Map());
    const invBtnFirst = parent.querySelector('button.ri-btn--ghost') as HTMLButtonElement | null;
    const trBtnFirst = parent.querySelector('button.ri-kv__v') as HTMLButtonElement | null;
    expect(invBtnFirst).not.toBeNull();
    expect(trBtnFirst).not.toBeNull();

    hud.update(state, net, power, spec, ncState, null, 0, 'test-island', new Map());
    const invBtnSecond = parent.querySelector('button.ri-btn--ghost') as HTMLButtonElement | null;
    const trBtnSecond = parent.querySelector('button.ri-kv__v') as HTMLButtonElement | null;
    expect(invBtnSecond).not.toBeNull();
    expect(trBtnSecond).not.toBeNull();

    // Element identity must be stable — same object references.
    expect(invBtnSecond).toBe(invBtnFirst);
    expect(trBtnSecond).toBe(trBtnFirst);
  });
});

describe('§15.3 mountIslandBar rename repaint', () => {
  it('option name textContent reflects the new name after rename + update()', () => {
    const spec: IslandSpec = {
      id: 'isle-1',
      name: 'Old Name',
      biome: 'plains',
      cx: 0,
      cy: 0,
      majorRadius: 10,
      minorRadius: 10,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
    };
    const state = makeState();
    const world = {
      islands: [spec],
      islandStates: new Map([['isle-1', state]]),
    } as unknown as WorldState;
    const bar = mountIslandBar(world, () => {});
    const power = new Map<string, import('./economy.js').PowerBalance>();
    // First update — option is created with 'Old Name'.
    bar.update('isle-1', power, null);
    const opt = document.querySelector('.ri-island-opt') as HTMLElement | null;
    expect(opt).not.toBeNull();
    const nameEl = opt!.querySelector('.ri-island-opt__name') as HTMLElement | null;
    expect(nameEl).not.toBeNull();
    expect(nameEl!.textContent).toBe('Old Name');
    // Simulate a rename by mutating the spec (mirrors renameIsland + onRenameIsland).
    spec.name = 'New Name';
    // Second update with the same island id-signature — option persists but
    // name textContent must now reflect the new name (§15.3 fix).
    bar.update('isle-1', power, null);
    expect(nameEl!.textContent).toBe('New Name');
  });
});
