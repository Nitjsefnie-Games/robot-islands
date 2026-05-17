/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('§9.2 tier helper discipline — no hardcoded level boundaries', () => {
  // Hardcoded `state.level >= N` (or `s.level >= N`) where N matches a §9.2
  // tier boundary (5, 15, 30, 50) drifts silently if the boundaries shift.
  // All such checks must route through `tierForLevel(state.level) >= T`.
  // This test source-greps the relevant files to keep the pattern out.
  const files = [
    'lattice.ts',
    'buildings-ui.ts',
    'tutorial.ts',
  ];

  for (const f of files) {
    it(`${f} routes tier checks through tierForLevel (no \`level >= 5/15/30/50\` literal)`, () => {
      const src = readFileSync(join(__dirname, f), 'utf8');
      // Strip block + line comments so the test isn't tripped by historical
      // commentary that quotes the old pattern.
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      // Forbidden: a property-access `.level` followed by `>=` and one of
      // the §9.2 boundary literals.
      const forbidden = /\.level\s*>=\s*(5|15|30|50)\b/;
      const match = stripped.match(forbidden);
      expect(match).toBeNull();
    });
  }
});
