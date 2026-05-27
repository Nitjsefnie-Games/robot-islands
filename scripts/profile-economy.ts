/* eslint-disable no-console */
// scripts/profile-economy.ts — load a live IDB save dump and benchmark
// advanceIsland() across representative tick deltas. Captures both wall-clock
// timings and (if NODE_OPTIONS includes --cpu-prof) a V8 CPU profile.
//
// Usage:
//   npx tsx scripts/profile-economy.ts /tmp/robot-islands-save.json
//   NODE_OPTIONS="--cpu-prof --cpu-prof-dir=/tmp --cpu-prof-name=ri.cpuprofile" \
//     npx tsx scripts/profile-economy.ts /tmp/robot-islands-save.json
//
// The save file is a JSON-serialised SaveSnapshot (v14+) as dumped from
// idb-keyval at runtime.

import { readFileSync } from 'node:fs';

import { advanceIsland, type IslandState } from '../src/economy.js';
import { deserializeWorld, type SaveSnapshot } from '../src/persistence.js';

// `performance` is a global in Node 18+ but `Date.now()` works as a fallback
// for the deserializer's wall-clock arg.
const nowWall = Date.now();
const nowPerf = performance.now();

function loadSave(path: string): { world: ReturnType<typeof deserializeWorld>['world']; islandStates: Map<string, IslandState> } {
  const raw = readFileSync(path, 'utf8');
  const snapshot = JSON.parse(raw) as SaveSnapshot;
  return deserializeWorld(snapshot, nowWall, nowPerf);
}

interface Bench {
  readonly label: string;
  readonly deltaMs: number;
  readonly samples: number;
}

const BENCHES: Bench[] = [
  { label: '16ms (1 frame)',  deltaMs: 16,             samples: 2000 },
  { label: '100ms',           deltaMs: 100,            samples: 2000 },
  { label: '1s',              deltaMs: 1_000,          samples: 500 },
  { label: '1min',            deltaMs: 60_000,         samples: 200 },
  { label: '1h',              deltaMs: 3_600_000,      samples: 50 },
  { label: '24h (catchup)',   deltaMs: 86_400_000,     samples: 10 },
];

function hrnow(): bigint {
  return process.hrtime.bigint();
}

function fmtNs(ns: bigint): string {
  const us = Number(ns) / 1000;
  if (us < 1000) return `${us.toFixed(1)}us`;
  const ms = us / 1000;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function pct(p: number, ns: bigint[]): string {
  if (!ns.length) return '—';
  const sorted = [...ns].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return fmtNs(sorted[idx]!);
}

function statSummary(ns: bigint[]): string {
  if (!ns.length) return 'no samples';
  let total = 0n;
  for (const n of ns) total += n;
  const meanNs = total / BigInt(ns.length);
  return `n=${ns.length}  mean=${fmtNs(meanNs)}  p50=${pct(0.5, ns)}  p90=${pct(0.9, ns)}  p99=${pct(0.99, ns)}  max=${pct(1, ns)}`;
}

function snapshotState(state: IslandState): IslandState {
  // Deep clone the inventory + storageCaps so each benchmark iteration starts
  // from the same baseline state. Buildings/etc. are shared (advanceIsland
  // mutates `lastTick` + a handful of building fields like operatingMs; that's
  // unavoidable for a faithful tick simulation but the cost is symmetric).
  return {
    ...state,
    inventory: { ...state.inventory },
    storageCaps: { ...state.storageCaps },
    unlockedNodes: new Set(state.unlockedNodes),
    unlockedEdges: new Set(state.unlockedEdges),
    socketBindings: new Map(state.socketBindings),
  };
}

function runBench(
  states: ReadonlyArray<IslandState>,
  bench: Bench,
): void {
  // Per-island timings — sum across islands per "sample" for a representative
  // total-tick figure since the main loop calls advanceIsland for every state.
  const sampleTotals: bigint[] = [];
  const perIslandTotals = new Map<string, bigint[]>();
  for (const s of states) perIslandTotals.set(s.id, []);

  for (let i = 0; i < bench.samples; i++) {
    // Restart from the deserialized baseline each sample so the state shape
    // is constant. We still mutate the SAME state object across samples (the
    // simulator advances time forward); to keep timings comparable, reset
    // lastTick each sample.
    const baselineNow = nowPerf;
    let sampleTotalNs = 0n;
    for (const state of states) {
      // Restart this island's clock.
      state.lastTick = baselineNow;
      const targetNow = baselineNow + bench.deltaMs;
      const t0 = hrnow();
      advanceIsland(state, targetNow);
      const t1 = hrnow();
      const dt = t1 - t0;
      sampleTotalNs += dt;
      perIslandTotals.get(state.id)!.push(dt);
    }
    sampleTotals.push(sampleTotalNs);
  }

  console.log(`\n[${bench.label}]  ${statSummary(sampleTotals)}  (total per main-loop call)`);
  for (const state of states) {
    const arr = perIslandTotals.get(state.id)!;
    console.log(`  • ${state.id.padEnd(20)} ${statSummary(arr)}`);
  }
}

function main(): void {
  const path = process.argv[2] ?? '/tmp/robot-islands-save.json';
  console.log(`Loading ${path}...`);
  const t0 = hrnow();
  const { world, islandStates } = loadSave(path);
  const t1 = hrnow();
  console.log(`  deserializeWorld: ${fmtNs(t1 - t0)}`);
  console.log(`  islands: ${world.islands.length}  states: ${islandStates.size}`);

  // Only benchmark POPULATED islands — un-populated ones never tick.
  const populatedStates: IslandState[] = [];
  for (const island of world.islands) {
    if (!island.populated) continue;
    const state = islandStates.get(island.id);
    if (state) populatedStates.push(snapshotState(state));
  }
  console.log(`  populated: ${populatedStates.length}`);
  for (const s of populatedStates) {
    const bldCount = s.buildings.length;
    const invCount = Object.keys(s.inventory).length;
    console.log(`    - ${s.id.padEnd(20)} L${s.level}  buildings=${bldCount}  invKeys=${invCount}`);
  }

  // Warmup — 50 iterations of a small tick to JIT the hot paths.
  console.log(`\nWarmup (50 × 100ms ticks)...`);
  for (let i = 0; i < 50; i++) {
    for (const state of populatedStates) {
      state.lastTick = nowPerf;
      advanceIsland(state, nowPerf + 100);
    }
  }

  // Run each bench.
  for (const bench of BENCHES) {
    runBench(populatedStates, bench);
  }

  console.log(`\nDone. Total wall time: ${fmtNs(hrnow() - t1)}`);
}

main();
