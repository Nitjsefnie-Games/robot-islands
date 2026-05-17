// Multi-island world data + render coordination.
//
// Step-1 had a single home island rendered at world origin. Step-2 generalises:
// the world is a flat list of placed islands, each with its own centre in
// world-tile coordinates, its biome ellipse parameters, and any buildings
// sitting on it.
//
// Per SPEC §2.1 the world is partitioned into stratification cells of side R
// (the discovery guarantee radius). We use R=16 tiles as a placeholder cell
// size — enough to space the demo islands out and exercise the cell-grid
// overlay, but small enough that the home island's vision radius of 5 cells =
// 80 tiles spans a few neighbours.
//
// Vision model (three states):
//   - 'visible'    — populated, OR discovered AND inside some populated
//                    island's vision radius. Rendered at full color/alpha.
//   - 'discovered' — discovered but outside all vision radii. Rendered dimmed
//                    (alpha + cool tint) to read as "known, but no current
//                    info".
//   - 'unknown'    — not discovered. Not rendered at all; the dark page
//                    background shows through.

import { Container } from 'pixi.js';

import { rerollModifiers, terrainAtForBiome } from './biomes.js';
import type { ModifierId } from './biomes.js';
import { BUILDING_DEFS } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import { renderBuildings } from './buildings.js';
import { islandCells } from './discovery.js';
import type { IslandState } from './economy.js';
import type { EndgameState, VictoryCondition } from './endgame.js';
import { regenerateTerrain, type TerrainKind, type Tile } from './island.js';
import {
  computeIslandTiles,
  islandInscribedAny,
  renderIslandTiles,
  TILE_PX,
} from './island.js';
import { footprintTiles } from './shape-mask.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import type { Route } from './routes.js';
import { RESOURCE_STORAGE_CATEGORY } from './storage-categories.js';
import { pointInVision, type VisionSource } from './vision-source.js';
import { generateCellIslands, generateWorld } from './world-gen.js';

/** Stratification cell side length, in tiles. SPEC §2.1 calls this R. */
export const CELL_SIZE_TILES = 16;
/** Padding (in tiles) extending past each island's ellipse edge to form the
 *  baseline vision area. A populated island's baseline vision footprint is an
 *  axis-aligned ellipse with semi-axes `(majorRadius + VISION_PADDING_TILES,
 *  minorRadius + VISION_PADDING_TILES)` centered on the island. Replaces the
 *  earlier fixed-radius circle (80 from center) which over-reached for big
 *  circular biomes.
 *
 *  Lighthouse-vision redesign (§15.x): padding dropped from 50 → 10 — the
 *  baseline now reads as "you can see the immediate waters off your own
 *  coast" rather than auto-granting 50 tiles of free intel on every settle.
 *  Distant scouting now requires Lighthouse infrastructure
 *  (`lighthouse.ts → computeVisionSources`). */
export const VISION_PADDING_TILES = 10;
/** Discovery aura radius around any discovered island, in tiles.
 *  DEPRECATED: §11 telemetry redesign moved the medium-blue ocean tier
 *  from per-island halos to per-stratification-cell squares (see
 *  `WorldState.revealedCells`). The constant is retained as exported data
 *  for any external (debug/dev-tools) consumer that might query it; no
 *  in-tree code reads it. */
export const DISCOVERY_RADIUS_TILES = 24;

// ---------------------------------------------------------------------------
// Ocean-tier palette
// ---------------------------------------------------------------------------
//
// Three discrete blues form the world's vision-state field. The colour step
// itself indicates the boundary between tiers — there is no outline ring.
//
//   VISION_BLUE     — luminous cyan-leaning shallow. Reads as "lit water,
//                     full information." Saturated and cool.
//   DISCOVERED_BLUE — desaturated steel mid-blue. Reads as "we surveyed
//                     this once; the lights are off now." Drops both
//                     lightness and chroma vs vision so the perceptual
//                     gap is two-axis, not just lightness.
//   UNKNOWN_BLUE    — the page background exactly. Unknown ocean fuses
//                     visually with the page void; "unknown" reads as
//                     absence rather than as a competing dark colour.

// Derive from the shared design token so DOM panels and the in-canvas
// vision colours stay in lockstep. Adjusting a hue means editing
// `ui-tokens.ts` once; both worlds pick it up.
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
   *  Mutable in step 12: settlement-vehicle arrivals flip this from false →
   *  true on the target island. See `tickVehicles` in `settlement.ts`. */
  populated: boolean;
  /** Whether the player knows this island exists at all. Populated → discovered
   *  by definition (the classification function short-circuits on populated).
   *  Mutable in step 6: drone returns flip this from false→true on revealed
   *  islands. The rest of the spec stays readonly — only this flag changes. */
  discovered: boolean;
  /** Buildings placed on this island, in island-local tile coords. Mutable so
   *  step-2.5 placement can push onto the same array shared with
   *  `IslandState.buildings` (the state field is a live reference, not a
   *  copy — see `makeInitialIslandState`). The dual-array footgun is
   *  intentionally avoided: one array, two consumers, mutation flows to
   *  both. */
  buildings: PlacedBuilding[];
  /** Terrain function in island-local coords. Defaults to grass everywhere. */
  readonly terrainAt?: (x: number, y: number) => TerrainKind;
  /** Active modifiers on this island per §3.5. Step 8 hard-codes the demo
   *  set on `DEMO_ISLANDS`; future steps roll from `rollModifiers` at
   *  generation. Empty array means no modifiers active. */
  readonly modifiers: ReadonlyArray<ModifierId>;
  /** §2.5: islands built via Platform Constructor are flagged so future
   *  systems can deny natural-only content (rare-biome modifiers per §3.5,
   *  biome-locked uniques per §9.5). For step 11 the flag is metadata only —
   *  no current consumer; reserved for step 12. Undefined ≡ false (natural). */
  readonly artificial?: boolean;
  /** §3.6 island-joining: appended constituents accumulated when this island
   *  has absorbed others. Each entry is a secondary ellipse rendered/queried
   *  in addition to `majorRadius`/`minorRadius` (the primary at offset 0,0).
   *  Single-ellipse islands have `undefined` or `[]` — every existing code
   *  path treats those identically. Per §3.6 a tile is part of the island
   *  iff it is inscribed inside ANY constituent (primary or extra). Merges
   *  are permanent; the array only grows. `rotation` is carried for forward-
   *  compat with §3.4 rotation (not yet wired) — always 0 for now. */
  extraEllipses?: Array<{
    readonly major: number;
    readonly minor: number;
    readonly rotation: number;
    readonly offsetX: number;
    readonly offsetY: number;
  }>;
}

/** §3.6 constituent ellipse view — the primary ellipse re-expressed as the
 *  same shape as an `extraEllipses` entry. Centralises the "primary at
 *  (0,0), extras at their offsets" pattern that overlap / tile / hit-test
 *  / vision code all share. */
export interface ConstituentEllipse {
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
    { major: spec.majorRadius, minor: spec.minorRadius, rotation: 0, offsetX: 0, offsetY: 0 },
  ];
  if (spec.extraEllipses) {
    for (const e of spec.extraEllipses) out.push(e);
  }
  return out;
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
 * at every spec-construction site (procedural world-gen, persistence
 * rehydration, artificial-island construction, demo fixtures). Any future
 * refactor of the closure contract — predicate signature, what's captured,
 * how the cast is expressed — touches one place.
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
  ) =>
    terrainAtForBiome(spec.biome, spec.id, x, y, (px, py) =>
      islandInscribedAny(spec, px, py),
    );
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

// ---------------------------------------------------------------------------
// §3 player-mutable display name
// ---------------------------------------------------------------------------

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
 * §13.3 Reality Forge — reassign an island's biome, regenerate terrain,
 * reroll modifiers (excluding natural-only ones), and invalidate buildings
 * whose footprint no longer matches the new terrain.
 */
export function useRealityForge(
  world: WorldState,
  islandId: string,
  targetBiome: Biome,
): void {
  const spec = world.islands.find((i) => i.id === islandId);
  if (!spec) return;

  // Regenerate terrain. The inscription predicate references `spec` by
  // identity so a future §3.6 merge that mutates `extraEllipses` is
  // observed by the next terrainAt call (no closure-capture of radii).
  // Doesn't go through `attachTerrainAt` because `regenerateTerrain` already
  // takes a narrowed `{ biome; terrainAt? }` parameter — no readonly-widening
  // cast is needed at this site, so the shared helper would be pure
  // ceremony here.
  regenerateTerrain(spec, targetBiome, (x, y) =>
    terrainAtForBiome(targetBiome, spec.id, x, y, (px, py) =>
      islandInscribedAny(spec, px, py),
    ),
  );

  // Reroll modifiers — natural-only ones are excluded.
  (spec as unknown as { modifiers: ModifierId[] }).modifiers = rerollModifiers(WORLD_SEED, targetBiome);

  // Invalidate buildings that no longer match terrain.
  for (const b of spec.buildings) {
    const def = BUILDING_DEFS[b.defId];
    const tiles = footprintTiles(def.footprint, b.x, b.y, (b.rotation ?? 0) as 0 | 1 | 2 | 3);
    const stillValid = tiles.every((t) => {
      const terrain = spec.terrainAt?.(t.x, t.y);
      if (!terrain) return false;
      if (def.requiredTile && def.requiredTile.length > 0 && !def.requiredTile.includes(terrain)) {
        return false;
      }
      return true;
    });
    if (!stillValid) {
      b.invalid = true;
    }
  }
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
 * over-approximation for rotated ellipses — but island rotation is not yet
 * wired (§3.4 placeholder), so axis-aligned is the realistic shape.
 *
 * Pure. Returns `true` on tangent contact (≤, not <).
 */
export function islandsOverlap(a: IslandSpec, b: IslandSpec): boolean {
  const ac = islandConstituents(a);
  const bc = islandConstituents(b);
  for (const ca of ac) {
    const ax = a.cx + ca.offsetX;
    const ay = a.cy + ca.offsetY;
    for (const cb of bc) {
      const bx = b.cx + cb.offsetX;
      const by = b.cy + cb.offsetY;
      const dx = ax - bx;
      const dy = ay - by;
      const sumA = ca.major + cb.major;
      const sumB = ca.minor + cb.minor;
      if ((dx * dx) / (sumA * sumA) + (dy * dy) / (sumB * sumB) <= 1) {
        return true;
      }
    }
  }
  return false;
}

/**
 * §3.6 total tile count across all constituents, deduplicated for tiles
 * shared by overlapping constituents (a tile counts once regardless of how
 * many constituents inscribe it). Pure.
 *
 * Used by `chooseMergeAbsorber` to decide which island is "larger" at the
 * moment of merge, and by `findNextMerge` to order multi-pair merges by
 * combined tile count.
 */
export function islandTileCount(spec: IslandSpec): number {
  const seen = new Set<string>();
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
        if (inside) seen.add(`${x},${y}`);
      }
    }
  }
  return seen.size;
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
 * with EMPTY buildings and the canonical Plains/r=14/Stable starting layout:
 *
 *   - biome: 'plains'
 *   - majorRadius/minorRadius: 14
 *   - populated: true, discovered: true
 *   - buildings: [] (no pre-placed buildings per §3.7)
 *   - modifiers: ['stable'] (no other modifiers per §3.7)
 *
 * Factory rather than const so each call mints a fresh mutable `buildings`
 * array — `makeInitialWorld` and tests that need a home spec both go
 * through this one path so the §3.7 contract has a single source of truth.
 */
function makeHomeIslandSpec(): IslandSpec {
  return {
    id: 'home',
    name: 'home',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
    // §3.7 starter placeholder: empty buildings — the player must place
    // their first Solar Panel, Mine, etc. via the placement UI. The
    // previous demo seeded a dozen buildings (Solar/Workshop/Mines/
    // Dronepad/Smelter/Silo/Antenna/etc.) as a bootstrap shortcut; that
    // bypassed the §3.7 "no pre-placed buildings" contract.
    buildings: [],
    // Home preserves its hand-placed terrain map exactly — terrainAtForBiome
    // delegates to defaultTerrainAtHome for islandId === 'home' (so the
    // ore/coal/water tiles the player will Mine on still exist). The
    // `inscribed` predicate is unused on this branch — pass a permissive
    // `() => true` to satisfy the signature.
    terrainAt: (x, y) => terrainAtForBiome('plains', 'home', x, y, () => true),
    // §3.7: Stable trait by default, no other modifiers.
    modifiers: ['stable'],
  };
}

/**
 * Hand-placed demo islands — RETAINED FOR TESTS ONLY. Pre-§3.7-cleanup,
 * this array was the production seed for `makeInitialWorld` and shipped
 * a heavily pre-built home plus five hand-placed neighbours (forest-ne,
 * desert-far, coast-unknown, hidden-w, hidden-s). That bypassed §3.7's
 * "one populated home island, empty buildings, empty inventory" contract.
 *
 * It now serves exclusively as a test fixture for code that needs a
 * known multi-island world layout (e.g. `world.test.ts` "matches the
 * demo layout", `world-gen.test.ts` overlap-avoidance checks). The
 * production `makeInitialWorld` no longer reads it.
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
 * Top-level world container introduced in step 6. Wraps the spec array (now
 * with mutable `discovered` flags) and the in-flight drone fleet. Built once
 * at startup via `makeInitialWorld`; mutations happen in-place when drones
 * dispatch and return.
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
  /** §13.4 endgame progress tracking. */
  endgameState: EndgameState;
  /** §13.3 Omniscient Lattice global activation flag. */
  latticeActive: boolean;
  /** Island IDs that have an active Lattice Node. */
  latticeNodeIslands: string[];
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

}

/** Default seed for the procedural world. Could later be made
 *  player-configurable; for now every fresh game uses the same string,
 *  yielding the same world. Persistence freezes the resolved island list,
 *  so reloads don't depend on this constant staying stable. */
export const WORLD_SEED = 'rio-2026';

/** Default world-gen options. Boot-time bulk generation covers cells in
 *  `[-halfExtentCells, +halfExtentCells]²`; the player extends the world
 *  outward as drones / satellites enter new cells via
 *  `ensureCellGenerated` (lazy, infinite). Density 0.15 biases toward
 *  "almost stranded but one next island always reachable" per §2.1, paired
 *  with `OVERLAP_BUFFER_TILES = 12` so 14-tile Plains islands don't
 *  stack into peanut shapes. */
export const DEFAULT_GEN_OPTS: {
  readonly seed: string;
  readonly halfExtentCells: number;
  readonly cellSizeTiles: number;
  readonly density: number;
} = {
  seed: WORLD_SEED,
  halfExtentCells: 10,
  cellSizeTiles: CELL_SIZE_TILES,
  density: 0.15,
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
export function makeInitialWorld(_nowMs: number): WorldState {
  // §3.7 fresh-game seed: a single populated home island. Procedural
  // generation appends undiscovered neighbours below.
  const islands: IslandSpec[] = [makeHomeIslandSpec()];
  // Procedural generation runs here, ONCE per fresh game. The resolved
  // list is persisted via the v3 snapshot path; reloads bypass this code.
  // Overlap detection takes home as `existingIslands` so the first
  // generated island never lands on top of (0, 0).
  // `world-gen.ts` imports `world.ts` for `IslandSpec` only as a type-only
  // edge, so the dependency cycle is type-side and TS handles it.
  const generated = generateWorld({ ...DEFAULT_GEN_OPTS, existingIslands: islands });
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
  return { islands, drones: [], routes: [], vehicles: [], revealedCells, seed: WORLD_SEED, satellites: [], repairDrones: [], debrisFields: [], tutorialState: { completed: new Set(), current: 'place_solar' }, endgameState: { achieved: new Set<VictoryCondition>(), firstAchievedMs: null, victoryBannerShown: false }, latticeActive: false, latticeNodeIslands: [], commPackets: [], generatedCells };
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
  return newSpecs;
}

// ---------------------------------------------------------------------------
// Initial economy state
// ---------------------------------------------------------------------------
//
// `IslandSpec` describes the static layout (terrain, ellipse, building
// placements); `IslandState` carries the mutable per-island runtime
// (inventory, level, XP, lastTick). We keep them separated so the spec
// can remain `readonly` and `DEMO_ISLANDS` can stay a frozen literal.
//
// For step 3 we only build state for the home island — the other demo
// islands are unpopulated and have no buildings, so their economies are
// trivially "nothing happens". When colonization lands in a later step,
// `makeInitialIslandState` will be applied to each newly-populated spec.

/**
 * Starting inventory — §3.7 starter placeholder, tuned for first-build
 * bootstrap.
 *
 * Per SPEC §3.7 the literal reading is "Empty inventory: no starter
 * resources, no Foundation Kit." That contract held pre-§14 when placement
 * was free — the player just placed a Solar Panel + Mine + Workshop and
 * production filled inventory before they ever needed materials. §14 added
 * placement costs (stone + wood for every T1 building) which makes the
 * all-zero starter impossibly slow: with no placeable buildings, no Mine
 * to produce iron_ore, no Workshop, the early game stalls.
 *
 * The starter bundle below INTENTIONALLY contradicts §3.7's literal
 * "empty inventory" rule. The justification: all-zero starter + enforced
 * placement costs = unplayable. A minimal bootstrap kit lets the player
 * place a Mine (30 stone + 15 wood) + Coal Generator (50 + 25) on coal
 * tiles, plus an Antenna T1 (15 + 5) and a few more T1 buildings before
 * stone/wood production kicks in. Tuned to: enough for the first ~3-4
 * T1 buildings, not enough to skip the early-game extraction loop.
 *
 *   stone: 60          — Mine (30) + Antenna T1 (15) leaves 15 spare
 *   wood:  40          — Mine (15) + Antenna T1 (5)  leaves 20 spare
 *   foundation_kit: 1  — §12.3 starter kit for the first settlement
 *                        dispatch (Workshop/Kit Assembler recipes
 *                        refill it via stone+wood once production is up).
 *
 * §3.7 starter placeholder — tuned for first-build bootstrap.
 */
function startingInventory(): Record<ResourceId, number> {
  const inv = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) inv[r] = 0;
  // §3.7 starter placeholder — tuned for first-build bootstrap.
  inv.stone = 60;
  inv.wood = 40;
  inv.foundation_kit = 1;
  return inv;
}

/** Baseline cap before any storage building is placed. Rebalanced for
 *  idle-game scale, step #19: bumped from 100 → 2000 so a few minutes of
 *  T1 production doesn't instantly fill storage. Storage buildings add on
 *  top of this baseline. Exported so `placement.ts` and persistence
 *  forward-compat can use the same constant. */
export const BASELINE_STORAGE_CAP = 2000; // rebalanced for idle-game scale, step #19 (was 100)

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
 * Every resource starts at BASELINE_STORAGE_CAP, regardless of category.
 *
 * Pure — no PixiJS, no DOM, no IslandState dependency.
 */
export function aggregateStorageCaps(
  buildings: ReadonlyArray<PlacedBuilding>,
): Record<ResourceId, number> {
  const caps = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) caps[r] = BASELINE_STORAGE_CAP;
  for (const b of buildings) {
    const def = BUILDING_DEFS[b.defId];
    const storage = def.storage;
    if (!storage) continue;
    if (storage.category === 'generic') {
      const label = b.cargoLabel;
      if (label !== undefined) {
        caps[label] = (caps[label] ?? 0) + storage.capacity;
      }
    } else {
      for (const r of ALL_RESOURCES) {
        if (RESOURCE_STORAGE_CATEGORY[r] === storage.category) {
          caps[r] = (caps[r] ?? 0) + storage.capacity;
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
    // Fresh island has nothing to migrate — flag pre-applied so the
    // persistence load path doesn't top up on first save round-trip.
    skillPointGrantMigrationApplied: true,
    unlockedNodes: new Set(),
    subPathProgress: new Map(),
    funnelPending: startingFunnelPending(),
    // §9.4 specialization is undeclared at birth — every island starts as
    // a Generalist (no buff, no penalty). Declaration is gated by T3
    // (level ≥ 15) and one-way until §9.7 Tier Reset lands.
    specializationRole: null,
    declaredAt: null,
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
    // §13.3 Singularity Battery defaults to empty.
    singularityStoredWs: 0,
    // §12.4 Starter inventory grace cap — no kit yet delivered.
    starterInventoryGrace: {} as Record<ResourceId, number>,
    lastTick: nowMs,
  };
}
