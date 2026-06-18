// Phase-attribution for catchUp: times deserialize / economy / world-systems
// separately over a controlled gap. Read-only against the real save.
import pg from 'pg';
import { loadSnapshot } from '../src/game/persistence.js';
import { deserializeWorld } from '../../src/persistence.js';
import { advanceWorldEconomy } from '../../src/economy-advance.js';
import { advanceWorldSystems } from '../../src/world-systems-advance.js';

const URL = process.env.DATABASE_URL ?? 'postgresql:///robot_islands';
const gapMin = Number(process.argv[2] ?? '20');
const USER = process.env.BENCH_USER ?? 'aee50add-e972-4b6b-9710-9325ff6a2711';

const pool = new pg.Pool({ connectionString: URL });
const snapshot = await loadSnapshot(pool, USER);
if (!snapshot) { console.error('no snapshot'); process.exit(1); }
await pool.end();
const NOW = snapshot.savedAt + gapMin * 60_000;
console.log(`islands=${snapshot.islandStates.length} routes=${(snapshot.world as any).routes?.length} gap=${gapMin}min`);

for (let rep = 0; rep < 3; rep++) {
  const snap = structuredClone(snapshot);
  let t = performance.now();
  const { world, islandStates } = deserializeWorld(snap, NOW, NOW, {});
  const tDes = performance.now() - t;
  world.islandStates = islandStates;
  t = performance.now();
  advanceWorldEconomy(world, islandStates, NOW, NOW);
  const tEco = performance.now() - t;
  t = performance.now();
  const r = advanceWorldSystems(world, islandStates, snap.savedAt, NOW, 0);
  const tSys = performance.now() - t;
  console.log(`rep${rep}: deserialize=${tDes.toFixed(0)}ms economy=${tEco.toFixed(0)}ms worldSystems=${tSys.toFixed(0)}ms (steps=${r.steps})`);
}
