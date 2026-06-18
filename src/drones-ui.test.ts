// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import { droneEtaLabel } from './drones-ui.js';

describe('droneEtaLabel (#136.4 one-way vs round-trip countdown)', () => {
  it('labels a round-trip drone with a bare return countdown', () => {
    // No waypoints (or <2) ⇒ straight-line round-trip: expectedReturnTime IS
    // the return-to-origin time, so a bare "T-Xs" reads correctly.
    expect(droneEtaLabel({ expectedReturnTime: 10_000 }, 0)).toBe('T-10.0s');
    expect(droneEtaLabel({ expectedReturnTime: 10_000, waypoints: [{ x: 0, y: 0 }] }, 0)).toBe('T-10.0s');
  });

  it('labels a one-way path drone as an arrival, not a return (#136.4)', () => {
    // A path-drawn drone (waypoints.length >= 2) goes `stranded` at its
    // terminus — expectedReturnTime is the ARRIVAL time, not a return, so the
    // label must not imply the drone comes back.
    expect(
      droneEtaLabel({ expectedReturnTime: 10_000, waypoints: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }, 0),
    ).toBe('arrive T-10.0s');
  });

  it('clamps a past return time to zero', () => {
    expect(droneEtaLabel({ expectedReturnTime: 1_000 }, 5_000)).toBe('T-0.0s');
  });
});
