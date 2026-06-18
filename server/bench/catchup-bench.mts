// Read-only benchmark + characterization harness for the catch-up path.
// Loads the REAL robot_islands save (SELECT only — never writes), runs
// catchUp() over a controlled offline gap, prints timing, and emits a
// deterministic digest of the resulting world as the behavior oracle.
//
// Usage:  DATABASE_URL=postgresql:///robot_islands npx tsx bench/catchup-bench.mts [gapMinutes] [reps]
import pg from 'pg';
import { loadSnapshot } from '../src/game/persistence.js';
import { catchUp } from '../src/game/runtime.js';
import { serializeWorld } from '../../src/persistence.js';
import { createHash } from 'node:crypto';

const URL = process.env.DATABASE_URL ?? 'postgresql:///robot_islands';
const gapMin = Number(process.argv[2] ?? '8');
const reps = Number(process.argv[3] ?? '5');
const USER = process.env.BENCH_USER ?? 'aee50add-e972-4b6b-9710-9325ff6a2711';

function digest(world: unknown, states: unknown): string {
  // Deterministic structural digest of the advanced world. catchUp is
  // deterministic for a fixed `now`, so this must be byte-identical across
  // any behavior-preserving optimization.
  const ser = serializeWorld(world as any, states as any, NOW, NOW);
  return createHash('sha256').update(JSON.stringify(ser)).digest('hex');
}

import { readFileSync, writeFileSync } from 'node:fs';
const SNAP_FILE = process.env.BENCH_SNAPSHOT_FILE;
let snapshot: Awaited<ReturnType<typeof loadSnapshot>>;
if (SNAP_FILE && process.env.BENCH_DUMP !== '1') {
  snapshot = JSON.parse(readFileSync(SNAP_FILE, 'utf8'));
} else {
  const pool = new pg.Pool({ connectionString: URL });
  snapshot = await loadSnapshot(pool, USER);
  await pool.end();
  if (SNAP_FILE && process.env.BENCH_DUMP === '1') { writeFileSync(SNAP_FILE, JSON.stringify(snapshot)); console.log('dumped snapshot to', SNAP_FILE); }
}
if (!snapshot) { console.error('no snapshot for', USER); process.exit(1); }

const NOW = snapshot.savedAt + gapMin * 60_000;
console.log(`save: v${snapshot.v}  savedAt=${snapshot.savedAt}  islands=${snapshot.islandStates.length}  routes=${(snapshot.world as any).routes?.length}`);
console.log(`gap=${gapMin}min  now=${NOW}  reps=${reps}`);

// Warm up (also pins the oracle digest).
const warm = catchUp(structuredClone(snapshot), NOW);
const oracle = digest(warm!.world, warm!.islandStates);
console.log('ORACLE digest:', oracle);

const times: number[] = [];
for (let i = 0; i < reps; i++) {
  // Fresh clone each rep so deserialize/advance starts from identical input.
  const snap = structuredClone(snapshot);
  const t0 = performance.now();
  const g = catchUp(snap, NOW);
  const dt = performance.now() - t0;
  const d = digest(g!.world, g!.islandStates);
  if (d !== oracle) { console.error(`!! DIGEST MISMATCH rep ${i}: ${d}`); process.exit(2); }
  times.push(dt);
}
times.sort((a, b) => a - b);
const med = times[Math.floor(times.length / 2)]!;
const min = times[0]!;
const max = times[times.length - 1]!;
console.log(`catchUp ms  min=${min.toFixed(1)}  median=${med.toFixed(1)}  max=${max.toFixed(1)}  (all: ${times.map((t) => t.toFixed(0)).join(',')})`);
