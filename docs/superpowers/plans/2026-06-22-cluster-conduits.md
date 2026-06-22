# Cluster Conduits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two infrastructure buildings (same-island Cluster Conduit, cross-island Lattice Conduit) that let players wire conduits into a transitive network so same-category buildings 4-adjacent to any wired conduit earn the §4.5 cluster bonus at full strength.

**Architecture:** A new `World.conduitLinks` edge list (conduit building-id pairs) drives a pure helper that derives extra union pairs for the existing `clusterBonusMuls` union-find. Same-island wiring plugs straight into the per-island cluster pass; cross-island wiring feeds remote attached buildings through the existing `ctx.crossIsland` plumbing. No attenuation, no upkeep — cost + tier gate are the only balance levers.

**Tech Stack:** TypeScript strict, Vite, PixiJS 8 (render layer only), vitest. Pure-layer modules carry no PixiJS import.

**Spec:** `docs/superpowers/specs/2026-06-22-cluster-conduits-design.md` (read it before starting).

## Global Constraints

- TypeScript strict + `noUncheckedIndexedAccess` + `noUnusedLocals` + `noUnusedParameters`. New code compiles clean (`cd server && npx tsc --noEmit`; root `npm run build`).
- Pure layer (no `pixi.js` import): `building-defs.ts`, `adjacency.ts`, `conduits.ts` (new), `economy*.ts`, `world.ts` pure exports, `persistence.ts`, `input.ts`. Render layer (may import PixiJS): `conduit-overlay.ts` (new), `inspector-ui.ts`, the wiring-UI panel.
- One responsibility per file; new mechanic ⇒ new file (`conduits.ts`, `conduit-overlay.ts`, `conduit-wiring-ui.ts`).
- **Every change that alters behavior updates `SPEC.md` in the same change.**
- Persistence: bump = migrate. Current `SCHEMA_VERSION = 31` (`persistence.ts:79`). This feature bumps to **32** with a full migration chain entry.
- Co-author trailer on every commit: `Co-Authored-By: <model name> <noreply@anthropic.com>`.
- The feature is **inert when `world.conduitLinks` is empty** — a save with no links must produce byte-identical economy output (the server bench oracle digest must not move).

---

### Task 1: Conduit building definitions

**Files:**
- Modify: `src/building-defs.ts` (add two `BuildingDefId` literals + two `BUILDING_DEFS` entries)
- Test: `src/building-defs.test.ts` (add cases; create if the file pattern differs — check existing test file naming first)

**Interfaces:**
- Produces: defIds `'cluster_conduit'` and `'lattice_conduit'`; both present in `BUILDING_DEFS` with `category: 'logistics'`, no `recipe`/`power`, `tier` and `placementCost` per the spec.

The conduits run no recipe and produce/consume no power, so they are never §4.5 cluster members (a `logistics`-category building with no recipe contributes nothing to a recipe-rate or power bonus — `CATEGORY_ADJACENCY_RATE.logistics` is a no-op for them). Mirror the field shape of an existing no-recipe `special`/`logistics` def (e.g. `lattice_node` at `building-defs.ts:2427` for the T5 fields, `path_drone_foundry` at `:2453` for a logistics building with no recipe).

- [ ] **Step 1: Write the failing test**

```ts
// src/building-defs.test.ts
import { describe, it, expect } from 'vitest';
import { BUILDING_DEFS } from './building-defs.js';

describe('conduit defs', () => {
  it('cluster_conduit is a T2 logistics building, no recipe/power', () => {
    const d = BUILDING_DEFS['cluster_conduit'];
    expect(d).toBeDefined();
    expect(d.category).toBe('logistics');
    expect(d.tier).toBe(2);
    expect(d.recipe).toBeUndefined();
    expect(d.power).toBeUndefined();
    expect(d.placementCost).toEqual({ steel_beam: 800, concrete: 500, wire: 120, microchip: 25, gear: 40 });
  });

  it('lattice_conduit is a T5 logistics building, no recipe/power', () => {
    const d = BUILDING_DEFS['lattice_conduit'];
    expect(d).toBeDefined();
    expect(d.category).toBe('logistics');
    expect(d.tier).toBe(5);
    expect(d.recipe).toBeUndefined();
    expect(d.power).toBeUndefined();
    expect(d.placementCost).toEqual({ steel_beam: 2800, microchip: 450, wire: 220, exotic_alloy: 90, reality_anchor: 50, ai_core: 30 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/building-defs.test.ts -t "conduit defs"`
Expected: FAIL — `BUILDING_DEFS['cluster_conduit']` is undefined (and TS error on the literal).

- [ ] **Step 3: Add the defId literals and defs**

In `src/building-defs.ts`, add `| 'cluster_conduit'` and `| 'lattice_conduit'` to the `BuildingDefId` union (near the other logistics defIds). Add to `BUILDING_DEFS`:

```ts
  cluster_conduit: {
    id: 'cluster_conduit',
    displayName: 'Cluster Conduit',
    category: 'logistics',
    tier: 2,
    footprint: SHAPES.square1,
    fill: 0x7dd3e8,   // cyan, echoes the §4.5 cluster accent
    stroke: 0x2d5878,
    // §4.5 conduit — pure connectivity, no recipe/power. Placeholder BOM
    // tuned per the building-defs convention (real-commitment magnitude).
    placementCost: { steel_beam: 800, concrete: 500, wire: 120, microchip: 25, gear: 40 },
    glyph: '⌗',
  },
  lattice_conduit: {
    id: 'lattice_conduit',
    displayName: 'Lattice Conduit',
    category: 'logistics',
    tier: 5,
    footprint: SHAPES.square2,
    fill: 0x80f0c0,   // mint-cyan, sibling to the Lattice Node
    stroke: 0x205040,
    // §4.5 cross-island conduit — only cross-island carrier of the cluster
    // bonus. At/above a full Lattice Node BOM; x2 to bridge two islands.
    placementCost: { steel_beam: 2800, microchip: 450, wire: 220, exotic_alloy: 90, reality_anchor: 50, ai_core: 30 },
    glyph: '⌗',
  },
```

Confirm `SHAPES.square1` / `SHAPES.square2` exist (grep `SHAPES.square` in `building-defs.ts`); use whatever the 1×1 / 2×2 shape keys actually are. Confirm `glyph` is an existing field on the def shape; drop it if not.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/building-defs.test.ts -t "conduit defs"`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `cd server && npx tsc --noEmit` (and root `npm run build` if quick).
```bash
git add src/building-defs.ts src/building-defs.test.ts
git commit -m "feat(conduits): add cluster_conduit + lattice_conduit building defs"
```

---

### Task 2: Data model + persistence (v31 → v32)

**Files:**
- Modify: `src/world.ts` (add `ConduitLink` type + `World.conduitLinks` field + seed it in `makeInitialWorld`)
- Modify: `src/persistence.ts` (bump `SCHEMA_VERSION`, `SerializedSnapshotV31`, `migrateV31toV32`, `loadWorld` dispatch, `SUPPORTED_LOAD_VERSIONS`, serialize/deserialize `conduitLinks`)
- Test: `src/persistence.test.ts` (migration + round-trip)

**Interfaces:**
- Produces: `export interface ConduitLink { readonly a: string; readonly b: string }` (in `world.ts`); `World.conduitLinks: ConduitLink[]`; serialized snapshot carries `world.conduitLinks`.

`a`/`b` are conduit building IDs (globally unique per `world.ts`'s internal-id contract). Order-insensitive (a wire {a,b} ≡ {b,a}); dedup is Task 3's `addConduitLink`'s job.

- [ ] **Step 1: Write the failing test**

```ts
// src/persistence.test.ts — add to the existing suite
import { migrateV31toV32 } from './persistence.js';

it('v31 → v32 defaults conduitLinks to empty', () => {
  const v31 = { v: 31, world: { /* minimal valid v31 world without conduitLinks */ }, /* …rest */ } as any;
  const v32 = migrateV31toV32(v31);
  expect(v32.v).toBe(32);
  expect(v32.world.conduitLinks).toEqual([]);
});
```

Build the `v31` fixture by copying the shape an adjacent migration test uses (grep `migrateV30toV31` in `persistence.test.ts` for the existing fixture pattern and reuse it, changing `v: 30` → `v: 31`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/persistence.test.ts -t "conduitLinks"`
Expected: FAIL — `migrateV31toV32` not exported.

- [ ] **Step 3: Implement the data model and migration**

In `src/world.ts`, beside the `routes` field (`world.ts:1008`):
```ts
export interface ConduitLink {
  readonly a: string; // conduit building id
  readonly b: string; // conduit building id
}
```
Add `conduitLinks: ConduitLink[];` to the `World` interface, and `conduitLinks: []` to the object `makeInitialWorld` returns (`world.ts:1190`).

In `src/persistence.ts`:
```ts
export const SCHEMA_VERSION = 32 as const;
// …
export type SerializedSnapshotV31 = Omit<SaveSnapshot, 'v'> & { readonly v: 31 };

/** v31 → v32: introduce §4.5 cluster conduits. Old saves have no conduit
 *  links; default `world.conduitLinks` to empty so the feature is inert. */
export function migrateV31toV32(s: SerializedSnapshotV31): SaveSnapshot {
  return {
    ...s,
    v: 32 as const,
    world: { ...s.world, conduitLinks: (s.world as { conduitLinks?: unknown }).conduitLinks ?? [] },
  } as unknown as SaveSnapshot;
}
```
Add `32` to `SUPPORTED_LOAD_VERSIONS` (`persistence.ts:87`). In `loadWorld`'s version dispatch (the `=== 30` / `migrateV30toV31` block, `persistence.ts:1138`), add the v31 step **after** the v30 step:
```ts
  if ((snapshot as unknown as { v: number }).v === 31) {
    snapshot = migrateV31toV32(snapshot as unknown as SerializedSnapshotV31);
  }
```
Ensure the serialize path (`persistence.ts:969` neighborhood, where `world.routes` is written) writes `conduitLinks: world.conduitLinks` and the deserialize path (`persistence.ts:1226` neighborhood) reads `conduitLinks: snapshot.world.conduitLinks ?? []`.

- [ ] **Step 4: Add a round-trip identity test**

```ts
it('v32 round-trips conduitLinks', () => {
  const w = makeInitialWorld(/* same args other round-trip tests use */);
  w.conduitLinks = [{ a: 'b1', b: 'b2' }];
  const restored = loadWorld(serializeWorld(/* the snapshot wrapper these tests use */));
  expect(restored.conduitLinks).toEqual([{ a: 'b1', b: 'b2' }]);
});
```
Match the exact serialize/load helper names the existing round-trip tests call.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/persistence.test.ts -t "conduit"`
Expected: PASS. Then `cd server && npx tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add src/world.ts src/persistence.ts src/persistence.test.ts
git commit -m "feat(conduits): World.conduitLinks + v31→v32 migration"
```

---

### Task 3: Pure conduit helpers (`conduits.ts`)

**Files:**
- Create: `src/conduits.ts`
- Test: `src/conduits.test.ts`

**Interfaces:**
- Consumes: `World`, `ConduitLink` (`world.ts`); `PlacedBuilding` (`buildings.ts`); `BUILDING_DEFS`, `BuildingDefId` (`building-defs.ts`); `borderTiles`, `footprintKeySet`, `touchesBorder` (`adjacency.ts`); `participatesInCluster` (`buildings.ts`).
- Produces:
  - `CONDUIT_DEF_IDS: ReadonlySet<BuildingDefId>` — `{'cluster_conduit','lattice_conduit'}`.
  - `isConduit(defId): boolean`.
  - `buildingIslandIndex(world): Map<string, string>` — building-id → island-id, over all `world.islands[].buildings`.
  - `canWire(world, aId, bId): { ok: boolean; reason?: string }` — legality (both are conduits; not self; not already linked; if endpoints on different islands, BOTH must be `lattice_conduit`).
  - `addConduitLink(world, aId, bId): void` — validates via `canWire`, pushes a deduped `{a,b}` (canonicalize order: smaller id first).
  - `removeConduitLink(world, aId, bId): void`.
  - `pruneConduitLinksForBuilding(world, buildingId): void` — drops every link touching `buildingId` (called on demolish/relocate).
  - `conduitComponents(world): string[][]` — connected components of conduit IDs (union-find over `conduitLinks`).
  - `attachedBuildings(conduitId, world, index?): PlacedBuilding[]` — buildings 4-adjacent to that conduit's footprint that `participatesInCluster` and are NOT themselves conduits, on the SAME island as the conduit.
  - `conduitClusterUnions(world): ReadonlyArray<readonly [string, string]>` — for every conduit component, for every category, chain-union the attached buildings of that category across the whole component. Returns building-id pairs; category grouping uses each attached building's `BUILDING_DEFS[defId].category`.

`attachedBuildings` uses the same adjacency test as the cluster code: build the conduit's `footprintKeySet` → `borderTiles`, then for each candidate building on the conduit's island, `touchesBorder`. (A conduit only attaches buildings on its own island; cross-island reach comes from wiring conduit→conduit, not from a conduit attaching a remote building.)

- [ ] **Step 1: Write failing tests**

```ts
// src/conduits.test.ts
import { describe, it, expect } from 'vitest';
import { isConduit, canWire, addConduitLink, conduitComponents, conduitClusterUnions } from './conduits.js';
// helpers to build a tiny World with placed conduits + buildings — mirror the
// fixture style in adjacency.test.ts (placed buildings) + a 2-island world.

describe('conduits', () => {
  it('isConduit', () => {
    expect(isConduit('cluster_conduit')).toBe(true);
    expect(isConduit('iron_mine')).toBe(false);
  });

  it('same-island Cluster Conduit cannot form a cross-island wire', () => {
    // world: cluster_conduit C1 on island A, cluster_conduit C2 on island B
    const w = /* … */;
    expect(canWire(w, 'C1', 'C2').ok).toBe(false);
  });

  it('cross-island wire needs lattice_conduit at both ends', () => {
    // L1 (lattice) on A, L2 (lattice) on B, C1 (cluster) on A
    expect(canWire(w, 'L1', 'L2').ok).toBe(true);
    expect(canWire(w, 'L1', 'C1').ok).toBe(true);   // same island A → fine
    expect(canWire(w, 'C1', 'L2').ok).toBe(false);  // cross-island, C1 not lattice
  });

  it('conduitComponents unions transitively', () => {
    // links C1-C2, C2-C3 → one component {C1,C2,C3}
    addConduitLink(w, 'C1', 'C2'); addConduitLink(w, 'C2', 'C3');
    const comps = conduitComponents(w).map((c) => c.slice().sort());
    expect(comps).toContainEqual(['C1', 'C2', 'C3']);
  });

  it('conduitClusterUnions chains same-category attached buildings, not cross-category', () => {
    // C1 has smelter S1 + power P1 adjacent; C2 (wired to C1) has smelter S2.
    // → a union pair connecting S1 and S2; never S1–P1.
    addConduitLink(w, 'C1', 'C2');
    const pairs = conduitClusterUnions(w).map((p) => p.slice().sort());
    expect(pairs.some((p) => p[0] === 'S1' && p[1] === 'S2' || p[0] === 'S2' && p[1] === 'S1')).toBe(true);
    expect(pairs.some((p) => p.includes('P1'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/conduits.test.ts`
Expected: FAIL — module not found / functions undefined.

- [ ] **Step 3: Implement `conduits.ts`**

```ts
// src/conduits.ts — pure module, no PixiJS/DOM.
import { BUILDING_DEFS, type BuildingDef, type BuildingDefId } from './building-defs.js';
import { type PlacedBuilding, participatesInCluster } from './buildings.js';
import { borderTiles, footprintKeySet, touchesBorder } from './adjacency.js';
import type { World, ConduitLink } from './world.js';

export const CONDUIT_DEF_IDS: ReadonlySet<BuildingDefId> = new Set(['cluster_conduit', 'lattice_conduit']);
export function isConduit(defId: BuildingDefId): boolean { return CONDUIT_DEF_IDS.has(defId); }

const canon = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export function buildingIslandIndex(world: World): Map<string, string> {
  const idx = new Map<string, string>();
  for (const isl of world.islands) for (const b of isl.buildings) idx.set(b.id, isl.id);
  return idx;
}

function buildingById(world: World, id: string): PlacedBuilding | undefined {
  for (const isl of world.islands) { const b = isl.buildings.find((x) => x.id === id); if (b) return b; }
  return undefined;
}

export function canWire(world: World, aId: string, bId: string): { ok: boolean; reason?: string } {
  if (aId === bId) return { ok: false, reason: 'self' };
  const a = buildingById(world, aId), b = buildingById(world, bId);
  if (!a || !b) return { ok: false, reason: 'missing' };
  if (!isConduit(a.defId) || !isConduit(b.defId)) return { ok: false, reason: 'not-conduit' };
  const [c0, c1] = canon(aId, bId);
  if (world.conduitLinks.some((l) => { const [x, y] = canon(l.a, l.b); return x === c0 && y === c1; }))
    return { ok: false, reason: 'duplicate' };
  const idx = buildingIslandIndex(world);
  if (idx.get(aId) !== idx.get(bId)) {
    // cross-island wire: both ends must be lattice_conduit
    if (a.defId !== 'lattice_conduit' || b.defId !== 'lattice_conduit')
      return { ok: false, reason: 'cross-island-needs-lattice' };
  }
  return { ok: true };
}

export function addConduitLink(world: World, aId: string, bId: string): void {
  if (!canWire(world, aId, bId).ok) return;
  const [a, b] = canon(aId, bId);
  world.conduitLinks.push({ a, b });
}

export function removeConduitLink(world: World, aId: string, bId: string): void {
  const [c0, c1] = canon(aId, bId);
  world.conduitLinks = world.conduitLinks.filter((l) => { const [x, y] = canon(l.a, l.b); return !(x === c0 && y === c1); });
}

export function pruneConduitLinksForBuilding(world: World, buildingId: string): void {
  world.conduitLinks = world.conduitLinks.filter((l) => l.a !== buildingId && l.b !== buildingId);
}

export function conduitComponents(world: World): string[][] {
  const ids = new Set<string>();
  for (const l of world.conduitLinks) { ids.add(l.a); ids.add(l.b); }
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; let c = x; while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; } return r; };
  for (const l of world.conduitLinks) { const ra = find(l.a), rb = find(l.b); if (ra !== rb) parent.set(ra, rb); }
  const comps = new Map<string, string[]>();
  for (const id of ids) { const r = find(id); (comps.get(r) ?? comps.set(r, []).get(r)!).push(id); }
  return [...comps.values()];
}

export function attachedBuildings(
  conduitId: string, world: World, defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
): PlacedBuilding[] {
  const idx = buildingIslandIndex(world);
  const islandId = idx.get(conduitId);
  if (!islandId) return [];
  const isl = world.islands.find((i) => i.id === islandId);
  const conduit = isl?.buildings.find((b) => b.id === conduitId);
  if (!isl || !conduit) return [];
  const border = borderTiles(footprintKeySet(conduit, defs));
  const out: PlacedBuilding[] = [];
  for (const b of isl.buildings) {
    if (b.id === conduitId || isConduit(b.defId)) continue;
    if (!participatesInCluster(b)) continue;
    if (touchesBorder(b, border, defs)) out.push(b);
  }
  return out;
}

export function conduitClusterUnions(
  world: World, defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
): ReadonlyArray<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [];
  for (const comp of conduitComponents(world)) {
    // collect attached buildings across the whole component, grouped by category
    const byCat = new Map<string, string[]>();
    for (const cid of comp)
      for (const b of attachedBuildings(cid, world, defs)) {
        const cat = defs[b.defId].category;
        (byCat.get(cat) ?? byCat.set(cat, []).get(cat)!).push(b.id);
      }
    for (const ids of byCat.values()) {
      const uniq = [...new Set(ids)];
      for (let i = 1; i < uniq.length; i++) pairs.push([uniq[i - 1]!, uniq[i]!] as const);
    }
  }
  return pairs;
}
```

Note: `world.conduitLinks` is reassigned in remove/prune — keep the `World.conduitLinks` field non-`readonly` (it is, mirroring `routes`).

- [ ] **Step 4: Run tests, fix until green**

Run: `npx vitest run src/conduits.test.ts`
Expected: PASS (build the fixtures referenced in Step 1).

- [ ] **Step 5: Typecheck + commit**

```bash
cd server && npx tsc --noEmit && cd ..
git add src/conduits.ts src/conduits.test.ts
git commit -m "feat(conduits): pure wire-graph + attachment + legality helpers"
```

---

### Task 4: `clusterBonusMuls` accepts conduit unions

**Files:**
- Modify: `src/adjacency.ts` (`clusterBonusMuls` gains optional `conduitUnions` param; apply in union-find with same-category guard)
- Test: `src/adjacency.test.ts`

**Interfaces:**
- Consumes: `conduitClusterUnions` output shape (`ReadonlyArray<readonly [string, string]>`).
- Produces: `clusterBonusMuls(buildings, defs?, conduitUnions?)` — extra building-id pairs unioned into the same component **only when same category** (the per-category invariant is preserved even though the pair came from a conduit).

- [ ] **Step 1: Write the failing test**

```ts
// src/adjacency.test.ts — add
import { clusterBonusMuls } from './adjacency.js';

it('conduitUnions merge two distant same-category buildings into one cluster', () => {
  // two smelters far apart (not 4-adjacent), each floor 1 → c=2, rate 0.05
  const a = mkBuilding('A', 'blast_furnace', 0, 0);   // category 'smelting'
  const b = mkBuilding('B', 'blast_furnace', 50, 50);
  const lone = clusterBonusMuls([a, b]).get('A');
  expect(lone).toBe(1);                                // not adjacent → no bonus
  const wired = clusterBonusMuls([a, b], undefined, [['A', 'B']]).get('A');
  expect(wired).toBeCloseTo(1 + 0.05 * 2);             // K-c_A = (2+2)-2 = 2
});

it('conduitUnions never bridge across categories', () => {
  const s = mkBuilding('S', 'blast_furnace', 0, 0);   // smelting
  const p = mkBuilding('P', 'coal_generator', 50, 50); // power (use a real power defId)
  const r = clusterBonusMuls([s, p], undefined, [['S', 'P']]);
  expect(r.get('S')).toBe(1);                          // different categories → no union
});
```

Use real defIds for the categories (grep `category: 'smelting'` / `category: 'power'` in `building-defs.ts`). `mkBuilding` mirrors the existing `adjacency.test.ts` placement helper (set `floorLevel` so `clusterFloorCapacity` = 2).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/adjacency.test.ts -t "conduitUnions"`
Expected: FAIL — `clusterBonusMuls` ignores the third arg (arity error or wrong value).

- [ ] **Step 3: Implement**

In `adjacency.ts`, extend `clusterBonusMuls` signature and apply the unions after the physical-adjacency loop, guarded by category:
```ts
export function clusterBonusMuls(
  buildings: ReadonlyArray<PlacedBuilding>,
  defs: Readonly<Record<BuildingDefId, BuildingDef>> = BUILDING_DEFS,
  conduitUnions?: ReadonlyArray<readonly [string, string]>,
): Map<string, number> {
  // … existing union-find setup + physical-adjacency loop …

  // §4.5 conduit unions: merge wired same-category buildings into one component.
  if (conduitUnions && conduitUnions.length > 0) {
    const indexById = new Map<string, number>();
    buildings.forEach((b, i) => indexById.set(b.id, i));
    for (const [aId, bId] of conduitUnions) {
      const ia = indexById.get(aId), ib = indexById.get(bId);
      if (ia === undefined || ib === undefined) continue;          // building not in this pass's set
      if (defs[buildings[ia]!.defId].category !== defs[buildings[ib]!.defId].category) continue;
      union(ia, ib);
    }
  }

  // … existing compCap + per-building bonus loop unchanged …
}
```
The `conduitClusterUnions` helper already groups by category, so the guard here is defensive (and protects the cross-island path where a pair's buildings might differ). Keep it.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/adjacency.test.ts`
Expected: PASS (new + all existing cluster tests).

- [ ] **Step 5: Commit**

```bash
git add src/adjacency.ts src/adjacency.test.ts
git commit -m "feat(conduits): clusterBonusMuls accepts conduit union pairs (same-category-gated)"
```

---

### Task 5: Same-island wiring into the economy

**Files:**
- Modify: `src/economy.ts` (`getDerivationsMemo` / `computeRates` — derive same-island conduit unions, fold into the `clusterBonusMuls` call and the derivations signature)
- Modify: `src/economy.ts` `RatesContext`/`EconomyCtx` to carry `conduitUnions?: ReadonlyArray<readonly [string,string]>` (per-island pre-filtered to this island's building IDs)
- Modify: `src/economy-advance.ts` + `src/main.ts` to populate `conduitUnions` per island from `conduitClusterUnions(world)` filtered to the island
- Test: `src/economy.test.ts` (or a new `src/economy-conduits.test.ts`)

**Interfaces:**
- Consumes: `conduitClusterUnions(world)` (Task 3); the per-island building set (`state.buildings`).
- Produces: `ctx.conduitUnions` threaded into `getDerivationsMemo` → `clusterBonusMuls(clusterBuildings, defs, ctx.conduitUnions)`; the unions are part of `derivationsSignature` so the memo invalidates when wiring changes.

Same-island unions only here — both endpoints' attached buildings live in this island's `clusterBuildings`. (Cross-island is Task 6.) The caller filters `conduitClusterUnions(world)` to pairs where BOTH building IDs belong to the island being advanced (use `buildingIslandIndex`).

- [ ] **Step 1: Write the failing test**

```ts
// drive advanceIsland / computeRates on a one-island world with two distant
// same-category producers, assert the effective rate rises once a same-island
// conduit pair is supplied via ctx.conduitUnions (vs not).
```
Mirror the existing `economy.test.ts` setup that asserts a cluster-bonus effect; the assertion is "rate with conduitUnions > rate without".

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/economy*.test.ts -t "conduit"` → FAIL.

- [ ] **Step 3: Implement**

1. Add `conduitUnions?: ReadonlyArray<readonly [string, string]>` to the `RatesContext`/`EconomyCtx` interface (near `crossIsland`, `economy.ts:189`).
2. In `derivationsSignature` (`economy.ts:955`), append a stable serialization of `ctx.conduitUnions` (e.g. sorted `a|b` joined) so the memo key reflects wiring.
3. In `getDerivationsMemo` (`economy.ts:993`), pass `ctx.conduitUnions` into `clusterBonusMuls(clusterBuildings, defs, ctx?.conduitUnions)`. (Thread `ctx` into `getDerivationsMemo` if it isn't already — it currently takes `geothermalActive, crossIsland`; add `conduitUnions` alongside.)
4. In `economy-advance.ts` (the ctx builders at `:145` and `:174`) and `main.ts` (`:3109`, `:3133`, `:3162`): compute `const allUnions = conduitClusterUnions(world)` once per tick, and a per-island filter `unionsFor(id)` keeping pairs whose both IDs are on `id` (via `buildingIslandIndex(world)`); set `conduitUnions: unionsFor(s.id)` in each ctx.

- [ ] **Step 4: Run tests** — `npx vitest run src/economy*.test.ts` → PASS.

- [ ] **Step 5: Inert-when-empty check + commit**

Run the full client suite for the economy: `npx vitest run src/economy.test.ts`. Confirm no existing snapshot/golden changed (empty `conduitUnions` ⇒ identical output).
```bash
git add src/economy.ts src/economy-advance.ts src/main.ts src/economy*.test.ts
git commit -m "feat(conduits): same-island conduit unions feed the per-island cluster bonus"
```

---

### Task 6: Cross-island injection

**Files:**
- Modify: `src/economy.ts` (cluster pass folds in conduit-reachable remote attached buildings + their union pairs; signature includes them)
- Modify: `src/economy-advance.ts` + `src/main.ts` (build a per-island "conduit cross-island" set parallel to `crossIslandById`)
- Test: `src/economy-conduits.test.ts`

**Interfaces:**
- Consumes: `conduitComponents`, `attachedBuildings`, `buildingIslandIndex` (Task 3).
- Produces: per-island `conduitRemoteAttached: PlacedBuilding[]` (attached buildings living on OTHER islands but reachable through a cross-island wire to a conduit on THIS island) folded into the island's `clusterBuildings` set for the `clusterBonusMuls` pass, plus the union pairs connecting them; both reflected in `derivationsSignature`.

The cluster pass for island `I` must (a) include remote attached buildings in the `buildings` array handed to `clusterBonusMuls` so they add their floor-capacity to `K`, and (b) include the union pairs that connect local attached buildings to those remote ones. Build this in the per-tick setup:

```ts
// once per tick, parallel to crossIslandById:
const conduitUnionsAll = conduitClusterUnions(world);            // global building-id pairs
const idx = buildingIslandIndex(world);
const buildingObjById = new Map<string, PlacedBuilding>();
for (const isl of world.islands) for (const b of isl.buildings) buildingObjById.set(b.id, b);
// per island I: pairs touching I, plus the remote buildings those pairs reference
function conduitDataFor(islandId: string) {
  const pairs = conduitUnionsAll.filter(([a, b]) => idx.get(a) === islandId || idx.get(b) === islandId);
  const remote = new Map<string, PlacedBuilding>();
  for (const [a, b] of pairs)
    for (const id of [a, b])
      if (idx.get(id) !== islandId) { const ob = buildingObjById.get(id); if (ob) remote.set(id, ob); }
  return { pairs, remote: [...remote.values()] };
}
```

In `getDerivationsMemo`, when `ctx.conduitRemoteAttached?.length`, concatenate them onto `clusterBuildings` before calling `clusterBonusMuls(clusterBuildings.concat(remote), defs, ctx.conduitUnions)`. The resulting map covers remote IDs too, but only LOCAL operational buildings read their bonus, so the wider set is safe (same pattern the under-construction note at `economy.ts:988` relies on). Add a stable serialization of the remote set (ids + floorLevel) to `derivationsSignature`.

- [ ] **Step 1: Write the failing test** — two-island world, a `lattice_conduit` on each wired together, a same-category producer attached to each. Assert each producer's effective rate rises vs. unwired. → FAIL.

- [ ] **Step 2: Implement** per the sketch above (replace the Task-5 `conduitUnions: unionsFor(s.id)` with `conduitUnions: conduitDataFor(s.id).pairs` and add `conduitRemoteAttached: conduitDataFor(s.id).remote`). Cache `conduitDataFor` per id per tick.

- [ ] **Step 3: Run tests** — `npx vitest run src/economy-conduits.test.ts` → PASS.

- [ ] **Step 4: Inert-when-empty + commit**

```bash
git add src/economy.ts src/economy-advance.ts src/main.ts src/economy-conduits.test.ts
git commit -m "feat(conduits): cross-island conduit clustering via crossIsland-injection"
```

---

### Task 7: Input action + wiring UI

**Files:**
- Modify: `src/input.ts` (register a `wire-conduit` action + key binding)
- Create: `src/conduit-wiring-ui.ts` (wiring-mode interaction)
- Modify: `src/main.ts` (instantiate the wiring UI; on demolish/relocate of a conduit, call `pruneConduitLinksForBuilding`)

**Interfaces:**
- Consumes: `canWire`, `addConduitLink`, `removeConduitLink`, `isConduit` (Task 3); the existing building-pick / click-to-target machinery the routes UI uses.
- Produces: a wiring mode where the player picks conduit A then conduit B; on second pick, `canWire` gates the action (invalid → red tint, no-op), valid → `addConduitLink` (or `removeConduitLink` if the link exists — toggle). Reuse the routes link-draw interaction as the pattern.

Read `src/routes.ts` + the routes UI/overlay (grep `routes` in the `*-ui.ts` / `*-overlay.ts` files) before implementing — mirror its click-to-link interaction and its persistence-mutation pattern. Add the action via `input.ts`'s `actions`/`bindings` registry (per AGENTS.md: no hardcoded `e.code` outside `input.ts`); pick an unused key (e.g. a chord or an unused letter — verify against the ~26 existing binds listed in `input.ts`).

- [ ] **Step 1:** Register the action + binding in `input.ts`; add a focused test in `src/input.test.ts` that dispatching the action toggles the wiring mode flag (mirror an existing input-action test).
- [ ] **Step 2:** Run the input test → FAIL → implement → PASS.
- [ ] **Step 3:** Implement `conduit-wiring-ui.ts` interaction; wire it into `main.ts`. Manual smoke per the AGENTS.md screenshot path (build + reload + `mcp__daedalus__screenshot`).
- [ ] **Step 4:** Add the demolish/relocate prune call in the building-removal path in `main.ts` (and any pure removal helper), so links don't dangle.
- [ ] **Step 5: Commit**

```bash
git add src/input.ts src/input.test.ts src/conduit-wiring-ui.ts src/main.ts
git commit -m "feat(conduits): wiring-mode input action + conduit-to-conduit link UI"
```

---

### Task 8: Wire render overlay (`conduit-overlay.ts`)

**Files:**
- Create: `src/conduit-overlay.ts` (render layer — may import `pixi.js`)
- Modify: `src/main.ts` (add the overlay layer to the world container; refresh per frame)
- Modify: `AGENTS.md` (add `conduit-overlay.ts` to the render-layer file list + overlay count)

**Interfaces:**
- Consumes: `world.conduitLinks`, building positions (conduit world tiles via `tileToWorldPx`); the camera/world container.
- Produces: a `ConduitOverlay` with a signature-gated `refresh(world)` — draws a line between each linked conduit pair's centres. Per the AGENTS.md per-frame discipline: gate `refresh()` on a string signature of exactly the fields the draw reads (`conduitLinks` endpoints + their resolved positions); identical signature ⇒ skip redraw. Apply the `−half` cell-centre convention (`buildings.ts` `renderBuildings` uses `t.x * TILE_PX - half`) so the line endpoints land on conduit centres.

Mirror `routes-renderer.ts` / a `*-overlay.ts` (e.g. `weather-overlay.ts` for the signature-gate pattern) for structure.

- [ ] **Step 1:** Implement the overlay with the signature gate (no test — render layer is read-only against state; verify visually).
- [ ] **Step 2:** Wire into `main.ts` render setup; `npm run build`; reload; `mcp__daedalus__screenshot` to confirm wires draw between conduits and align to centres.
- [ ] **Step 3: Commit**

```bash
git add src/conduit-overlay.ts src/main.ts AGENTS.md
git commit -m "feat(conduits): conduit-link render overlay (signature-gated)"
```

---

### Task 9: Inspector panel

**Files:**
- Modify: `src/inspector-ui.ts` (when a conduit is selected, show its attached buildings + wire count; optionally a "remove wire" affordance)
- Test: none (render/DOM) — verify visually.

**Interfaces:**
- Consumes: `attachedBuildings`, `conduitComponents`, `world.conduitLinks`, `isConduit` (Task 3).

- [ ] **Step 1:** In `inspector-ui.ts`, branch on `isConduit(selected.defId)`: render attached-building count (`attachedBuildings(id, world).length`) and wire count (`world.conduitLinks.filter(l => l.a === id || l.b === id).length`). Mirror the existing inspector section layout.
- [ ] **Step 2:** `npm run build`; reload; screenshot a selected conduit.
- [ ] **Step 3: Commit**

```bash
git add src/inspector-ui.ts
git commit -m "feat(conduits): inspector panel for conduit attachments + wires"
```

---

### Task 10: SPEC.md + catalog + tier table

**Files:**
- Modify: `SPEC.md` (§4.5 sub-section; §8 catalog rows; tier/build-order rows)

**Interfaces:** none.

- [ ] **Step 1:** Add a §4.5 sub-section after the buff-adjacency paragraph documenting: the two conduit buildings; 4-adjacent attachment; transitive wired-network clustering at full strength; same-category preservation; the rule that a cross-island wire requires a `lattice_conduit` at both ends; and that the Lattice Conduit is the **only** cross-island carrier of the §4.5 cluster bonus (distinct from §13.3's Lattice Node, which carries gating adjacency + exotic pairs but not this term). Reference `conduits.ts` (`conduitClusterUnions`) + `clusterBonusMuls`'s `conduitUnions` param + `World.conduitLinks` (persisted; v32).
- [ ] **Step 2:** Add `cluster_conduit` / `lattice_conduit` rows to the §8 building catalog (footprint, tier, cost, "no recipe; cluster-bonus connectivity").
- [ ] **Step 3:** Update the §13.3 cross-reference note so the Lattice-Node paragraph explicitly points at the Lattice Conduit for cluster-bonus transport.
- [ ] **Step 4: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): §4.5 cluster conduits — wired-network clustering + catalog"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** §2.1 buildings → T1; §2.1 cost → T1; §2.2 attachment (`attachedBuildings`) → T3; §2.3 wiring + legality + transitive → T3/T4/T7; §2.4 full-strength semantics → T4; §3.1 data/persistence → T2; §3.2 cluster computation → T4; §3.3 same-island → T5, cross-island → T6; §3.4 inspector → T9; UI/overlay → T7/T8; SPEC → T10; demolish-prune risk → T7. All spec sections mapped.
- **Type consistency:** `ConduitLink {a,b}` (T2) used unchanged in T3/T7/T8; `conduitClusterUnions(): ReadonlyArray<readonly [string,string]>` (T3) is exactly the `conduitUnions` type `clusterBonusMuls` accepts (T4) and the economy threads (T5/T6). `attachedBuildings`/`conduitComponents` signatures consistent across T3/T6/T9.
- **Placeholder scan:** UI tasks (T7–T9) intentionally point at the routes-UI / overlay patterns to mirror rather than reproducing render code that depends on unread Pixi/DOM APIs — each step names the exact file to mirror and the concrete adaptation. Pure-layer + persistence tasks (T1–T6) carry full code.
- **Inert-when-empty** verified as an explicit step in T5/T6 (no golden/oracle movement with empty `conduitLinks`).
