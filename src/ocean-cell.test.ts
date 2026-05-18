import { describe, it, expect } from 'vitest';
import { terrainAt, footprintMatches, type OceanCellSpec } from './ocean-cell.js';

const mkWorld = (cells: Array<[number, number, OceanCellSpec['terrain']]>) => ({
  oceanCells: new Map(cells.map(([x, y, t]) => [`${x},${y}`, { terrain: t }] as const)),
});

describe('terrainAt', () => {
  it('returns the cell terrain when present', () => {
    const w = mkWorld([[0, 0, 'shallows']]);
    expect(terrainAt(w, 0, 0)).toBe('shallows');
  });

  it('returns the implicit "deep" default for unmapped cells', () => {
    const w = mkWorld([]);
    expect(terrainAt(w, 5, 5)).toBe('deep');
  });
});

describe('footprintMatches', () => {
  it('returns true when every footprint tile matches the required terrain', () => {
    const w = mkWorld([
      [0, 0, 'hydrothermal_vent'], [1, 0, 'hydrothermal_vent'],
      [0, 1, 'hydrothermal_vent'], [1, 1, 'hydrothermal_vent'],
    ]);
    expect(footprintMatches(w, 0, 0, 2, 2, ['hydrothermal_vent'])).toBe(true);
  });

  it('returns false when any footprint tile is wrong terrain', () => {
    const w = mkWorld([
      [0, 0, 'hydrothermal_vent'], [1, 0, 'hydrothermal_vent'],
      [0, 1, 'hydrothermal_vent'], [1, 1, 'deep'],
    ]);
    expect(footprintMatches(w, 0, 0, 2, 2, ['hydrothermal_vent'])).toBe(false);
  });

  it('accepts an OR list of terrains', () => {
    const w = mkWorld([
      [0, 0, 'shallows'], [1, 0, 'deep'],
      [0, 1, 'shallows'], [1, 1, 'shallows'],
    ]);
    expect(footprintMatches(w, 0, 0, 2, 2, ['shallows', 'deep'])).toBe(true);
  });
});
