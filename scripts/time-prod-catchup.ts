/* eslint-disable no-console */
// Throwaway diagnostic: time the READ-ONLY catchUp for the prod save in
// isolation (no event-loop contention), with a per-phase breakdown, to see why
// /api/game/state takes seconds for a tiny offline gap.
import { Pool } from 'pg';
import { loadSnapshot } from '../server/src/game/persistence.js';
import { deserializeWorld, serializeWorld } from '../src/persistence.js';
import { advanceWorldEconomy } from '../src/economy-advance.js';
import { advanceWorldSystems } from '../src/world-systems-advance.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const userId = process.argv[2]!;
const snap = await loadSnapshot(pool, userId);
if (!snap) { console.log('no save'); process.exit(1); }
const now0 = Date.now();
console.log(`save v=${snap.v} savedAt=${snap.savedAt} gap=${((now0 - snap.savedAt) / 1000).toFixed(1)}s islands=${snap.world.islands.length} oceanCells=${(snap.world.oceanCells ?? []).length} drones=${(snap.world.drones ?? []).length} routes=${(snap.world.routes ?? []).length}`);

function hr() { return process.hrtime.bigint(); }
function ms(a: bigint, b: bigint) { return Number(b - a) / 1e6; }

for (let i = 0; i < 3; i++) {
  const now = Date.now();
  const t0 = hr();
  const { world, islandStates } = deserializeWorld(snap, now, now);
  const t1 = hr();
  world.islandStates = islandStates;
  advanceWorldEconomy(world, islandStates, now, now);
  const t2 = hr();
  advanceWorldSystems(world, islandStates, snap.savedAt, now, 0);
  const t3 = hr();
  serializeWorld(world, islandStates, now, now);
  const t4 = hr();
  console.log(`iter ${i}: total=${ms(t0, t4).toFixed(1)}ms  deser=${ms(t0, t1).toFixed(1)}  econ=${ms(t1, t2).toFixed(1)}  systems=${ms(t2, t3).toFixed(1)}  ser=${ms(t3, t4).toFixed(1)}`);
  const g = globalThis as { __segs?: Record<string, number>; __dt?: unknown[] };
  console.log('   segments/island:', JSON.stringify(g.__segs ?? {}));
  if (i === 0) console.log('   home first segments:', JSON.stringify(g.__dt ?? []));
  g.__segs = {}; g.__dt = [];
}
await pool.end();
