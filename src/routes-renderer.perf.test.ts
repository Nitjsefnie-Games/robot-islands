// Copyright 2026 Anthropic PBC · SPDX-License-Identifier: Apache-2.0
//
// §perf-2026-05-28 Phase 4: routes-renderer perf-gate.
// 50 routes, steady-state frames, per-update wall-clock < 0.5 ms.
// Un-skipped — runs in `npm test`. Threshold loose enough to avoid
// CI-jitter false negatives; tight enough to catch a regression.

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
  it('update() with 50 routes stays under 0.5 ms wall-clock on steady-state frames', () => {
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
    expect(dtPerCall).toBeLessThan(0.5);
  });
});
