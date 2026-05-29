# Skill-tree Rebalance v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut every skill sub-path to ≤2 filler lever-families, consolidate cross-branch duplicate levers to one home, and add a magical material-input-efficiency lever — keeping v1's cap framework intact.

**Architecture:** The magnitude machinery (`deriveMagnitudes`) groups by effect-key **globally across all sub-paths** and solves each pool's per-node magnitude so the product hits `POOL_TARGETS[key]`. Therefore the entire de-noding + consolidation is achieved by *editing the `*_FILLER_ARCHETYPES` arrays* and `POOL_TARGETS`; magnitudes re-derive automatically. The new `recipeInputMul` effect is a runtime `SkillMultipliers` field applied to recipe input demand in the economy (mirrors `powerConsumptionMul`). Node-id removal forces a persistence schema bump + ladder reset.

**Tech Stack:** TypeScript (strict), Vitest, no framework. Pure-layer only — no PixiJS.

**Spec:** `docs/superpowers/specs/2026-05-29-skilltree-v2-rebalance-spec.md`

---

## ⛔ Prerequisite gate (do not start before this is true)

Spec §9 (Q5) sequences this **after** the throughput-floors rebalance. Before Task 1:

- [ ] Confirm throughput-floors is merged to `master` (`git log --oneline | grep -i floors`).
- [ ] Re-read `src/economy.ts` `computeRates` + `inputAvail` — **floors edits this file, so every economy line number below must be re-verified.** The integration is specified by symbol + behavior, not just line.
- [ ] Re-read `src/persistence.ts:79` `SCHEMA_VERSION` — it is **16** today; floors may bump it. The migration target is **current committed + 1**. Replace every `<N>`/`<N+1>` below with the actual numbers at execution time.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/skilltree.ts` | `SkillEffect` union, `SkillMultipliers`, `effectiveSkillMultipliers` fold | Add `recipeInputMul` variant + field + fold case |
| `src/economy.ts` | tick loop, `computeRates`, `inputAvail` | Divide recipe input demand by `skillMul.recipeInputMul` |
| `src/skilltree-derive-magnitudes.ts` | `POOL_TARGETS`, magnitude solver | Add `recipeInputMul: 1.5`; remove `storageCapMul` |
| `src/skilltree-archetypes.ts` | per-sub-path filler chains | Rewrite all 20 `*_FILLER_ARCHETYPES` to ≤2 lever-families; add magic chains; consolidate storage |
| `src/skilltree-catalog.ts` | notables/keystones assembly | Move demoted levers into NOTABLES; drop dead `effectLabel`-only kinds |
| `src/skilltree-budget.test.ts` | NEW | Assert ≤2 lever-families + ≤23 nodes per sub-path |
| `src/persistence.ts` | schema + migrations | `migrateV<N>toV<N+1>` ladder reset (keep xp/buildings/inventory) |

---

## Task 1: Add `recipeInputMul` effect + SkillMultipliers fold

**Files:**
- Modify: `src/skilltree.ts` (`SkillEffect` union ~line 177; `SkillMultipliers` ~780; `blankMultipliers` ~868; `effectiveSkillMultipliers` ~916 + return ~1088)
- Test: `src/skilltree.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/skilltree.test.ts — add to the existing effectiveSkillMultipliers describe block
import { effectiveSkillMultipliers } from './skilltree.js';
// (use the file's existing helper for building an IslandState with unlockedNodes;
//  match the pattern already used by neighbouring tests in this file)

it('folds recipeInputMul into a >1 divisor multiplier', () => {
  // node with effect { kind: 'recipeInputMul', reduce: true }, magnitude 0.2
  const mul = effectiveSkillMultipliersForNodes([
    { effect: { kind: 'recipeInputMul', reduce: true }, magnitude: 0.2 },
    { effect: { kind: 'recipeInputMul', reduce: true }, magnitude: 0.1 },
  ]);
  // 1.2 * 1.1 = 1.32 — inputs are later divided by this
  expect(mul.recipeInputMul).toBeCloseTo(1.32, 5);
});
```

> If `effectiveSkillMultipliersForNodes` does not exist, build the IslandState inline exactly as the adjacent tests in `skilltree.test.ts` do (they unlock nodes by id on a constructed graph). Do not invent a new helper — copy the established setup.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/skilltree.test.ts -t "recipeInputMul"`
Expected: FAIL — `mul.recipeInputMul` is `undefined`.

- [ ] **Step 3a: Add the union variant** (`src/skilltree.ts`, after the `batteryCapacityMul` line ~177)

```ts
  | { readonly kind: 'batteryCapacityMul' }
  // Magical material-input efficiency — divides recipe INPUT quantities
  // (outputs unchanged). reduce:true ⇒ multiplier > 1 means "needs less
  // input". Runtime-only: never edits the static RECIPES table, so the
  // mass-balance auditor (mass-balance.test.ts) never sees it.
  | { readonly kind: 'recipeInputMul'; readonly reduce: true };
```

- [ ] **Step 3b: Add the field to `SkillMultipliers`** (~line 789, next to `powerConsumption`)

```ts
  readonly powerConsumption: number;
  /** Divisor on recipe input demand (≥1; 1 = no effect). Capped ÷1.5. */
  readonly recipeInputMul: number;
```

- [ ] **Step 3c: Seed it in `blankMultipliers`** (~line 877)

```ts
    powerConsumption: 1,
    recipeInputMul: 1,
```

- [ ] **Step 3d: Fold it in `effectiveSkillMultipliers`** — add an accumulator beside `powerConsumption` (~line 927), a case beside `powerConsumptionMul` (~line 982), and include it in the return (~line 1088).

```ts
  // beside `let powerConsumption = 1;`
  let recipeInputMul = 1;
```
```ts
      // beside case 'powerConsumptionMul':
      case 'recipeInputMul':
        recipeInputMul *= m;
        break;
```
```ts
    // in the returned object, beside `powerConsumption,`
    recipeInputMul,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/skilltree.test.ts -t "recipeInputMul"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skilltree.ts src/skilltree.test.ts
git commit -m "feat(skilltree): recipeInputMul SkillEffect + multipliers fold

Co-Authored-By: <implementer model> <noreply@...>"
```

---

## Task 2: Apply `recipeInputMul` to recipe input demand in the economy

**Files:**
- Modify: `src/economy.ts` — `inputAvail` (~line 544) and the consumption accrual in `computeRates`/integration (search `recipe.inputs` and where inputs are debited).
- Test: `src/economy.test.ts`

> **Re-ground first:** floors has edited this file. Locate (a) where per-cycle input demand `needPerCycle` is read in `inputAvail`, and (b) where inputs are actually subtracted from inventory during integration. The multiplier must apply to **both** so demand and consumption stay consistent. Effective per-cycle input = `needPerCycle / skillMul.recipeInputMul`.

- [ ] **Step 1: Write the failing test**

```ts
// src/economy.test.ts
it('recipeInputMul reduces consumed inputs without changing outputs', () => {
  // Build two identical islands; one with recipeInputMul=1.5 in its resolved
  // SkillMultipliers (unlock 0 vs N magic nodes, or inject via the same path
  // neighbouring economy tests use to set skill multipliers).
  // Advance both one fixed interval producing a recipe with inputs:{iron_ore:2}.
  // Assert: magic island consumed iron_ore at 2/1.5 the rate; outputs equal.
  expect(magicConsumed).toBeCloseTo(baseConsumed / 1.5, 4);
  expect(magicProduced).toBeCloseTo(baseProduced, 4);
});
```

> Match the existing economy-test harness for constructing `IslandState` + advancing — see neighbouring tests (e.g. the inputAvail / flow-through tests). Use the same skill-multiplier injection path they use; do not hand-roll a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/economy.test.ts -t "recipeInputMul reduces"`
Expected: FAIL — consumption unchanged (multiplier not applied).

- [ ] **Step 3: Apply the divisor at both sites.** In `inputAvail` and the consumption-debit site, replace the raw `needPerCycle` with the reduced demand.

```ts
// inputAvail() — where it iterates recipe.inputs:
const needPerCycle = rawNeedPerCycle / skillMul.recipeInputMul;
// (thread skillMul into inputAvail's params if not already available —
//  it already receives the resolved multipliers for powerFactor; reuse that.)
```
```ts
// consumption accrual during integration — same division applied to the
// amount debited per second so inventory drawdown matches inputAvail's demand.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/economy.test.ts -t "recipeInputMul reduces"`
Expected: PASS.

- [ ] **Step 5: Run the full economy suite** (guards the flow-through / two-pass invariants)

Run: `npx vitest run src/economy.test.ts`
Expected: PASS (no regression in inputAvail / power-balance tests).

- [ ] **Step 6: Commit**

```bash
git add src/economy.ts src/economy.test.ts
git commit -m "feat(economy): apply recipeInputMul divisor to recipe input demand

Co-Authored-By: <implementer model> <noreply@...>"
```

---

## Task 3: Magnitude pool config — add magic pool, remove generic storage

**Files:**
- Modify: `src/skilltree-derive-magnitudes.ts` `POOL_TARGETS` (~line 23). (The CI test + `scripts/skilltree-magnitudes.ts` re-export this — single source of truth.)
- Test: `src/skilltree-derive-magnitudes.test.ts` + the existing `src/skilltree-magnitudes.test.ts` CI guard.

- [ ] **Step 1: Write the failing test**

```ts
// src/skilltree-derive-magnitudes.test.ts
import { deriveMagnitudes, POOL_TARGETS } from './skilltree-derive-magnitudes.js';

it('recipeInputMul pool target is 1.5 and product hits it', () => {
  expect(POOL_TARGETS['recipeInputMul']).toBeCloseTo(1.5, 6);
  const raw = [ // one 3-node filler chain of recipeInputMul, prefix registered
    { id: 'smelting.inputEff.1', subPath: 'smelting', depth: 1, cost: 3,
      effect: { kind: 'recipeInputMul', reduce: true }, description: '' },
    { id: 'smelting.inputEff.2', subPath: 'smelting', depth: 2, cost: 5,
      effect: { kind: 'recipeInputMul', reduce: true }, description: '' },
    { id: 'smelting.inputEff.3', subPath: 'smelting', depth: 3, cost: 9,
      effect: { kind: 'recipeInputMul', reduce: true }, description: '' },
  ];
  const out = deriveMagnitudes(raw, ['smelting.inputEff']);
  const product = out.reduce((p, n) => p * (1 + n.magnitude), 1);
  expect(product).toBeCloseTo(1.5, 4);
});

it('storageCapMul pool is removed (no generic uniform-storage target)', () => {
  expect('storageCapMul' in POOL_TARGETS).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/skilltree-derive-magnitudes.test.ts -t "recipeInputMul pool|storageCapMul pool"`
Expected: FAIL — `recipeInputMul` absent; `storageCapMul` still present.

- [ ] **Step 3: Edit `POOL_TARGETS`** — add the magic line, delete the generic-storage line.

```ts
  'powerConsumptionMul': Math.sqrt(10),
  'recipeInputMul': 1.5,            // magical input-efficiency (reduce pool, ÷1.5 at full)
  'commRangeMul': 10,
  // ...
  // DELETE this line — generic uniform storage cap is removed in v2:
  //   'storageCapMul': Math.sqrt(10),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/skilltree-derive-magnitudes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skilltree-derive-magnitudes.ts src/skilltree-derive-magnitudes.test.ts
git commit -m "feat(skilltree): POOL_TARGETS += recipeInputMul 1.5, -= storageCapMul

Co-Authored-By: <implementer model> <noreply@...>"
```

---

## Task 4: De-node + consolidate filler archetypes

This is the bulk change. Rewrite every `*_FILLER_ARCHETYPES` array per the spec §4 ownership map. **Do it one branch per commit** (5 commits) so review is bounded. Conventions (copy from existing entries): `growth: 1.10`; filler `baseCost`/`costGrowth` in the 1–3 / 1.4–1.7 range; magic chains use **elevated** cost (`baseCost: 3, costGrowth: 1.8`) per spec Q4.

**Rule:** each array ends with **≤2 distinct lever-families**. Storage is the exception-by-definition: its 4 per-category caps are *one* capacity family (Task 5's test groups by family).

### Surviving archetypes per sub-path (the complete map)

| Sub-path | Archetype 1 | Archetype 2 | Notes |
|---|---|---|---|
| mining | `recipeRateMul:extraction` | `mineYieldBonusMul` | drop storageCap, powerCons; rareTrickle → notable |
| forestry | `recipeRateMul:extraction` | `loggerYieldBonusMul` | drop storageCap; exoticTrickle → notable |
| drilling | `recipeRateMul:extraction` | `drillYieldBonusMul` | drop storageCap, dup mineYield, rareTrickle |
| robotics | `recipeRateMul:manufacturing` | `droneFuelEfficiencyMul` | constructionTime+parallelBuild → notable; droneScanRadius dropped |
| smelting | `recipeRateMul:smelting` | `recipeInputMul` (magic) | drop powerCons, maintenance |
| chemistry | `recipeRateMul:chemistry` | `recipeInputMul` (magic) | drop storageCap, powerCons |
| electronics | `recipeRateMul:electronics` | `recipeInputMul` (magic) | drop powerCons, satBuffer |
| power_systems | `powerProductionMul` | `powerConsumptionMul` | battery, xpGain → notable |
| storage | `storageCategoryCapMul:dry_goods` | `storageCategoryCapMul:liquid_gas` **+** `:components` **+** `:rare` | one capacity family (4 chains); generic removed; maint → resilience |
| transport | `routeCapacityMul` | `airshipRangeMul` | droneFuel → robotics pool |
| network | `teleporterEfficiencyMul` | — (sparse) | commRange, scanner dropped |
| launch | `launchSuccessAdditive` | `satBufferCapMul` | padExplosion, satFuel → notable |
| communication | `commRangeMul` | — (sparse) | scanner, satBuffer dropped |
| discovery | `scannerCoverageMul` | `droneScanRadiusMul` | scannerDwell → notable |
| resilience | `debrisProtectionMul` | `maintenanceThresholdMul` | repairDrone → notable |
| aquaculture | `recipeRateMul:extraction` | `aquacultureYieldBonusMul` | drop storageCap, dup mineYield |
| hydroprocessing | `recipeRateMul:chemistry` | — (sparse) | powerCons, storageCap dropped |
| submarine | `routeCapacityMul` | `airshipRangeMul` | powerProduction dropped |
| oceanography | `scannerCoverageMul` | `t5ExtractorYieldBonusMul` | commRange, droneScan dropped |
| patronage | `patronageYieldBonusMul` | — (sparse) | extraction-rate, commRange, rare dropped |

### Worked examples (apply the same shape to the rest)

- [ ] **Step 4.1: Extraction branch.** Rewrite MINING/FORESTRY/DRILLING/ROBOTICS archetype arrays.

```ts
// MINING — was 4 archetypes, now 2
export const MINING_FILLER_ARCHETYPES: FillerArchetype[] = [
  { idPrefix: 'mining.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'extraction' }, subPath: 'mining',
    growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 8 },
  { idPrefix: 'mining.yieldBonus', effectKind: 'mineYieldBonusMul',
    subPath: 'mining', growth: 1.10, baseCost: 2, costGrowth: 1.6, count: 6 },
];
// ROBOTICS — manufacturing-rate is rehomed here (was in storage)
export const ROBOTICS_FILLER_ARCHETYPES: FillerArchetype[] = [
  { idPrefix: 'robotics.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'manufacturing' }, subPath: 'robotics',
    growth: 1.10, baseCost: 1, costGrowth: 1.5, count: 8 },
  { idPrefix: 'robotics.droneFuel', effectKind: 'droneFuelEfficiencyMul',
    subPath: 'robotics', growth: 1.10, baseCost: 1, costGrowth: 1.4, count: 7 },
];
```

- [ ] **Step 4.2: Refinement branch** (smelting/chemistry/electronics get the magic chain; power_systems keeps prod+consume).

```ts
// SMELTING — rate + magic. Magic chain uses elevated cost (premium, spec Q4).
export const SMELTING_FILLER_ARCHETYPES: FillerArchetype[] = [
  { idPrefix: 'smelting.recipeRate', effectKind: 'recipeRateMul',
    effectExtra: { category: 'smelting' }, subPath: 'smelting',
    growth: 1.10, baseCost: 1, costGrowth: 1.5, count: 8 },
  { idPrefix: 'smelting.inputEff', effectKind: 'recipeInputMul',
    effectExtra: { reduce: true }, subPath: 'smelting',
    growth: 1.10, baseCost: 3, costGrowth: 1.8, count: 4 },  // premium cost
];
// chemistry.inputEff and electronics.inputEff: identical shape, their own idPrefix.
// All three share the single 'recipeInputMul' pool (effectKey ignores category).
```

> **T3 gate (spec Q4):** locate how depth/tier gating is enforced (search `Tier`, `tierFor`, `minSpent`, depth→tier in `skilltree.ts`/`skilltree-catalog.ts`). Gate each `*.inputEff` chain so its first node requires T3+. If gating is depth-based (`cost(depth)=2^(depth-1)` ⇒ tier), start the chain at the depth whose tier ≥ 3; if it's a `minSpent` prereq (as in `BRANCH` thresholds), add a threshold entry. **Re-ground the exact mechanism before writing — do not guess.**

- [ ] **Step 4.3: Logistics branch** — storage hosts the 4 category caps (consolidated from mining/forestry/drilling/aquaculture); generic `storageCapMul` archetype deleted everywhere; manufacturing-rate removed (→ robotics).

```ts
// STORAGE — one capacity family, 4 category chains. No generic storageCapMul.
export const STORAGE_FILLER_ARCHETYPES: FillerArchetype[] = [
  { idPrefix: 'storage.capDry',  effectKind: 'storageCategoryCapMul',
    effectExtra: { category: 'dry_goods' },  subPath: 'storage',
    growth: 1.10, baseCost: 1, costGrowth: 1.5, count: 5 },
  { idPrefix: 'storage.capLiq',  effectKind: 'storageCategoryCapMul',
    effectExtra: { category: 'liquid_gas' }, subPath: 'storage',
    growth: 1.10, baseCost: 1, costGrowth: 1.5, count: 5 },
  { idPrefix: 'storage.capComp', effectKind: 'storageCategoryCapMul',
    effectExtra: { category: 'components' }, subPath: 'storage',
    growth: 1.10, baseCost: 1, costGrowth: 1.5, count: 4 },
  { idPrefix: 'storage.capRare', effectKind: 'storageCategoryCapMul',
    effectExtra: { category: 'rare' },       subPath: 'storage',
    growth: 1.10, baseCost: 1, costGrowth: 1.5, count: 4 },
];
```

- [ ] **Step 4.4: Orbital branch** — launch/communication/discovery/resilience per the map table.
- [ ] **Step 4.5: Ocean branch** — aquaculture/hydroprocessing/submarine/oceanography/patronage per the map table.

- [ ] **Step 4.6: Move demoted levers into NOTABLES** (`src/skilltree-catalog.ts`). For each demoted kind (`constructionTimeMul`, `mineRareTrickleMul`, `loggerExoticTrickleMul`, `parallelBuildCapAdd`, `batteryCapacityMul`, `xpGainMul`, `scannerDwellRateMul`, `repairDroneReliabilityMul`, `padExplosionReduceMul`, `satFuelReserveMul`), ensure exactly one notable node of that kind exists in the relevant sub-path's NOTABLES array (most already do — verify and add only the missing ones). A notable is a non-`<prefix>.`-id node so `inferTier` classifies it `notable`.

- [ ] **Step 4.7: After each branch, run magnitudes + typecheck.**

Run: `npx vitest run src/skilltree-magnitudes.test.ts && npm run build`
Expected: each pool product still ≈ its `POOL_TARGETS` cap; clean compile (drop now-unused effect kinds from `effectLabel` only if `noUnusedLocals` complains — it won't, it's a switch).

- [ ] **Step 4.8: Commit per branch** (5 commits, e.g. `refactor(skilltree): de-node extraction branch to ≤2 chains`).

---

## Task 5: Budget acceptance test (≤2 lever-families + ≤23 nodes)

**Files:**
- Create: `src/skilltree-budget.test.ts`

- [ ] **Step 1: Write the test** (this is the spec §10 guard; it groups by lever-family, not raw archetype count)

```ts
import { describe, it, expect } from 'vitest';
import { FULL_CATALOG } from './skilltree-catalog.js';
import { BRANCH_SUBPATHS } from './skilltree.js';
import { effectKey } from './skilltree-derive-magnitudes.js';

// A "lever-family" collapses category variants of one kind (e.g. all
// storageCategoryCapMul:* count as one family).
function family(e: { kind: string }): string {
  if (e.kind === 'storageCategoryCapMul') return 'storageCategoryCapMul';
  if (e.kind === 'recipeRateMul') return effectKey(e as any); // category matters here
  return e.kind;
}

describe('skill-tree v2 node budget', () => {
  const allSubpaths = Object.values(BRANCH_SUBPATHS).flat();
  for (const sp of allSubpaths) {
    const nodes = FULL_CATALOG.filter(n => n.subPath === sp);
    const fillers = nodes.filter(n => !n.id.includes('.keystone.') && /\.\d+$/.test(n.id));
    it(`${sp}: ≤2 filler lever-families`, () => {
      const fams = new Set(fillers.map(n => family(n.effect)));
      expect(fams.size).toBeLessThanOrEqual(2);
    });
    it(`${sp}: ≤23 total nodes`, () => {
      expect(nodes.length).toBeLessThanOrEqual(23);
    });
  }
});
```

- [ ] **Step 2: Run** — `npx vitest run src/skilltree-budget.test.ts`. Expected: PASS after Task 4. If a sub-path fails, its archetype array still has >2 families — fix that array.

- [ ] **Step 3: Commit** — `test(skilltree): v2 node-budget guard (≤2 families, ≤23 nodes)`.

---

## Task 6: Persistence migration (ladder reset, keep xp/buildings/inventory)

**Files:**
- Modify: `src/persistence.ts` — bump `SCHEMA_VERSION`; add `SerializedSnapshotV<N>` alias, `migrateV<N>toV<N+1>`, `loadWorld` dispatch line, `SUPPORTED_LOAD_VERSIONS`.
- Test: `src/persistence.test.ts`, `src/persistence-load.test.ts`

> `<N>` = current committed `SCHEMA_VERSION` (16 today, re-verify). Unlike `migrateV13toV14`, **keep `level`/`xp`** — only refund SP and clear node progression. Locate the level→total-SP function (search `skillPoints`, `spGranted`, `totalSp`, the `1.031^L` curve) and set `unspentSkillPoints` to the full earned total so the player re-spends.

- [ ] **Step 1: Write the failing migration test**

```ts
// src/persistence.test.ts
it('migrateV<N>toV<N+1> refunds SP, clears nodes, keeps xp + buildings', () => {
  const v = makeV<N>Snapshot({ level: 5, xp: 1234, unlockedNodes: ['mining.recipeRate.1'],
                               buildings: [/* one placed building */], inventory: { iron_ore: 50 } });
  const out = migrateV<N>toV<N+1>(v);
  const st = out.islandStates[0].state;
  expect(out.v).toBe(<N+1>);
  expect(st.unlockedNodes).toEqual([]);
  expect(st.unlockedEdges).toEqual([]);
  expect(st.socketBindings).toEqual([]);
  expect(st.level).toBe(5);          // xp/level PRESERVED (unlike v13→v14)
  expect(st.xp).toBe(1234);
  expect(st.unspentSkillPoints).toBe(totalSpForLevel(5)); // full refund
  // buildings + inventory untouched
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/persistence.test.ts -t "migrateV<N>"`. Expected: FAIL (function undefined).

- [ ] **Step 3: Implement** (model on `migrateV13toV14` at `persistence.ts:442`, but keep level/xp)

```ts
export type SerializedSnapshotV<N> = Omit<SaveSnapshot, 'v'> & { readonly v: <N> };

/** v<N> → v<N+1>: skill-tree v2 reset. Node ids changed, so unlockedNodes
 *  is invalid → clear progression + refund all earned SP. Keeps level/xp,
 *  buildings, inventory. */
export function migrateV<N>toV<N+1>(s: SerializedSnapshotV<N>): SaveSnapshot {
  return {
    ...s,
    v: <N+1> as const,
    islandStates: s.islandStates.map((entry) => ({
      ...entry,
      state: {
        ...entry.state,
        unlockedNodes: [],
        unlockedEdges: [],
        socketBindings: [],
        unspentSkillPoints: totalSpForLevel(entry.state.level),
      },
    })),
  } as unknown as SaveSnapshot;
}
```

- [ ] **Step 4: Wire it** — bump `SCHEMA_VERSION` to `<N+1>`; add `<N>` already in `SUPPORTED_LOAD_VERSIONS` and add `<N+1>`; add the dispatch line after the `migrateV<N-1>toV<N>` line (~657):

```ts
    snapshot = migrateV<N>toV<N+1>(snapshot as unknown as SerializedSnapshotV<N>);
```

- [ ] **Step 5: Run persistence suites** — `npx vitest run src/persistence.test.ts src/persistence-load.test.ts`. Expected: PASS (migration + round-trip identity at new version).

- [ ] **Step 6: Commit** — `feat(persistence): v<N>→v<N+1> skilltree-v2 ladder reset`.

---

## Task 7: Combined-ceiling verification (spec §9)

**Files:**
- Test: `src/economy.test.ts` (or a dedicated `skilltree-ceiling.test.ts`)

- [ ] **Step 1:** Write a guard test asserting the stacked ceiling is the intended value: input-eff `÷1.5` × extraction-rate pool `×√10` (× the floor `×(1+L)` from throughput-floors) produces the documented maximum effective throughput, and does **not** exceed it. Pull the intended ceiling number from the spec §9 / re-derive with the product owner.

- [ ] **Step 2:** Run; if the stacked ceiling is higher than intended, the fix is a spec decision (cap interaction), not code — surface it, do not silently clamp.

- [ ] **Step 3: Commit** — `test(skilltree): combined input-eff × rate × floor ceiling guard`.

---

## Final verification

- [ ] `npm test` — full suite green.
- [ ] `npm run build` — clean (strict, noUnused*).
- [ ] `npx vitest run src/mass-balance.test.ts` — green with **no new skips** (proves `recipeInputMul` is invisible to the static auditor — the spec's load-bearing correction).
- [ ] `npx vitest run src/skilltree-budget.test.ts src/skilltree-magnitudes.test.ts` — budgets + caps hold.
- [ ] Manual smoke (after `npm run build` + browser reload): unlock a `*.inputEff` node, confirm a refining building's input drawdown drops and it's T3-gated.

---

## Notes for the executor

- **Magnitudes are never hand-set** — only `POOL_TARGETS` + archetype `count`/chain-shape. If a pool product drifts from its cap, the bug is in the archetype arrays, not the solver.
- **The two fragile, re-ground-at-execution points:** (1) the `economy.ts` input-divisor sites (floors moved them); (2) the T3-gate mechanism for the magic chains. Both are specified by behavior; verify the exact code before writing.
- **Schema numbers are placeholders `<N>`** deliberately — pin them at execution from `persistence.ts`.
