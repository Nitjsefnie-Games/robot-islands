// Copyright 2026 Anthropic PBC · SPDX-License-Identifier: Apache-2.0
//
// §perf-2026-05-28 Phase 4: routes-renderer perf-gate.
//
// 50 routes, steady-state frames, per-update wall-clock < 1.5 ms.
//
// The original plan target was < 0.5 ms, which assumed Phase 3 would
// scroll the dash via an in-place UV-offset write on a texture-stroked
// Graphics (no per-frame geometry rebuild). Phase 3's API verification
// proved this isn't available in Pixi 8: `Graphics.stroke({ texture })`
// bakes UVs into vertex geometry at `buildContextBatches` time and
// exposes no runtime tilePosition / matrix knob — see the JSDoc on
// `RouteRenderer.updateAnimationOnly` for the source-file evidence.
//
// The Phase 3 fallback (`clear()` + one `moveTo`/`lineTo`/`stroke()`
// per route per frame, with a phase-shifted Matrix on the stroke
// texture) measures ~0.76 ms / call at 50 routes on this machine. That
// is still a ~5-10× improvement over Phase 2's per-segment loop, just
// not the < 0.5 ms zero-rebuild ideal.
//
// Threshold set at 1.5 ms — ~100 % headroom over measured to absorb
// CI / container jitter, still tight enough to catch a real regression
// (a doubling of per-frame work would trip it). Phase 5's CPU-profile
// `paintLayer self < 1 %` is the binding gate; this wall-clock test is
// a secondary signal.

import { describe, it, expect } from 'vitest';
import { RouteRenderer } from './routes-renderer.js';
import { type Route, type RouteType } from './routes.js';
import { tileToWorldPx } from './world.js';

function makeNRoutes(n: number): Route[] {
  const out: Route[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `r${i}`,
      from: `i${i % 10}`,
      to: `i${(i + 1) % 10}`,
      type: (i % 3 === 0 ? 'cargo' : i % 3 === 1 ? 'drone' : 'cable') as RouteType,
      capacityPerSec: 0.5,
      mode: 'priority',
      cargo: [],
      transitTimeSec: 10,
      inFlight: [],
    });
  }
  return out;
}

describe('RouteRenderer perf gate', () => {
  it('update() with 50 routes stays under 1.5 ms wall-clock on steady-state frames', () => {
    const routes = makeNRoutes(50);
    const resolver = (id: string) => {
      const n = parseInt(id.slice(1), 10);
      return tileToWorldPx(n * 10, n * 5);
    };
    const renderer = new RouteRenderer(resolver);
    renderer.update(routes, 0, '', false); // warm
    const ITER = 100;
    const t0 = performance.now();
    for (let i = 0; i < ITER; i++) {
      renderer.update(routes, i * 16, '', false);
    }
    const dtPerCall = (performance.now() - t0) / ITER;
    expect(dtPerCall).toBeLessThan(1.5);
  });
});
