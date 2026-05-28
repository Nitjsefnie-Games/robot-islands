// Shared numeric constants extracted from across the codebase to eliminate
// duplicate "keep in sync" declarations. No imports, no PixiJS, no DOM —
// safe to import from any module (including leaf modules like
// `vision-source.ts` that must avoid pulling in `world.ts`).
//
// Each constant is the SINGLE source of truth for its value. Re-exports
// from `world.ts` / `lattice.ts` / `discovery.ts` exist for backward
// compatibility with existing import sites.

/** §2.1 stratification cell side length, in tiles. SPEC calls this R.
 *  Used for discovery (per-cell ocean reveal), drone pathing, weather
 *  cells, satellite coverage rasterization, and grid overlay rendering. */
export const CELL_SIZE_TILES = 16;

/** §13.3 / §9.6 Network Consciousness threshold for Omniscient Lattice
 *  activation — the count of T5-mastered, networked islands with a valid
 *  Lattice Node required to unlock the §13.3 cross-island lattice. The
 *  same numeric value defines the milestone-4 row of the §9.6 NC milestone
 *  table (see `MILESTONE_TABLE` in `network-consciousness.ts`). */
export const LATTICE_ACTIVATION_THRESHOLD = 20;
