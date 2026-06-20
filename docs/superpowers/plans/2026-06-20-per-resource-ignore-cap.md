# Per-resource Ignore Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-building `forceRun` boolean and the global automatic `OUTPUT_CAP_EXEMPT` byproduct set with a single, user-configurable per-`(building, output-resource)` **Ignore Cap** flag.

**Architecture:** A new leaf module `src/output-cap.ts` owns the global default-on set (9 resources, adds `slag`) and the effective predicate `isOutputCapExempt(b, r) = b.ignoreCapOverrides?.[r] ?? OUTPUT_CAP_EXEMPT.has(r)`. The flow solver's whole-building `ignoreOutputCap: boolean` becomes a per-resource `capExemptOutputs: ReadonlySet<string>`. A v29→v30 persistence migration converts `forceRun` to `ignoreCapOverrides` behavior-preservingly. The inspector exposes one checkbox per output resource. `forceRun` is removed last, after every consumer is migrated.

**Tech Stack:** Vite 5 + TypeScript strict + PixiJS 8 (client `src/`), Fastify 5 + Postgres + tsx (server `server/`), vitest. Pure layer has no PixiJS imports; the server re-runs the pure layer.

## Global Constraints

- TypeScript strict, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` — new code compiles clean (`src/buildings.ts` indexed reads use the existing `?? 0` idiom).
- Pure layer (economy, flow-solver, output-cap, building-operational, persistence, recipes) must NOT import `pixi.js` — the server imports them.
- SPEC.md is the source of truth: every behavior change updates the relevant § in the SAME change (§4.6 Force Run → Ignore Cap, §15.3 (A) OUTPUT_CAP_EXEMPT, §4.7 wear note).
- Persistence policy "bump = migrate": new schema version ships a `migrateV<N>toV<N+1>`, a `SerializedSnapshotV<N>` alias, a `deserializeWorld` dispatch arm, and an entry in `SUPPORTED_LOAD_VERSIONS`.
- Input routing: no behavior here touches `input.ts` (inspector buttons use `defineAction`/dispatch).
- Tests run against real Postgres for the server project; `npm test` from root needs PG up (`DATABASE_URL` defaults to `postgresql:///robot_islands_test`).
- Commits: feature branch `feat/per-resource-ignore-cap` (already cut). Each task commits with a `Co-Authored-By:` trailer for the authoring model.

---

### Task 1: Foundation — `output-cap.ts`, `slag` default, `ignoreCapOverrides` field

**Files:**
- Create: `src/output-cap.ts`
- Create: `src/output-cap.test.ts`
- Modify: `src/economy.ts` (remove the local `OUTPUT_CAP_EXEMPT` definition near line 643; re-export from `output-cap.js`)
- Modify: `src/buildings.ts` (add `ignoreCapOverrides` to `PlacedBuilding`; keep `forceRun` for now)

**Interfaces:**
- Produces: `OUTPUT_CAP_EXEMPT: ReadonlySet<ResourceId>` (now `co, refinery_gas, wood_tar, water_vapor, cryo_coolant_vented, mill_scale, tar, asphalt, slag`); `isOutputCapExempt(b: { ignoreCapOverrides?: Partial<Record<ResourceId, boolean>> }, r: ResourceId): boolean`; `PlacedBuilding.ignoreCapOverrides?: Partial<Record<ResourceId, boolean>>`.

- [ ] **Step 1: Write the failing test** — `src/output-cap.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { OUTPUT_CAP_EXEMPT, isOutputCapExempt } from './output-cap.js';

describe('output-cap', () => {
  it('slag is in the default-on set (P4 + this feature)', () => {
    expect(OUTPUT_CAP_EXEMPT.has('slag')).toBe(true);
    expect(OUTPUT_CAP_EXEMPT.has('co')).toBe(true);
    expect(OUTPUT_CAP_EXEMPT.has('iron_ingot')).toBe(false);
  });

  it('no overrides ⇒ falls through to the global default', () => {
    expect(isOutputCapExempt({}, 'slag')).toBe(true);        // default on
    expect(isOutputCapExempt({}, 'iron_ingot')).toBe(false); // default off
  });

  it('an override wins over the default, either direction', () => {
    expect(isOutputCapExempt({ ignoreCapOverrides: { slag: false } }, 'slag')).toBe(false);
    expect(isOutputCapExempt({ ignoreCapOverrides: { iron_ingot: true } }, 'iron_ingot')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/output-cap.test.ts`
Expected: FAIL — cannot find module `./output-cap.js`.

- [ ] **Step 3: Create `src/output-cap.ts`**

```ts
import type { ResourceId } from './recipes.js';

/**
 * §15.3 (A) / §4.6 — the DEFAULT-ON set for per-output Ignore Cap.
 *
 * These resources are SIDE outputs of buildings whose PRIMARY output is
 * valuable; a full bin must not (by default) stall the producer and starve the
 * primary. Each is stored up to cap and drawable; overflow above cap is voided
 * by `applyRates`' clamp. This is now the DEFAULT a player can override per
 * building (see `isOutputCapExempt`), not a hard rule. `slag` joins the set
 * (side output of smelter→iron_ingot, steel_mill→steel; consumer:
 * slag_reprocessor). `co2` is NOT here — it lives in `NON_STORED_OUTPUTS`.
 */
export const OUTPUT_CAP_EXEMPT: ReadonlySet<ResourceId> = new Set<ResourceId>([
  'co', 'refinery_gas', 'wood_tar', 'water_vapor', 'cryo_coolant_vented',
  'mill_scale', 'tar', 'asphalt', 'slag',
]);

/**
 * Effective per-(building, output-resource) Ignore Cap flag. A per-building
 * override (if present for `r`) wins; otherwise the global default applies.
 * Ignore-cap ON ⇒ a full `r` bin never stalls/throttles this building (overflow
 * voided), so it keeps running for XP on its other constraints.
 */
export function isOutputCapExempt(
  b: { readonly ignoreCapOverrides?: Partial<Record<ResourceId, boolean>> },
  r: ResourceId,
): boolean {
  return b.ignoreCapOverrides?.[r] ?? OUTPUT_CAP_EXEMPT.has(r);
}
```

- [ ] **Step 4: Re-point `economy.ts`** — delete the local `OUTPUT_CAP_EXEMPT` block (the `export const OUTPUT_CAP_EXEMPT = new Set([...])` near line 643, the one that listed 8 resources) and add near the other imports:

```ts
import { OUTPUT_CAP_EXEMPT, isOutputCapExempt } from './output-cap.js';
```

Then re-export it so existing import sites keep working:

```ts
export { OUTPUT_CAP_EXEMPT } from './output-cap.js';
```

(`isOutputCapExempt` is used in Task 2; importing it now is fine — it is referenced there. If `noUnusedLocals` flags it this task, defer the `isOutputCapExempt` import to Task 2.)

- [ ] **Step 5: Add the field in `src/buildings.ts`** — in the `PlacedBuilding` interface, immediately after the `forceRun?: boolean;` field:

```ts
  /** §4.6 per-output Ignore Cap overrides. Maps an output resource to an
   *  explicit on/off that overrides the global OUTPUT_CAP_EXEMPT default for
   *  THIS building. Absent resource ⇒ use the global default. Absent field ⇒
   *  all outputs at their global default (byproducts on, everything else off).
   *  Replaces `forceRun` (removed in the final task); set by the inspector. */
  ignoreCapOverrides?: Partial<Record<ResourceId, boolean>>;
```

Ensure `ResourceId` is imported in `buildings.ts` (it likely already is; if not, `import type { ResourceId } from './recipes.js';`).

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/output-cap.test.ts && npx vitest run src/economy.test.ts`
Expected: PASS. (Adding `slag` to the default set may flip an economy test that asserted a full slag bin stalls its producer — if any fails, that is the intended behavior change; update that assertion to reflect slag no longer stalling, and note it.)

- [ ] **Step 7: Typecheck + commit**

```bash
npx tsc -b
git add src/output-cap.ts src/output-cap.test.ts src/economy.ts src/buildings.ts
git commit -m "feat(ignore-cap): output-cap leaf module + slag default + ignoreCapOverrides field

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 2: Engine — per-resource exemption in the flow solver + economy wiring

**Files:**
- Modify: `src/flow-solver.ts` (`FlowBuildingSpec`, `keysByBuilding`, the `cap:` branch of `update`)
- Modify: `src/economy.ts` (flow-spec builder ~line 1628 and the `ownFlowSpecs` clone ~1635; the `capConstrained` regime scan ~line 1680; `outputAvail` ~line 672)
- Modify: `src/flow-solver.test.ts`, `src/economy.test.ts`

**Interfaces:**
- Consumes: `isOutputCapExempt` (Task 1).
- Produces: `FlowBuildingSpec.capExemptOutputs?: ReadonlySet<string>` (replaces `ignoreOutputCap?: boolean`).

- [ ] **Step 1: Update the failing solver test** — in `src/flow-solver.test.ts`, the `describe('flow-solver — ignoreOutputCap (force run)')` block. Replace the `ignoreOutputCap: true` spec field with `capExemptOutputs` and add a mixed case:

```ts
it('a producer exempt on ONE output gates on its OTHER capped output', () => {
  // produces A (exempt, at cap) and B (not exempt, at cap); a B consumer pulls.
  const buildings = [
    { produces: { A: 1, B: 1 }, consumes: {}, capExemptOutputs: new Set(['A']) },
    { produces: {}, consumes: { B: 0.5 } },
  ];
  const sol = solveFlow(buildings, {
    capConstrained: new Set(['A', 'B']),
    zeroConstrained: new Set(),
  });
  // gated by B only: realized B production (1×g) must match B draw (0.5) ⇒ g=0.5
  expect(sol.gates[0]).toBeCloseTo(0.5, 5);
});

it('a fully-exempt producer keeps gate 1 at a capped output with no consumer', () => {
  const buildings = [{ produces: { A: 1 }, consumes: {}, capExemptOutputs: new Set(['A']) }];
  const sol = solveFlow(buildings, { capConstrained: new Set(['A']), zeroConstrained: new Set() });
  expect(sol.gates[0]).toBeCloseTo(1, 5);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/flow-solver.test.ts`
Expected: FAIL — `capExemptOutputs` not honored (gate wrong / type error on the old `ignoreOutputCap`).

- [ ] **Step 3: Change `FlowBuildingSpec` in `src/flow-solver.ts`** — replace the `ignoreOutputCap` field:

```ts
  /** §4.6 per-output Ignore Cap: this building's production of each resource in
   *  this set is exempt from output-cap throttling — a full bin of that
   *  resource never drives the building's gate down. Overflow is voided
   *  downstream by `applyRates`' clamp. NOT exempt from input-empty (zero)
   *  constraints or the power factor. Absent/empty = no exemptions. */
  readonly capExemptOutputs?: ReadonlySet<string>;
```

- [ ] **Step 4: Apply per-resource exemption in `solveFlow`** — `keysByBuilding` (currently lines ~114-125): replace the `if (!b.ignoreOutputCap) { ... }` wrapper with a per-resource skip:

```ts
  const keysByBuilding: MulKey[][] = buildings.map((b) => {
    const ks: MulKey[] = [];
    for (const r of Object.keys(b.produces)) {
      if ((b.produces[r] ?? 0) > 0 && constraints.capConstrained.has(r) &&
          !(b.capExemptOutputs?.has(r))) {
        ks.push(`cap:${r}`);
      }
    }
    for (const r of Object.keys(b.consumes)) {
      if ((b.consumes[r] ?? 0) > 0 && constraints.zeroConstrained.has(r)) ks.push(`zero:${r}`);
    }
    return ks;
  });
```

And in the `cap:` branch of `update` (currently line ~156), replace `if (buildings[i]!.ignoreOutputCap) continue;`:

```ts
        if (p > 0) {
          if (buildings[i]!.capExemptOutputs?.has(res)) continue; // per-output ignore-cap
          const net = p - c;
          if (net > 0) {
            entries.push({ coeff: net, otherGate: gate(i, key) });
          }
        } else if (c > 0) {
```

- [ ] **Step 5: Wire economy's flow-spec builder** (`src/economy.ts` ~line 1628). Replace `ignoreOutputCap: te.building.forceRun === true` with a per-resource set built from the recipe's outputs:

```ts
      const capExemptOutputs = new Set<ResourceId>();
      for (const r of Object.keys(resolveRotatingOutput(te.recipe, nowMs))) {
        const id = r as ResourceId;
        if (isOutputCapExempt(te.building, id)) capExemptOutputs.add(id);
      }
      return { produces, consumes, capExemptOutputs };
```

In the `ownFlowSpecs` clone (~line 1635), replace the `...(fb.ignoreOutputCap ? { ignoreOutputCap: true } : {})` spread with:

```ts
    ...(fb.capExemptOutputs && fb.capExemptOutputs.size ? { capExemptOutputs: new Set(fb.capExemptOutputs) } : {}),
```

(Confirm `nowMs` and `resolveRotatingOutput` are in scope at the builder; they are used elsewhere in this function. If `resolveRotatingOutput` is not in scope, use `te.recipe.outputs` keys plus, when `te.recipe.rotateOutputs` exists, its entries — match how `outputAvail` enumerates outputs.)

- [ ] **Step 6: Drop the GLOBAL skip in the `capConstrained` regime scan** (`src/economy.ts` ~line 1680). Remove the line `if (OUTPUT_CAP_EXEMPT.has(id)) continue;` from that scan so a resource enters `capConstrained` purely on `stock >= cap`. Per-building exemption is now handled in the solver (Step 4); an all-exempt resource yields an empty `θ` entry set ⇒ no throttle, and no building is gated by it. Keep the `NON_STORED_OUTPUTS` skip. Update the nearby comment to explain the move.

- [ ] **Step 7: Make `outputAvail` per-building** (`src/economy.ts` ~line 660). It is the pass-3 power probe; give it the building's overrides. Change its signature to accept the building (or its overrides) and replace `if (OUTPUT_CAP_EXEMPT.has(id)) continue;` with `if (isOutputCapExempt(b, id)) continue;`. Update its single/both call sites (the `baseRate === 0` power-probe pass) to pass the building. Keep the `NON_STORED_OUTPUTS` skip.

- [ ] **Step 8: Migrate economy tests** — any economy test that set `building.forceRun = true` to assert produce-at-cap must instead set `building.ignoreCapOverrides = { <output>: true }` (the engine no longer reads `forceRun`). Add one test: a steel_mill at a full `slag` bin keeps producing `steel` (slag default-exempt); the same mill with `ignoreCapOverrides: { slag: false }` stalls on a full slag bin.

- [ ] **Step 9: Run + typecheck + commit**

```bash
npx vitest run src/flow-solver.test.ts src/economy.test.ts
npx tsc -b
git add src/flow-solver.ts src/flow-solver.test.ts src/economy.ts src/economy.test.ts
git commit -m "feat(ignore-cap): per-output cap exemption in the flow solver + economy wiring

Co-Authored-By: <model> <noreply@anthropic.com>"
```
Expected: all green. `forceRun` is now an orphaned field (no engine effect) until removed in Task 6.

---

### Task 3: Persistence migration v29 → v30

**Files:**
- Modify: `src/persistence.ts` (`SCHEMA_VERSION`, `SUPPORTED_LOAD_VERSIONS`, `SerializedSnapshotV29` alias, `migrateV29toV30`, `deserializeWorld` dispatch)
- Modify: `src/persistence.test.ts`

**Interfaces:**
- Consumes: the building catalog to enumerate a def's output resources (import the catalog/`recipes` the same way other pure modules do, e.g. `BUILDINGS`/`catalog` from `building-defs.js` and `recipe.outputs`/`rotateOutputs`).
- Produces: v30 snapshots whose buildings carry `ignoreCapOverrides` (and no `forceRun`).

- [ ] **Step 1: Write the failing migration test** — `src/persistence.test.ts`

```ts
it('migrates v29 forceRun:true → ignoreCapOverrides on every output (§4.6)', () => {
  const v29 = makeV29Snapshot({
    buildings: [
      { id: 'b-forced', defId: 'smelter', x: 0, y: 0, forceRun: true },
      { id: 'b-plain',  defId: 'smelter', x: 1, y: 0 },
    ],
  });
  const loaded = loadWorld(JSON.stringify(v29));
  const forced = findBuilding(loaded, 'b-forced');
  const plain = findBuilding(loaded, 'b-plain');
  // smelter outputs iron_ingot + slag + co (from recipes) → all forced on
  expect(forced.ignoreCapOverrides).toMatchObject({ iron_ingot: true, slag: true, co: true });
  expect(forced.forceRun).toBeUndefined();
  // a non-force-run building gets NO overrides (defaults apply)
  expect(plain.ignoreCapOverrides).toBeUndefined();
  expect(plain.forceRun).toBeUndefined();
});
```

(Use whatever v-fixture helper this file already has; if none, build the v29 object literal inline with `v: 29` and the current world shape.)

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/persistence.test.ts -t "forceRun"`
Expected: FAIL — v29 not accepted / no migration.

- [ ] **Step 3: Bump version + supported set** in `src/persistence.ts`:

```ts
export const SCHEMA_VERSION = 30 as const;
export const SUPPORTED_LOAD_VERSIONS: ReadonlySet<number> = new Set([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
```

- [ ] **Step 4: Add the v29 alias + migration** (mirror the existing `migrateV28toV29` shape):

```ts
/** v29 snapshot — structurally identical to v30 (SaveSnapshot) except the v
 *  literal and that buildings carry `forceRun?: boolean` instead of
 *  `ignoreCapOverrides`. */
export type SerializedSnapshotV29 = Omit<SaveSnapshot, 'v'> & { readonly v: 29 };

/** v29 → v30: replace the per-building `forceRun` boolean with per-output
 *  `ignoreCapOverrides`. A force-run building exempts ALL its outputs, so set
 *  every output resource of its def's recipe (incl. rotateOutputs) to `true`;
 *  this reproduces the old all-outputs exemption exactly. A non-force-run
 *  building gets no overrides (the global OUTPUT_CAP_EXEMPT defaults apply,
 *  now incl. slag). `forceRun` is dropped from every building. */
export function migrateV29toV30(s: SerializedSnapshotV29): SaveSnapshot {
  return {
    ...s,
    v: 30 as const,
    world: {
      ...s.world,
      islands: s.world.islands.map((isl) => ({
        ...isl,
        buildings: isl.buildings.map((b) => {
          const { forceRun, ...rest } = b as typeof b & { forceRun?: boolean };
          if (forceRun !== true) return rest;
          const def = catalog[rest.defId];
          const outs = def?.recipe
            ? Object.keys(def.recipe.outputs).concat(
                (def.recipe.rotateOutputs ?? []).flatMap((o) => Object.keys(o)))
            : [];
          const ignoreCapOverrides: Record<string, boolean> = {};
          for (const r of outs) ignoreCapOverrides[r] = true;
          return Object.keys(ignoreCapOverrides).length ? { ...rest, ignoreCapOverrides } : rest;
        }),
      })),
    },
  } as unknown as SaveSnapshot;
}
```

(Adjust `catalog`/`def.recipe.rotateOutputs` to the actual names in `building-defs.ts`/`recipes.ts`. If `rotateOutputs` has a different shape, enumerate its resource keys accordingly — match `resolveRotatingOutput`.)

- [ ] **Step 5: Wire the dispatch** — in `deserializeWorld`, after the `v === 29` arm that calls `migrateV28toV29`... actually after the existing `=== 28 → migrateV28toV29` block add:

```ts
  if ((snapshot as unknown as { v: number }).v === 29) {
    snapshot = migrateV29toV30(snapshot as unknown as SerializedSnapshotV29);
  }
```

- [ ] **Step 6: Add a v30 round-trip identity test**

```ts
it('v30 round-trips identity with ignoreCapOverrides', () => {
  const snap = makeCurrentSnapshot({
    buildings: [{ id: 'b1', defId: 'smelter', x: 0, y: 0, ignoreCapOverrides: { iron_ingot: true } }],
  });
  const out = loadWorld(JSON.stringify(serialize(snap)));
  expect(findBuilding(out, 'b1').ignoreCapOverrides).toEqual({ iron_ingot: true });
});
```

- [ ] **Step 7: Run + typecheck + commit**

```bash
npx vitest run src/persistence.test.ts
npx tsc -b
git add src/persistence.ts src/persistence.test.ts
git commit -m "feat(ignore-cap): v29->v30 migration — forceRun to ignoreCapOverrides

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 4: Server intent `set-ignore-cap` + gateway seam `setIgnoreCap`

**Files:**
- Modify: `server/src/game/intents.ts` (replace the `set-force-run` intent)
- Modify: `src/mutation-gateway.ts` (both the interface signature ~line 149, the REMOTE arm ~line 432, the LOCAL arm ~line 973)
- Modify: `server/src/game/intents.test.ts`

**Interfaces:**
- Produces: intent `set-ignore-cap` with payload `{ islandId: string, buildingId: string, resource: string, value: boolean }`; gateway `setIgnoreCap(islandId, buildingId, resource, value): GatewayReturn`.

- [ ] **Step 1: Write the failing server test** — `server/src/game/intents.test.ts`

```ts
describe('set-ignore-cap', () => {
  it('accepts a real output resource and writes the override', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (_w, states) => {
      const s = states.get('home'); s.level = 5;
    });
    // place a smelter first via place-building, then toggle its iron_ingot
    const bId = await placeBuilding(uid, 'smelter', 0, 0, now); // helper returns id
    const ack = await applyIntent(pool, uid,
      { type: 'set-ignore-cap', payload: { islandId: 'home', buildingId: bId, resource: 'iron_ingot', value: true }, seq: 2 }, now);
    expect(ack).toMatchObject({ ok: true });
    const b = (await homeBuildings(uid)).find((bb) => bb.id === bId)!;
    expect((b.ignoreCapOverrides as Record<string, boolean>).iron_ingot).toBe(true);
  });

  it('rejects a resource that is not an output of the building', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const bId = await placeBuilding(uid, 'smelter', 0, 0, now);
    const ack = await applyIntent(pool, uid,
      { type: 'set-ignore-cap', payload: { islandId: 'home', buildingId: bId, resource: 'wood', value: true }, seq: 2 }, now);
    expect(ack).toMatchObject({ ok: false });
  });
});
```

(Use the existing `placeBuilding` helper / a smelter the home level allows; if smelter needs resources to place, stock them in the modifier like the ocean tests do.)

- [ ] **Step 2: Run to confirm it fails**

Run: `cd server && DATABASE_URL=postgresql:///robot_islands_test npx vitest run src/game/intents.test.ts -t "set-ignore-cap"`
Expected: FAIL — unknown intent `set-ignore-cap`.

- [ ] **Step 3: Replace the intent** in `server/src/game/intents.ts` (the `'set-force-run'` block):

```ts
  // set-ignore-cap — §4.6 per-output Ignore Cap. Player supplies
  // { islandId, buildingId, resource, value }. Authoritative checks: building
  // exists on the island AND `resource` is an actual output of its recipe.
  'set-ignore-cap': {
    apply(game: LiveGame, payload: unknown): IntentResult {
      if (!isRecord(payload)) return { ok: false, error: 'malformed payload' };
      const { islandId, buildingId, resource, value } = payload;
      if (typeof islandId !== 'string') return { ok: false, error: 'islandId must be a string' };
      if (typeof buildingId !== 'string') return { ok: false, error: 'buildingId must be a string' };
      if (typeof resource !== 'string') return { ok: false, error: 'resource must be a string' };
      if (typeof value !== 'boolean') return { ok: false, error: 'value must be a boolean' };
      const island = resolveIsland(game, islandId);
      if (!island) return { ok: false, error: 'unknown island' };
      const b = island.spec.buildings.find((bb) => bb.id === buildingId);
      if (!b) return { ok: false, error: 'not-found' };
      const def = catalog[b.defId];
      const outputs = def?.recipe
        ? new Set(Object.keys(def.recipe.outputs).concat(
            (def.recipe.rotateOutputs ?? []).flatMap((o) => Object.keys(o))))
        : new Set<string>();
      if (!outputs.has(resource)) return { ok: false, error: 'not-an-output' };
      const ov = { ...(b.ignoreCapOverrides ?? {}) };
      ov[resource] = value;
      b.ignoreCapOverrides = ov;
      return { ok: true };
    },
  },
```

(Import `catalog`/`BUILDINGS` if not already imported in this file. Match the symbol the server uses to resolve a def by id.)

- [ ] **Step 4: Update the gateway** in `src/mutation-gateway.ts`:

Interface (~line 149):
```ts
  setIgnoreCap(islandId: string, buildingId: string, resource: string, value: boolean): GatewayReturn;
```
REMOTE arm (~line 432):
```ts
    setIgnoreCap(islandId, buildingId, resource, value) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      const b = island.spec.buildings.find((bb) => bb.id === buildingId);
      if (!b) return err('not-found');
      const ov = { ...(b.ignoreCapOverrides ?? {}) };
      ov[resource as ResourceId] = value;
      b.ignoreCapOverrides = ov;
      return ok();
    },
```
LOCAL arm (~line 973):
```ts
    setIgnoreCap(islandId, buildingId, resource, value) {
      return send('set-ignore-cap', { islandId, buildingId, resource, value });
    },
```
(Ensure `ResourceId` is imported in the gateway, or type `resource: string` and index loosely as the file's style allows.)

- [ ] **Step 5: Run + typecheck + commit**

```bash
cd server && DATABASE_URL=postgresql:///robot_islands_test npx vitest run src/game/intents.test.ts && npm run typecheck && cd ..
npx tsc -b
git add server/src/game/intents.ts server/src/game/intents.test.ts src/mutation-gateway.ts
git commit -m "feat(ignore-cap): set-ignore-cap intent + setIgnoreCap gateway seam

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 5: Inspector UI — per-resource Ignore Cap checkboxes

**Files:**
- Modify: `src/inspector-ui.ts` (the `InspectorDeps.onSetForceRun` dep + `set-building-force-run` action + the `forceRunBtn` UI block)
- Modify: `src/main.ts` (the `onSetForceRun` dep wiring ~line 1728)
- Modify: `src/inspector-ui.test.ts`

**Interfaces:**
- Consumes: `isOutputCapExempt`, `OUTPUT_CAP_EXEMPT` (from `output-cap.js`); gateway `setIgnoreCap` (Task 4).
- Produces: `InspectorDeps.onSetIgnoreCap(target: InspectorTarget, resource: ResourceId, value: boolean): void`.

- [ ] **Step 1: Update the failing UI test** — `src/inspector-ui.test.ts`. Replace `onSetForceRun: vi.fn()` in the deps with `onSetIgnoreCap: vi.fn()` and add:

```ts
it('renders one Ignore Cap checkbox per output resource and dispatches on toggle', () => {
  const onSetIgnoreCap = vi.fn();
  const { container, selectBuilding } = mountForTest({ onSetIgnoreCap });
  selectBuilding(/* a smelter with outputs iron_ingot, slag, co */);
  const boxes = container.querySelectorAll('[data-ignore-cap-resource]');
  expect(boxes.length).toBe(3);
  // slag/co start checked (default-on), iron_ingot unchecked
  const ironBox = container.querySelector('[data-ignore-cap-resource="iron_ingot"]') as HTMLInputElement;
  ironBox.click();
  expect(onSetIgnoreCap).toHaveBeenCalledWith(expect.anything(), 'iron_ingot', true);
});
```

(Adapt to the test harness this file uses — match how the existing force-run test mounts/selects.)

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/inspector-ui.test.ts`
Expected: FAIL — `onSetIgnoreCap` not defined / no checkboxes rendered.

- [ ] **Step 3: Swap the dep + action** in `src/inspector-ui.ts`. Replace `onSetForceRun(target, value)` in `InspectorDeps` with:

```ts
  /** §4.6 Set this building's Ignore Cap flag for one output resource. main.ts
   *  routes it to the mutation gateway (`setIgnoreCap`). */
  onSetIgnoreCap(target: InspectorTarget, resource: ResourceId, value: boolean): void;
```

Replace the `pendingForceRun` ref + `set-building-force-run` action with a resource-parameterized dispatch (the action reads a pending `{resource, value}`):

```ts
  let pendingIgnoreCap: { resource: ResourceId; value: boolean } | null = null;
  defineAction(reg, 'set-building-ignore-cap', () => {
    const p = pendingIgnoreCap;
    pendingIgnoreCap = null;
    if (!p) return;
    const target = resolveTarget();
    if (!target) { close(); return; }
    if ((target.building.constructionRemainingMs ?? 0) > 0) return;
    deps.onSetIgnoreCap(target, p.resource, p.value);
    paint();
  });
```

- [ ] **Step 4: Replace the `forceRunBtn` block with a checkbox list.** Where the single `forceRunBtn` was built+appended, build one labeled checkbox per output resource of the building's recipe (use `resolveRotatingOutput` / `recipe.outputs` keys + `rotateOutputs`). Each checkbox:
  - `dataset.ignoreCapResource = r`;
  - `checked = isOutputCapExempt(building, r)`;
  - on `change`: `pendingIgnoreCap = { resource: r, value: checkbox.checked }; dispatchAction('set-building-ignore-cap')`.
  - Render the subsection only when the building has ≥1 productive recipe output (same guard as the old force-run button); hide while constructing.

```ts
  // §4.6 Ignore Cap — one toggle per output resource. Default-on resources
  // (OUTPUT_CAP_EXEMPT, incl. slag) start checked; a checked box keeps the
  // building producing for XP at a full bin of that resource (overflow voided).
  const outputs = building.def.recipe
    ? Object.keys(resolveRotatingOutput(building.def.recipe, Date.now())) as ResourceId[]
    : [];
  if (outputs.length > 0) {
    // append a small header + a row per resource (label + <input type=checkbox>)
    // wiring each box as in Step 3's dispatch.
  }
```

(Match the panel's existing element-creation + `styled()` idioms. Keep the building/def reference resolution consistent with how the panel already reads `building.def`/recipe.)

- [ ] **Step 5: Wire `main.ts`** (~line 1728). Replace the `onSetForceRun` dep:

```ts
    onSetIgnoreCap: (target: InspectorTarget, resource: ResourceId, value: boolean) => {
      // §4.6 per-output Ignore Cap. Pure write goes through the gateway seam.
      const gatewayResult = gateway.setIgnoreCap(target.spec.id, target.building.id, resource, value);
      // mirror the old onSetForceRun handling of gatewayResult (autosave bump,
      // optimistic local apply, etc.) exactly as it was.
    },
```

- [ ] **Step 6: Run + typecheck + commit**

```bash
npx vitest run src/inspector-ui.test.ts
npx tsc -b
git add src/inspector-ui.ts src/inspector-ui.test.ts src/main.ts
git commit -m "feat(ignore-cap): per-resource Ignore Cap checkboxes in the inspector

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 6: Map badge per-resource + remove `forceRun` + SPEC + full sweep

**Files:**
- Modify: `src/building-alerts-overlay.ts` (badge condition ~line 228)
- Modify: `src/buildings.ts` (remove `forceRun?: boolean`)
- Modify: `src/discovery-signature.ts` (comment only — it already excludes the field)
- Modify: `SPEC.md` (§4.6, §15.3 (A), §4.7)
- Grep-and-clean any remaining `forceRun` references across `src/` and `server/`

**Interfaces:**
- Consumes: `isOutputCapExempt`, `OUTPUT_CAP_EXEMPT`.

- [ ] **Step 1: Update the badge** in `src/building-alerts-overlay.ts`. Replace `const forced = b.forceRun === true;` with: green when the building forces a NON-default output:

```ts
  // §4.6 Ignore Cap: green badge when the building forces a NON-default output
  // (a primary/valuable resource it normally wouldn't overflow). Default
  // byproduct exemptions (slag, co, ...) do not light it.
  const forced = Object.entries(b.ignoreCapOverrides ?? {}).some(
    ([r, v]) => v === true && !OUTPUT_CAP_EXEMPT.has(r as ResourceId),
  );
```

Import `OUTPUT_CAP_EXEMPT` (and `ResourceId` if needed) from `output-cap.js`/`recipes.js`. Add/adjust a test if this file has one; otherwise rely on the full suite.

- [ ] **Step 2: Remove `forceRun`** from `PlacedBuilding` in `src/buildings.ts`. Then:

Run: `grep -rn "forceRun" src/ server/ --include=*.ts`
Expected after cleanup: only `SerializedSnapshotV29`-related migration code references it (as a destructured/typed legacy field), and test fixtures that intentionally build v29 snapshots. Fix every other reference (there should be none after Tasks 2/4/5). Update the `discovery-signature.ts` comment naming `forceRun` to name `ignoreCapOverrides` and note it stays excluded (non-visual; the badge refreshes per-frame).

- [ ] **Step 3: Update SPEC.md** — rewrite §4.6 "Force Run" → per-resource "Ignore Cap" (per-output overrides, the 9-resource default-on set incl. slag, fully-configurable semantics, cost unchanged: still consumes inputs/power and wears; green badge on a forced non-default output). Reframe §15.3 (A): `OUTPUT_CAP_EXEMPT` is the DEFAULT-ON set (add slag), the per-building `ignoreCapOverrides` layered on top via `isOutputCapExempt`, the solver's `capExemptOutputs`. Update the §4.7 wear note wording (Ignore-Cap-on outputs keep a nonzero duty cycle → wear).

- [ ] **Step 4: Full suite + typechecks**

Run:
```bash
npx tsc -b
cd server && npm run typecheck && cd ..
npm test
```
Expected: client + server typecheck clean; `npm test` all green (PG up).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ignore-cap): per-resource badge, remove forceRun, SPEC §4.6/§15.3/§4.7

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-06-20-per-resource-ignore-cap-design.md`):
- Data model (`ignoreCapOverrides`, `isOutputCapExempt`, default-on set + slag) → Task 1. ✓
- Engine generalization (solver `capExemptOutputs`, economy wiring, drop global skip, `outputAvail`) → Task 2. ✓
- Migration v29→v30 (forceRun→overrides, equivalence) → Task 3. ✓
- Server intent + gateway seam → Task 4. ✓
- Inspector per-resource UI → Task 5. ✓
- Badge (non-default only), forceRun removal, discovery-signature comment, SPEC → Task 6. ✓
- Test surface items map to the per-task test steps. ✓

**Placeholder scan:** code shown for every code step; the few "match the existing idiom"/"adjust to actual catalog name" notes are unavoidable codebase-specific bindings flagged explicitly for the implementer to resolve by reading the file — not skipped logic.

**Type consistency:** `ignoreCapOverrides: Partial<Record<ResourceId, boolean>>` (buildings.ts, predicate, migration, intent, gateway, UI) consistent; `capExemptOutputs: ReadonlySet<string>` (flow-solver spec + economy builder) consistent; `isOutputCapExempt(b, r)` signature stable across Tasks 1/2/5/6; gateway `setIgnoreCap(islandId, buildingId, resource, value)` matches the intent payload and the UI/main wiring; action name `set-building-ignore-cap` used in both the `defineAction` and the dispatch.

**Ordering invariant:** the build/tests stay green at every task boundary because `forceRun?` remains on the type (orphaned after Task 2) until Task 6 removes it once every consumer is migrated.
