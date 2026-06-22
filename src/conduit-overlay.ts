// §4.5 conduit-link render overlay — draws a thin line between each pair of
// wired conduits so the player can see the cluster network on the map.
//
// Render-only: reads world.conduitLinks, never mutates state. refresh() is
// signature-gated (mirrors weather-overlay.ts) so the per-frame cost is a
// single string compare when the wiring topology is unchanged.

import { Container, Graphics } from 'pixi.js';

import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { shapeHeight, shapeWidth } from './shape-mask.js';
import { tileToWorldPx, VISION_BLUE, type WorldState } from './world.js';

/** Optional accent for cross-island lattice-conduit links. */
const CROSS_ISLAND_MINT = 0x80f0c0;

export interface ConduitOverlayHandle {
  readonly layer: Container;
  refresh(world: WorldState): void;
  dispose(): void;
}

interface ResolvedEndpoint {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly islandId: string;
}

/** Resolve a conduit building id to its footprint-centre in world pixels,
 *  or null if the building no longer exists. Mirrors routeSourceTile() in
 *  routes.ts: tile coords address centres, and the footprint centre is offset
 *  by (W-1)/2, (H-1)/2 from the anchor tile. */
function resolveConduitCenter(
  world: WorldState,
  buildingId: string,
): ResolvedEndpoint | null {
  for (const spec of world.islands) {
    const b = spec.buildings.find((bb) => bb.id === buildingId);
    if (!b) continue;
    const def = BUILDING_DEFS[b.defId as BuildingDefId];
    const offX = def ? (shapeWidth(def.footprint) - 1) / 2 : 0;
    const offY = def ? (shapeHeight(def.footprint) - 1) / 2 : 0;
    const tileX = spec.cx + b.x + offX;
    const tileY = spec.cy + b.y + offY;
    const px = tileToWorldPx(tileX, tileY);
    return { id: b.id, x: px.x, y: px.y, islandId: spec.id };
  }
  return null;
}

export function mountConduitOverlay(): ConduitOverlayHandle {
  const layer = new Container();
  layer.label = 'conduit-overlay';
  const gfx = new Graphics();
  gfx.label = 'conduit-overlay-gfx';
  layer.addChild(gfx);

  let lastSig = '';

  return {
    layer,
    refresh(world: WorldState): void {
      const entries: string[] = [];
      const resolvedPairs: Array<{ a: ResolvedEndpoint; b: ResolvedEndpoint }> = [];

      for (const link of world.conduitLinks) {
        const a = resolveConduitCenter(world, link.a);
        const b = resolveConduitCenter(world, link.b);
        if (!a || !b) continue;
        // Sort by id so the signature (and draw order) is order-insensitive.
        const [first, second] = a.id < b.id ? [a, b] : [b, a];
        entries.push(
          `${first.id}|${first.x.toFixed(2)},${first.y.toFixed(2)}|${second.id}|${second.x.toFixed(2)},${second.y.toFixed(2)}`,
        );
        resolvedPairs.push({ a: first, b: second });
      }

      entries.sort();
      const sig = entries.join(';');
      if (sig === lastSig) return;
      lastSig = sig;

      gfx.clear();
      for (const { a, b } of resolvedPairs) {
        const crossIsland = a.islandId !== b.islandId;
        gfx
          .moveTo(a.x, a.y)
          .lineTo(b.x, b.y)
          .stroke({
            width: 1.5,
            color: crossIsland ? CROSS_ISLAND_MINT : VISION_BLUE,
            alpha: 0.85,
          });
      }
    },
    dispose(): void {
      lastSig = '';
      layer.destroy({ children: true });
    },
  };
}
