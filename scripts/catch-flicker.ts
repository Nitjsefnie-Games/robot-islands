/* eslint-disable no-console */
// Throwaway: poll the prod save until `home`'s economy advance flickers (hits
// the 10k-segment grind), then dump the exact snapshot as a deterministic
// fixture for a failing test + root-cause analysis.
import { Pool } from 'pg';
import { writeFileSync } from 'node:fs';
import { loadSnapshot } from '../server/src/game/persistence.js';
import { deserializeWorld } from '../src/persistence.js';
import { advanceWorldEconomy } from '../src/economy-advance.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const userId = process.argv[2]!;
const THRESH_MS = 1500;
const MAX_ITERS = 150;
for (let i = 0; i < MAX_ITERS; i++) {
  const snap = await loadSnapshot(pool, userId);
  if (!snap) { console.log('no save'); break; }
  const now = Date.now();
  const { world, islandStates } = deserializeWorld(snap, now, now);
  world.islandStates = islandStates;
  const t0 = process.hrtime.bigint();
  advanceWorldEconomy(world, islandStates, now, now);
  const econMs = Number(process.hrtime.bigint() - t0) / 1e6;
  if (econMs > THRESH_MS) {
    writeFileSync('/tmp/flicker-save.json', JSON.stringify(snap));
    console.log(`CAUGHT flicker at iter ${i}: econ=${econMs.toFixed(0)}ms gap=${((now - snap.savedAt) / 1000).toFixed(0)}s savedAt=${snap.savedAt}. Dumped /tmp/flicker-save.json`);
    await pool.end();
    process.exit(0);
  }
  console.log(`iter ${i}: econ=${econMs.toFixed(0)}ms (no flicker)`);
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('did NOT catch flicker in window');
await pool.end();
