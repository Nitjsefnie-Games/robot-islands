// Measures the per-intent persist cost: serializeWorld (CPU) and saveSnapshot
// (N sequential island INSERTs). Runs inside a BEGIN/ROLLBACK tx so the real
// save is never mutated.
import pg from 'pg';
import { loadSnapshot, saveSnapshot } from '../src/game/persistence.js';
import { catchUp } from '../src/game/runtime.js';
import { serializeWorld } from '../../src/persistence.js';

const URL = process.env.DATABASE_URL ?? 'postgresql:///robot_islands';
const USER = process.env.BENCH_USER ?? 'aee50add-e972-4b6b-9710-9325ff6a2711';
const pool = new pg.Pool({ connectionString: URL });
const snapshot = await loadSnapshot(pool, USER);
if (!snapshot) { console.error('no snapshot'); process.exit(1); }
const NOW = snapshot.savedAt + 60_000;
const game = catchUp(snapshot, NOW)!;
console.log(`islands=${game.world.islands.length} routes=${game.world.routes.length}`);

const client = await pool.connect();
await client.query('BEGIN');
try {
  for (let rep = 0; rep < 5; rep++) {
    let t = performance.now();
    const ser = serializeWorld(game.world, game.islandStates, NOW, NOW);
    const tSer = performance.now() - t;
    const serBytes = JSON.stringify(ser.world).length + ser.islandStates.reduce((a, e) => a + JSON.stringify(e.state).length, 0);
    t = performance.now();
    await saveSnapshot(client, USER, ser);
    const tSave = performance.now() - t;
    console.log(`rep${rep}: serializeWorld=${tSer.toFixed(1)}ms  saveSnapshot(DB)=${tSave.toFixed(1)}ms  (~${(serBytes/1024).toFixed(0)}KB)`);
  }
} finally {
  await client.query('ROLLBACK'); // never mutate the real save
  client.release();
  await pool.end();
}
