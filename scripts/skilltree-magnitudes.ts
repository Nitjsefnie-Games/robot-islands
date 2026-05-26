/* eslint-disable no-console */
// scripts/skilltree-magnitudes.ts — dev script. Computes per-effect-kind
// product of (1 + magnitude) across the live catalog and prints a table.
// Run: npx tsx scripts/skilltree-magnitudes.ts

import { FULL_CATALOG } from '../src/skilltree-catalog.js';
export { POOL_TARGETS } from '../src/skilltree-derive-magnitudes.js';
import { effectKey, POOL_TARGETS } from '../src/skilltree-derive-magnitudes.js';

export function computeProducts(): Map<string, number> {
  const products = new Map<string, number>();
  for (const n of FULL_CATALOG) {
    if (!('magnitude' in n)) continue;
    const key = effectKey(n.effect);
    if (!(key in POOL_TARGETS)) continue;
    products.set(key, (products.get(key) ?? 1) * (1 + n.magnitude));
  }
  return products;
}

// CLI entry — pretty-print the table.
if (import.meta.url === `file://${process.argv[1]}`) {
  const products = computeProducts();
  const rows: Array<[string, number, number, number]> = [];
  for (const [k, target] of Object.entries(POOL_TARGETS)) {
    const actual = products.get(k) ?? 0;
    const ratio = target === 0 ? 0 : actual / target;
    rows.push([k, target, actual, ratio]);
  }
  console.log('effect-kind                                target    actual    ratio');
  console.log('-'.repeat(78));
  for (const [k, t, a, r] of rows.sort((x, y) => Math.abs(1 - y[3]) - Math.abs(1 - x[3]))) {
    console.log(k.padEnd(42), t.toFixed(3).padStart(8), a.toFixed(3).padStart(8), r.toFixed(4).padStart(8));
  }
}
