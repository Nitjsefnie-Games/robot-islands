import { describe, it, expect } from 'vitest';
import {
  hasOperationalBuilding,
  isOperationalBuilding,
  participatesInCluster,
  findOperationalBuilding,
  ratedBuildingPower,
  activeFloors,
  activeFloorLevel,
  displayedFloorLevel,
  type PlacedBuilding,
} from './buildings.js';

function b(over: Partial<PlacedBuilding> & { id: string; defId: PlacedBuilding['defId'] }): PlacedBuilding {
  return { x: 0, y: 0, ...over };
}

describe('hasOperationalBuilding', () => {
  it('returns false for an empty list', () => {
    expect(hasOperationalBuilding([], 'spaceport')).toBe(false);
  });

  it('returns true when a matching, non-invalid, fully-constructed building exists', () => {
    const list: PlacedBuilding[] = [b({ id: 'a', defId: 'spaceport' })];
    expect(hasOperationalBuilding(list, 'spaceport')).toBe(true);
  });

  it('ignores buildings of a different defId', () => {
    const list: PlacedBuilding[] = [b({ id: 'a', defId: 'workshop' })];
    expect(hasOperationalBuilding(list, 'spaceport')).toBe(false);
  });

  it('skips invalid buildings', () => {
    const list: PlacedBuilding[] = [b({ id: 'a', defId: 'spaceport', invalid: true })];
    expect(hasOperationalBuilding(list, 'spaceport')).toBe(false);
  });

  it('skips buildings still under construction', () => {
    const list: PlacedBuilding[] = [b({ id: 'a', defId: 'spaceport', constructionRemainingMs: 1000 })];
    expect(hasOperationalBuilding(list, 'spaceport')).toBe(false);
  });

  it('skips fully floor-disabled buildings', () => {
    const list: PlacedBuilding[] = [b({ id: 'a', defId: 'spaceport', disabledFloors: displayedFloorLevel({ floorLevel: 0 }) })];
    expect(hasOperationalBuilding(list, 'spaceport')).toBe(false);
  });

  it('returns true when at least one of several candidates is operational', () => {
    const list: PlacedBuilding[] = [
      b({ id: 'a', defId: 'spaceport', invalid: true }),
      b({ id: 'b', defId: 'spaceport', constructionRemainingMs: 5000 }),
      b({ id: 'c', defId: 'spaceport' }),
    ];
    expect(hasOperationalBuilding(list, 'spaceport')).toBe(true);
  });
});

describe('isOperationalBuilding', () => {
  it('returns true for a plain operational building', () => {
    expect(isOperationalBuilding(b({ id: 'a', defId: 'spaceport' }))).toBe(true);
  });

  it('returns false for invalid', () => {
    expect(isOperationalBuilding(b({ id: 'a', defId: 'spaceport', invalid: true }))).toBe(false);
  });

  it('returns false for under-construction', () => {
    expect(isOperationalBuilding(b({ id: 'a', defId: 'spaceport', constructionRemainingMs: 1000 }))).toBe(false);
  });

  it('returns false for fully floor-disabled', () => {
    expect(isOperationalBuilding(b({ id: 'a', defId: 'spaceport', disabledFloors: displayedFloorLevel({ floorLevel: 0 }) }))).toBe(false);
  });
});

describe('findOperationalBuilding', () => {
  it('returns undefined for an empty list', () => {
    expect(findOperationalBuilding([], 'spaceport')).toBeUndefined();
  });

  it('returns the building when found and operational', () => {
    const list: PlacedBuilding[] = [b({ id: 'a', defId: 'spaceport' })];
    expect(findOperationalBuilding(list, 'spaceport')).toEqual(list[0]);
  });

  it('returns undefined when the only match is invalid', () => {
    const list: PlacedBuilding[] = [b({ id: 'a', defId: 'spaceport', invalid: true })];
    expect(findOperationalBuilding(list, 'spaceport')).toBeUndefined();
  });

  it('returns the first operational match', () => {
    const list: PlacedBuilding[] = [
      b({ id: 'a', defId: 'spaceport', invalid: true }),
      b({ id: 'b', defId: 'spaceport' }),
    ];
    expect(findOperationalBuilding(list, 'spaceport')).toEqual(list[1]);
  });

  it('skips fully floor-disabled buildings', () => {
    const list: PlacedBuilding[] = [b({ id: 'a', defId: 'spaceport', disabledFloors: displayedFloorLevel({ floorLevel: 0 }) })];
    expect(findOperationalBuilding(list, 'spaceport')).toBeUndefined();
  });
});

describe('ratedBuildingPower', () => {
  it('returns identity at L0 with mul 1', () => {
    expect(ratedBuildingPower(5000, 0, 0, 1, 1)).toEqual({ produced: 5000, consumed: 0 });
  });

  it('scales produced and consumed by floor level alone', () => {
    // floorEffectMul(3) = 1 + 3 = 4
    // floorPowerDrawMul(3) = 1 + 0.5 * 3 = 2.5
    expect(ratedBuildingPower(100, 40, 3, 1, 1)).toEqual({ produced: 400, consumed: 100 });
  });

  it('scales produced and consumed by skill multipliers alone', () => {
    expect(ratedBuildingPower(100, 40, 0, 2, 2)).toEqual({ produced: 200, consumed: 20 });
  });

  it('combines floor and skill multipliers correctly', () => {
    // produced: 100 * 4 * 2 = 800
    // consumed: (40 * 2.5) / 2 = 50
    expect(ratedBuildingPower(100, 40, 3, 2, 2)).toEqual({ produced: 800, consumed: 50 });
  });
});

// Floor-disable state round-trips through the persistence shallow spread
// without any explicit migration.
describe('floor-disable is lossless across save round-trip', () => {
  it('a building with disabledFloors survives JSON.parse(JSON.stringify(b))', () => {
    const building: PlacedBuilding = {
      id: 'test-1',
      defId: 'workshop',
      x: 0,
      y: 0,
      disabledFloors: 1,
    };
    const round = JSON.parse(JSON.stringify(building)) as PlacedBuilding;
    expect(round.disabledFloors).toBe(1);
  });

  it('a building with disabledFloors === undefined round-trips as undefined', () => {
    const building: PlacedBuilding = { id: 'test-2', defId: 'workshop', x: 0, y: 0 };
    const round = JSON.parse(JSON.stringify(building)) as PlacedBuilding;
    expect(round.disabledFloors).toBeUndefined();
  });
});

describe('queue model fields', () => {
  it('PlacedBuilding accepts queued + queueSeq', () => {
    const b: PlacedBuilding = {
      id: 'placed-1', defId: 'iron_mine', x: 0, y: 0, rotation: 0,
      constructionRemainingMs: 30000, queued: true, queueSeq: 3,
    };
    expect(b.queued).toBe(true);
    expect(b.queueSeq).toBe(3);
  });
});

describe('active floors (floor-disable, Part 2)', () => {
  it('defaults to all built floors active', () => {
    expect(activeFloors({ floorLevel: 2 })).toBe(3);
    expect(activeFloorLevel({ floorLevel: 2 })).toBe(2);
  });
  it('subtracts disabledFloors from the top', () => {
    expect(activeFloors({ floorLevel: 2, disabledFloors: 1 })).toBe(2);
    expect(activeFloorLevel({ floorLevel: 2, disabledFloors: 1 })).toBe(1);
  });
  it('fully disabled = 0 active', () => {
    expect(activeFloors({ floorLevel: 2, disabledFloors: 3 })).toBe(0);
    expect(activeFloorLevel({ floorLevel: 2, disabledFloors: 3 })).toBe(-1);
  });
  it('clamps over-disable to 0 active', () => {
    expect(activeFloors({ floorLevel: 0, disabledFloors: 9 })).toBe(0);
  });
});

describe('floor-disable gating', () => {
  it('a building with 0 active floors is non-operational', () => {
    expect(isOperationalBuilding({ floorLevel: 1, disabledFloors: 2 })).toBe(false);
    expect(participatesInCluster({ floorLevel: 1, disabledFloors: 2 })).toBe(false);
  });
  it('a partially-disabled building is still operational', () => {
    expect(isOperationalBuilding({ floorLevel: 2, disabledFloors: 1 })).toBe(true);
    expect(participatesInCluster({ floorLevel: 2, disabledFloors: 1 })).toBe(true);
  });
});
