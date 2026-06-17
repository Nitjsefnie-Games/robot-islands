/* eslint-disable no-console */
// Throwaway: dump the projected catch-up snapshot for saveNow at the golden gap
// (savedAt+1h) as canonical JSON, to numerically diff old-vs-new behaviour.
import { readFileSync, writeFileSync } from 'node:fs';
import { deserializeWorld, serializeWorld, type SaveSnapshot } from '../src/persistence.js';
import { advanceWorldEconomy } from '../src/economy-advance.js';
import { advanceWorldSystems } from '../src/world-systems-advance.js';
import { projectSnapshotForClient } from '../server/src/game/projection.js';

const snap = JSON.parse(readFileSync('/tmp/saveNow.json', 'utf8')) as SaveSnapshot;
const now = snap.savedAt + 3_600_000;
const { world, islandStates } = deserializeWorld(snap, now, now);
world.islandStates = islandStates;
advanceWorldEconomy(world, islandStates, now, now);
advanceWorldSystems(world, islandStates, snap.savedAt, now, 0);
const projected = projectSnapshotForClient(serializeWorld(world, islandStates, now, now));
writeFileSync(process.argv[2]!, JSON.stringify(projected));
console.log('wrote', process.argv[2]);
