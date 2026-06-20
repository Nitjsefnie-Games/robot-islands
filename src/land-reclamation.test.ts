// §3.4 Land Reclamation Hub — pure unit tests for canExpandConstituent outcomes,
// the expandConstituent mutation, the cost curve, and BIOME_MAX_RADII caps.

import { describe, expect, it } from 'vitest';

import type { IslandState } from './economy.js';
import type { PlacedBuilding } from './buildings.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import {
  canExpandConstituent,
  expandConstituent,
  inscribedTileCount,
  landReclamationCost,
} from './land-reclamation.js';
import { LAND_TILE_COST } from './building-defs.js';
import type { Biome, IslandSpec } from './world.js';

// Fixtures

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

// Single-constituent spec (primary ellipse only) for cost-of-growth tests.
function singleEllipseSpec(
  over: { biome: Biome; major: number; minor: number },
): IslandSpec {
  return makeSpec({
    biome: over.biome,
    majorRadius: over.major,
    minorRadius: over.minor,
  });
}

// Merged spec: a primary ellipse plus N absorbed constituents (extraEllipses).
function mergedSpec(over: {
  primary: { biome: Biome; major: number; minor: number };
  extras: ReadonlyArray<{
    biome: Biome;
    major: number;
    minor: number;
    offsetX: number;
    offsetY: number;
    rotation?: number;
  }>;
}): IslandSpec {
  return makeSpec({
    biome: over.primary.biome,
    majorRadius: over.primary.major,
    minorRadius: over.primary.minor,
    extraEllipses: over.extras.map((e) => ({
      biome: e.biome,
      major: e.major,
      minor: e.minor,
      rotation: e.rotation ?? 0,
      offsetX: e.offsetX,
      offsetY: e.offsetY,
    })),
  });
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
    auraAmpVersion: 0,
    auraAmpCache: null,
    auraAmpCacheVersion: -1,
    co2Kg: 0,
    funnelPending: emptyFunnel(),
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

function hubBuilding(): PlacedBuilding {
  return { id: 'hub-1', defId: 'land_reclamation_hub', x: 0, y: 0 };
}

describe('landReclamationCost — tile-delta × LAND_TILE_COST', () => {
  it('major-axis +1 bills (tileDelta) × LAND_TILE_COST', () => {
    const major = 14, minor = 14;
    const delta = inscribedTileCount(major + 1, minor) - inscribedTileCount(major, minor);
    expect(delta).toBeGreaterThan(0);
    const spec = singleEllipseSpec({ biome: 'plains', major, minor });
    expect(landReclamationCost(spec, 0, 'major')).toEqual({
      steel_beam: delta * (LAND_TILE_COST.steel_beam ?? 0),
      concrete: delta * (LAND_TILE_COST.concrete ?? 0),
    });
  });
  it('minor-axis +1 uses the minor delta', () => {
    const major = 14, minor = 7;
    const delta = inscribedTileCount(major, minor + 1) - inscribedTileCount(major, minor);
    const spec = singleEllipseSpec({ biome: 'plains', major, minor });
    expect(landReclamationCost(spec, 0, 'minor')).toEqual({
      steel_beam: delta * 1,
      concrete: delta * 10,
    });
  });
  it('inscribedTileCount grows with radius', () => {
    expect(inscribedTileCount(15, 14)).toBeGreaterThan(inscribedTileCount(14, 14));
  });
});

describe('landReclamationCost — constituent-indexed (union delta per lobe)', () => {
  it('cost index 0 grows primary (matches legacy primary delta)', () => {
    const spec = singleEllipseSpec({ biome: 'plains', major: 10, minor: 8 });
    const cost = landReclamationCost(spec, 0, 'major');
    // delta > 0 and proportional to LAND_TILE_COST
    const stone = Object.keys(LAND_TILE_COST)[0]! as keyof typeof LAND_TILE_COST;
    expect(cost[stone]! % LAND_TILE_COST[stone]!).toBe(0);
    expect(cost[stone]!).toBeGreaterThan(0);
  });

  it('cost for an absorbed lobe charges only NEW union tiles', () => {
    // Primary plains r10 at (0,0); absorbed lobe r6 at offset (12,0) partly
    // overlapping the primary. Growing the lobe toward the primary adds fewer
    // new tiles than its full ring (overlap already counted).
    const spec = mergedSpec({
      primary: { biome: 'plains', major: 10, minor: 10 },
      extras: [{ biome: 'volcanic', major: 6, minor: 6, offsetX: 12, offsetY: 0 }],
    });
    const costLobe = landReclamationCost(spec, 1, 'major'); // grow the lobe
    const stone = Object.keys(LAND_TILE_COST)[0]! as keyof typeof LAND_TILE_COST;
    // Strictly less than an isolated r6→r7 ring would cost (some tiles already
    // inside the primary union).
    const isolated = landReclamationCost(
      singleEllipseSpec({ biome: 'volcanic', major: 6, minor: 6 }), 0, 'major');
    expect(costLobe[stone]!).toBeLessThan(isolated[stone]!);
    expect(costLobe[stone]!).toBeGreaterThan(0);
  });

  it('out-of-range index → no charge (empty basket)', () => {
    const spec = singleEllipseSpec({ biome: 'plains', major: 10, minor: 10 });
    // No extraEllipses → index 1 is out of range.
    expect(landReclamationCost(spec, 1, 'major')).toEqual({});
  });
});

describe('canExpandConstituent (primary, index 0)', () => {
  it('rejects with no-hub when the island has no Land Reclamation Hub', () => {
    const spec = makeSpec({ buildings: [] });
    const state = makeState({ stone: 100_000 });
    const result = canExpandConstituent(spec, state, 0, 'major');
    expect(result).toEqual({ ok: false, reason: 'no-hub' });
  });

  it('rejects with axis-at-max when the chosen axis is at the biome cap', () => {
    // Plains caps both axes at 28.
    const spec = makeSpec({ majorRadius: 28, minorRadius: 14, buildings: [hubBuilding()] });
    const state = makeState({ steel_beam: 1_000_000, concrete: 10_000_000 });
    expect(canExpandConstituent(spec, state, 0, 'major')).toEqual({
      ok: false,
      reason: 'axis-at-max',
    });
    // The OTHER axis (minor at 14) is still expandable.
    expect(canExpandConstituent(spec, state, 0, 'minor')).toEqual({ ok: true });
  });

  it('rejects with insufficient-resources when inventory is below cost', () => {
    const spec = makeSpec({ buildings: [hubBuilding()] });
    const state = makeState({ steel_beam: 0, concrete: 0 });
    const result = canExpandConstituent(spec, state, 0, 'major');
    expect(result).toEqual({ ok: false, reason: 'insufficient-resources' });
  });

  it('returns ok when hub is placed, axis is below cap, and resources suffice', () => {
    const spec = makeSpec({ buildings: [hubBuilding()] });
    const state = makeState({ steel_beam: 1_000_000, concrete: 10_000_000 });
    expect(canExpandConstituent(spec, state, 0, 'major')).toEqual({ ok: true });
    expect(canExpandConstituent(spec, state, 0, 'minor')).toEqual({ ok: true });
  });

  it('checks the no-hub gate before axis-at-max (precedence)', () => {
    // No hub AND axis at cap — no-hub fires first.
    const spec = makeSpec({ majorRadius: 28, minorRadius: 28, buildings: [] });
    const state = makeState({ stone: 100_000 });
    expect(canExpandConstituent(spec, state, 0, 'major')).toEqual({
      ok: false,
      reason: 'no-hub',
    });
  });

  it('checks axis-at-max before insufficient-resources (precedence)', () => {
    // Hub present, axis at cap, AND inventory is low — axis-at-max wins so
    // the player sees the right reason rather than "go mine more stone".
    const spec = makeSpec({ majorRadius: 28, minorRadius: 14, buildings: [hubBuilding()] });
    const state = makeState({ stone: 0 });
    expect(canExpandConstituent(spec, state, 0, 'major')).toEqual({
      ok: false,
      reason: 'axis-at-max',
    });
  });
});

describe('expandConstituent (primary, index 0)', () => {
  it('increments the chosen axis by 1 and leaves the other untouched', () => {
    const spec = makeSpec({ majorRadius: 14, minorRadius: 14, buildings: [hubBuilding()] });
    const state = makeState({ steel_beam: 1_000_000, concrete: 10_000_000 });
    expandConstituent(spec, state, 0, 'major');
    expect(spec.majorRadius).toBe(15);
    expect(spec.minorRadius).toBe(14);
  });

  it('increments minor when minor is chosen', () => {
    const spec = makeSpec({ majorRadius: 14, minorRadius: 14, buildings: [hubBuilding()] });
    const state = makeState({ steel_beam: 1_000_000, concrete: 10_000_000 });
    expandConstituent(spec, state, 0, 'minor');
    expect(spec.majorRadius).toBe(14);
    expect(spec.minorRadius).toBe(15);
  });

  it('deducts the cost from inventory', () => {
    const spec = makeSpec({ majorRadius: 14, minorRadius: 14, buildings: [hubBuilding()] });
    const state = makeState({ steel_beam: 1_000_000, concrete: 10_000_000 });
    const expectedCost = landReclamationCost(
      singleEllipseSpec({ biome: 'plains', major: 14, minor: 14 }), 0, 'major');
    expandConstituent(spec, state, 0, 'major');
    expect(state.inventory.steel_beam).toBe(1_000_000 - (expectedCost.steel_beam ?? 0));
    expect(state.inventory.concrete).toBe(10_000_000 - (expectedCost.concrete ?? 0));
  });

  it('uses the PRE-expansion radius for cost calculation', () => {
    // Growing 14→15 should cost cost(14,14,'major'), not cost(15,14,'major').
    const spec = makeSpec({ majorRadius: 14, minorRadius: 14, buildings: [hubBuilding()] });
    const state = makeState({ steel_beam: 1_000_000, concrete: 10_000_000 });
    const costAt14 = landReclamationCost(
      singleEllipseSpec({ biome: 'plains', major: 14, minor: 14 }), 0, 'major');
    expandConstituent(spec, state, 0, 'major');
    expect(state.inventory.steel_beam).toBe(1_000_000 - (costAt14.steel_beam ?? 0));
    expect(state.inventory.concrete).toBe(10_000_000 - (costAt14.concrete ?? 0));
  });
});

// Biome-cap gates — Plains (28,28), Coast (28,14), Volcanic (14,14)
describe('landReclamationCost — union-aware delta for merged islands', () => {
  it('charges only genuinely-new tiles when extraEllipse overlaps the expansion ring', () => {
    // Primary r=3, extra at (4,0) r=3. Expanding major to 4 adds 4 primary
    // tiles. The 2 right-edge growth tiles are absorbed by the extra ellipse,
    // so the charged tiles are the 2 left-edge ones. Union delta should be
    // 2 vs primary-only delta of 4.
    const primaryOnly = landReclamationCost(
      singleEllipseSpec({ biome: 'plains', major: 3, minor: 3 }), 0, 'major');
    const unionAware = landReclamationCost(
      mergedSpec({
        primary: { biome: 'plains', major: 3, minor: 3 },
        extras: [{ biome: 'plains', major: 3, minor: 3, offsetX: 4, offsetY: 0 }],
      }),
      0,
      'major',
    );

    // Verify the union-aware cost is strictly smaller.
    expect(unionAware.steel_beam).toBeLessThan(primaryOnly.steel_beam!);
    expect(unionAware.concrete).toBeLessThan(primaryOnly.concrete!);

    // Hand-counted expectation: 2 new tiles.
    expect(unionAware.steel_beam).toBe(2 * (LAND_TILE_COST.steel_beam ?? 0));
    expect(unionAware.concrete).toBe(2 * (LAND_TILE_COST.concrete ?? 0));
  });

  it('falls back to primary-only delta when extraEllipses is absent or empty', () => {
    const withoutExtra = landReclamationCost(
      singleEllipseSpec({ biome: 'plains', major: 3, minor: 3 }), 0, 'major');
    const withEmptyExtra = landReclamationCost(
      mergedSpec({ primary: { biome: 'plains', major: 3, minor: 3 }, extras: [] }),
      0,
      'major',
    );
    expect(withEmptyExtra).toEqual(withoutExtra);
  });
});

describe('§3.4 BIOME_MAX_RADII gates', () => {
  it('Plains: expand to (28,28) then both axes reject further expansion', () => {
    const spec = makeSpec({
      biome: 'plains',
      majorRadius: 27,
      minorRadius: 27,
      buildings: [hubBuilding()],
    });
    const state = makeState({ steel_beam: 10_000_000, concrete: 100_000_000 });
    expandConstituent(spec, state, 0, 'major');
    expandConstituent(spec, state, 0, 'minor');
    expect(spec.majorRadius).toBe(28);
    expect(spec.minorRadius).toBe(28);
    expect(canExpandConstituent(spec, state, 0, 'major')).toEqual({
      ok: false,
      reason: 'axis-at-max',
    });
    expect(canExpandConstituent(spec, state, 0, 'minor')).toEqual({
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
    const state = makeState({ steel_beam: 10_000_000, concrete: 100_000_000 });
    expandConstituent(spec, state, 0, 'minor');
    expect(spec.minorRadius).toBe(14);
    expect(canExpandConstituent(spec, state, 0, 'minor')).toEqual({
      ok: false,
      reason: 'axis-at-max',
    });
    // But major still has room (14 → 28 is open).
    expect(canExpandConstituent(spec, state, 0, 'major')).toEqual({ ok: true });
  });

  it('Volcanic: both axes cap at 14', () => {
    const spec = makeSpec({
      biome: 'volcanic',
      majorRadius: 13,
      minorRadius: 13,
      buildings: [hubBuilding()],
    });
    const state = makeState({ steel_beam: 10_000_000, concrete: 100_000_000 });
    expandConstituent(spec, state, 0, 'major');
    expandConstituent(spec, state, 0, 'minor');
    expect(spec.majorRadius).toBe(14);
    expect(spec.minorRadius).toBe(14);
    expect(canExpandConstituent(spec, state, 0, 'major')).toEqual({
      ok: false,
      reason: 'axis-at-max',
    });
    expect(canExpandConstituent(spec, state, 0, 'minor')).toEqual({
      ok: false,
      reason: 'axis-at-max',
    });
  });
});

// Per-lobe constituent gate + mutation: each absorbed lobe caps at its OWN
// origin biome (BIOME_MAX_RADII[lobe.biome]), not the absorber's; the mutation
// grows ONLY the targeted constituent; a bad index is rejected, not thrown.
describe('canExpandConstituent / expandConstituent — absorbed lobes', () => {
  // stateWithPlentyOfResources: ample steel_beam + concrete (the LAND_TILE_COST
  // basket) so the gate never trips on insufficient-resources.
  function stateWithPlentyOfResources(): IslandState {
    return makeState({ steel_beam: 10_000_000, concrete: 100_000_000 });
  }

  it('lobe capped at its OWN origin biome, not the absorber', () => {
    // Plains primary (cap 28) + Volcanic lobe (cap 14) already at minor 14.
    const spec = mergedSpec({
      primary: { biome: 'plains', major: 20, minor: 20 },
      extras: [{ biome: 'volcanic', major: 8, minor: 14, offsetX: 26, offsetY: 0 }],
    });
    spec.buildings = [hubBuilding()];
    const st = stateWithPlentyOfResources();
    // Volcanic lobe minor already at its cap (14) → axis-at-max.
    expect(canExpandConstituent(spec, st, 1, 'minor')).toEqual({ ok: false, reason: 'axis-at-max' });
    // Volcanic lobe major 8 < 14 → ok.
    expect(canExpandConstituent(spec, st, 1, 'major')).toEqual({ ok: true });
    // Primary plains major 20 < 28 → ok.
    expect(canExpandConstituent(spec, st, 0, 'major')).toEqual({ ok: true });
  });

  it('expandConstituent grows ONLY the targeted lobe', () => {
    const spec = mergedSpec({
      primary: { biome: 'plains', major: 20, minor: 20 },
      extras: [{ biome: 'volcanic', major: 8, minor: 8, offsetX: 26, offsetY: 0 }],
    });
    spec.buildings = [hubBuilding()];
    const st = stateWithPlentyOfResources();
    expandConstituent(spec, st, 1, 'major');
    expect(spec.extraEllipses![0]!.major).toBe(9); // lobe grew
    expect(spec.extraEllipses![0]!.minor).toBe(8); // other axis untouched
    expect(spec.majorRadius).toBe(20); // primary untouched
    expect(spec.minorRadius).toBe(20); // primary untouched
  });

  it('bad index rejects with bad-constituent (no throw)', () => {
    const spec = singleEllipseSpec({ biome: 'plains', major: 10, minor: 10 });
    spec.buildings = [hubBuilding()];
    const st = stateWithPlentyOfResources();
    expect(canExpandConstituent(spec, st, 5, 'major')).toEqual({
      ok: false,
      reason: 'bad-constituent',
    });
    // Mutation on a bad index is a safe no-op (does not throw, does not mutate).
    expect(() => expandConstituent(spec, st, 5, 'major')).not.toThrow();
    expect(spec.majorRadius).toBe(10);
  });
});
