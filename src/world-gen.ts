// Procedural world generation per SPEC §2.1 (stratification cell grid),
// §2.3 (biome roll), §3.4 (initial radii by biome), §3.5 (modifier roll).
//
// Procedural generation runs ONCE at first start of a fresh game. The
// resolved island list is persisted via the existing v2 snapshot path;
// reloading restores the same world without re-running the generator.
// Demo home and the 5 hand-placed demos remain in DEMO_ISLANDS for
// continuity — generated islands are appended around them and an overlap
// check keeps procedural placements off the hand-placed ones.
//
// Algorithm summary:
//   1. For every cell `(cx, cy)` in the [-N, +N]² grid, decide independently
//      whether to place an island (probability = `density`). The home cell
//      (0, 0) is always skipped.
//   2. If placing: roll a biome from a weighted distribution (placeholder
//      table at the head of `rollBiome` below), pick a jittered position
//      inside the cell, take the biome's initialMajor/MinorRadius, and roll
//      modifiers via `rollModifiers`.
//   3. Skip the placement if it overlaps any already-placed island
//      (procedural-so-far OR caller-supplied existing islands). Overlap test
//      is a conservative distance-based ellipse approximation:
//          dist(c1, c2) < max(maj1, min1) + max(maj2, min2) + buffer
//      with `buffer = 4` tiles.
//
// Pure module: no DOM, no PixiJS, no Math.random.

import { BIOME_DEFS, rollModifiers } from './biomes.js';
import { makeSeededRng } from './rng.js';
import { attachTerrainAt, type Biome, type IslandSpec } from './world.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GenOptions {
  /** Seed for the RNG. The same string always produces the same world. */
  readonly seed: string;
  /** Generate islands within cells `[-N, +N]²`. Home cell `(0, 0)` is
   *  always skipped. */
  readonly halfExtentCells: number;
  /** Stratification cell side length R, in tiles (SPEC §2.1). Generally
   *  matches `CELL_SIZE_TILES` from `world.ts`. */
  readonly cellSizeTiles: number;
  /** Per-cell placement probability in [0, 1]. */
  readonly density: number;
  /** Islands already on the world. New placements must not overlap any of
   *  these. Defaults to an empty array. Used to keep procedural islands
   *  off the hand-placed demo islands (forest-ne, desert-far, hidden-w,
   *  hidden-s, coast-unknown, home). */
  readonly existingIslands?: ReadonlyArray<IslandSpec>;
}

/**
 * Generate procedural islands per the SPEC §2.1 cell-grid rules. Returns a
 * fresh array of `IslandSpec` objects. Pure — same `opts` always yields the
 * same output (deterministic given `seed`).
 */
export function generateWorld(opts: GenOptions): IslandSpec[] {
  const rng = makeSeededRng(opts.seed);
  const out: IslandSpec[] = [];

  // Collect every island we've placed so far (caller-supplied + procedural)
  // for the overlap check. The check is cheap (linear scan, small N), and
  // we mutate the array as we go.
  const placed: IslandSpec[] = [...(opts.existingIslands ?? [])];

  const N = opts.halfExtentCells;
  const cell = opts.cellSizeTiles;

  // Row-major iteration so the rng is consumed in a stable order. Changing
  // the iteration order silently changes the generated world for the same
  // seed, so this is part of the determinism contract.
  for (let cy = -N; cy <= N; cy++) {
    for (let cx = -N; cx <= N; cx++) {
      // Home cell skip. Use coordinates (not id) — the home island sits at
      // tile (0, 0), so its cell is unambiguously (0, 0).
      if (cx === 0 && cy === 0) continue;

      // Density gate. Consume one rng call per cell regardless of whether
      // we place — keeps the sequence aligned even if `density` changes.
      const placeRoll = rng();
      if (placeRoll >= opts.density) continue;

      // Biome roll.
      const biome = rollBiome(rng);
      const def = BIOME_DEFS[biome];

      // Position: cell centre + jitter inside ±40% of the cell extent in
      // each axis. The ±40% (instead of ±50%) leaves a small margin off
      // the cell edge to reduce inter-cell collisions — and the overlap
      // check below catches anything that slips through. Snapped to
      // integer tile coords because the renderer + economy assume
      // integer-tile island centres.
      const cellCx = cx * cell + cell / 2;
      const cellCy = cy * cell + cell / 2;
      const jitterX = (rng() - 0.5) * 2 * (cell * 0.4);
      const jitterY = (rng() - 0.5) * 2 * (cell * 0.4);
      const islandCx = Math.round(cellCx + jitterX);
      const islandCy = Math.round(cellCy + jitterY);

      // Radii from the biome's catalog default per §3.4.
      const majorRadius = def.initialMajorRadius;
      const minorRadius = def.initialMinorRadius;

      // Overlap check against every already-placed island (caller-supplied
      // hand-placed islands AND every procedural island we've placed so
      // far). Conservative distance-based ellipse approximation per the
      // task brief.
      if (overlapsAny(islandCx, islandCy, majorRadius, minorRadius, placed)) {
        // Skip placement. We still consumed the biome + position + jitter
        // rng calls so the sequence stays stable.
        continue;
      }

      const id = `gen-${cx}-${cy}`;
      // Modifier roll per §3.5 via the existing pure rng-driven function.
      // `seed` is advisory inside `rollModifiers` — the entropy comes from
      // the rng we just threaded through.
      const modifiers = rollModifiers(opts.seed, biome, rng);

      // Build via the shared `attachTerrainAt` helper — the inscription
      // predicate captures `spec` by reference so a future §3.6 merge that
      // mutates `extraEllipses` is observed live (no closure-capture of
      // radii). The readonly-widening cast lives once, in the helper.
      const spec: IslandSpec = attachTerrainAt({
        id,
        name: id,
        biome,
        cx: islandCx,
        cy: islandCy,
        majorRadius,
        minorRadius,
        populated: false,
        discovered: false,
        buildings: [],
        modifiers,
      });
      out.push(spec);
      placed.push(spec);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Biome weight table per the task brief (placeholder per SPEC §15.7 step 6).
 *  Sum is 100, so we treat each row as a percentage. */
const BIOME_WEIGHTS: ReadonlyArray<readonly [Biome, number]> = [
  ['plains', 25],
  ['forest', 20],
  ['coast', 15],
  ['volcanic', 10],
  ['desert', 15],
  ['arctic', 15],
];

const BIOME_WEIGHT_TOTAL: number = BIOME_WEIGHTS.reduce((s, [, w]) => s + w, 0);

/** Sample a biome from the weighted distribution. Consumes one rng call. */
function rollBiome(rng: () => number): Biome {
  let r = rng() * BIOME_WEIGHT_TOTAL;
  for (const [b, w] of BIOME_WEIGHTS) {
    r -= w;
    if (r < 0) return b;
  }
  // Floating-point safety: if every threshold was barely missed, return
  // the last biome in the table.
  return BIOME_WEIGHTS[BIOME_WEIGHTS.length - 1]![0];
}

/** Conservative distance-based ellipse overlap test. Two islands collide if
 *  their centre distance is less than `max(maj, min)` for each plus a small
 *  buffer. This is intentionally loose (it treats both as enclosing
 *  circles) so the worst case is "a slightly larger gap than strictly
 *  necessary." The buffer keeps two islands from joining at generation
 *  time per the §2.1 minimum-spacing requirement. */
function overlapsAny(
  cx: number,
  cy: number,
  major: number,
  minor: number,
  others: ReadonlyArray<IslandSpec>,
): boolean {
  const BUFFER_TILES = 4;
  const myMax = Math.max(major, minor);
  for (const o of others) {
    const otherMax = Math.max(o.majorRadius, o.minorRadius);
    const dx = cx - o.cx;
    const dy = cy - o.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < myMax + otherMax + BUFFER_TILES) return true;
  }
  return false;
}
