// Copyright 2026 Anthropic PBC · SPDX-License-Identifier: Apache-2.0
//
// Bend-handle overlay for the selected route. Render layer: draws a faint
// highlighted polyline, waypoint handles, and midpoint "add" affordance dots.
//
// Pure geometry helper `handleWorldPositions` is unit-tested; the Pixi draw
// loop is read-only against state and is not unit-tested per AGENTS.md.

import { Container, Graphics } from 'pixi.js';
import { routePolylinePoints, type Route } from './routes.js';
import type { IslandSpec } from './world.js';

/** World-pixel positions of each waypoint handle on a route. Returns `[]` when
 *  the route has no waypoints or either endpoint island is unknown. */
export function handleWorldPositions(
  route: Route,
  islandIndex: Map<string, IslandSpec>,
  tilePx: number,
): Array<{ x: number; y: number }> {
  const pts = routePolylinePoints(route, islandIndex);
  if (!pts || pts.length < 3) return [];
  // pts = [from, waypoint0, waypoint1, ..., to]; slice off endpoints.
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    out.push({ x: p.x * tilePx, y: p.y * tilePx });
  }
  return out;
}

export class RouteBendOverlay {
  readonly layer: Container;
  private readonly gfx: Graphics;
  private selected: Route | null = null;
  private islandIndex: Map<string, IslandSpec> = new Map();
  private tilePx = 24;

  constructor(tilePx = 24) {
    this.tilePx = tilePx;
    this.layer = new Container();
    this.layer.label = 'route-bend-overlay';
    this.gfx = new Graphics();
    this.gfx.label = 'route-bend-gfx';
    this.layer.addChild(this.gfx);
    this.layer.visible = false;
  }

  setSelected(route: Route | null, islandIndex: Map<string, IslandSpec>): void {
    this.selected = route;
    this.islandIndex = islandIndex;
    this.layer.visible = route !== null;
    this.update();
  }

  update(): void {
    const g = this.gfx;
    g.clear();

    if (!this.selected) return;
    const pts = routePolylinePoints(this.selected, this.islandIndex);
    if (!pts || pts.length < 2) return;

    const worldPts = pts.map((p) => ({ x: p.x * this.tilePx, y: p.y * this.tilePx }));

    // Faint highlighted polyline.
    g.moveTo(worldPts[0]!.x, worldPts[0]!.y);
    for (let i = 1; i < worldPts.length; i++) {
      const p = worldPts[i]!;
      g.lineTo(p.x, p.y);
    }
    g.stroke({ width: 2, color: 0x7dd3e8, alpha: 0.35 });

    // Filled circle handle at each waypoint.
    const handleRadius = 5;
    for (let i = 1; i < worldPts.length - 1; i++) {
      const p = worldPts[i]!;
      g.circle(p.x, p.y, handleRadius).fill({ color: 0x7dd3e8, alpha: 0.85 });
    }

    // Smaller "add" affordance dot at each segment midpoint.
    const addRadius = 2.5;
    for (let i = 0; i < worldPts.length - 1; i++) {
      const a = worldPts[i]!;
      const b = worldPts[i + 1]!;
      const mx = (a.x + b.x) * 0.5;
      const my = (a.y + b.y) * 0.5;
      g.circle(mx, my, addRadius).fill({ color: 0xf5a742, alpha: 0.7 });
    }
  }

  dispose(): void {
    this.selected = null;
    this.layer.destroy({ children: true });
  }
}
