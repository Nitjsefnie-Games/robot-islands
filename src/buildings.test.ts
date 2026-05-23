import { describe, it, expect } from 'vitest';
import { hasOperationalBuilding, type PlacedBuilding } from './buildings.js';

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
    // Asserts the predicate already filters on b.disabled even before
    // PlacedBuilding.disabled lands in Task 2. The field is an extra string
    // key per TS structural typing, so we cast through unknown.
    const list: PlacedBuilding[] = [
      ({ id: 'a', defId: 'spaceport', x: 0, y: 0, disabled: true } as unknown) as PlacedBuilding,
    ];
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
