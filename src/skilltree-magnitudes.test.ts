import { describe, it, expect } from 'vitest';
import { POOL_TARGETS, computeProducts } from '../scripts/skilltree-magnitudes.js';

describe('skill-tree magnitude invariants (spec §03 cap-per-pool)', () => {
  const products = computeProducts();
  const TOLERANCE = 0.005; // ±0.5%

  for (const [key, target] of Object.entries(POOL_TARGETS)) {
    it(`product across all ${key} nodes ≈ ${target.toFixed(3)}`, () => {
      const actual = products.get(key);
      expect(actual, `no catalog nodes found for ${key}`).toBeDefined();
      const ratio = actual! / target;
      expect(ratio).toBeGreaterThanOrEqual(1 - TOLERANCE);
      expect(ratio).toBeLessThanOrEqual(1 + TOLERANCE);
    });
  }
});
