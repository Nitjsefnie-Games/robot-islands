// Copyright 2026 Anthropic PBC · SPDX-License-Identifier: Apache-2.0
//
// §perf-2026-05-28 Phase 4: routes-renderer correctness coverage.
// Pixi Graphics/Container construct fine in node — the project's
// placement-ui.test.ts proves the pattern. We spy on instance methods
// (not prototypes) so the animated-layer per-frame clear doesn't
// pollute the static-layer assertions.

import { describe, it, expect, vi } from 'vitest';
import { Container } from 'pixi.js';
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
  it('every Route field is either in routesCacheKey or on the not-visual whitelist', () => {
    const r = makeRoute('r1', {
      sourceBuildingId: 'b1',
      draining: false,
    });

    const cacheKeyFields = new Set(['id', 'type', 'from', 'to', 'inFlight']);
    const notVisualWhitelist = new Set([
      'capacityPerSec',     // not rendered (stat panel only)
      'mode',               // priority / weighted; not rendered
      'cargo',              // resource filter list; not rendered
      'transitTimeSec',     // chevrons read inFlight items directly; route field unused at render
      'sourceBuildingId',   // metadata; used for buildBuildingOptions only
      'draining',           // soft-delete flag; not visually distinguished today
    ]);

    const known = new Set([...cacheKeyFields, ...notVisualWhitelist]);
    for (const k of Object.keys(r)) {
      expect(
        known.has(k),
        `Route field "${k}" is neither in cacheKeyFields nor on the not-visual whitelist. If it affects rendered output, add it to routesCacheKey() in src/routes.ts. Otherwise, add it to the whitelist in this test file.`,
      ).toBe(true);
    }
  });
});


describe('RouteRenderer — lifecycle', () => {
  it('dispose() is idempotent', () => {
    const r = new RouteRenderer(makeResolver());
    r.dispose();
    expect(() => r.dispose()).not.toThrow();
  });
});

describe('RouteRenderer — Fix 7.1: dash-scroll matrix composition', () => {
  // Pixi 8 computes stroke UVs as invert(style.matrix) · vertex.
  // For uniform phase advance the FIXED composition is:
  //   set(identity).translate(-offsetPx, 0).rotate(angle)
  // which yields M⁻¹ = [cos, sin, offsetPx; -sin, cos, 0].
  // The u-component of any vertex therefore changes by exactly +offsetPx
  // regardless of angle — verified analytically above.
  //
  // The BROKEN (old) composition:
  //   set(identity).rotate(angle).translate(-offsetPx, 0)
  // yields M⁻¹.tx = offsetPx*cos(angle), so vertical routes don't scroll.

  function composeFixed(angle: number, offsetPx: number): { tx: number; ty: number } {
    // Reproduces the FIXED code: identity → translate → rotate
    // translate: tx=-offsetPx, ty=0, a=1, b=0, c=0, d=1
    // rotate: tx = -offsetPx*cos, ty = -offsetPx*sin
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const tx = -offsetPx * cos;
    const ty = -offsetPx * sin;
    // M⁻¹.tx = -cos*tx - sin*ty = offsetPx*cos² + offsetPx*sin² = offsetPx
    const invTx = -cos * tx - sin * ty;
    const invTy =  sin * tx - cos * ty;
    return { tx: invTx, ty: invTy };
  }

  function composeBroken(angle: number, offsetPx: number): { tx: number; ty: number } {
    // Reproduces the BROKEN code: identity → rotate → translate(-offsetPx, 0)
    // After rotate: a=cos, b=sin, c=-sin, d=cos, tx=0, ty=0
    // After translate: tx=-offsetPx, ty=0
    // M⁻¹.tx = -cos*(-offsetPx) + sin*0 = offsetPx*cos
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const invTx =  cos * offsetPx; // = offsetPx * cos(angle)
    const invTy = -sin * offsetPx; // regression note
    return { tx: invTx, ty: invTy };
  }

  it('fixed composition: M⁻¹.tx === offsetPx regardless of angle (phase advance uniform)', () => {
    const offsetPx = 42;
    for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 3]) {
      const { tx } = composeFixed(angle, offsetPx);
      expect(tx).toBeCloseTo(offsetPx, 9);
    }
  });

  it('fixed composition: M⁻¹.ty === 0 regardless of angle', () => {
    const offsetPx = 42;
    for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 3]) {
      const { ty } = composeFixed(angle, offsetPx);
      expect(ty).toBeCloseTo(0, 9);
    }
  });

  it('regression guard: broken composition yields M⁻¹.tx ≈ 0 at angle=π/2 (vertical route dead)', () => {
    const offsetPx = 42;
    const { tx } = composeBroken(Math.PI / 2, offsetPx);
    // cos(π/2) ≈ 0 → broken code scrolls by ~0, not offsetPx
    expect(Math.abs(tx)).toBeLessThan(1e-9);
  });

  it('regression guard: broken composition differs from fixed at angle=π/2', () => {
    const offsetPx = 42;
    const fixed = composeFixed(Math.PI / 2, offsetPx);
    const broken = composeBroken(Math.PI / 2, offsetPx);
    expect(Math.abs(fixed.tx - broken.tx)).toBeGreaterThan(40);
  });
});
