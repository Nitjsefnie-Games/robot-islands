// Building status overlay — combines §4.7 maintenance state and §9.3
// construction progress into one per-building corner-badge layer.
//
// Maintenance (top-right corner dot):
//   factor in [0.95, 1.0)   → no indicator (just-past-threshold; noisy)
//   factor in [0.55, 0.95)  → amber dot (ramp in progress)
//   factor <= 0.55          → solid red dot (plateau / fully degraded)
//
// Construction (top-left corner): while constructionRemainingMs > 0, the
// building draws a translucent cyan tint over its footprint plus a small
// progress arc in the top-left so the player can see at a glance which
// buildings are still building (rather than wondering why a freshly-
// placed Smelter isn't producing yet).
//
// Pure PixiJS Graphics, no DOM. Rebuilt every REBUILD_MS to avoid
// per-frame churn. Maintenance state ticks slowly enough that 2s is
// imperceptible; construction can flip from "1 sec left" to "operational"
// inside the throttle window but that's a sub-tick visual lag only.

import { Container, Graphics, Text } from 'pixi.js';

import { BUILDING_DEFS } from './building-defs.js';
import type { IslandState } from './economy.js';
import { constructionProgress } from './construction.js';
import { activeFloors, displayedFloorLevel, rawFloorLevel } from './buildings.js';
import { TILE_PX } from './island.js';
import { maintenanceFactor } from './maintenance.js';
import { OUTPUT_CAP_EXEMPT } from './output-cap.js';
import type { ResourceId } from './recipes.js';
import { SHOT_DURATION_MS } from './terrain-modifier.js';
import { effectiveSkillMultipliers } from './skilltree.js';
import { footprintTiles, shapeHeight, shapeWidth, type Rotation } from './shape-mask.js';
import { CELL_SIZE_TILES } from './constants.js';
import type { WorldState } from './world.js';

const REBUILD_MS = 2000;

const AMBER = 0xe6b800;
const RED = 0xff5040;
const CONSTRUCTION_CYAN = 0x60c8e0;
const DISABLED_RED = 0xE8624A;

// Floor-level badge (bottom-right corner) — dark background disc + white
// number. Visually distinct from the top-corner badges (cyan arc, amber/red
// dot) and always present including L1.
const LEVEL_BADGE_BG = 0x0a1520;
const LEVEL_BADGE_FG = 0xd8e6f0;
// §4.6 Force Run: a force-running building's level badge turns green so the
// produce-at-cap state is visible on the map without opening the inspector.
const LEVEL_BADGE_BG_FORCERUN = 0x2ecc71;
const LEVEL_BADGE_FG_FORCERUN = 0x062a13;
const LEVEL_BADGE_RADIUS = 6; // px, world-space (zoom-independent via world container)

export interface BuildingAlertsHandle {
  readonly layer: Container;
  refresh(nowMs: number): void;
  invalidate(): void;
}

export function mountBuildingAlertsOverlay(
  world: WorldState,
  islandStates: Map<string, IslandState>,
): BuildingAlertsHandle {
  const layer = new Container();
  layer.label = 'building-alerts';
  const gfx = new Graphics();
  // Badge-text layer sits above the Graphics so numbers paint on top of the
  // disc backgrounds. Cleared each rebuild (removeChildren) to prevent leaks.
  const badgeLayer = new Container();
  badgeLayer.label = 'building-alerts-badges';
  layer.addChild(gfx);
  layer.addChild(badgeLayer);
  let lastRebuildMs = -Infinity;
  let dirty = true;

  const rebuild = (): void => {
    gfx.clear();
    // Destroy (not just detach) all Text objects from the previous rebuild
    // before re-adding them — `removeChildren()` returns the removed array;
    // `destroy(true)` releases each badge's text texture deterministically
    // rather than leaving it to Pixi's texture GC.
    for (const c of badgeLayer.removeChildren()) c.destroy(true);
    for (const [islandId, state] of islandStates) {
      const spec = world.islands.find((i) => i.id === islandId);
      if (!spec) continue;
      const skillMul = effectiveSkillMultipliers(state);
      for (const b of state.buildings) {
        const def = BUILDING_DEFS[b.defId];
        const tiles = footprintTiles(def.footprint, b.x, b.y, (b.rotation ?? 0) as Rotation);
        // Footprint extents — shared by both badge corners + the construction tint.
        let minTx = Infinity;
        let maxTx = -Infinity;
        let minTy = Infinity;
        let maxTy = -Infinity;
        for (const t of tiles) {
          if (t.x < minTx) minTx = t.x;
          if (t.x > maxTx) maxTx = t.x;
          if (t.y < minTy) minTy = t.y;
          if (t.y > maxTy) maxTy = t.y;
        }
        // §4 ocean platforms render FILLING their reserved cell block
        // (renderBuildings draws footprint-in-cells), so the floor-level badge +
        // alert markers + construction tint must use the cell-sized extent — not
        // the 1-tile footprint, which would land them in the cell's corner.
        if (def.oceanPlacement === true) {
          maxTx = minTx + shapeWidth(def.footprint) * CELL_SIZE_TILES - 1;
          maxTy = minTy + shapeHeight(def.footprint) * CELL_SIZE_TILES - 1;
        }

        // §9.3 construction visual: translucent cyan footprint tint + top-left
        // progress arc while constructionRemainingMs > 0. Computed first so the
        // maintenance dot paints on top (a building can't be both under
        // construction AND maintenance-degraded — the maintenance counter
        // doesn't start accruing until construction completes).
        const remaining = b.constructionRemainingMs ?? 0;
        if (remaining > 0) {
          // Footprint rect in world pixels (TILE_PX origin at tile centre, so
          // the bounding rect runs from (minTx - 0.5) to (maxTx + 0.5)).
          const half = TILE_PX / 2;
          const rx = (spec.cx + minTx) * TILE_PX - half;
          const ry = (spec.cy + minTy) * TILE_PX - half;
          const rw = (maxTx - minTx + 1) * TILE_PX;
          const rh = (maxTy - minTy + 1) * TILE_PX;
          gfx.rect(rx, ry, rw, rh).fill({ color: CONSTRUCTION_CYAN, alpha: 0.28 });
          // Progress arc grows 0° → 360° as the job completes. Divides by the
          // job's real duration (placement OR upgrade) via constructionProgress
          // — floorLevel(b) is already the in-progress floor, so an upgrade's
          // longer base×(L+1) timer fills from the start instead of sitting
          // empty until `remaining` drops below the placement base.
          const completed = constructionProgress(remaining, def, rawFloorLevel(b), b.constructionTotalMs);
          const tlPx = (spec.cx + minTx) * TILE_PX - TILE_PX / 2;
          const tlPy = (spec.cy + minTy) * TILE_PX - TILE_PX / 2;
          const radius = 5;
          // Outline disc for contrast on any building colour.
          gfx.circle(tlPx, tlPy, radius + 1).fill({ color: 0x000000, alpha: 0.7 });
          gfx.circle(tlPx, tlPy, radius).fill({ color: 0x103040 });
          // Arc — sweep from -π/2 (top) clockwise by completed × 2π.
          if (completed > 0) {
            const start = -Math.PI / 2;
            const end = start + completed * Math.PI * 2;
            gfx
              .moveTo(tlPx, tlPy)
              .arc(tlPx, tlPy, radius - 1, start, end)
              .lineTo(tlPx, tlPy)
              .fill({ color: CONSTRUCTION_CYAN });
          }
        } else if ((b.terrainShotRemainingMs ?? 0) > 0) {
          // terrain_modifier v5 — same cyan arc, base = SHOT_DURATION_MS.
          const remShot = b.terrainShotRemainingMs ?? 0;
          const base = SHOT_DURATION_MS;
          const completed = Math.max(0, Math.min(1, 1 - remShot / base));
          const half = TILE_PX / 2;
          const rx = (spec.cx + minTx) * TILE_PX - half;
          const ry = (spec.cy + minTy) * TILE_PX - half;
          const rw = (maxTx - minTx + 1) * TILE_PX;
          const rh = (maxTy - minTy + 1) * TILE_PX;
          gfx.rect(rx, ry, rw, rh).fill({ color: CONSTRUCTION_CYAN, alpha: 0.18 });
          const tlPx = (spec.cx + minTx) * TILE_PX - TILE_PX / 2;
          const tlPy = (spec.cy + minTy) * TILE_PX - TILE_PX / 2;
          const radius = 5;
          gfx.circle(tlPx, tlPy, radius + 1).fill({ color: 0x000000, alpha: 0.7 });
          gfx.circle(tlPx, tlPy, radius).fill({ color: 0x103040 });
          if (completed > 0) {
            const start = -Math.PI / 2;
            const end = start + completed * Math.PI * 2;
            gfx
              .moveTo(tlPx, tlPy)
              .arc(tlPx, tlPy, radius - 1, start, end)
              .lineTo(tlPx, tlPy)
              .fill({ color: CONSTRUCTION_CYAN });
          }
        }

        // §NEW disabled cue (p_visual_cue=low_alpha): 0.40-alpha fill + dashed
        // red outline. Painted after the construction tint (a hand-edited save
        // could make a building both disabled AND under construction — show
        // both) and before the maintenance dot (the dot, still reflecting the
        // frozen factor, surfaces on top).
        if (activeFloors(b) < displayedFloorLevel(b)) {
          const half = TILE_PX / 2;
          const rx = (spec.cx + minTx) * TILE_PX - half;
          const ry = (spec.cy + minTy) * TILE_PX - half;
          const rw = (maxTx - minTx + 1) * TILE_PX;
          const rh = (maxTy - minTy + 1) * TILE_PX;
          // Dimming fill — keeps the sprite identifiable but reads as "off".
          gfx.rect(rx, ry, rw, rh).fill({ color: 0x000000, alpha: 0.40 });
          // Dashed red outline. PixiJS Graphics doesn't have a native
          // stroke-dasharray; emit four segments along the perimeter,
          // alternating drawn/skipped, to approximate the 4-3 dash pattern.
          const DASH = 4;
          const GAP = 3;
          const drawDashedSegment = (x0: number, y0: number, x1: number, y1: number): void => {
            const dx = x1 - x0;
            const dy = y1 - y0;
            const len = Math.hypot(dx, dy);
            if (len === 0) return;
            const ux = dx / len;
            const uy = dy / len;
            let t = 0;
            while (t < len) {
              const segEnd = Math.min(t + DASH, len);
              gfx.moveTo(x0 + ux * t, y0 + uy * t).lineTo(x0 + ux * segEnd, y0 + uy * segEnd);
              t = segEnd + GAP;
            }
          };
          drawDashedSegment(rx, ry, rx + rw, ry);            // top
          drawDashedSegment(rx + rw, ry, rx + rw, ry + rh);  // right
          drawDashedSegment(rx + rw, ry + rh, rx, ry + rh);  // bottom
          drawDashedSegment(rx, ry + rh, rx, ry);            // left
          gfx.stroke({ color: DISABLED_RED, width: 1.5 });
        }

        // §4.7 maintenance badge — top-right corner dot. Only buildings
        // PAST construction can degrade (operatingMs doesn't accrue while
        // building) so the maintenance check is a no-op for the under-
        // construction case above; reading factor here is still safe.
        const factor = maintenanceFactor(b, def, skillMul.maintenanceThreshold);
        if (factor < 0.95) {
          const color = factor <= 0.55 ? RED : AMBER;
          const worldTx = spec.cx + maxTx;
          const worldTy = spec.cy + minTy;
          const px = worldTx * TILE_PX + TILE_PX / 2;
          const py = worldTy * TILE_PX - TILE_PX / 2;
          gfx.circle(px, py, 4).fill({ color: 0x000000, alpha: 0.7 });
          gfx.circle(px, py, 3).fill({ color });
        }

        // Floor-level badge — bottom-right corner, always shown (including L1).
        // Display is the raw stored floor level + 1; there is no hard maximum.
        {
          const half = TILE_PX / 2;
          const brPx = (spec.cx + maxTx) * TILE_PX + half;  // right edge x
          const brPy = (spec.cy + maxTy) * TILE_PX + half;  // bottom edge y
          const r = LEVEL_BADGE_RADIUS;
          const inset = r; // badge centre sits one radius from the corner edge
          const cx = brPx - inset;
          const cy = brPy - inset;
          // §4.6 Ignore Cap: green badge when the building forces a NON-default
          // output (a primary/valuable resource it normally wouldn't overflow).
          // Default byproduct exemptions (slag, co, ...) do not light it.
          const forced = Object.entries(b.ignoreCapOverrides ?? {}).some(
            ([r, v]) => v === true && !OUTPUT_CAP_EXEMPT.has(r as ResourceId),
          );
          // Outline disc for contrast on any building colour.
          gfx.circle(cx, cy, r + 1).fill({ color: 0x000000, alpha: 0.65 });
          gfx.circle(cx, cy, r).fill({ color: forced ? LEVEL_BADGE_BG_FORCERUN : LEVEL_BADGE_BG });
          // Number on top — managed in badgeLayer so it's a real glyph.
          const lvText = new Text({
            text: String(displayedFloorLevel(b)),
            style: {
              fontFamily: 'ui-monospace, monospace',
              fontSize: 8,
              fill: forced ? LEVEL_BADGE_FG_FORCERUN : LEVEL_BADGE_FG,
            },
          });
          lvText.anchor.set(0.5);
          lvText.position.set(cx, cy);
          badgeLayer.addChild(lvText);
        }
      }
    }
    dirty = false;
    lastRebuildMs = performance.now();
  };

  return {
    layer,
    refresh(nowMs: number): void {
      if (!dirty && nowMs - lastRebuildMs < REBUILD_MS) return;
      rebuild();
    },
    invalidate(): void {
      dirty = true;
    },
  };
}
