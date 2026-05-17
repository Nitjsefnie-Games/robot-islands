// §11 Antenna signal-range overlay — faint cyan ring per Antenna in the
// world, sized by `ANTENNA_SIGNAL_RADII[defId]`. Drones outside this radius
// silently drop scanned cells (per drones.ts:617); without an on-map
// indication players couldn't tell which corners of the map had coverage.
//
// Pure PixiJS Graphics. Cheap to rebuild — antennas are a small set even
// in a populated late-game world. Rebuilds on `refresh()`; main.ts calls
// that whenever the world layers rebuild (post-discovery, post-placement)
// so the overlay tracks live Antenna placements.

import { Container, Graphics } from 'pixi.js';

import { computeSignalRanges } from './antenna.js';
import { TILE_PX } from './island.js';
import type { WorldState } from './world.js';

/** Outer ring stroke alpha. Kept low — antenna radii span hundreds of
 *  tiles and would drown the map at full opacity. */
const RING_STROKE_ALPHA = 0.22;
/** Inner fill alpha. Lower still — just enough to read as "this area is
 *  covered" without competing with island colours. */
const RING_FILL_ALPHA = 0.04;
/** Cyan to match the existing telemetry vocabulary (vision halo, status
 *  dots — see ocean.ts `VISION_BLUE`). */
const SIGNAL_COLOR = 0x7dd3e8;

export interface AntennaOverlayHandle {
  readonly layer: Container;
  refresh(): void;
  setVisible(visible: boolean): void;
}

export function mountAntennaOverlay(world: WorldState): AntennaOverlayHandle {
  const layer = new Container();
  layer.label = 'antenna-overlay';
  const gfx = new Graphics();
  layer.addChild(gfx);

  function rebuild(): void {
    gfx.clear();
    const populated = world.islands.filter((s) => s.populated);
    const ranges = computeSignalRanges(populated);
    for (const r of ranges) {
      const px = r.cx * TILE_PX;
      const py = r.cy * TILE_PX;
      const radiusPx = r.radius * TILE_PX;
      gfx
        .circle(px, py, radiusPx)
        .fill({ color: SIGNAL_COLOR, alpha: RING_FILL_ALPHA })
        .stroke({ color: SIGNAL_COLOR, width: 1, alpha: RING_STROKE_ALPHA });
    }
  }

  return {
    layer,
    refresh(): void {
      rebuild();
    },
    setVisible(visible: boolean): void {
      layer.visible = visible;
    },
  };
}
