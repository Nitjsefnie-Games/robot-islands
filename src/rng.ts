// Tiny pure seeded-RNG helpers for procedural world generation.
// Pure — no globals, no `Math.random`.

/**
 * String → numeric seed minter. Returns a function that, each call,
 * advances the internal hash and returns a fresh 32-bit seed. Calling it
 * repeatedly splits one string into independent numeric seeds for parallel
 * PRNG streams.
 */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (): number => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/**
 * Mulberry32 PRNG. Returns a function yielding `[0, 1)` floats. Identical
 * input seed → identical output sequence (the determinism is the point).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Convenience: string seed → PRNG. Mints a single numeric seed via xmur3
 * and feeds it to mulberry32. The same string seed always yields the same
 * `() => number` sequence.
 */
export function makeSeededRng(stringSeed: string): () => number {
  const mint = xmur3(stringSeed);
  return mulberry32(mint());
}
