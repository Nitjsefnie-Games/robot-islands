// §3.4 Land Reclamation Hub — numbered constituent badges.
//
// While the inspector is open on a Land Reclamation Hub, this overlay draws
// "#1…#N" at each constituent ellipse centre so the player can map the
// per-constituent picker rows to lobes on the map. Lives in screen space
// (parented under `app.stage`) so the badges stay a fixed readable size
// regardless of camera zoom.
//
// Render layer only: read-only against spec; no state mutation.

import { Container, Text } from 'pixi.js';

import { worldToScreen, type Camera } from './camera.js';
import { islandConstituents, tileToWorldPx, VISION_BLUE, type IslandSpec } from './world.js';

const BADGE_FONT_SIZE = 13;

export interface LobeBadgeOverlayHandle {
  /** Draw badges for `spec`'s constituents, or hide all badges when null. */
  update(spec: IslandSpec | null, cam: Camera): void;
  /** Tear down the Pixi container and pooled Text objects. */
  destroy(): void;
}

/** Creates a pooled overlay of numbered badges under `parent`. */
export function createLobeBadgeOverlay(parent: Container): LobeBadgeOverlayHandle {
  const layer = new Container();
  layer.label = 'lobe-badge-overlay';
  parent.addChild(layer);

  const pool: Text[] = [];

  return {
    update(spec: IslandSpec | null, cam: Camera): void {
      const cs = spec ? islandConstituents(spec) : [];

      // Grow the pool to fit the current constituent count.
      while (pool.length < cs.length) {
        const t = new Text({
          text: '',
          style: {
            fontFamily: 'ui-monospace, monospace',
            fontSize: BADGE_FONT_SIZE,
            fill: VISION_BLUE,
          },
        });
        t.anchor.set(0.5);
        layer.addChild(t);
        pool.push(t);
      }

      for (let i = 0; i < pool.length; i++) {
        const t = pool[i]!;
        if (i >= cs.length || !spec) {
          t.visible = false;
          continue;
        }
        const c = cs[i]!;
        const worldPx = tileToWorldPx(spec.cx + c.offsetX, spec.cy + c.offsetY);
        const screenPx = worldToScreen(worldPx, cam);
        t.position.set(screenPx.x, screenPx.y);
        t.text = `#${i + 1}`;
        t.visible = true;
      }
    },

    destroy(): void {
      layer.destroy({ children: true });
    },
  };
}
