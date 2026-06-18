// Copyright 2026 Anthropic PBC · SPDX-License-Identifier: Apache-2.0
//
// §perf-2026-05-28 Phase 3: routes renderer with texture-stroke dash animation.
// Owns 3 containers parented under `world` (see main.ts wiring):
//   staticLayer    — dashed-line geometry, built once per route per
//                    cacheKey change (fallback if texture-stroke breaks).
//   animatedLayer  — texture-stroked dashed line; per-frame UV offset via
//                    clear+restroke with a shifted matrix (see API note below).
//   overlayLayer   — per-frame chevrons + pulses + draft preview (cheap
//                    primitives, rebuilt every update; not cached).

import { Container, Graphics, Matrix } from 'pixi.js';
import type { Route } from './routes.js';
import { VISION_BLUE } from './world.js';
import { TILE_PX } from './island.js';
import { colorForRouteType, getDashedStrokeTexture } from './routes-dash-texture.js';

export interface RouteRenderState {
  staticGraphics: Graphics;
  animatedGraphics: Graphics;
  cacheKey: string;
  routeType: Route['type'];
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** Resolved polyline in world pixels: [from, ...waypoints*TILE_PX, to]. */
  points: Array<{ x: number; y: number }>;
}

/** Resolve an island id to its centre in world-pixel coords, or null if
 *  the island isn't known (defensive — shouldn't happen in steady state). */
export type IslandPosResolver =
  (islandId: string) => { x: number; y: number } | null;

/** Pixels of UV scroll per millisecond. Matches the pre-impl visual
 *  feel (~12 px / 600 ms = 0.02 px/ms in routes-ui.ts:1037). The dash
 *  pattern repeats every 12 px, so a full cycle takes 600 ms. */
const SCROLL_SPEED_PX_PER_MS = 12 / 600;

export class RouteRenderer {
  readonly staticLayer = new Container();
  readonly animatedLayer = new Container();
  readonly overlayLayer = new Container();
  private readonly overlayGfx = new Graphics();

  private readonly entries = new Map<string, RouteRenderState>();
  private _disposed = false;
  private readonly _scrollMatrix = new Matrix();

  constructor(
    private readonly resolveIslandPos: IslandPosResolver,
    /** Optional: resolve a route's SOURCE-BUILDING world-px position (the point
     *  it is drawn FROM). Returns null for legacy routes with no resolvable
     *  source building, in which case the `from` endpoint falls back to the
     *  island centre. Keeps the drawn start consistent with the §2.6 weather
     *  path, which also anchors at the source building. */
    private readonly resolveRouteSourcePos?: (route: Route) => { x: number; y: number } | null,
  ) {
    this.staticLayer.label = 'routes-static';
    this.animatedLayer.label = 'routes-animated';
    this.overlayLayer.label = 'routes-overlay';
    this.overlayLayer.addChild(this.overlayGfx);
  }

  /** Per-frame update. diffRebuild runs every frame; its per-route cacheKey
   *  (type, endpoints, endpoint world coords, inFlight count) short-circuits
   *  unchanged entries, so geometry only rebuilds when something visible moved.
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
    // Fix 7.4: diffRebuild runs unconditionally so island-centre moves
    // (merge §3.6 / land reclamation) are picked up the same frame — a
    // route-list-level key can't see them because Route carries island ids,
    // not coordinates.  Steady-state per-frame cost is two resolveIslandPos
    // calls (each allocates a small point object via tileToWorldPx) plus one
    // template-string build + compare per route; route counts are small.
    this.diffRebuild(routes);
    this.updateAnimationOnly(nowMs);
    this.paintOverlay(routes, nowMs, draftKey, panelVisible);
  }

  private diffRebuild(routes: ReadonlyArray<Route>): void {
    const seen = new Set<string>();
    for (const r of routes) {
      seen.add(r.id);
      // Fix 7.4: include endpoint world coords in the per-route key so that an
      // island-centre move (merge §3.6 / land reclamation) invalidates the cache
      // and the drawn route is rebuilt to the new position.
      const from = this.resolveRouteSourcePos?.(r) ?? this.resolveIslandPos(r.from);
      const to = this.resolveIslandPos(r.to);
      const wpKey = r.waypoints?.map((w) => `${w.x},${w.y}`).join(';') ?? '';
      const perRouteKey = `${r.type}|${r.from}|${r.to}|${r.inFlight.length}|${from?.x}|${from?.y}|${to?.x}|${to?.y}|${wpKey}`;
      const existing = this.entries.get(r.id);
      if (existing && existing.cacheKey === perRouteKey) continue;
      if (!from || !to) {
        // Defensive — drop any half-built entry until both endpoints resolve.
        if (existing) {
          existing.staticGraphics.destroy();
          existing.animatedGraphics.destroy();
          this.entries.delete(r.id);
        }
        continue;
      }

      const points: Array<{ x: number; y: number }> = [{ x: from.x, y: from.y }];
      if (r.waypoints) {
        for (const w of r.waypoints) {
          points.push({ x: w.x * TILE_PX, y: w.y * TILE_PX });
        }
      }
      points.push({ x: to.x, y: to.y });

      if (existing) {
        existing.staticGraphics.clear();
        existing.animatedGraphics.clear();
        existing.cacheKey = perRouteKey;
        existing.routeType = r.type;
        existing.fromX = from.x; existing.fromY = from.y;
        existing.toX = to.x;     existing.toY = to.y;
        existing.points = points;
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
          routeType: r.type,
          fromX: from.x, fromY: from.y,
          toX: to.x,     toY: to.y,
          points,
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

  /** Build the dashed-line geometry for a single route.
   *  Phase 3: the animated layer uses a texture-stroked line; the static
   *  layer carries a per-segment dashed-line fallback that's only executed
   *  if `BUILD_STATIC_FALLBACK` is flipped on — see the const below. */
  private buildRouteGeometry(r: Route, entry: RouteRenderState): void {
    const color = colorForRouteType(r.type);
    const alpha = 0.55;

    // Phase-2-style per-segment dashed fallback. Gated OFF by default:
    // every cacheKey-change otherwise wastes O(totalLen / period) Graphics
    // ops building geometry that's never painted (the static layer is
    // hidden below). Flip `BUILD_STATIC_FALLBACK` to `true` and remove the
    // `entry.staticGraphics.visible = false` line if the Phase-3 texture-
    // stroke pipeline breaks in a future Pixi upgrade.
    const BUILD_STATIC_FALLBACK = false;
    if (BUILD_STATIC_FALLBACK) {
      const DASH_LEN_WORLD_PX = 8;
      const GAP_LEN_WORLD_PX = 4;
      const period = DASH_LEN_WORLD_PX + GAP_LEN_WORLD_PX;
      const pts = entry.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i]!;
        const p2 = pts[i + 1]!;
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const segLen = Math.hypot(dx, dy);
        if (segLen <= 0) continue;
        const ux = dx / segLen;
        const uy = dy / segLen;
        let drawn = 0;
        while (drawn < segLen) {
          const startT = drawn;
          const endT = Math.min(segLen, drawn + DASH_LEN_WORLD_PX);
          if (endT > startT) {
            const sx = p1.x + ux * startT;
            const sy = p1.y + uy * startT;
            const ex = p1.x + ux * endT;
            const ey = p1.y + uy * endT;
            entry.staticGraphics.moveTo(sx, sy).lineTo(ex, ey);
          }
          drawn += period;
        }
      }
      entry.staticGraphics.stroke({ width: 1.5, color, alpha });
    }

    // Phase 3: texture-stroked animated line, segment-by-segment so each
    // straight span gets its own dash-scroll rotation.
    const tex = getDashedStrokeTexture(r.type);
    const pts = entry.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i]!;
      const p2 = pts[i + 1]!;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const angle = Math.atan2(dy, dx);
      this._scrollMatrix.set(1, 0, 0, 1, 0, 0).rotate(angle);
      entry.animatedGraphics
        .moveTo(p1.x, p1.y)
        .lineTo(p2.x, p2.y)
        .stroke({ texture: tex, matrix: this._scrollMatrix, width: 2.0, alpha: 0.85 });
    }

    // Static layer is the dashed fallback — kept hidden; see
    // `BUILD_STATIC_FALLBACK` above for flip-on instructions.
    entry.staticGraphics.visible = false;
  }

  /** Per-frame dash-scroll animation.
   *
   *  API-verification note (Pixi 8.x, installed 2026-05-28):
   *  Pixi 8 bakes stroke-texture UVs into vertex geometry in
   *  `buildContextBatches` (`buildUvs` via `generateTextureMatrix`).
   *  There is no runtime uniform or `tilePosition`-style knob that shifts
   *  a textured stroke without a full geometry rebuild. The implementer
   *  verified this by reading `node_modules/pixi.js/lib/scene/graphics/
   *  shared/utils/buildContextBatches.mjs` and `buildUvs.mjs`.
   *
   *  Fallback used here: each frame we `clear()` the animated Graphics,
   *  redraw one `moveTo/lineTo`, and `stroke()` with a phase-shifted
   *  `matrix`. This is still dramatically cheaper than Phase 2's
   *  per-segment dashed-line loop (one line + one stroke vs N segments).
   */
  private updateAnimationOnly(nowMs: number): void {
    const offsetPx = nowMs * SCROLL_SPEED_PX_PER_MS;
    for (const entry of this.entries.values()) {
      const tex = getDashedStrokeTexture(entry.routeType);
      entry.animatedGraphics.clear();

      // Stroke segment-by-segment so each straight span of a bent route
      // scrolls its dash pattern along its own angle.
      const pts = entry.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i]!;
        const p2 = pts[i + 1]!;
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const angle = Math.atan2(dy, dx);

        // Fix 7.1: translate BEFORE rotate so the phase advances uniformly
        // along the line at every angle.  See §perf-2026-05-28 API note above.
        // The correct composition: identity → translate → rotate yields
        // M⁻¹.tx = offsetPx (uniform) instead of offsetPx·cos(angle) (old).
        this._scrollMatrix.set(1, 0, 0, 1, 0, 0).translate(-offsetPx, 0).rotate(angle);

        entry.animatedGraphics
          .moveTo(p1.x, p1.y)
          .lineTo(p2.x, p2.y)
          .stroke({ texture: tex, matrix: this._scrollMatrix, width: 2.0, alpha: 0.85 });
      }
    }
  }

  /** Per-frame overlay rebuild: chevrons + arrival-pulse + draft preview.
   *  Phase 3 deletes the per-frame dash highlight (the static layer became
   *  texture-stroked and animates via the matrix shift above). */
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
      // `from|to|buildingId` — the draft starts at the SELECTED source building
      // (matching where the real route will be drawn / the §2.6 weather path),
      // falling back to the island centre when no building is chosen yet.
      const [fromId, toId, buildingId] = draftKey.split('|');
      if (fromId && toId && fromId !== toId) {
        const p1 = (buildingId
          ? this.resolveRouteSourcePos?.({ from: fromId, sourceBuildingId: buildingId } as Route)
          : null) ?? this.resolveIslandPos(fromId);
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

      // In-flight chevrons interpolated along the polyline.
      const pts = entry.points;
      if (pts.length < 2) continue;

      // Segment lengths and cumulative distances.
      const segLens: number[] = [];
      let totalLen = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i]!;
        const p2 = pts[i + 1]!;
        const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        segLens.push(len);
        totalLen += len;
      }
      if (totalLen <= 0) continue;

      for (const b of r.inFlight) {
        const total = b.arrivalTime - b.dispatchTime;
        if (total <= 0) continue;
        const t = Math.max(0, Math.min(1, (nowMs - b.dispatchTime) / total));
        const targetDist = t * totalLen;

        let distSoFar = 0;
        let segIdx = 0;
        for (; segIdx < segLens.length; segIdx++) {
          if (distSoFar + segLens[segIdx]! >= targetDist) break;
          distSoFar += segLens[segIdx]!;
        }
        segIdx = Math.min(segIdx, segLens.length - 1);

        const p1 = pts[segIdx]!;
        const p2 = pts[segIdx + 1]!;
        const segLen = segLens[segIdx]!;
        const segT = segLen > 0 ? (targetDist - distSoFar) / segLen : 0;
        const cx = p1.x + (p2.x - p1.x) * segT;
        const cy = p1.y + (p2.y - p1.y) * segT;
        const ux = segLen > 0 ? (p2.x - p1.x) / segLen : 0;
        const uy = segLen > 0 ? (p2.y - p1.y) / segLen : 0;
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
    if (this._disposed) return;
    this._disposed = true;
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
