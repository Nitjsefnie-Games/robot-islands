import { describe, expect, it } from 'vitest';

import {
  CABLE_TRANSMISSION_KW,
  createPowerLinkRoute,
  isPowerLink,
  powerLinkPeerDef,
  powerLinkTypeForBuilding,
  _resetRouteIdCounter,
} from './routes.js';
import type { PlacedBuilding } from './buildings.js';

function building(defId: PlacedBuilding['defId']): PlacedBuilding {
  return { id: `b-${defId}`, defId, x: 0, y: 0 };
}

// §5.3 inter-island power links — the missing creation path (#115). The pure
// builders pick the route type from the endpoint and produce a cargo-less,
// zero-transit power route.
describe('power-link route helpers (§5.3, #115)', () => {
  it('maps power endpoints to their route type', () => {
    expect(powerLinkTypeForBuilding('power_substation')).toBe('submarine_cable');
    expect(powerLinkTypeForBuilding('spacetime_anchor')).toBe('spacetime');
    expect(powerLinkTypeForBuilding('dock')).toBeNull();
  });

  it('requires the same endpoint def at both ends', () => {
    expect(powerLinkPeerDef('power_substation')).toBe('power_substation');
    expect(powerLinkPeerDef('spacetime_anchor')).toBe('spacetime_anchor');
    expect(powerLinkPeerDef('dronepad')).toBeNull();
  });

  it('builds a submarine_cable from a Power Substation — no cargo, zero transit', () => {
    _resetRouteIdCounter();
    const r = createPowerLinkRoute(building('power_substation'), 'home', 'colony');
    expect(r).not.toBeNull();
    expect(r!.type).toBe('submarine_cable');
    expect(isPowerLink(r!.type)).toBe(true);
    expect(r!.capacityPerSec).toBe(CABLE_TRANSMISSION_KW);
    expect(r!.cargo).toEqual([]);
    expect(r!.transitTimeSec).toBe(0);
    expect(r!.from).toBe('home');
    expect(r!.to).toBe('colony');
    expect(r!.sourceBuildingId).toBe('b-power_substation');
  });

  it('builds an infinite-capacity spacetime route from a Spacetime Anchor', () => {
    const r = createPowerLinkRoute(building('spacetime_anchor'), 'home', 'colony');
    expect(r!.type).toBe('spacetime');
    expect(r!.capacityPerSec).toBe(0); // unused — the spacetime gate always passes
    expect(r!.cargo).toEqual([]);
  });

  it('returns null for a non-power building', () => {
    expect(createPowerLinkRoute(building('dock'), 'home', 'colony')).toBeNull();
  });
});
