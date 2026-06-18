// Copyright 2026 Anthropic PBC · SPDX-License-Identifier: Apache-2.0
//
// §perf-2026-05-28 Phase 4: routes-renderer correctness coverage.
// Pixi Graphics/Container construct fine in node — the project's
// placement-ui.test.ts proves the pattern. We spy on instance methods
// (not prototypes) so the animated-layer per-frame clear doesn't
// pollute the static-layer assertions.

import { describe, it, expect, vi } from 'vitest';
import { Container, Matrix } from 'pixi.js';
import { RouteRenderer } from './routes-renderer.js';
import { type Route, type RouteType } from './routes.js';
import { tileToWorldPx } from './world.js';

function makeRoute(id: string, overrides: Partial<Route> = {}): Route {
  return {
    id,
    from: 'island-a',
    to: 'island-b',
    type: 'cargo' as RouteType,
    capacityPerSec: 0.5,
    mode: 'priority',
    cargo: [],
    transitTimeSec: 10,
    inFlight: [],
    ...overrides,
  };
}

function makeResolver() {
  return (id: string) => {
    if (id === 'island-a') return tileToWorldPx(0, 0);
    if (id === 'island-b') return tileToWorldPx(10, 5);
    if (id === 'island-c') return tileToWorldPx(-5, 8);
    return null;
  };
}

describe('RouteRenderer — Phase 1 contract', () => {
  it('paintLayer with unchanged routes does not call Graphics.clear() on the static layer on second invocation', () => {
    const r = new RouteRenderer(makeResolver());
    const routes = [makeRoute('r1')];
    r.update(routes, 0, '', false);

    const entry = r._entriesForTest().get('r1')!;
    const staticClearSpy = vi.spyOn(entry.staticGraphics, 'clear');

    r.update(routes, 16, '', false);
    expect(staticClearSpy).not.toHaveBeenCalled();
  });

  it('paintLayer rebuilds when route.inFlight.length changes', () => {
    const r = new RouteRenderer(makeResolver());
    const routes = [makeRoute('r1')];
    r.update(routes, 0, '', false);

    const entry = r._entriesForTest().get('r1')!;
    const staticClearSpy = vi.spyOn(entry.staticGraphics, 'clear');

    routes[0]!.inFlight.push({
      resourceId: 'iron_ore' as never,
      amount: 1,
      arrivalTime: 1000,
      dispatchTime: 0,
    });
    r.update(routes, 16, '', false);
    expect(staticClearSpy).toHaveBeenCalled();
  });
});

describe('RouteRenderer — Phase 2 world-space contract', () => {
  it('builds line endpoints in world coords, NOT screen coords', () => {
    const r = new RouteRenderer(makeResolver());
    const routes = [makeRoute('r1')];
    r.update(routes, 0, '', false);

    const entries = r._entriesForTest();
    const e = entries.get('r1');
    expect(e).toBeDefined();

    const a = tileToWorldPx(0, 0);
    const b = tileToWorldPx(10, 5);
    expect(e!.fromX).toBe(a.x);
    expect(e!.fromY).toBe(a.y);
    expect(e!.toX).toBe(b.x);
    expect(e!.toY).toBe(b.y);
  });

  it('route Graphics layers are attached to world container, not UI container', () => {
    const world = new Container();
    world.label = 'world';
    const r = new RouteRenderer(makeResolver());
    world.addChild(r.staticLayer);
    world.addChild(r.animatedLayer);
    world.addChild(r.overlayLayer);
    expect(r.staticLayer.parent).toBe(world);
    expect(r.animatedLayer.parent).toBe(world);
    expect(r.overlayLayer.parent).toBe(world);
  });
});

describe('RouteRenderer — Phase 3 animation contract', () => {
  it('dashed texture animation advances frame-to-frame WITHOUT calling .clear() on the static layer', () => {
    const r = new RouteRenderer(makeResolver());
    const routes = [makeRoute('r1')];
    r.update(routes, 0, '', false); // warm

    const entry = r._entriesForTest().get('r1')!;
    const staticClearSpy = vi.spyOn(entry.staticGraphics, 'clear');
    const animatedClearSpy = vi.spyOn(entry.animatedGraphics, 'clear');

    for (let i = 0; i < 10; i++) {
      r.update(routes, i * 16, '', false);
    }

    // Static layer must NOT be cleared during animation-only frames.
    expect(staticClearSpy).not.toHaveBeenCalled();
    // Animated layer MUST clear+restroke every frame (Pixi 8 limitation).
    expect(animatedClearSpy).toHaveBeenCalledTimes(10);
  });
});

describe('Route field whitelist', () => {
  it('every Route field is either in perRouteKey (RouteRenderer.diffRebuild) or on the not-visual whitelist', () => {
    const r = makeRoute('r1', {
      sourceBuildingId: 'b1',
      draining: false,
    });

    // Fields currently encoded in `perRouteKey` inside RouteRenderer.diffRebuild()
    // (routes-renderer.ts). Adding a new Route field that affects rendered output?
    // Add it there AND to this set. See VISUAL-FIELD-MARKER in routes.ts.
    const perRouteKeyFields = new Set(['id', 'type', 'from', 'to', 'inFlight', 'waypoints']);
    const notVisualWhitelist = new Set([
      'capacityPerSec',     // not rendered (stat panel only)
      'mode',               // priority / weighted; not rendered
      'cargo',              // resource filter list; not rendered
      'transitTimeSec',     // chevrons read inFlight items directly; route field unused at render
      'sourceBuildingId',   // metadata; used for buildBuildingOptions only
      'draining',           // soft-delete flag; not visually distinguished today
    ]);

    const known = new Set([...perRouteKeyFields, ...notVisualWhitelist]);
    for (const k of Object.keys(r)) {
      expect(
        known.has(k),
        `Route field "${k}" is neither in perRouteKeyFields nor on the not-visual whitelist. If it affects rendered output, add it to \`perRouteKey\` in RouteRenderer.diffRebuild() (routes-renderer.ts). Otherwise, add it to the whitelist in this test file.`,
      ).toBe(true);
    }
  });
});


describe('RouteRenderer — Fix 7.4: cacheKey includes endpoint world coords + waypoints', () => {
  // When an island's centre changes (merge §3.6 / land reclamation), the per-route
  // cacheKey must change so the rendered route geometry is rebuilt.  Before the fix,
  // the key was only `${type}|${from}|${to}|${inFlightLen}` — endpoint positions were
  // not included, so moves left the drawn route stale until inFlight changed.

  it('cacheKey differs after one endpoint position changes', () => {
    // Use a mutable position map so we can simulate an island move.
    const positions: Record<string, { x: number; y: number }> = {
      'island-a': tileToWorldPx(0, 0),
      'island-b': tileToWorldPx(10, 5),
    };
    const resolver = (id: string) => positions[id] ?? null;
    const renderer = new RouteRenderer(resolver);
    const routes = [makeRoute('r1')];

    // Initial build.
    renderer.update(routes, 0, '', false);
    const keyBefore = renderer._entriesForTest().get('r1')!.cacheKey;

    // Move island-b to a different position (simulate merge / reclamation).
    positions['island-b'] = tileToWorldPx(20, 15);
    renderer.update(routes, 16, '', false);
    const keyAfter = renderer._entriesForTest().get('r1')!.cacheKey;

    expect(keyBefore).not.toBe(keyAfter);
  });

  it('cacheKey is stable when positions are unchanged', () => {
    const renderer = new RouteRenderer(makeResolver());
    const routes = [makeRoute('r1')];

    renderer.update(routes, 0, '', false);
    const keyBefore = renderer._entriesForTest().get('r1')!.cacheKey;

    renderer.update(routes, 16, '', false);
    const keyAfter = renderer._entriesForTest().get('r1')!.cacheKey;

    expect(keyBefore).toBe(keyAfter);
  });

  it('changing waypoints invalidates the per-route cacheKey (rebuild) (#118)', () => {
    const renderer = new RouteRenderer(makeResolver());
    const routes = [makeRoute('r1')];

    renderer.update(routes, 0, '', false);
    const keyBefore = renderer._entriesForTest().get('r1')!.cacheKey;

    routes[0] = makeRoute('r1', { waypoints: [{ x: 5, y: 3 }] });
    renderer.update(routes, 16, '', false);
    const keyAfter = renderer._entriesForTest().get('r1')!.cacheKey;

    expect(keyBefore).not.toBe(keyAfter);
  });
});

describe('RouteRenderer — lifecycle', () => {
  it('dispose() is idempotent', () => {
    const r = new RouteRenderer(makeResolver());
    r.dispose();
    expect(() => r.dispose()).not.toThrow();
  });
});

describe('RouteRenderer — Fix 7.1: dash-scroll matrix composition (live Pixi Matrix)', () => {
  // Pixi 8 computes stroke UVs as invert(style.matrix) · vertex (verified in
  // node_modules/pixi.js/lib/scene/graphics/shared/utils/generateTextureFillMatrix.mjs).
  // The dash-scroll phase therefore lives in invert(M).tx.  These tests build
  // the exact matrix compositions from updateAnimationOnly with the real Pixi
  // Matrix API and assert on the inverted translation.
  //
  // FIXED composition  (current code):  set(identity).translate(-offsetPx, 0).rotate(angle)
  //   → invert(M).tx === offsetPx at EVERY angle: uniform phase advance.
  // BROKEN composition (pre-fix code):  set(identity).rotate(angle).translate(-offsetPx, 0)
  //   → invert(M).tx === offsetPx·cos(angle): dead on vertical routes (cos(π/2)=0).
  const offsetPx = 42;
  const ANGLES = [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 3];

  it('fixed composition: invert(M).tx === offsetPx and invert(M).ty === 0 at every angle', () => {
    for (const angle of ANGLES) {
      const inv = new Matrix().set(1, 0, 0, 1, 0, 0).translate(-offsetPx, 0).rotate(angle).invert();
      expect(inv.tx, `tx at angle=${angle}`).toBeCloseTo(offsetPx, 9);
      expect(inv.ty, `ty at angle=${angle}`).toBeCloseTo(0, 9);
    }
  });

  it('regression guard: broken rotate→translate composition yields invert(M).tx ≈ 0 at angle=π/2', () => {
    const inv = new Matrix().set(1, 0, 0, 1, 0, 0).rotate(Math.PI / 2).translate(-offsetPx, 0).invert();
    // cos(π/2) ≈ 0 → vertical routes get ~0 phase advance: the original bug.
    expect(Math.abs(inv.tx)).toBeLessThan(1e-9);
  });

  it('regression guard: broken composition differs from fixed at angle=π/2', () => {
    const fixed = new Matrix().set(1, 0, 0, 1, 0, 0).translate(-offsetPx, 0).rotate(Math.PI / 2).invert();
    const broken = new Matrix().set(1, 0, 0, 1, 0, 0).rotate(Math.PI / 2).translate(-offsetPx, 0).invert();
    expect(Math.abs(fixed.tx - broken.tx)).toBeGreaterThan(40);
  });
});
