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

import { BUILDING_DEFS, shapeHeight, shapeWidth, type BuildingDefId } from './building-defs.js';
import type { IslandState } from './economy.js';
import { TILE_PX } from './island.js';
import {
  affordabilityShortfall,
  footprintTiles,
  placeBuilding,
  placementCostFor,
  validatePlacement,
  type PlacementReason,
  type Rotation,
} from './placement.js';
import type { ResourceId } from './recipes.js';
import { VISION_BLUE, tileToWorldPx, type IslandSpec } from './world.js';

// Color tokens — match the drone-reticle "ok = cyan / warn = amber" pattern.
const OK_COLOR = VISION_BLUE;
const WARN_COLOR = 0xf5a742;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

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
   *  so the caller can chain a "rebuild world layers" call on success. */
  attemptCommit(): { ok: boolean; reason?: PlacementReason };
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
}

// ---------------------------------------------------------------------------
// Reason → human-readable label
// ---------------------------------------------------------------------------
const REASON_LABEL: Readonly<Record<PlacementReason, string>> = {
  'out-of-bounds': 'OUT OF BOUNDS',
  overlap: 'OVERLAP',
  'def-not-unlocked': 'LOCKED',
  'biome-locked': 'BIOME MISMATCH',
  'tile-requirement-not-met': 'TILE MISMATCH',
  'insufficient-resources': 'INSUFFICIENT RESOURCES',
};

/** Pretty-print a §14 shortfall record as "NEED 5 STONE, 3 WOOD" for the
 *  validation status line / disabled-place-button label. Falls back to the
 *  generic INSUFFICIENT RESOURCES label when the record is empty
 *  (defensive — the validator only emits `insufficient-resources` with a
 *  non-empty missing record). */
function formatMissing(
  missing: Partial<Record<ResourceId, number>>,
): string {
  const parts: string[] = [];
  for (const [r, n] of Object.entries(missing) as Array<[ResourceId, number]>) {
    if (n <= 0) continue;
    parts.push(`${n} ${r.toUpperCase().replace(/_/g, ' ')}`);
  }
  if (parts.length === 0) return REASON_LABEL['insufficient-resources'];
  return `NEED ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Stable id generator — sessions-local
// ---------------------------------------------------------------------------
let placedCounter = 0;
function nextPlacedId(): string {
  placedCounter += 1;
  // `placed-N` namespace is distinct from `home-*` (demo seed),
  // `forestne-*` (demo seed), and `art-N` (artificial-island construction),
  // so an id collision can't happen across the session.
  return `placed-${placedCounter}`;
}

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // World-space outline layer (scales with zoom)
  // -------------------------------------------------------------------------
  const previewLayer = new Container();
  previewLayer.label = 'placement-preview';
  previewLayer.visible = false;
  const outlineGfx = new Graphics();
  previewLayer.addChild(outlineGfx);

  // -------------------------------------------------------------------------
  // Screen-space status label (fixed pixel size)
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Paint helpers
  // -------------------------------------------------------------------------
  function paintOutlineAndLabel(): void {
    if (!active || activeDefId === null || !cursorSeen) {
      previewLayer.visible = false;
      statusLayer.visible = false;
      return;
    }

    const def = BUILDING_DEFS[activeDefId];
    const targetSpec = deps.getTargetSpec();
    const targetState = deps.getTargetState();

    // Cursor → world-tile → island-local. The anchor snaps to the integer
    // tile whose visual centre is nearest the cursor (Math.round), matching
    // the half-tile rendering convention: tile (n) is drawn centred on
    // world pixel (n * TILE_PX), so its visual extent spans [n-0.5, n+0.5).
    const wt = deps.screenToWorldTile(cursorScreenX, cursorScreenY);
    const localX = Math.round(wt.x - targetSpec.cx);
    const localY = Math.round(wt.y - targetSpec.cy);

    const v = validatePlacement(
      targetSpec,
      targetState,
      activeDefId,
      localX,
      localY,
      rotation,
    );
    const color = v.ok ? OK_COLOR : WARN_COLOR;

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
    previewLayer.visible = true;

    // Status label in screen space. Positioned offset from cursor so it
    // doesn't sit underneath it (cursor pointer would obscure the first
    // glyph on most platforms).
    //
    // The label has three pieces:
    //   1. Building name + footprint (always shown).
    //   2. Validation tail (only on failure). On `insufficient-resources`
    //      the tail expands to "NEED 5 STONE, 3 WOOD" via `formatMissing`
    //      so the player learns exactly what's short without consulting
    //      the cost row.
    //   3. Cost row (always shown) — listing every cost entry in
    //      "20 STONE, 10 WOOD" form. The cost row colours its entries
    //      red when short and the OK colour when affordable, summarising
    //      the §14 affordability snapshot at a glance even when the
    //      cursor is over a valid tile.
    const labelMain = `${def.displayName.toUpperCase()} ${shapeWidth(def.footprint)}×${shapeHeight(def.footprint)}`;
    const labelTail = v.ok
      ? ''
      : v.reason === 'insufficient-resources' && v.missing
        ? `  ·  ${formatMissing(v.missing)}`
        : `  ·  ${REASON_LABEL[v.reason ?? 'out-of-bounds']}`;
    // §14 cost row — always rendered, summarising the basket regardless of
    // current cursor state. Computed from inventory vs def cost; per-entry
    // sufficiency is the input for the cost-row colour decision.
    const cost = placementCostFor(def);
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
      labelMain + labelTail + (costStr ? `\nCOST: ${costStr}` : '');
    // Cost-row colour: red when ANY cost entry is short on inventory, OK
    // colour otherwise. The validation tail's own colour (which drives the
    // main `color` var) is independent — geometry failures still paint the
    // outline amber even when the cost is affordable.
    labelText.style.fill = costShort ? WARN_COLOR : color;
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

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  function begin(defId: BuildingDefId): void {
    active = true;
    activeDefId = defId;
    rotation = 0;
    cursorSeen = false;
    paintOutlineAndLabel();
  }
  function cancel(): void {
    if (!active) return;
    active = false;
    activeDefId = null;
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
  function attemptCommit(): { ok: boolean; reason?: PlacementReason } {
    if (!active || activeDefId === null) return { ok: false };
    const targetSpec = deps.getTargetSpec();
    const targetState = deps.getTargetState();
    const wt = deps.screenToWorldTile(cursorScreenX, cursorScreenY);
    const localX = Math.round(wt.x - targetSpec.cx);
    const localY = Math.round(wt.y - targetSpec.cy);
    const v = validatePlacement(
      targetSpec,
      targetState,
      activeDefId,
      localX,
      localY,
      rotation,
    );
    if (!v.ok) return { ok: false, reason: v.reason };
    // §14: `placeBuilding` re-checks the cost gate between validate and
    // commit (defensive: another sibling production tick could have
    // consumed inventory in the gap). On the rare race, fall through to
    // the same `insufficient-resources` reason the validator emits.
    const result = placeBuilding(
      targetSpec,
      targetState,
      activeDefId,
      localX,
      localY,
      rotation,
      nextPlacedId,
    );
    if (!result.ok) return { ok: false, reason: result.reason };
    cancel();
    deps.onPlaced();
    return { ok: true };
  }

  return {
    previewLayer,
    statusLayer,
    isActive: () => active,
    begin,
    cancel,
    rotate,
    setCursorScreenPos,
    hidePreview,
    attemptCommit,
  };
}
