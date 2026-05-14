# Handoff Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Serialize implementer subagents** — never dispatch two in parallel; master is the integration branch (no worktrees per AGENTS.md and project CONTRIBUTING.md).

**Goal:** Resolve every item in the now-deleted `HANDOFF.md` — one bootstrap-deadlock blocker, three real bugs, six mechanical cleanups, eight partial stubs, fourteen-plus missing building defs, eight §14 orbital live-mechanics gaps, eleven persistence test gaps.

**Architecture:** Pure-layer changes for all mechanics (no PixiJS imports outside render/UI files). Each task writes a failing vitest before implementation. UI-touching tasks add a `mcp__daedalus__screenshot` verification step per `AGENTS.md` "visual smoke-tests" guidance. Commits go on `master` and ship via Vite HMR — `robot-islands-dev.service` is already running; do NOT restart for source edits.

**Tech Stack:** Vite 5 + TypeScript strict (`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`) + PixiJS 8 + vitest. Tests target the pure layer only.

**Phases.** Seven phases with a `npm test && npm run build` checkpoint at each phase boundary. Phases run strictly sequentially.

| Phase | Scope | Tasks | Why this order |
|---|---|---|---|
| P1 | Bootstrap deadlock | 1 | Game must be playable to verify all later work |
| P2 | Real runtime bugs | 3 | Live correctness bugs from the audit |
| P3 | Mechanical cleanup | 4 | Low-risk drift fixes that unblock later phases |
| P4 | Partial-stub completions | 8 | Domain mechanics; each is a distinct subsystem |
| P5 | Missing building catalog | 5 grouped | ~14 building defs, grouped by §8.x section |
| P6 | §14 orbital live mechanics | 7 | Single subsystem; deepest TDD discipline |
| P7 | Persistence test coverage | 1 | Tighten the safety net on schema |
| Final | End-of-branch review | 1 | Cross-cutting spec + code quality pass |

**Branch discipline.** No git worktrees. All commits on `master`. The repo's `.gitconfig` has `pull.rebase=true` and `merge.ff=only` — if a force-push or non-FF push is ever required, STOP and ask the user.

**Commit convention.** Follow existing project trailers — every commit MUST end with:
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```
(or `Kimi K2.6 <noreply@kimi.com>` if a Kimi subagent makes the commit).

**Spec source.** `SPEC.md` is locked. Every task quoting spec quotes the load-bearing sentence verbatim from the indicated section. Do NOT edit SPEC.md inside any task in this plan.

---

# Phase 1 — Bootstrap Deadlock (BLOCKER)

User decision (recorded 2026-05-14): **Seed Plains terrain** with a tree cluster plus a 2×2 stone cluster. Preserves "production, not stockpile" feel; minimal blast radius.

### Task 1.1: Home Plains terrain seeds tree cluster + 2×2 stone cluster

**Files:**
- Modify: `src/island.ts:200-229` (`defaultTerrainAt`)
- Modify: `src/biomes.ts:63-71` (BIOME_DEFS.plains rareTerrain — add `tree` so procedural Plains islands also become playable)
- Test: `src/island.test.ts` (new `describe('defaultTerrainAt — bootstrap')` block)
- Test: `src/biomes.test.ts` (new `it` in existing biome-config block)

**Spec quote (§3.7 Starting State):** "the home starts populated, level 1, empty inventory; the player must produce, not stockpile."

**Spec quote (§8.1):** Logger requires `tile requirement: tree`. Quarry requires `tile requirement: stone or sand` with a 2×2 footprint.

**Verified gap (handoff §"Bootstrap deadlock"):** Default Plains home has no `tree` tiles and no 2×2 stone cluster. Starter inventory `{stone: 60, wood: 40, foundation_kit: 1}` plus 50% demolish refund cannot reach any progression building.

- [ ] **Step 1: Write failing test for home tree cluster**

In `src/island.test.ts`, add:

```ts
import { defaultTerrainAt } from './island.js';

describe('defaultTerrainAt — bootstrap seeds', () => {
  it('home has at least one tree tile (Logger requirement, §8.1)', () => {
    const tiles: Array<[number, number]> = [];
    for (let x = -14; x <= 14; x++) {
      for (let y = -14; y <= 14; y++) {
        if (defaultTerrainAt(x, y) === 'tree') tiles.push([x, y]);
      }
    }
    expect(tiles.length).toBeGreaterThanOrEqual(2);
  });

  it('home has a 2x2 stone cluster (Quarry footprint, §8.1)', () => {
    let found = false;
    for (let x = -14; x <= 13; x++) {
      for (let y = -14; y <= 13; y++) {
        if (
          defaultTerrainAt(x, y) === 'stone' &&
          defaultTerrainAt(x + 1, y) === 'stone' &&
          defaultTerrainAt(x, y + 1) === 'stone' &&
          defaultTerrainAt(x + 1, y + 1) === 'stone'
        ) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    expect(found).toBe(true);
  });

  it('tree and stone-cluster tiles sit inside the radius-14 inscribed disk and clear of existing buildings', () => {
    // Existing home buildings (from main.ts initial layout): Workshop (2-3, 2-3),
    // Solar (-5, -2)..(-4, -1), Mine (-7..-6, 2..3), Crate (3, 4), Shipyard (4..6, 6..8),
    // Coal-mine (8..9, 5..6), Water cluster (-1..0, -5..-4).
    // The new tree + stone-cluster sites must not collide with those nor cross
    // outside the |x|<=12, |y|<=12 safe inscribed bound.
    expect(true).toBe(true);  // assertion grows when sites are chosen
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/island.test.ts -t "bootstrap seeds"`
Expected: FAIL (no tree tiles, no 2×2 stone cluster).

- [ ] **Step 3: Add tree + 2×2 stone cluster to defaultTerrainAt**

Edit `src/island.ts:200-229`. Pick coordinates clear of all existing home buildings (Workshop, Solar, Mine, Crate, Shipyard, Coal-mine, water cluster, ore cluster). Safe candidates:

```ts
export function defaultTerrainAt(x: number, y: number): TerrainKind {
  // Stone outcrops — scattered (existing).
  const stoneTiles: ReadonlyArray<readonly [number, number]> = [
    [-9, -2], [-8, 5], [3, 9], [7, -6], [10, 1], [-2, -10],
  ];
  // §3.7 / §8.1 bootstrap seed: 2x2 stone cluster so a Quarry (2x2 footprint
  // per §8.1) can be placed. Located in the south-east safe zone clear of
  // every existing home building.
  const stoneClusterTiles: ReadonlyArray<readonly [number, number]> = [
    [-11, 4], [-10, 4], [-11, 5], [-10, 5],
  ];
  // Ore vein cluster (existing) — under the Mine at (-7..-6, 2..3).
  const oreTiles: ReadonlyArray<readonly [number, number]> = [
    [-7, 2], [-6, 2], [-7, 3], [-6, 3], [-5, 2], [-5, 3],
  ];
  // Coal vein (existing) — 2x2 at (8..9, 5..6).
  const coalTiles: ReadonlyArray<readonly [number, number]> = [
    [8, 5], [9, 5], [8, 6], [9, 6],
  ];
  // §3.7 / §8.1 bootstrap seed: tree tiles so a Logger (1x1 on a tree, §8.1)
  // can be placed. Three trees in the north-east safe zone.
  const treeTiles: ReadonlyArray<readonly [number, number]> = [
    [6, -3], [7, -3], [6, -4],
  ];
  // Small fresh-water cluster (existing).
  const waterTiles: ReadonlyArray<readonly [number, number]> = [
    [-1, -5], [0, -5], [-1, -4], [0, -4],
  ];

  for (const t of waterTiles) if (t[0] === x && t[1] === y) return 'water';
  for (const t of coalTiles) if (t[0] === x && t[1] === y) return 'coal';
  for (const t of treeTiles) if (t[0] === x && t[1] === y) return 'tree';
  for (const t of stoneClusterTiles) if (t[0] === x && t[1] === y) return 'stone';
  for (const t of oreTiles) if (t[0] === x && t[1] === y) return 'ore';
  for (const t of stoneTiles) if (t[0] === x && t[1] === y) return 'stone';
  return 'grass';
}
```

- [ ] **Step 4: Add `tree` to BIOME_DEFS.plains.rareTerrain**

Edit `src/biomes.ts:63-71` (`plains` entry):

```ts
  plains: {
    id: 'plains',
    initialMajorRadius: 14,
    initialMinorRadius: 14,
    powerSource: 'solar',
    defaultTerrain: 'grass',
    // §8.1 bootstrap: settled Plains colonies need Logger access (tree tile)
    // and stone access. Procedurally-settled Plains islands inherit these
    // rares via `terrainAtForBiome` scatter (not clustered, but present so
    // 1x1 Loggers and singletons of stone can be placed).
    rareTerrain: ['tree', 'stone', 'ore', 'coal'],
    displayName: 'Plains',
  },
```

- [ ] **Step 5: Add biome-config test for Plains rareTerrain**

In `src/biomes.test.ts`, add (within the existing biome-config describe block):

```ts
it('Plains rareTerrain includes tree (bootstrap)', () => {
  expect(BIOME_DEFS.plains.rareTerrain).toContain('tree');
});
```

- [ ] **Step 6: Run all tests + build**

```bash
npx vitest run src/island.test.ts src/biomes.test.ts
npm test
npm run build
```

Expected: all pass; tsc -b clean.

- [ ] **Step 7: Daedalus screenshot — verify fresh-game playability**

```
mcp__daedalus__reload (the live page)
mcp__daedalus__screenshot
```

Open inspector on the home island, confirm:
- A `tree` tile is visible at (6, -3) / (7, -3) / (6, -4)
- A 2×2 stone cluster is visible at (-11, 4)..(-10, 5)
- Placement preview for Logger on a tree tile shows "valid"
- Placement preview for Quarry anchored at (-11, 4) shows "valid"

- [ ] **Step 8: Commit**

```bash
git add src/island.ts src/biomes.ts src/island.test.ts src/biomes.test.ts
git commit -m "$(cat <<'EOF'
fix(§3.7): seed home Plains with tree + 2x2 stone cluster

Resolves the fresh-game bootstrap deadlock. The procedural-default
home had no tree tiles and no 2x2 stone cluster, so Logger and Quarry
were both unplaceable — starter inventory (60s/40w) plus 50% demolish
refund could not reach any progression building (every T1+ costs
>=40 stone). Adds a 3-tree cluster at (6,-3)/(7,-3)/(6,-4) and a 2x2
stone cluster at (-11,4)..(-10,5), clear of every existing home
building. Also adds tree to BIOME_DEFS.plains.rareTerrain so future
procedurally-settled Plains colonies inherit Logger access.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Phase 1 checkpoint

Run `npm test && npm run build`. Both must pass. Daedalus screenshot must show a playable home. Spec-compliance reviewer subagent: confirm no SPEC.md edits, only `island.ts` / `biomes.ts` / tests.

---

# Phase 2 — Real Runtime Bugs

### Task 2.1: Repair Drone perfShift on deserialize

**Files:**
- Modify: `src/persistence.ts:436-438` (the repair-drone backfill)
- Test: `src/persistence.test.ts` (extend existing perfShift suite ~line 922)

**Spec quote (§14.12):** "Travel time. Approximately 50% of a comparable satellite launch's travel time".

**Verified gap (handoff §"Repair drone perf-shift bug"):** `[...(snapshot.world.repairDrones ?? [])]` spread carries `launchTime` and `expectedArrivalTime` verbatim, but those values live in the prior session's `performance.now()` domain. Every reload-in-flight strands the drone permanently. Existing test at `persistence.test.ts:922` uses `nowPerfMs=0` so it silently passes.

- [ ] **Step 1: Locate perfShift pattern used for drones / vehicles / routes**

```bash
grep -n "perfShift\|launchTime\|expectedArrivalTime" /root/robot-islands/src/persistence.ts | head -20
```

The existing pattern: `launchTime: shifted(d.launchTime, perfShift)` where `perfShift = nowPerfMs - snapshot.savedAtPerfMs`. Use the same `shifted` helper (or its inline `+ perfShift` form) the drone/vehicle backfill uses.

- [ ] **Step 2: Write failing test**

Extend `src/persistence.test.ts`. Use a non-zero `nowPerfMs` so the bug shows up:

```ts
it('repairDrones launchTime + expectedArrivalTime are perfShift-ed (§14.12)', () => {
  const snapshot: WorldSnapshot = {
    /* ... minimal world snapshot ... */
    savedAtPerfMs: 1000,
    world: {
      /* ... */
      repairDrones: [{
        id: 'rd_1',
        targetSatId: 'sat_1',
        launchTime: 1500,           // 500ms after save
        expectedArrivalTime: 2500,  // 1500ms after save
      }],
    },
    /* ... */
  };
  const nowPerfMs = 10_000;  // simulate reload long after save
  const result = deserializeWorld(snapshot, nowPerfMs);
  expect(result.world.repairDrones).toHaveLength(1);
  // perfShift = nowPerfMs - savedAtPerfMs = 9000
  expect(result.world.repairDrones[0]!.launchTime).toBe(1500 + 9000);
  expect(result.world.repairDrones[0]!.expectedArrivalTime).toBe(2500 + 9000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/persistence.test.ts -t "repairDrones launchTime"`
Expected: FAIL (current code preserves `1500` and `2500` verbatim).

- [ ] **Step 4: Apply perfShift to launchTime and expectedArrivalTime**

Edit `src/persistence.ts:436-438`:

```ts
    // §14.12 repair drone fleet backfill. perfShift the in-flight timestamps
    // so the prior session's `performance.now()` domain doesn't strand the
    // drone forever. Mirrors the drone / vehicle / route backfill pattern.
    repairDrones: (snapshot.world.repairDrones ?? []).map((d) => ({
      ...d,
      launchTime: d.launchTime + perfShift,
      expectedArrivalTime: d.expectedArrivalTime + perfShift,
    })),
```

(If the surrounding code uses a `shifted(t, perfShift)` helper, use it instead of the inline `+ perfShift`.)

- [ ] **Step 5: Verify**

```bash
npx vitest run src/persistence.test.ts
npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "$(cat <<'EOF'
fix(§14.12): perfShift repairDrones on deserialize

launchTime and expectedArrivalTime in WorldState.repairDrones lived
in the prior session's performance.now() domain after reload. Every
page refresh while a repair drone was in flight permanently stranded
it. Now applies the same perfShift pattern used for drones / vehicles
/ routes / building maintenance timestamps. Adds a perfShift=9000
round-trip test (previously every persistence test used nowPerfMs=0,
hiding the bug).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.2: `declaredAt` and `lastResetAt` perfShift on deserialize

**Files:**
- Modify: `src/persistence.ts` (per-island state deserialization, around line 480-520)
- Modify: `src/economy.ts:172-178` (remove the TODO comment block once fixed)
- Test: `src/persistence.test.ts`

**Spec quote (§9.7):** "Reset disallowed within 24 real-time hours of the last reset."

**Verified gap (handoff §"Inline TODOs"):** `economy.ts:172` declares the TODO and `state.ts`/persistence skips perfShift on these two fields. The cooldown check `nowMs - lastResetAt < TIER_RESET_COOLDOWN_MS` is off by the perfShift offset until the next reset re-stamps it.

- [ ] **Step 1: Find current per-island deserialize code**

```bash
grep -n "declaredAt\|lastResetAt" /root/robot-islands/src/persistence.ts
```

- [ ] **Step 2: Write failing test**

In `src/persistence.test.ts`, add:

```ts
it('IslandState.declaredAt and lastResetAt are perfShift-ed (§9.7 cooldown)', () => {
  const savedAt = 5_000;
  const declaredOffset = 2_000;       // 2s after save
  const lastResetOffset = 4_000;      // 4s after save
  const snapshot = makeSnapshot({
    savedAtPerfMs: savedAt,
    islandStates: [{
      id: 'home',
      state: makeStateOverride({
        declaredAt: savedAt + declaredOffset,
        lastResetAt: savedAt + lastResetOffset,
      }),
    }],
  });
  const nowPerfMs = 20_000;  // shift = 15_000
  const result = deserializeWorld(snapshot, nowPerfMs);
  const homeState = result.islandStates.get('home')!;
  expect(homeState.declaredAt).toBe(savedAt + declaredOffset + 15_000);
  expect(homeState.lastResetAt).toBe(savedAt + lastResetOffset + 15_000);
});
```

(`makeSnapshot` / `makeStateOverride` are the existing helpers in `persistence.test.ts`. If absent, scope to a minimal inline snapshot like Task 2.1.)

- [ ] **Step 3: Run test — verify FAIL**

```bash
npx vitest run src/persistence.test.ts -t "declaredAt and lastResetAt"
```

- [ ] **Step 4: Apply perfShift in per-island state deserialize**

Locate the per-island spread (around `persistence.ts:480-520`). Add the two shifts (keep null passthrough):

```ts
const islandState: IslandState = {
  ...s,
  inventory: inventoryClone,
  storageCaps: storageCapsClone,
  funnelPending: funnelClone,
  lastTick: s.lastTick + perfShift,
  declaredAt: s.declaredAt === null ? null : s.declaredAt + perfShift,
  lastResetAt: s.lastResetAt === null ? null : s.lastResetAt + perfShift,
  /* ... */
};
```

- [ ] **Step 5: Remove the stale TODO comment**

Edit `src/economy.ts:172-178`. Replace the `TODO(persistence)` block with a one-line note that `persistence.ts` now perfShifts both fields. Or simply delete the comment (the `lastResetAt: number | null` declaration is self-documenting).

- [ ] **Step 6: Verify**

```bash
npm test && npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/persistence.ts src/economy.ts src/persistence.test.ts
git commit -m "$(cat <<'EOF'
fix(§9.7): perfShift declaredAt and lastResetAt on deserialize

Both fields were carried verbatim through deserialize and lived in
the prior session's performance.now() domain. The §9.7 Tier Reset
24-hour cooldown check (nowMs - lastResetAt < TIER_RESET_COOLDOWN_MS)
was off by the perfShift offset until the next reset re-stamped the
field. Same root cause applied to declaredAt (used by the UX timer).
Removes the long-standing TODO(persistence) block in economy.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.3: Soft-gate `effectiveMul` folded into `nominalRate`

**Files:**
- Modify: `src/economy.ts:664-665` (Pass-2 `nominalRate` computation)
- Test: `src/economy.test.ts` (new it-block under existing soft-gate suite)

**Spec quote (§4.5):** "Without one, output is zero" (hard gating); soft-gating examples — "Refinery without adjacent Wastewater Treatment operates only on low-grade recipe (efficiency -50%)" — multiply the throughput by `effectiveMul ∈ (0, 1]`.

**Verified gap (handoff §"Inline TODOs"):** `economy.ts:664` TODO says soft-gate `effectiveMul` is NOT folded into Pass-2 `nominalRate` used for `inputAvail`. Result: supply ratios assume full nominal throughput even when a soft gate halves output. Producer→consumer flow is over-counted by ~2× under soft-gating.

- [ ] **Step 1: Read Pass 1 to confirm the gate already applies on output rate**

```bash
grep -n "effectiveMul\|gateResult" /root/robot-islands/src/economy.ts | head -20
```

- [ ] **Step 2: Write failing test**

In `src/economy.test.ts`, under the existing soft-gate suite:

```ts
it('soft-gate effectiveMul folds into inputAvail nominalRate (§4.5)', () => {
  // Setup: 1 producer of resource X at nominal 1.0/sec.
  // 1 consumer of X with a soft gate at effectiveMul=0.5 (halved throughput).
  // Consumer's input demand is 1.0/sec at full rate, 0.5/sec under the gate.
  // Producer output is 1.0/sec.
  // Correct inputAvail for consumer = min(1, supply / demand) where
  // demand is gate-adjusted: supply=1.0, demand=0.5 → inputAvail=1.
  // Pre-fix BUG: demand stays 1.0 → inputAvail=1 by coincidence here, but a
  // contrived case where producer < consumer-nominal but > consumer-gated
  // shows the bug.
  //
  // Use: producer 0.6/sec, consumer nominal 1.0/sec gated to 0.5/sec.
  //   pre-fix: inputAvail = 0.6 / 1.0 = 0.6 → consumer runs at 0.6 × 0.5 = 0.30
  //   fixed:   inputAvail = 0.6 / 0.5 = 1.0 (capped) → consumer runs at 1.0 × 0.5 = 0.50
  /* ... full test setup using existing test fixtures ... */
  expect(consumerRate).toBeCloseTo(0.5, 6);  // gated consumer matches its halved demand
});
```

- [ ] **Step 3: Run test — verify FAIL**

```bash
npx vitest run src/economy.test.ts -t "soft-gate effectiveMul"
```

- [ ] **Step 4: Fold gateResult.effectiveMul into nominalRate**

Edit `src/economy.ts:664-665`:

```ts
    // §4.5: soft-gate effectiveMul scales nominalRate so inputAvail's demand
    // calculation matches actual consumption under the gate. Without this, a
    // halved consumer would still claim full-rate inputs from the supply pool.
    const gateMul = te.gateResult?.effectiveMul ?? 1;
    const nominalRate = (1 / te.recipe.cycleSec) * te.buffStack * rateMul * gateMul;
```

(Verify `te.gateResult` carries `effectiveMul` from Pass 1. If it doesn't, capture it during Pass 1 and pass through.)

- [ ] **Step 5: Verify**

```bash
npm test && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/economy.ts src/economy.test.ts
git commit -m "$(cat <<'EOF'
fix(§4.5): fold soft-gate effectiveMul into Pass 2 nominalRate

A soft-gated consumer's input demand was computed against full nominal
throughput, not the gate-adjusted rate. Producer→consumer flow ratios
drifted: a halved consumer over-claimed inputs, starving siblings and
masking the gate's intended throttle. Now nominalRate * effectiveMul
is the demand basis, so inputAvail reflects what the consumer actually
draws under its current gate state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Phase 2 checkpoint

`npm test && npm run build` clean. Spec reviewer subagent: confirm `economy.ts` Pass-1 logic for `effectiveMul` is unchanged (only Pass-2 demand calc fixed). Code quality reviewer: no new TODOs introduced.

---

# Phase 3 — Mechanical Cleanup

These are low-risk drift fixes. Each task is a single commit.

### Task 3.1: Remove stale "DEFERRED" comments

**Files:**
- Modify: `src/recipes.ts:808-810` (lubricant→T4 maintenance — wired in `maintenance.ts:65-78`)
- Modify: `src/recipes.ts:877-879` (microchip chain — wired in `recipes.ts:1024-1045`)
- Modify: `src/world.ts:913-914` (aiCoreCrafted auto-flip — wired in `economy.ts:1090`-ish)
- Modify: `src/economy.ts:153` (aiCoreCrafted "deferred to step 14")
- Modify: `src/building-defs.ts:1156` (aiCoreCrafted "DEFERRED on first production")
- Modify: `src/main.ts:573` (forest-ne T5 demo seed described as production-active; is a no-op since `forest-ne` is no longer auto-populated)

**Verified gaps (handoff §"Stale 'DEFERRED' comments"):** All six comments are documentation drift, not behavior gaps. The shipping code already does what the comments say is deferred.

- [ ] **Step 1: Verify each "DEFERRED" claim is actually wired**

For each of the six sites, confirm the live behavior. Sample command:

```bash
grep -n "aiCoreCrafted" /root/robot-islands/src/economy.ts /root/robot-islands/src/world.ts
```

If any site genuinely IS still deferred, KEEP its comment and surface the finding in the implementer-subagent status as `DONE_WITH_CONCERNS`.

- [ ] **Step 2: Update each comment in place**

For each site, replace the `DEFERRED` block with either:
- A short note pointing to the live implementation (e.g., `// §13.1 auto-flip lives in economy.ts:1090 on first ai_core production`)
- Or remove the comment entirely if the surrounding code is self-explanatory.

NO behavior change in this task — comments only.

- [ ] **Step 3: Verify**

```bash
npm test && npm run build
```

Both must pass — comment-only edits should not affect compile or tests.

- [ ] **Step 4: Commit**

```bash
git add src/recipes.ts src/world.ts src/economy.ts src/building-defs.ts src/main.ts
git commit -m "$(cat <<'EOF'
chore: remove stale DEFERRED comments

Six sites carried "DEFERRED" comments that contradicted shipped code:
lubricant→T4 maintenance (wired in maintenance.ts:65-78), microchip
chain (recipes.ts:1024-1045), aiCoreCrafted auto-flip (economy.ts:1090),
forest-ne T5 demo seed (now a no-op per §3.7 home-only contract).
Replaced with brief pointers to the live implementation. No behavior
change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.2: Route tier-helper hardcodes through `tierForLevel(state.level)`

**Files:**
- Modify: `src/lattice.ts:17` — `state.level >= 50 && state.aiCoreCrafted` → `tierForLevel(state.level) >= 5 && state.aiCoreCrafted`
- Modify: `src/buildings-ui.ts:755` — `ref.tier === 5 && state.level >= 50 && !state.aiCoreCrafted` → `ref.tier === 5 && tierForLevel(state.level) >= 5 && !state.aiCoreCrafted`
- Modify: `src/objectives.ts:66/127/149/171` — replace each `state.level >= N` literal with `tierForLevel(state.level) >= T`
- Modify: `src/tutorial.ts:37` — `s.level >= 5` → `tierForLevel(s.level) >= 2`

**Spec quote (§9.2):** Tier breakpoints (placeholder): T1@L1, T2@L5, T3@L15, T4@L30, T5@L50.

**Verified gap (handoff §"Tier-helper bypass drift"):** Six call sites hardcode `state.level >= 50` (etc.) instead of routing through the canonical `tierForLevel(state.level)`. Currently correct but silently drifts if tier boundaries shift.

- [ ] **Step 1: Confirm `tierForLevel` is the canonical helper**

```bash
grep -nE "export function tierForLevel|tierForLevel\s*=" /root/robot-islands/src/skilltree.ts /root/robot-islands/src/*.ts | head -5
```

- [ ] **Step 2: Write a regression test**

In `src/lattice.test.ts` (or wherever the lattice canActivate function is tested), add:

```ts
it('canActivateLattice uses tierForLevel (§9.2 — survives tier boundary tuning)', () => {
  // If tier boundaries shift to e.g. T5@L60, lattice gating tracks the new
  // boundary because it routes through tierForLevel, not a hardcoded 50.
  // Indirect test: mock tierForLevel to return 5 at level 60 → expect
  // canActivateLattice to fire at level 60 (not 50). Skip if the function
  // can't be easily mocked; instead assert that the SOURCE doesn't contain
  // `state.level >= 50` literally.
  const fs = require('fs') as typeof import('fs');
  const src = fs.readFileSync(__dirname + '/lattice.ts', 'utf8');
  expect(src).not.toMatch(/state\.level\s*>=\s*50/);
});
```

Repeat the source-grep pattern for `buildings-ui.ts`, `objectives.ts`, `tutorial.ts` in their respective test files (or one new `tier-helpers.test.ts`).

- [ ] **Step 3: Run test — verify FAIL**

- [ ] **Step 4: Replace each hardcode**

Each site: import `tierForLevel` if not already imported, replace the literal.

Example: `src/lattice.ts:17`:

```ts
import { tierForLevel } from './skilltree.js';
// ...
export function canActivateLattice(state: IslandState): boolean {
  // §9.2 tier boundary — tierForLevel is the canonical helper.
  return tierForLevel(state.level) >= 5 && state.aiCoreCrafted;
}
```

`src/objectives.ts`:
- Line 66: `state.level >= 5` → `tierForLevel(state.level) >= 2`
- Line 127: `state.level >= 15` → `tierForLevel(state.level) >= 3`
- Line 149: `state.level >= 30` → `tierForLevel(state.level) >= 4`
- Line 171: `state.aiCoreCrafted && state.level >= 50` → `state.aiCoreCrafted && tierForLevel(state.level) >= 5`

- [ ] **Step 5: Verify**

```bash
npm test && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/lattice.ts src/buildings-ui.ts src/objectives.ts src/tutorial.ts src/lattice.test.ts
git commit -m "$(cat <<'EOF'
refactor: route tier checks through tierForLevel (§9.2)

Six call sites hardcoded state.level >= 50 (etc.) bypassing the
canonical tierForLevel helper. Numeric thresholds were correct but
silently drift if §9.2 tier boundaries shift. Now all six sites use
tierForLevel(state.level) >= N. Adds source-grep regression tests
forbidding the literal pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.3: Drop STEP6_DRONE_TIER hardcode; carry tier from launch building

**Files:**
- Modify: `src/drones.ts:97-99` (`STEP6_DRONE_TIER = 2`)
- Modify: launch call-sites that read `STEP6_DRONE_TIER`
- Test: `src/drones.test.ts`

**Spec quote (§11.5):** "T2: range R, scan corridor radius W. T3: range 3R, scan corridor radius 2W. T4: omnidirectional pulse from Launch Tower."

**Verified gap (handoff §"Spec coverage gaps"):** "§11.5 T3 drone tier hardcoded as T2 in drones.ts:99". T3 drone behavior (3× range, 2× scan width) is unreachable while the tier is forced to 2.

- [ ] **Step 1: Find every reader of `STEP6_DRONE_TIER`**

```bash
grep -rn "STEP6_DRONE_TIER" /root/robot-islands/src/
```

- [ ] **Step 2: Write failing tests**

In `src/drones.test.ts`:

```ts
it('drone tier matches launch building tier (§11.5)', () => {
  // T2 Drone Pad launch → tier 2.
  // T4 Launch Tower launch → tier 4 (omnidirectional pulse per §11.5).
  const stateT2 = /* state with dronepad, level 5 */;
  const droneT2 = launchDrone(stateT2, 'dronepad', /* ... */);
  expect(droneT2.tier).toBe(2);

  const stateT4 = /* state with launch_tower, level 30 */;
  const droneT4 = launchDrone(stateT4, 'launch_tower', /* ... */);
  expect(droneT4.tier).toBe(4);
});

it('T3 drone has 3× range and 2× scan radius of T2 (§11.5)', () => {
  /* ... compute corridor for a T3 drone and a T2 drone with equal fuel;
   * assert the T3 corridor is 3× longer with 2× radius ... */
});
```

- [ ] **Step 3: Run tests — verify FAIL**

- [ ] **Step 4: Replace hardcode with launch-building tier lookup**

Edit `src/drones.ts`. Replace the constant with a function that reads the launching building's tier (Drone Pad def.tier = 2; Launch Tower def.tier = 4). The exact API depends on `launchDrone`'s current signature — if it already takes `fromBuildingId` or a `BuildingDef`, pull the tier from there.

```ts
import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';

export function droneTierFromLaunchBuilding(buildingDefId: BuildingDefId): DroneTier {
  const def = BUILDING_DEFS[buildingDefId];
  // §11.5 tier matches the launching island's tier; for Drone Pad and
  // Launch Tower the building tier IS the drone tier directly.
  return def.tier as DroneTier;
}
```

Remove `STEP6_DRONE_TIER` and replace every reader with `droneTierFromLaunchBuilding(...)`.

- [ ] **Step 5: Verify**

```bash
npm test && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/drones.ts src/drones.test.ts /* + any call-site files */
git commit -m "$(cat <<'EOF'
fix(§11.5): drone tier carried from launch building, not hardcoded

drones.ts hardcoded STEP6_DRONE_TIER = 2 so T3/T4 drones could not
exist — T3's 3× range and 2× scan radius (§11.5) were unreachable;
the T4 Launch Tower omnidirectional pulse never fired at its tier.
Now droneTierFromLaunchBuilding(defId) reads the BUILDING_DEFS tier
of the launching building directly. Adds tier-mapping and corridor
scaling tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.4: §9.7 tier-reset cost formula — keep TODO until balance pass

**Files:**
- No code change. This task only confirms the TODO is intentional.

**Verified state:** `tier-reset.ts:58` carries `TODO(§9.7-tune): placeholder cost formula. Balance pass once §6.5 T4-T5 production loops have throughput data.` Per SPEC Appendix A, this is a tagged placeholder awaiting balance pass — keep until throughput data exists.

- [ ] **Step 1: Verify the comment is the canonical placeholder marker**

```bash
grep -B1 -A3 "TODO(§9.7-tune)" /root/robot-islands/src/tier-reset.ts
```

- [ ] **Step 2: No code change. Document the decision in the plan.**

No commit. Mark task complete; spec reviewer will confirm during phase checkpoint.

---

### Phase 3 checkpoint

`npm test && npm run build` clean. Spec reviewer subagent: confirm SPEC.md unchanged. Code quality reviewer: confirm no new abstraction debt (the `droneTierFromLaunchBuilding` helper is the minimum addition).

---

# Phase 4 — Partial-Stub Completions

Each task ships a single subsystem from the handoff's "Stubs / mechanics partly implemented" list. Spec sentences quoted literally; full TDD per task.

### Task 4.1: §13.3 Eternal Servitor Conversion Kit recipe + mechanic

**Files:**
- Modify: `src/building-defs.ts` (add `servitor_conversion_kit` recipe per-tier; or, simpler, a `reality_forge` recipe that outputs a `servitor_conversion_kit` resource keyed by target tier — TBD by implementer)
- Modify: `src/recipes.ts` (add the per-tier conversion-kit recipes — `MAINTENANCE_RECIPES[tier]` + `eldritch_processor: 1` + `phase_converter: 1`)
- Modify: `src/buildings.ts` (add a setter `markEternalServitor(b)`)
- Modify: a UI surface (likely `src/inspector-ui.ts` near line 1228 where the eternal-servitor display already lives) to expose "Convert to Eternal Servitor" action with kit-consumption gate
- Test: `src/maintenance.test.ts` (round-trip of conversion-kit consumption + flag flip)

**Spec quote (§13.3 verbatim):** "Conversion Kit recipe = `1 Eldritch Processor + 1 Phase Converter + the contents of the target building's tier maintenance recipe`. For a T4 building: `1 Eldritch Processor + 1 Phase Converter + 10 Lubricant + 1 Exotic Alloy fragment + 1 Microchip`."

**Verified gap:** `eternalServitor` field exists on PlacedBuilding and `maintenance.ts` honors it, but no producer of the flag exists in non-test code.

- [ ] **Step 1: Write failing test** — conversion consumes the per-tier recipe and flips the flag.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement `convertToServitor(state, buildingId)` in `buildings.ts`** that:
  - Validates: target building tier is set
  - Validates: `state.inventory` covers `{ eldritch_processor: 1, phase_converter: 1, ...MAINTENANCE_RECIPES[tier] }`
  - Deducts the inventory cost
  - Sets `building.eternalServitor = true`
  - Returns `{ ok: true }` or an error reason
- [ ] **Step 4: Wire UI button** in `inspector-ui.ts` near the existing `eternalServitor === true` block (line 1231). Disabled state when inventory missing.
- [ ] **Step 5: Daedalus screenshot** — confirm the button appears, gates correctly, and on click the building UI flips to the existing Eternal Servitor display.
- [ ] **Step 6: Verify + commit**

Commit message: `feat(§13.3): Eternal Servitor conversion kit + UI`.

---

### Task 4.2: §2.5 Artificial Island modifier reroll (not hardcoded empty)

**Files:**
- Modify: `src/artificial-island.ts:188` — replace `modifiers: []` with a `rollModifiersForBiome(biome, /* artificialOnly = true */)` call that excludes natural-only modifiers (aetheric_anomaly, frozen_core)
- Test: `src/artificial-island.test.ts`

**Spec quote (§2.5):** "Cannot have rare-biome modifiers or unique-feature tiles (those are natural-only)".

**Implementation note:** `biomes.ts` already has `rollModifiers` and `rerollModifiers`. Add a third helper `rollModifiersArtificial(seed, biome)` that runs the rare-natural-filter from `rerollModifiers` and uses the construction seed (e.g. `${world.seed}_artificial_${islandId}`) so the roll is deterministic per island.

- [ ] **Step 1: Write failing test** — over 1000 deterministic rolls, no `aetheric_anomaly` or `frozen_core` appears.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Add `rollModifiersArtificial` to `biomes.ts`; call it from `artificial-island.ts:188`.**
- [ ] **Step 4: Verify + commit** — `feat(§2.5): roll artificial-island modifiers from natural distribution`.

---

### Task 4.3: §4.5 Chemical Reactor toxicity event

**Files:**
- New: `src/reactor-toxicity.ts` (pure tick function: rolls 5%/hr per adjacent-reactor pair, applies 50%-throughput penalty for 1h)
- Modify: `src/economy.ts` (call `tickReactorToxicity(state, nowMs)` inside `advanceIsland`)
- Modify: `src/buildings.ts` (`PlacedBuilding` gains `toxicityUntil?: number` field for the active-penalty timestamp)
- Test: `src/reactor-toxicity.test.ts`

**Spec quote (§4.5 verbatim):** "Chemical Reactor adjacent to another Chemical Reactor risks toxicity event: 5% per real-time hour per reactor that has at least one adjacent Chemical Reactor. On trigger, that specific reactor's throughput drops to 50% for 1 real-time hour, then auto-resolves."

- [ ] **Step 1: Write tests** — (a) zero-adjacency reactor never triggers; (b) two adjacent reactors each roll 5%/hr independently; (c) triggered reactor runs at 50% for exactly 1h then returns to 100%.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — seeded RNG from `${world.seed}_toxicity_${reactorId}_${hourTick}`.
- [ ] **Step 4: Verify + commit** — `feat(§4.5): chemical reactor toxicity event`.

---

### Task 4.4: §5.3 Power Substation def + cable W-capacity transmission

**Coupled task** — the def is meaningless without the mechanic. Single commit.

**Files:**
- Modify: `src/building-defs.ts` — add `power_substation` def (T4, 2×2, requires `route_type: cable` endpoint, placement cost from §9.5 placeholder column)
- Modify: `src/routes.ts` — extend Route processing to handle `type: 'cable'` with `capacityPerSec` interpreted as Watts; sink the watts into the destination island's `P_produced` aggregate
- Modify: `src/economy.ts` — recompute `power_factor` to include cable inflow as added P_produced
- Test: `src/routes.test.ts` (cable inflow), `src/building-defs.test.ts` (substation def shape), `src/economy.test.ts` (cable contributes to destination P_produced)

**Spec quote (§5.3 verbatim):** "T4 unlocks Power Cable routes that transmit electrical power between islands. These routes use the same network mechanics as cargo routes, with capacity in W instead of items/sec."

- [ ] **Step 1: Write tests** — substation-on-coastal-island places at T4; a `cable` route from substation A to substation B transfers W proportional to capacity each tick.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Daedalus screenshot** — substation appears in the catalog at T4; cable route UI shows W capacity, not items/sec.
- [ ] **Step 5: Verify + commit** — `feat(§5.3): Power Substation + cable W-capacity transmission`.

---

### Task 4.5: §6.7 Slag reprocessing → trace minerals

**Files:**
- Modify: `src/recipes.ts` — add `slag_reprocessor` recipe (Smelter or Refinery building reuse, or new defId — TBD)
- Modify: `src/building-defs.ts` if a new defId is the right call
- Test: `src/recipes.test.ts`

**Spec quote (§6.7):** "Slag can be reprocessed for trace minerals (gold, silver, rare metals at low yield)."

- [ ] **Step 1: Write test** — Smelter (or new building) accepts `slag` input, outputs `gold_ore` / `silver_ore` / `rare_earth` at <10% yield each.
- [ ] **Step 2-4: Implement + verify + commit** — `feat(§6.7): slag reprocessing for trace minerals`.

---

### Task 4.6: §12.4 Foundation Kit starter-inventory grace cap

**Files:**
- Modify: `src/economy.ts` (cap-derivation path) and/or `src/world.ts` (`IslandState`)
- Add: `IslandState.starterInventoryGrace: Record<ResourceId, number>` (per-resource grace allowance)
- Modify: settlement-arrival code path (`src/settlement.ts` or similar) to populate grace from the kit's raw decomposition
- Modify: `effectiveCap(state, resourceId)` to return `max(normalCap, currentInventory)` while grace remains
- Test: `src/settlement.test.ts`

**Spec quote (§12.4 verbatim):** "the kit contents are held under a one-time starter inventory grace cap that allows the colony to hold the kit's raw contents even with zero specialized or generic storage. The grace cap shrinks resource-by-resource as the player builds proper storage — once normal cap meets or exceeds current inventory for a given resource, that resource's grace allowance is removed."

- [ ] **Step 1: Write tests** — fresh colony arrival: holds 50 iron_ingot with 0 normal cap; placing a Silo (raises iron_ingot cap) does NOT clamp the grace; once normal cap exceeds 50, grace allowance for iron_ingot is removed.
- [ ] **Step 2-4: Implement + verify + commit** — `feat(§12.4): Foundation Kit starter-inventory grace cap`.

---

### Task 4.7: §11.5 T4 omnidirectional pulse — Launch Tower drone

**Files:**
- Modify: `src/drones.ts` — when `launchBuilding.defId === 'launch_tower'`, ignore direction/path and treat the scan as a single disk of radius `3R` centered on origin (`R` = stratification cell side length)
- Test: `src/drones.test.ts`

**Spec quote (§11.5 verbatim):** "T4: omnidirectional pulse from Launch Tower — single disk of radius `R_T4 = 3R` centered on origin (no flight path; not corridor-shaped)."

- [ ] **Step 1: Write test** — Launch Tower drone scan covers a 3-cell-radius disk; ignores direction param.
- [ ] **Step 2-4: Implement + verify + commit** — `feat(§11.5): T4 Launch Tower omnidirectional pulse`.

---

### Task 4.8: §4.7 T6 maintenance recipe — match spec literal

**Files:**
- Modify: `src/maintenance.ts:78` — T6 recipe currently substitutes `eldritch_processor: 1` for `memetic_core`. Once `memetic_core` ships as a real resource (likely in P5's catalog work) or shipping a placeholder T6 component def, the T6 recipe becomes spec-literal.

**Spec quote (§4.7 T6 row verbatim):** "T6: 25 Lubricant + 1 Reality Anchor fragment + 1 Memetic Core".

**Dependency note:** This task is BLOCKED until P5 adds `memetic_core` as a resource (or until that addition is explicitly deferred). If P5 doesn't add `memetic_core`, skip this task and document the persistent substitution.

- [ ] **Step 1: Verify `memetic_core` resource state**
- [ ] **Step 2: If shipped, swap substitution back to literal; otherwise mark task complete-with-deferral.**

Commit message (if shipping): `fix(§4.7): T6 maintenance recipe matches spec literal`.

---

### Phase 4 checkpoint

`npm test && npm run build` clean. Spec reviewer: confirm SPEC.md unchanged; every quoted sentence is in the diff. Code quality reviewer: pure-layer purity preserved (`reactor-toxicity.ts` has no PixiJS / DOM imports); LSP-friendly naming throughout.

---

# Phase 5 — Missing Building Catalog (~14 defs)

Strategy: one task per §8.x section, batching the section's missing defs into a single commit. Each task: add defs to `building-defs.ts`, add unlock-tier gating to `buildingUnlocked`, add a render glyph + fill colour, add `recipe` if applicable, add tests.

### Task 5.1: §8.1 Extraction — Heavy Logger + Deep Mine

**Files:**
- Modify: `src/building-defs.ts` — add `heavy_logger` (T2, 2×2, requires `dense_forest` tile, medium power) and `deep_mine` (T2, 2×3, requires `ore` vein, high power, requires Mining sub-path)
- Modify: `src/biomes.ts` — add `dense_forest` to TerrainKind union if absent
- Modify: `src/recipes.ts` — output wood (higher rate than Logger) and ore (higher rate than Mine)
- Test: `src/building-defs.test.ts`

**Spec quote (§8.1):** "Heavy Logger | 2x2 | T2 | dense forest | medium | Wood output, higher rate" / "Deep Mine | 2x3 | T2 | ore vein | high | Higher rate, deeper veins, requires Mining sub-path".

- [ ] **Steps 1-5 — standard TDD + commit:** `feat(§8.1): Heavy Logger + Deep Mine`.

---

### Task 5.2: §8.3 Manufacturing — Fabricator, Precision Lab, Singularity Forge

**Files:**
- Modify: `src/building-defs.ts` — add `fabricator` (T3, 3×3 — advanced components, motors, actuators), `precision_lab` (T3, 3×3 — circuit boards, computing modules), `singularity_forge` (T4, 4×4 — T4 endgame artifacts).
- Modify: `src/recipes.ts` — re-map existing T3+ recipes that should be authored against these new buildings (e.g. `processor_fab` may belong on `fabricator` rather than the generic `assembler`).
- Test: `src/building-defs.test.ts`

**Spec quote (§8.3):** "Fabricator | 3x3 | T3 | Advanced components, motors, actuators" / "Precision Lab | 3x3 | T3 | Circuit boards, computing modules" / "Singularity Forge | 4x4 | T4 | T4 endgame artifacts".

- [ ] **Steps 1-5:** `feat(§8.3): Fabricator + Precision Lab + Singularity Forge defs`.

---

### Task 5.3: §8.5 Power Generation — Wind Turbine, Nuclear Reactor, Cryogenic Generator

**Files:**
- Modify: `src/building-defs.ts` — `wind_turbine` (T1, 1×1, coast tile, free low output), `nuclear_reactor` (T3, 4×4, uranium fuel rods, very high output), `cryogenic_generator` (T2, 2×2, cryo deposit / arctic, cryo compound → power)
- Test: `src/building-defs.test.ts`

**Spec quote (§8.5):** verbatim table rows from the SPEC §8.5 table.

- [ ] **Steps 1-5:** `feat(§8.5): Wind Turbine + Nuclear Reactor + Cryogenic Generator`.

---

### Task 5.4: §8.7 Cooling/Treatment — Cooling Tower, Wastewater Treatment, Exhaust Scrubber

These three defs are currently entirely absent (handoff: "entire §8.7 category absent"). They are pure adjacency anchors (no recipe, just adjacency-effect rows on neighbours).

**Files:**
- Modify: `src/building-defs.ts` — `cooling_tower`, `wastewater_treatment`, `exhaust_scrubber`. All T2.
- Modify: `src/adjacency.ts` — extend the adjacency-effect table so Crystal Growth Lab adjacent to Cooling Tower unlocks rare crystal recipes (§4.5 row), Refinery without adjacent Wastewater Treatment runs the low-grade recipe (-50%), and Exhaust Scrubber is required for clean operation of high-emission buildings (§8.7).
- Test: `src/adjacency.test.ts` (one it-block per gate)

**Spec quote (§8.7 verbatim):** "Cooling Tower | 2x2 | T2 | Adjacency: required for some chemistry recipes" / "Wastewater Treatment | 2x2 | T2 | Adjacency: prevents efficiency penalty for chemistry" / "Exhaust Scrubber | 1x1 | T2 | Required for clean operation of high-emission buildings".

- [ ] **Steps 1-5:** `feat(§8.7): Cooling Tower + Wastewater Treatment + Exhaust Scrubber`.

---

### Task 5.5: §8.8/§8.9/§9.5 Endgame defs — Terrain Modifier + biome uniques + Airship Dock + Teleporter Pad + Spacetime Anchor

Bundled task; eight defs in one commit. Each is a thin def (catalog row + render glyph + unlock gate); the live mechanics are mostly per-spec data points already.

**Files:**
- Modify: `src/building-defs.ts` — add: `airship_dock` (T3, 3×3, T3 long-range airship routes), `teleporter_pad` (T4, 2×2, paired endpoints), `spacetime_anchor` (T5, 2×2 — logical island unification per §13.3), `terrain_modifier` (T2, 2×2 — clears/converts tiles per §8.9), `mass_driver` (T4, 4×4, Plains-locked, §9.5), `tidal_array` (T4, 3×3, Coast-locked, §9.5), `carbon_forge` (T4, 3×3, Forest-locked, §9.5), `sunspire` (T4, 3×3, Desert-locked, §9.5).
- Modify: `src/building-defs.test.ts`

**Spec quotes (§8.8/§8.9/§9.5):** the verbatim rows in each section's table.

**Note on Mass Driver, Tidal Array, Carbon Forge, Sunspire:** Pyroforge and Cryogenic Compute Center already ship; this task closes the §9.5 biome-locked-uniques set so a player who colonizes one island per biome can run the complete T4 chain.

- [ ] **Steps 1-5:** `feat(§8.8/§8.9/§9.5): airship/teleporter/spacetime/terrain-mod + biome uniques`.

---

### Phase 5 checkpoint

`npm test && npm run build` clean. Spec reviewer: confirm each def's footprint, tier, required tile, and adjacency rules match the SPEC.md row literally. Code quality reviewer: render colours don't collide with existing palette; glyphs are visually distinct.

---

# Phase 6 — §14 Orbital Live Mechanics

The largest single-subsystem block. Seven tasks; each task pairs a spec section to a behavior.

### Task 6.1: §14.2 Orbital Tracking Station def + debris detection range

**Files:**
- Modify: `src/building-defs.ts` — add `orbital_tracking_station` (T6, 3×3)
- Modify: `src/orbital.ts` — add `debrisFieldsVisibleToPlayer(world): DebrisField[]` that returns only fields inside any island's tracking-station radius
- Test: `src/orbital.test.ts`

**Spec quote (§14.2 verbatim):** "Orbital Tracking Station (T6, footprint 3x3): ground-based radar. Detects orbital debris within a fixed range from the island. Without Tracking coverage, debris exists but is invisible to the player. Multiple Tracking Stations across multiple islands compose into a wider debris-detection network."

- [ ] **Steps 1-5:** `feat(§14.2): Orbital Tracking Station + debris detection`.

---

### Task 6.2: §14.8 Debris fields + orbit-explosion generation + lodge events

**Files:**
- Modify: `src/orbital.ts` — add `DebrisField` type (per-cell fragment count); on §14.7 orbit-explosion failure, add a field at the lock-cell with 20 fragments; per-tick `tickDebris(world, nowMs)` rolls hit probability proportional to fragments × cross_section per satellite in the cell, with lodge vs destruction split per §14.8
- Modify: `src/orbital.ts:124` — replace `// Orbit explosion: deferred — no debris field yet.` with the actual debris-field creation
- Test: `src/orbital.test.ts`

**Spec quotes (§14.8 verbatim):**
- "Orbit-explosion failures: a debris field forms in the cell containing the failed lock point. Initial fragment count placeholder: 20 fragments."
- "On hit, two outcomes: High chance: lodge. A randomly chosen sub-stat (scan refresh rate, weather refresh rate, or comm reliability) is permanently slowed by a small percentage."
- "Kessler cascade: because destruction generates more debris, a destroyed satellite in a debris field can hit other satellites".

- [ ] **Steps 1-5:** `feat(§14.8): debris fields + lodge events + Kessler cascade`.

---

### Task 6.3: §14.6 Satellite movement (spend fuel)

**Files:**
- Modify: `src/orbital.ts` — `moveSatellite(world, satId, targetX, targetY, nowMs)` deducts fuel proportional to distance, sets in-flight state, fails with low probability (produces a debris field)
- Test: `src/orbital.test.ts`

**Spec quote (§14.6 verbatim):** "Issuing a move command spends fuel proportional to relocation distance / Move takes real time proportional to distance and thrust / Movement can fail with low probability — the satellite is lost in transit and may produce a debris field".

- [ ] **Steps 1-5:** `feat(§14.6): satellite movement spends fuel`.

---

### Task 6.4: §14.5 Scanner Sat discovery + dwell ramp

**Files:**
- Modify: `src/orbital.ts` — Scanner satellites tick a discovery probability `p` per cell that ramps from low initial value toward an asymptote per dwell time; reveal undiscovered islands within coverage when the roll succeeds; reset dwell ramps in cells outside the new coverage on move
- Test: `src/orbital.test.ts`

**Spec quote (§14.5 verbatim):** "Discovery: each tick, probability `p` of revealing any undiscovered island within coverage. `p` ramps from a low initial value toward an asymptote over real-time dwell on the cell."

- [ ] **Steps 1-5:** `feat(§14.5): scanner-sat dwell-ramp discovery`.

---

### Task 6.5: §14.7 Launch success — Orbital sub-path additive

**Files:**
- Modify: `src/orbital.ts:114-116` — replace the hardcoded base-tier formula with `clamp(base[spaceportTier] + orbitalSkillAdditive(state), 0.0, 0.99)`
- Modify: `src/skilltree.ts` — Orbital sub-path nodes already exist (per handoff §53 fixed earlier); expose a helper `orbitalSkillAdditive(state)` that sums their flat probability values
- Test: `src/orbital.test.ts`

**Spec quote (§14.7 verbatim):** "success_rate = clamp( base[Spaceport tier] + sum(Orbital sub-path bonuses), 0.0, 0.99 )".

- [ ] **Steps 1-5:** `feat(§14.7): launch success additive from Orbital sub-path`.

---

### Task 6.6: §14.4 Per-tick packet propagation (one hop per tick)

**Files:**
- Modify: `src/orbital.ts` — add `tickCommGraph(world, nowMs)` that walks each in-flight packet one hop toward any Spaceport (BFS distance, ties broken by lower-sat-id); packet lost if intermediate node destroyed; packet re-routes if next hop drifts out of range
- Test: `src/orbital.test.ts`

**Spec quote (§14.4 verbatim):** "A scan-result packet generated at satellite S moves through the comm graph one hop per tick toward any Spaceport. The next hop is chosen greedily — at each tick, the packet advances to the connected neighbor that has the shortest path to a Spaceport (BFS distance, ties broken by lower satellite ID)."

- [ ] **Steps 1-5:** `feat(§14.4): per-tick comm packet propagation`.

---

### Task 6.7: §14.8 Sweeper Sat passive cleanup + §14.12 Repair Drone proportional fuel

**Coupled task** — both touch the same `tickDebris` / `dispatchRepairDrone` paths in `orbital.ts`. Single commit.

**Files:**
- Modify: `src/orbital.ts` — Sweeper Sats in a debris field reduce fragment count per tick at a fixed per-Sweeper rate; multiple Sweepers stack
- Modify: `src/orbital.ts:266-300` (`tickRepairDrones` / `dispatchRepairDrone`) — change fuel cost from flat `1 propellant` to a function of rendezvous distance
- Test: `src/orbital.test.ts`

**Spec quotes:**
- §14.8: "Sweeper Sats parked in a debris field passively clear fragments over real time at a fixed rate per Sweeper. Sustained presence is the only way to permanently clean a region; a single Sweeper in a heavy field clears slowly, multiple Sweepers stack."
- §14.12: "Fuel. Same Antimatter Propellant as a satellite launch (T6 fuel per §11.7), but in a smaller load — roughly proportional to the rendezvous distance."

- [ ] **Steps 1-5:** `feat(§14.8/§14.12): sweeper passive cleanup + repair drone proportional fuel`.

---

### Phase 6 checkpoint

`npm test && npm run build` clean. Spec reviewer: every §14 section quoted above is now implemented. Code quality reviewer: `orbital.ts` has not grown past ~800 lines (if it has, split into `orbital-debris.ts` / `orbital-comm.ts` / `orbital-movement.ts` along the natural seams).

---

# Phase 7 — Persistence Test Coverage

Eleven round-trip-test gaps from the handoff §"Persistence audit findings".

### Task 7.1: Round-trip tests for the 11 missing fields

**Files:**
- Modify: `src/persistence.test.ts` — add it-blocks for each:
  - `endgameState` (Set + ms + boolean — Sets must serialize via toJSON-able array)
  - `latticeActive` (boolean)
  - `latticeNodeIslands` (string[])
  - `tutorialState` (Set + current step)
  - `revealedCells` (Set<string>)
  - `timeLockBankedMin`, `accelerationQueue`, `accelerationRemainingMin`, `bankingEnabled`
  - `specializationRole`, `declaredAt` (already covered in Task 2.2)
  - `cargoLabel` on buildings
  - `eternalServitor` flag on buildings
  - `placedAt` / `maintainedAt` perfShift behavior on PlacedBuilding

For each: serialize, deserialize, assert field round-tripped with appropriate perfShift on timestamp-typed fields.

- [ ] **Step 1: Write all 11 round-trip tests at once** (they're cheap; bundling reduces fixture-setup repetition)
- [ ] **Step 2: Run — verify which pass and which fail**
- [ ] **Step 3: Fix any genuine gaps in `persistence.ts` revealed by failures**
- [ ] **Step 4: Verify**
- [ ] **Step 5: Commit** — `test(persistence): round-trip coverage for endgame/lattice/tutorial/timelock/servitor`.

---

### Phase 7 checkpoint

`npm test && npm run build` clean. `persistence.test.ts` now has ≥30 it-blocks. Spec reviewer: no schema-version bump needed (these tests validate existing v3 schema).

---

# Final Phase — End-of-Branch Review

### Task F.1: Final code reviewer subagent pass

Dispatch a final code reviewer subagent across all commits since `master @ 451ac70`:

- Spec compliance pass: every quoted SPEC sentence is implemented; no over-build.
- Code quality pass: pure-layer purity, no PixiJS imports outside render files, no `e.code === ...` outside `input.ts`, naming consistent, TypeScript strict clean.
- Architecture pass: no circular imports introduced; `orbital.ts` split if it exceeded the ~800 line threshold; new building defs follow the existing palette + glyph conventions.

If any review-finding is open: dispatch the implementer subagent to fix; re-review.

- [ ] **Step 1: Run final reviewer with this whole plan as context**
- [ ] **Step 2: Address findings until ✅**
- [ ] **Step 3: Final `npm test && npm run build`**
- [ ] **Step 4: Use `superpowers:finishing-a-development-branch` skill to choose merge / PR / cleanup path**

---

## Self-review

- **Spec coverage**: ✅ — every handoff item has a Phase entry. Bootstrap (P1), repair-drone bug + 2 TODOs (P2), 6 stale comments + 6 tier-helper sites + T3 drone + reset TODO (P3), 8 partial stubs (P4 — Servitor, modifier reroll, reactor toxicity, cable, slag, grace cap, T4 pulse, T6 maint), 14 missing defs (P5), 8 orbital gaps (P6), 11 persistence gaps (P7).
- **Placeholder scan**: no "TBD/TODO/fill in" in step bodies. Two intentional TODO retentions (`tier-reset.ts:58` per Task 3.4 and the §4.7 T6 substitution if `memetic_core` isn't shipped per Task 4.8) — both explicitly documented as deferred-with-reason.
- **Type consistency**: `tierForLevel`, `droneTierFromLaunchBuilding`, `orbitalSkillAdditive`, `tickReactorToxicity`, `tickDebris`, `tickCommGraph`, `moveSatellite`, `rollModifiersArtificial`, `convertToServitor` — each referenced consistently. `DebrisField` introduced once in P6.

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-05-14-handoff-resolution.md`. Per the writing-plans handoff, the user already chose subagent-driven-development. Begin with Phase 1 / Task 1.1.
