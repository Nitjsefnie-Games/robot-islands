// Times the per-second WS push components: serializeWorld + computeSnapshotDelta.
import pg from 'pg';
import { loadSnapshot } from '../src/game/persistence.js';
import { catchUp } from '../src/game/runtime.js';
import { serializeWorld } from '../../src/persistence.js';
import { computeSnapshotDelta, applySnapshotDelta } from '../../src/snapshot-delta.js';
import { createHash } from 'node:crypto';

const URL = process.env.DATABASE_URL ?? 'postgresql:///robot_islands';
const USER = process.env.BENCH_USER ?? 'aee50add-e972-4b6b-9710-9325ff6a2711';
const pool = new pg.Pool({ connectionString: URL });
const snap = await loadSnapshot(pool, USER);
await pool.end();
if (!snap) { console.error('no snapshot'); process.exit(1); }
const t0 = snap.savedAt;
console.log(`islands=${snap.islandStates.length} routes=${(snap.world as any).routes?.length}`);

for (let rep = 0; rep < 5; rep++) {
  // two consecutive 1s-apart projections (prev, next), like back-to-back pushes
  const gA = catchUp(structuredClone(snap), t0 + 1000)!;
  const gB = catchUp(structuredClone(snap), t0 + 2000)!;
  let t = performance.now();
  const prev = serializeWorld(gA.world, gA.islandStates, t0 + 1000, t0 + 1000);
  const next = serializeWorld(gB.world, gB.islandStates, t0 + 2000, t0 + 2000);
  const tSer = performance.now() - t;
  t = performance.now();
  const { delta } = computeSnapshotDelta(prev, next);
  const tDelta = performance.now() - t;
  const deltaJson = JSON.stringify(delta);
  // CORRECTNESS GATE: delta must reconstruct `next` from `prev` exactly.
  const rebuilt = applySnapshotDelta(prev, delta);
  const ok = JSON.stringify(rebuilt) === JSON.stringify(next);
  const deltaHash = createHash('sha256').update(deltaJson).digest('hex').slice(0, 16);
  console.log(`rep${rep}: 2×serializeWorld=${tSer.toFixed(1)}ms  computeSnapshotDelta=${tDelta.toFixed(1)}ms  roundtrip=${ok ? 'OK' : 'FAIL'}  deltaHash=${deltaHash}  (~${(deltaJson.length/1024).toFixed(1)}KB)`);
  if (!ok) process.exit(2);
}
