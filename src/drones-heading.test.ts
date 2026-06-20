import { describe, expect, it } from 'vitest';

import {
  droneHeadingAt,
  DRONE_T5_SPEED_TILES_PER_SEC,
  type Drone,
} from './drones.js';

// §11 — the in-flight marker must point in the drone's CURRENT travel
// direction, not its frozen launch heading (#144). droneHeadingAt derives the
// instantaneous heading from droneCurrentPosition so the return leg and every
// path bend rotate correctly.
function drone(over: Partial<Drone>): Drone {
  return {
    id: 'd',
    fromIslandId: 'home',
    originX: 0,
    originY: 0,
    dirX: 1,
    dirY: 0,
    outboundTiles: 20,
    scanRadius: 4,
    launchTime: 0,
    expectedReturnTime: 80_000,
    tier: 2,
    fuelLoaded: 10,
    fuelResource: 'diesel',
    status: 'active',
    waypoints: [],
    darkModeDiscoveries: [],
    scanBuffer: new Set<string>(),
    probabilityBias: 0,
    ...over,
  };
}

describe('droneHeadingAt (#144) — heading follows motion', () => {
  it('points along +dir on the outbound leg', () => {
    // East drone, speed 0.5 t/s, outbound 20 tiles → apex at 40s.
    const d = drone({ dirX: 1, dirY: 0 });
    expect(droneHeadingAt(d, 10_000)).toBeCloseTo(0, 5); // due east
  });

  it('points along -dir on the return leg (not tail-first)', () => {
    // t=50s is past the 40s apex → drone heading home (west).
    const d = drone({ dirX: 1, dirY: 0 });
    expect(Math.abs(droneHeadingAt(d, 50_000))).toBeCloseTo(Math.PI, 5); // due west
  });

  it('falls back to the launch heading before any motion', () => {
    // North drone at launch instant: no delta yet → launch heading (π/2).
    const d = drone({ dirX: 0, dirY: 1 });
    expect(droneHeadingAt(d, 0)).toBeCloseTo(Math.PI / 2, 5);
  });

  it('rotates to the current segment on a path-drawn flight', () => {
    // Polyline east-then-north. travelled=15 (5 tiles into the +y segment)
    // at t = 15 / 0.8 s → heading should be due north (π/2), not east.
    const d = drone({
      waypoints: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
    });
    const t = (15 / DRONE_T5_SPEED_TILES_PER_SEC) * 1000;
    expect(droneHeadingAt(d, t)).toBeCloseTo(Math.PI / 2, 5); // due north
  });
});
