// Click-to-place UX for §4 placement — sister module to drones-ui.ts.
//
// Two render layers:
//   - `previewLayer`: a WORLD-space PixiJS Container that draws the rotated
//     footprint outline at the cursor's nearest tile. Lives in the world
//     container (NOT screen space) so the outline scales with zoom and stays
//     overlaid on the right tiles regardless of camera position.
//   - `statusLayer`: a SCREEN-space PixiJS Container that draws the small
//     "MINE 2×2" / "INVALID: out of bounds" label near the cursor. Lives on
//     the stage (NOT the world container) so the label stays a fixed
//     pixel size regardless of zoom — same discipline as the drone reticle
//     in drones-ui.ts.
//
// Placement mode is mutually-exclusive with drone-ops launch mode: the
// drones-ui already armed-state-locks the canvas mousedown, so when
// placement enters we exit launch mode (the caller wires that). The
// cancel paths (Escape, right-click, successful placement) all go through
// `cancel()`.
//
// All `e.code` handling stays in input.ts via the InputRegistry — this
// module exposes `cancel()` and `attemptCommit()` which main.ts wires
// behind the `'rotate-placement'` and `'cancel-placement'` action names.
// The right-click cancel routes through the same `cancel()` exit.

import { Container, Graphics, Text } from 'pixi.js';

import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { shapeHeight, shapeWidth } from './shape-mask.js';
import { CELL_SIZE_TILES } from './constants.js';
import type { IslandState } from './economy.js';
import { TILE_PX } from './island.js';
import type { TerrainKind } from './island.js';
import {
  affordabilityShortfall,
  formatShortfall,
  placeBuilding,
  placementCostFor,
  relocateBuilding,
  relocateFee,
  validatePlacement,
  validateOceanPlacement,
  type OceanPlacementReason,
  type PlacementReason,
} from './placement.js';
import type { PlacedBuilding } from './buildings.js';
import { DEFAULT_GRAPH } from './skilltree.js';
import { candidateAnchors, type AnchorCandidate } from './anchor-picker.js';
import { footprintTiles, type Rotation } from './shape-mask.js';
import type { ResourceId } from './recipes.js';
import { VISION_BLUE, tileToWorldPx, type IslandSpec, type WorldState } from './world.js';
import { type MutationGateway } from './mutation-gateway.js';
import { brushTilesAt, SHOT_DURATION_MS } from './terrain-modifier.js';
import { validateGroupRelocate, groupRelocateFee, buildingFootprintTilesWorld } from './mass-actions.js';

/** §4.6 picker dep: opens the cargo-label modal and resolves to the
 *  player's pick, or `null` if cancelled. The default implementation in
 *  `cargo-label-picker.ts` is the production DOM modal; tests inject a
 *  fake that resolves synchronously / synthetically. */
export type PickCargoLabel = () => Promise<ResourceId | null>;

/** terrain_modifier v5 — placement-time target TerrainKind picker. Invoked
 *  by `begin()` when the selected def is a terrainModifier; the returned
 *  promise resolves with the player's chosen TerrainKind or `null` if
 *  cancelled. Optional on `PlacementUiDeps` — when omitted, terrainModifier
 *  placements arm with no target (Task 4 treats undefined terrainTarget as
 *  no-op at shot time). */
export type PickTerrainTarget = () => Promise<TerrainKind | null>;

/** §4 ocean-layer picker dep (Task 10): opens the anchor picker modal with
 *  the supplied candidate list and resolves to the chosen island id, or
 *  `null` if the player cancelled. Production callers wire
 *  `mountAnchorPicker(...).pick`; tests inject a fake that resolves
 *  synthetically. Optional on `PlacementUiDeps` — when omitted, an ocean
 *  placement attempt synthesises a cancellation (no picker → no anchor →
 *  no commit), preserving the "headless test fixture" path. */
export type PickAnchor = (candidates: AnchorCandidate[]) => Promise<string | null>;

// Color tokens — match the drone-reticle "ok = cyan / warn = amber" pattern.
const OK_COLOR = VISION_BLUE;
const WARN_COLOR = 0xf5a742;

export interface PlacementUiHandle {
  /** World-space layer for the footprint outline. Add to the world container
   *  at a Z above islands. */
  readonly previewLayer: Container;
  /** Screen-space layer for the status label. Add to app.stage. */
  readonly statusLayer: Container;
  /** Whether placement mode is currently armed. The canvas mouseup
   *  disambiguation reads this (small-click → attemptCommit). */
  isActive(): boolean;
  /** Begin placement mode for `defId` on the active target island. Hides
   *  the buildings catalog modal via the supplied callback. Idempotent: a
   *  second call replaces the active def. */
  begin(defId: BuildingDefId): void;
  /** Exit placement mode without placing. Idempotent (no-op when inactive). */
  cancel(): void;
  /** Enter relocate mode for an existing building: ghost follows the cursor,
   *  validity ignores the building's own footprint, commit charges the
   *  half-fee via relocateBuilding. */
  beginRelocate(building: PlacedBuilding): void;
  /** Enter group-relocate mode for a rigid cluster of buildings: the anchor
   *  (`members[0]`) follows the cursor and every member translates by the same
   *  (dx,dy). The whole cluster validates all-or-nothing via
   *  validateGroupRelocate; commit relocates every member or none. */
  beginGroupRelocate(members: PlacedBuilding[]): void;
  /** Rotate the in-progress placement clockwise (0 → 1 → 2 → 3 → 0). */
  rotate(): void;
  /** Update the cursor's screen position; recompute the preview's tile snap
   *  and validation, repaint. Called from the canvas mousemove handler. */
  setCursorScreenPos(screenX: number, screenY: number): void;
  /** Hide the preview (called on canvas mouseleave so the outline doesn't
   *  ghost at the last cursor position). Doesn't exit placement mode —
   *  re-entering the canvas reactivates the preview on the next mousemove. */
  hidePreview(): void;
  /** Attempt to commit at the current cursor position. Returns the result
   *  so the caller can chain a "rebuild world layers" call on success.
   *
   *  Two reason channels because §4 ocean placement reasons are intentionally
   *  disjoint from land `PlacementReason` (per the `OceanPlacementReason`
   *  type comment in placement.ts — "callers don't confuse a land-placement
   *  land-mine with an ocean one"). When the ocean validator rejects, the
   *  specific reason surfaces via `oceanReason` instead of collapsing to the
   *  generic `'def-is-ocean'` land-reason placeholder. `reason` is only set
   *  for land-placement failures (or the headless / mis-wired-deps ocean
   *  fallback, which IS the literal `'def-is-ocean'` semantic — an ocean def
   *  reached a context with no ocean routing infrastructure). */
  attemptCommit(): {
    ok: boolean;
    reason?: PlacementReason;
    oceanReason?: OceanPlacementReason;
  };
  /** §15.2 test accessor — the current text of the status label, or '' when
   *  the label has never been painted (placement inactive / pre-cursor).
   *  Exposed so tests can assert the terrain-target annotation without
   *  triggering CanvasTextMetrics (setCursorScreenPos path). */
  getLabelText(): string;
  /** §15.2 test accessor — the computed labelMain fragment (building name +
   *  footprint ± terrain-target suffix) without triggering a paint.  '' when
   *  no placement is active.  Safe to call in headless tests (no canvas
   *  required). */
  getLabelMain(): string;
}

export interface PlacementUiDeps {
  /** Active target island spec. Resolved per-call so a click-to-switch
   *  on the map retargets placement without re-mounting the UI. */
  getTargetSpec(): IslandSpec;
  /** Active target island state. Paired with `getTargetSpec`; both must
   *  resolve to the same island id at any one call site. */
  getTargetState(): IslandState;
  /** Screen → world-tile conversion. Same helper as drones-ui uses. */
  screenToWorldTile(screenX: number, screenY: number): { x: number; y: number };
  /** Called after a successful place so main.ts can rebuild render layers. */
  onPlaced(): void;
  /** Called after a successful relocate commit so the host rebuilds world
   *  layers (mirrors the post-placement onPlaced rebuild). Optional. */
  onRelocated?: () => void;
  /** §4.6 placement-time cargo-label picker. Invoked by `begin()` when the
   *  selected def is generic-storage (`def.storage?.category === 'generic'`);
   *  the returned promise resolves with the player's chosen ResourceId or
   *  `null` if they cancelled the picker (placement aborts in that path).
   *  Optional — when omitted, generic-storage placements fall through with
   *  no explicit label and `placeBuilding` uses its `DEFAULT_CARGO_LABEL`
   *  fallback (test fixtures and the empty-deps path stay unbroken). */
  pickCargoLabel?: PickCargoLabel;
  /** §4 ocean-layer (Task 10) — world reader for the ocean placement path.
   *  Required for any ocean def (`def.oceanPlacement === true`); without it,
   *  the ocean attemptCommit branch can't validate cell terrain / resolve
   *  anchor candidates and rejects with `'def-is-ocean'` as a defensive
   *  fallback. Optional so existing test fixtures that only exercise land
   *  placement keep working without threading a synthetic world. */
  getWorld?(): WorldState;
  /** §4 ocean-layer (Task 10) — id → IslandState resolver for the anchor
   *  placement step. After the player picks an anchor, the commit path
   *  needs the anchor's IslandState to deduct §14 placement cost from its
   *  inventory and push the platform onto its `buildings[]`. Optional for
   *  the same back-compat reason as `getWorld`. */
  getStateById?(islandId: string): IslandState | undefined;
  /** §4 ocean-layer (Task 10) anchor picker. Invoked from `attemptCommit`
   *  after `validateOceanPlacement` succeeds. The returned promise resolves
   *  with the player-picked island id or `null` if cancelled. Optional —
   *  when omitted, the ocean attemptCommit branch synthesises a
   *  cancellation (no commit) so headless test fixtures can place ocean
   *  defs only via direct `placeBuilding` calls. */
  pickAnchor?: PickAnchor;
  /** Mutation gateway — optional so tests can keep wiring only the placement
   *  deps they already have. When present, land + ocean commits route through
   *  the gateway; otherwise the pure functions are called directly. */
  gateway?: MutationGateway;
  /** terrain_modifier v5 — target-biome picker. Invoked by `begin()` when the
   *  selected def carries `terrainModifier: true`; the returned promise
   *  resolves with the player's chosen TerrainKind or `null` if cancelled.
   *  Optional — when omitted, terrainModifier placements arm with
   *  `activeTerrainTarget = undefined` (Task 4 short-circuits the shot). */
  pickTerrainTarget?: PickTerrainTarget;
}

const REASON_LABEL: Readonly<Record<PlacementReason, string>> = {
  'out-of-bounds': 'OUT OF BOUNDS',
  overlap: 'OVERLAP',
  'def-not-unlocked': 'LOCKED',
  'biome-locked': 'BIOME MISMATCH',
  'tile-requirement-not-met': 'TILE MISMATCH',
  'insufficient-resources': 'INSUFFICIENT RESOURCES',
  'queue-full': 'BUILD QUEUE FULL',
  // `def-is-ocean` is a defense-in-depth reject for ocean defs routed
  // through the LAND validator (buildings-ui.ts filters them out of the
  // catalog, so the player path never reaches this label). Programmatic /
  // test callers hit it; the user-facing string is here for symmetry.
  'def-is-ocean': 'OCEAN DEF — USE OCEAN PLACEMENT',
};

/** §4 ocean-layer (Task 10) reason → label. Distinct from `PlacementReason`
 *  per the `OceanPlacementReason` union; surfaced by the status painter
 *  when the player hovers over an invalid ocean cell. */
const OCEAN_REASON_LABEL: Readonly<Record<OceanPlacementReason, string>> = {
  'def-not-ocean': 'DEF NOT OCEAN',
  'terrain-mismatch': 'TERRAIN MISMATCH',
  'no-anchor-in-range': 'NO ANCHOR IN RANGE',
  'land-overlap': 'LAND OVERLAP',
  'ocean-overlap': 'OCEAN OVERLAP',
};

/** Pretty-print a §14 shortfall record as "NEED 5 STONE, 3 WOOD" for the
 *  validation status line / disabled-place-button label. Falls back to the
 *  generic INSUFFICIENT RESOURCES label when the record is empty
 *  (defensive — the validator only emits `insufficient-resources` with a
 *  non-empty missing record). */
function formatMissing(
  missing: Partial<Record<ResourceId, number>>,
): string {
  const body = formatShortfall(missing);
  if (body === '') return REASON_LABEL['insufficient-resources'];
  return `NEED ${body}`;
}

// Stable id derived from island id + anchor coordinates.  Island-qualified
// so buildings on different islands with identical local coords don't share
// an id — collisions caused misfire in the toggle-disable hotkey and
// hover-suppression path (§15.4).  `validatePlacement` still rejects
// overlap within an island, so the id is unique by construction across
// reloads for any given island.
// NOTE: do NOT parse the coordinate tail out of ids — ids are opaque tokens.
// Old saves retain the pre-§15.4 `placed-X,Y` format; new placements get the
// island-qualified `placed-{islandId}-X,Y` format.
function placedIdFor(islandId: string, x: number, y: number): string {
  return `placed-${islandId}-${x},${y}`;
}

/** Order `members` so each can be relocated by `(dx,dy)` without colliding with
 *  a still-unmoved sibling's CURRENT footprint — required because the per-member
 *  `relocateBuilding` re-validates against the live spec (see the call site).
 *  Greedy topological commit: repeatedly emit any member whose destination tiles
 *  don't overlap any remaining member's current tiles. For a rigid translation
 *  such a member always exists (the "blocks" relation advances strictly along
 *  (dx,dy) ⇒ acyclic). Falls back to emitting the remainder in input order if
 *  no movable member is found (cannot happen for a valid rigid translation, but
 *  keeps the function total). */
function collisionSafeOrder(
  spec: IslandSpec,
  members: PlacedBuilding[],
  dx: number,
  dy: number,
): PlacedBuilding[] {
  // Precompute each member's CURRENT world-tile footprint and its DESTINATION
  // world-tile footprint (current shifted by (dx,dy)).
  const curr = new Map<string, Set<string>>();
  const dest = new Map<string, Set<string>>();
  for (const m of members) {
    const tiles = buildingFootprintTilesWorld(spec, m);
    curr.set(m.id, new Set(tiles.map((t) => `${t.x},${t.y}`)));
    dest.set(m.id, new Set(tiles.map((t) => `${t.x + dx},${t.y + dy}`)));
  }
  const out: PlacedBuilding[] = [];
  const remaining = [...members];
  while (remaining.length > 0) {
    const idx = remaining.findIndex((m) => {
      const d = dest.get(m.id)!;
      // Movable iff no OTHER remaining member's current footprint intersects d.
      return !remaining.some((other) => {
        if (other.id === m.id) return false;
        const c = curr.get(other.id)!;
        for (const tile of d) if (c.has(tile)) return true;
        return false;
      });
    });
    if (idx < 0) {
      // No movable member (shouldn't happen for a valid rigid translation) —
      // emit the rest in order so the function stays total.
      out.push(...remaining);
      break;
    }
    out.push(remaining[idx]!);
    remaining.splice(idx, 1);
  }
  return out;
}

export function mountPlacementUi(deps: PlacementUiDeps): PlacementUiHandle {
  let active = false;
  let activeDefId: BuildingDefId | null = null;
  let rotation: Rotation = 0;
  let cursorScreenX = 0;
  let cursorScreenY = 0;
  /** Whether we've received a mousemove since `begin()` — gates the first
   *  preview paint so the outline doesn't appear at the default (0, 0)
   *  before the user has actually moved the cursor over the canvas. */
  let cursorSeen = false;
  /** §4.6: cargo label chosen at picker time for a generic-storage def.
   *  Undefined for non-generic defs (specialized storage routes by category,
   *  non-storage carries no label) or while the picker is still pending
   *  (during the pending window `active` stays false so no commit can fire).
   *  Passed verbatim to `placeBuilding` on commit; the override is silently
   *  ignored by `placeBuilding` for non-generic defs. */
  let activeCargoLabel: ResourceId | undefined = undefined;
  /** terrain_modifier v5 — target TerrainKind picked at picker-time. Undefined
   *  for non-modifier defs and during the pending window before
   *  pickTerrainTarget resolves. Threaded into placeBuilding on commit. */
  let activeTerrainTarget: TerrainKind | undefined = undefined;
  /** Monotonic begin counter — used to detect a stale picker resolution
   *  when the player started a new placement before the previous picker
   *  promise resolved. Bumped on every `begin()`. The picker callback
   *  captures the counter at dispatch; on resolution it compares against
   *  the current counter and bails if they differ. */
  let beginEpoch = 0;
  /** True while a remote placement/relocate commit is awaiting its server ack.
   *  `attemptCommit` early-returns while set so a rapid second click can't
   *  double-dispatch the place intent (charging cost twice / placing at two
   *  tiles). Cleared in BOTH the success and failure async branches. LOCAL
   *  commits resolve synchronously, so this never latches there. */
  let commitPending = false;
  /** Non-null while relocating an existing building (vs. placing a new one).
   *  Carries the building so the ghost can show the move fee and pass its id
   *  to validatePlacement as ignoreBuildingId. */
  let relocating: PlacedBuilding | null = null;
  /** Non-null while group-relocating a rigid cluster of selected buildings.
   *  The anchor is `groupRelocating[0]`: the cursor's target local tile maps
   *  to the anchor's new position, and every other member translates by the
   *  same (dx,dy). Mutually exclusive with `relocating` (single-building) —
   *  the paint/commit paths short-circuit on this before the `relocating`
   *  branch. Each member keeps its OWN def/rotation when drawn/validated;
   *  `activeDefId`/`rotation` are set to the anchor's only so the existing
   *  `active && activeDefId !== null` guards stay satisfied. */
  let groupRelocating: PlacedBuilding[] | null = null;

  // World-space outline layer (scales with zoom).
  const previewLayer = new Container();
  previewLayer.label = 'placement-preview';
  previewLayer.visible = false;
  const outlineGfx = new Graphics();
  previewLayer.addChild(outlineGfx);

  // Screen-space status label (fixed pixel size).
  const statusLayer = new Container();
  statusLayer.label = 'placement-status';
  statusLayer.visible = false;
  const labelBg = new Graphics();
  statusLayer.addChild(labelBg);
  const labelText = new Text({
    text: '',
    style: {
      fontFamily: 'ui-monospace, monospace',
      fontSize: 11,
      fill: 0xcdd6f4,
      letterSpacing: 1.0,
    },
  });
  statusLayer.addChild(labelText);

  /** Shared label builder — used by both the paint path and getLabelMain().
   *  Returns the main label fragment: optional MOVE prefix, building name,
   *  footprint dimensions, and optional terrain-target suffix. */
  function buildLabelMain(def: (typeof BUILDING_DEFS)[BuildingDefId], isRelocating: PlacedBuilding | null, terrainTarget: TerrainKind | undefined): string {
    const targetSuffix = (def.terrainModifier === true && terrainTarget !== undefined)
      ? `  ·  → ${terrainTarget.toUpperCase()}`
      : '';
    return `${isRelocating ? 'MOVE ' : ''}${def.displayName.toUpperCase()} ${shapeWidth(def.footprint)}×${shapeHeight(def.footprint)}${targetSuffix}`;
  }

  function paintOutlineAndLabel(): void {
    if (!active || activeDefId === null) {
      previewLayer.visible = false;
      statusLayer.visible = false;
      labelText.text = '';
      return;
    }

    const def = BUILDING_DEFS[activeDefId];

    // Group relocate (rigid cluster) — short-circuits the single-relocate and
    // ocean branches. Draws one footprint ghost per member at its translated
    // position; the whole cluster tints from validateGroupRelocate(...).ok.
    if (groupRelocating !== null) {
      paintGroupRelocate(groupRelocating);
      return;
    }

    // §4 ocean-layer (Task 10) — ocean defs paint their preview in WORLD
    // tile coords (not island-local) since they don't anchor to any one
    // island's centre. The cursor snaps to the nearest CELL origin, the
    // footprint covers a w×h block of cells (= w*16 × h*16 tiles), and
    // the status label folds in the ocean-validator reason on failure.
    if (def.oceanPlacement === true) {
      if (!cursorSeen) return;
      paintOceanPreview(def, activeDefId);
      return;
    }

    const targetSpec = deps.getTargetSpec();
    const targetState = deps.getTargetState();

    // Cursor → world-tile → island-local. The anchor snaps to the integer
    // tile whose visual centre is nearest the cursor (Math.round), matching
    // the half-tile rendering convention: tile (n) is drawn centred on
    // world pixel (n * TILE_PX), so its visual extent spans [n-0.5, n+0.5).
    const wt = deps.screenToWorldTile(cursorScreenX, cursorScreenY);
    const localX = Math.round(wt.x - targetSpec.cx);
    const localY = Math.round(wt.y - targetSpec.cy);

    const v = relocating
      ? validatePlacement(targetSpec, targetState, activeDefId, localX, localY, rotation, DEFAULT_GRAPH, relocating.id, true)
      : validatePlacement(targetSpec, targetState, activeDefId, localX, localY, rotation);
    const color = v.ok ? OK_COLOR : WARN_COLOR;

    // Status label — computed unconditionally so getLabelText() always returns
    // the current label even before the cursor enters the canvas (cursorSeen).
    //
    // The label has three pieces:
    //   1. Building name + footprint (always shown). For terrain_modifier,
    //      the chosen target terrain is folded into labelMain so it survives
    //      the unconditional labelText.text assignment below (§15.2).
    //   2. Validation tail (only on failure). On `insufficient-resources`
    //      the tail expands to "NEED 5 STONE, 3 WOOD" via `formatMissing`
    //      so the player learns exactly what's short without consulting
    //      the cost row.
    //   3. Cost row (always shown) — listing every cost entry in
    //      "20 STONE, 10 WOOD" form. The cost row colours its entries
    //      red when short and the OK colour when affordable, summarising
    //      the §14 affordability snapshot at a glance even when the
    //      cursor is over a valid tile.
    // §15.2: fold the chosen terrain target into labelMain so the annotation
    // survives the unconditional labelText.text assignment below.
    const labelMain = buildLabelMain(def, relocating, activeTerrainTarget);
    const labelTail = v.ok
      ? ''
      : v.reason === 'insufficient-resources' && v.missing
        ? `  ·  ${formatMissing(v.missing)}`
        : `  ·  ${REASON_LABEL[v.reason ?? 'out-of-bounds']}`;
    // §14 cost row — always rendered, summarising the basket regardless of
    // current cursor state. Computed from inventory vs def cost; per-entry
    // sufficiency is the input for the cost-row colour decision.
    const cost = relocating ? relocateFee(relocating, def) : placementCostFor(def);
    const shortfall = affordabilityShortfall(targetState.inventory, cost);
    const costEntries: Array<[ResourceId, number]> = Object.entries(
      cost,
    ) as Array<[ResourceId, number]>;
    const costStr =
      costEntries.length === 0
        ? ''
        : costEntries
            .map(([r, n]) => `${n} ${r.toUpperCase().replace(/_/g, ' ')}`)
            .join(', ');
    const costShort = Object.keys(shortfall).length > 0;
    labelText.text =
      labelMain + labelTail + (costStr ? `\n${relocating ? 'FEE' : 'COST'}: ${costStr}` : '');
    // Cost-row colour: red when ANY cost entry is short on inventory, OK
    // colour otherwise. The validation tail's own colour (which drives the
    // main `color` var) is independent — geometry failures still paint the
    // outline amber even when the cost is affordable.
    labelText.style.fill = costShort ? WARN_COLOR : color;

    // The outline + label layout below requires a screen position (cursorSeen).
    // Text is already written above so getLabelText() works regardless.
    if (!cursorSeen) return;

    // Footprint outline — one stroked rectangle per tile, plus a translucent
    // fill at 0.2 alpha. Drawn in world-pixel coordinates inside previewLayer
    // which is added at the world container's root (so the camera transform
    // takes it from world-px to screen-px).
    outlineGfx.clear();
    const tiles = footprintTiles(def.footprint, localX, localY, rotation);
    const islandWorldPx = tileToWorldPx(targetSpec.cx, targetSpec.cy);
    const half = TILE_PX / 2;
    for (const t of tiles) {
      // tile (tx, ty) in island-local → world tile (tx + cx, ty + cy) →
      // world px ((tx+cx)*TILE_PX, (ty+cy)*TILE_PX) with the half-tile
      // offset matching renderBuildings/renderIslandTiles conventions
      // (world (0,0) sits at the centre of tile (0,0)).
      const wpx = (t.x * TILE_PX + islandWorldPx.x) - half;
      const wpy = (t.y * TILE_PX + islandWorldPx.y) - half;
      outlineGfx
        .rect(wpx, wpy, TILE_PX, TILE_PX)
        .fill({ color, alpha: 0.2 })
        .stroke({ width: 2, color, alpha: 0.95, alignment: 1 });
    }

    // terrain_modifier v5 brush preview — overdraw the 12-tile ring with
    // a dimmer cyan so the player sees the FULL 16-tile shot scope. Footprint
    // is already painted by the loop above; the ring is the union of the 4×4
    // brush block minus the 2×2 footprint.
    if (def.terrainModifier === true) {
      const brush = brushTilesAt(localX, localY);
      const footKeys = new Set(tiles.map((t) => `${t.x},${t.y}`));
      for (const t of brush) {
        const key = `${t.x},${t.y}`;
        if (footKeys.has(key)) continue; // already drawn by footprint loop
        const tileWx = (t.x * TILE_PX + islandWorldPx.x) - half;
        const tileWy = (t.y * TILE_PX + islandWorldPx.y) - half;
        outlineGfx
          .rect(tileWx, tileWy, TILE_PX, TILE_PX)
          .stroke({ width: 1, color, alpha: 0.6 })
          .fill({ color, alpha: 0.10 });
      }
    }

    previewLayer.visible = true;

    // Lay out the background rectangle behind the text for legibility — same
    // panel-bg colour as the side docks but with no border.
    const padX = 6;
    const padY = 3;
    const tw = labelText.width;
    const th = labelText.height;
    const baseX = cursorScreenX + 16;
    const baseY = cursorScreenY + 16;
    labelBg.clear();
    labelBg
      .rect(baseX - padX, baseY - padY, tw + padX * 2, th + padY * 2)
      .fill({ color: 0x0e121a, alpha: 0.88 })
      .stroke({ width: 1, color, alpha: 0.6, alignment: 1 });
    labelText.position.set(baseX, baseY);
    statusLayer.visible = true;
  }

  /** Group-relocate (rigid cluster) preview painter. The cursor's target
   *  local tile maps to the anchor (`members[0]`); every member ghosts at
   *  `(m.x+dx, m.y+dy)` using ITS OWN def footprint + rotation. The whole
   *  cluster tints green/red from `validateGroupRelocate(...).ok`. Called
   *  from `paintOutlineAndLabel` when `groupRelocating` is set. */
  function paintGroupRelocate(members: PlacedBuilding[]): void {
    const anchor = members[0];
    if (!anchor) return;
    const targetSpec = deps.getTargetSpec();
    const targetState = deps.getTargetState();

    // Cursor → world-tile → island-local (same convention as the single path).
    const wt = deps.screenToWorldTile(cursorScreenX, cursorScreenY);
    const localX = Math.round(wt.x - targetSpec.cx);
    const localY = Math.round(wt.y - targetSpec.cy);
    const dx = localX - anchor.x;
    const dy = localY - anchor.y;

    const v = validateGroupRelocate(targetSpec, targetState, members, dx, dy);
    const color = v.ok ? OK_COLOR : WARN_COLOR;

    // Label — member count + summed fee. Computed unconditionally so
    // getLabelText() stays meaningful even before the cursor enters.
    const fee = groupRelocateFee(members);
    const feeEntries = Object.entries(fee) as Array<[ResourceId, number]>;
    const feeStr = feeEntries
      .map(([r, n]) => `${n} ${r.toUpperCase().replace(/_/g, ' ')}`)
      .join(', ');
    labelText.text =
      `MOVE ${members.length} BUILDINGS` + (feeStr ? `\nFEE: ${feeStr}` : '');
    labelText.style.fill = color;

    if (!cursorSeen) return;

    // One stroked rectangle per member tile (its own def footprint + rotation),
    // in world-px inside previewLayer — same math as the single-relocate ghost.
    outlineGfx.clear();
    const islandWorldPx = tileToWorldPx(targetSpec.cx, targetSpec.cy);
    const half = TILE_PX / 2;
    for (const m of members) {
      const mDef = BUILDING_DEFS[m.defId];
      const mRot = (m.rotation ?? 0) as Rotation;
      const tiles = footprintTiles(mDef.footprint, m.x + dx, m.y + dy, mRot);
      for (const t of tiles) {
        const wpx = (t.x * TILE_PX + islandWorldPx.x) - half;
        const wpy = (t.y * TILE_PX + islandWorldPx.y) - half;
        outlineGfx
          .rect(wpx, wpy, TILE_PX, TILE_PX)
          .fill({ color, alpha: 0.2 })
          .stroke({ width: 2, color, alpha: 0.95, alignment: 1 });
      }
    }
    previewLayer.visible = true;

    // Status label background — same chrome as the single-relocate label.
    const padX = 6;
    const padY = 3;
    const tw = labelText.width;
    const th = labelText.height;
    const baseX = cursorScreenX + 16;
    const baseY = cursorScreenY + 16;
    labelBg.clear();
    labelBg
      .rect(baseX - padX, baseY - padY, tw + padX * 2, th + padY * 2)
      .fill({ color: 0x0e121a, alpha: 0.88 })
      .stroke({ width: 1, color, alpha: 0.6, alignment: 1 });
    labelText.position.set(baseX, baseY);
    statusLayer.visible = true;
  }

  /** §4 ocean-layer (Task 10) preview painter — paints the cell-aligned
   *  footprint in WORLD tile coords (no island-local offset) and folds in
   *  the ocean-validator reason. Called from `paintOutlineAndLabel` when
   *  the active def has `oceanPlacement === true`. */
  function paintOceanPreview(def: typeof BUILDING_DEFS[BuildingDefId], defId: BuildingDefId): void {
    const wt = deps.screenToWorldTile(cursorScreenX, cursorScreenY);
    // Snap cursor to nearest cell origin (floor — same convention as
    // `attemptCommit` so the preview matches the commit target exactly).
    const cellX = Math.floor(wt.x / CELL_SIZE_TILES);
    const cellY = Math.floor(wt.y / CELL_SIZE_TILES);
    const cellW = shapeWidth(def.footprint);
    const cellH = shapeHeight(def.footprint);
    // Footprint world-tile origin — anchor cell origin lifted to world tiles.
    const tileX0 = cellX * CELL_SIZE_TILES;
    const tileY0 = cellY * CELL_SIZE_TILES;
    // Try to validate against the live world so the player gets immediate
    // feedback. Without `getWorld` (headless test fixture) we paint amber
    // and the status carries the routing-issue label.
    const world = deps.getWorld?.();
    const cost = placementCostFor(def);
    let ok = false;
    let reason: OceanPlacementReason | 'no-world' = 'no-world';
    // Non-null ⇒ geometry is fine but no in-range anchor can afford the cost;
    // holds the shortfall of the closest-to-affording anchor (or {}).
    let unaffordableShortfall: Partial<Record<ResourceId, number>> | null = null;
    if (world) {
      const ov = validateOceanPlacement(world, defId, cellX, cellY, world.depthRevealedCells);
      if (!ov.ok) {
        reason = ov.reason ?? 'terrain-mismatch';
      } else {
        // §14 affordability: whichever anchor the player picks pays the cost, so
        // the placement is affordable iff at least one in-range anchor affords
        // it. Otherwise surface the shortfall like the land path does (the
        // commit re-checks per-anchor server-side). Headless (no getStateById)
        // skips the check so tests that only assert geometry still pass.
        const anchors = deps.getStateById ? candidateAnchors(world, cellX, cellY) : [];
        let anyAfford = anchors.length === 0;
        let best: Partial<Record<ResourceId, number>> | null = null;
        for (const a of anchors) {
          const st = deps.getStateById?.(a.islandId);
          if (!st) continue;
          const sf = affordabilityShortfall(st.inventory, cost);
          if (Object.keys(sf).length === 0) {
            anyAfford = true;
            break;
          }
          if (best === null || Object.keys(sf).length < Object.keys(best).length) best = sf;
        }
        if (anyAfford) ok = true;
        else unaffordableShortfall = best ?? {};
      }
    }
    const color = ok ? OK_COLOR : WARN_COLOR;

    // Footprint outline — one stroked rectangle per cell (16×16 tile block)
    // in world-px. The world container's camera transform takes care of
    // world-px → screen-px.
    outlineGfx.clear();
    const half = TILE_PX / 2;
    for (let dy = 0; dy < cellH; dy++) {
      for (let dx = 0; dx < cellW; dx++) {
        const wpx = (tileX0 + dx * CELL_SIZE_TILES) * TILE_PX - half;
        const wpy = (tileY0 + dy * CELL_SIZE_TILES) * TILE_PX - half;
        const w = CELL_SIZE_TILES * TILE_PX;
        const h = CELL_SIZE_TILES * TILE_PX;
        outlineGfx
          .rect(wpx, wpy, w, h)
          .fill({ color, alpha: 0.18 })
          .stroke({ width: 2, color, alpha: 0.95, alignment: 1 });
      }
    }
    previewLayer.visible = true;
    // Status label — building name + cell footprint + ocean reason.
    const labelMain = `${def.displayName.toUpperCase()} ${cellW}×${cellH} CELL`;
    const labelTail = ok
      ? ''
      : unaffordableShortfall !== null
        ? Object.keys(unaffordableShortfall).length > 0
          ? `  ·  NEED ${formatMissing(unaffordableShortfall)}`
          : '  ·  INSUFFICIENT RESOURCES'
        : reason === 'no-world'
          ? '  ·  NO WORLD'
          : `  ·  ${OCEAN_REASON_LABEL[reason]}`;
    // §14 cost row — the basket whichever anchor island the player picks pays on
    // commit. The whole label (incl. cost) goes WARN when `ok` is false, so an
    // unaffordable placement shows the cost in red alongside the NEED tail.
    const costEntries = Object.entries(cost) as Array<[ResourceId, number]>;
    const costStr =
      costEntries.length === 0
        ? ''
        : costEntries.map(([r, n]) => `${n} ${r.toUpperCase().replace(/_/g, ' ')}`).join(', ');
    labelText.text = labelMain + labelTail + (costStr ? `\nCOST: ${costStr}` : '');
    labelText.style.fill = color;
    const padX = 6;
    const padY = 3;
    const tw = labelText.width;
    const th = labelText.height;
    const baseX = cursorScreenX + 16;
    const baseY = cursorScreenY + 16;
    labelBg.clear();
    labelBg
      .rect(baseX - padX, baseY - padY, tw + padX * 2, th + padY * 2)
      .fill({ color: 0x0e121a, alpha: 0.88 })
      .stroke({ width: 1, color, alpha: 0.6, alignment: 1 });
    labelText.position.set(baseX, baseY);
    statusLayer.visible = true;
  }

  function begin(defId: BuildingDefId): void {
    const def = BUILDING_DEFS[defId];
    const isGeneric = def.storage?.category === 'generic';
    const isTerrainModifier = def.terrainModifier === true;
    const epoch = ++beginEpoch;
    // Reset transient state regardless of picker path so a re-arm during
    // a pending picker doesn't carry over the previous cursor state.
    rotation = 0;
    cursorSeen = false;
    activeCargoLabel = undefined;
    activeTerrainTarget = undefined;
    relocating = null;
    // terrain_modifier v5: target-biome picker BEFORE arming the brush.
    // While the picker is open `active` stays false so canvas mousedown /
    // commit handlers no-op. On resolve:
    //   - null → cancelled, do not arm placement.
    //   - TerrainKind → arm placement with that target.
    // The picker dep is optional — when unset we arm with no target.
    if (isTerrainModifier && deps.pickTerrainTarget) {
      active = false;
      activeDefId = null;
      previewLayer.visible = false;
      statusLayer.visible = false;
      deps.pickTerrainTarget().then((picked) => {
        if (epoch !== beginEpoch) return; // stale
        if (picked === null) return; // player cancelled; placement aborts
        active = true;
        activeDefId = defId;
        activeTerrainTarget = picked;
        paintOutlineAndLabel();
      });
      return;
    }
    // §4.6: generic-storage defs ask the picker BEFORE entering placement
    // mode. While the picker is open `active` stays false so canvas
    // mousedown / commit handlers no-op (the picker modal also intercepts
    // input as a DOM modal). On resolve:
    //   - null → cancelled, do not arm placement.
    //   - ResourceId → arm placement with that label.
    // The picker dep is optional — when unset (test fixtures, headless
    // contexts) we arm immediately with no override, and `placeBuilding`
    // applies its `DEFAULT_CARGO_LABEL` fallback.
    if (isGeneric && deps.pickCargoLabel) {
      // Hide any previously-visible layers while the picker is open.
      active = false;
      activeDefId = null;
      previewLayer.visible = false;
      statusLayer.visible = false;
      deps.pickCargoLabel().then((picked) => {
        // Stale resolution guard: a fresh begin() / cancel() bumped the
        // epoch, so this resolution belongs to a superseded session.
        if (epoch !== beginEpoch) return;
        if (picked === null) {
          // Player cancelled the picker — placement aborts entirely. No
          // building was created; no state was mutated. Mirrors the
          // existing cancel() exit so subsequent inputs find a clean slate.
          return;
        }
        active = true;
        activeDefId = defId;
        activeCargoLabel = picked;
        paintOutlineAndLabel();
      });
      return;
    }
    // Non-generic, non-modifier def — arm immediately.
    active = true;
    activeDefId = defId;
    paintOutlineAndLabel();
  }
  function beginRelocate(building: PlacedBuilding): void {
    cancel();                 // clear any in-flight placement (also nulls relocating)
    relocating = building;
    active = true;
    activeDefId = building.defId;
    rotation = (building.rotation ?? 0) as Rotation;
    cursorSeen = false;
    paintOutlineAndLabel();
  }
  function beginGroupRelocate(members: PlacedBuilding[]): void {
    cancel();                 // clear any in-flight placement/relocate
    const anchor = members[0];
    if (!anchor) return;      // empty selection — nothing to move
    groupRelocating = members;
    active = true;
    // Set activeDefId/rotation to the anchor's so the existing
    // `active && activeDefId !== null` guards stay valid; the group itself
    // uses each member's own def/rotation when drawing/validating.
    activeDefId = anchor.defId;
    rotation = (anchor.rotation ?? 0) as Rotation;
    cursorSeen = false;
    paintOutlineAndLabel();
  }
  function cancel(): void {
    // Bump the epoch so any in-flight picker promise becomes stale on
    // resolve — covers the case where the player hits Escape, fires a
    // different action, or starts a new placement while the picker hasn't
    // resolved yet. The early-return is preserved for the common case
    // where placement was already armed (no picker in flight).
    beginEpoch++;
    relocating = null;
    groupRelocating = null;
    if (!active) return;
    active = false;
    activeDefId = null;
    activeCargoLabel = undefined;
    activeTerrainTarget = undefined;
    rotation = 0;
    previewLayer.visible = false;
    statusLayer.visible = false;
  }
  function rotate(): void {
    if (!active) return;
    rotation = ((rotation + 1) % 4) as Rotation;
    paintOutlineAndLabel();
  }
  function setCursorScreenPos(screenX: number, screenY: number): void {
    cursorScreenX = screenX;
    cursorScreenY = screenY;
    cursorSeen = true;
    paintOutlineAndLabel();
  }
  function hidePreview(): void {
    if (!active) return;
    previewLayer.visible = false;
    statusLayer.visible = false;
    // Keep `cursorSeen = true` — re-entering the canvas via mousemove will
    // bring it back. Toggling `active = false` on every mouseleave would be
    // a poor UX (the player loses their armed state mid-aim).
  }
  function attemptCommit(): {
    ok: boolean;
    reason?: PlacementReason;
    oceanReason?: OceanPlacementReason;
  } {
    if (!active || activeDefId === null) return { ok: false };
    // A previous commit is still awaiting its server ack — ignore this click so
    // we don't double-dispatch the place/relocate intent.
    if (commitPending) return { ok: false };
    const def = BUILDING_DEFS[activeDefId];
    function recordRejection(): void {
      const world = deps.getWorld?.();
      if (!world || activeDefId === null) return;
      world.recentBuildAttempts.add(activeDefId);
      world.recentBuildAttemptTs.set(activeDefId, performance.now());
    }
    const wt = deps.screenToWorldTile(cursorScreenX, cursorScreenY);
    // Group relocate (rigid cluster) — short-circuits the ocean and single
    // branches. Recompute (dx,dy) from the anchor, re-validate, then commit
    // every member all-or-nothing (validateGroupRelocate is the contract).
    if (groupRelocating !== null) {
      const members = groupRelocating;
      const anchor = members[0];
      if (!anchor) return { ok: false };
      const targetSpec = deps.getTargetSpec();
      const targetState = deps.getTargetState();
      const localX = Math.round(wt.x - targetSpec.cx);
      const localY = Math.round(wt.y - targetSpec.cy);
      const dx = localX - anchor.x;
      const dy = localY - anchor.y;
      const v = validateGroupRelocate(targetSpec, targetState, members, dx, dy);
      if (!v.ok) {
        recordRejection();
        return { ok: false }; // invalid drop — stay armed, no mutation
      }
      // Commit order matters: `relocateBuilding` re-validates each member
      // against the LIVE spec, where not-yet-moved siblings still sit at their
      // OLD tiles. Moving a member into a tile a not-yet-moved sibling still
      // occupies would falsely reject as `overlap` (validateGroupRelocate
      // sidesteps this with a clone; the real sequential commit can't). So we
      // commit in a collision-safe order: a member is movable once no STILL-
      // UNMOVED sibling's current footprint overlaps its destination footprint.
      // Such an order always exists for a rigid translation (the "blocks"
      // relation strictly advances along (dx,dy) ⇒ acyclic; the zero-vector
      // no-op blocks nothing). Computed up-front from original geometry, which
      // is sound because validateGroupRelocate already proved the final layout
      // is overlap-free.
      const ordered = collisionSafeOrder(targetSpec, members, dx, dy);

      // Commit each member in safe order. validateGroupRelocate already
      // guaranteed every member fits, so partial failure shouldn't occur; if a
      // gateway call still rejects, log and continue (best-effort) — validation
      // is the contract. Mirror the single-relocate gateway-vs-pure choice and
      // the sync|Promise handling.
      const promises: Promise<unknown>[] = [];
      for (const m of ordered) {
        const mRot = (m.rotation ?? 0) as Rotation;
        const nx = m.x + dx;
        const ny = m.y + dy;
        const gatewayResult = deps.gateway
          ? deps.gateway.relocateBuilding(targetSpec.id, m.id, nx, ny, mRot)
          : undefined;
        if (gatewayResult instanceof Promise) {
          promises.push(
            gatewayResult.then((r) => {
              if (!r.ok) {
                console.warn(`group relocate: member ${m.id} rejected (${r.reason ?? 'unknown'})`);
              }
            }),
          );
        } else {
          const r = gatewayResult ?? relocateBuilding(targetSpec, targetState, m.id, nx, ny, mRot);
          if (!r.ok) {
            console.warn(`group relocate: member ${m.id} rejected (${r.reason ?? 'unknown'})`);
          }
        }
      }
      if (promises.length > 0) {
        commitPending = true;
        void (async () => {
          await Promise.all(promises);
          commitPending = false;
          cancel();
          deps.onRelocated?.();
        })();
        return { ok: false }; // pending; success arrives via the async callback
      }
      cancel();
      deps.onRelocated?.();
      return { ok: true };
    }
    // §4 ocean-layer (Task 10): ocean defs route through their own
    // placement flow (validateOceanPlacement + anchor picker). The land
    // validator early-rejects them as `def-is-ocean` (defense-in-depth);
    // routing them HERE is the matching positive path.
    if (def.oceanPlacement === true) {
      // Map world-tile cursor to cell coords. The cursor is fractional;
      // a building anchored at cell C covers cells [C..C+w-1] × [C..C+h-1]
      // so we floor — the cursor's NEAREST cell origin is the anchor.
      const cellX = Math.floor(wt.x / CELL_SIZE_TILES);
      const cellY = Math.floor(wt.y / CELL_SIZE_TILES);
      const world = deps.getWorld?.();
      if (!world || !deps.pickAnchor || !deps.getStateById) {
        // Headless / mis-wired deps: surface a generic "ocean def can't be
        // routed" signal. The land-side `def-is-ocean` label is the
        // closest existing reason and IS semantically right HERE — the
        // def is ocean and the routing infrastructure is absent. (Distinct
        // from a validator rejection, which surfaces via `oceanReason`.)
        return { ok: false, reason: 'def-is-ocean' };
      }
      // §4 ocean RELOCATE: move the existing platform to the new cell via the
      // ocean-aware relocateBuilding (keeps the anchor, charges the half-fee).
      // No anchor picker — unlike a fresh placement.
      if (relocating) {
        // The platform lives on its anchor island's buildings[]; relocate it
        // there (keep the anchor, move the cell).
        const anchorId = relocating.anchorIslandId;
        const anchorSpec = anchorId ? world.islands.find((i) => i.id === anchorId) : undefined;
        const anchorState = anchorId ? deps.getStateById(anchorId) : undefined;
        if (!anchorId || !anchorSpec || !anchorState) {
          recordRejection();
          return { ok: false, reason: 'def-is-ocean' };
        }
        const relId = relocating.id;
        const localX = cellX * CELL_SIZE_TILES - anchorSpec.cx;
        const localY = cellY * CELL_SIZE_TILES - anchorSpec.cy;
        if (deps.gateway) {
          commitPending = true;
          void Promise.resolve(
            deps.gateway.relocateBuilding(anchorId, relId, localX, localY, 0),
          ).then((r) => {
            commitPending = false;
            if (r.ok) {
              deps.onPlaced?.();
              cancel();
            } else {
              recordRejection();
            }
          });
          return { ok: true };
        }
        const r = relocateBuilding(anchorSpec, anchorState, relId, localX, localY, 0, world);
        if (r.ok) {
          deps.onPlaced?.();
          cancel();
          return { ok: true };
        }
        recordRejection();
        return { ok: false, reason: r.reason as PlacementReason };
      }
      const ov = validateOceanPlacement(world, activeDefId, cellX, cellY, world.depthRevealedCells);
      if (!ov.ok) {
        recordRejection();
        // Surface the specific ocean-validator reason via `oceanReason`
        // (parallel field, not collapsed into the land `PlacementReason`
        // union — see the union's "disjoint" type comment in placement.ts).
        // Callers (HUD / status painter) can then differentiate
        // terrain-mismatch / no-anchor-in-range / land-overlap.
        return {
          ok: false,
          oceanReason: ov.reason ?? 'terrain-mismatch',
        };
      }
      const cands = candidateAnchors(world, cellX, cellY);
      // Validator guarantees cands.length > 0 (else `no-anchor-in-range`),
      // but defense-in-depth: bail if it's empty here too.
      if (cands.length === 0) {
        recordRejection();
        return { ok: false, oceanReason: 'no-anchor-in-range' };
      }
      // §14 affordability parity with the land path: the anchor the player
      // picks pays, so block BEFORE opening the picker if NO in-range anchor can
      // afford the cost (the preview surfaces the same). If at least one can,
      // the picker opens and the server re-checks the chosen anchor's inventory.
      const oceanCost = placementCostFor(def);
      const anyAfford = cands.some((c) => {
        const st = deps.getStateById?.(c.islandId);
        return st !== undefined && Object.keys(affordabilityShortfall(st.inventory, oceanCost)).length === 0;
      });
      if (!anyAfford) {
        recordRejection();
        return { ok: false, reason: 'insufficient-resources' };
      }
      // Kick off the anchor picker. The commit completes asynchronously
      // when the picker resolves — mirrors the cargo-label `pickCargoLabel`
      // → `begin()` async pattern. attemptCommit returns {ok:false} here
      // (synchronous contract); the picker-resolution callback drives the
      // actual mutation and calls `deps.onPlaced()`.
      const defId = activeDefId; // capture for the async closure
      const cellAnchorCoordX = cellX * CELL_SIZE_TILES;
      const cellAnchorCoordY = cellY * CELL_SIZE_TILES;
      // Bump the epoch so a stale picker resolution gets dropped — same
      // pre-increment pattern `begin()` uses. Without the bump, a player
      // double-clicking commit while the first picker is open would have
      // BOTH `.then` callbacks share the same captured epoch, and neither
      // stale-check would fire. The cargo-label `begin()` path already
      // uses `++beginEpoch`; this mirrors it.
      const epoch = ++beginEpoch;
      // In-flight guard: block a second commit while the picker is open and the
      // gateway round-trip is pending. Cleared on every resolution branch below.
      commitPending = true;
      deps.pickAnchor(cands).then(async (picked) => {
        if (epoch !== beginEpoch) {
          commitPending = false;
          return; // stale
        }
        if (picked === null) {
          // Cancel — abort placement entirely (mirrors cargo-label cancel).
          commitPending = false;
          cancel();
          return;
        }
        const anchorState = deps.getStateById?.(picked);
        const anchorSpec = world.islands.find((i) => i.id === picked);
        if (!anchorState || !anchorSpec) {
          // Anchor disappeared between picker open and resolve — defensive.
          commitPending = false;
          cancel();
          return;
        }
        // Convert world-tile cell-anchor coords to anchor-local tile coords
        // (matching the per-building convention: b.x, b.y are island-local).
        const localX = cellAnchorCoordX - anchorSpec.cx;
        const localY = cellAnchorCoordY - anchorSpec.cy;
        const result = deps.gateway
          ? await deps.gateway.placeBuilding(anchorSpec.id, defId, localX, localY, 0, {
              anchorIslandId: picked,
            })
          : placeBuilding(
              anchorSpec,
              anchorState,
              defId,
              localX,
              localY,
              0, // ocean defs ignore rotation (square footprints in initial scope)
              () => placedIdFor(anchorSpec.id, localX, localY),
              undefined, // nowMs — keep the default (state.lastTick)
              undefined, // cargoLabelOverride — ocean defs aren't generic-storage
              picked, // anchorIslandId
            );
        commitPending = false;
        if (result.ok) {
          cancel();
          deps.onPlaced();
        } else {
          // Insufficient resources / queue-full on the anchor — surface
          // through the cancel path; the player can re-arm with different
          // inventory.
          recordRejection();
          cancel();
        }
      });
      return { ok: false }; // pending; success arrives via the async callback
    }
    // Land path (existing).
    const targetSpec = deps.getTargetSpec();
    const targetState = deps.getTargetState();
    const localX = Math.round(wt.x - targetSpec.cx);
    const localY = Math.round(wt.y - targetSpec.cy);
    if (relocating) {
      const gatewayResult = deps.gateway
        ? deps.gateway.relocateBuilding(targetSpec.id, relocating.id, localX, localY, rotation)
        : undefined;
      if (gatewayResult instanceof Promise) {
        commitPending = true;
        void (async () => {
          const result = await gatewayResult;
          commitPending = false;
          if (!result.ok) {
            recordRejection();
            return;
          }
          deps.onRelocated?.();
          cancel();
        })();
        return { ok: false };
      }
      const result = gatewayResult ?? relocateBuilding(targetSpec, targetState, relocating.id, localX, localY, rotation);
      if (!result.ok) {
        recordRejection();
        return { ok: false, reason: result.reason === 'not-found' ? undefined : (result.reason as PlacementReason) };
      }
      deps.onRelocated?.();
      cancel();
      return { ok: true };
    }
    const v = validatePlacement(
      targetSpec,
      targetState,
      activeDefId,
      localX,
      localY,
      rotation,
    );
    if (!v.ok) {
      recordRejection();
      return { ok: false, reason: v.reason };
    }
    // §14: `placeBuilding` re-checks the cost gate between validate and
    // commit (defensive: another sibling production tick could have
    // consumed inventory in the gap). On the rare race, fall through to
    // the same `insufficient-resources` reason the validator emits.
    const gatewayResult = deps.gateway
      ? deps.gateway.placeBuilding(targetSpec.id, activeDefId, localX, localY, rotation, {
          cargoLabel: activeCargoLabel,
          terrainTarget: def.terrainModifier === true ? activeTerrainTarget : undefined,
          terrainShotMs: def.terrainModifier === true ? SHOT_DURATION_MS : undefined,
        })
      : undefined;
    if (gatewayResult instanceof Promise) {
      commitPending = true;
      void (async () => {
        const result = await gatewayResult;
        commitPending = false;
        if (!result.ok) {
          recordRejection();
          return;
        }
        cancel();
        deps.onPlaced();
      })();
      return { ok: false };
    }
    const result = gatewayResult ?? placeBuilding(
      targetSpec,
      targetState,
      activeDefId,
      localX,
      localY,
      rotation,
      () => placedIdFor(targetSpec.id, localX, localY),
      undefined, // nowMs — keep the default (state.lastTick)
      activeCargoLabel, // §4.6 picker pick — undefined for non-generic defs
      undefined, // anchorIslandId — land path, never set
      def.terrainModifier === true ? activeTerrainTarget : undefined,
      def.terrainModifier === true ? SHOT_DURATION_MS : undefined,
    );
    if (!result.ok) {
      recordRejection();
      return { ok: false, reason: result.reason as PlacementReason };
    }
    cancel();
    deps.onPlaced();
    return { ok: true };
  }

  function getLabelMain(): string {
    if (!active || activeDefId === null) return '';
    return buildLabelMain(BUILDING_DEFS[activeDefId], relocating, activeTerrainTarget);
  }

  return {
    previewLayer,
    statusLayer,
    isActive: () => active,
    begin,
    beginRelocate,
    beginGroupRelocate,
    cancel,
    rotate,
    setCursorScreenPos,
    hidePreview,
    attemptCommit,
    getLabelText: () => labelText.text,
    getLabelMain,
  };
}
