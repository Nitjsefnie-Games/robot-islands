import { describe, it, expect } from 'vitest';
import {
  terrainAt,
  footprintMatches,
  shouldRenderFeatureGlyph,
  clusterAnchorOf,
  type OceanCellSpec,
} from './ocean-cell.js';

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

  it('§5 masks an un-depth-revealed rare feature so it does NOT satisfy a feature terrainReq', () => {
    const w = mkWorld([[2, 3, 'hydrothermal_vent']]);
    const depthRevealed = new Set<string>(); // cell NOT revealed
    expect(footprintMatches(w, 2, 3, 1, 1, ['hydrothermal_vent'], depthRevealed)).toBe(false);
  });

  it('§5 uses true terrain when the rare feature IS depth-revealed', () => {
    const w = mkWorld([[2, 3, 'hydrothermal_vent']]);
    const depthRevealed = new Set<string>(['2,3']);
    expect(footprintMatches(w, 2, 3, 1, 1, ['hydrothermal_vent'], depthRevealed)).toBe(true);
  });

  it('§5 server path omits depthRevealedCells and matches true terrain unchanged', () => {
    const w = mkWorld([[2, 3, 'hydrothermal_vent']]);
    expect(footprintMatches(w, 2, 3, 1, 1, ['hydrothermal_vent'])).toBe(true);
  });

  it('§5 hidden rare feature still matches a bulk terrainReq (treated as deep base)', () => {
    const w = mkWorld([[2, 3, 'hydrothermal_vent']]);
    const depthRevealed = new Set<string>();
    expect(footprintMatches(w, 2, 3, 1, 1, ['shallows', 'deep'], depthRevealed)).toBe(true);
  });

  it('§5 hidden rare feature does not satisfy a shallows-only requirement', () => {
    const w = mkWorld([[2, 3, 'hydrothermal_vent']]);
    const depthRevealed = new Set<string>();
    expect(footprintMatches(w, 2, 3, 1, 1, ['shallows'], depthRevealed)).toBe(false);
  });
});

describe('§6 shouldRenderFeatureGlyph', () => {
  it('returns true when revealed + depth-revealed + terrain is rare', () => {
    const w = mkWorld([[3, 4, 'hydrothermal_vent']]);
    const revealed = new Set<string>(['3,4']);
    const depth = new Set<string>(['3,4']);
    expect(shouldRenderFeatureGlyph('3,4', revealed, depth, w.oceanCells)).toBe(true);
  });

  it('returns false when terrain is bulk (shallows / deep) even with both flags set', () => {
    const w = mkWorld([[3, 4, 'shallows']]);
    const revealed = new Set<string>(['3,4']);
    const depth = new Set<string>(['3,4']);
    expect(shouldRenderFeatureGlyph('3,4', revealed, depth, w.oceanCells)).toBe(false);
    const w2 = mkWorld([[3, 4, 'deep']]);
    expect(shouldRenderFeatureGlyph('3,4', revealed, depth, w2.oceanCells)).toBe(false);
  });

  it('returns false when surface revealed but not depth (hidden depth feature)', () => {
    const w = mkWorld([[3, 4, 'nodule_field']]);
    const revealed = new Set<string>(['3,4']);
    const depth = new Set<string>();
    expect(shouldRenderFeatureGlyph('3,4', revealed, depth, w.oceanCells)).toBe(false);
  });

  it('returns false when neither revealed (total fog)', () => {
    const w = mkWorld([[3, 4, 'trench']]);
    const revealed = new Set<string>();
    const depth = new Set<string>();
    expect(shouldRenderFeatureGlyph('3,4', revealed, depth, w.oceanCells)).toBe(false);
  });

  it('returns false when cell not in oceanCells (implicit deep default)', () => {
    const w = mkWorld([]);
    const revealed = new Set<string>(['3,4']);
    const depth = new Set<string>(['3,4']);
    // Unmapped cells default to 'deep' (bulk) — even with both flags set,
    // they must not render a glyph (no rare-feature backing).
    expect(shouldRenderFeatureGlyph('3,4', revealed, depth, w.oceanCells)).toBe(false);
  });

  it('handles all three rare terrains symmetrically', () => {
    const revealed = new Set<string>(['0,0']);
    const depth = new Set<string>(['0,0']);
    for (const t of ['hydrothermal_vent', 'nodule_field', 'trench'] as const) {
      const w = mkWorld([[0, 0, t]]);
      expect(shouldRenderFeatureGlyph('0,0', revealed, depth, w.oceanCells)).toBe(true);
    }
  });
});

describe('§6 clusterAnchorOf', () => {
  it('returns the top-left (min Y then min X) cell of a 3×3 nodule cluster', () => {
    const cells: Array<[number, number, OceanCellSpec['terrain']]> = [];
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        cells.push([5 + dx, 7 + dy, 'nodule_field']);
      }
    }
    const w = mkWorld(cells);
    // Pick any cluster cell — they should all resolve to the top-left.
    expect(clusterAnchorOf(w, '6,8')).toBe('5,7');
    expect(clusterAnchorOf(w, '7,9')).toBe('5,7');
    expect(clusterAnchorOf(w, '5,7')).toBe('5,7');
  });

  it('returns the cell itself for a singleton (isolated) feature cell', () => {
    const w = mkWorld([[2, 3, 'hydrothermal_vent']]);
    expect(clusterAnchorOf(w, '2,3')).toBe('2,3');
  });

  it('returns null for a bulk-terrain cell (shallows / deep)', () => {
    const w = mkWorld([[0, 0, 'shallows']]);
    expect(clusterAnchorOf(w, '0,0')).toBe(null);
  });

  it('returns null for an unmapped cell (implicit deep)', () => {
    const w = mkWorld([]);
    expect(clusterAnchorOf(w, '0,0')).toBe(null);
  });

  it('does not merge clusters that share an edge with a different terrain', () => {
    // 2×2 vent block at (0,0)..(1,1), adjacent 2×2 nodule block at (2,0)..(3,1).
    // Cluster of (3,0) should be the nodule block, anchor (2,0) — NOT (0,0).
    const w = mkWorld([
      [0, 0, 'hydrothermal_vent'], [1, 0, 'hydrothermal_vent'],
      [0, 1, 'hydrothermal_vent'], [1, 1, 'hydrothermal_vent'],
      [2, 0, 'nodule_field'], [3, 0, 'nodule_field'],
      [2, 1, 'nodule_field'], [3, 1, 'nodule_field'],
    ]);
    expect(clusterAnchorOf(w, '3,1')).toBe('2,0');
    expect(clusterAnchorOf(w, '0,1')).toBe('0,0');
  });

  it('flood-fills via 4-connectivity (diagonal-only contact is a separate cluster)', () => {
    // Two trench cells touching only at a diagonal — NOT one cluster.
    const w = mkWorld([
      [0, 0, 'trench'],
      [1, 1, 'trench'],
    ]);
    expect(clusterAnchorOf(w, '1,1')).toBe('1,1');
    expect(clusterAnchorOf(w, '0,0')).toBe('0,0');
  });

  it('with membership set, anchors only on depth-revealed cells (#86)', () => {
    // 2×2 vent cluster at (0,0)..(1,1). The true top-left is (0,0), but if
    // only (1,0) and (1,1) are depth-revealed, the glyph anchor must be the
    // top-left of the depth-revealed subset — (1,0) — not the full cluster.
    const w = mkWorld([
      [0, 0, 'hydrothermal_vent'],
      [1, 0, 'hydrothermal_vent'],
      [0, 1, 'hydrothermal_vent'],
      [1, 1, 'hydrothermal_vent'],
    ]);
    const depthRevealed = new Set<string>(['1,0', '1,1']);
    expect(clusterAnchorOf(w, '1,0', depthRevealed)).toBe('1,0');
    expect(clusterAnchorOf(w, '1,1', depthRevealed)).toBe('1,0');
    // Starting from an un-depth-revealed cell returns null.
    expect(clusterAnchorOf(w, '0,0', depthRevealed)).toBe(null);
  });

  it('with membership set, disconnected depth-revealed components get separate anchors', () => {
    // 3×1 trench: cells (0,0), (1,0), (2,0). Only the ends are depth-revealed.
    const w = mkWorld([
      [0, 0, 'trench'],
      [1, 0, 'trench'],
      [2, 0, 'trench'],
    ]);
    const leftOnly = new Set<string>(['0,0']);
    expect(clusterAnchorOf(w, '0,0', leftOnly)).toBe('0,0');
    const rightOnly = new Set<string>(['2,0']);
    expect(clusterAnchorOf(w, '2,0', rightOnly)).toBe('2,0');
  });
});
