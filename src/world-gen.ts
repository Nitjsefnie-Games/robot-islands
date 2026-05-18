// Procedural world generation per SPEC §2.1 (stratification cell grid),
// §2.3 (biome roll), §3.4 (initial radii by biome), §3.5 (modifier roll).
//
// **Per-cell determinism.** Every cell `(X, Y)` seeds its own RNG from
// `${seed}_cell_${X}_${Y}`, so `generateCellIslands(seed, X, Y, ...)`
// returns the SAME island candidate regardless of whether it's called in
// isolation (lazy generation as a drone enters the cell) or in a bulk
// boot-time sweep. The cross-cell `overlapsAny` check is the only
// order-dependent part: if cell (X, Y)'s candidate overlaps a previously-
// placed island in a neighbour cell, the candidate is dropped. As long as
// the caller hands the same neighbour-island list at each invocation, the
// drop decision is also deterministic.
//
// **Lazy + infinite.** Callers can mix bulk generation (`generateWorld`
// for boot) with on-demand single-cell generation (`generateCellIslands`)
// as the player discovers new cells via drones / satellites / routes.
// There is no `halfExtentCells` cap on the lazy path; the bulk path's
// `halfExtentCells` exists only to bootstrap the cells visible at game
// start.
//
// Pure module: no DOM, no PixiJS, no Math.random.

import { BIOME_DEFS, rollModifiers } from './biomes.js';
import { makeSeededRng } from './rng.js';
import { attachTerrainAt, type Biome, type IslandSpec } from './world.js';

// Ocean-layer §2: re-export so callers wiring "the procedural world
// pipeline" find both island placement (`generateWorld`) and ocean
// terrain seeding (`generateOceanTerrain`) at one import path. The
// actual call site lives in `makeInitialWorld` (world.ts) — that's
// where the `WorldState` is assembled — but discoverability for
// future maintainers belongs next to the rest of the world-gen API.
export { generateOceanTerrain } from './ocean-gen.js';

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
 * Generate the procedural islands within a single cell `(cellX, cellY)`.
 * Pure + per-cell deterministic — same `(seed, cellX, cellY)` always
 * returns the same candidate set, regardless of generation order.
 *
 * Returns at most one island per cell — this is the design choice per
 * §2.1 (single island per cell, density gates the first-island roll).
 * Multi-island-per-cell fan-out is intentionally not implemented.
 *
 * `neighborSpecs` is the cross-cell overlap context. The function only
 * reads from it (never mutates); pass islands from neighbour cells (±1 on
 * both axes) so the cross-cell buffer is enforced. If `neighborSpecs`
 * changes between calls (e.g. a §3.6 merge absorbed a neighbour), the
 * overlap decision can change — that's by design.
 *
 * Skip rules:
 *   - Home cell (0, 0) returns `[]`.
 *   - Density gate: first rng call must be < `density`.
 *   - Overlap: candidate's centre-circle gates against `neighborSpecs`
 *     via the `OVERLAP_BUFFER_TILES`-padded ellipse approximation. On
 *     overlap, returns `[]` (the cell is "stranded" — gives §2.1's
 *     "stranded but reachable" feel when density + buffer are tuned
 *     together).
 */
export function generateCellIslands(
  seed: string,
  cellX: number,
  cellY: number,
  cellSizeTiles: number,
  density: number,
  neighborSpecs: ReadonlyArray<IslandSpec>,
): IslandSpec[] {
  if (cellX === 0 && cellY === 0) return [];

  // Per-cell rng — output depends only on (seed, cellX, cellY), not on
  // generation order of other cells.
  const rng = makeSeededRng(`${seed}_cell_${cellX}_${cellY}`);

  const placeRoll = rng();
  if (placeRoll >= density) return [];

  const biome = rollBiome(rng);
  const def = BIOME_DEFS[biome];

  // Position: cell centre + jitter inside ±40% of the cell extent in
  // each axis. ±40% (vs ±50%) leaves a small margin off the cell edge
  // to reduce inter-cell collisions; the overlap check below catches
  // anything that slips through. Snapped to integer tile coords because
  // the renderer + economy assume integer-tile island centres.
  const cellCx = cellX * cellSizeTiles + cellSizeTiles / 2;
  const cellCy = cellY * cellSizeTiles + cellSizeTiles / 2;
  const jitterX = (rng() - 0.5) * 2 * (cellSizeTiles * 0.4);
  const jitterY = (rng() - 0.5) * 2 * (cellSizeTiles * 0.4);
  const islandCx = Math.round(cellCx + jitterX);
  const islandCy = Math.round(cellCy + jitterY);

  // Radii from the biome's catalog default per §3.4.
  const majorRadius = def.initialMajorRadius;
  const minorRadius = def.initialMinorRadius;

  if (overlapsAny(islandCx, islandCy, majorRadius, minorRadius, neighborSpecs)) {
    return [];
  }

  const id = `gen-${cellX}-${cellY}`;
  const modifiers = rollModifiers(seed, biome, rng);
  // §3.4 Coast-only rotation: roll a multiple of 22.5° (= 360 / 16) from a
  // dedicated per-cell RNG stream. Decoupling from the main `rng` keeps
  // future inserts above this point — extra modifier draws, alternate
  // jitter shapes — from perturbing existing rotation values for any seed
  // already in the wild. Non-Coast biomes leave the field unset; readers
  // collapse undefined → 0 via `?? 0` (see IslandSpec docblock).
  const rotation = biome === 'coast' ? rollCoastRotation(seed, cellX, cellY) : 0;
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
    rotation,
  });
  return [spec];
}

/**
 * Generate procedural islands within `[-halfExtentCells, +halfExtentCells]²`
 * by calling `generateCellIslands` per cell. Pure — same `opts` always
 * yields the same output. Used at boot to bootstrap the visible cells; the
 * lazy on-demand path (`generateCellIslands` directly) handles infinite
 * generation as the player discovers new cells.
 */
export function generateWorld(opts: GenOptions): IslandSpec[] {
  const out: IslandSpec[] = [];
  const placed: IslandSpec[] = [...(opts.existingIslands ?? [])];
  const N = opts.halfExtentCells;
  for (let cy = -N; cy <= N; cy++) {
    for (let cx = -N; cx <= N; cx++) {
      const islands = generateCellIslands(
        opts.seed,
        cx,
        cy,
        opts.cellSizeTiles,
        opts.density,
        placed,
      );
      out.push(...islands);
      placed.push(...islands);
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

/** §3.4 number of discrete rotation buckets for Coast islands. 16 buckets
 *  × 22.5° = 360°. */
const COAST_ROTATION_STEPS = 16;

/** §3.4 Coast-island rotation roll. Deterministic from the world seed +
 *  cell coordinates: a separate RNG stream keyed `${seed}_cell_${cx}_${cy}_rotation`
 *  so the value depends only on the seed and the cell, not on the call
 *  order of other rolls in `generateCellIslands` (biome, jitter, modifiers).
 *  Returns one of `{0, 22.5, 45, …, 337.5}` — 16 evenly-spaced multiples
 *  of 22.5° in `[0, 360)`. Pure. */
function rollCoastRotation(seed: string, cellX: number, cellY: number): number {
  const r = makeSeededRng(`${seed}_cell_${cellX}_${cellY}_rotation`);
  const step = Math.floor(r() * COAST_ROTATION_STEPS);
  // Clamp belt-and-braces in case r() somehow returns exactly 1.0; the
  // contract is `[0, 1)` but the clamp costs nothing and keeps the
  // returned bucket strictly in `[0, COAST_ROTATION_STEPS)`.
  const clamped = Math.min(step, COAST_ROTATION_STEPS - 1);
  return (clamped * 360) / COAST_ROTATION_STEPS;
}

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
/** Cross-cell minimum-spacing buffer in tiles. Spec §2.1 calls for
 *  "stranded but reachable" feel — tuned alongside
 *  `DEFAULT_GEN_OPTS.density` in `world.ts`. The current pairing
 *  (density 0.08, buffer 16; single island per cell) keeps neighbour
 *  islands at least one cell apart in practice. Raise to bias toward
 *  stranded; lower to bias toward dense. */
export const OVERLAP_BUFFER_TILES = 16;

function overlapsAny(
  cx: number,
  cy: number,
  major: number,
  minor: number,
  others: ReadonlyArray<IslandSpec>,
): boolean {
  const myMax = Math.max(major, minor);
  for (const o of others) {
    const otherMax = Math.max(o.majorRadius, o.minorRadius);
    const dx = cx - o.cx;
    const dy = cy - o.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < myMax + otherMax + OVERLAP_BUFFER_TILES) return true;
  }
  return false;
}
