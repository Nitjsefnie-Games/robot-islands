// Per-instance building placement + rendering.
//
// `PlacedBuilding` is the per-instance runtime: a unique id, the BuildingDefId
// pointer into the static catalog (`building-defs.ts`), and tile coordinates.
// Static per-kind data — footprint, fill, stroke, recipe binding, power —
// lives on `BuildingDef`; rendering looks it up via `BUILDING_DEFS[b.defId]`.
//
// The split lands per SPEC §15.1: many instances share one def, the def
// table drives the Building Catalog UI, and the placement runtime stays
// minimal. Rotation is wired into the type as `rotation: 0|1|2|3`; every
// demo instance still ships rotation: 0 until the placement UI rotation
// widget lands.

import { Container, Graphics, Text } from 'pixi.js';

import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { activeFloors, activeFloorLevel } from './floor-levels.js';
import type { PausedReason } from './economy.js';
import { TILE_PX, desaturate, lighten } from './island.js';
import type { ResourceId } from './recipes.js';
import { footprintTiles, type Rotation } from './shape-mask.js';

/** Per-instance placement. `id` is unique across the world; `defId` points
 *  into BUILDING_DEFS. (x, y) is the anchor tile of the footprint —
 *  the covered tiles are given by `footprintTiles(def.footprint, x, y, rot)`. */
export interface PlacedBuilding {
  readonly id: string;
  readonly defId: BuildingDefId;
  readonly x: number;
  readonly y: number;
  /** Per §15.1 BuildingDef shape, but placement (step 2.5) isn't built;
   *  every demo instance ships rotation: 0. Optional for forward-compat. */
  readonly rotation?: 0 | 1 | 2 | 3;
  /** §4.6 generic-storage label. Meaningful ONLY for buildings whose def
   *  carries `storage.category === 'generic'` (Crate, Warehouse). Names the
   *  single ResourceId this storage instance contributes capacity to.
   *  Undefined → no resource cap contribution (forward-compat with old saves
   *  written before this field existed; those Crates load with no label and
   *  the player can label them via the inspector). The economy treats
   *  undefined-label generic storage as zero-cap; on load it does NOT
   *  back-fill a default — the inspector relabel path is the only way to
   *  attach a resource to a previously-unlabeled Crate. Mutable: the
   *  inspector's §4.6 relabel path reassigns this field. */
  cargoLabel?: ResourceId;
  /** §4 ocean-layer anchor (Task 10). Set at placement time for any def with
   *  `oceanPlacement: true`; the named island credits the platform's output
   *  and supplies its power from the §5.3 unified pool. Per the §4 design
   *  doc (`docs/superpowers/specs/2026-05-18-ocean-layer-design.md`), an
   *  ocean platform lives logically on `anchorIslandId`'s `buildings[]` —
   *  the existing per-island economy tick credits anchor inventory + power
   *  with no separate dispatch path. Required for any ocean def to function:
   *  a missing or stale anchor (anchor unpopulated / deleted) halts the
   *  building with `paused === 'anchor-depopulated'` instead of producing.
   *  Undefined for non-ocean defs (forward-compat: legacy saves and land
   *  buildings simply omit the field). */
  readonly anchorIslandId?: string;
  /** §4 ocean-layer paused state (Task 10). Mutated by the economy tick when
   *  an ocean platform's preconditions fail (anchor unpopulated, terrain
   *  no longer ocean). When set, the building skips production / consumption
   *  / power-draw for that tick. Cleared back to undefined when the
   *  precondition recovers. Optional / undefined for non-paused buildings
   *  (the common case) and for every land building (which has no analogous
   *  pause state at present). */
  paused?: PausedReason;
  /** §4.7 maintenance: wall-clock perf-domain timestamp this building was
   *  placed at. Optional for forward-compat with saved buildings minted
   *  before the maintenance system shipped — those load with the field
   *  undefined and behave as if freshly placed (operatingMs = 0, factor 1.0)
   *  until the first auto-maintenance check stamps a real value. */
  readonly placedAt?: number;
  /** §9.3 Robotics: ms of construction time remaining before this building
   *  becomes operational. While > 0, the building does NOT produce, does NOT
   *  contribute to power balance, and does NOT accrue maintenance time.
   *  Mutated each tick in `advanceIsland`. Set on placement by `placeBuilding`
   *  from BASE_CONSTRUCTION_MS_BY_TIER[def.tier] / robotics.constructionTimeMul.
   *  Optional for forward-compat with saves minted before this field shipped
   *  (legacy = treat as 0 = fully constructed). */
  constructionRemainingMs?: number;
  /** §9.3 total ms of the in-progress construction job at the moment it was
   *  started (placement or upgrade). Used so the progress arc divides by the
   *  actual initial duration, which may differ from the unmultiplied base when
   *  Robotics `constructionTimeMul` is > 1. Optional for forward-compat with
   *  saves minted before this field shipped (legacy = fall back to base). */
  constructionTotalMs?: number;
  /** §queue: true while this placement/upgrade waits in the build queue. A
   *  queued build occupies its footprint and has paid its cost, but does NOT
   *  tick (`tickConstruction`/`nextConstructionCompletionMs` skip it) and is
   *  excluded from the running-slot count. Promoted to running (flag cleared)
   *  at the construction-completion boundary in `advanceIsland`. Optional;
   *  absent ≡ false (forward-compat: pre-v18 saves omit it). */
  queued?: boolean;
  /** §queue: monotonic per-island enqueue order, for deterministic FIFO
   *  promotion (lowest seq promotes first). Sourced from `IslandState.nextQueueSeq`,
   *  never wall-clock. Optional; absent ≡ 0 (placement order). */
  queueSeq?: number;
  /** §4.7 accumulated operating time since last maintenance, in ms. Ticks
   *  every advanceIsland segment regardless of whether the building actually
   *  ran (§4.7: "Idle buildings ... accrue maintenance time the same as
   *  actively-producing ones"). Resets to 0 on a successful maintenance
   *  cycle. Missing on legacy saves = treated as 0 by `maintenanceFactor`. */
  readonly operatingMs?: number;
  /** §4.7 perf-domain timestamp of the most recent successful auto-maintain
   *  cycle. Defaults to `placedAt` on a fresh placement. Missing on legacy
   *  saves = also undefined (the inspector reports "since placement" then). */
  readonly maintainedAt?: number;
  /** §13.3 Eternal Servitor flag. When `true`, the building skips all
   *  maintenance accrual and degradation (and, when wired, fuel-consumption
   *  checks). Flipped by `convertToServitor` (below in this file), invoked
   *  from the inspector "Convert" button at `inspector-ui.ts:1372`. Mutable:
   *  `convertToServitor` flips this once, permanently. */
  eternalServitor?: true;
  /** §14.2 Spaceport tier for launch-success-rate scaling. Optional so legacy
   *  saves and non-upgradable buildings load cleanly (undefined ≡ tier 1). */
  tier?: number;
  /** §4.5 toxicity event expiry timestamp in perf-domain ms. Set when a
   *  chemical_reactor rolls its 5%/hr toxicity event; 50% throughput
   *  multiplier applies while `nowMs < toxicityExpiryMs`. Missing/undefined
   *  ≡ no active toxicity period. Forward-compat: legacy saves load with
   *  the field absent and behave normally. */
  toxicityExpiryMs?: number;
  /** Floor-upgrade level L ≥ 0 (0 = fresh, 1+ = upgrades purchased). Optional;
   *  absent ≡ 0 (forward-compat: pre-v16 saves and un-upgraded buildings omit it).
   *  There is no hard maximum; effect scaling clamps at L = 9 (10 floors) per
   *  §4.9, while cost and display follow the raw value. */
  floorLevel?: number;
  /** True if the building's footprint no longer matches terrain after biome change. */
  invalid?: boolean;
  /** terrain_modifier v5 — player's pick for the target TerrainKind, chosen
   *  at placement-time via terrain-modifier-target-picker.ts (Task 5).
   *  Meaningful ONLY for buildings whose def carries `terrainModifier: true`
   *  (currently terrain_modifier). Persisted for the building's lifetime
   *  — which is the SHOT_DURATION_MS window, since the modifier
   *  self-destroys on shot completion (v5 lock
   *  modifier_self_destroys_after_shot). Optional / undefined for every
   *  other def. */
  readonly terrainTarget?: import('./island.js').TerrainKind;
  /** terrain_modifier v5 — single-shot animation countdown in ms. Set to
   *  SHOT_DURATION_MS at placement; decremented every advanceIsland segment
   *  by the segment duration; on the segment driving it to ≤ 0 the shot
   *  resolves (Task 4): brush tiles get overrides written, the building is
   *  removed from state.buildings, footprint freed. Missing/undefined ≡ "no
   *  shot pending" (the modifier never got a target, never fires —
   *  shouldn't happen in production but the field is optional for forward-
   *  compat with legacy saves). */
  terrainShotRemainingMs?: number;
  /** §NEW temporary floor-disable: how many of the building's BUILT floors are
   *  switched off, counted from the top. 0 / absent = all built floors active
   *  (full effect); equal to displayedFloorLevel = fully disabled (the old
   *  `disabled === true`). Free + instantly reversible; scales throughput /
   *  power / storage capacity / §4.5 cluster contribution by the ACTIVE floor
   *  count (via the forthcoming `activeFloorLevel` helper). */
  disabledFloors?: number;
  /** Force-run (§4.6): keep producing for XP even when an output bin is at
   *  cap. Absent / false = default (throttle to consumer draw at a full bin).
   *  The building still consumes inputs + power and accrues maintenance wear;
   *  the overflow output is voided at the cap. Free + instantly reversible via
   *  the inspector toggle. */
  forceRun?: boolean;
}

/** Returns true iff at least one placed building of `defId` in `buildings`
 *  is operational: not invalid, not still under construction, not
 *  player-disabled. Accepts both `state.buildings` and `spec.buildings`
 *  (the arrays are aliased per `world.ts:1036`'s
 *  `makeInitialIslandState`).
 *
 *  Consolidates the ~25 scattered `buildings.some(b => b.defId === '…')`
 *  provider-scan call sites so adding a new "is this thing actually
 *  available?" filter (e.g. §NEW disabled toggle) is a single-line edit
 *  here instead of a fan-out across the tree. Pure. */
export function isOperationalBuilding(
  b: { invalid?: boolean; constructionRemainingMs?: number; floorLevel?: number; disabledFloors?: number },
): boolean {
  if (b.invalid === true) return false;
  if ((b.constructionRemainingMs ?? 0) > 0) return false;
  if (activeFloors(b) <= 0) return false;          // floor-disable
  return true;
}

export function hasOperationalBuilding(
  buildings: ReadonlyArray<{ defId: string; invalid?: boolean; constructionRemainingMs?: number; floorLevel?: number; disabledFloors?: number }>,
  defId: BuildingDefId,
): boolean {
  for (const b of buildings) {
    if (b.defId !== defId) continue;
    if (!isOperationalBuilding(b)) continue;
    return true;
  }
  return false;
}

/** §4.5 cluster membership: a building participates in (connects, and
 *  contributes floor-capacity to) its same-category cluster unless it is
 *  invalid or player-disabled. Unlike `isOperationalBuilding`, a building still
 *  UNDER CONSTRUCTION DOES participate — per #35 it bridges its cluster and
 *  contributes its previous (completed) floor capacity (the floor being built
 *  is excluded by `clusterFloorCapacity` in `adjacency.ts`). */
export function participatesInCluster(
  b: { invalid?: boolean; floorLevel?: number; disabledFloors?: number },
): boolean {
  return b.invalid !== true && activeFloors(b) > 0;
}

export function findOperationalBuilding(
  buildings: ReadonlyArray<{ defId: string; invalid?: boolean; constructionRemainingMs?: number; floorLevel?: number; disabledFloors?: number }>,
  defId: BuildingDefId,
): PlacedBuilding | undefined {
  for (const b of buildings) {
    if (b.defId !== defId) continue;
    if (!isOperationalBuilding(b)) continue;
    return b as PlacedBuilding;
  }
  return undefined;
}

// Pure floor-level helpers live in `floor-levels.ts` (no pixi import) so the
// authoritative server can read floor counts without the render layer. Re-export
// them here so existing render-layer consumers are unaffected.
export {
  floorLevel,
  rawFloorLevel,
  displayedFloorLevel,
  activeFloors,
  activeFloorLevel,
} from './floor-levels.js';

/** Floor-upgrade multiplier for throughput / power output / storage: ×(1+L). */
export function floorEffectMul(level: number): number { return 1 + level; }

/** A placed building's storage-capacity contribution, scaled by its active floor level: ×(1+L_active). */
export function floorScaledCapacity(b: { floorLevel?: number; disabledFloors?: number }, capacity: number): number {
  return capacity * floorEffectMul(activeFloorLevel(b));
}
/** Floor-upgrade multiplier for consumer power DRAW: ×(1+0.5L) (sub-linear vs output). */
export function floorPowerDrawMul(level: number): number { return 1 + 0.5 * level; }

/** Rated effective power (W) for a placed building's inspector readout: the nameplate scaled
 *  by floor level and the player's skill power multipliers. Mirrors the economy's per-building
 *  power scaling MINUS the time-varying factors (solar/wind/throughput) which a rated readout
 *  doesn't show. `powerProductionMul` / `powerConsumptionMul` are skillMul.powerProduction /
 *  skillMul.powerConsumption (consumption is a reduction multiplier ⇒ divide, matching economy). */
export function ratedBuildingPower(
  producesBase: number,
  consumesBase: number,
  level: number,
  powerProductionMul: number,
  powerConsumptionMul: number,
): { produced: number; consumed: number } {
  return {
    produced: producesBase * floorEffectMul(level) * powerProductionMul,
    consumed: (consumesBase * floorPowerDrawMul(level)) / powerConsumptionMul,
  };
}

export { convertToServitor, type ConvertToServitorResult } from './servitor.js';

/**
 * Visual polish constants. The "weathered industrial schematic" direction
 * means buildings sit on the terrain with weight (drop shadow) and read as
 * dimensional rather than flat (bevel + glyph).
 *
 *   - DESAT_AMOUNT: 0.30 pulls 30% toward grayscale. Keeps each building
 *     identifiable by hue but stops the workshop's saturated orange / dock's
 *     candy-blue from screaming.
 *   - SHADOW_*: 2px down-right offset, dark fill at 0.4 alpha. Sells the
 *     "raised plate" feel without a real lighting pass.
 *   - BEVEL_*: 1px inner-top highlight + 1px inner-bottom shadow give a
 *     subtle stamped-metal look. Alphas tuned to read at zoom 1.0 without
 *     swamping the glyph.
 *   - GLYPH_SCALE: glyph height = TILE_PX × footprint-min × this. 0.5 lands
 *     ~24px on a 2×2 building and ~48px on a 4×4 — readable at default zoom.
 *   - GLYPH_LIGHTEN: 70% blend toward white. Glyph reads as light-on-dark on
 *     every fill, including the cyan / pink / pale-mint pastels in the T5
 *     band. (Bitwise tricks vary wildly across fills; a fixed blend is
 *     consistent.)
 */
const DESAT_AMOUNT = 0.30;
const SHADOW_OFFSET = 2;
const SHADOW_ALPHA = 0.40;

const GLYPH_SCALE = 0.5;
const GLYPH_LIGHTEN = 0.70;
const GLYPH_ALPHA = 0.85;

/**
 * Render PlacedBuildings into a fresh container. Each instance's screen
 * rectangle is computed from its def's footprint shape mask + fill/stroke
 * (so a single rendering function handles every building kind uniformly).
 *
 * Coordinate convention matches `renderIslandTiles`: world (0,0) is the
 * centre of tile (0,0), so a footprint origin shifts by -TILE_PX/2 in each
 * axis. The inset leaves a thin gap so the underlying terrain colour is
 * still visible around the building edge.
 *
 * Visual polish (z-order, back to front per building):
 *   1. Drop shadow — dark rect at +2px offset, alpha 0.4.
 *   2. Main fill — desaturated catalog fill, with stroke.
 *   3. Bevel — 1px inner-top highlight + 1px inner-bottom shadow.
 *   4. Glyph — centred Unicode mark, lightened against the fill.
 *
 * All buildings share one Graphics for shapes (cheap to flush) and one
 * Container child for glyph Texts (Text needs its own object). The caller
 * destroys the Container via `destroy({ children: true })`, which cascades
 * to the Text instances and frees their textures.
 */
export function renderBuildings(buildings: ReadonlyArray<PlacedBuilding>): Container {
  const layer = new Container();
  layer.label = 'buildings';

  const half = TILE_PX / 2;
  const inset = 2;
  const g = new Graphics();
  const glyphLayer = new Container();
  glyphLayer.label = 'building-glyphs';

  for (const b of buildings) {
    const def = BUILDING_DEFS[b.defId];
    const rot = (b.rotation ?? 0) as Rotation;
    const tiles = footprintTiles(def.footprint, b.x, b.y, rot);

    // Bounding box of the rotated footprint for shadow + glyph centre.
    let minTx = Infinity;
    let minTy = Infinity;
    let maxTx = -Infinity;
    let maxTy = -Infinity;
    for (const t of tiles) {
      if (t.x < minTx) minTx = t.x;
      if (t.y < minTy) minTy = t.y;
      if (t.x > maxTx) maxTx = t.x;
      if (t.y > maxTy) maxTy = t.y;
    }
    const bboxPx = minTx * TILE_PX - half + inset;
    const bboxPy = minTy * TILE_PX - half + inset;
    const bboxW = (maxTx - minTx + 1) * TILE_PX - inset * 2;
    const bboxH = (maxTy - minTy + 1) * TILE_PX - inset * 2;

    // 1) Drop shadow — bounding box, offset down-right, dark fill at low alpha.
    g.rect(bboxPx + SHADOW_OFFSET, bboxPy + SHADOW_OFFSET, bboxW, bboxH).fill({
      color: 0x000000,
      alpha: SHADOW_ALPHA,
    });

    // 2) Main fill — one rect per tile. Desaturated to read as weathered/aged.
    // Stroke on each tile so non-rectangular shapes render correctly.
    const fillCol = desaturate(def.fill, DESAT_AMOUNT);
    for (const t of tiles) {
      const tx = t.x * TILE_PX - half + inset;
      const ty = t.y * TILE_PX - half + inset;
      const tw = TILE_PX - inset * 2;
      const th = TILE_PX - inset * 2;
      g.rect(tx, ty, tw, th)
        .fill(fillCol)
        .stroke({ width: 2, color: def.stroke, alignment: 1 });
    }

    // 3) Glyph — centred on the bounding box. Size scales with the smaller
    // bbox dimension so a 4×4 building gets a beefier mark than a 1×1.
    const minSide = Math.min(maxTx - minTx + 1, maxTy - minTy + 1);
    const fontSize = Math.round(minSide * TILE_PX * GLYPH_SCALE);
    const glyphColor = lighten(fillCol, GLYPH_LIGHTEN);
    const t = new Text({
      text: def.glyph,
      style: {
        fontFamily: 'ui-monospace, monospace',
        fontSize,
        // PIXI 8 Text.style.fill accepts a hex number directly.
        fill: glyphColor,
      },
    });
    t.alpha = GLYPH_ALPHA;
    t.anchor.set(0.5);
    t.position.set(bboxPx + bboxW / 2, bboxPy + bboxH / 2);
    glyphLayer.addChild(t);
  }

  layer.addChild(g);
  layer.addChild(glyphLayer);
  return layer;
}
