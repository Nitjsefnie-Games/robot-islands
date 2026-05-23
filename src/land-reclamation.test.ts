// §3.4 Land Reclamation Hub — pure unit tests.
//
// Tests cover the four `canExpandIsland` outcomes (ok / no-hub / axis-at-max /
// insufficient-resources), the `expandIsland` mutation (single-axis increment
// + inventory deduction with the sibling axis untouched), and the cost curve.
// All three §3.4 placeholder biome caps are exercised at-cap to verify
// `BIOME_MAX_RADII` table lookups.

import { describe, expect, it } from 'vitest';

import type { IslandState } from './economy.js';
import type { PlacedBuilding } from './buildings.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import {
  canExpandIsland,
  expandIsland,
  landReclamationCost,
} from './land-reclamation.js';
import type { Biome, IslandSpec } from './world.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function emptyInv(): Record<ResourceId, number> {
  const inv = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) inv[r] = 0;
  return inv;
}

function emptyFunnel(): Record<ResourceId, number> {
  const f = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) f[r] = 0;
  return f;
}

function emptyCaps(): Record<ResourceId, number> {
  const c = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) c[r] = 1_000_000;
  return c;
}

function makeSpec(over: Partial<IslandSpec> = {}): IslandSpec {
  const defaults: IslandSpec = {
    id: 'fixture',
    name: 'fixture',
    biome: 'plains' as Biome,
    cx: 0,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: [],
  };
  return { ...defaults, ...over };
}

function makeState(inventory: Partial<Record<ResourceId, number>> = {}): IslandState {
  const inv = emptyInv();
  for (const [k, v] of Object.entries(inventory)) {
    inv[k as ResourceId] = v ?? 0;
  }
  return {
    id: 'fixture',
    buildings: [],
    inventory: inv,
    storageCaps: emptyCaps(),
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
    funnelPending: emptyFunnel(),
    declaredAt: null,
    aiCoreCrafted: false,
    ascendantCoreCrafted: false,
    lastResetAt: null,
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    genesisTarget: null,
    singularityStoredWs: 0,
    starterInventoryGrace: {} as Record<ResourceId, number>,
    lastTick: 0,
  };
}

function hubBuilding(): PlacedBuilding {
  return { id: 'hub-1', defId: 'land_reclamation_hub', x: 0, y: 0 };
}

// ---------------------------------------------------------------------------
// landReclamationCost — superlinear in current radius
// ---------------------------------------------------------------------------

describe('landReclamationCost (§3.4 placeholder)', () => {
  it('returns positive stone cost', () => {
    expect(landReclamationCost(14).stone).toBeGreaterThan(0);
  });

  it('scales superlinearly with current radius (r=27 ≫ r=14)', () => {
    const small = landReclamationCost(14).stone;
    const big = landReclamationCost(27).stone;
    // 5 × 27² / (5 × 14²)  =  729 / 196  ≈  3.72  — well above linear (~1.93).
    expect(big / small).toBeGreaterThan(2);
  });

  it('matches the 5 × r² formula at r=14 and r=27', () => {
    expect(landReclamationCost(14).stone).toBe(5 * 14 * 14);
    expect(landReclamationCost(27).stone).toBe(5 * 27 * 27);
  });
});

// ---------------------------------------------------------------------------
// canExpandIsland — rejection reasons + ok
// ---------------------------------------------------------------------------

describe('canExpandIsland', () => {
  it('rejects with no-hub when the island has no Land Reclamation Hub', () => {
    const spec = makeSpec({ buildings: [] });
    const state = makeState({ stone: 100_000 });
    const result = canExpandIsland(spec, state, 'major');
    expect(result).toEqual({ ok: false, reason: 'no-hub' });
  });

  it('rejects with axis-at-max when the chosen axis is at the biome cap', () => {
    // Plains caps both axes at 28.
    const spec = makeSpec({ majorRadius: 28, minorRadius: 14, buildings: [hubBuilding()] });
    const state = makeState({ stone: 100_000 });
    expect(canExpandIsland(spec, state, 'major')).toEqual({
      ok: false,
      reason: 'axis-at-max',
    });
    // The OTHER axis (minor at 14) is still expandable.
    expect(canExpandIsland(spec, state, 'minor')).toEqual({ ok: true });
  });

  it('rejects with insufficient-resources when inventory is below cost', () => {
    // Plains: r=14, cost = 5 × 14² = 980 stone.
    const spec = makeSpec({ buildings: [hubBuilding()] });
    const state = makeState({ stone: 100 });
    const result = canExpandIsland(spec, state, 'major');
    expect(result).toEqual({ ok: false, reason: 'insufficient-resources' });
  });

  it('returns ok when hub is placed, axis is below cap, and resources suffice', () => {
    const spec = makeSpec({ buildings: [hubBuilding()] });
    const state = makeState({ stone: 100_000 });
    expect(canExpandIsland(spec, state, 'major')).toEqual({ ok: true });
    expect(canExpandIsland(spec, state, 'minor')).toEqual({ ok: true });
  });

  it('checks the no-hub gate before axis-at-max (precedence)', () => {
    // No hub AND axis at cap — no-hub fires first.
    const spec = makeSpec({ majorRadius: 28, minorRadius: 28, buildings: [] });
    const state = makeState({ stone: 100_000 });
    expect(canExpandIsland(spec, state, 'major')).toEqual({
      ok: false,
      reason: 'no-hub',
    });
  });

  it('checks axis-at-max before insufficient-resources (precedence)', () => {
    // Hub present, axis at cap, AND inventory is low — axis-at-max wins so
    // the player sees the right reason rather than "go mine more stone".
    const spec = makeSpec({ majorRadius: 28, minorRadius: 14, buildings: [hubBuilding()] });
    const state = makeState({ stone: 0 });
    expect(canExpandIsland(spec, state, 'major')).toEqual({
      ok: false,
      reason: 'axis-at-max',
    });
  });
});

// ---------------------------------------------------------------------------
// expandIsland — mutation semantics
// ---------------------------------------------------------------------------

describe('expandIsland', () => {
  it('increments the chosen axis by 1 and leaves the other untouched', () => {
    const spec = makeSpec({ majorRadius: 14, minorRadius: 14, buildings: [hubBuilding()] });
    const state = makeState({ stone: 100_000 });
    expandIsland(spec, state, 'major');
    expect(spec.majorRadius).toBe(15);
    expect(spec.minorRadius).toBe(14);
  });

  it('increments minor when minor is chosen', () => {
    const spec = makeSpec({ majorRadius: 14, minorRadius: 14, buildings: [hubBuilding()] });
    const state = makeState({ stone: 100_000 });
    expandIsland(spec, state, 'minor');
    expect(spec.majorRadius).toBe(14);
    expect(spec.minorRadius).toBe(15);
  });

  it('deducts the cost from inventory', () => {
    const spec = makeSpec({ majorRadius: 14, minorRadius: 14, buildings: [hubBuilding()] });
    const state = makeState({ stone: 5_000 });
    const expectedCost = landReclamationCost(14).stone; // current-radius cost
    expandIsland(spec, state, 'major');
    expect(state.inventory.stone).toBe(5_000 - expectedCost);
  });

  it('uses the PRE-expansion radius for cost calculation', () => {
    // Growing 14→15 should cost cost(14), not cost(15).
    const spec = makeSpec({ majorRadius: 14, minorRadius: 14, buildings: [hubBuilding()] });
    const state = makeState({ stone: 5_000 });
    const costAt14 = landReclamationCost(14).stone;
    expandIsland(spec, state, 'major');
    expect(state.inventory.stone).toBe(5_000 - costAt14);
  });
});

// ---------------------------------------------------------------------------
// Biome-cap gates — Plains (28,28), Coast (28,14), Volcanic (14,14)
// ---------------------------------------------------------------------------

describe('§3.4 BIOME_MAX_RADII gates', () => {
  it('Plains: expand to (28,28) then both axes reject further expansion', () => {
    const spec = makeSpec({
      biome: 'plains',
      majorRadius: 27,
      minorRadius: 27,
      buildings: [hubBuilding()],
    });
    const state = makeState({ stone: 10_000_000 });
    expandIsland(spec, state, 'major');
    expandIsland(spec, state, 'minor');
    expect(spec.majorRadius).toBe(28);
    expect(spec.minorRadius).toBe(28);
    expect(canExpandIsland(spec, state, 'major')).toEqual({
      ok: false,
      reason: 'axis-at-max',
    });
    expect(canExpandIsland(spec, state, 'minor')).toEqual({
      ok: false,
      reason: 'axis-at-max',
    });
  });

  it('Coast: minor caps at 14 even though major can go to 28 (asymmetric)', () => {
    const spec = makeSpec({
      biome: 'coast',
      majorRadius: 14,
      minorRadius: 13,
      buildings: [hubBuilding()],
    });
    const state = makeState({ stone: 10_000_000 });
    expandIsland(spec, state, 'minor');
    expect(spec.minorRadius).toBe(14);
    expect(canExpandIsland(spec, state, 'minor')).toEqual({
      ok: false,
      reason: 'axis-at-max',
    });
    // But major still has room (14 → 28 is open).
    expect(canExpandIsland(spec, state, 'major')).toEqual({ ok: true });
  });

  it('Volcanic: both axes cap at 14', () => {
    const spec = makeSpec({
      biome: 'volcanic',
      majorRadius: 13,
      minorRadius: 13,
      buildings: [hubBuilding()],
    });
    const state = makeState({ stone: 10_000_000 });
    expandIsland(spec, state, 'major');
    expandIsland(spec, state, 'minor');
    expect(spec.majorRadius).toBe(14);
    expect(spec.minorRadius).toBe(14);
    expect(canExpandIsland(spec, state, 'major')).toEqual({
      ok: false,
      reason: 'axis-at-max',
    });
    expect(canExpandIsland(spec, state, 'minor')).toEqual({
      ok: false,
      reason: 'axis-at-max',
    });
  });
});
