// Copyright 2026 Anthropic PBC · SPDX-License-Identifier: Apache-2.0
//
// Module-scope pool of dashed-stroke textures, one per RouteType.
// Held for the session lifetime; never destroyed. With the current
// route-type catalogue the pool is 3-5 textures, < 1 MB total GPU
// memory (small dash patterns at low resolution). Phase 2 returns
// null and the renderer falls back to a solid stroke; Phase 3 wires
// the actual RenderTexture build.

import type { Renderer, Texture } from 'pixi.js';
import type { RouteType } from './routes.js';

// Phase-3 will populate this cache; Phase-2 stub leaves it empty.
const _cache = new Map<RouteType, Texture>();
void _cache;

/** Lazily build (Phase 3) / return cached dash texture for `routeType`.
 *  Phase 2: returns null — RouteRenderer falls back to a Graphics-built
 *  dashed stroke. Phase 3 replaces the body with a RenderTexture build. */
export function getDashedStrokeTexture(
  _renderer: Renderer,
  _routeType: RouteType,
): Texture | null {
  return null;  // Phase 2 stub; Phase 3 builds the texture
}

/** Per-routeType color used by both the dash texture (Phase 3 build) and
 *  the Phase 2 Graphics-stroke fallback. Mirrors the constants currently
 *  in routes-ui.ts so visual output stays identical across the migration. */
export function colorForRouteType(t: RouteType): number {
  if (t === 'submarine_cable') return 0x4a6680;  // SUBMARINE_CABLE_TINT
  if (t === 'cable') return 0x9caab8;            // LAND_CABLE_TINT
  return 0x7dd3e8;                                // VISION_BLUE — cargo / drone / etc.
}
