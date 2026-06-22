// Per-function microbenchmarks for the catch-up hotspots, run against REAL save
// inputs (deserialized once from the frozen snapshot). The full catchUp bench is
// the end-to-end metric + oracle; this gives the per-FUNCTION signal you need
// while iterating on one hot function — isolated from JIT warmup of unrelated
// code, the 480-step loop, and cross-phase GC. Report is min-of-rounds ns/op
// (min is robust to scheduler/GC jitter — noise only ever inflates a round).
//
// Usage: BENCH_SNAPSHOT_FILE=<f> npx tsx bench/microbench.mts [nameSubstr]
//   Runs all registered benches, or only those whose name contains nameSubstr.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { loadSnapshot } from '../src/game/persistence.js';
import { deserializeWorld } from '../../src/persistence.js';
import { islandsOverlap } from '../../src/world.js';
import { findNextMerge } from '../../src/island-merge.js';
import { computeRates } from '../../src/economy.js';

const URL = process.env.DATABASE_URL ?? 'postgresql:///robot_islands';
const USER = process.env.BENCH_USER ?? 'aee50add-e972-4b6b-9710-9325ff6a2711';
const SNAP_FILE = process.env.BENCH_SNAPSHOT_FILE;
const only = process.argv[2];

let snapshot: Awaited<ReturnType<typeof loadSnapshot>>;
if (SNAP_FILE) {
  snapshot = JSON.parse(readFileSync(SNAP_FILE, 'utf8'));
} else {
  const pool = new pg.Pool({ connectionString: URL });
  snapshot = await loadSnapshot(pool, USER);
  await pool.end();
}
if (!snapshot) { console.error('no snapshot'); process.exit(1); }
const NOW = snapshot.savedAt + 8 * 60_000;
const { world, islandStates } = deserializeWorld(structuredClone(snapshot), NOW, NOW, {});
world.islandStates = islandStates;
const populated = world.islands.filter((s) => s.populated);
const pairs = (populated.length * (populated.length - 1)) / 2;

/** A bench = a closure doing ONE unit of work, plus how many such units the
 *  reported ns is divided by (so we can report per-pair as well as per-scan). */
interface Bench { name: string; unitsPerCall: number; run: () => unknown; }
const benches: Bench[] = [
  {
    name: 'islandsOverlap:all-pairs-scan',
    unitsPerCall: pairs, // ns is reported per pair-check too
    run: () => {
      let n = 0;
      for (let i = 0; i < populated.length; i++)
        for (let j = i + 1; j < populated.length; j++)
          if (islandsOverlap(populated[i]!, populated[j]!)) n++;
      return n;
    },
  },
  {
    name: 'findNextMerge',
    unitsPerCall: 1,
    run: () => findNextMerge(world, islandStates),
  },
  ...(() => {
    // computeRates is non-mutating, so it loops cleanly on a real island state.
    // ctx-less path: exercises the 4-pass + flow-solve structure (the 25%
    // self-time hotspot) without reconstructing the full RatesContext — a
    // per-function signal, with the e2e economy phase as the representative check.
    const big = [...islandStates.values()].sort((a, b) => b.buildings.length - a.buildings.length)[0];
    return big
      ? [{ name: 'computeRates:biggest-island', unitsPerCall: 1, run: () => computeRates(big) }]
      : [];
  })(),
];

function time(b: Bench): { nsPerCall: number; nsPerUnit: number } {
  // Auto-size K so a round is ~80ms; warm up first.
  for (let i = 0; i < 50; i++) b.run();
  let K = 1;
  while (true) {
    const t = performance.now();
    for (let i = 0; i < K; i++) b.run();
    if (performance.now() - t >= 40) break;
    K *= 2;
  }
  const rounds: number[] = [];
  for (let r = 0; r < 8; r++) {
    const t = performance.now();
    for (let i = 0; i < K; i++) b.run();
    rounds.push((performance.now() - t) / K); // ms per call
  }
  rounds.sort((a, b) => a - b);
  const msPerCall = rounds[0]!; // min round
  return { nsPerCall: msPerCall * 1e6, nsPerUnit: (msPerCall * 1e6) / b.unitsPerCall };
}

console.log(`save: islands=${world.islands.length} populated=${populated.length} pairs=${pairs}`);
for (const b of benches) {
  if (only && !b.name.includes(only)) continue;
  const { nsPerCall, nsPerUnit } = time(b);
  const per = b.unitsPerCall > 1 ? `  (${nsPerUnit.toFixed(0)} ns/unit ×${b.unitsPerCall})` : '';
  console.log(`${b.name.padEnd(34)} ${(nsPerCall / 1000).toFixed(2).padStart(10)} us/call${per}`);
}
