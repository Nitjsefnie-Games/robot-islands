// Copyright 2026 Anthropic PBC · SPDX-License-Identifier: Apache-2.0
//
// Module-scope pool of dashed-stroke textures, one per RouteType.
// Held for the session lifetime; never destroyed. With the current
// route-type catalogue the pool is 3-5 textures, < 1 MB total GPU
// memory (small dash patterns at low resolution).

import { Texture } from 'pixi.js';
import type { RouteType } from './routes.js';

const _cache = new Map<RouteType, Texture>();

/** Texture dimensions. Square (12×12) so the rotated texture matrix
 *  used in routes-renderer.ts produces uniform dash spacing along
 *  lines at any angle. */
const TILE_SIZE = 12;
const DASH_WIDTH = 8;

/** Per-routeType color used by both the dash texture build and the
 *  Phase 2 Graphics-stroke fallback. Mirrors the constants currently
 *  in routes-ui.ts so visual output stays identical across the
 *  migration. */
export function colorForRouteType(t: RouteType): number {
  if (t === 'submarine_cable') return 0x4a6680;  // SUBMARINE_CABLE_TINT
  if (t === 'cable') return 0x9caab8;            // LAND_CABLE_TINT
  return 0x7dd3e8;                                // VISION_BLUE — cargo / drone / etc.
}

/** Build (lazy) / return the cached dash texture for `routeType`. The
 *  texture is built via a 2D Canvas — a pure-CPU path that doesn't
 *  require a live Pixi Renderer (safer to call before the renderer is
 *  fully online and unit-testable without a WebGL context). */
export function getDashedStrokeTexture(routeType: RouteType): Texture {
  const cached = _cache.get(routeType);
  if (cached) return cached;

  const color = colorForRouteType(routeType);
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!canvas) {
    // Test environment fallback — Texture.EMPTY is a valid 1×1 white
    // texture that produces a solid stroke (degrades gracefully).
    const empty = Texture.EMPTY;
    _cache.set(routeType, empty);
    return empty;
  }
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    const empty = Texture.EMPTY;
    _cache.set(routeType, empty);
    return empty;
  }
  ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, DASH_WIDTH, TILE_SIZE);
  // gap (DASH_WIDTH .. TILE_SIZE) stays transparent.

  const tex = Texture.from(canvas);
  tex.source.style.addressMode = 'repeat';
  _cache.set(routeType, tex);
  return tex;
}

/** Test-only — reset the texture pool. Phase 4 perf-test calls this between
 *  cases to ensure each test gets a fresh build. */
export function _resetDashTextureCache(): void {
  _cache.clear();
}
