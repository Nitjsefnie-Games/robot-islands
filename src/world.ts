// Multi-island world data + render coordination. The world is a flat list of
// placed islands, each with its own centre in world-tile coordinates, biome
// ellipse parameters, and buildings.
//
// Per SPEC §2.1 the world is partitioned into stratification cells of side R
// (the discovery guarantee radius).
//
// Vision model (three states):
//   - 'visible'    — populated, OR discovered AND inside some populated
//                    island's vision radius.
//   - 'discovered' — discovered but outside all vision radii. The ocean tier,
//                    not island dimming, signals "known but no current info"
//                    (see renderIsland).
//   - 'unknown'    — not discovered. Not rendered; the dark page background
//                    shows through.

import { Container } from 'pixi.js';

import { terrainAtForBiome } from './biomes.js';
import type { ModifierId } from './biomes.js';
import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import { floorScaledCapacity, renderBuildings } from './buildings.js';
import { CELL_SIZE_TILES } from './constants.js';
import { islandCells } from './discovery.js';
import type { IslandState } from './economy.js';
import { type TerrainKind, type Tile } from './island.js';
import {
  computeIslandTiles,
  defaultTerrainAt,
  islandInscribedAny,
  renderIslandTiles,
  tileInscribedInEllipse,
  TILE_PX,
} from './island.js';
import type { OceanCellSpec } from './ocean-cell.js';
import { generateOceanTerrain, seedOceanTerrainForIslands } from './ocean-gen.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import type { Route } from './routes.js';
import { RESOURCE_STORAGE_CATEGORY, baselineCap, storageBaseFor } from './storage-categories.js';
import { pointInVision, type VisionSource } from './vision-source.js';
import { generateCellIslands, generateWorld } from './world-gen.js';

/** Stratification cell side length, in tiles. SPEC §2.1 calls this R.
 *  Re-exported from `constants.ts` (the canonical source of truth). */
export { CELL_SIZE_TILES };
/** Padding (in tiles) extending past each island's ellipse edge to form the
 *  baseline vision area. A populated island's baseline vision footprint is an
 *  axis-aligned ellipse with semi-axes `(majorRadius + VISION_PADDING_TILES,
 *  minorRadius + VISION_PADDING_TILES)` centered on the island.
 *
 *  Lighthouse-vision redesign (§15.x): small (10) so the baseline reads as
 *  "the immediate waters off your own coast" rather than free intel on every
 *  settle. Distant scouting requires Lighthouse infrastructure
 *  (`lighthouse.ts → computeVisionSources`). */
export const VISION_PADDING_TILES = 10;

// Ocean-tier palette: three discrete blues form the world's vision-state
// field. The colour step itself is the tier boundary — there is no outline
// ring. DISCOVERED_BLUE drops both lightness and chroma vs VISION_BLUE so the
// perceptual gap is two-axis; UNKNOWN_BLUE equals the page void so unknown
// ocean fuses with the background and reads as absence.

// Derive from the shared design token so DOM panels and the in-canvas
// vision colours stay in lockstep — edit `ui-tokens.ts` once, both pick it up.
import { COLOR } from './ui-tokens.js';
const hexToNumber = (s: string): number => parseInt(s.replace('#', ''), 16);

/** Tier A — vision (full info) ocean. Luminous cyan-tinged shallow.
 *  Identical to `COLOR.accent` so the DOM accent + the in-canvas vision
 *  halo stay in sync. */
export const VISION_BLUE = hexToNumber(COLOR.accent);
/** Tier B — discovered (no current info) ocean. Desaturated steel blue.
 *  Not in the token set; kept as a literal here. */
export const DISCOVERED_BLUE = 0x2d5878;
/** Tier C — unknown ocean. Equals the page void background. */
export const UNKNOWN_BLUE = hexToNumber(COLOR.void);

export type Biome = 'plains' | 'forest' | 'coast' | 'volcanic' | 'desert' | 'arctic';

/**
 * §3.4 maximum natural radii per biome — the hard cap on Land Reclamation
 * Hub expansion. Joining (§3.6) is the only path past these caps; a single
 * island cannot grow beyond its biome's natural ceiling. Numbers per the
 * SPEC §3.4 placeholder table. Pure data — consumed by
 * `canExpandIsland` / `expandIsland` in `land-reclamation.ts`.
 */
export const BIOME_MAX_RADII: Readonly<
  Record<Biome, { readonly major: number; readonly minor: number }>
> = {
  plains: { major: 28, minor: 28 },
  forest: { major: 20, minor: 20 },
  coast: { major: 28, minor: 14 },
  volcanic: { major: 14, minor: 14 },
  desert: { major: 24, minor: 24 },
  arctic: { major: 14, minor: 14 },
};

export type IslandRenderState = 'visible' | 'discovered' | 'unknown';

/** §3.6 one ownership claim in `IslandSpec.ownershipLedger`. `constituent`
 *  indexes `islandConstituents(spec)` (0 = primary, N = extraEllipses[N-1]);
 *  (major,minor) are that constituent's radii AT THE TIME of this claim. */
export interface OwnershipClaim {
  readonly constituent: number;
  readonly major: number;
  readonly minor: number;
}

export interface IslandSpec {
  readonly id: string;
  /** Player-mutable display name. Initialized to the same string as `id`
   *  at spec creation; the player can rename via the inspector to anything
   *  non-empty up to 32 chars (no ascii control chars). Use this for any
   *  UI surface that shows the island to the player; `id` remains the
   *  internal lookup key (routes, save files, log lines, etc.). */
  name: string;
  readonly biome: Biome;
  /** Centre of the island in world-tile coordinates. */
  readonly cx: number;
  readonly cy: number;
  /** Ellipse half-axes in tiles. §3.4: Land Reclamation Hub mutates these
   *  in place (player-chosen +1 per expansion, capped by BIOME_MAX_RADII).
   *  Rotation cannot change post-generation per §3.4. Persistence already
   *  round-trips both fields via the JSON spread in `serializeWorld`. */
  majorRadius: number;
  minorRadius: number;
  /** Whether the island is populated (origin of vision). Implies discovered.
   *  Mutable: settlement-vehicle arrivals flip false → true (`tickVehicles`
   *  in `settlement.ts`). */
  populated: boolean;
  /** Whether the player knows this island exists at all. Populated → discovered
   *  by definition (the classification function short-circuits on populated).
   *  Mutable: drone returns flip false → true on revealed islands. */
  discovered: boolean;
  /** Buildings placed on this island, in island-local tile coords. Mutable and
   *  shared by reference with `IslandState.buildings` (not a copy — see
   *  `makeInitialIslandState`): one array, two consumers, mutation flows to
   *  both. */
  buildings: PlacedBuilding[];
  /** Terrain function in island-local coords. Defaults to grass everywhere. */
  readonly terrainAt?: (x: number, y: number) => TerrainKind;
  /** §03 terrain_modifier: sparse per-tile overrides written by the modifier's
   *  shot. Key format `${x},${y}` in island-local tile coords. Stores only the
   *  CURRENT kind — no history (v5 lock `no_revert_mechanic`).
   *  `attachTerrainAt`'s closure consults this BEFORE `terrainAtForBiome`
   *  (overrides-then-biome precedence). Mutable; `last_placed_wins` means later
   *  writes overwrite earlier. Optional for forward-compat: legacy saves
   *  (schema 6) load with it undefined and behave identically. */
  tileOverrides?: Record<string, TerrainKind>;
  /** Active modifiers on this island per §3.5. Empty array means none. Mutable:
   *  the §13.3 Universe Editor reassigns this to the re-rolled set after a
   *  biome change (see `changeBiome` in `universe-editor.ts`). */
  modifiers: ReadonlyArray<ModifierId>;
  /** §2.5: islands built via Platform Constructor are flagged so future
   *  systems can deny natural-only content (rare-biome modifiers per §3.5,
   *  biome-locked uniques per §9.5). Undefined ≡ false (natural). */
  readonly artificial?: boolean;
  /** §3.6 island-joining: appended constituents accumulated when this island
   *  has absorbed others. Each entry is a secondary ellipse queried in addition
   *  to `majorRadius`/`minorRadius` (the primary at offset 0,0). Single-ellipse
   *  islands have `undefined` or `[]` — treated identically everywhere. Per
   *  §3.6 a tile belongs to the island iff inscribed inside ANY constituent.
   *  Merges are permanent; the array only grows. Per-extra `rotation` is
   *  forward-compat only — merge propagation isn't wired, so absorbed primaries
   *  enter with rotation 0 (see `island-merge.ts`). */
  extraEllipses?: Array<{
    /** §3.6 origin biome of this absorbed constituent. Drives BOTH the per-lobe
     *  Land Reclamation cap (BIOME_MAX_RADII[biome]) AND this lobe's terrain
     *  generation — tiles inside the lobe are generated under its own biome, not
     *  the absorber's (see `attachTerrainAt`). Optional in input shape only:
     *  legacy saves lack it; readers default via `?? spec.biome`. */
    readonly biome?: Biome;
    /** §3.6 origin id (terrain seed) of the absorbed island. `terrainAtForBiome`
     *  hashes vein placement on the island id, so reproducing the lobe's original
     *  terrain after a merge requires its original id. Optional: pre-feature
     *  merges lack it; readers default via `?? spec.id` (best-effort — a legacy
     *  lobe then uses the absorber's seed, the pre-feature look). */
    readonly originId?: string;
    readonly major: number;
    readonly minor: number;
    readonly rotation: number;
    readonly offsetX: number;
    readonly offsetY: number;
  }>;
  /** §3.4 primary-ellipse rotation in degrees, in `[0, 360)`. For all biomes
   *  EXCEPT Coast this is 0 (or absent — readers must default via `?? 0`).
   *  Coast islands roll a 22.5° multiple deterministically from the world seed
   *  at generation. Immutable per §3.4 once set. Metadata only — no geometry
   *  consumer rotates the ellipse yet. Optional so legacy saves hydrate cleanly
   *  (missing reads as 0). */
  rotation?: number;
  /** §3.7 hand-placed base-layout radius. When set (only the home island, = 16),
   *  the PRIMARY constituent's tiles WITHIN this radius use the locked
   *  `defaultTerrainAt` starter layout; tiles beyond it generate procedurally
   *  from the island's biome (so growing home past its original footprint yields
   *  real terrain, not grass — §3.7). Absent on every other island (and on
   *  absorbed lobes, which never use the hand layout). Added in the v28→v29
   *  migration; readers treat absent as "no locked base layout". */
  baseLayoutRadius?: number;
  /** §3.6 placement-order ownership ledger. Append-only list of ownership
   *  CLAIMS in the order constituents were placed/grown: each entry says
   *  "constituent `c` inscribed the ring up to (major,minor) at this point in
   *  time." Resolves overlap precedence by placement TIME ("already-placed
   *  wins") so a growing constituent never overwrites a sibling's existing land.
   *  `constituent` indexes `islandConstituents(spec)` (0 = primary). ABSENT ⇒
   *  the implicit baseline (`islandImplicitLedger`): constituents in index order
   *  at current radii — identical to the pre-ledger "earliest-index wins" rule,
   *  so single-ellipse and never-grown merged islands store nothing and legacy
   *  saves behave unchanged. A constituent may appear multiple times (baseline +
   *  one per later growth); only CONSECUTIVE same-constituent claims coalesce.
   *  Invariant: the last claim per constituent equals its current radii. Rides
   *  the `serializeWorld` spread (SerializedIslandSpec omits only terrainAt). */
  ownershipLedger?: ReadonlyArray<OwnershipClaim>;
}

/** §3.6 constituent ellipse view — the primary ellipse re-expressed as the
 *  same shape as an `extraEllipses` entry. Centralises the "primary at
 *  (0,0), extras at their offsets" pattern that overlap / tile / hit-test
 *  / vision code all share. */
export interface ConstituentEllipse {
  readonly biome: Biome;
  /** Origin island id — the terrain seed for this constituent. The primary
   *  carries the island's own id; an absorbed lobe carries the absorbed island's
   *  id so its terrain reproduces post-merge (§3.6). */
  readonly originId: string;
  readonly major: number;
  readonly minor: number;
  readonly rotation: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Walk every constituent of `spec`: the primary at offset (0, 0), then any
 *  `extraEllipses`. Returns a fresh array on each call (cheap — at most 1 +
 *  extras.length entries). Pure. */
export function islandConstituents(spec: IslandSpec): ConstituentEllipse[] {
  const out: ConstituentEllipse[] = [
    { biome: spec.biome, originId: spec.id, major: spec.majorRadius, minor: spec.minorRadius,
      rotation: 0, offsetX: 0, offsetY: 0 },
  ];
  if (spec.extraEllipses) {
    for (const e of spec.extraEllipses) {
      // Legacy lobes lack biome/originId — default to the absorber's (the
      // pre-feature look: absorber biome + absorber seed).
      out.push({ ...e, biome: e.biome ?? spec.biome, originId: e.originId ?? spec.id });
    }
  }
  return out;
}

/** §3.6 the implicit ownership baseline: every constituent claimed at its
 *  CURRENT radii in index order. This is what an absent `ownershipLedger`
 *  means (legacy "earliest-index wins"). Pure. */
export function islandImplicitLedger(spec: IslandSpec): OwnershipClaim[] {
  return islandConstituents(spec).map((c, i) => ({
    constituent: i, major: c.major, minor: c.minor,
  }));
}

/** §3.6 record a Land Reclamation growth of constituent `index` to (major,minor)
 *  in the ownership ledger. Materializes the implicit baseline first when the
 *  ledger is absent (so the pre-growth footprint keeps its existing ownership),
 *  then appends the new claim — coalescing only when the LAST entry is the same
 *  constituent (a run of growths on one constituent is one logical claim).
 *  Mutates `spec.ownershipLedger`. Pure w.r.t. everything else. */
export function recordGrowthClaim(
  spec: IslandSpec, index: number, major: number, minor: number,
): void {
  const ledger: OwnershipClaim[] = spec.ownershipLedger
    ? [...spec.ownershipLedger]
    : islandImplicitLedger(spec);
  const last = ledger[ledger.length - 1];
  if (last && last.constituent === index) {
    ledger[ledger.length - 1] = { constituent: index, major, minor };
  } else {
    ledger.push({ constituent: index, major, minor });
  }
  spec.ownershipLedger = ledger;
}

/** §3.6 the constituent that OWNS island-local tile (x, y) by placement order
 *  ("already-placed wins"), plus its index, or undefined when no constituent
 *  inscribes the tile. Walks `ownershipLedger` (first claim whose ellipse
 *  inscribes the tile wins); when the ledger is absent OR under-covers the
 *  current union, falls back to the current-radii index walk so a union tile is
 *  never left unowned. The owner's CURRENT radii (c.major/c.minor) — not the
 *  claim radii — drive terrain generation; only ownership is historical. Pure. */
export function constituentOwnerAt(
  spec: IslandSpec, x: number, y: number,
): { ellipse: ConstituentEllipse; index: number } | undefined {
  const constituents = islandConstituents(spec);
  const ledger = spec.ownershipLedger;
  if (ledger && ledger.length > 0) {
    for (const claim of ledger) {
      const c = constituents[claim.constituent];
      if (!c) continue; // defensive: stale index
      if (tileInscribedInEllipse(x - c.offsetX, y - c.offsetY, claim.major, claim.minor)) {
        return { ellipse: c, index: claim.constituent };
      }
    }
    // fall through: ledger under-covers the union (invariant violation) → self-heal
  }
  for (let i = 0; i < constituents.length; i++) {
    const c = constituents[i]!;
    if (tileInscribedInEllipse(x - c.offsetX, y - c.offsetY, c.major, c.minor)) {
      return { ellipse: c, index: i };
    }
  }
  return undefined;
}

/** §3.6 multibiome: the biome of the constituent that owns tile (x,y) in
 *  island-local coords, resolved by placement order via `constituentOwnerAt`
 *  (the ownership ledger — "already-placed wins"), independent of the
 *  `computeIslandTiles` dedup order. Returns undefined when no constituent
 *  inscribes the tile (outside the footprint). Pure. */
export function constituentBiomeAt(spec: IslandSpec, x: number, y: number): Biome | undefined {
  return constituentOwnerAt(spec, x, y)?.ellipse.biome;
}

/** The set of distinct constituent biomes on `spec` (primary + absorbed lobes).
 *  For a non-merged island this is just { spec.biome }. Pure. */
export function islandConstituentBiomes(spec: IslandSpec): Set<Biome> {
  return new Set(islandConstituents(spec).map((c) => c.biome));
}

/**
 * Build an `IslandSpec` from a base lacking `terrainAt` and attach the
 * predicate-aware `terrainAt` closure expected by `renderIsland` and the
 * §8.1 procedural-extractor placement code.
 *
 * The closure captures the returned `spec` BY REFERENCE — not the radii or
 * `extraEllipses` literals — so any §3.4 expansion that mutates
 * `majorRadius` / `minorRadius` and any §3.6 merge that mutates
 * `extraEllipses` is observed live on the very next `terrainAt(x, y)` call.
 * Capturing the geometry at closure-build time would silently miss
 * extra-ellipse tiles and reintroduce the boundary-fragment defect there.
 *
 * Centralises the readonly-widening cast that would otherwise be duplicated
 * at every spec-construction site (world-gen, persistence rehydration,
 * artificial-island construction, demo fixtures).
 *
 * WARNING for future maintainers: do NOT switch the body to
 * `{ ...spec, terrainAt: ... }` or otherwise rebind `spec` to a snapshot
 * before attaching the closure. The pinned by-reference invariant is
 * asserted by a dedicated test in `biomes.test.ts`; that test will fail
 * loudly if the reference is lost.
 */
export function attachTerrainAt<B extends Omit<IslandSpec, 'terrainAt'>>(base: B): IslandSpec {
  // Shallow-spread so we own the returned spec and never mutate the caller's
  // `base` literal (callers occasionally build the base once and re-use it).
  const spec = { ...base } as IslandSpec;
  (spec as { terrainAt: (x: number, y: number) => TerrainKind }).terrainAt = (
    x,
    y,
  ) => {
    // terrain_modifier §03 — overrides take precedence over the biome
    // closure. Read `spec.tileOverrides` LIVE (not captured at closure-
    // build time) so a shot landing mid-session is observed on the next
    // call; matches the by-reference invariant for `spec.biome` / radii.
    const overrides = spec.tileOverrides;
    if (overrides !== undefined) {
      const k = overrides[`${x},${y}`];
      if (k !== undefined) return k;
    }
    // §3.6 per-constituent terrain, resolved by placement order ("already-placed
    // wins") via the ownership ledger — a grown constituent never overwrites a
    // sibling's existing terrain. Each constituent generates terrain under its
    // OWN biome/seed in its OWN local frame, so an absorbed lobe keeps the terrain
    // (incl. resource veins) it had as a standalone island. The OWNER's current
    // radii drive the boundary predicate; only ownership of a contested tile is
    // historical.
    const owner = constituentOwnerAt(spec, x, y);
    if (owner) {
      const c = owner.ellipse;
      const lx = x - c.offsetX;
      const ly = y - c.offsetY;
      // §3.7 hand-placed base layout (home): only the PRIMARY (index 0) within
      // baseLayoutRadius uses the locked layout; absorbed lobes never do.
      if (owner.index === 0 && spec.baseLayoutRadius !== undefined &&
          tileInscribedInEllipse(lx, ly, spec.baseLayoutRadius, spec.baseLayoutRadius)) {
        return defaultTerrainAt(lx, ly);
      }
      return terrainAtForBiome(c.biome, c.originId, lx, ly, (px, py) =>
        tileInscribedInEllipse(px, py, c.major, c.minor),
      );
    }
    // Not inscribed in any constituent (e.g. a bounding-box probe outside the
    // footprint). Fall back to the primary's biome/seed in island-local coords,
    // matching the pre-feature query for non-land tiles.
    return terrainAtForBiome(spec.biome, spec.id, x, y, (px, py) =>
      islandInscribedAny(spec, px, py),
    );
  };
  return spec;
}

/** Convenience: world-tile coords → world-pixel coords. */
export function tileToWorldPx(cxTiles: number, cyTiles: number): { x: number; y: number } {
  return { x: cxTiles * TILE_PX, y: cyTiles * TILE_PX };
}

/**
 * Squared world-tile distance from an island's centre to a point. Pure helper
 * for vision-radius checks (avoids sqrt when only comparing to a radius).
 */
export function distSqTiles(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

// §3 player-mutable display name

/** Maximum length of a player-supplied island name. Anything longer is
 *  rejected by `renameIsland`. Chosen to fit comfortably in the HUD title
 *  and the inspector header without truncation. */
export const ISLAND_NAME_MAX_LEN = 32;

/** Result of a `renameIsland` call. `ok=false` carries a reason string so
 *  the UI can surface the failure (currently the inspector input falls
 *  back to `spec.name`/`spec.id` rather than rendering the reason, but
 *  the field is here for symmetry with the validation API on
 *  `validateConstruction` / `canExpandIsland`). */
export interface RenameIslandResult {
  readonly ok: boolean;
  readonly reason?: 'empty' | 'too-long' | 'control-char';
}

/** Outcome of `validateIslandName`. On success `name` is the trimmed,
 *  validated string ready to assign to `spec.name`. On failure `reason`
 *  enumerates which rule rejected the input. Pure data — no mutation.
 *
 *  Sole source of truth for "is this a valid island name?": both
 *  `renameIsland` (inspector rename path) and `construction-ui.ts`
 *  (artificial-island creation form) consume this predicate so the rules
 *  can't drift between the two entry points. */
export type ValidateNameResult =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly reason: 'empty' | 'too-long' | 'control-char' };

/** Pure predicate — validate `raw` as an island name. Trims surrounding
 *  whitespace; empty (post-trim) rejects with `'empty'`; >`ISLAND_NAME_MAX_LEN`
 *  characters rejects with `'too-long'`; any ascii control character
 *  (`\x00-\x1F` or `\x7F`) rejects with `'control-char'`. On success the
 *  returned `name` is the post-trim string; callers that want to MUTATE
 *  an `IslandSpec` should use `renameIsland`, which wraps this predicate. */
export function validateIslandName(raw: string): ValidateNameResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length > ISLAND_NAME_MAX_LEN) return { ok: false, reason: 'too-long' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return { ok: false, reason: 'control-char' };
  return { ok: true, name: trimmed };
}

/** Validate `name` via `validateIslandName` and (on success) mutate
 *  `spec.name` in place. Pure with respect to the rest of the world —
 *  does not touch routes, drones, or island state. The internal `id` is
 *  never modified. */
export function renameIsland(spec: IslandSpec, name: string): RenameIslandResult {
  const v = validateIslandName(name);
  if (!v.ok) return { ok: false, reason: v.reason };
  spec.name = v.name;
  return { ok: true };
}

/**
 * Point-in-island hit-test. A point lies inside an island iff it lies inside
 * ANY of the island's constituent ellipses (§3.6 union semantics). Pure.
 *
 * Each constituent is centred at `(spec.cx + offsetX, spec.cy + offsetY)`
 * with semi-axes `(major, minor)`. The primary constituent has offset (0, 0).
 */
export function pointInIsland(spec: IslandSpec, wx: number, wy: number): boolean {
  for (const c of islandConstituents(spec)) {
    const dx = wx - (spec.cx + c.offsetX);
    const dy = wy - (spec.cy + c.offsetY);
    if ((dx * dx) / (c.major * c.major) + (dy * dy) / (c.minor * c.minor) <= 1) {
      return true;
    }
  }
  return false;
}

/**
 * True iff world tile `(wx, wy)` does NOT fall inside any island's union
 * footprint. Pure helper wrapping `pointInIsland` against `world.islands`.
 *
 * Used by `validateOceanPlacement` (placement.ts) to gate the §3 ocean-
 * footprint check so a placement whose cell footprint overlaps island
 * tiles is rejected with `land-overlap` rather than slipping through on
 * `terrainAt`'s implicit-`deep` fallback for unmapped cells. (Cells
 * INSIDE an island's tile grid aren't stored in `world.oceanCells`, so
 * `terrainAt` would otherwise default them to `deep` and falsely accept
 * Open-Water Extractor placement on the middle of an island.)
 */
export function isOceanTile(world: WorldState, wx: number, wy: number): boolean {
  for (const isl of world.islands) {
    if (pointInIsland(isl, wx, wy)) return false;
  }
  return true;
}

/**
 * Point-in-ellipse hit-test for active-island selection. Returns the first
 * populated island whose union-footprint covers `(wx, wy)` (in world-tile
 * coords), or null if the point lies outside every populated island.
 * Fractional coordinates accepted — the click pivots from screenToWorldTile,
 * which doesn't snap to integer tiles.
 *
 * Iterates only `populated` islands (active-island switching is the player
 * picking which colony to focus on; discovered-only islands have no state
 * and can't be active). First match wins, so overlapping populated islands
 * would pick the one earlier in the spec array — but per §3 islands are
 * spaced so this case doesn't arise in practice (and after §3.6 merges,
 * the surviving identity carries all overlapping constituents).
 */
export function findPopulatedIslandAt(
  wx: number,
  wy: number,
  islands: ReadonlyArray<IslandSpec>,
): IslandSpec | null {
  for (const s of islands) {
    if (!s.populated) continue;
    if (pointInIsland(s, wx, wy)) return s;
  }
  return null;
}

/**
 * §3.6 ellipse-overlap test. Two islands overlap iff ANY pair of their
 * constituent ellipses overlap. For each pair `(cA, cB)` we use the
 * "sum of semi-axes" axis-aligned ellipse test:
 *
 *   `(dx²/(aA+aB)²) + (dy²/(bA+bB)²) ≤ 1`
 *
 * where `(dx, dy)` is the offset between the two constituent world centres.
 * This is exact for axis-aligned ellipses (it tests whether the centre of
 * one lies inside the Minkowski-sum ellipse of the two) and a conservative
 * over-approximation for rotated ellipses. `IslandSpec.rotation` is set
 * for Coast islands (§3.4) but no geometry consumer — including this
 * overlap test, the tile-inscription, or the renderer — currently honours
 * it, so the axis-aligned approximation matches the realised shape on
 * screen. When rotation lands in the geometry layer, this test will need
 * a rotated-ellipse SAT or similar replacement.
 *
 * Pure. Returns `true` on tangent contact (≤, not <).
 */
/**
 * §3.6 merge trigger: do the two islands' inscribed-TILE footprints touch?
 *
 * Returns true iff some buildable tile of `a` shares a cell with, or is
 * ORTHOGONALLY adjacent (shares an edge — N/E/S/W) to, a buildable tile of `b`.
 * Diagonal (corner-only) contact does NOT count: two tiles touching at a single
 * point still have ocean on both flanks, so the land masses are not connected —
 *     [a][ ]
 *     [ ][b]
 * must not merge. Merge fires only when there is no ocean tile between them along
 * a shared edge ("touching land").
 *
 * This deliberately replaces the old continuous ellipse-overlap test. A tile
 * only counts as land when ALL FOUR of its corners are STRICTLY inside the
 * ellipse (§3.4), so the discrete footprint is ~1–2 tiles smaller than the
 * mathematical ellipse. Two ellipses could therefore overlap in a thin boundary
 * band that holds no buildable tile of either island — and the old test merged
 * islands that still had visible ocean between them. Comparing the rasterized
 * footprints fixes that: merge fires exactly when the land masses actually meet.
 *
 * Broad phase: reject pairs whose world bounding boxes are more than one tile
 * apart — O(constituents), rejects every distant pair before any rasterization.
 * Narrow phase: an overlap-or-edge-adjacent membership test of every `b` tile
 * against `a`'s memoized world tile set. Offline catch-up never mutates geometry,
 * so the memoized sets build once and serve cheap lookups across thousands of
 * `findNextMerge` steps.
 */
// Self (overlap) + the four orthogonal neighbours. Diagonals are intentionally
// excluded — see the corner-touch note above.
const TOUCH_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
];

export function islandsOverlap(a: IslandSpec, b: IslandSpec): boolean {
  fillAabb(a, _aabbA);
  fillAabb(b, _aabbB);
  if (
    _aabbA.maxX + 1 < _aabbB.minX || _aabbB.maxX + 1 < _aabbA.minX ||
    _aabbA.maxY + 1 < _aabbB.minY || _aabbB.maxY + 1 < _aabbA.minY
  ) {
    return false;
  }
  const aSet = islandWorldTileSet(a);
  for (const [lx, ly] of islandLocalTiles(b)) {
    const wx = b.cx + lx;
    const wy = b.cy + ly;
    for (const [ox, oy] of TOUCH_OFFSETS) {
      if (aSet.has(`${wx + ox},${wy + oy}`)) return true;
    }
  }
  return false;
}

// PERF: rasterizing a constituent's bounding box is O(major×minor) and
// allocates a Set<string> of "x,y" keys. islandTileCount AND islandsOverlap are
// called once per populated island PER world-systems catch-up step (≈3600× for a
// 1h offline gap, via findNextMerge) AND once per server push/intent. A CPU
// profile showed the rasterization as >50% of catch-up CPU and ~5% of every push.
//
// The buildable-tile set is a pure function of the spec's ellipse GEOMETRY only
// — majorRadius, minorRadius, and each extraEllipses entry's major/minor/offsetX/
// offsetY (rotation is NOT read; cx/cy are NOT read — the LOCAL tiles are
// position-independent). We memoize on a CONTENT key, not object identity, for
// two reasons: (1) every deserialize builds fresh spec objects, so an identity
// key would miss on every push; a content key hits across pushes of the same
// geometry. (2) A §3.6 merge mutates extraEllipses (and §3.4 mutates the radii)
// IN PLACE on the same spec object (attachTerrainAt's by-reference contract), so
// a changed geometry yields a new key ⇒ recompute; an identity key would return
// a STALE result. Exact string key ⇒ zero collision risk: equal key ⇒ equal
// geometry ⇒ provably equal tiles. Both caches are capped + cleared wholesale.
//
// Two derived caches: the LOCAL tile list (geometry-keyed, used by islandTileCount
// and as the source for world translation) and the WORLD tile-key Set (geometry @
// position keyed, used by islandsOverlap's narrow phase). Offline catch-up never
// mutates geometry, so a near-touching pair's world sets build once then serve
// cheap membership lookups across every subsequent findNextMerge step.
const tileListCache = new Map<string, ReadonlyArray<readonly [number, number]>>();
const worldTileSetCache = new Map<string, ReadonlySet<string>>();
const TILE_CACHE_CAP = 4096;

function tileCountCacheKey(spec: IslandSpec): string {
  let key = `${spec.majorRadius}|${spec.minorRadius}`;
  if (spec.extraEllipses) {
    for (const e of spec.extraEllipses) key += `|${e.major},${e.minor},${e.offsetX},${e.offsetY}`;
  }
  return key;
}

/** Rasterize the deduplicated set of LOCAL inscribed tiles (island-local coords,
 *  relative to cx/cy). Each constituent's tiles are the unit squares whose four
 *  corners all lie strictly inside that constituent's ellipse (§3.4). */
function computeIslandLocalTiles(spec: IslandSpec): Array<readonly [number, number]> {
  const seen = new Set<string>();
  const tiles: Array<readonly [number, number]> = [];
  for (const c of islandConstituents(spec)) {
    // Bounding box for this constituent in island-local coords.
    const xMin = Math.floor(c.offsetX - c.major);
    const xMax = Math.ceil(c.offsetX + c.major);
    const yMin = Math.floor(c.offsetY - c.minor);
    const yMax = Math.ceil(c.offsetY + c.minor);
    const a2 = c.major * c.major;
    const b2 = c.minor * c.minor;
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        // Inscribed test: all four corners of the unit square strictly
        // inside the constituent ellipse (centered at offsetX, offsetY).
        let inside = true;
        for (const [cx, cy] of [
          [x, y],
          [x + 1, y],
          [x, y + 1],
          [x + 1, y + 1],
        ] as const) {
          const dx = cx - c.offsetX;
          const dy = cy - c.offsetY;
          if ((dx * dx) / a2 + (dy * dy) / b2 >= 1) {
            inside = false;
            break;
          }
        }
        if (inside) {
          const k = `${x},${y}`;
          if (!seen.has(k)) {
            seen.add(k);
            tiles.push([x, y]);
          }
        }
      }
    }
  }
  return tiles;
}

/** Memoized LOCAL inscribed-tile list, deduplicated across constituents. */
function islandLocalTiles(spec: IslandSpec): ReadonlyArray<readonly [number, number]> {
  const key = tileCountCacheKey(spec);
  const cached = tileListCache.get(key);
  if (cached !== undefined) return cached;
  const tiles = computeIslandLocalTiles(spec);
  if (tileListCache.size >= TILE_CACHE_CAP) tileListCache.clear();
  tileListCache.set(key, tiles);
  return tiles;
}

/** Memoized WORLD-coords tile-key Set, keyed by geometry AND position. */
function islandWorldTileSet(spec: IslandSpec): ReadonlySet<string> {
  const key = `${tileCountCacheKey(spec)}@${spec.cx},${spec.cy}`;
  const cached = worldTileSetCache.get(key);
  if (cached !== undefined) return cached;
  const set = new Set<string>();
  for (const [lx, ly] of islandLocalTiles(spec)) set.add(`${spec.cx + lx},${spec.cy + ly}`);
  if (worldTileSetCache.size >= TILE_CACHE_CAP) worldTileSetCache.clear();
  worldTileSetCache.set(key, set);
  return set;
}

/** Conservative world-space bounding box over every constituent ellipse — the
 *  cheap broad-phase reject for islandsOverlap (no rasterization).
 *
 *  PERF: writes into a caller-supplied object instead of returning a fresh one.
 *  islandsOverlap (the ONLY caller) is synchronous and non-reentrant, so two
 *  reused module-level scratch bounds avoid a per-pair heap allocation — this is
 *  the broad-phase reject hit ~3M times per offline catch-up (O(N²) pairs ×
 *  findNextMerge's per-step rescan). The fields are read directly rather than via
 *  islandConstituents(), which itself allocates an array + object-spreads each
 *  call. Identical AABB (primary at (cx,cy) with the spec radii, plus any
 *  extraEllipses at their offsets). */
interface Aabb { minX: number; maxX: number; minY: number; maxY: number; }
const _aabbA: Aabb = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
const _aabbB: Aabb = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
function fillAabb(spec: IslandSpec, out: Aabb): void {
  const { cx, cy } = spec;
  let minX = cx - spec.majorRadius, maxX = cx + spec.majorRadius;
  let minY = cy - spec.minorRadius, maxY = cy + spec.minorRadius;
  if (spec.extraEllipses) {
    for (const e of spec.extraEllipses) {
      const ex = cx + e.offsetX, ey = cy + e.offsetY;
      if (ex - e.major < minX) minX = ex - e.major;
      if (ex + e.major > maxX) maxX = ex + e.major;
      if (ey - e.minor < minY) minY = ey - e.minor;
      if (ey + e.minor > maxY) maxY = ey + e.minor;
    }
  }
  out.minX = minX; out.maxX = maxX; out.minY = minY; out.maxY = maxY;
}

/**
 * §3.6 total tile count across all constituents, deduplicated for tiles
 * shared by overlapping constituents (a tile counts once regardless of how
 * many constituents inscribe it). Pure (memoized — see the PERF note above).
 *
 * Used by `chooseMergeAbsorber` to decide which island is "larger" at the
 * moment of merge, and by `findNextMerge` to order multi-pair merges by
 * combined tile count.
 */
export function islandTileCount(spec: IslandSpec): number {
  return islandLocalTiles(spec).length;
}

/**
 * Classify a single island into one of three render states.
 *
 * Logic (the population short-circuit means we don't have to set
 * `discovered: true` redundantly on populated islands — they're discovered
 * by definition):
 *
 *   1. populated                                 → 'visible'
 *   2. !discovered                               → 'unknown'
 *   3. ANY constituent centre is inside some VisionSource → 'visible'
 *   4. otherwise                                 → 'discovered'
 *
 * Vision is the UNION of `VisionSource` entries pre-computed by
 * `lighthouse.ts → computeVisionSources`: baseline padded ellipses (one per
 * populated constituent) plus Lighthouse circles. For merged islands the
 * test checks every constituent centre — the island reads as visible if any
 * of its constituents sits inside any source.
 */
export function islandRenderState(
  spec: IslandSpec,
  sources: ReadonlyArray<VisionSource>,
): IslandRenderState {
  if (spec.populated) return 'visible';
  if (!spec.discovered) return 'unknown';
  // §3.6 merged-island handling: an island is visible if ANY of its
  // constituent centres lies inside any vision source. For a single-ellipse
  // island this collapses to the natural "is the centre in vision?" check.
  for (const c of islandConstituents(spec)) {
    if (pointInVision(sources, spec.cx + c.offsetX, spec.cy + c.offsetY)) {
      return 'visible';
    }
  }
  return 'discovered';
}

/**
 * Render a single island's terrain + buildings into a fresh container, with
 * the container positioned at the island's world-pixel centre. The contents
 * are drawn in island-local coordinates (matching `renderIslandTiles` /
 * `renderBuildings` from step 1), and the container translation handles the
 * world placement.
 *
 * The render state only controls *whether* the island is drawn:
 *   - 'visible'    → full colour land
 *   - 'discovered' → full colour land (the surrounding mid-blue ocean tier
 *                    is the sole indicator of "known but no current info")
 *   - 'unknown'    → null (caller skips it; ocean tier C shows through)
 *
 * Earlier versions dimmed discovered islands via alpha + tint, which made
 * the steel-blue ocean tier bleed through the half-transparent land and
 * read as "ocean overlays the island". The ocean colour itself now carries
 * the world's vision-state info; the island stays opaque so it always
 * reads as land.
 */
export function renderIsland(spec: IslandSpec, state: IslandRenderState = 'visible'): Container | null {
  if (state === 'unknown') return null;
  const c = new Container();
  c.label = `island:${spec.id}:${state}`;
  // §3.6: merged islands span multiple constituents — pass `extraEllipses` so
  // the renderer covers the union, not just the primary ellipse.
  const tiles: Tile[] = computeIslandTiles(
    spec.majorRadius,
    spec.minorRadius,
    spec.terrainAt ?? (() => 'grass'),
    spec.extraEllipses,
  );
  c.addChild(renderIslandTiles(tiles));
  if (spec.buildings.length > 0) c.addChild(renderBuildings(spec.buildings));
  const px = tileToWorldPx(spec.cx, spec.cy);
  c.position.set(px.x, px.y);
  return c;
}

/**
 * §3.7 — Fresh new-game home spec factory. Returns a populated home island
 * with EMPTY buildings and the canonical Plains/r=16/Stable starting layout:
 *
 *   - biome: 'plains'
 *   - majorRadius/minorRadius: 16
 *   - populated: true, discovered: true
 *   - buildings: [] (no pre-placed buildings per §3.7)
 *   - modifiers: ['stable'] (no other modifiers per §3.7)
 *
 * Factory rather than const so each call mints a fresh mutable `buildings`
 * array — `makeInitialWorld` and tests that need a home spec both go
 * through this one path so the §3.7 contract has a single source of truth.
 */
function makeHomeIslandSpec(): IslandSpec {
  return attachTerrainAt({
    id: 'home',
    name: 'home',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 16,
    minorRadius: 16,
    // §3.7 hand-placed starter layout is locked within the original r16
    // footprint; growth beyond it generates procedural plains.
    baseLayoutRadius: 16,
    populated: true,
    discovered: true,
    // §3.7: empty buildings — the player places their first via the UI.
    buildings: [],
    // §3.7: Stable trait by default, no other modifiers.
    modifiers: ['stable'],
  });
}

/**
 * Hand-placed demo islands — TEST FIXTURE ONLY (production `makeInitialWorld`
 * no longer reads it). Provides a known multi-island layout for tests that
 * need one (e.g. `world.test.ts` "matches the demo layout",
 * `world-gen.test.ts` overlap-avoidance). State classifications:
 *
 *   - home plains (0, 0) populated                            → 'visible'  (state a)
 *   - forest-ne (40, -10) discovered, dist≈41 < 80 (vision)   → 'visible'  (state a, via vision)
 *   - desert-far (80, 60) discovered, dist=100 > 80           → 'discovered' (state b)
 *   - coast-unknown (180, 0) !discovered                      → 'unknown'  (out of step-6 drone range)
 *   - hidden-w (-50, 12) !discovered                          → 'unknown'  (within reach: 50 tiles SW)
 *   - hidden-s (35, 70) !discovered                           → 'unknown'  (within reach: ~78 tiles south)
 */
// Each fixture entry flows through `attachTerrainAt` so the inscription
// predicate captures the spec BY REFERENCE — see the helper's docblock
// (above) for the by-reference invariant and the test pinning it.

export const DEMO_ISLANDS_TEST_FIXTURE: ReadonlyArray<IslandSpec> = [
  attachTerrainAt({
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
    modifiers: ['stable'],
  }),
  attachTerrainAt({
    id: 'forest-ne',
    name: 'forest-ne',
    biome: 'forest',
    cx: 40,
    cy: -10,
    majorRadius: 10,
    minorRadius: 10,
    populated: true,
    discovered: true,
    buildings: [
      { id: 'forestne-dock-1',                defId: 'dock',                 x: 0,  y: 0 },
      { id: 'forestne-workshop-1',            defId: 'workshop',             x: -3, y: 0 },
      { id: 'forestne-logger-1',              defId: 'logger',               x: 3,  y: 3 },
      { id: 'forestne-platform-constructor-1', defId: 'platform_constructor', x: -4, y: -4 },
    ],
    modifiers: ['fertile'],
  }),
  attachTerrainAt({
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
    modifiers: ['mineral_rich'],
  }),
  attachTerrainAt({
    id: 'coast-unknown',
    name: 'coast-unknown',
    biome: 'coast',
    cx: 180,
    cy: 0,
    majorRadius: 14,
    minorRadius: 7,
    populated: false,
    discovered: false,
    buildings: [],
    modifiers: [],
  }),
  attachTerrainAt({
    id: 'hidden-w',
    name: 'hidden-w',
    biome: 'plains',
    cx: -50,
    cy: 12,
    majorRadius: 9,
    minorRadius: 9,
    populated: false,
    discovered: false,
    buildings: [],
    modifiers: [],
  }),
  attachTerrainAt({
    id: 'hidden-s',
    name: 'hidden-s',
    biome: 'forest',
    cx: 35,
    cy: 70,
    majorRadius: 8,
    minorRadius: 8,
    populated: false,
    discovered: false,
    buildings: [],
    modifiers: ['cursed_storms'],
  }),
];

/**
 * Top-level world container: the spec array (with mutable `discovered` flags),
 * the in-flight drone fleet, and other world-scoped fleets/state. Built once
 * via `makeInitialWorld`; mutations happen in-place.
 *
 * `IslandState` (in `economy.ts`) is per-island runtime; `WorldState` lives
 * alongside it. Drones live on `WorldState`, not on any single island state.
 */
export interface WorldState {
  /** Mutable: `discovered` flag flips when drones return. The `IslandSpec`
   *  objects themselves are reused — drone-discovery touches one field. */
  islands: IslandSpec[];
  /** Procedural seed used for weather and other deterministic world systems.
   *  Frozen at world creation; reloads carry the same seed. */
  readonly seed: string;
  /** Mutable: drones list grows on dispatch, shrinks on return. The
   *  inline-import keeps this a type-only edge so `world.ts` doesn't take a
   *  runtime dependency on `drones.ts` (the dependency goes the other way:
   *  `drones.ts` consumes `WorldState`). */
  drones: import('./drones.js').Drone[];
  /** Mutable: player-created inter-island routes. Each route carries its own
   *  in-flight batch buffer (§2.4 hybrid latency model). Like `drones`, the
   *  module dependency points `routes.ts → world.ts`; the type-only import
   *  keeps the back-edge cycle-free. */
  routes: Route[];
  /** Mutable: §12 settlement vehicles in flight (ships + helicopters). Each
   *  vehicle is consumed on arrival — list grows on dispatch, shrinks on
   *  tick when arrival fires. Same type-only-import discipline as drones
   *  and routes; the runtime dependency is `settlement.ts → world.ts`. */
  vehicles: import('./settlement.js').SettlementVehicle[];
  /** §11 telemetry: set of stratification-cell keys (format `"cellX,cellY"`)
   *  the player has revealed. Initially seeded with every cell touched by a
   *  populated island's footprint (so home isn't pitch-dark). Mutated by
   *  `tickDrones`: a drone inside an Antenna's signal range adds its current
   *  scan-corridor cells to this set each tick. Persisted as a sorted array
   *  of strings. Replaces the per-island-center-flip discovery model. */
  revealedCells: Set<string>;
  /** Runtime island states keyed by island id. Not persisted as part of the
   *  world snapshot (serialization keeps it separate for schema stability);
   *  set by `main.ts` after init/load. */
  islandStates?: Map<string, IslandState>;
  /** §14.2 orbital satellite fleet. Mutable: grows on successful launch.
   *  Same type-only-import discipline as drones/routes/vehicles; the runtime
   *  dependency is `orbital.ts → world.ts`. */
  satellites: import('./orbital.js').Satellite[];
  /** §14.12 T6 Repair Drone fleet. Mutable: grows on dispatch, shrinks on
   *  arrival resolution. Same type-only-import discipline. */
  repairDrones: import('./orbital.js').RepairDrone[];
  /** §14.8 orbital debris fields. Mutable. Same type-only-import discipline. */
  debrisFields: import('./orbital.js').DebrisField[];
  /** Tutorial onboarding state. Optional so legacy saves and test fixtures
   *  compile without change; `makeInitialWorld` always seeds it. */
  tutorialState?: import('./tutorial.js').TutorialState;
  /** §13.3 Omniscient Lattice global activation flag. */
  latticeActive: boolean;
  /** Island IDs that have an active Lattice Node. */
  latticeNodeIslands: string[];
  /** §9.9 Active-Play Production Bonus balance — "effective focused
   *  milliseconds". Accrued/decayed by `tickActiveBonus` (active-bonus.ts);
   *  read via `activeBonusMul`. Optional so legacy saves and test fixtures
   *  compile without change; `makeInitialWorld` always seeds it. */
  activeBonusMs?: number;
  /** §9.9 Wall-clock ms of the player's last activity heartbeat/tick.
   *  Optional on legacy saves; `deserializeWorld` defaults it to `savedAt` so
   *  closed-game decay is unchanged. `makeInitialWorld` seeds it to 0. */
  lastActiveMs?: number;
  /** §9.8 server-authoritative trade offers — live, wall-clock-timed offers
   *  the player can accept. In REMOTE the server owns this list (spawn/expire
   *  on the activity heartbeat + catch-up); in LOCAL the client tick owns it.
   *  Optional so legacy saves and fixtures compile; seeded `[]` by
   *  `makeInitialWorld` and the v24→v25 migration. */
  tradeOffers?: import('./trade.js').TradeOffer[];
  /** §14.4 in-flight comm packets. Mutable. */
  commPackets: import('./orbital.js').CommPacket[];
  /** §2.1 infinite map — set of cell keys (`"cellX,cellY"`) that have
   *  already been considered by the procedural generator. New cells the
   *  player reaches via drone / satellite / route are generated lazily
   *  via `ensureCellGenerated` (see `world.ts`); the cell is added here
   *  on first generation so subsequent calls short-circuit. Optional for
   *  back-compat with pre-§2.1-infinite saves; absent === treat the v4
   *  migration's "every cell in `[-10, +10]²` was generated at boot" set
   *  as the implicit baseline. */
  generatedCells?: Set<string>;
  /** Ocean-layer §2 — sparse terrain map keyed `"cellX,cellY"`. Cells NOT
   *  in the map are implicit `deep` (the default tier; saves memory for
   *  the vast empty seas between islands). Populated during world-gen
   *  after island placement (`generateOceanTerrain`, future ocean-gen
   *  module); consumed by placement validation, render glyphs, and the
   *  sonar-buoy reveal path via `ocean-cell.ts` helpers (`terrainAt`,
   *  `footprintMatches`). Mutable — generation, save migration, and
   *  feature edits all write through the same map instance. */
  oceanCells: Map<string, OceanCellSpec>;
  /** Ocean-layer §5 — set of ocean cell keys (`"cellX,cellY"`) the player
   *  has revealed for DEPTH (the ocean-layer feature glyph). Separate
   *  from `revealedCells` (surface discovery): a cell can be
   *  surface-known but depth-unknown until a Sonar Buoy or Scanner Sat
   *  upgrade covers it. Starts empty on a fresh game and on v4→v5
   *  migrations — players who already explored have surface visibility
   *  but no depth knowledge yet. Mutable: discovery writers add cell
   *  keys as sonar coverage advances. */
  depthRevealedCells: Set<string>;
  /** §si-units Phase 1 — global CO₂ pool in kg. */
  totalCo2Kg: number;
  /** §si-units Phase 1 — player geo-latitude in [-90, +90] or null. */
  playerLat: number | null;
  /** §si-units Phase 1 — player geo-longitude in [-180, +180] or null. */
  playerLon: number | null;
  /** Phase 7 §05 — set of building def-ids the player tried to place
   *  but failed. 5 s TTL maintained by main.ts; consumed by tutorial
   *  steps 9 + 10 (copper / limestone) and step 25 (biome gating).
   *  NOT persisted. */
  recentBuildAttempts: Set<BuildingDefId>;
  /** Parallel timestamp map for TTL cleanup. NOT persisted. */
  recentBuildAttemptTs: Map<BuildingDefId, number>;

}

/** Default seed for the procedural world. Could later be made
 *  player-configurable; for now every fresh game uses the same string,
 *  yielding the same world. Persistence freezes the resolved island list,
 *  so reloads don't depend on this constant staying stable. */
export const WORLD_SEED = 'rio-2026';

/** Default world-gen options. Boot-time bulk generation covers cells in
 *  `[-halfExtentCells, +halfExtentCells]²`; the player extends the world
 *  outward as drones / satellites enter new cells via
 *  `ensureCellGenerated` (lazy, infinite).
 *
 *  Density 0.02, single island per cell (no multi-island fan-out): biases
 *  toward "stranded but reachable" — most cells stay empty ocean; the cells
 *  that do roll an island sit far enough apart that the next neighbour is
 *  always a drone-hop away but rarely the next cell over. Paired with
 *  `OVERLAP_BUFFER_TILES = 16` so cross-cell placements never crowd. Lowered
 *  from 0.08 (2026-06-11): the old value read ~3× too dense in play. Because
 *  overlap rejection makes island count sub-linear in density, 0.02 thins the
 *  realized count ~3× (not the ~4× a linear reading of the ratio implies). */
export const DEFAULT_GEN_OPTS: {
  readonly seed: string;
  readonly halfExtentCells: number;
  readonly cellSizeTiles: number;
  readonly density: number;
} = {
  seed: WORLD_SEED,
  halfExtentCells: 10,
  cellSizeTiles: CELL_SIZE_TILES,
  density: 0.02,
};

/**
 * Build the working world per §3.7: one populated home island, empty
 * buildings, plus a procedural batch of undiscovered neighbours. Generation
 * runs once on first start; the resolved island list is persisted, so
 * reloads don't regenerate.
 *
 * Pre-§3.7-cleanup this seeded six hand-placed demo islands (forest-ne,
 * desert-far, etc.) as a bootstrap shortcut. Those islands are now
 * retained only as a test fixture (`DEMO_ISLANDS_TEST_FIXTURE`) — the
 * production new-game world is the home + procedural layout.
 */
export function makeInitialWorld(_nowMs: number, seed: string = WORLD_SEED): WorldState {
  // §3.7 fresh-game seed: a single populated home island. Procedural
  // generation appends undiscovered neighbours below. `seed` drives island
  // placement / biomes / ocean terrain so each account's world is unique —
  // the server passes the save's creation (registration / reset) timestamp;
  // callers that omit it (LOCAL debug, tests, demos) get the canonical
  // WORLD_SEED. The home island itself is hand-placed and seed-independent.
  const islands: IslandSpec[] = [makeHomeIslandSpec()];
  // Procedural generation runs here, ONCE per fresh game. The resolved
  // list is persisted via the v3 snapshot path; reloads bypass this code.
  // Overlap detection takes home as `existingIslands` so the first
  // generated island never lands on top of (0, 0).
  // `world-gen.ts` imports `world.ts` for `IslandSpec` only as a type-only
  // edge, so the dependency cycle is type-side and TS handles it.
  const generated = generateWorld({ ...DEFAULT_GEN_OPTS, seed, existingIslands: islands });
  for (const g of generated) islands.push(g);
  // §11 telemetry: seed revealedCells with every cell touched by a
  // populated OR already-discovered island's footprint. With only home
  // populated at start, this seeds just home's cells — every procedural
  // island is undiscovered and stays under the fog overlay until a drone
  // scouts it. `islandCells` walks every constituent (primary +
  // extraEllipses) so merged islands are seeded correctly.
  const revealedCells = new Set<string>();
  for (const spec of islands) {
    if (!spec.populated && !spec.discovered) continue;
    for (const k of islandCells(spec)) revealedCells.add(k);
  }
  // §2.1 infinite map — record every cell the boot sweep considered so
  // subsequent lazy `ensureCellGenerated` calls don't re-roll them.
  const generatedCells = new Set<string>();
  const N = DEFAULT_GEN_OPTS.halfExtentCells;
  for (let cy = -N; cy <= N; cy++) {
    for (let cx = -N; cx <= N; cx++) generatedCells.add(`${cx},${cy}`);
  }
  // Ocean-layer §2 — derive terrain from the seed + island layout.
  // Pure + deterministic: same seed + same islands ⇒ same cells. The
  // generator scans only a bounding rect around the placed islands;
  // empty seas beyond that rect stay implicit `deep` via `terrainAt`'s
  // fallback in `ocean-cell.ts`.
  const oceanCells = generateOceanTerrain(seed, islands);
  // Ocean-layer §5 — depth visibility starts empty. Sonar Buoys and Scanner
  // Sat upgrades populate it as the player builds those revealers.
  const depthRevealedCells = new Set<string>();
  return { islands, drones: [], routes: [], vehicles: [], revealedCells, seed, satellites: [], repairDrones: [], debrisFields: [], tutorialState: { completed: new Set(), current: 'place_solar' }, latticeActive: false, latticeNodeIslands: [], activeBonusMs: 0, tradeOffers: [], commPackets: [], totalCo2Kg: 0, playerLat: null, playerLon: null, generatedCells, oceanCells, depthRevealedCells, recentBuildAttempts: new Set(), recentBuildAttemptTs: new Map() };
}

/**
 * §2.1 infinite map — lazily generate the islands in cell `(cellX, cellY)`
 * if not already done. Drones / satellites / routes / discovery call this
 * as they enter new cells; the function short-circuits if the cell is
 * already in `world.generatedCells`. Newly-minted island specs are pushed
 * onto `world.islands` (so existing render / vision pipelines see them
 * without further hooks).
 *
 * Cross-cell overlap honours the 8 neighbour cells' existing islands via
 * a centre-distance check; if the cell's candidate would overlap, the
 * candidate is dropped (the cell is "stranded") and the cell still gets
 * marked generated so the negative result is sticky.
 *
 * Returns the new islands (possibly empty). Pure-mutating: only touches
 * `world.islands` and `world.generatedCells`.
 */
export function ensureCellGenerated(world: WorldState, cellX: number, cellY: number): IslandSpec[] {
  if (!world.generatedCells) world.generatedCells = new Set<string>();
  const key = `${cellX},${cellY}`;
  if (world.generatedCells.has(key)) return [];
  world.generatedCells.add(key);
  // Pull neighbour-cell islands for the overlap check. We pass ALL
  // existing islands (cheap linear scan, and the spec already promises
  // the buffer applies cross-cell to ANY existing island).
  const newSpecs = generateCellIslands(
    world.seed,
    cellX,
    cellY,
    CELL_SIZE_TILES,
    DEFAULT_GEN_OPTS.density,
    world.islands,
  );
  for (const s of newSpecs) world.islands.push(s);
  // Ocean-layer §2 — seed shallows and vents for the newly minted specs so
  // lazy generation produces the same terrain as the boot-time sweep.
  if (newSpecs.length > 0) {
    seedOceanTerrainForIslands(world.oceanCells, world.seed, world.islands, newSpecs);
  }
  return newSpecs;
}

// Initial economy state.
//
// `IslandSpec` describes the static layout (terrain, ellipse, building
// placements); `IslandState` carries the mutable per-island runtime
// (inventory, level, XP, lastTick). They're kept separate so the spec can
// remain `readonly`.

/**
 * Starting inventory — rev-9 starter per rev-16 §12.9.3 + Phase 7 design spec
 * §03. §14 added placement costs (stone + wood for every T1 building), so the
 * literal §3.7 "empty inventory" no longer bootstraps; these line items are
 * sized so the player can reach 1x battery_bank in <= 45 minutes via the
 * canonical tutorial chain.
 *
 * Reachability is gated by src/reachability.test.ts — DO NOT lower any
 * value without re-checking that the 45-min invariant holds.
 */
function startingInventory(): Record<ResourceId, number> {
  const inv = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) inv[r] = 0;
  inv.stone           = 1200;
  inv.wood            = 600;
  inv.iron_ore        = 30;
  inv.coal            = 80;
  inv.iron_ingot      = 60;
  inv.bolt            = 25;
  inv.limestone       = 15;
  inv.saltwater_cell  = 4;
  inv.foundation_kit  = 1;
  inv.scrap           = 5000; // §rev-17 salvage cache — bootstraps the steel chain (scrap → steel_mill_scrap → steel → beam_mill → steel_beam)
  // steel intentionally 0 — player walks the iron→steel chain.
  return inv;
}



/**
 * Aggregate placement-time storage caps from a building list per §4.6
 * categorized storage:
 *
 *   - Specialized buildings (Silo, Tank, Cold Storage, Component
 *     Warehouse, Vault) add their `storage.capacity` to every resource
 *     whose `RESOURCE_STORAGE_CATEGORY` matches the def's category.
 *   - Generic buildings (Crate, Warehouse) add their capacity only to the
 *     single resource named on the PlacedBuilding's `cargoLabel`. An
 *     unlabeled generic building (cargoLabel === undefined) contributes
 *     nothing — forward-compatible with old saves and with freshly-placed
 *     buildings that haven't been labeled yet.
 *
 * Baseline caps are per-resource: override from RESOURCE_BASE_CAP, else
 *  per-category default from defaultCapForCategory().
 *
 * Pure — no PixiJS, no DOM, no IslandState dependency.
 */
export function aggregateStorageCaps(
  buildings: ReadonlyArray<PlacedBuilding>,
): Record<ResourceId, number> {
  const caps = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) {
    caps[r] = baselineCap(r);
  }
  for (const b of buildings) {
    const def = BUILDING_DEFS[b.defId];
    const storage = def.storage;
    if (!storage) continue;
    // `storage.capacity` is a percentage multiplier; the per-resource
    // contribution is `multiplier × storageBaseFor(r)` (§4.6).
    const mult = floorScaledCapacity(b, storage.capacity);
    if (storage.category === 'generic') {
      const label = b.cargoLabel;
      if (label !== undefined) {
        caps[label] = (caps[label] ?? 0) + mult * storageBaseFor(label);
      }
    } else {
      for (const r of ALL_RESOURCES) {
        if (RESOURCE_STORAGE_CATEGORY[r] === storage.category) {
          caps[r] = (caps[r] ?? 0) + mult * storageBaseFor(r);
        }
      }
    }
  }
  return caps;
}

/** Empty per-resource funnel-pending map. Every key zeroed so the
 *  `accrueXp` drain never sees `undefined`. */
function startingFunnelPending(): Record<ResourceId, number> {
  const f = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) f[r] = 0;
  return f;
}

/**
 * Build a fresh `IslandState` for a spec. `nowMs` seeds `lastTick` so the
 * first `advanceIsland` call doesn't replay history from epoch zero.
 */
export function makeInitialIslandState(spec: IslandSpec, nowMs: number): IslandState {
  return {
    id: spec.id,
    buildings: spec.buildings,
    inventory: startingInventory(),
    storageCaps: aggregateStorageCaps(spec.buildings),
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
    everProduced: new Set(),
    tradeCooldownMs: 0,
    tradeAcceptCount: 0,
    auraAmpVersion: 0,
    auraAmpCache: null,
    auraAmpCacheVersion: -1,   // -1 forces miss on first computeAuraAmplifiers call
    co2Kg: 0,
    funnelPending: startingFunnelPending(),
    // §13.1 T5 access gate. Defaults to false on every fresh island — T5
    // catalog rows stay locked until the player has both reached level 50
    // and crafted at least one AI core. Auto-flips to true on first
    // `ai_core` production via `state.aiCoreCrafted = true` in
    // `economy.ts:1115`. (forest-ne demo seeds it manually via main.ts.)
    aiCoreCrafted: false,
    // §14.1 T6 access gate (first half). Defaults to false; the step-20
    // demo seeds this true manually on forest-ne alongside aiCoreCrafted.
    // Auto-flips to true on first `ascendant_core` production via the §13
    // auto-flip block in `economy.ts:advanceIsland`.
    ascendantCoreCrafted: false,
    // §9.7 Tier Reset cooldown anchor. Null on a fresh island — the player
    // hasn't ever paid for a reset yet, so the 24h block doesn't apply.
    lastResetAt: null,
    // §13.3 Time Lock defaults.
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    // §13.3 Genesis Chamber defaults to inactive.
    genesisTarget: null,
    // §13.3 Battery buffer defaults to empty.
    batteryStoredWs: 0,
    // §12.4 Starter inventory grace cap — no kit yet delivered.
    starterInventoryGrace: {} as Record<ResourceId, number>,
    socketBindings: new Map(),
    lastTick: nowMs,
  };
}
