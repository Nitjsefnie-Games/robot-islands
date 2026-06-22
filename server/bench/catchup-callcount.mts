// In-process per-function CALL-COUNT harness for the catch-up calc. Mirrors
// catchup-profile.mts, but instead of CPU sampling (which finds expensive
// leaves) it uses V8 precise coverage with callCount to expose how MANY times
// each function runs — the metric that surfaces redundant-recompute blowups a
// cheap-but-absurdly-frequent function hides from time profiling (the browser
// side found hasPickableSkill at 200M calls/6s this way). Read-only.
//
// Usage: DATABASE_URL=... npx tsx bench/catchup-callcount.mts [gapMin] [reps]
//   BENCH_SNAPSHOT_FILE=<file> caches the snapshot (DB-independent reps).
//   BENCH_TOPN (default 30) — how many top callers to print.
import pg from 'pg';
import { Session } from 'node:inspector';
import { readFileSync } from 'node:fs';
import { loadSnapshot } from '../src/game/persistence.js';
import { catchUp } from '../src/game/runtime.js';

const URL = process.env.DATABASE_URL ?? 'postgresql:///robot_islands';
const gapMin = Number(process.argv[2] ?? '8');
const reps = Number(process.argv[3] ?? '6');
const USER = process.env.BENCH_USER ?? 'aee50add-e972-4b6b-9710-9325ff6a2711';
const SNAP_FILE = process.env.BENCH_SNAPSHOT_FILE;
const TOPN = Number(process.env.BENCH_TOPN ?? '30');

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

// Warm up so JIT/coverage instrumentation has settled (we measure steady state).
for (let i = 0; i < 3; i++) catchUp(structuredClone(snapshot), NOW);

const session = new Session();
session.connect();
const post = (method: string, params?: object): Promise<any> =>
  new Promise((res, rej) => session.post(method, params as never, (e, r) => (e ? rej(e) : res(r))));

// Collect scriptId -> parsed source so we can show the head of anonymous
// functions (offsets are into the tsx-transpiled source V8 actually parsed,
// so slicing that source — not the original .ts — is the reliable mapping).
const sources = new Map<string, string>();
await post('Debugger.enable');
session.on('Debugger.scriptParsed', (msg: any) => {
  const p = msg.params;
  if (typeof p?.scriptId === 'string') sources.set(p.scriptId, p.url ?? '');
});

await post('Profiler.enable');
// callCount:true → per-function invocation counts; detailed:false → function
// granularity (one range per function, ranges[0].count is the call count).
await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
for (let i = 0; i < reps; i++) catchUp(structuredClone(snapshot), NOW);
const { result } = await post('Profiler.takePreciseCoverage');
await post('Profiler.stopPreciseCoverage');

// Pull source for every project script in the result (for offset->head slicing).
const srcText = new Map<string, string>();
for (const script of result as Array<{ scriptId: string; url: string }>) {
  if (!script.url.includes('/src/') || script.url.includes('/node_modules/')) continue;
  try {
    const { scriptSource } = await post('Debugger.getScriptSource', { scriptId: script.scriptId });
    srcText.set(script.scriptId, scriptSource);
  } catch { /* ignore */ }
}
session.disconnect();

// Aggregate per (file + functionName + startOffset) — anonymous closures keep
// their own offset so they DON'T collapse into one "(anonymous)" bucket.
type Row = { fn: string; file: string; count: number; head: string };
const agg = new Map<string, Row>();
for (const script of result as Array<{ scriptId: string; url: string; functions: Array<{ functionName: string; ranges: Array<{ count: number; startOffset: number }> }> }>) {
  const url = script.url;
  if (!url.includes('/src/') || url.includes('/node_modules/')) continue;
  const file = url.replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '');
  const src = srcText.get(script.scriptId) ?? '';
  for (const f of script.functions) {
    const r0 = f.ranges[0];
    const count = r0?.count ?? 0;
    if (count === 0) continue;
    const off = r0?.startOffset ?? -1;
    const name = f.functionName || '(anon)';
    const key = `${file}::${name}::${off}`;
    let head = '';
    if (!f.functionName && src && off >= 0) {
      head = src.slice(off, off + 70).replace(/\s+/g, ' ').trim();
    }
    const row = agg.get(key);
    if (row) row.count += count;
    else agg.set(key, { fn: name, file, count, head });
  }
}

const rows = [...agg.values()].sort((a, b) => b.count - a.count);
const perRep = (n: number) => Math.round(n / reps);
console.log(`=== call counts: ${reps} catchUp reps (gap=${gapMin}min, user=${USER.slice(0, 8)}) ===`);
console.log(`(count = total over ${reps} reps; per-rep = count/${reps})`);
console.log('');
console.log(`${'count'.padStart(13)} ${'per-rep'.padStart(11)}  function @ file`);
for (const r of rows.slice(0, TOPN)) {
  const label = r.head ? `${r.fn} @ ${r.file}  «${r.head}»` : `${r.fn} @ ${r.file}`;
  console.log(`${String(r.count).padStart(13)} ${String(perRep(r.count)).padStart(11)}  ${label}`);
}
