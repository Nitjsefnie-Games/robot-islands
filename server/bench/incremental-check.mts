// Verify the OPTIMIZATION's core invariant: advancing a hot in-memory world in
// 1-second slices (cp -> T1 -> T2 -> ... -> T) produces a BYTE-IDENTICAL world
// to a single one-shot catchUp(cp, T). If this holds, the per-second projection
// can keep the world hot and step it incrementally instead of re-deserializing +
// re-integrating from the checkpoint every second.
//
// Gate: SHA-256 of the serialized advanced world must match between the two paths.
// Run from server/: BENCH_SNAPSHOT_FILE=/tmp/ri_bench_snapshot.json npx tsx bench/incremental-check.mts [windowSec]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deserializeWorld, serializeWorld } from '../../src/persistence.js';
import { advanceWorldEconomy } from '../../src/economy-advance.js';
import { advanceWorldSystems } from '../../src/world-systems-advance.js';

const snap = JSON.parse(readFileSync(process.env.BENCH_SNAPSHOT_FILE!, 'utf8'));
const base: number = snap.savedAt;
const windowSec = Number(process.argv[2] ?? '30');
const T = base + windowSec * 1000;

const digest = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex');

// --- Path A: one-shot, exactly as runtime.catchUp does it ---
function oneShot() {
  const { world, islandStates } = deserializeWorld(snap, T, T, { decayClosedGameActiveBonus: false });
  world.islandStates = islandStates;
  advanceWorldEconomy(world, islandStates, T, T);
  advanceWorldSystems(world, islandStates, base, T, 0);
  return serializeWorld(world, islandStates, T, T);
}

// --- Path B: keep the world hot, step it 1s at a time ---
function incremental() {
  // Initial deserialize ONCE at `base` (the moment the socket connected / last
  // checkpoint). Subsequent ticks advance the SAME in-memory objects.
  const { world, islandStates } = deserializeWorld(snap, base, base, { decayClosedGameActiveBonus: false });
  world.islandStates = islandStates;
  let prev = base;
  for (let t = base + 1000; t <= T; t += 1000) {
    advanceWorldEconomy(world, islandStates, t, t);
    advanceWorldSystems(world, islandStates, prev, t, 0);
    prev = t;
  }
  return serializeWorld(world, islandStates, T, T);
}

const a = oneShot();
const b = incremental();
const da = digest(a), db = digest(b);
console.log(`window=${windowSec}s  ${da === db ? 'MATCH' : 'MISMATCH'}`);

// Quantify the divergence: walk both serialized trees in parallel, collect the
// max absolute and max RELATIVE difference over every numeric leaf, plus the
// worst offenders by relative error and any non-numeric mismatch.
let maxAbs = 0, maxRel = 0, worst = '', nonNumeric = 0, numLeaves = 0, diffLeaves = 0;
const worstList: Array<{ path: string; x: number; y: number; rel: number }> = [];
function walk(x: unknown, y: unknown, path: string) {
  if (typeof x === 'number' && typeof y === 'number') {
    numLeaves++;
    if (x !== y) {
      diffLeaves++;
      const abs = Math.abs(x - y);
      const rel = abs / (Math.max(Math.abs(x), Math.abs(y)) || 1);
      if (abs > maxAbs) maxAbs = abs;
      if (rel > maxRel) { maxRel = rel; worst = `${path} ${x} vs ${y}`; }
      worstList.push({ path, x, y, rel });
    }
    return;
  }
  if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') {
    if (JSON.stringify(x) !== JSON.stringify(y)) { nonNumeric++; if (nonNumeric <= 8) console.log(`  non-numeric diff @ ${path}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`); }
    return;
  }
  const ax = x as Record<string, unknown>, ay = y as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ax), ...Object.keys(ay)])) walk(ax[k], ay[k], `${path}.${k}`);
}
walk(a, b, '');
console.log(`numeric leaves: ${numLeaves}, differing: ${diffLeaves}, non-numeric mismatches: ${nonNumeric}`);
console.log(`max ABS diff = ${maxAbs.toExponential(3)}   max REL diff = ${maxRel.toExponential(3)}`);
console.log(`worst rel: ${worst}`);
worstList.sort((p, q) => q.rel - p.rel);
for (const w of worstList.slice(0, 6)) console.log(`  rel=${w.rel.toExponential(2)}  ${w.path}  ${w.x} vs ${w.y}`);
if (da !== db) process.exitCode = 1;
