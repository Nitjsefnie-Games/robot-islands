import { describe, expect, it } from 'vitest';

import {
  computePlacementValidity,
  placementBlocksGhost,
  type ConstructionCandidate,
} from './construction-placement.js';
import type { IslandState } from './economy.js';
import type { PlacedBuilding } from './buildings.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { aggregateStorageCaps, type IslandSpec, type WorldState } from './world.js';
import { tileToCell, cellKey } from './discovery.js';
import { tileInscribedInEllipse } from './island.js';

const PC: PlacedBuilding = { id: 'pc-1', defId: 'platform_constructor', x: -4, y: -4 };

function inv(over: Partial<Record<ResourceId, number>>): Record<ResourceId, number> {
  const i = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) i[r] = 0;
  for (const [k, v] of Object.entries(over)) i[k as ResourceId] = v ?? 0;
  return i;
}

function founderSpec(): IslandSpec {
  return {
    id: 'founder', name: 'founder', biome: 'plains', cx: 0, cy: 0,
    majorRadius: 14, minorRadius: 14, populated: true, discovered: true,
    buildings: [PC], modifiers: [],
  };
}

function founderState(level = 15, materials: Partial<Record<ResourceId, number>> = {}): IslandState {
  return {
    id: 'founder', buildings: [PC], inventory: inv(materials),
    storageCaps: aggregateStorageCaps([PC]), xp: 0, level, unspentSkillPoints: 0,
    unlockedNodes: new Set(), unlockedEdges: new Set(), auraAmpVersion: 0,
    auraAmpCache: null, auraAmpCacheVersion: -1, co2Kg: 0,
    funnelPending: inv({}), aiCoreCrafted: false, ascendantCoreCrafted: false,
    lastResetAt: null, timeLockBankedMin: 0, accelerationQueue: [],
    accelerationRemainingMin: 0, bankingEnabled: false, genesisTarget: null,
    batteryStoredWs: 0, starterInventoryGrace: {} as Record<ResourceId, number>,
    socketBindings: new Map(), everProduced: new Set(), tradeCooldownMs: 0,
    tradeAcceptCount: 0, lastTick: 0,
  };
}

/** Reveal every footprint cell of a 4x4 ellipse centered at (cx,cy). */
function revealFootprint(cx: number, cy: number): Set<string> {
  const s = new Set<string>();
  for (let dy = -4; dy <= 3; dy++) for (let dx = -4; dx <= 3; dx++) {
    if (!tileInscribedInEllipse(dx, dy, 4, 4)) continue;
    const c = tileToCell(cx + dx, cy + dy);
    s.add(cellKey(c.cellX, c.cellY));
  }
  return s;
}

function world(states: Map<string, IslandState>, revealed: Set<string>): WorldState {
  const islands: IslandSpec[] = [];
  for (const id of states.keys()) {
    if (id === 'founder') islands.push(founderSpec());
  }
  return { islands, revealedCells: revealed } as unknown as WorldState;
}

const enough = { steel_beam: 100000, concrete: 100000 } as Partial<Record<ResourceId, number>>;

function cand(over: Partial<ConstructionCandidate> = {}): ConstructionCandidate {
  return { founderId: 'founder', biome: 'plains', major: 4, minor: 4, cx: 200, cy: 200, ...over };
}

describe('computePlacementValidity', () => {
  it('returns unknown-founder when the founder id is not in state', () => {
    const states = new Map<string, IslandState>();
    const w = world(states, revealFootprint(200, 200));
    expect(computePlacementValidity(w, states, cand()).reason).toBe('unknown-founder');
  });

  it('reds out on position-occupied before checking discovery', () => {
    const states = new Map([['founder', founderState(15, enough)]]);
    // Place candidate ON TOP of the founder at (0,0) -> overlap.
    const w = world(states, revealFootprint(0, 0));
    const v = computePlacementValidity(w, states, cand({ cx: 0, cy: 0 }));
    expect(v.reason).toBe('position-occupied');
  });

  it('returns in-unknown-space when the footprint is not revealed', () => {
    const states = new Map([['founder', founderState(15, enough)]]);
    const w = world(states, new Set()); // nothing revealed
    const v = computePlacementValidity(w, states, cand());
    expect(v.reason).toBe('in-unknown-space');
  });

  it('surfaces insufficient-materials only after spatial checks pass', () => {
    const states = new Map([['founder', founderState(15, {})]]); // no materials
    const w = world(states, revealFootprint(200, 200));
    const v = computePlacementValidity(w, states, cand());
    expect(v.reason).toBe('insufficient-materials');
  });

  it('returns ok when founder valid, position free, revealed, affordable', () => {
    const states = new Map([['founder', founderState(15, enough)]]);
    const w = world(states, revealFootprint(200, 200));
    expect(computePlacementValidity(w, states, cand())).toEqual({ ok: true });
  });

  it('placementBlocksGhost reds the spatial reasons only', () => {
    expect(placementBlocksGhost('position-occupied')).toBe(true);
    expect(placementBlocksGhost('in-unknown-space')).toBe(true);
    expect(placementBlocksGhost('radius-too-large')).toBe(true);
    expect(placementBlocksGhost('insufficient-materials')).toBe(false);
    expect(placementBlocksGhost(undefined)).toBe(false);
  });
});
