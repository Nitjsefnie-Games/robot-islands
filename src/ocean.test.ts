// Unit tests for the pure fog-cell computation extracted from the ocean
// fog-overlay renderer. `renderOceanFogOverlay` itself is render-only
// (PixiJS Container/Sprite) and not exercised here — `computeFogCells`
// carries the entire interesting predicate.
//
// The headline regression covered: discovered-but-unrevealed cells that
// overlap a populated island's vision halo MUST NOT be in the fog set.
// Otherwise the fog overlay paints UNKNOWN_BLUE on top of the ocean's
// VISION_BLUE square (and the weather overlay then composites
// light_fog rgba(224,232,240,0.18) over that), producing the solid
// dark-grey square the user reported after a drone discovery.

import { describe, expect, it } from 'vitest';

import { computeFogCells } from './ocean.js';
import { type VisionSource } from './vision-source.js';
import { type IslandSpec } from './world.js';

function makeIslandSpec(over: Partial<IslandSpec>): IslandSpec {
  return {
    id: 'spec',
    name: 'spec',
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

describe('computeFogCells', () => {
  it('returns empty when there are no discovered islands', () => {
    const undiscovered = makeIslandSpec({ id: 'u', cx: 0, cy: 0, discovered: false });
    const fog = computeFogCells([undiscovered], new Set<string>(), []);
    expect(fog.size).toBe(0);
  });

  it('fogs every unrevealed cell of a discovered island when no vision source covers it', () => {
    // Island far enough from origin that its footprint cells don't overlap
    // any vision halo we'd construct around (0,0). With majorRadius=5 +
    // minorRadius=5 centred at tile (200, 200) the footprint sits well inside
    // cells around (12..13, 12..13) — comfortably outside any (0,0)-centred
    // padded ellipse we'd test with.
    const neighbour = makeIslandSpec({
      id: 'neigh',
      cx: 200,
      cy: 200,
      majorRadius: 5,
      minorRadius: 5,
      discovered: true,
    });
    const fog = computeFogCells([neighbour], new Set<string>(), []);
    // Sanity: there IS at least one fogged cell (the neighbour's footprint).
    expect(fog.size).toBeGreaterThan(0);
  });

  it('skips revealed cells (current behaviour preserved)', () => {
    const neighbour = makeIslandSpec({
      id: 'neigh',
      cx: 200,
      cy: 200,
      majorRadius: 5,
      minorRadius: 5,
      discovered: true,
    });
    // Pre-compute the full fog set with no reveals, pick one of its cells,
    // mark it revealed, re-compute, and confirm it's gone while the others
    // are still there.
    const beforeReveal = computeFogCells([neighbour], new Set<string>(), []);
    expect(beforeReveal.size).toBeGreaterThan(0);
    const someCell = [...beforeReveal][0]!;
    const revealedCells = new Set<string>([someCell]);
    const afterReveal = computeFogCells([neighbour], revealedCells, []);
    expect(afterReveal.has(someCell)).toBe(false);
    expect(afterReveal.size).toBe(beforeReveal.size - 1);
  });

  it('REGRESSION: vision overrides fog on overlap cells (drone-discovery dark-square bug)', () => {
    // Setup:
    //   - Home island, populated. Vision source is a wide ellipse at (0,0)
    //     with major=major=100 — covers the full neighbour footprint at
    //     (40,0).
    //   - Neighbour island, discovered (not populated). Footprint cells sit
    //     entirely inside the home vision halo.
    //   - `revealedCells` is empty — the player hasn't manually revealed
    //     any cell yet. Without the fix, every footprint cell of the
    //     neighbour would be in the fog set; with the fix, none should be
    //     (vision wins).
    const home = makeIslandSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      majorRadius: 10,
      minorRadius: 10,
      populated: true,
      discovered: true,
    });
    const neighbour = makeIslandSpec({
      id: 'neigh',
      cx: 40,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      discovered: true,
    });
    const homeVision: VisionSource = {
      kind: 'ellipse',
      cx: 0,
      cy: 0,
      major: 100,
      minor: 100,
      offsetX: 0,
      offsetY: 0,
    };

    // Without vision: neighbour's unrevealed footprint cells WOULD be fogged.
    const fogWithoutVision = computeFogCells(
      [home, neighbour],
      new Set<string>(),
      [],
    );
    expect(fogWithoutVision.size).toBeGreaterThan(0);

    // With vision: the same footprint cells are excluded — vision lights
    // through the fog.
    const fogWithVision = computeFogCells(
      [home, neighbour],
      new Set<string>(),
      [homeVision],
    );
    expect(fogWithVision.size).toBe(0);
  });

  it('partial vision overlap: cells inside vision are excluded, cells outside still fog', () => {
    // Setup:
    //   - Discovered neighbour at tile (50, 0) with a wide-ish footprint
    //     (major=20, minor=5) so its cells span cell-x ≈ 1..4 (16-tile cells).
    //   - Home vision source covers ONLY cell column 1 (a small circle near
    //     the neighbour's near edge), leaving cell columns 2..4 outside.
    //   - revealedCells empty.
    //   - Assertion: fog set excludes any cell that intersects the vision
    //     circle and includes at least one cell outside the vision circle.
    const neighbour = makeIslandSpec({
      id: 'neigh',
      cx: 50,
      cy: 0,
      majorRadius: 20,
      minorRadius: 5,
      discovered: true,
    });
    // Circle radius 8 at tile (30, 0) → covers cells whose AABB the circle
    // touches. Cell-x 1 spans tiles [16, 32) which the circle reaches; cell-x
    // 2 spans [32, 48) which it just barely clips on the right (centre 30 + r 8 = 38).
    // Sized so vision-cells is a strict subset of the neighbour's footprint.
    const visionSrc: VisionSource = { kind: 'circle', cx: 30, cy: 0, radius: 8 };

    const fogWithoutVision = computeFogCells(
      [neighbour],
      new Set<string>(),
      [],
    );
    const fogWithVision = computeFogCells(
      [neighbour],
      new Set<string>(),
      [visionSrc],
    );

    // Vision shrinks the fog set (some cells now excluded) but not to zero
    // (cells far from the vision circle remain fogged).
    expect(fogWithVision.size).toBeLessThan(fogWithoutVision.size);
    expect(fogWithVision.size).toBeGreaterThan(0);

    // Every cell present in `fogWithVision` is also in `fogWithoutVision`
    // (vision can only REMOVE cells, never add them).
    for (const k of fogWithVision) {
      expect(fogWithoutVision.has(k)).toBe(true);
    }
  });

  it('undiscovered islands are still skipped even when vision sources exist', () => {
    // Belt-and-suspenders: the discovered filter has to run BEFORE the vision
    // exclusion; otherwise an exotic ordering could let undiscovered footprints
    // leak into the fog set.
    const undiscovered = makeIslandSpec({
      id: 'u',
      cx: 200,
      cy: 200,
      discovered: false,
    });
    const wideVision: VisionSource = {
      kind: 'circle', cx: 0, cy: 0, radius: 1000,
    };
    const fog = computeFogCells([undiscovered], new Set<string>(), [wideVision]);
    expect(fog.size).toBe(0);
  });
});
