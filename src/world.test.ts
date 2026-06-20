// Island render-state classification: pure-logic tests for the three-state
// vision model (visible / discovered / unknown).

import { describe, expect, it } from 'vitest';

import { computeVisionSources, type VisionSource } from './lighthouse.js';
import {
  attachTerrainAt,
  constituentBiomeAt,
  DEMO_ISLANDS_TEST_FIXTURE,
  findPopulatedIslandAt,
  islandConstituentBiomes,
  islandConstituents,
  islandRenderState,
  ISLAND_NAME_MAX_LEN,
  makeInitialIslandState,
  makeInitialWorld,
  renameIsland,
  WORLD_SEED,
  validateIslandName,
  VISION_PADDING_TILES,
  type IslandSpec,
} from './world.js';
import { tileInscribedInEllipse, type TerrainKind } from './island.js';
import type { ResourceId } from './recipes.js';
import { ALL_RESOURCES } from './recipes.js';

function makeSpec(over: Partial<IslandSpec>): IslandSpec {
  return {
    id: 'test',
    name: 'test',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 5,
    minorRadius: 5,
    populated: false,
    discovered: false,
    buildings: [],
    modifiers: [],
    ...over,
  };
}

/** Helper: build the VisionSource[] for a single populated source spec.
 *  Mirrors what `main.ts` does each frame — convenient for `islandRenderState`
 *  callers that want to assert against a known fixture without rebuilding the
 *  full demo layout. */
function sourcesFor(specs: ReadonlyArray<IslandSpec>): VisionSource[] {
  return computeVisionSources(specs);
}

describe('islandRenderState', () => {
  // Plains-like source (14, 14) at origin. Padding 10 → baseline ellipse
  // (24, 24). Small enough that forest-ne (40, -10) classifies as
  // `discovered` without a Lighthouse.
  const sourceSpec = makeSpec({
    id: 'src',
    cx: 0,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
  });
  const sources: ReadonlyArray<VisionSource> = sourcesFor([sourceSpec]);

  it('classifies a populated island as visible (regardless of `discovered`)', () => {
    const s = makeSpec({ populated: true, discovered: false, cx: 200, cy: 200 });
    // Even far away from any source, populated implies visible — populated
    // islands ARE the vision sources, so they're trivially in vision of self.
    expect(islandRenderState(s, sources)).toBe('visible');
  });

  it('classifies a discovered island inside the baseline ellipse as visible', () => {
    // A point at (10, 10) against a (14,14) source → baseline (24, 24).
    // 10²/24² + 10²/24² ≈ 0.347 ≤ 1 → visible.
    const s = makeSpec({ populated: false, discovered: true, cx: 10, cy: 10 });
    expect(islandRenderState(s, sources)).toBe('visible');
  });

  it('classifies a discovered island outside vision ellipse as discovered', () => {
    // forest-ne-ish: (40, -10). 40²/24² + 10²/24² ≈ 2.95 > 1 → discovered.
    const s = makeSpec({ populated: false, discovered: true, cx: 40, cy: -10 });
    expect(islandRenderState(s, sources)).toBe('discovered');
  });

  it('classifies an undiscovered island as unknown', () => {
    const s = makeSpec({ populated: false, discovered: false, cx: 10, cy: 10 });
    // Even though it's inside the vision ellipse, undiscovered short-circuits
    // to unknown — the player just doesn't know it's there.
    expect(islandRenderState(s, sources)).toBe('unknown');
  });

  it('handles zero vision sources sanely', () => {
    const s1 = makeSpec({ populated: true });
    const s2 = makeSpec({ populated: false, discovered: true });
    const s3 = makeSpec({ populated: false, discovered: false });
    expect(islandRenderState(s1, [])).toBe('visible');
    expect(islandRenderState(s2, [])).toBe('discovered');
    expect(islandRenderState(s3, [])).toBe('unknown');
  });

  it('treats the vision-ellipse boundary as inclusive', () => {
    // Source (14, 14) → vision semi-axis 24 on the major axis. (24, 0) sits
    // exactly on the ellipse boundary → 24²/24² + 0 = 1 ≤ 1 → visible.
    const s = makeSpec({ populated: false, discovered: true, cx: 24, cy: 0 });
    expect(islandRenderState(s, sources)).toBe('visible');
  });

  it('uses asymmetric semi-axes for oval (Coast-like) sources — major-axis boundary visible', () => {
    // Coast-like (14, 7) source at origin → vision ellipse semi-axes (24, 17).
    // Test point on the major axis at the boundary: (24, 0) → 1.0 ≤ 1 → visible.
    const ovalSrc = makeSpec({
      id: 'oval',
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 7,
      populated: true,
      discovered: true,
    });
    const ovalSources = sourcesFor([ovalSrc]);
    const onMajorBoundary = makeSpec({
      populated: false,
      discovered: true,
      cx: 24,
      cy: 0,
    });
    expect(islandRenderState(onMajorBoundary, ovalSources)).toBe('visible');
  });

  it('uses asymmetric semi-axes for oval (Coast-like) sources — minor-axis boundary visible, just outside discovered', () => {
    // Same (14, 7) source → vision (24, 17). Test point on minor axis at
    // boundary: (0, 17) → 17²/17² = 1 → visible. Test point just past it,
    // (0, 20): 20²/17² ≈ 1.384 > 1 → outside vision; with `discovered: true`
    // that classifies as 'discovered'.
    const ovalSrc = makeSpec({
      id: 'oval',
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 7,
      populated: true,
      discovered: true,
    });
    const ovalSources = sourcesFor([ovalSrc]);
    const onMinorBoundary = makeSpec({
      populated: false,
      discovered: true,
      cx: 0,
      cy: 17,
    });
    const justOutsideMinor = makeSpec({
      populated: false,
      discovered: true,
      cx: 0,
      cy: 20,
    });
    expect(islandRenderState(onMinorBoundary, ovalSources)).toBe('visible');
    expect(islandRenderState(justOutsideMinor, ovalSources)).toBe('discovered');
    // Same point but never discovered → unknown short-circuits regardless of
    // ellipse geometry.
    const undiscovered = makeSpec({
      populated: false,
      discovered: false,
      cx: 0,
      cy: 20,
    });
    expect(islandRenderState(undiscovered, ovalSources)).toBe('unknown');
  });

  it('exposes VISION_PADDING_TILES at the canonical value', () => {
    // Locked-in Lighthouse-vision constant: 10 tiles past the island's own
    // ellipse edge for the baseline halo (distant scouting requires a
    // Lighthouse). Pinned so a re-tune must update this test consciously.
    expect(VISION_PADDING_TILES).toBe(10);
  });

  it('matches the demo layout: home visible, forest-ne visible (populated), desert-far discovered, coast-unknown unknown', () => {
    const populated = DEMO_ISLANDS_TEST_FIXTURE.filter((s) => s.populated);
    const visionSources = computeVisionSources(populated);
    const byId = new Map(DEMO_ISLANDS_TEST_FIXTURE.map((s) => [s.id, s] as const));
    const get = (id: string): IslandSpec => {
      const s = byId.get(id);
      if (!s) throw new Error(`demo missing ${id}`);
      return s;
    };
    // home (14,14) Plains at origin → baseline (24,24) ellipse.
    // forest-ne is hardcoded populated → 'visible' via the populated
    //   short-circuit, regardless of distance to home.
    // desert-far (80,60) → outside both home's (24,24) AND forest-ne's
    //   (20,20) baselines, but discovered → 'discovered'.
    // coast-unknown (180,0) → discovered=false → 'unknown'.
    expect(islandRenderState(get('home'), visionSources)).toBe('visible');
    expect(islandRenderState(get('forest-ne'), visionSources)).toBe('visible');
    expect(islandRenderState(get('desert-far'), visionSources)).toBe('discovered');
    expect(islandRenderState(get('coast-unknown'), visionSources)).toBe('unknown');
  });

  it('Lighthouse extends vision: a T2 Lighthouse on the source covers an island ~41 tiles away', () => {
    // Forest-ne-style fixture: at (40, -10), 41.2 tiles from home. Without
    // a Lighthouse this sits well outside home's (24, 24) baseline (2.95
    // ratio) → 'discovered'. With a `lighthouse_t2` on home at (0, 0)
    // local → 80-tile circle centred at (0.5, 0.5) → 41.2 < 80 → 'visible'.
    const homeWithLighthouse = makeSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      populated: true,
      discovered: true,
      buildings: [{ id: 'lh-2', defId: 'lighthouse_t2', x: 0, y: 0 }],
    });
    const sourcesWithLh = computeVisionSources([homeWithLighthouse]);
    const target = makeSpec({
      populated: false,
      discovered: true,
      cx: 40,
      cy: -10,
    });
    expect(islandRenderState(target, sourcesWithLh)).toBe('visible');
    // Sanity: the same target without the Lighthouse classifies as
    // 'discovered' under the new 10-tile baseline.
    const sourcesBaselineOnly = computeVisionSources([
      { ...homeWithLighthouse, buildings: [] },
    ]);
    expect(islandRenderState(target, sourcesBaselineOnly)).toBe('discovered');
  });
});

// §3.7 fresh-game contract — the production new-game world is one populated
// home island (plains, r=14, Stable, empty buildings) plus N procedural
// undiscovered neighbours. The heavy-seeded demo layout is retained only as
// DEMO_ISLANDS_TEST_FIXTURE for the "matches the demo layout" case above.

describe('makeInitialWorld — §3.7 fresh-game contract', () => {
  it('produces exactly one populated island (home) at world origin', () => {
    const w = makeInitialWorld(0);
    const populated = w.islands.filter((s) => s.populated);
    expect(populated).toHaveLength(1);
    const home = populated[0]!;
    expect(home.id).toBe('home');
    expect(home.cx).toBe(0);
    expect(home.cy).toBe(0);
    expect(home.biome).toBe('plains');
    expect(home.majorRadius).toBe(16);
    expect(home.minorRadius).toBe(16);
    expect(home.discovered).toBe(true);
    expect(home.modifiers).toEqual(['stable']);
  });

  it('home island starts with EMPTY buildings (§3.7 "no pre-placed buildings")', () => {
    const w = makeInitialWorld(0);
    const home = w.islands.find((s) => s.id === 'home')!;
    expect(home.buildings).toEqual([]);
  });

  it('defaults the world seed to WORLD_SEED when none is given', () => {
    expect(makeInitialWorld(0).seed).toBe(WORLD_SEED);
  });

  it('uses an explicit seed and that seed produces a different procedural world', () => {
    const a = makeInitialWorld(0, 'seed-A');
    const b = makeInitialWorld(0, 'seed-B');
    expect(a.seed).toBe('seed-A');
    expect(b.seed).toBe('seed-B');
    // Home is hand-placed and seed-independent; the procedural NEIGHBOURS differ.
    const sig = (w: ReturnType<typeof makeInitialWorld>): string =>
      w.islands
        .filter((s) => s.id !== 'home')
        .map((s) => `${s.id}@${s.cx},${s.cy}:${s.biome}`)
        .sort()
        .join('|');
    expect(sig(a)).not.toBe(sig(b));
    // Same seed ⇒ identical layout (determinism).
    expect(sig(makeInitialWorld(0, 'seed-A'))).toBe(sig(a));
  });

  it('appends procedural neighbours beyond the home island', () => {
    const w = makeInitialWorld(0);
    // Default gen options yield dozens of procedural islands at density 0.3;
    // we just assert "more than 1" so this isn't fragile to gen-table changes.
    expect(w.islands.length).toBeGreaterThan(1);
  });

  it('every non-home island starts unpopulated and undiscovered (dark world map)', () => {
    const w = makeInitialWorld(0);
    for (const spec of w.islands) {
      if (spec.id === 'home') continue;
      expect(spec.populated).toBe(false);
      expect(spec.discovered).toBe(false);
    }
  });

  it('seeds revealedCells only for home (no demo-neighbour cells)', () => {
    const w = makeInitialWorld(0);
    // home's cells should be present; every procedural island is
    // undiscovered, so its cells must not be revealed.
    expect(w.revealedCells.size).toBeGreaterThan(0);
    // Sanity: a far-out cell that no procedural island could reasonably
    // cover from home (the cell at +20, +20 in cell-coords ~ tile (320,320))
    // must not be revealed at start. This is a coarse smoke test of the
    // "only populated/discovered cells seed reveals" invariant.
    expect(w.revealedCells.has('20,20')).toBe(false);
  });

  it('produces no in-flight drones, routes, or vehicles at start', () => {
    const w = makeInitialWorld(0);
    expect(w.drones).toEqual([]);
    expect(w.routes).toEqual([]);
    expect(w.vehicles).toEqual([]);
  });

  it('home island terrain honours tileOverrides (SPEC §03 precedence)', () => {
    const w = makeInitialWorld(0);
    const home = w.islands.find((s) => s.id === 'home')!;
    // Fresh home has no overrides yet; terrainAt returns the biome closure.
    expect(home.terrainAt?.(0, 0)).toBeDefined();
    // Apply an override and assert it takes precedence.
    home.tileOverrides = { '0,0': 'ore' };
    expect(home.terrainAt?.(0, 0)).toBe('ore');
  });

  it("home's initial IslandState carries a §14 starter bootstrap kit (not empty — see startingInventory)", () => {
    // §3.7's literal "empty inventory" rule predates §14 placement costs:
    // every T1 building needs stone + wood, so an all-zero starter can't
    // bootstrap (no Mine → no extraction). The starter bundle below
    // INTENTIONALLY contradicts §3.7 — see `startingInventory` in world.ts.
    // Pins the rev-9 starter contract per rev-16 §12.9.3 + spec §03:
    // 9 line items sized to reach 1x battery_bank in <= 45 min.
    const w = makeInitialWorld(0);
    const home = w.islands.find((s) => s.id === 'home')!;
    const state = makeInitialIslandState(home, 0);
    // The starter bundle resources land at the rev-9-tuned figures.
    expect(state.inventory.stone).toBe(1200);
    expect(state.inventory.wood).toBe(600);
    expect(state.inventory.iron_ore).toBe(30);
    expect(state.inventory.coal).toBe(80);
    expect(state.inventory.iron_ingot).toBe(60);
    expect(state.inventory.bolt).toBe(25);
    expect(state.inventory.limestone).toBe(15);
    expect(state.inventory.saltwater_cell).toBe(4);
    expect(state.inventory.foundation_kit).toBe(1);
    // §rev-17 salvage cache — bootstraps the steel chain (scrap → steel_mill_scrap → steel → beam_mill → steel_beam).
    expect(state.inventory.scrap).toBe(5000);
    // steel intentionally 0 — player walks the iron→steel chain.
    expect(state.inventory.steel).toBe(0);
    // Every NON-starter resource is 0.
    const starterResources = new Set<ResourceId>([
      'stone', 'wood', 'iron_ore', 'coal', 'iron_ingot', 'bolt',
      'limestone', 'saltwater_cell', 'foundation_kit', 'scrap',
    ]);
    for (const r of ALL_RESOURCES) {
      if (starterResources.has(r)) continue;
      expect(state.inventory[r], `inventory.${r} should be 0`).toBe(0);
    }
  });

  it("home's initial IslandState starts at level 1, XP 0, no skill points, no specialization", () => {
    // §3.7 "Level 1, 0 XP, 0 skill points." Companion to the empty-
    // inventory test above — pins the rest of the per-island starting
    // state.
    const w = makeInitialWorld(0);
    const home = w.islands.find((s) => s.id === 'home')!;
    const state = makeInitialIslandState(home, 0);
    expect(state.level).toBe(1);
    expect(state.xp).toBe(0);
    expect(state.unspentSkillPoints).toBe(0);
    expect(state.unlockedEdges.size).toBe(0);
    expect(state.aiCoreCrafted).toBe(false);
    expect(state.ascendantCoreCrafted).toBe(false);
  });
});

describe('findPopulatedIslandAt', () => {
  // Hand-built fixture mirroring a tiny slice of the demo layout: home at
  // origin (r=14), forest-ne at (40, -10) (r=10), desert-far at (80, 60)
  // (r=12, unpopulated/discovered). Active-island selection ignores
  // discovered-but-not-populated islands; only populated count.
  const fixture: IslandSpec[] = [
    {
      id: 'home',
      name: 'home',
      biome: 'plains',
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
    },
    {
      id: 'forest-ne',
      name: 'forest-ne',
      biome: 'forest',
      cx: 40,
      cy: -10,
      majorRadius: 10,
      minorRadius: 10,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
    },
    {
      id: 'desert-far',
      name: 'desert-far',
      biome: 'desert',
      cx: 80,
      cy: 60,
      majorRadius: 12,
      minorRadius: 12,
      populated: false,
      discovered: true,
      buildings: [],
      modifiers: [],
    },
  ];

  it('returns the populated island whose ellipse covers the click point', () => {
    const r = findPopulatedIslandAt(0, 0, fixture);
    expect(r?.id).toBe('home');
  });

  it('matches an off-centre but inscribed click', () => {
    // (40, -10) is forest-ne's centre; (43, -8) is well inside its r=10 disk.
    const r = findPopulatedIslandAt(43, -8, fixture);
    expect(r?.id).toBe('forest-ne');
  });

  it('returns null on open ocean (no island covers the point)', () => {
    const r = findPopulatedIslandAt(200, 200, fixture);
    expect(r).toBeNull();
  });

  it('returns null when the click lands on an unpopulated (but discovered) island', () => {
    // desert-far is discovered but not populated — should be ignored.
    const r = findPopulatedIslandAt(80, 60, fixture);
    expect(r).toBeNull();
  });

  it('rejects a click just outside the ellipse boundary', () => {
    // home has r=14; (15, 0) is one tile outside.
    const r = findPopulatedIslandAt(15, 0, fixture);
    expect(r).toBeNull();
  });

  it('accepts a click on the ellipse boundary (<= 1)', () => {
    // (14, 0) lies exactly on the r=14 ellipse — boundary is inclusive.
    const r = findPopulatedIslandAt(14, 0, fixture);
    expect(r?.id).toBe('home');
  });
});

// renameIsland — pure validation + mutation for the player-mutable display
// name. The internal `id` must never change; only `name` is touched.

describe('renameIsland', () => {
  it('accepts a normal 1-32 char name and mutates spec.name', () => {
    const s = makeSpec({ id: 'home', name: 'home' });
    const r = renameIsland(s, 'My Cozy Outpost');
    expect(r.ok).toBe(true);
    expect(s.name).toBe('My Cozy Outpost');
    // Internal id must be untouched.
    expect(s.id).toBe('home');
  });

  it('trims surrounding whitespace before applying', () => {
    const s = makeSpec({ id: 'home', name: 'home' });
    const r = renameIsland(s, '   The Forge   ');
    expect(r.ok).toBe(true);
    expect(s.name).toBe('The Forge');
  });

  it('rejects an empty name (and does not mutate)', () => {
    const s = makeSpec({ id: 'home', name: 'home' });
    const r = renameIsland(s, '');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty');
    expect(s.name).toBe('home');
  });

  it('rejects a whitespace-only name as empty (and does not mutate)', () => {
    const s = makeSpec({ id: 'home', name: 'home' });
    const r = renameIsland(s, '   ');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty');
    expect(s.name).toBe('home');
  });

  it('accepts a name at the 32-char boundary', () => {
    const s = makeSpec({ id: 'home', name: 'home' });
    const exactly32 = 'a'.repeat(ISLAND_NAME_MAX_LEN);
    expect(exactly32.length).toBe(32);
    const r = renameIsland(s, exactly32);
    expect(r.ok).toBe(true);
    expect(s.name).toBe(exactly32);
  });

  it('rejects a 33-char name (one over the cap)', () => {
    const s = makeSpec({ id: 'home', name: 'home' });
    const tooLong = 'a'.repeat(ISLAND_NAME_MAX_LEN + 1);
    const r = renameIsland(s, tooLong);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too-long');
    expect(s.name).toBe('home');
  });

  it('rejects names containing ascii control characters', () => {
    const s = makeSpec({ id: 'home', name: 'home' });
    // Tab character (0x09) sits inside the control-char range \x00-\x1F.
    const r = renameIsland(s, 'New\tName');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('control-char');
    expect(s.name).toBe('home');
    // Newline / DEL likewise rejected.
    expect(renameIsland(s, 'Line\nBreak').ok).toBe(false);
    expect(renameIsland(s, 'Bell\x07Char').ok).toBe(false);
    expect(renameIsland(s, 'Del\x7FChar').ok).toBe(false);
  });
});

// validateIslandName — pure predicate underlying `renameIsland` and the
// construction-ui name field. Tested independently so both call sites
// share the same accept/reject behaviour.

describe('validateIslandName', () => {
  it('accepts a normal name and returns the trimmed string', () => {
    const r = validateIslandName('My Cozy Outpost');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe('My Cozy Outpost');
  });

  it('trims surrounding whitespace on the returned name', () => {
    const r = validateIslandName('   The Forge   ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe('The Forge');
  });

  it('rejects an empty string with reason "empty"', () => {
    const r = validateIslandName('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty');
  });

  it('rejects a whitespace-only string with reason "empty"', () => {
    const r = validateIslandName('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty');
  });

  it('accepts a name at exactly ISLAND_NAME_MAX_LEN chars', () => {
    const exactly32 = 'a'.repeat(ISLAND_NAME_MAX_LEN);
    const r = validateIslandName(exactly32);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe(exactly32);
  });

  it('rejects a name one over the cap with reason "too-long"', () => {
    const tooLong = 'a'.repeat(ISLAND_NAME_MAX_LEN + 1);
    const r = validateIslandName(tooLong);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too-long');
  });

  it('rejects ascii control chars with reason "control-char"', () => {
    // Tab (0x09), newline, bell (0x07), DEL (0x7F) — all in the
    // control range and all rejected.
    for (const bad of ['Tab\tName', 'Line\nBreak', 'Bell\x07Char', 'Del\x7FChar']) {
      const r = validateIslandName(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('control-char');
    }
  });
});



describe('attachTerrainAt — tileOverrides precedence', () => {
  function makeSpec(overrides?: Record<string, TerrainKind>): IslandSpec {
    return attachTerrainAt({
      id: 'test-island',
      name: 'test-island',
      cx: 100,
      cy: 100,
      majorRadius: 10,
      minorRadius: 10,
      biome: 'plains',
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
      ...(overrides ? { tileOverrides: overrides } : {}),
    });
  }

  it('returns the override kind when one is set', () => {
    const spec = makeSpec({ '0,0': 'magma_vent' });
    expect(spec.terrainAt?.(0, 0)).toBe('magma_vent');
  });

  it('falls through to the biome closure when no override matches', () => {
    const spec = makeSpec({ '0,0': 'magma_vent' });
    // (3, 3) was not overridden; biome closure decides.
    const k = spec.terrainAt?.(3, 3);
    expect(k).toBeDefined();
    expect(k).not.toBe('magma_vent');
  });

  it('reads tileOverrides BY REFERENCE — insertion after closure-build is observed', () => {
    const spec = makeSpec();
    // `terrainAt` was bound before tileOverrides existed; insert and re-query.
    spec.tileOverrides = { '5,5': 'uranium_vein' };
    expect(spec.terrainAt?.(5, 5)).toBe('uranium_vein');
  });

  it('behaves identically to a legacy spec when tileOverrides is undefined', () => {
    const legacy = makeSpec();
    expect(legacy.tileOverrides).toBeUndefined();
    expect(legacy.terrainAt?.(2, 2)).toBeDefined();
  });
});


describe('islandConstituents', () => {
  it('islandConstituents carries biome: primary from spec, extras from entry', () => {
    const spec = {
      id: 'i1', biome: 'plains' as const,
      majorRadius: 10, minorRadius: 8, cx: 0, cy: 0,
      buildings: [],
      extraEllipses: [
        { biome: 'volcanic' as const, major: 6, minor: 6, rotation: 0, offsetX: 12, offsetY: 0 },
        // legacy-shaped entry missing biome (cast to exercise the ?? fallback)
        { major: 5, minor: 5, rotation: 0, offsetX: -12, offsetY: 0 } as unknown as never,
      ],
    } as unknown as Parameters<typeof islandConstituents>[0];

    const cs = islandConstituents(spec);
    expect(cs).toHaveLength(3);
    expect(cs[0]!.biome).toBe('plains');     // primary
    expect(cs[1]!.biome).toBe('volcanic');   // explicit extra biome
    expect(cs[2]!.biome).toBe('plains');     // legacy extra falls back to spec.biome
  });
});


describe('constituentBiomeAt / islandConstituentBiomes', () => {
  it('non-merged island: inside tile uses spec.biome, outside returns undefined', () => {
    const spec = makeSpec({ biome: 'forest', majorRadius: 5, minorRadius: 5 });
    expect(tileInscribedInEllipse(0, 0, 5, 5)).toBe(true);
    expect(constituentBiomeAt(spec, 0, 0)).toBe('forest');
    expect(tileInscribedInEllipse(10, 0, 5, 5)).toBe(false);
    expect(constituentBiomeAt(spec, 10, 0)).toBeUndefined();
  });

  it('merged island: each lobe resolves to its own biome', () => {
    const spec = makeSpec({
      biome: 'forest',
      majorRadius: 5,
      minorRadius: 5,
      extraEllipses: [
        {
          biome: 'volcanic' as const,
          originId: 'absorbed',
          major: 6,
          minor: 6,
          rotation: 0,
          offsetX: 12,
          offsetY: 0,
        },
      ],
    });
    expect(tileInscribedInEllipse(0, 0, 5, 5)).toBe(true);
    expect(constituentBiomeAt(spec, 0, 0)).toBe('forest');
    expect(tileInscribedInEllipse(11 - 12, 0, 6, 6)).toBe(true);
    expect(constituentBiomeAt(spec, 11, 0)).toBe('volcanic');
  });

  it('overlap precedence: earliest inscribing constituent wins', () => {
    const spec = makeSpec({
      biome: 'forest',
      majorRadius: 5,
      minorRadius: 5,
      extraEllipses: [
        {
          biome: 'volcanic' as const,
          originId: 'absorbed',
          major: 5,
          minor: 5,
          rotation: 0,
          offsetX: 3,
          offsetY: 0,
        },
      ],
    });
    // (0,0) is inside both constituents; primary is earliest.
    expect(tileInscribedInEllipse(0, 0, 5, 5)).toBe(true);
    expect(tileInscribedInEllipse(0 - 3, 0, 5, 5)).toBe(true);
    expect(constituentBiomeAt(spec, 0, 0)).toBe('forest');
    // (5,0) is inside the extra only.
    expect(tileInscribedInEllipse(5, 0, 5, 5)).toBe(false);
    expect(tileInscribedInEllipse(5 - 3, 0, 5, 5)).toBe(true);
    expect(constituentBiomeAt(spec, 5, 0)).toBe('volcanic');
  });

  it('islandConstituentBiomes collects distinct biomes', () => {
    const single = makeSpec({ biome: 'forest' });
    expect(islandConstituentBiomes(single)).toEqual(new Set(['forest']));

    const merged = makeSpec({
      biome: 'forest',
      extraEllipses: [
        {
          biome: 'volcanic' as const,
          originId: 'a',
          major: 6,
          minor: 6,
          rotation: 0,
          offsetX: 12,
          offsetY: 0,
        },
        {
          biome: 'volcanic' as const,
          originId: 'b',
          major: 4,
          minor: 4,
          rotation: 0,
          offsetX: -12,
          offsetY: 0,
        },
      ],
    });
    const biomes = islandConstituentBiomes(merged);
    expect(biomes.size).toBe(2);
    expect(biomes.has('forest')).toBe(true);
    expect(biomes.has('volcanic')).toBe(true);
  });
});
