// §11 Antenna signal-range overlay — faint cyan ring per Antenna, sized by
// `ANTENNA_SIGNAL_RADII[defId]`. Drones outside this radius silently drop
// scanned cells (per drones.ts:617); without an on-map indication players
// couldn't tell which corners of the map had coverage.
//
// Pure PixiJS Graphics, cheap to rebuild. Rebuilds on `refresh()`; main.ts
// calls that whenever the world layers rebuild (post-discovery,
// post-placement) so the overlay tracks live Antenna placements.

import { Container, Graphics } from 'pixi.js';

import { computeSignalRanges, isAntennaRedundant } from './antenna.js';
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
/** Rust tint for antennas whose entire sampled perimeter is already covered by
 *  at least one other antenna. Matches the spec §05 chosen value (~90% blend
 *  of cyan toward 0xE08B7F). */
const REDUNDANT_COLOR = 0xd6928a;
/** Alpha for the red frame drawn around a redundant Antenna building itself
 *  (in addition to its range ring) — slightly bolder than the ring so the
 *  culprit building is easy to spot, but still a "slight" hint. */
const REDUNDANT_FRAME_ALPHA = 0.55;

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
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]!;
      const others = ranges.slice(0, i).concat(ranges.slice(i + 1));
      const redundant = isAntennaRedundant(r, others);
      const colour = redundant ? REDUNDANT_COLOR : SIGNAL_COLOR;
      const px = r.cx * TILE_PX;
      const py = r.cy * TILE_PX;
      const radiusPx = r.radius * TILE_PX;
      gfx
        .circle(px, py, radiusPx)
        .fill({ color: colour, alpha: RING_FILL_ALPHA })
        .stroke({ color: colour, width: 1, alpha: RING_STROKE_ALPHA });
      // Slight red frame around the building footprint itself for redundant
      // antennas, so the culprit is identifiable without tracing the ring back
      // to its centre. `cx`/`cy` are the footprint CENTRE, and tile coords address
      // tile centres (tileToWorldPx maps a tile coord to its centre — see
      // routeSourceTile in routes.ts), so `cx*TILE_PX` is the building's visual
      // centre. The footprint's NW corner is therefore half the footprint
      // (width/2 tiles) up-left of the centre, i.e. (cx - width/2)*TILE_PX.
      if (redundant) {
        const x0 = (r.cx - r.width / 2) * TILE_PX;
        const y0 = (r.cy - r.height / 2) * TILE_PX;
        gfx
          .rect(x0, y0, r.width * TILE_PX, r.height * TILE_PX)
          .stroke({ color: REDUNDANT_COLOR, width: 2, alpha: REDUNDANT_FRAME_ALPHA });
      }
    }
  }

  // PERF (§ redraw gating): same root-group-churn problem as the satellite
  // overlay — rebuild() clears+redraws every frame, dirtying the root render
  // group even when the antenna ring set is unchanged (the common case; it only
  // changes when an antenna is placed/removed or an island is populated/merged).
  // The two overlays together measured ~4.4 ms/frame of avoidable render cost in
  // a live interleaved A/B. Gate on a signature of the exact draw inputs (ring
  // geometry + redundancy flag): identical signature ⇒ identical geometry, so
  // the skip is behavior-preserving. The signature recomputes the (cheap) ranges
  // each frame but only re-tessellates the Graphics when they actually change.
  let lastSig: string | null = null;
  const signature = (): string => {
    const populated = world.islands.filter((s) => s.populated);
    const ranges = computeSignalRanges(populated);
    const parts: string[] = [];
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]!;
      const others = ranges.slice(0, i).concat(ranges.slice(i + 1));
      const redundant = isAntennaRedundant(r, others);
      parts.push(`${r.cx},${r.cy},${r.radius},${r.width},${r.height},${redundant ? 1 : 0}`);
    }
    return parts.join('|');
  };

  return {
    layer,
    refresh(): void {
      const sig = signature();
      if (sig === lastSig) return;
      lastSig = sig;
      rebuild();
    },
    setVisible(visible: boolean): void {
      layer.visible = visible;
    },
  };
}
