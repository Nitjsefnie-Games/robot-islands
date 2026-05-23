import { describe, it, expect } from 'vitest';
import {
  hasOperationalBuilding,
  isOperationalBuilding,
  findOperationalBuilding,
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

  it('skips disabled buildings (the field is the whole point — checked against future-Task-2)', () => {
    const list: PlacedBuilding[] = [b({ id: 'a', defId: 'spaceport', disabled: true })];
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

  it('returns false for disabled', () => {
    expect(isOperationalBuilding(b({ id: 'a', defId: 'spaceport', disabled: true }))).toBe(false);
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

  it('skips disabled buildings', () => {
    const list: PlacedBuilding[] = [b({ id: 'a', defId: 'spaceport', disabled: true })];
    expect(findOperationalBuilding(list, 'spaceport')).toBeUndefined();
  });
});

// The spec §05 verification row — disabled flag round-trips through
// the persistence shallow spread without any explicit migration.
describe('disable is lossless across save round-trip', () => {
  it('a building with disabled === true survives JSON.parse(JSON.stringify(b))', () => {
    const building: PlacedBuilding = {
      id: 'test-1',
      defId: 'workshop',
      x: 0,
      y: 0,
      disabled: true,
    };
    const round = JSON.parse(JSON.stringify(building)) as PlacedBuilding;
    expect(round.disabled).toBe(true);
  });

  it('a building with disabled === undefined round-trips as undefined', () => {
    const building: PlacedBuilding = { id: 'test-2', defId: 'workshop', x: 0, y: 0 };
    const round = JSON.parse(JSON.stringify(building)) as PlacedBuilding;
    expect(round.disabled).toBeUndefined();
  });
});
