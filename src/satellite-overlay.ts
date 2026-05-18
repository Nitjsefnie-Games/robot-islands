// §14 satellite map visualization — coloured dots at each satellite's
// current world position so launches are visible from the map view.
//
// Variants are colour-coded:
//   scanner  → cyan      (vision)
//   relay    → green     (network)
//   sweeper  → amber     (debris cleanup)
//
// Each sat also gets a faint coverage ring (scanner) / comm-range ring
// (relay) to make the §14.5 effective area legible at a glance.
//
// Debris fields render as small magenta crosses sized by fragment count so
// Kessler hotspots stand out. Pure PixiJS Graphics — no DOM.

import { Container, Graphics } from 'pixi.js';

import { TILE_PX } from './island.js';
import type { SatelliteVariant } from './orbital.js';
import type { WorldState } from './world.js';

const VARIANT_COLOR: Record<SatelliteVariant, number> = {
  scanner: 0x7dd3e8,
  relay: 0x60d0a0,
  sweeper: 0xe6b800,
};

/** Ring alpha — kept low; the rings span hundreds of world tiles and would
 *  drown the map at full opacity. */
const RING_ALPHA = 0.12;

/** Debris-marker colour + size constants. */
const DEBRIS_COLOR = 0xb04080;
const DEBRIS_CROSS_TILES = 4;

export interface SatelliteOverlayHandle {
  readonly layer: Container;
  refresh(): void;
}

export function mountSatelliteOverlay(world: WorldState): SatelliteOverlayHandle {
  const layer = new Container();
  layer.label = 'satellite-overlay';
  const gfx = new Graphics();
  layer.addChild(gfx);

  const rebuild = (): void => {
    gfx.clear();

    // Debris first (under everything else).
    for (const d of world.debrisFields) {
      const px = d.cellX * 16 * TILE_PX + 8 * TILE_PX;
      const py = d.cellY * 16 * TILE_PX + 8 * TILE_PX;
      const size = Math.max(3, Math.min(12, d.fragments / 2)) * TILE_PX;
      gfx
        .moveTo(px - size, py)
        .lineTo(px + size, py)
        .moveTo(px, py - size)
        .lineTo(px, py + size)
        .stroke({ color: DEBRIS_COLOR, width: 1.5, alpha: 0.7 });
      // Halo so dense fields read at zoom-out.
      gfx.circle(px, py, DEBRIS_CROSS_TILES * TILE_PX).fill({
        color: DEBRIS_COLOR,
        alpha: 0.12,
      });
    }

    // Satellite rings.
    for (const sat of world.satellites) {
      const px = sat.x * TILE_PX;
      const py = sat.y * TILE_PX;
      const color = VARIANT_COLOR[sat.variant];
      if (sat.variant === 'scanner' && sat.coverageRadius > 0) {
        gfx.circle(px, py, sat.coverageRadius * TILE_PX).fill({
          color,
          alpha: RING_ALPHA,
        });
      }
      if (sat.variant === 'relay' && sat.commRange > 0) {
        gfx.circle(px, py, sat.commRange * TILE_PX).stroke({
          color,
          width: 1,
          alpha: 0.35,
        });
      }
    }

    // Satellite dots (on top of rings).
    for (const sat of world.satellites) {
      const px = sat.x * TILE_PX;
      const py = sat.y * TILE_PX;
      const color = VARIANT_COLOR[sat.variant];
      // Outer outline for contrast on dark ocean.
      gfx.circle(px, py, 3 * TILE_PX).fill({ color: 0x000000, alpha: 0.6 });
      gfx.circle(px, py, 2 * TILE_PX).fill({ color });
      // Repair-pending markers — small red ring.
      if (sat.pendingRepairDroneId !== null) {
        gfx.circle(px, py, 4 * TILE_PX).stroke({
          color: 0xff5040,
          width: 1.2,
          alpha: 0.8,
        });
      }
    }
  };

  return {
    layer,
    refresh(): void {
      rebuild();
    },
  };
}
