// §4.7 maintenance status indicator overlay.
//
// `maintenanceFactor` already drives the economy (degrading producers at
// 100%→50% over the 4h ramp window past the tier threshold), but the
// player couldn't see which buildings were degrading short of opening the
// inspector on every one. This overlay paints a small amber/red dot in
// the corner of each degrading building's footprint so degradation reads
// at a glance from the world map.
//
// Per building:
//   factor in [0.95, 1.0)   → no indicator (just-past-threshold; noisy)
//   factor in [0.55, 0.95)  → amber dot (ramp in progress)
//   factor <= 0.55          → solid red dot (plateau / fully degraded)
//
// Pure PixiJS Graphics, no DOM. Rebuilt every WEATHER-style throttle to
// avoid per-frame churn; weather already proved the cadence works for a
// world-scale per-tick scan.

import { Container, Graphics } from 'pixi.js';

import { BUILDING_DEFS } from './building-defs.js';
import type { IslandState } from './economy.js';
import { TILE_PX } from './island.js';
import { maintenanceFactor } from './maintenance.js';
import { footprintTiles, type Rotation } from './shape-mask.js';
import type { WorldState } from './world.js';

const REBUILD_MS = 2000;

const AMBER = 0xe6b800;
const RED = 0xff5040;

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
        const factor = maintenanceFactor(b, def);
        if (factor >= 0.95) continue;
        const color = factor <= 0.55 ? RED : AMBER;
        // Compute the rightmost-topmost tile of the rotated footprint so the
        // badge sits in the building's top-right corner regardless of shape.
        const tiles = footprintTiles(def.footprint, b.x, b.y, (b.rotation ?? 0) as Rotation);
        let maxTx = -Infinity;
        let minTy = Infinity;
        for (const t of tiles) {
          if (t.x > maxTx) maxTx = t.x;
          if (t.y < minTy) minTy = t.y;
        }
        // World pixel of the top-right corner of that tile:
        const worldTx = spec.cx + maxTx;
        const worldTy = spec.cy + minTy;
        const px = worldTx * TILE_PX + TILE_PX / 2;
        const py = worldTy * TILE_PX - TILE_PX / 2;
        // Outline + fill for legibility on any building colour.
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
