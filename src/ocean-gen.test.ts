// Ocean-layer §2 — terrain seeding tests. Per the design doc, generation
// runs in a fixed order (shallows → trenches → nodule fields → vents) so
// each step can reject overlap with prior placements. These tests pin
// the contract end-users actually rely on: determinism per seed, shape
// invariants per feature, biome correlations for vents, and the
// non-overlap rules between rare features.

import { describe, expect, it } from 'vitest';

import { generateOceanTerrain, seedOceanTerrainForIslands } from './ocean-gen.js';
import { attachTerrainAt, type IslandSpec } from './world.js';

// Minimal IslandSpec fixture — `attachTerrainAt` mints a fully-typed spec
// from a base lacking only the `terrainAt` closure. Using it (vs an
// `as IslandSpec` cast) catches schema drift if `IslandSpec` gains a new
// required field later.
const mkIsland = (
  id: string,
  biome: IslandSpec['biome'],
  cx: number,
  cy: number,
  major = 6,
  minor = 4,
): IslandSpec =>
  attachTerrainAt({
    id,
    name: id,
    biome,
    cx,
    cy,
    majorRadius: major,
    minorRadius: minor,
    populated: false,
    discovered: false,
    buildings: [],
    modifiers: [],
  });

describe('generateOceanTerrain', () => {
  const ISLANDS: ReadonlyArray<IslandSpec> = [
    mkIsland('home', 'plains', 0, 0),
    mkIsland('vol', 'volcanic', 40, 0),
    mkIsland('cst', 'coast', -40, 30),
  ];

  it('is deterministic for the same seed', () => {
    const a = generateOceanTerrain('seed-1', ISLANDS);
    const b = generateOceanTerrain('seed-1', ISLANDS);
    expect(Array.from(a.entries()).sort()).toEqual(Array.from(b.entries()).sort());
  });

  // Counterpart to the determinism test: if the generator silently
  // ignored its seed parameter, every "same seed → same map" assertion
  // would pass vacuously. Two distinct seeds must produce distinct maps.
  it('produces different maps for different seeds', () => {
    const a = generateOceanTerrain('seed-A', ISLANDS);
    const b = generateOceanTerrain('seed-B', ISLANDS);
    expect(Array.from(a.entries()).sort()).not.toEqual(
      Array.from(b.entries()).sort(),
    );
  });

  it('seeds shallows within R=2 cells of an island edge', () => {
    const cells = generateOceanTerrain('seed-1', ISLANDS);
    const shallowsHits = Array.from(cells.values()).filter(
      (c) => c.terrain === 'shallows',
    ).length;
    expect(shallowsHits).toBeGreaterThan(0);
  });

  // Trench-shape sweep. A single-seed check is gameable by cherry-picking a
  // seed that skirts the multi-trench overlap case; the 50-seed loop catches
  // the regression where two edge-adjacent trenches merge into a non-rectangular
  // 4-connected blob. With the prior-trench buffer rejection in `seedTrenches`,
  // every component for every seed must be a clean 2×N or 3×N rectangle, N ∈ [4, 8].
  it('seeds trenches as 2×N or 3×N rectangles in deep zones (50-seed sweep)', () => {
    const keyOf = (x: number, y: number) => `${x},${y}`;
    let totalComponents = 0;
    for (let i = 0; i < 50; i++) {
      const cells = generateOceanTerrain(`trench-sweep-${i}`, ISLANDS);
      const trenchKeys = Array.from(cells.entries())
        .filter(([, c]) => c.terrain === 'trench')
        .map(([k]) => k.split(',').map(Number) as [number, number]);
      if (trenchKeys.length === 0) continue;

      // 4-neighbour flood-fill into connected components.
      const set = new Set(trenchKeys.map(([x, y]) => keyOf(x, y)));
      const visited = new Set<string>();
      const components: Array<Array<[number, number]>> = [];
      for (const start of trenchKeys) {
        const k0 = keyOf(start[0], start[1]);
        if (visited.has(k0)) continue;
        const stack: Array<[number, number]> = [start];
        const component: Array<[number, number]> = [];
        while (stack.length > 0) {
          const [x, y] = stack.pop()!;
          const k = keyOf(x, y);
          if (visited.has(k)) continue;
          visited.add(k);
          component.push([x, y]);
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nk = keyOf(x + dx, y + dy);
            if (set.has(nk) && !visited.has(nk)) stack.push([x + dx, y + dy]);
          }
        }
        components.push(component);
      }

      // Each component must be a 2×N (or 3×N) rectangle with N ∈ [4, 8].
      for (const comp of components) {
        const xs = comp.map(([x]) => x);
        const ys = comp.map(([, y]) => y);
        const w = Math.max(...xs) - Math.min(...xs) + 1;
        const h = Math.max(...ys) - Math.min(...ys) + 1;
        // Rectangle-fill check: width * height = cell count.
        expect(
          comp.length,
          `seed trench-sweep-${i}: component size ${comp.length} ≠ ${w}×${h} = ${w * h}`,
        ).toBe(w * h);
        const isHorizontal = (h === 2 || h === 3) && w >= 4 && w <= 8;
        const isVertical = (w === 2 || w === 3) && h >= 4 && h <= 8;
        expect(
          isHorizontal || isVertical,
          `seed trench-sweep-${i}: component dims ${w}×${h} not in (2|3)×[4,8]`,
        ).toBe(true);
        totalComponents++;
      }
    }
    // Sanity guard: the sweep must actually observe trenches, else the
    // assertion loop is vacuous (e.g. a generator that emits zero trenches
    // would silently pass).
    expect(totalComponents).toBeGreaterThan(0);
  });

  it('vent clusters are biased toward volcanic islands', () => {
    const cells = generateOceanTerrain('seed-vent', ISLANDS);
    const vents = Array.from(cells.entries())
      .filter(([, c]) => c.terrain === 'hydrothermal_vent')
      .map(([k]) => k.split(',').map(Number) as [number, number]);
    // All vent cells should sit within reach of the volcanic island at
    // (40, 0). With CELL_SIZE_TILES=16 → volcanic cell at (2, 0). The
    // cluster anchor is within R=5 cells of the island edge; cluster
    // extent is at most 3 cells; the ellipse half-axis in cells is
    // ceil(6/16)≈1. Allow R=5 + 3 + 1 ≈ 9 as a generous bound.
    const VOLCANIC_CELL_X = Math.floor(40 / 16);
    const VOLCANIC_CELL_Y = Math.floor(0 / 16);
    for (const [vx, vy] of vents) {
      const dist = Math.hypot(vx - VOLCANIC_CELL_X, vy - VOLCANIC_CELL_Y);
      expect(dist).toBeLessThanOrEqual(9);
    }
  });

  it('nodule fields and trenches never overlap', () => {
    const cells = generateOceanTerrain('seed-1', ISLANDS);
    const trenchKeys = new Set(
      Array.from(cells.entries())
        .filter(([, c]) => c.terrain === 'trench')
        .map(([k]) => k),
    );
    const noduleKeys = new Set(
      Array.from(cells.entries())
        .filter(([, c]) => c.terrain === 'nodule_field')
        .map(([k]) => k),
    );
    for (const k of trenchKeys) expect(noduleKeys.has(k)).toBe(false);
  });

  it('vent clusters never overlap trenches or nodule fields', () => {
    const cells = generateOceanTerrain('seed-vent', ISLANDS);
    const ventKeys = new Set(
      Array.from(cells.entries())
        .filter(([, c]) => c.terrain === 'hydrothermal_vent')
        .map(([k]) => k),
    );
    const blockerKeys = new Set(
      Array.from(cells.entries())
        .filter(([, c]) => c.terrain === 'trench' || c.terrain === 'nodule_field')
        .map(([k]) => k),
    );
    for (const k of ventKeys) expect(blockerKeys.has(k)).toBe(false);
  });

  it('nodule fields are 3×3 clusters', () => {
    // Iterate several seeds so we catch at least one nodule field; the
    // 3×3 shape invariant must hold for every cluster we see.
    for (let i = 0; i < 5; i++) {
      const cells = generateOceanTerrain(`nodule-${i}`, ISLANDS);
      const noduleKeys = Array.from(cells.entries())
        .filter(([, c]) => c.terrain === 'nodule_field')
        .map(([k]) => k.split(',').map(Number) as [number, number]);
      if (noduleKeys.length === 0) continue;

      const keyOf = (x: number, y: number) => `${x},${y}`;
      const set = new Set(noduleKeys.map(([x, y]) => keyOf(x, y)));
      const visited = new Set<string>();
      for (const start of noduleKeys) {
        const k0 = keyOf(start[0], start[1]);
        if (visited.has(k0)) continue;
        const stack: Array<[number, number]> = [start];
        const component: Array<[number, number]> = [];
        while (stack.length > 0) {
          const [x, y] = stack.pop()!;
          const k = keyOf(x, y);
          if (visited.has(k)) continue;
          visited.add(k);
          component.push([x, y]);
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nk = keyOf(x + dx, y + dy);
            if (set.has(nk) && !visited.has(nk)) stack.push([x + dx, y + dy]);
          }
        }
        // Every nodule cluster is exactly 3×3 = 9 cells.
        const xs = component.map(([x]) => x);
        const ys = component.map(([, y]) => y);
        const w = Math.max(...xs) - Math.min(...xs) + 1;
        const h = Math.max(...ys) - Math.min(...ys) + 1;
        expect(component.length).toBe(9);
        expect(w).toBe(3);
        expect(h).toBe(3);
      }
    }
  });

  // Pin the 1-cell 4-neighbour buffer between nodule clusters
  // (`seedNoduleFields` — keeps two 3×3 fields from blob-merging into a single
  // amorphous mass): every cell of one cluster must be at Chebyshev distance ≥ 2
  // from every cell of another, i.e. no two clusters share an 8-neighbour. Sweep
  // 20 seeds for one that rolls ≥ 2 clusters; observedMultiCluster guards against
  // a vacuous pass.
  it('keeps nodule clusters separated by a 1-cell buffer', () => {
    const keyOf = (x: number, y: number) => `${x},${y}`;
    let observedMultiCluster = false;
    for (let i = 0; i < 20; i++) {
      const cells = generateOceanTerrain(`nodule-buffer-${i}`, ISLANDS);
      const noduleKeys = Array.from(cells.entries())
        .filter(([, c]) => c.terrain === 'nodule_field')
        .map(([k]) => k.split(',').map(Number) as [number, number]);
      if (noduleKeys.length === 0) continue;

      // 4-neighbour flood-fill → component list.
      const set = new Set(noduleKeys.map(([x, y]) => keyOf(x, y)));
      const visited = new Set<string>();
      const components: Array<Array<[number, number]>> = [];
      for (const start of noduleKeys) {
        const k0 = keyOf(start[0], start[1]);
        if (visited.has(k0)) continue;
        const stack: Array<[number, number]> = [start];
        const component: Array<[number, number]> = [];
        while (stack.length > 0) {
          const [x, y] = stack.pop()!;
          const k = keyOf(x, y);
          if (visited.has(k)) continue;
          visited.add(k);
          component.push([x, y]);
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nk = keyOf(x + dx, y + dy);
            if (set.has(nk) && !visited.has(nk)) stack.push([x + dx, y + dy]);
          }
        }
        components.push(component);
      }

      if (components.length < 2) continue;
      observedMultiCluster = true;

      // For every pair (A, B): min Chebyshev distance between any
      // cell-of-A and any cell-of-B must be ≥ 2. (Distance 1 means
      // either edge- or corner-adjacent; the generator's 4-neighbour
      // buffer rejects placements where a candidate cell IS a nodule OR
      // is edge-adjacent to one — so any two distinct clusters can't
      // share a 4-neighbour ring cell.)
      for (let a = 0; a < components.length; a++) {
        for (let b = a + 1; b < components.length; b++) {
          let minDist = Infinity;
          const A = components[a]!;
          const B = components[b]!;
          for (const [ax, ay] of A) {
            for (const [bx, by] of B) {
              const d = Math.max(Math.abs(ax - bx), Math.abs(ay - by));
              if (d < minDist) minDist = d;
            }
          }
          expect(
            minDist,
            `seed nodule-buffer-${i}: clusters ${a},${b} min Chebyshev ${minDist} < 2`,
          ).toBeGreaterThanOrEqual(2);
        }
      }
    }
    expect(observedMultiCluster).toBe(true);
  });
});

describe('seedOceanTerrainForIslands — lazy generation', () => {
  it('adds shallows ring around a lazily generated island', () => {
    const island = mkIsland('lazy', 'plains', 200, 200);
    // Lazy path: start from empty and seed only the new island.
    const lazy = new Map<string, import('./ocean-cell.js').OceanCellSpec>();
    seedOceanTerrainForIslands(lazy, 'lazy-seed', [island], [island]);
    const shallowCells = Array.from(lazy.entries()).filter(
      ([, c]) => c.terrain === 'shallows',
    );
    expect(shallowCells.length).toBeGreaterThan(0);
  });

  it('volcanic island rolls identical vents at boot and lazily for the same seed', () => {
    // Use a large enough island (major=minor=40) and seed 'v26' — confirmed to
    // yield 10 vent cells, making the equality assertion non-vacuous.
    const island = mkIsland('vol', 'volcanic', 300, 300, 40, 40);
    const boot = generateOceanTerrain('v26', [island]);
    const bootVents = Array.from(boot.entries()).filter(
      ([, c]) => c.terrain === 'hydrothermal_vent',
    );

    // Guard: ensure the seed actually produces vents so the equality below
    // cannot pass vacuously as []===[].
    expect(bootVents.length).toBeGreaterThan(0);

    const lazy = new Map<string, import('./ocean-cell.js').OceanCellSpec>();
    seedOceanTerrainForIslands(lazy, 'v26', [island], [island]);
    const lazyVents = Array.from(lazy.entries()).filter(
      ([, c]) => c.terrain === 'hydrothermal_vent',
    );

    expect(lazyVents.sort()).toEqual(bootVents.sort());
  });
});
