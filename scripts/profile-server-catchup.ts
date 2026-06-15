/* eslint-disable no-console */
// scripts/profile-server-catchup.ts — benchmark the FULL server-side simulation
// compute, the way server/src/game/runtime.ts:catchUp drives it on every
// loadAndCatchUp (per intent) and every periodic state push.
//
// profile-economy.ts only times advanceIsland() per island; it MISSES the
// whole-world orchestration that actually runs on the server: the precompute
// (Network Consciousness, lattice activation + pooling, shared-network,
// cable-network brownout, Mirror-Sat solar) inside advanceWorldEconomy, plus
// advanceWorldSystems (drones, routes, orbital, island merges). This script
// drives the real server entry points so the benchmark reflects server CPU.
//
// Pipeline measured (one "sample"), mirroring projectReadOnly in ws.ts:
//   deserializeWorld → advanceWorldEconomy → advanceWorldSystems  (= catchUp)
//   → serializeWorld → projectSnapshotForClient
//
// Usage:
//   npx tsx scripts/profile-server-catchup.ts [save.json]
//   npx tsx scripts/profile-server-catchup.ts [save.json] --golden
//   npx tsx scripts/profile-server-catchup.ts [save.json] --check-golden <sha256>
//
//   # CPU profile (analyze with scripts/analyze-cpuprofile.py):
//   NODE_OPTIONS="--cpu-prof --cpu-prof-dir=/tmp --cpu-prof-name=ri-catchup.cpuprofile" \
//     npx tsx scripts/profile-server-catchup.ts [save.json]
//
// The save file is a JSON-serialised SaveSnapshot (v14+) dumped from idb-keyval
// (see scripts/pull-idb-save.sh). Default: /tmp/saveNow.json.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  deserializeWorld,
  serializeWorld,
  type SaveSnapshot,
} from '../src/persistence.js';
import { advanceWorldEconomy } from '../src/economy-advance.js';
import { advanceWorldSystems } from '../src/world-systems-advance.js';
import { projectSnapshotForClient } from '../server/src/game/projection.js';

// ── timing helpers (style shared with profile-economy.ts) ──────────────────

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

function sorted(ns: bigint[]): bigint[] {
  return [...ns].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function pct(p: number, s: bigint[]): bigint {
  if (!s.length) return 0n;
  const idx = Math.min(s.length - 1, Math.floor((s.length - 1) * p));
  return s[idx]!;
}

function statSummary(ns: bigint[]): string {
  if (!ns.length) return 'no samples';
  const s = sorted(ns);
  const min = s[0]!;
  const p50 = pct(0.5, s);
  // Relative spread of the body of the distribution: (p90-min)/min as a noise
  // proxy. The optimizer only keeps a change whose speedup clearly exceeds this.
  const p90 = pct(0.9, s);
  const spreadPct = min > 0n ? Number(((p90 - min) * 100n) / min) : 0;
  return `n=${ns.length}  min=${fmtNs(min)}  p50=${fmtNs(p50)}  p90=${fmtNs(p90)}  p99=${fmtNs(pct(0.99, s))}  max=${fmtNs(pct(1, s))}  spread(p90-min)=${spreadPct}%`;
}

// ── the measured pipeline ──────────────────────────────────────────────────

interface Phases {
  deserialize: bigint;
  economy: bigint;
  systems: bigint;
  serialize: bigint;
  project: bigint;
  total: bigint;
}

/** One full server-side catch-up+project at the given `now`. Mirrors
 *  runtime.ts:catchUp followed by ws.ts:projectReadOnly's serialize+project.
 *  `now` is used as BOTH wall and perf clock (matching catchUp), so the result
 *  is deterministic for a fixed (snapshot, now). Returns the projected snapshot
 *  plus a per-phase timing breakdown. */
function catchUpAndProject(snapshot: SaveSnapshot, now: number): { projected: SaveSnapshot; phases: Phases } {
  const t0 = hrnow();
  const { world, islandStates } = deserializeWorld(snapshot, now, now);
  const t1 = hrnow();
  // Unify the view before advancing (catchUp does this).
  world.islandStates = islandStates;
  advanceWorldEconomy(world, islandStates, now, now);
  const t2 = hrnow();
  advanceWorldSystems(world, islandStates, snapshot.savedAt, now, 0);
  const t3 = hrnow();
  const serialized = serializeWorld(world, islandStates, now, now);
  const t4 = hrnow();
  const projected = projectSnapshotForClient(serialized);
  const t5 = hrnow();
  return {
    projected,
    phases: {
      deserialize: t1 - t0,
      economy: t2 - t1,
      systems: t3 - t2,
      serialize: t4 - t3,
      project: t5 - t4,
      total: t5 - t0,
    },
  };
}

// ── golden behaviour gate ───────────────────────────────────────────────────

/** Canonical-JSON SHA-256 of the projected snapshot at a FIXED gap. This is the
 *  optimizer's correctness oracle: any kept optimization MUST reproduce this
 *  hash exactly. Uses a fixed gap (savedAt + GOLDEN_GAP_MS) so the result is
 *  independent of wall-clock — two runs of an unchanged tree must agree. */
const GOLDEN_GAP_MS = 3_600_000; // 1h — exercises a non-trivial integration

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function goldenHash(snapshot: SaveSnapshot): string {
  const now = snapshot.savedAt + GOLDEN_GAP_MS;
  const { projected } = catchUpAndProject(snapshot, now);
  const json = JSON.stringify(canonicalize(projected));
  return createHash('sha256').update(json).digest('hex');
}

// ── main ─────────────────────────────────────────────────────────────────

interface Gap {
  readonly label: string;
  readonly ms: number;
  readonly samples: number;
}

// Sample counts sized so the default bench finishes in well under a minute
// (the optimizer hang-guard: bound every run). The 24h gap costs ~50s/sample —
// far too slow for a per-iteration keep/revert gate — so it is opt-in via
// --include-24h, NOT part of the default loop measurement.
const GAPS: Gap[] = [
  { label: '1s   (per-push)',   ms: 1_000,      samples: 300 },
  { label: '1min',              ms: 60_000,     samples: 80 },
  { label: '1h',                ms: 3_600_000,  samples: 6 },
];
const GAP_24H: Gap = { label: '24h  (offline)', ms: 86_400_000, samples: 2 };

function loadSnapshot(path: string): SaveSnapshot {
  return JSON.parse(readFileSync(path, 'utf8')) as SaveSnapshot;
}

function main(): void {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));
  const path = positional[0] ?? '/tmp/saveNow.json';
  const snapshot = loadSnapshot(path);

  if (flags.includes('--golden')) {
    // Run twice to prove determinism before trusting the hash as a gate.
    const h1 = goldenHash(snapshot);
    const h2 = goldenHash(snapshot);
    console.log(`golden(gap=${GOLDEN_GAP_MS}ms) = ${h1}`);
    console.log(`determinism: ${h1 === h2 ? 'OK (two runs agree)' : 'FAIL — h2=' + h2}`);
    process.exit(h1 === h2 ? 0 : 1);
  }

  const checkIdx = args.indexOf('--check-golden');
  if (checkIdx !== -1) {
    const expected = args[checkIdx + 1];
    const got = goldenHash(snapshot);
    const ok = got === expected;
    console.log(`golden expected = ${expected}`);
    console.log(`golden actual   = ${got}`);
    console.log(ok ? 'GATE PASS — behaviour identical' : 'GATE FAIL — behaviour changed');
    process.exit(ok ? 0 : 1);
  }

  // Benchmark mode.
  const w = snapshot.world;
  const pop = (w.islands ?? []).filter((i) => i.populated).length;
  console.log(`save: ${path}`);
  console.log(`  v=${snapshot.v}  islands=${w.islands?.length ?? 0}  populated=${pop}  states=${snapshot.islandStates.length}`);
  console.log(`  drones=${(w.drones ?? []).length}  routes=${(w.routes ?? []).length}  oceanCells=${(w.oceanCells ?? []).length}`);

  // Sample-count scale (RI_SCALE=0.05 for a quick probe). Bounds total runtime.
  const scale = Number(process.env.RI_SCALE ?? '1') || 1;
  let gaps = flags.includes('--include-24h') ? [...GAPS, GAP_24H] : GAPS;
  // Focused-profile mode: RI_ONLY=<index> restricts to one gap and RI_SAMPLES
  // overrides its sample count. Used to profile ONE scenario with enough samples
  // that the one-time weather epoch-anchor walk shrinks below profiling noise.
  const only = process.env.RI_ONLY;
  if (only !== undefined) {
    const idx = Number(only);
    const picked = ([...GAPS, GAP_24H])[idx];
    if (picked) {
      const samples = Number(process.env.RI_SAMPLES ?? picked.samples) || picked.samples;
      gaps = [{ ...picked, samples }];
    }
  }

  // Warmup — JIT the hot paths with a moderate gap.
  process.stderr.write(`\nWarmup (60 × 1min catch-ups)...\n`);
  for (let i = 0; i < 60; i++) catchUpAndProject(snapshot, snapshot.savedAt + 60_000);

  for (const gap of gaps) {
    const samples = Math.max(3, Math.round(gap.samples * scale));
    process.stderr.write(`  running [${gap.label}] × ${samples}...\n`);
    const totals: bigint[] = [];
    const ph = { deserialize: [] as bigint[], economy: [] as bigint[], systems: [] as bigint[], serialize: [] as bigint[], project: [] as bigint[] };
    for (let i = 0; i < samples; i++) {
      const { phases } = catchUpAndProject(snapshot, snapshot.savedAt + gap.ms);
      totals.push(phases.total);
      ph.deserialize.push(phases.deserialize);
      ph.economy.push(phases.economy);
      ph.systems.push(phases.systems);
      ph.serialize.push(phases.serialize);
      ph.project.push(phases.project);
    }
    console.log(`\n[${gap.label}]  ${statSummary(totals)}`);
    const med = (arr: bigint[]): bigint => pct(0.5, sorted(arr));
    console.log(`    deserialize p50=${fmtNs(med(ph.deserialize))}   economy p50=${fmtNs(med(ph.economy))}   systems p50=${fmtNs(med(ph.systems))}   serialize p50=${fmtNs(med(ph.serialize))}   project p50=${fmtNs(med(ph.project))}`);
  }
}

main();
