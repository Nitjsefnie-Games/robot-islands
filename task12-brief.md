# Task 12 Brief — Wire exoticAdjacency + structural + xpGainMul

## Files to modify / create
- `src/skilltree.ts` — update `exoticAdjacency` payload, add `AdjacencyEffectData`, add `skillUnlockedAdjacencyRules`
- `src/adjacency.ts` — add `exoticRules` param to `computeBuffStack`, apply pairBoost
- `src/economy.ts` — thread exotic rules into `computeRates`, fold `xpGainMul` into `accrueXp`
- `src/structural.ts` — NEW file with `StructuralEffectData` and `hasStructuralEffect`
- `src/adjacency.test.ts` — add exoticAdjacency tests
- `src/structural.test.ts` — NEW test file for structural
- `src/economy.test.ts` — add xpGainMul tests

## 1. src/skilltree.ts

### A. Update `exoticAdjacency` payload (line ~79)
Change from:
```ts
| { readonly kind: 'exoticAdjacency'; readonly description: string }
```
To:
```ts
| { readonly kind: 'exoticAdjacency'; readonly description: string; readonly effect: AdjacencyEffectData }
```

Add `AdjacencyEffectData` type before `SkillEffect`:
```ts
export type AdjacencyEffectData =
  | { readonly kind: 'pairBoost'; readonly pair: readonly [BuildingDefId, BuildingDefId]; readonly recipeRateBonus: number };
```

### B. Add `skillUnlockedAdjacencyRules` helper
After `effectiveSkillMultipliers` or near other helpers:
```ts
export interface ExoticAdjacencyRule {
  readonly pair: readonly [BuildingDefId, BuildingDefId];
  readonly recipeRateBonus: number;
}

export function skillUnlockedAdjacencyRules(
  state: IslandState,
  graph: Graph = DEFAULT_GRAPH,
): ReadonlyArray<ExoticAdjacencyRule> {
  const rules: ExoticAdjacencyRule[] = [];
  for (const nodeId of state.unlockedNodes) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (node?.effect.kind === 'exoticAdjacency' && node.effect.effect.kind === 'pairBoost') {
      rules.push({ pair: node.effect.effect.pair, recipeRateBonus: node.effect.effect.recipeRateBonus });
    }
  }
  return rules;
}
```

## 2. src/adjacency.ts

### A. Update `computeBuffStack` signature
Add optional `exoticRules` parameter:
```ts
export function computeBuffStack(
  b: PlacedBuilding,
  buildings: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
  crossIsland?: ReadonlyArray<PlacedBuilding>,
  exoticRules?: ReadonlyArray<{ readonly pair: readonly [BuildingDefId, BuildingDefId]; readonly recipeRateBonus: number }>,
): number {
```

### B. Apply exotic rules after the buff loop
After the existing `for (const entry of buffs)` loop (around line 177), add:
```ts
  if (exoticRules) {
    for (const rule of exoticRules) {
      if (b.defId === rule.pair[0]) {
        const hasPair = neighbors.some((n) => n.defId === rule.pair[1]);
        if (hasPair) stack *= 1 + rule.recipeRateBonus;
      }
    }
  }
```

Note: `neighbors` is already computed above. Make sure the `neighbors` array is available at this point. Currently `neighbors` is scoped inside the buff loop block. You may need to lift it or recompute it.

Actually, looking at the code, `neighbors` is computed before the buff loop. Let me verify:
```ts
  const neighbors: PlacedBuilding[] = [];
  const seen = new Set<string>();
  // ... populate neighbors
```
Yes, `neighbors` is available after line 166. So we can just add the exotic rules loop after line 177 (after `return stack;`? No, before `return stack;`).

## 3. src/economy.ts

### A. Thread exotic rules into computeRates
Import `skillUnlockedAdjacencyRules` from `./skilltree.js`.

In `computeRates`, around line 794 where `computeBuffStack` is called:
```ts
const exoticRules = skillUnlockedAdjacencyRules(state);
const buffStack = computeBuffStack(b, validBuildings, defs, undefined, exoticRules);
```

Wait, `computeBuffStack` takes `crossIsland` as 4th param and `exoticRules` as 5th. The current call is:
```ts
const buffStack = computeBuffStack(b, validBuildings, defs);
```

Change to:
```ts
const exoticRules = skillUnlockedAdjacencyRules(state);
const buffStack = computeBuffStack(b, validBuildings, defs, undefined, exoticRules);
```

But `skillUnlockedAdjacencyRules` takes `graph` as optional second arg. In `economy.ts`, we don't have `graph` available. We can call `skillUnlockedAdjacencyRules(state)` and it will use `DEFAULT_GRAPH`.

However, tests might want to pass a custom graph. But `computeRates` also doesn't take a `graph` parameter. For now, using `DEFAULT_GRAPH` is fine.

### B. Fold xpGainMul into accrueXp
Update `accrueXp` signature:
```ts
export function accrueXp(
  state: IslandState,
  production: Partial<Record<ResourceId, number>>,
  consumption: Partial<Record<ResourceId, number>>,
  dtSec: number,
  xpMul: number = 1,
  xpGainMul: number = 1,
): void {
```

Change the final line from:
```ts
  state.xp += gain * xpMul;
```
To:
```ts
  state.xp += gain * xpMul * xpGainMul;
```

### C. Update the caller in advanceIsland
Around line 1609:
```ts
const skillMul = effectiveSkillMultipliers(state);
// ...
accrueXp(state, production, consumption, dtSec, 1, skillMul.xpGain);
```

Wait, `effectiveSkillMultipliers` is already called inside `computeRates`. But `advanceIsland` doesn't have `skillMul` available. We can call it again:
```ts
const xpGainMul = effectiveSkillMultipliers(state).xpGain;
accrueXp(state, production, consumption, dtSec, 1, xpGainMul);
```

Or we could compute it once at the top of the loop. But since `effectiveSkillMultipliers` is pure and relatively cheap, calling it here is fine.

Actually, looking at `advanceIsland`, `effectiveSkillMultipliers` might already be called inside `computeRates`. We just need to capture it. But `computeRates` doesn't return it.

Simplest: call it again right before `accrueXp`:
```ts
const xpGainMul = effectiveSkillMultipliers(state).xpGain;
accrueXp(state, production, consumption, dtSec, undefined, xpGainMul);
```

Wait, `accrueXp`'s 5th param is `xpMul` and 6th is `xpGainMul`. The existing call is:
```ts
accrueXp(state, production, consumption, dtSec);
```

So with the new signature:
```ts
accrueXp(state, production, consumption, dtSec, 1, xpGainMul);
```

### D. Update economy.test.ts callers
The tests call `accrueXp(state, production, consumption, dtSec, 1)` with 5 args. With the new signature, this is fine because the 6th param is optional.

## 4. src/structural.ts (NEW)

Create the file:
```ts
// Structural effect dispatch — catch-all for skill-unlocked engine rewrites.
//
// Each `structural` node carries a `StructuralEffectData` payload. Callers
// query via `hasStructuralEffect(kind, state, graph)` to gate behaviour.

import type { IslandState } from './economy.js';
import type { Graph } from './skilltree-graph.js';
import { DEFAULT_GRAPH } from './skilltree.js';

export type StructuralEffectData =
  | { readonly kind: 'sharedPowerGrid' }
  | { readonly kind: 'parallelConstruction'; readonly bonus: number };

export function hasStructuralEffect(
  kind: StructuralEffectData['kind'],
  state: IslandState,
  graph: Graph = DEFAULT_GRAPH,
): boolean {
  for (const nodeId of state.unlockedNodes) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (node?.effect.kind === 'structural' && node.effect.data.kind === kind) return true;
  }
  return false;
}
```

Note: The current `structural` effect type in `skilltree.ts` is:
```ts
| { readonly kind: 'structural'; readonly description: string }
```

But the task plan says the payload should be `{ data: StructuralEffectData }`. So we need to update the `structural` payload too!

### E. Update `structural` payload in skilltree.ts
Change from:
```ts
| { readonly kind: 'structural'; readonly description: string }
```
To:
```ts
| { readonly kind: 'structural'; readonly description: string; readonly data: StructuralEffectData }
```

Where `StructuralEffectData` is imported from `./structural.js`. But that creates a circular dependency if `structural.ts` imports from `skilltree.ts` and `skilltree.ts` imports from `structural.ts`.

To avoid this, define `StructuralEffectData` in `skilltree.ts` directly instead of importing from `structural.ts`. Or define it in a shared type-only file.

Actually, looking at the task plan:
```ts
// src/structural.ts
export type StructuralEffectData = ...;
export function hasStructuralEffect(...) { ... }
```

And in `skilltree.ts`, the `structural` effect currently has `readonly description: string`. The task plan doesn't explicitly say to change the `structural` payload in `skilltree.ts`, but `hasStructuralEffect` checks `node.effect.data.kind === kind`, which implies the payload must have a `data` field.

So we need to update the `structural` payload in `skilltree.ts` to include `data`. But if `structural.ts` imports from `skilltree.ts` (for `DEFAULT_GRAPH`) and `skilltree.ts` imports from `structural.ts` (for `StructuralEffectData`), that's a cycle.

Solutions:
1. Define `StructuralEffectData` in `skilltree.ts` and have `structural.ts` import it from there.
2. Define `StructuralEffectData` in a separate small file and import it in both.
3. Define it in `skilltree.ts` and don't create `structural.ts` at all (put `hasStructuralEffect` in `skilltree.ts`).

Looking at the task plan, it says `src/structural.ts` (NEW). So option 1 is best: define `StructuralEffectData` in `skilltree.ts`, and `structural.ts` imports it from `skilltree.ts`. But `structural.ts` also needs `DEFAULT_GRAPH` from `skilltree.ts`. That's fine — it's a one-way import.

Wait, `skilltree.ts` would import `StructuralEffectData` from... nowhere, it defines it. But the `structural` payload in `SkillEffect` needs to reference `StructuralEffectData`. So we define `StructuralEffectData` in `skilltree.ts` before `SkillEffect`.

Then `structural.ts` imports `StructuralEffectData` and `DEFAULT_GRAPH` from `skilltree.ts`.

```ts
// In skilltree.ts, before SkillEffect:
export type StructuralEffectData =
  | { readonly kind: 'sharedPowerGrid' }
  | { readonly kind: 'parallelConstruction'; readonly bonus: number };

// In SkillEffect:
| { readonly kind: 'structural'; readonly description: string; readonly data: StructuralEffectData }
```

And `structural.ts`:
```ts
import type { IslandState } from './economy.js';
import type { Graph } from './skilltree-graph.js';
import { DEFAULT_GRAPH, type StructuralEffectData } from './skilltree.js';

export function hasStructuralEffect(...) { ... }
```

This avoids cycles.

## 5. Tests

### adjacency.test.ts
Add tests for exoticAdjacency / pairBoost:
- pairBoost with matching neighbor → multiplier applied
- pairBoost without matching neighbor → no effect
- Multiple exotic rules stack multiplicatively
- exoticRules work alongside native adjacencyBuffs

Example:
```ts
it('applies pairBoost when focal and neighbor match the pair', () => {
  const focal: PlacedBuilding = { id: 'a', defId: 'smelter', x: 0, y: 0 };
  const neighbor: PlacedBuilding = { id: 'b', defId: 'coal_gen', x: 2, y: 0 };
  const rules = [{ pair: ['smelter', 'coal_gen'] as const, recipeRateBonus: 0.25 }];
  expect(computeBuffStack(focal, [focal, neighbor], BUILDING_DEFS, undefined, rules)).toBeCloseTo(1.25, 9);
});
```

### structural.test.ts (NEW)
Create `src/structural.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { hasStructuralEffect } from './structural.js';
import type { IslandState } from './economy.js';
import type { Graph } from './skilltree-graph.js';

describe('hasStructuralEffect', () => {
  it('returns false when no matching node is owned', () => {
    const state = { unlockedNodes: new Set<string>() } as IslandState;
    expect(hasStructuralEffect('sharedPowerGrid', state)).toBe(false);
  });

  it('returns true when a matching structural node is owned', () => {
    const graph: Graph = {
      nodes: [
        {
          id: 's.1',
          subPath: 'mining',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'structural', description: 'shared grid', data: { kind: 'sharedPowerGrid' } },
          description: 'shared grid',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };
    const state = { unlockedNodes: new Set<string>(['s.1']) } as IslandState;
    expect(hasStructuralEffect('sharedPowerGrid', state, graph)).toBe(true);
    expect(hasStructuralEffect('parallelConstruction', state, graph)).toBe(false);
  });
});
```

### economy.test.ts
Add tests for xpGainMul in `accrueXp`:
- Default xpGainMul = 1 → no change
- xpGainMul = 2 → double XP
- xpGainMul = 0 → no XP

Example:
```ts
it('doubles XP when xpGainMul is 2', () => {
  const state = makeState();
  accrueXp(state, { iron_ore: 5 }, {}, 1, 1, 2);
  expect(state.xp).toBe(5 * XP_WEIGHT.iron_ore * 2);
});
```

Also add a test for `advanceIsland` (or `computeRates`) that verifies `skillUnlockedAdjacencyRules` are applied. This could be a higher-level integration test.

Actually, since `computeRates` with exoticRules affects `buffStack`, and `buffStack` affects the rate, we can test it via `computeRates` output. But that's complex. A simpler test: verify that `computeBuffStack` accepts exotic rules and applies them. The adjacency.test.ts tests cover that.

## Build & Test
Run:
```bash
npm test
npm run build
```

Expected: all existing tests pass, new tests pass, TypeScript compiles clean.

## Commit
```bash
git add -A
git commit -F - <<'EOF'
feat(skilltree): wire exoticAdjacency + structural + xpGainMul effect kinds

- exoticAdjacency: skill-unlocked adjacency rules join existing §4.5
  per-building computation. Initial supported rule: pairBoost.
- structural: new closed-union StructuralEffectData with hasStructuralEffect
  helper for site-specific dispatch (sharedPowerGrid, parallelConstruction
  placeholders for first content).
- xpGainMul: folded into economy.ts XP accrual; global multiplier stacks
  with the recipe's base xp_weight.

Co-Authored-By: Kimi K2.6 <noreply@kimi.com>
EOF
```
