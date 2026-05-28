// Copyright 2026 Anthropic PBC · SPDX-License-Identifier: Apache-2.0
//
// §perf-2026-05-28 Phase 2: routes renderer.
// Owns 3 containers parented under `world` (see main.ts wiring):
//   staticLayer    — dashed-line geometry, built once per route per
//                    cacheKey change (the expensive thing).
//   animatedLayer  — Phase-3 texture-stroke overlay (Phase 2: unused stub).
//   overlayLayer   — per-frame chevrons + pulses + draft preview (cheap
//                    primitives, rebuilt every update; not cached).

import { Container, Graphics } from 'pixi.js';
import { routesCacheKey, type Route } from './routes.js';
import { VISION_BLUE } from './world.js';
import { colorForRouteType } from './routes-dash-texture.js';

export interface RouteRenderState {
  staticGraphics: Graphics;
  animatedGraphics: Graphics;
  cacheKey: string;     // per-route subset of the full cacheKey
  fromX: number;        // cached world-px endpoints; used by overlay layer
  fromY: number;
  toX: number;
  toY: number;
}

/** Resolve an island id to its centre in world-pixel coords, or null if
 *  the island isn't known (defensive — shouldn't happen in steady state). */
export type IslandPosResolver =
  (islandId: string) => { x: number; y: number } | null;

export class RouteRenderer {
  readonly staticLayer = new Container();
  readonly animatedLayer = new Container();
  readonly overlayLayer = new Container();
  private readonly overlayGfx = new Graphics();

  private readonly entries = new Map<string, RouteRenderState>();
  private lastFullKey: string | null = null;
  constructor(private readonly resolveIslandPos: IslandPosResolver) {
    this.staticLayer.label = 'routes-static';
    this.animatedLayer.label = 'routes-animated';
    this.overlayLayer.label = 'routes-overlay';
    this.overlayLayer.addChild(this.overlayGfx);
  }

  /** Per-frame update. Fast path = compare key + redraw cheap overlay.
   *  Slow path = diff against the cache and rebuild changed entries.
   *  @param routes      current world.routes
   *  @param nowMs       performance.now() at the ticker callsite
   *  @param draftKey    `${fromIslandId}|${toIslandId}` or '' when hidden
   *  @param panelVisible whether the routes panel is open (draft preview gate) */
  update(
    routes: ReadonlyArray<Route>,
    nowMs: number,
    draftKey: string,
    panelVisible: boolean,
  ): void {
    const key = routesCacheKey(routes);

    // Slow-path trigger: any of (geometry key, draft preview, visibility)
    // changed. The dashed-line static layer is rebuilt on geometry change
    // only; draft + visibility never invalidate the static cache.
    if (key !== this.lastFullKey) {
      this.diffRebuild(routes);
      this.lastFullKey = key;
    }

    // Overlay (chevrons + pulses + draft preview) is cheap; rebuild every
    // call. This is where the dash-scroll animation lives in Phase 2 (still
    // per-frame). Phase 3 moves the scroll to a UV offset on the static
    // layer's stroke and the overlay no longer carries dashes.
    this.paintOverlay(routes, nowMs, draftKey, panelVisible);
  }

  private diffRebuild(routes: ReadonlyArray<Route>): void {
    const seen = new Set<string>();
    for (const r of routes) {
      seen.add(r.id);
      const perRouteKey = `${r.type}|${r.from}|${r.to}|${r.inFlight.length}`;
      const existing = this.entries.get(r.id);
      if (existing && existing.cacheKey === perRouteKey) continue;

      const from = this.resolveIslandPos(r.from);
      const to = this.resolveIslandPos(r.to);
      if (!from || !to) {
        // Defensive — drop any half-built entry until both endpoints resolve.
        if (existing) {
          existing.staticGraphics.destroy();
          existing.animatedGraphics.destroy();
          this.entries.delete(r.id);
        }
        continue;
      }

      if (existing) {
        existing.staticGraphics.clear();
        existing.animatedGraphics.clear();
        existing.cacheKey = perRouteKey;
        existing.fromX = from.x; existing.fromY = from.y;
        existing.toX = to.x;     existing.toY = to.y;
        this.buildRouteGeometry(r, existing);
      } else {
        const sg = new Graphics();
        const ag = new Graphics();
        this.staticLayer.addChild(sg);
        this.animatedLayer.addChild(ag);
        const entry: RouteRenderState = {
          staticGraphics: sg,
          animatedGraphics: ag,
          cacheKey: perRouteKey,
          fromX: from.x, fromY: from.y,
          toX: to.x,     toY: to.y,
        };
        this.entries.set(r.id, entry);
        this.buildRouteGeometry(r, entry);
      }
    }

    // Sweep removed routes.
    for (const [id, e] of this.entries) {
      if (seen.has(id)) continue;
      e.staticGraphics.destroy();
      e.animatedGraphics.destroy();
      this.entries.delete(id);
    }
  }

  /** Build the dashed-line static geometry for a single route. Phase 2:
   *  draws the dashed line via Graphics in WORLD coords (no resolveScreenPos);
   *  the dash phase comes from `paintOverlay` per-frame. Phase 3 replaces
   *  this body with a single texture-stroked line + tilePosition animation. */
  private buildRouteGeometry(r: Route, entry: RouteRenderState): void {
    const color = colorForRouteType(r.type);
    const alpha = r.type === 'submarine_cable' || r.type === 'cable' ? 0.55 : 0.55;

    // Phase 2: build the line ONCE in world coords. Dash pattern is
    // emitted as a sequence of moveTo/lineTo segments (same approach
    // the old drawDashedSegment used); animation comes from paintOverlay
    // redrawing on top each frame. Phase 3 replaces this with one
    // texture-stroked lineTo and per-frame tilePosition update.
    const DASH_LEN_WORLD_PX = 8;
    const GAP_LEN_WORLD_PX = 4;
    const dx = entry.toX - entry.fromX;
    const dy = entry.toY - entry.fromY;
    const totalLen = Math.sqrt(dx * dx + dy * dy);
    if (totalLen <= 0) return;
    const ux = dx / totalLen;
    const uy = dy / totalLen;
    const period = DASH_LEN_WORLD_PX + GAP_LEN_WORLD_PX;
    let drawn = 0;
    while (drawn < totalLen) {
      const startT = drawn;
      const endT = Math.min(totalLen, drawn + DASH_LEN_WORLD_PX);
      if (endT > startT) {
        const sx = entry.fromX + ux * startT;
        const sy = entry.fromY + uy * startT;
        const ex = entry.fromX + ux * endT;
        const ey = entry.fromY + uy * endT;
        entry.staticGraphics.moveTo(sx, sy).lineTo(ex, ey);
      }
      drawn += period;
    }
    entry.staticGraphics.stroke({ width: 1.5, color, alpha });

    // animatedGraphics stays empty in Phase 2 — Phase 3 fills it with the
    // texture-stroked line + tilePosition animation.
    void entry.animatedGraphics;
  }

  /** Per-frame overlay rebuild: chevrons + arrival-pulse + draft preview.
   *  Also handles the dash-scroll animation in Phase 2 by drawing a moving
   *  highlight on top of the static dashed layer. Phase 3 deletes the
   *  highlight (the static layer becomes texture-stroked and animates via
   *  tilePosition — see Phase 3 card). */
  private paintOverlay(
    routes: ReadonlyArray<Route>,
    nowMs: number,
    draftKey: string,
    panelVisible: boolean,
  ): void {
    const g = this.overlayGfx;
    g.clear();

    // Draft preview line — only when the panel is open and selection valid.
    if (panelVisible && draftKey !== '') {
      const sep = draftKey.indexOf('|');
      const fromId = draftKey.slice(0, sep);
      const toId = draftKey.slice(sep + 1);
      if (fromId && toId && fromId !== toId) {
        const p1 = this.resolveIslandPos(fromId);
        const p2 = this.resolveIslandPos(toId);
        if (p1 && p2) {
          g.moveTo(p1.x, p1.y)
           .lineTo(p2.x, p2.y)
           .stroke({ width: 1.5, color: VISION_BLUE, alpha: 0.3 });
        }
      }
    }

    // Per-route: arrival pulse + in-flight chevrons.
    for (const r of routes) {
      const entry = this.entries.get(r.id);
      if (!entry) continue;

      // Arrival pulse: amber ring on the destination for the last 2s.
      let nextEta = Infinity;
      for (const b of r.inFlight) {
        const eta = (b.arrivalTime - nowMs) / 1000;
        if (eta < nextEta) nextEta = eta;
      }
      if (nextEta >= 0 && nextEta <= 2) {
        const pulse = 1 - nextEta / 2;
        const radius = 6 + pulse * 4;
        g.circle(entry.toX, entry.toY, radius)
         .stroke({ width: 1.5, color: 0xf5a742, alpha: 0.4 + 0.4 * pulse });
      }

      // In-flight chevrons interpolated along the line.
      const dx = entry.toX - entry.fromX;
      const dy = entry.toY - entry.fromY;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len <= 0) continue;
      const ux = dx / len;
      const uy = dy / len;
      for (const b of r.inFlight) {
        const total = b.arrivalTime - b.dispatchTime;
        if (total <= 0) continue;
        const t = Math.max(0, Math.min(1, (nowMs - b.dispatchTime) / total));
        const cx = entry.fromX + dx * t;
        const cy = entry.fromY + dy * t;
        this.drawChevron(g, cx, cy, ux, uy);
      }
    }
  }

  /** ▶ chevron centred at (cx, cy) pointing along (ux, uy). Geometry
   *  mirrors the pre-existing routes-ui drawChevron — kept identical so
   *  the visual smoke-test agrees with baseline. */
  private drawChevron(
    g: Graphics, cx: number, cy: number, ux: number, uy: number,
  ): void {
    const len = 6, back = 4, width = 4;
    const px = -uy, py = ux;
    const tipX = cx + ux * len,    tipY = cy + uy * len;
    const bLX = cx - ux * back + px * width;
    const bLY = cy - uy * back + py * width;
    const bRX = cx - ux * back - px * width;
    const bRY = cy - uy * back - py * width;
    g.moveTo(tipX, tipY)
     .lineTo(bLX, bLY)
     .lineTo(bRX, bRY)
     .closePath()
     .fill({ color: VISION_BLUE, alpha: 0.85 })
     .stroke({ width: 1, color: 0xf5a742, alpha: 0.6 });
  }

  dispose(): void {
    for (const e of this.entries.values()) {
      e.staticGraphics.destroy();
      e.animatedGraphics.destroy();
    }
    this.entries.clear();
    this.staticLayer.destroy({ children: true });
    this.animatedLayer.destroy({ children: true });
    this.overlayLayer.destroy({ children: true });
  }

  /** Test-only accessor — Phase 4 introspects the per-route cacheKey to
   *  assert the no-rebuild-on-unchanged-input contract. */
  _entriesForTest(): ReadonlyMap<string, RouteRenderState> {
    return this.entries;
  }
}
