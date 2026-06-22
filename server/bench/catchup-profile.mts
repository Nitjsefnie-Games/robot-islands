// In-process CPU profiler for the catch-up calc. Unlike `node --cpu-prof`
// (which, under the tsx ESM loader, attributes almost everything to module
// resolution in a worker thread), this starts a node:inspector CPU profiler
// around ONLY the warmed, timed catchUp reps — so the .cpuprofile contains the
// real compute frames (deserializeWorld / advanceWorldEconomy / computeRates /
// world-systems) with their actual names. Read-only against the save.
//
// Usage: DATABASE_URL=... npx tsx bench/catchup-profile.mts [gapMin] [reps]
//   BENCH_SNAPSHOT_FILE=<file> caches the snapshot (DB-independent reps).
//   Writes the profile to BENCH_PROFILE_OUT (default /tmp/ri-catchup.cpuprofile).
import pg from 'pg';
import { Session } from 'node:inspector';
import { writeFileSync, readFileSync } from 'node:fs';
import { loadSnapshot } from '../src/game/persistence.js';
import { catchUp } from '../src/game/runtime.js';

const URL = process.env.DATABASE_URL ?? 'postgresql:///robot_islands';
const gapMin = Number(process.argv[2] ?? '8');
const reps = Number(process.argv[3] ?? '6');
const USER = process.env.BENCH_USER ?? 'aee50add-e972-4b6b-9710-9325ff6a2711';
const OUT = process.env.BENCH_PROFILE_OUT ?? '/tmp/ri-catchup.cpuprofile';
const SNAP_FILE = process.env.BENCH_SNAPSHOT_FILE;

let snapshot: Awaited<ReturnType<typeof loadSnapshot>>;
if (SNAP_FILE) {
  snapshot = JSON.parse(readFileSync(SNAP_FILE, 'utf8'));
} else {
  const pool = new pg.Pool({ connectionString: URL });
  snapshot = await loadSnapshot(pool, USER);
  await pool.end();
}
if (!snapshot) { console.error('no snapshot for', USER); process.exit(1); }
const NOW = snapshot.savedAt + gapMin * 60_000;

// Warm up so JIT has settled before we profile (we want steady-state frames).
for (let i = 0; i < 3; i++) catchUp(structuredClone(snapshot), NOW);

const session = new Session();
session.connect();
const post = (method: string, params?: object): Promise<any> =>
  new Promise((res, rej) => session.post(method, params as never, (e, r) => (e ? rej(e) : res(r))));

await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 100 }); // 100us
await post('Profiler.start');
for (let i = 0; i < reps; i++) catchUp(structuredClone(snapshot), NOW);
const { profile } = await post('Profiler.stop');
session.disconnect();

writeFileSync(OUT, JSON.stringify(profile));
console.log(`profiled ${reps} reps (gap=${gapMin}min) -> ${OUT}`);
