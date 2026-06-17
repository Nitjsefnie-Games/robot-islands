/* eslint-disable no-console */
// Throwaway: load the captured flicker fixture and run ONE economy advance,
// dumping which resource(s) trigger the near-zero (clamped tMs+1) cap events.
import { readFileSync } from 'node:fs';
import { deserializeWorld, type SaveSnapshot } from '../src/persistence.js';
import { advanceWorldEconomy } from '../src/economy-advance.js';

const snap = JSON.parse(readFileSync('/tmp/flicker-save.json', 'utf8')) as SaveSnapshot;
const now = snap.savedAt + 18_000; // ~the gap we captured
const { world, islandStates } = deserializeWorld(snap, now, now);
world.islandStates = islandStates;
const t0 = process.hrtime.bigint();
advanceWorldEconomy(world, islandStates, now, now);
console.log(`econ=${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)}ms`);
console.log('segments/island:', JSON.stringify((globalThis as { __segs?: unknown }).__segs ?? {}));
console.log('flickering cap-events (home):', JSON.stringify((globalThis as { __cap?: unknown }).__cap ?? [], null, 1));

// Home inventory vs caps for the flagged resources — print home state summary.
const home = islandStates.get('home');
if (home) {
  console.log('home level=', home.level, 'buildings=', home.buildings.length);
}
