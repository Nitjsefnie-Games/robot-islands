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

import { Container, Graphics, GraphicsContext } from 'pixi.js';
import type { Route } from './routes.js';
import { VISION_BLUE } from './world.js';
import { TILE_PX } from './island.js';
import { colorForRouteType } from './routes-dash-texture.js';

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


export class RouteRenderer {
  readonly staticLayer = new Container();
  readonly animatedLayer = new Container();
  readonly overlayLayer = new Container();
  private readonly overlayGfx = new Graphics();

  // PERF (§ chevron instancing): the in-flight chevrons animate every frame, so
  // the old paintOverlay accumulated all chevron triangles into `overlayGfx` and
  // re-tessellated them on every clear()+redraw — a per-frame geometry rebuild
  // whose cost scales with the in-flight bot count (the dominant render-ms cost
  // on a busy transport scene; live A/B confirmed routes-overlay as the top
  // render layer). Instead we tessellate ONE unit chevron into a SHARED
  // GraphicsContext (`chevronCtx`) and instance it across a pool of Graphics:
  // each frame we only set per-instance position/rotation (a matrix write, no
  // re-tessellation, no GPU geometry re-upload). Pixi v8 shares one tessellated
  // geometry across every Graphics built on the same context, so this is
  // byte-for-byte the same vector output as the old path — only the per-frame
  // CPU changes. Unit chevron points along +x (matches appendChevronPath with
  // u=(1,0), p=(0,1), c=origin → tip (6,0), base (-4,±4)); rotation orients it.
  private readonly chevronCtx = new GraphicsContext()
    .poly([6, 0, -4, 4, -4, -4])
    .fill({ color: VISION_BLUE, alpha: 0.85 })
    .stroke({ width: 1, color: 0xf5a742, alpha: 0.6 });
  private readonly chevronPool: Graphics[] = [];

  private readonly entries = new Map<string, RouteRenderState>();
  private _disposed = false;
  /** Whether overlayGfx (draft + pulses) drew anything last frame — drives the
   *  empty-clear gate so a frame that draws nothing into an already-empty layer
   *  skips clear() (and its render-group dirty). Starts true so the first frame
   *  always clears. */
  private _overlayHadContent = true;

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
    // PERF (§ render-group isolation): the overlay layer redraws its chevrons
    // every frame (paintOverlay clears + re-strokes for direction/flow), which
    // — if left in the root render group — dirties the root every frame and
    // forces a re-collect of the whole non-grouped world. The animated layer
    // holds the per-route line geometry (built once, static between route
    // edits). Isolating both as render groups keeps the chevron churn local to
    // a tiny group and lifts the static route lines out of the per-frame walk.
    // Live interleaved A/B on a 66-route scene (300 render-ms samples/phase):
    // grouping cut per-frame render time a consistent ~15% (0.88 → 0.74 ms;
    // every grouped run below every ungrouped run) — and the win scales with
    // on-screen scene weight. Behavior identical (render groups = same pixels).
    this.animatedLayer.enableRenderGroup();
    this.overlayLayer.enableRenderGroup();
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

  /** Build the route line geometry — a plain SOLID stroke along the polyline.
   *  Previously a scrolling texture-stroked dash. Pixi 8 bakes stroke-texture
   *  UVs into vertex geometry, which caused two artifacts: (a) scrolling the
   *  dashes required a full clear()+re-tessellate EVERY frame, which flickered
   *  the lines (~30 Hz), and (b) the dashed texture faded at the line ends where
   *  the segment length didn't land on a dash-period boundary. A solid stroke
   *  has neither problem and is built ONCE per cacheKey change (no per-frame
   *  work). Flow / direction is conveyed by the chevrons (see paintOverlay). */
  private buildRouteGeometry(r: Route, entry: RouteRenderState): void {
    const color = colorForRouteType(r.type);
    const pts = entry.points;
    if (pts.length >= 2) {
      const g = entry.animatedGraphics;
      g.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
      g.stroke({ color, width: 2, alpha: 0.85 });
    }
    // Static layer is unused now (the solid line lives on the animated layer,
    // built once); keep it hidden.
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
    // FLICKER FIX: the dash line is now STATIC — drawn once in
    // buildRouteGeometry and left alone. Pixi 8 bakes stroke-texture UVs into
    // vertex geometry (see API note above), so the old per-frame dash-scroll
    // had to clear() and re-stroke the Graphics EVERY frame. Re-tessellating +
    // re-uploading that geometry every frame made the yellow route lines
    // visibly flicker (~30 Hz: the line's drawn yellow oscillated frame-to-
    // frame, confirmed by a per-frame canvas capture). The "cargo flowing"
    // read is still carried by the chevrons, which animate in paintOverlay.
    // (A flicker-free scroll is possible via per-segment TilingSprites scrolled
    // by tilePosition — no geometry rebuild — but that's a larger change; this
    // removes the flicker now.)
    void nowMs;
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
    const flags = globalThis as Record<string, unknown>;
    const instanced = flags.__instChevrons !== false;

    // overlayGfx holds ONLY the draft preview + arrival pulses (chevrons are
    // pooled Graphics in pass 2). Decide up front whether either draws anything
    // this frame, so the empty-clear gate below can skip clear() when there's
    // nothing to draw and the layer is already empty — an unconditional clear
    // dirties the routes-overlay render group every frame even when it draws
    // nothing (the AGENTS.md empty-clear anti-pattern, now applicable because
    // the chevrons moved out of overlayGfx). `__forceOverlayIdle` is a debug
    // toggle that pretends nothing draws, to isolate the gate's idle-frame win.
    const draftSeg = this.draftSegment(draftKey, panelVisible);
    let anyPulse = false;
    if (!flags.__forceOverlayIdle) {
      for (const r of routes) {
        const entry = this.entries.get(r.id);
        if (!entry) continue;
        for (const b of r.inFlight) {
          const eta = (b.arrivalTime - nowMs) / 1000;
          if (eta >= 0 && eta <= 2) { anyPulse = true; break; }
        }
        if (anyPulse) break;
      }
    }
    const willDraw = draftSeg !== null || anyPulse;

    // Empty-clear gate (instanced mode only — in legacy mode overlayGfx also
    // accumulates chevrons below, so it must always clear). Skip the whole
    // clear+draw block when nothing draws and nothing was drawn last frame.
    // `__noOverlayGate` is a debug toggle that defeats the gate (always clears)
    // for live A/B of the gate's idle-frame saving.
    if (!instanced || willDraw || this._overlayHadContent || flags.__noOverlayGate) {
      g.clear();
      if (draftSeg) {
        g.moveTo(draftSeg.x1, draftSeg.y1)
         .lineTo(draftSeg.x2, draftSeg.y2)
         .stroke({ width: 1.5, color: VISION_BLUE, alpha: 0.3 });
      }
      // Arrival pulses (amber ring on the destination for the last 2 s). Drawn
      // before the legacy chevron batch so they don't commit its accumulated path
      // early. Few — at most one per route with an arrival in the last 2 s.
      if (!flags.__forceOverlayIdle) {
        for (const r of routes) {
          const entry = this.entries.get(r.id);
          if (!entry) continue;
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
        }
      }
      this._overlayHadContent = willDraw;
    }

    // Pass 2: in-flight chevrons. Instanced path (default) positions pooled
    // Graphics that share `chevronCtx` — no per-frame tessellation. The legacy
    // path (toggle `globalThis.__instChevrons = false`, kept for live A/B and as
    // a fallback) accumulates triangles into `overlayGfx` for one fill+stroke.
    let anyChevron = false;
    let chevronIdx = 0;
    for (const r of routes) {
      const entry = this.entries.get(r.id);
      if (!entry) continue;
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
        if (instanced) {
          const gc = this.acquireChevron(chevronIdx++);
          gc.position.set(cx, cy);
          gc.rotation = Math.atan2(uy, ux);
          gc.visible = true;
        } else {
          this.appendChevronPath(g, cx, cy, ux, uy);
          anyChevron = true;
        }
      }
    }
    if (instanced) {
      // Hide pooled chevrons beyond the live in-flight count.
      for (let i = chevronIdx; i < this.chevronPool.length; i++) {
        this.chevronPool[i]!.visible = false;
      }
      // Bound the pool: an offline-catch-up burst can momentarily put thousands
      // of bots in flight, growing the pool to that peak. Left untrimmed, the
      // hidden tail is carried through collectRenderables (and memory) forever.
      // Trim back toward current need + slack so steady state stays small; the
      // slack absorbs normal frame-to-frame variation without destroy/recreate
      // thrash. Trimmed instances were hidden, so this is behavior-neutral.
      const cap = chevronIdx + 64;
      if (this.chevronPool.length > cap) {
        for (let i = cap; i < this.chevronPool.length; i++) this.chevronPool[i]!.destroy();
        this.chevronPool.length = cap;
      }
    } else {
      // Legacy path: hide the whole instanced pool, then ONE fill + ONE stroke
      // for ALL accumulated chevrons (every chevron shares the same style).
      for (const gc of this.chevronPool) gc.visible = false;
      if (anyChevron) {
        g.fill({ color: VISION_BLUE, alpha: 0.85 })
         .stroke({ width: 1, color: 0xf5a742, alpha: 0.6 });
      }
    }
  }

  /** Lazily grow the instanced-chevron pool. Each instance is a Graphics built
   *  on the SHARED `chevronCtx`, so they all reuse one tessellated geometry and
   *  cost only a per-frame transform write. Parented under `overlayLayer` (after
   *  `overlayGfx`) so chevrons render on top of pulses/draft, matching the
   *  legacy z-order (pulses pass 1 → chevrons pass 2). */
  private acquireChevron(i: number): Graphics {
    let gc = this.chevronPool[i];
    if (!gc) {
      gc = new Graphics(this.chevronCtx);
      this.overlayLayer.addChild(gc);
      this.chevronPool[i] = gc;
    }
    return gc;
  }

  /** Resolve the draft-preview segment (panel open + valid distinct endpoints),
   *  or null when nothing should be drawn. Anchors at the SELECTED source
   *  building (matching the real route / §2.6 weather path), falling back to the
   *  island centre. Pure resolve, no drawing — lets paintOverlay's empty-clear
   *  gate know whether the draft will draw before deciding to clear. */
  private draftSegment(
    draftKey: string,
    panelVisible: boolean,
  ): { x1: number; y1: number; x2: number; y2: number } | null {
    if (!panelVisible || draftKey === '') return null;
    const [fromId, toId, buildingId] = draftKey.split('|');
    if (!fromId || !toId || fromId === toId) return null;
    const p1 = (buildingId
      ? this.resolveRouteSourcePos?.({ from: fromId, sourceBuildingId: buildingId } as Route)
      : null) ?? this.resolveIslandPos(fromId);
    const p2 = this.resolveIslandPos(toId);
    if (!p1 || !p2) return null;
    return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  }

  /** Append one ▶ chevron's triangle (centred at (cx,cy), pointing along
   *  (ux,uy)) to `g`'s CURRENT path — no fill/stroke. The caller batches a
   *  single fill()+stroke() over every chevron's accumulated triangle, so the
   *  per-instruction tessellation/setup cost is paid once, not per chevron. */
  private appendChevronPath(
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
     .closePath();
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
    // Pooled chevrons are destroyed with overlayLayer's children, but the
    // shared context they were built on is externally owned — free it too.
    this.chevronCtx.destroy();
  }

  /** Test-only accessor — Phase 4 introspects the per-route cacheKey to
   *  assert the no-rebuild-on-unchanged-input contract. */
  _entriesForTest(): ReadonlyMap<string, RouteRenderState> {
    return this.entries;
  }
}
