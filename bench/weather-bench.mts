// Cold-walk benchmark + characterization oracle for the weather walker.
// Mirrors the boot freeze: a fresh page has an empty weatherCache, and the
// weather overlay's first refresh cold-walks every visible cell from epoch
// t=0 to wall-now (~220k dwell iterations each). We sample a grid of cells
// at wall-now, capture each cell's WeatherCell as the oracle, and time it.
import { weather, clearWeatherCacheForTests } from '../src/weather.js';
import type { Biome } from '../src/world.js';

const SEED = 'rio-2026';
const CO2 = 0;
const NOW = 1781815000000; // ~wall-now epoch ms (matches the real save's clock)
const BIOMES: (Biome | undefined)[] = ['plains', 'volcanic', 'arctic', 'desert', 'forest', undefined];
const N = Number(process.argv[2] ?? '200'); // cell count (boot samples a few hundred)

// Deterministic cell set + biome assignment.
const cells: Array<{ cx: number; cy: number; biome: Biome | undefined }> = [];
for (let i = 0; i < N; i++) {
  cells.push({ cx: (i * 7) % 97, cy: (i * 13) % 89, biome: BIOMES[i % BIOMES.length] });
}

function runOnce(): string[] {
  clearWeatherCacheForTests();
  const out: string[] = [];
  for (const c of cells) {
    const w = weather(SEED, c.cx, c.cy, NOW, c.biome, CO2);
    out.push(`${c.cx},${c.cy},${c.biome}:${w.state}|${w.sinceMs}|${w.untilMs}`);
    // also a forecast query (overlay samples now + a forward time) — exercises
    // the resume path off the just-built walker.
    const f = weather(SEED, c.cx, c.cy, NOW + 3 * 60 * 60 * 1000, c.biome, CO2);
    out.push(`f:${f.state}|${f.sinceMs}|${f.untilMs}`);
  }
  return out;
}

// Oracle (warm-up run also).
const oracle = runOnce().join('\n');
const reps = Number(process.argv[3] ?? '4');
const times: number[] = [];
for (let i = 0; i < reps; i++) {
  const t0 = performance.now();
  const out = runOnce().join('\n');
  const dt = performance.now() - t0;
  if (out !== oracle) { console.error('!! DIGEST MISMATCH rep', i); process.exit(2); }
  times.push(dt);
}
times.sort((a, b) => a - b);
const crypto = await import('node:crypto');
console.log('cells:', N, ' oracle sha:', crypto.createHash('sha256').update(oracle).digest('hex').slice(0, 16));
console.log(`cold-walk ms  min=${times[0]!.toFixed(0)}  median=${times[Math.floor(times.length / 2)]!.toFixed(0)}  (all: ${times.map((t) => t.toFixed(0)).join(',')})`);
