import { describe, expect, it } from 'vitest';

import { positionIsFree, regionDiscoveredOrVisible } from './construction-gate.js';
import {
  validateArtificialPlacement, maxGrowthFootprintTouches, founderRangeGap,
  naturalConstituentCount, attributedArtificialCount,
  ARTIFICIAL_RANGE_TILES, ARTIFICIAL_RATIO,
} from './construction-gate.js';
import { tileToCell, cellKey } from './discovery.js';
import { tileInscribedInEllipse } from './island.js';
import type { IslandSpec, WorldState } from './world.js';

/** Minimal WorldState carrying only the geometry `positionIsFree` reads. */
function worldWithIslands(islands: Array<Partial<IslandSpec>>): WorldState {
  return { islands, revealedCells: new Set() } as unknown as WorldState;
}

/** Minimal WorldState — regionDiscoveredOrVisible only reads revealedCells. */
function worldWith(revealed: Iterable<string>): WorldState {
  return { revealedCells: new Set(revealed) } as unknown as WorldState;
}

/** Every cell key the inscribed footprint of an ellipse at (cx,cy) occupies. */
function footprintCells(cx: number, cy: number, major: number, minor: number): string[] {
  const keys = new Set<string>();
  const xMin = -Math.ceil(major), xMax = Math.ceil(major) - 1;
  const yMin = -Math.ceil(minor), yMax = Math.ceil(minor) - 1;
  for (let dy = yMin; dy <= yMax; dy++) {
    for (let dx = xMin; dx <= xMax; dx++) {
      if (!tileInscribedInEllipse(dx, dy, major, minor)) continue;
      const { cellX, cellY } = tileToCell(cx + dx, cy + dy);
      keys.add(cellKey(cellX, cellY));
    }
  }
  return [...keys];
}

describe('regionDiscoveredOrVisible', () => {
  it('returns true when every footprint cell is revealed', () => {
    const cells = footprintCells(100, 100, 4, 4);
    expect(regionDiscoveredOrVisible(worldWith(cells), 100, 100, 4, 4)).toBe(true);
  });

  it('returns false when any footprint cell is missing from revealedCells', () => {
    const cells = footprintCells(100, 100, 4, 4);
    expect(cells.length).toBeGreaterThan(0);
    const missingOne = cells.slice(1); // drop the first cell
    expect(regionDiscoveredOrVisible(worldWith(missingOne), 100, 100, 4, 4)).toBe(false);
  });

  it('returns false against an empty revealed set', () => {
    expect(regionDiscoveredOrVisible(worldWith([]), 0, 0, 4, 4)).toBe(false);
  });
});

describe('positionIsFree (land-footprint overlap)', () => {
  it('rejects a candidate whose inscribed footprint overlaps an existing island', () => {
    const w = worldWithIslands([{ id: 'a', cx: 0, cy: 0, majorRadius: 6, minorRadius: 6 }]);
    // centres 2 tiles apart, both radius 6 → footprints heavily overlap.
    expect(positionIsFree(w, 2, 0, 6, 6)).toBe(false);
  });

  it('allows a candidate stacked off the MINOR axis of an elongated island', () => {
    // Existing island is wide in X (major 20) and thin in Y (minor 2). A candidate
    // far along Y does not overlap its land. The old circular major-radius check
    // wrongly rejected this (dist 12 < 20+5+buffer); the tile-footprint check
    // correctly allows it.
    const w = worldWithIslands([{ id: 'a', cx: 0, cy: 0, majorRadius: 20, minorRadius: 2 }]);
    expect(positionIsFree(w, 0, 12, 5, 5)).toBe(true);
  });

  it('allows a candidate far from every island', () => {
    const w = worldWithIslands([{ id: 'a', cx: 0, cy: 0, majorRadius: 6, minorRadius: 6 }]);
    expect(positionIsFree(w, 100, 100, 5, 5)).toBe(true);
  });
});

/** Full IslandSpec with plains defaults — the anti-leapfrog gates read
 *  populated/artificial/founderId/extraEllipses/biome/radii, so a richer spec
 *  than `worldWithIslands`' partials is needed. */
function spec(partial: Partial<IslandSpec> & { id: string; cx: number; cy: number }): IslandSpec {
  return {
    name: partial.id, biome: 'plains', majorRadius: 10, minorRadius: 10,
    populated: true, discovered: true, buildings: [], modifiers: [],
    ...partial,
  } as IslandSpec;
}
/** WorldState carrying only the `islands` array the gates read. Named `worldOf`
 *  (not `worldWith`) to avoid colliding with the revealedCells helper above. */
function worldOf(...islands: IslandSpec[]): WorldState {
  return { islands } as unknown as WorldState;
}

describe('§2.5 anti-leapfrog placement gates', () => {
  // Plains max radius is 28 (BIOME_MAX_RADII). A populated plains island at
  // r10 could grow to r28: its max-growth footprint reaches |x| < 28.
  it('anchor: rejects inside a populated island\'s max-growth footprint even when clear of its current footprint', () => {
    const nat = spec({ id: 'nat-1', cx: 0, cy: 0 });          // r10 now, max 28
    const world = worldOf(nat);
    // candidate r4 centred at x=28: current footprint (r10, reach ~x=9) is 15+
    // tiles clear, but a max-grown r28 footprint reaches ~x=26-27 and the r4
    // candidate's inscribed tiles start ~x=25 — definite overlap, not a
    // borderline 1-tile gap (inscribed footprints run 1-2 tiles inside the
    // mathematical ellipse).
    expect(maxGrowthFootprintTouches(world, 28, 0, 4, 4)).toBe(true);
    const v = validateArtificialPlacement(world, nat, 28, 0, 4, 4);
    expect(v).toEqual({ ok: false, reason: 'leapfrog-anchor' });
  });

  it('anchor: accepts just beyond the max-growth footprint', () => {
    const nat = spec({ id: 'nat-1', cx: 0, cy: 0 });
    const world = worldOf(nat);
    // candidate r4 centred at x=40: max-grown reach 28 + candidate 4 → gap ≈ 8 tiles.
    expect(maxGrowthFootprintTouches(world, 40, 0, 4, 4)).toBe(false);
    expect(validateArtificialPlacement(world, nat, 40, 0, 4, 4).ok).toBe(true);
  });

  it('anchor: ignores unpopulated islands (they cannot grow)', () => {
    const ghost = spec({ id: 'nat-2', cx: 0, cy: 0, populated: false });
    const world = worldOf(ghost, spec({ id: 'founder', cx: 200, cy: 0 }));
    expect(maxGrowthFootprintTouches(world, 30, 0, 4, 4)).toBe(false);
  });

  it('range: measures the Chebyshev gap between constituent bounding boxes', () => {
    const founder = spec({ id: 'f', cx: 0, cy: 0 });          // bbox reaches x=10
    // candidate r4 at x=62: gap = 62 − 10 − 4 = 48 → exactly at the limit, allowed.
    expect(founderRangeGap(founder, 62, 0, 4, 4)).toBe(ARTIFICIAL_RANGE_TILES);
    // x=63 → gap 49 → out of range.
    expect(founderRangeGap(founder, 63, 0, 4, 4)).toBe(49);
  });

  it('range: rejects beyond ARTIFICIAL_RANGE_TILES from the founder, measured from the nearest constituent', () => {
    // founder with a lobe stretching toward the candidate: range measured from the lobe, not the primary.
    const founder = spec({
      id: 'f', cx: 0, cy: 0,
      extraEllipses: [{ biome: 'plains', originId: 'gen-1-0', major: 10, minor: 10, rotation: 0, offsetX: 40, offsetY: 0 }],
    });
    const world = worldOf(founder);
    // candidate at x=110: gap to primary = 110−10−4 = 96 > 48, but to lobe (reaches x=50) = 110−50−4 = 56 > 48 → reject.
    expect(validateArtificialPlacement(world, founder, 110, 0, 4, 4)).toEqual({ ok: false, reason: 'out-of-range' });
    // candidate at x=100: gap to lobe = 100−50−4 = 46 ≤ 48 → allowed (and clear of anchor: plains lobe max 28
    // ⇒ max-grown lobe reaches x=40+28=68; candidate r4 at 100 reaches 96).
    expect(validateArtificialPlacement(world, founder, 100, 0, 4, 4).ok).toBe(true);
  });

  it('ratio: counts natural constituents by originId prefix', () => {
    const merged = spec({
      id: 'nat-1', cx: 0, cy: 0,
      extraEllipses: [
        { biome: 'plains', originId: 'gen-2-0', major: 8, minor: 8, rotation: 0, offsetX: 20, offsetY: 0 },
        { biome: 'plains', originId: 'art-50-0', major: 8, minor: 8, rotation: 0, offsetX: 40, offsetY: 0, founderId: 'nat-1' },
      ],
    });
    expect(naturalConstituentCount(merged)).toBe(2);          // primary + gen lobe; art lobe excluded
    const artFounder = spec({ id: 'art-9-9', cx: 0, cy: 0, artificial: true });
    expect(naturalConstituentCount(artFounder)).toBe(0);      // artificial primary is not natural
  });

  it('ratio: attributedArtificialCount counts standalone islands AND absorbed lobes', () => {
    const founder = spec({ id: 'nat-1', cx: 0, cy: 0 });
    const standalone = spec({ id: 'art-80-0', cx: 80, cy: 0, artificial: true, founderId: 'nat-1' });
    const other = spec({
      id: 'nat-2', cx: 200, cy: 0,
      extraEllipses: [{ biome: 'plains', originId: 'art-90-0', major: 6, minor: 6, rotation: 0, offsetX: 30, offsetY: 0, founderId: 'nat-1' }],
    });
    const world = worldOf(founder, standalone, other);
    expect(attributedArtificialCount(world, 'nat-1')).toBe(2);
    expect(attributedArtificialCount(world, 'nat-2')).toBe(0);
  });

  it('ratio: rejects the (2N+1)-th artificial build and blocks artificial founders outright', () => {
    expect(ARTIFICIAL_RATIO).toBe(2);                         // budget math below assumes 2·N
    // founder: 1 natural constituent → budget = 2. Two attributed already → reject the 3rd.
    const founder = spec({ id: 'nat-1', cx: 0, cy: 0 });
    const a1 = spec({ id: 'art-100-0', cx: 100, cy: 0, artificial: true, founderId: 'nat-1' });
    const a2 = spec({ id: 'art-100-40', cx: 100, cy: 40, artificial: true, founderId: 'nat-1' });
    const world = worldOf(founder, a1, a2);
    // position picked clear of every anchor/range concern: within 48 of founder bbox, away from max-growth reaches.
    // anchor clear: founder max-growth reach 44 − 28 − 4 = 12 tiles gap at (0,44).
    const v = validateArtificialPlacement(world, founder, 0, 44, 4, 4);
    expect(v).toEqual({ ok: false, reason: 'ratio-exceeded' });
    // an artificial founder (0 natural constituents) can never build:
    // (its own max-growth footprint: r10→cap28 reaches y≈328; candidate r4 at 344 reaches y≈340 → gap ~12, clear.)
    const artFounder = spec({ id: 'art-300-0', cx: 300, cy: 300, artificial: true, populated: true });
    const w2 = worldOf(artFounder);
    expect(validateArtificialPlacement(w2, artFounder, 300, 344, 4, 4)).toEqual({ ok: false, reason: 'ratio-exceeded' });
  });
});
