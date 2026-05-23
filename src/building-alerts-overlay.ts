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

import { Container, Graphics } from 'pixi.js';

import { BUILDING_DEFS } from './building-defs.js';
import type { IslandState } from './economy.js';
import { BASE_CONSTRUCTION_MS_BY_TIER } from './construction.js';
import { TILE_PX } from './island.js';
import { maintenanceFactor } from './maintenance.js';
import { footprintTiles, type Rotation } from './shape-mask.js';
import type { WorldState } from './world.js';

const REBUILD_MS = 2000;

const AMBER = 0xe6b800;
const RED = 0xff5040;
const CONSTRUCTION_CYAN = 0x60c8e0;
const DISABLED_RED = 0xE8624A;

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
  layer.addChild(gfx);
  let lastRebuildMs = -Infinity;
  let dirty = true;

  const rebuild = (): void => {
    gfx.clear();
    for (const [islandId, state] of islandStates) {
      const spec = world.islands.find((i) => i.id === islandId);
      if (!spec) continue;
      for (const b of state.buildings) {
        const def = BUILDING_DEFS[b.defId];
        const tiles = footprintTiles(def.footprint, b.x, b.y, (b.rotation ?? 0) as Rotation);
        // Footprint extents (shared by both badge corners + the construction
        // tint).
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

        // §9.3 construction visual. While constructionRemainingMs > 0 draw a
        // translucent cyan tint over the building's footprint plus a small
        // progress arc in the top-left corner so the player sees "this is
        // still building" vs "this is broken / inactive". Computed first so
        // the maintenance dot paints on top of it (a building can't be both
        // under construction AND maintenance-degraded since the maintenance
        // counter doesn't start accruing until construction completes).
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
          // Progress arc in the top-left corner. Base = tier's full
          // construction time; remaining shrinks from full → 0 so the arc
          // grows from 0° → 360° as the build completes.
          const base = BASE_CONSTRUCTION_MS_BY_TIER[def.tier];
          const completed = Math.max(0, Math.min(1, 1 - remaining / base));
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
        }

        // §NEW disabled cue (p_visual_cue=low_alpha). 0.40-alpha fill +
        // dashed red outline over the footprint. Painted after the
        // construction tint (so a disabled-but-under-construction
        // building, which UI flow forbids but a hand-edited save could
        // produce, would show both) and before the maintenance dot (so
        // the dot — which still reflects the frozen factor — surfaces
        // on top).
        if (b.disabled === true) {
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
        const factor = maintenanceFactor(b, def);
        if (factor >= 0.95) continue;
        const color = factor <= 0.55 ? RED : AMBER;
        const worldTx = spec.cx + maxTx;
        const worldTy = spec.cy + minTy;
        const px = worldTx * TILE_PX + TILE_PX / 2;
        const py = worldTy * TILE_PX - TILE_PX / 2;
        gfx.circle(px, py, 4).fill({ color: 0x000000, alpha: 0.7 });
        gfx.circle(px, py, 3).fill({ color });
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
