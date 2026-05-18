# Ocean Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Ocean Layer spec at `docs/superpowers/specs/2026-05-18-ocean-layer-design.md` — a new placement surface between islands that hosts 12 cable-tethered extraction/processing buildings producing T5/T6 exotic inputs, with two-axis discovery (surface + depth), multi-cell terrain clusters, player-selected anchor islands, and a load-bearing hover tooltip.

**Architecture:** Pure-layer additions (`ocean-cell.ts`, `ocean-gen.ts`, `sonar-buoy.ts`, `submarine-cable.ts`) extend the existing world state with `oceanCells: Map<string, OceanCellSpec>` and `depthRevealedCells: Set<string>`. Render-layer additions (`ocean.ts` extension, `hover-tooltip.ts`) wire the new state into the existing PixiJS pipeline. 12 new building defs + ~25 recipes + ~20 ResourceIds drop into the existing economy via the standard `BUILDING_DEFS` / `RECIPES` tables. No new dispatch graph — ocean platforms are logically buildings on their player-selected anchor island.

**Tech Stack:** Same as the rest of the project — Vite 5 + TypeScript strict + PixiJS 8 + vitest. No new dependencies.

---

## File structure

### New files

| Path | Responsibility |
|---|---|
| `src/ocean-cell.ts` | `OceanCellSpec` type + pure query helpers (`terrainAt`, `footprintMatches`, `clusterAnchorOf`) |
| `src/ocean-gen.ts` | Procedural ocean terrain seeding called from `generateWorld` |
| `src/sonar-buoy.ts` | Per-tick Sonar Buoy logic that writes to `revealedCells` + `depthRevealedCells` |
| `src/submarine-cable.ts` | Submarine cable variant logic (placement validation, adjacency with land cable). May fold into `routes.ts` if cable code is centralized there. |
| `src/anchor-picker.ts` | Modal for player-selected anchor island at ocean-building placement. Reuses the modal shell from `src/cargo-label-picker.ts`. |
| `src/hover-tooltip.ts` | DOM overlay for cell hover info (terrain, cluster, weather, building). Pure `cellInfoForHover()` helper + DOM rendering. |

### Modified files

| Path | What changes |
|---|---|
| `src/world.ts` | Add `World.oceanCells: Map<string, OceanCellSpec>` field. Add `WorldState.depthRevealedCells: Set<string>` field. |
| `src/world-gen.ts` | Call `generateOceanTerrain(seed, islands)` after island placement. |
| `src/persistence.ts` | Serialize/deserialize `oceanCells` + `depthRevealedCells`. Schema bump v4 → v5 with migration path. |
| `src/discovery.ts` | Export the new `depthRevealedCells` reveal helpers. Existing surface-discovery API unchanged. |
| `src/orbital.ts` | Extend Scanner Sat tick to write `revealedCells` + `depthRevealedCells` for ocean cells in coverage (in addition to existing island discovery). |
| `src/placement.ts` | After tile commit for an ocean building, transition to `awaiting-anchor` state; emit anchor picker; complete placement with chosen `anchorIslandId`. Validate footprint-match against ocean terrain. |
| `src/economy.ts` | `paused` reason enum gains `'anchor-depopulated'`, `'anchor-disconnected'`, `'terrain-lost'`. No change to `advanceIsland` (ocean platforms are normal buildings on the anchor island). |
| `src/inspector-ui.ts` | Display chips for the three new paused reasons. Submarine cable + Sonar Buoy display headers. |
| `src/building-defs.ts` | Add 12 new building defs with `oceanPlacement: true` + `terrainReqs: readonly OceanTerrain[]`. |
| `src/recipes.ts` | ~25 new recipes + ~20 new `ResourceId` entries. |
| `src/storage-categories.ts` | Categorize the new resources. |
| `src/inventory-ui.ts` | Parallel categorization. |
| `src/ocean.ts` | Add feature-glyph render pass between fog sprites and weather overlay z-layer. Extract `cellAtScreenPx()` helper as pure function for hover. |
| `src/main.ts` | Wire hover tooltip into input pipeline. |
| `SPEC.md` | New §3.x subsection documenting the ocean layer (cross-reference §2.6 weather, §5.3 power, §14.5 sat coverage). |

### Test files (new + extended)

| Path | Coverage |
|---|---|
| `src/ocean-gen.test.ts` (new) | Terrain seeding determinism, cluster shapes, biome correlations, non-overlap |
| `src/ocean-cell.test.ts` (new) | `terrainAt`, `footprintMatches`, `clusterAnchorOf` |
| `src/sonar-buoy.test.ts` (new) | Powered buoy writes both sets; unpowered doesn't; multi-buoy union |
| `src/submarine-cable.test.ts` (new) | Ocean-only placement; land-cable adjacency joins §5.3 pool |
| `src/discovery.test.ts` (extended) | `depthRevealedCells` independence + persistence |
| `src/orbital.test.ts` (extended) | Scanner Sat ocean-cell reveal; in-transit sats don't reveal |
| `src/placement.test.ts` (extended) | Ocean placement: footprint-match, anchor picker, cancel |
| `src/economy.test.ts` (extended) | Anchor crediting, `paused` states |
| `src/persistence.test.ts` (extended) | v4 → v5 migration |

---

## Implementation order

12 tasks. Each ships as its own commit. Order matters: tasks 1-3 establish data primitives that everything else depends on; tasks 4-7 add discovery/infra; tasks 8-10 add the building catalog; tasks 11-12 add the render/UI layer.

> **TDD discipline reminder for every task:** write the failing test first, run it to confirm it fails for the expected reason, write the minimal implementation, run again to confirm pass, commit. Do not skip the red phase. Verification before completion: when you say tests pass, you must have run `npm test` FOREGROUND in this turn. **Do NOT background `npm test` or `npm run build`** — past agents that did got killed by the harness waiting for completion notifications. Run them foreground with explicit timeouts (15-30s each).

> **Commit trailer:** every commit ends with `Co-Authored-By: <Your Model> <noreply@anthropic.com>` using your own model name (Claude Sonnet 4.6 / Haiku 4.5 / Opus 4.7, whichever ran the dispatch).

---

### Task 1: Data primitives — `OceanCellSpec` + world fields

**Spec section:** §2

**Files:**
- Create: `src/ocean-cell.ts`
- Modify: `src/world.ts` (add `oceanCells` to `World`, `depthRevealedCells` to `WorldState`)
- Test: `src/ocean-cell.test.ts` (new)

- [ ] **Step 1: Write the failing tests in `src/ocean-cell.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { terrainAt, footprintMatches, type OceanCellSpec } from './ocean-cell.js';

const mkWorld = (cells: Array<[number, number, OceanCellSpec['terrain']]>) => ({
  oceanCells: new Map(cells.map(([x, y, t]) => [`${x},${y}`, { terrain: t }] as const)),
});

describe('terrainAt', () => {
  it('returns the cell terrain when present', () => {
    const w = mkWorld([[0, 0, 'shallows']]);
    expect(terrainAt(w, 0, 0)).toBe('shallows');
  });

  it('returns the implicit "deep" default for unmapped cells', () => {
    const w = mkWorld([]);
    expect(terrainAt(w, 5, 5)).toBe('deep');
  });
});

describe('footprintMatches', () => {
  it('returns true when every footprint tile matches the required terrain', () => {
    const w = mkWorld([
      [0, 0, 'hydrothermal_vent'], [1, 0, 'hydrothermal_vent'],
      [0, 1, 'hydrothermal_vent'], [1, 1, 'hydrothermal_vent'],
    ]);
    expect(footprintMatches(w, 0, 0, 2, 2, ['hydrothermal_vent'])).toBe(true);
  });

  it('returns false when any footprint tile is wrong terrain', () => {
    const w = mkWorld([
      [0, 0, 'hydrothermal_vent'], [1, 0, 'hydrothermal_vent'],
      [0, 1, 'hydrothermal_vent'], [1, 1, 'deep'],
    ]);
    expect(footprintMatches(w, 0, 0, 2, 2, ['hydrothermal_vent'])).toBe(false);
  });

  it('accepts an OR list of terrains', () => {
    const w = mkWorld([
      [0, 0, 'shallows'], [1, 0, 'deep'],
      [0, 1, 'shallows'], [1, 1, 'shallows'],
    ]);
    expect(footprintMatches(w, 0, 0, 2, 2, ['shallows', 'deep'])).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/ocean-cell.test.ts`
Expected: FAIL — `Cannot find module './ocean-cell.js'`.

- [ ] **Step 3: Implement `src/ocean-cell.ts`**

```typescript
export type OceanTerrain =
  | 'shallows'
  | 'deep'
  | 'trench'
  | 'hydrothermal_vent'
  | 'nodule_field';

export interface OceanCellSpec {
  readonly terrain: OceanTerrain;
}

interface OceanWorld {
  readonly oceanCells: ReadonlyMap<string, OceanCellSpec>;
}

const key = (x: number, y: number): string => `${x},${y}`;

/** Look up the terrain at an ocean cell. Returns 'deep' for cells not
 *  explicitly stored in the map (the implicit default for empty sea). */
export function terrainAt(world: OceanWorld, cellX: number, cellY: number): OceanTerrain {
  return world.oceanCells.get(key(cellX, cellY))?.terrain ?? 'deep';
}

/** Returns true iff every tile under the building's footprint
 *  (anchorX..anchorX+w-1, anchorY..anchorY+h-1) matches one of the
 *  required terrains. */
export function footprintMatches(
  world: OceanWorld,
  anchorX: number,
  anchorY: number,
  footprintW: number,
  footprintH: number,
  requiredTerrains: readonly OceanTerrain[],
): boolean {
  for (let dy = 0; dy < footprintH; dy++) {
    for (let dx = 0; dx < footprintW; dx++) {
      const t = terrainAt(world, anchorX + dx, anchorY + dy);
      if (!requiredTerrains.includes(t)) return false;
    }
  }
  return true;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/ocean-cell.test.ts`
Expected: PASS — 4/4.

- [ ] **Step 5: Extend `World` and `WorldState` in `src/world.ts`**

Find the `World` interface and add (preserving existing fields):

```typescript
import type { OceanCellSpec } from './ocean-cell.js';

export interface World {
  // ... existing fields ...
  readonly oceanCells: ReadonlyMap<string, OceanCellSpec>;
}
```

Find the `WorldState` interface and add:

```typescript
export interface WorldState {
  // ... existing fields ...
  readonly depthRevealedCells: Set<string>;
}
```

Update `makeInitialWorld` / `makeInitialWorldState` (or equivalents) to initialize the new fields to `new Map()` and `new Set<string>()` respectively.

- [ ] **Step 6: Run the full suite + build, confirm no regressions**

Run: `npm test` (foreground), expect 1746/1746 + 4 new = 1750 pass.
Run: `npm run build` (foreground), expect exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/ocean-cell.ts src/ocean-cell.test.ts src/world.ts
git commit -m "feat(ocean): OceanCellSpec + world fields (Task 1)"
```

---

### Task 2: World-gen — `generateOceanTerrain`

**Spec section:** §2 (generation rules)

**Files:**
- Create: `src/ocean-gen.ts`
- Modify: `src/world-gen.ts` (call `generateOceanTerrain` after island placement)
- Test: `src/ocean-gen.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { generateOceanTerrain } from './ocean-gen.js';
import type { IslandSpec } from './world.js';

// Minimal island fixture — only fields ocean-gen reads.
const mkIsland = (id: string, biome: IslandSpec['biome'], cx: number, cy: number, rx = 6, ry = 4): IslandSpec => ({
  id, name: id, biome, cx, cy, rx, ry,
  populated: false, discovered: false, buildings: [], modifiers: [],
} as IslandSpec);

describe('generateOceanTerrain', () => {
  const ISLANDS = [
    mkIsland('home', 'plains', 0, 0),
    mkIsland('vol', 'volcanic', 40, 0),
    mkIsland('cst', 'coast', -40, 30),
  ];

  it('is deterministic for the same seed', () => {
    const a = generateOceanTerrain('seed-1', ISLANDS);
    const b = generateOceanTerrain('seed-1', ISLANDS);
    expect(Array.from(a.entries()).sort()).toEqual(Array.from(b.entries()).sort());
  });

  it('seeds shallows within R=2 cells of an island edge', () => {
    const cells = generateOceanTerrain('seed-1', ISLANDS);
    // The home island ellipse occupies roughly cells (-1..0, -1..0) at CELL_SIZE_TILES=16.
    // A cell two cells away from the ellipse edge should be shallows.
    const shallowsHits = Array.from(cells.values()).filter(c => c.terrain === 'shallows').length;
    expect(shallowsHits).toBeGreaterThan(0);
  });

  it('seeds trenches as 2xN rectangles in deep zones', () => {
    const cells = generateOceanTerrain('seed-trench', ISLANDS);
    const trenchCells = Array.from(cells.entries()).filter(([, c]) => c.terrain === 'trench');
    // Should appear in clusters whose dimensions are 2xN with N in [4, 8].
    // Detailed shape assertion: group cells into connected components, each component
    // must be a 2xN rectangle.
    expect(trenchCells.length).toBe(0); // 'seed-trench' may roll zero trenches; pick a seed known to roll at least one.
    // NOTE: implementer should pick a seed that reliably rolls at least one trench
    // and assert the rectangle shape (use a connected-components helper inline).
  });

  it('vent clusters are biased toward volcanic islands', () => {
    const cells = generateOceanTerrain('seed-vent', ISLANDS);
    const vents = Array.from(cells.entries())
      .filter(([, c]) => c.terrain === 'hydrothermal_vent')
      .map(([k]) => k.split(',').map(Number) as [number, number]);
    // All vent cells should be within R=5 of the volcanic island at (40, 0).
    const VOLCANIC_CELL_X = Math.floor(40 / 16);
    const VOLCANIC_CELL_Y = Math.floor(0 / 16);
    for (const [vx, vy] of vents) {
      const dist = Math.hypot(vx - VOLCANIC_CELL_X, vy - VOLCANIC_CELL_Y);
      expect(dist).toBeLessThanOrEqual(7); // R=5 + ellipse radius slack
    }
  });

  it('nodule fields and trenches never overlap', () => {
    const cells = generateOceanTerrain('seed-1', ISLANDS);
    for (const [k, c] of cells.entries()) {
      if (c.terrain === 'trench') {
        // No cell should be BOTH trench and nodule_field.
        // Map-key uniqueness already guarantees this — the assertion is
        // that the placement loop respects the non-overlap invariant.
        // Indirect check: count of cells with each terrain matches expected ranges.
      }
    }
    // Direct assertion: walk both types and verify cell-key sets are disjoint.
    const trenchKeys = new Set(
      Array.from(cells.entries()).filter(([, c]) => c.terrain === 'trench').map(([k]) => k),
    );
    const noduleKeys = new Set(
      Array.from(cells.entries()).filter(([, c]) => c.terrain === 'nodule_field').map(([k]) => k),
    );
    for (const k of trenchKeys) expect(noduleKeys.has(k)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/ocean-gen.test.ts`
Expected: FAIL — `Cannot find module './ocean-gen.js'`.

- [ ] **Step 3: Implement `src/ocean-gen.ts`**

Reference: spec §2 generation rules. Key design points:

- Iteration order: shallows → trenches → nodule fields → vents → deep (default).
- Per-feature RNG streams: `makeSeededRng(\`${seed}_ocean_<feature>\`)`. Mirrors `world-gen.ts` `rollCoastRotation` pattern (commit `a6578df`).
- Trenches: 0-3 per world; each a 2×N rectangle (N=4-8); drawn between two random deep-zone endpoints. Trench width 2; rare 3-wide roll 10%.
- Nodule fields: 2-5 per world; 3×3 clusters in deep zones (>R=8 from any island edge); reject if overlaps a trench cell.
- Vents: 0-3 per Volcanic island; cluster anchor within R=5 of island edge; cluster shape 2×2 (60%), 3×2 (30%), 2×3 (10%); reject if overlaps trench or nodule field.
- Shallows: derived — any cell within R=2 of an island edge (use `islandsOverlap` or a simpler radial check).

Function signature:

```typescript
import { CELL_SIZE_TILES } from './constants.js';
import { makeSeededRng } from './world-gen.js';
import type { IslandSpec } from './world.js';
import type { OceanCellSpec, OceanTerrain } from './ocean-cell.js';

export function generateOceanTerrain(
  seed: string,
  islands: readonly IslandSpec[],
): Map<string, OceanCellSpec> {
  const cells = new Map<string, OceanCellSpec>();
  // Step 1: shallows from island proximity (R=2).
  seedShallows(cells, islands);
  // Step 2: trenches (2xN rectangles in deep zones).
  seedTrenches(cells, seed, islands);
  // Step 3: nodule fields (3x3 clusters in deep zones, non-overlapping with trenches).
  seedNoduleFields(cells, seed, islands);
  // Step 4: vents (small clusters near volcanic islands, non-overlapping with trenches/nodules).
  seedVents(cells, seed, islands);
  return cells;
}

// Implementer: each `seed<X>` helper is a private function in this file.
// Use cell coordinates: cellX = floor(tileX / CELL_SIZE_TILES), cellY = floor(tileY / CELL_SIZE_TILES).
// Island ellipses are in tile coordinates; their cell footprint is islandSpec.cx ± rx, scaled.
```

Implement each `seed<X>` helper following the design in spec §2. Reference `src/world-gen.ts` `rollCoastRotation` for the per-stream RNG pattern.

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/ocean-gen.test.ts`
Expected: PASS — all tests.

If the trench test was originally skipped pending a known seed, find a deterministic seed that rolls at least one trench (try `'trench-test'`, `'a'`, `'b'` etc.) and finalize the assertion.

- [ ] **Step 5: Wire into `src/world-gen.ts`**

In `generateWorld`, after islands are placed but before returning, call:

```typescript
const oceanCells = generateOceanTerrain(opts.seed, islands);
return { ...rest, islands, oceanCells };
```

- [ ] **Step 6: Run full suite + build**

Run: `npm test` (foreground), expect prior count + 5 new = 1755 pass.
Run: `npm run build` (foreground), exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/ocean-gen.ts src/ocean-gen.test.ts src/world-gen.ts
git commit -m "feat(ocean): generateOceanTerrain — 5 terrain types seeded per spec §2 (Task 2)"
```

---

### Task 3: Persistence — v4 → v5 migration

**Spec section:** §2 migration

**Files:**
- Modify: `src/persistence.ts` (schema bump + migration; serialize new fields)
- Test: `src/persistence.test.ts` (extend with v4 → v5 migration test)

- [ ] **Step 1: Write the failing test in `src/persistence.test.ts`**

Add to the existing describe block:

```typescript
import { generateOceanTerrain } from './ocean-gen.js';

describe('v4 → v5 ocean migration', () => {
  it('populates oceanCells by re-deriving from world seed on load', () => {
    const v4Save = {
      schemaVersion: 4,
      world: {
        seed: 'migration-seed-1',
        islands: [/* minimal island fixture */],
        // No oceanCells field
      },
      worldState: {
        revealedCells: ['0,0', '1,0'],
        // No depthRevealedCells field
      },
    };
    const loaded = loadSerialized(JSON.stringify(v4Save));
    expect(loaded.world.oceanCells).toBeDefined();
    // The migrated terrain should match a fresh generateOceanTerrain call.
    const expected = generateOceanTerrain('migration-seed-1', loaded.world.islands);
    expect(Array.from(loaded.world.oceanCells.entries()).sort())
      .toEqual(Array.from(expected.entries()).sort());
    expect(loaded.worldState.depthRevealedCells).toEqual(new Set());
    expect(loaded.worldState.revealedCells).toEqual(new Set(['0,0', '1,0']));
  });

  it('bumps the in-memory schema version to 5', () => {
    const v4Save = { schemaVersion: 4, world: { seed: 'x', islands: [] }, worldState: { revealedCells: [] } };
    const loaded = loadSerialized(JSON.stringify(v4Save));
    // After load, a re-serialize should write v5.
    const reSerialized = JSON.parse(serializeWorldState(loaded.world, loaded.worldState));
    expect(reSerialized.schemaVersion).toBe(5);
  });

  it('rejects pre-v4 saves with unknown schema', () => {
    const v3Save = { schemaVersion: 3 };
    expect(() => loadSerialized(JSON.stringify(v3Save))).toThrow(/unknown schema/i);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/persistence.test.ts -t "v4 → v5"`
Expected: FAIL — migration not implemented.

- [ ] **Step 3: Implement the migration in `src/persistence.ts`**

Find the `SCHEMA_VERSION` constant; bump from 4 to 5. Find the load path (probably `loadSerialized` or `deserializeWorld`); add migration:

```typescript
import { generateOceanTerrain } from './ocean-gen.js';

const SCHEMA_VERSION = 5;

function migrateV4ToV5(parsed: any): any {
  if (parsed.schemaVersion !== 4) return parsed;
  // Add oceanCells by re-deriving from seed
  const oceanCellsMap = generateOceanTerrain(parsed.world.seed, parsed.world.islands);
  parsed.world.oceanCells = Array.from(oceanCellsMap.entries()); // serialized form
  // Add empty depthRevealedCells
  parsed.worldState.depthRevealedCells = [];
  parsed.schemaVersion = 5;
  return parsed;
}

// In loadSerialized (or equivalent):
function loadSerialized(json: string): { world: World; worldState: WorldState } {
  let parsed = JSON.parse(json);
  if (parsed.schemaVersion < 4) throw new Error(`unknown schema version: ${parsed.schemaVersion}`);
  if (parsed.schemaVersion === 4) parsed = migrateV4ToV5(parsed);
  if (parsed.schemaVersion !== 5) throw new Error(`unknown schema version: ${parsed.schemaVersion}`);
  // ... existing deserialize logic, plus:
  const world = {
    ...rest,
    oceanCells: new Map(parsed.world.oceanCells),
  };
  const worldState = {
    ...rest,
    depthRevealedCells: new Set(parsed.worldState.depthRevealedCells ?? []),
    revealedCells: new Set(parsed.worldState.revealedCells ?? []),
  };
  return { world, worldState };
}
```

Update `serializeWorldState` (or equivalent) to write `oceanCells` as `Array.from(world.oceanCells.entries())` and `depthRevealedCells` as `Array.from(state.depthRevealedCells)`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/persistence.test.ts -t "v4 → v5"`
Expected: PASS.

- [ ] **Step 5: Run full suite + build**

Run: `npm test` (foreground). All existing persistence round-trip tests should still pass (`SCHEMA_VERSION` bump is backwards-compat for v4; older versions explicitly rejected per existing policy).
Run: `npm run build` (foreground), exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/persistence.ts src/persistence.test.ts
git commit -m "feat(persistence): v4 → v5 ocean migration — re-derive terrain from seed (Task 3)"
```

---

### Task 4: Submarine cable as new `RouteType` (REVISED — see note)

**REVISED 2026-05-18**: the original Task 4 (and spec §4) assumed cable was a tile-placed building. Reality: `cable` is a `RouteType` (inter-island route between two `power_substation` buildings). The §5.3 unified pool walks islands+routes via `computeCableNetworkBalance`, not cells. This task is rewritten to match. Spec §4 has been updated in the same commit cycle.

**Spec section:** §4 (revised)

**Files:**
- Modify: `src/routes.ts` — add `'submarine_cable'` to `RouteType` union; extend `isPowerLink` to include it
- Modify: `src/building-defs.ts` — `power_substation` may need a flag/connection-variant update to accept submarine cable routes (verify the existing cable route's structure first)
- Modify: `src/recipes.ts` — add `submarine_cable` recipe + `lead_sheath` resource if missing
- Modify: `src/routes-ui.ts` (or wherever route creation UI lives) — extend the route-type picker / creation flow to offer submarine_cable as a tier-3 option
- Test: `src/routes.test.ts` extension OR new `src/submarine-cable.test.ts`

- [ ] **Step 1: Understand the existing cable route structure**

Before writing tests, read:
- `src/routes.ts` — `RouteType` union, `Route` discriminated union shape, `isPowerLink`, `computeCableNetworkBalance`
- `src/building-defs.ts` — `power_substation` def, `cable` route's interaction with substations
- `src/routes.test.ts` — how existing cable routes are tested (so submarine_cable tests mirror the pattern)
- `src/routes-ui.ts` (if exists) — how the player creates routes
- Whatever recipe produces the existing `cable` resource (if there is one) — submarine_cable should mirror

- [ ] **Step 2: Write the failing tests**

Sketch (adjust to match existing route-test patterns):

```typescript
describe('§4 submarine_cable RouteType', () => {
  it("'submarine_cable' is a valid RouteType", () => {
    // Construct a Route with type: 'submarine_cable' between two islands;
    // verify the type system accepts it and the route is well-formed.
  });

  it('isPowerLink returns true for submarine_cable', () => {
    expect(isPowerLink('submarine_cable')).toBe(true);
  });

  it('submarine_cable routes contribute to §5.3 unified pool', () => {
    // Build a world: island A populated with substation, island B populated with substation,
    // submarine_cable route between them. computeCableNetworkBalance should show both islands
    // in the same connected component.
  });

  it('a fresh submarine_cable route requires both endpoints to have power_substation', () => {
    // Same constraint as land cable.
  });
});

describe('§4 submarine_cable recipe', () => {
  it('exists with inputs { rubber: 2, lead_sheath: 1, copper_wire: 1 }', () => {
    const r = RECIPES.submarine_cable_recipe!;
    expect(r.inputs).toEqual({ rubber: 2, lead_sheath: 1, copper_wire: 1 });
    expect(r.outputs).toEqual({ submarine_cable: 1 });
  });
});
```

Adjust the recipe-name and resource-name placeholders to match what actually fits the codebase (e.g. if the existing `cable` is the resource AND the route type uses it as a transmission medium, you may need to name the new resource carefully).

- [ ] **Step 3: Run tests, verify they fail**

Run: `npx vitest run src/routes.test.ts -t "submarine_cable"` FOREGROUND.
Expected: FAIL — RouteType doesn't include 'submarine_cable' yet.

- [ ] **Step 4: Extend `RouteType` and `isPowerLink` in `src/routes.ts`**

```typescript
export type RouteType = 'cargo' | 'drone' | 'airship' | 'teleporter' | 'cable' | 'spacetime' | 'mass_driver' | 'submarine_cable';
//                                                                                                                ^^^^^^^^^^^^^^^^^
```

Extend `isPowerLink`:

```typescript
function isPowerLink(t: RouteType): boolean {
  return t === 'cable' || t === 'spacetime' || t === 'submarine_cable';
}
```

- [ ] **Step 5: Add recipe + resources in `src/recipes.ts`**

Add `submarine_cable` ResourceId. Add `lead_sheath` if missing (with a minimal stub recipe). Add `submarine_cable_recipe`:

```typescript
submarine_cable_recipe: {
  id: 'submarine_cable_recipe',
  building: 'submarine_cable_factory', // or wherever the existing cable recipe builds — match its building
  inputs: { rubber: 2, lead_sheath: 1, copper_wire: 1 },
  outputs: { submarine_cable: 1 },
  cycleSec: 60, // mirror existing cable recipe cycle
  category: 'infrastructure',
} as const,
```

Verify the existing cable recipe FIRST — submarine_cable should mirror its `building` field. If land cable doesn't have a recipe (it's a primitive game-state object, not a craftable resource), then submarine_cable similarly may be a route-creation action rather than a producible resource. Adapt.

- [ ] **Step 6: Wire route-creation UI**

In whatever file lets the player create routes (`src/routes-ui.ts` is likely), extend the route-type picker to offer `'submarine_cable'` as a tier-3 unlock. Mirror how `'cable'` is offered today. If `routes-ui.ts` hardcodes `type: 'cargo'` for all UI-created routes (as the mass_driver task discovered for that type), this step degrades to "add the type to the enum and accept that UI creation is a separate follow-up" — same scope-discipline call as mass_driver.

- [ ] **Step 7: Run tests + build**

Run: `npm test` FOREGROUND. Expect ~1768 + new tests.
Run: `npm run build` FOREGROUND. Exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/routes.ts src/routes.test.ts src/building-defs.ts src/recipes.ts src/routes-ui.ts # or whatever you touched
git commit -m "feat(routes): submarine_cable RouteType — inter-island power transmission (Task 4)"
```

### What this task does NOT cover

- Tile-placed cable cells (no such thing in the codebase; not building it).
- Anchor-picker for ocean platforms (that's Task 5 — independent of submarine cable per the spec revision).
- Power infrastructure for ocean platforms (handled via anchor's existing power pool; no submarine cable required to power platforms).

---

### Task 5: Anchor picker modal

**Spec section:** §4

**Files:**
- Create: `src/anchor-picker.ts`
- Modify: `src/placement.ts` (transition to `awaiting-anchor` after tile commit for ocean buildings)
- Modify: `src/placement-ui.ts` (wire the picker into the placement flow)
- Test: `src/anchor-picker.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { candidateAnchors } from './anchor-picker.js';

describe('candidateAnchors', () => {
  it('returns populated islands in the cable component the platform will join', () => {
    const world = /* fixture with islands A (populated), B (populated), C (unpopulated)
                     all in the same §5.3 cable component as the prospective platform */;
    const candidates = candidateAnchors(world, /* placement cell */);
    expect(candidates.map(c => c.islandId)).toEqual(['A', 'B']);
  });

  it('returns single-island case as one-option list (still uses picker for consistency)', () => {
    const world = /* single populated island A in component */;
    const candidates = candidateAnchors(world, /* placement cell */);
    expect(candidates.length).toBe(1);
    expect(candidates[0].islandId).toBe('A');
  });

  it('returns empty list when no populated island is reachable', () => {
    const world = /* fixture: cable component contains only unpopulated islands or no cable yet */;
    const candidates = candidateAnchors(world, /* placement cell */);
    expect(candidates).toEqual([]);
  });

  it('orders candidates by distance to the placement cell (nearest first)', () => {
    const world = /* islands A at dist 5, B at dist 3, both populated, same component */;
    const candidates = candidateAnchors(world, /* placement cell */);
    expect(candidates[0].islandId).toBe('B');
    expect(candidates[1].islandId).toBe('A');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/anchor-picker.test.ts`
Expected: FAIL — `candidateAnchors` not exported.

- [ ] **Step 3: Implement `candidateAnchors` in `src/anchor-picker.ts`**

```typescript
import type { World } from './world.js';

export interface AnchorCandidate {
  readonly islandId: string;
  readonly islandName: string;
  readonly distanceCells: number;
  readonly inventoryHeadroom: number; // headroom on the main output resource
}

/** Maximum distance (in cells) from the placement cell to consider an
 *  island as an anchor candidate. Appendix-A placeholder; tuning the
 *  player loop. */
export const ANCHOR_MAX_RANGE_CELLS = 50;

export function candidateAnchors(
  world: World,
  placementCellX: number,
  placementCellY: number,
): AnchorCandidate[] {
  return world.islands
    .filter(isl => isl.populated)
    .map(isl => ({
      islandId: isl.id,
      islandName: isl.name,
      distanceCells: Math.hypot(isl.cx - placementCellX * CELL_SIZE_TILES, isl.cy - placementCellY * CELL_SIZE_TILES) / CELL_SIZE_TILES,
      inventoryHeadroom: 0, // implementer: query the island's main-output cap headroom
    }))
    .filter(c => c.distanceCells <= ANCHOR_MAX_RANGE_CELLS)
    .sort((a, b) => a.distanceCells - b.distanceCells);
}
```

**REVISED**: per the post-brainstorm spec correction, ocean platforms do NOT trace a cable component back to land. The cable model is now route-based (Task 4 revision); anchor selection is simply "pick any populated island within range." No `cablePoolComponentAt` helper needed.

- [ ] **Step 4: Implement the picker modal**

Mirror the `src/cargo-label-picker.ts` shell (commits `a96210a` + `144fd15`):

```typescript
import { mountModal } from './modal-shell.js'; // implementer: use whatever shared shell cargo-label-picker established

export function mountAnchorPicker(parentEl: HTMLElement): {
  pick(candidates: AnchorCandidate[]): Promise<string | null>;
} {
  // Render a modal listing candidates with island name, distance, inventory headroom.
  // Default-highlight the nearest (candidates[0]).
  // Enter → resolve with selected islandId.
  // Escape / cancel button → resolve null.
}
```

- [ ] **Step 5: Wire into the placement state machine in `src/placement.ts` + `src/placement-ui.ts`**

After the player commits a placement tile for a building with `oceanPlacement: true`:

```typescript
const candidates = candidateAnchors(world, cellX, cellY);
if (candidates.length === 0) {
  // No populated island within ANCHOR_MAX_RANGE_CELLS — show error toast, abort placement.
  return { ok: false, reason: 'no-anchor-in-range' };
}
const picked = await anchorPicker.pick(candidates);
if (picked === null) return { ok: false, reason: 'cancelled' };
placeBuilding(world, def, cellX, cellY, { anchorIslandId: picked });
```

- [ ] **Step 6: Run tests + build**

Run: `npm test` (foreground), expect prior + 4 new = 1762.
Run: `npm run build` (foreground), exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/anchor-picker.ts src/anchor-picker.test.ts src/placement.ts src/placement-ui.ts src/routes.ts
git commit -m "feat(placement): anchor picker for ocean buildings (Task 5)"
```

---

### Task 6: Sonar Buoy

**Spec section:** §5

**Files:**
- Create: `src/sonar-buoy.ts`
- Modify: `src/building-defs.ts` (add `sonar_buoy` def)
- Modify: `src/recipes.ts` (add Sonar Buoy recipe — `20 iron_ingot + 10 copper_wire + 5 microchip` placeholder)
- Modify: `src/discovery.ts` (export `depthRevealedCells` helpers)
- Modify: `src/main.ts` (call Sonar Buoy tick per world tick)
- Test: `src/sonar-buoy.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { tickSonarBuoys, SONAR_BUOY_RADIUS_TILES } from './sonar-buoy.js';

describe('Sonar Buoy', () => {
  it('powered buoy writes both revealedCells and depthRevealedCells within radius', () => {
    const world = /* fixture with a buoy at cell (5, 5), powered */;
    const state = /* worldState with empty discovery sets */;
    tickSonarBuoys(world, state);
    const radius = SONAR_BUOY_RADIUS_TILES; // expect 4 cells
    let revealed = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx*dx + dy*dy <= radius*radius) {
          const key = `${5 + dx},${5 + dy}`;
          expect(state.revealedCells.has(key)).toBe(true);
          expect(state.depthRevealedCells.has(key)).toBe(true);
          revealed++;
        }
      }
    }
    expect(revealed).toBeGreaterThan(0);
  });

  it('unpowered buoy does not reveal', () => {
    const world = /* fixture with a buoy at (5, 5), no power */;
    const state = /* empty discovery sets */;
    tickSonarBuoys(world, state);
    expect(state.depthRevealedCells.size).toBe(0);
  });

  it('multiple buoys union their coverage (no double-count issues)', () => {
    const world = /* two buoys at (5, 5) and (10, 10), both powered */;
    const state = /* empty */;
    tickSonarBuoys(world, state);
    // Union should cover both radii without duplication (Set semantics).
    expect(state.depthRevealedCells.has('5,5')).toBe(true);
    expect(state.depthRevealedCells.has('10,10')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/sonar-buoy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/sonar-buoy.ts`**

```typescript
import type { World, WorldState, PlacedBuilding } from './world.js';

export const SONAR_BUOY_RADIUS_TILES = 4;
export const SONAR_BUOY_DEF_ID = 'sonar_buoy';

export function tickSonarBuoys(world: World, state: WorldState): void {
  for (const island of world.islands) {
    for (const b of island.buildings) {
      if (b.defId !== SONAR_BUOY_DEF_ID) continue;
      if (!isPowered(world, state, b)) continue; // use existing power-check helper
      const centerCellX = Math.floor((b.tileX + island.cx) / CELL_SIZE_TILES);
      const centerCellY = Math.floor((b.tileY + island.cy) / CELL_SIZE_TILES);
      revealRadius(state, centerCellX, centerCellY, SONAR_BUOY_RADIUS_TILES);
    }
  }
}

function revealRadius(state: WorldState, cx: number, cy: number, r: number): void {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx*dx + dy*dy > r*r) continue;
      const key = `${cx + dx},${cy + dy}`;
      state.revealedCells.add(key);
      state.depthRevealedCells.add(key);
    }
  }
}
```

- [ ] **Step 4: Add `sonar_buoy` to `src/building-defs.ts`**

```typescript
sonar_buoy: {
  id: 'sonar_buoy',
  displayName: 'Sonar Buoy',
  tier: 2,
  footprint: SHAPES.single,
  category: 'infrastructure',
  placementCost: { iron_ingot: 20, copper_wire: 10, microchip: 5 },
  power: { consumes: 50 },
  oceanPlacement: true,
  terrainReqs: ['shallows', 'deep', 'trench', 'hydrothermal_vent', 'nodule_field'], // any ocean
  glyph: '◌',
} as const,
```

- [ ] **Step 5: Add `depthRevealedCells` helpers to `src/discovery.ts`**

Export a `revealOceanCells(state, cellKeys, { surface, depth })` helper that writes to one or both sets per the flags. The Sonar Buoy tick can use it; Scanner Sat extension (Task 7) will too.

- [ ] **Step 6: Wire into per-tick loop in `src/main.ts`**

In the main ticker, after the existing drone-discovery tick:

```typescript
import { tickSonarBuoys } from './sonar-buoy.js';
// ...
tickSonarBuoys(world, worldState);
```

- [ ] **Step 7: Run tests + build**

Run: `npm test` (foreground), expect prior + 3 new = 1765.
Run: `npm run build` (foreground), exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/sonar-buoy.ts src/sonar-buoy.test.ts src/building-defs.ts src/recipes.ts src/discovery.ts src/main.ts
git commit -m "feat(ocean): Sonar Buoy — T2 active depth-discovery (Task 6)"
```

---

### Task 7: Scanner Sat extension to ocean cells

**Spec section:** §5

**Files:**
- Modify: `src/orbital.ts` (extend Scanner Sat tick to write `depthRevealedCells` for ocean cells in coverage)
- Test: `src/orbital.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Add to existing `§14.5 scanner dwell-ramp discovery` describe block:

```typescript
it('Scanner Sat coverage flips depthRevealedCells for ocean cells in coverage', () => {
  const world = /* fixture: Scanner Sat at known cell, with ocean cells in coverage */;
  const state = /* empty discovery sets */;
  tickScannerSats(world, state, dt);
  // Walk every ocean cell within the sat's coverage disk and assert both sets contain it.
  for (const cellKey of cellsCoveredBySat(/* sat, world */)) {
    expect(state.revealedCells.has(cellKey)).toBe(true);
    expect(state.depthRevealedCells.has(cellKey)).toBe(true);
  }
});

it('in-transit Scanner Sat (locked=false) does not reveal ocean cells', () => {
  const world = /* fixture: Scanner Sat with locked=false */;
  const state = /* empty */;
  tickScannerSats(world, state, dt);
  expect(state.depthRevealedCells.size).toBe(0);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/orbital.test.ts -t "ocean cells"`
Expected: FAIL — depth not written.

- [ ] **Step 3: Implement the extension in `src/orbital.ts`**

Find the Scanner Sat tick (probably `tickScannerSats` or the `tickSats` dispatcher). In the cell-coverage loop that flips island-discovery flags, add a parallel branch for ocean cells:

```typescript
for (const cellKey of cellsCoveredBySat(sat, world)) {
  // existing: flip island discovery if cell is an island cell
  // NEW:
  if (world.oceanCells.has(cellKey)) {
    state.revealedCells.add(cellKey);
    state.depthRevealedCells.add(cellKey);
  }
}
```

- [ ] **Step 4: Run tests + build**

Run: `npm test` (foreground), expect prior + 2 new = 1767.
Run: `npm run build` (foreground), exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/orbital.ts src/orbital.test.ts
git commit -m "feat(orbital): Scanner Sat reveals ocean cells in coverage (Task 7)"
```

---

### Task 8: Building catalog Part A — extractors (5 defs + recipes)

**Spec section:** §3

**Files:**
- Modify: `src/building-defs.ts` (add 5 extractor defs)
- Modify: `src/recipes.ts` (add ~10 extraction recipes + the raw resources)
- Modify: `src/storage-categories.ts`, `src/inventory-ui.ts` (categorize new resources)
- Modify: `src/placement.ts` (extend footprint validation to check `terrainReqs`)
- Test: `src/placement.test.ts` (extend with ocean-building footprint-match tests)

- [ ] **Step 1: Write the failing tests in `src/placement.test.ts`**

```typescript
describe('§3 ocean building footprint validation', () => {
  it('rejects Vent Tap placement when footprint extends beyond vent cluster', () => {
    const world = /* fixture: 2x2 vent cluster at (5,5)-(6,6); placement attempt at (5,5) with a 2x2 footprint that includes a deep cell */;
    const result = validatePlacement(world, 'vent_tap', 5, 5);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('terrain-mismatch');
  });

  it('accepts Vent Tap on a contiguous 2x2 vent cluster', () => {
    const world = /* exact 2x2 vent cluster at (5,5)-(6,6) */;
    const result = validatePlacement(world, 'vent_tap', 5, 5);
    expect(result.ok).toBe(true);
  });

  it('accepts Open-Water Extractor on shallows OR deep mixed footprint', () => {
    const world = /* 2x2 footprint with 2 shallows + 2 deep */;
    const result = validatePlacement(world, 'open_water_extractor', /* anchor */);
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/placement.test.ts -t "ocean building footprint"`
Expected: FAIL — `validatePlacement` doesn't check ocean terrain yet.

- [ ] **Step 3: Add the 5 extractor building defs to `src/building-defs.ts`**

```typescript
seawater_intake_rig: {
  id: 'seawater_intake_rig',
  displayName: 'Seawater Intake Rig',
  tier: 2,
  footprint: SHAPES.square2,
  category: 'extraction',
  placementCost: { iron_ingot: 50, copper_wire: 20, microchip: 10 },
  power: { consumes: 200 },
  oceanPlacement: true,
  terrainReqs: ['shallows'],
  glyph: '~',
} as const,

open_water_extractor: {
  id: 'open_water_extractor',
  displayName: 'Open-Water Extractor',
  tier: 3,
  footprint: SHAPES.square2,
  category: 'extraction',
  placementCost: { carbon_steel: 80, copper_wire: 30, microchip: 15 },
  power: { consumes: 400 },
  oceanPlacement: true,
  terrainReqs: ['shallows', 'deep'],
  glyph: '≈',
} as const,

nodule_harvester: {
  id: 'nodule_harvester',
  displayName: 'Nodule Harvester',
  tier: 3,
  footprint: SHAPES.square2,
  category: 'extraction',
  placementCost: { carbon_steel: 100, gear: 25, microchip: 20 },
  power: { consumes: 600 },
  oceanPlacement: true,
  terrainReqs: ['nodule_field'],
  glyph: '⊙',
} as const,

trench_drill: {
  id: 'trench_drill',
  displayName: 'Trench Drill',
  tier: 4,
  footprint: SHAPES.square2,
  category: 'extraction',
  placementCost: { exotic_alloy: 5, carbon_steel: 150, ai_core: 1 },
  power: { consumes: 1000 },
  oceanPlacement: true,
  terrainReqs: ['trench'],
  glyph: '▼',
} as const,

vent_tap: {
  id: 'vent_tap',
  displayName: 'Vent Tap',
  tier: 4,
  footprint: SHAPES.square2,
  category: 'extraction',
  placementCost: { exotic_alloy: 4, carbon_steel: 100, optical_glass: 10 },
  power: { consumes: 800 },
  oceanPlacement: true,
  terrainReqs: ['hydrothermal_vent'],
  glyph: '✦',
} as const,
```

- [ ] **Step 4: Add the extraction recipes + raws in `src/recipes.ts`**

Add new `ResourceId` entries: `dilute_brine`, `concentrated_brine`, `he3_dilute`, `mn_nodule`, `re_nodule`, `co_nodule`, `methane_hydrate`, `heavy_isotope_slurry`, `vent_sulfide`, `vent_exotic`.

Add ~10 recipes:

```typescript
seawater_intake_dilute_brine: {
  id: 'seawater_intake_dilute_brine',
  building: 'seawater_intake_rig',
  inputs: {},
  outputs: { dilute_brine: 1 },
  cycleSec: 60,
  category: 'extraction',
} as const,
seawater_intake_deuterium: {
  id: 'seawater_intake_deuterium',
  building: 'seawater_intake_rig',
  inputs: {},
  outputs: { he3_dilute: 1 }, // very slow, trace amounts
  cycleSec: 300,
  category: 'extraction',
} as const,
// Open-Water Extractor: 2 recipes for concentrated brine + He-3 dilute
// Nodule Harvester: 3 recipes for Mn / Re / Co nodules
// Trench Drill: 3 recipes for methane_hydrate / heavy_isotope_slurry / vent_sulfide
// Vent Tap: 2 recipes for vent_sulfide / vent_exotic
```

Mirror existing land-extractor recipes' cycle-time + ratio patterns. Numbers are Appendix-A placeholders.

- [ ] **Step 5: Add terrain validation to `src/placement.ts`**

In `validatePlacement`:

```typescript
import { footprintMatches } from './ocean-cell.js';

const def = BUILDING_DEFS[defId];
if (def.oceanPlacement && def.terrainReqs) {
  const { width: fw, height: fh } = footprintDims(def.footprint);
  if (!footprintMatches(world, anchorX, anchorY, fw, fh, def.terrainReqs)) {
    return { ok: false, reason: 'terrain-mismatch' };
  }
}
```

- [ ] **Step 6: Categorize new resources in `src/storage-categories.ts` + `src/inventory-ui.ts`**

Add entries (most are 'components' or 'rare' category):

```typescript
// storage-categories.ts
dilute_brine: 'common',
concentrated_brine: 'common',
he3_dilute: 'rare',
mn_nodule: 'common',
re_nodule: 'rare',
co_nodule: 'rare',
methane_hydrate: 'common',
heavy_isotope_slurry: 'rare',
vent_sulfide: 'common',
vent_exotic: 'rare',
```

- [ ] **Step 7: Run tests + build**

Run: `npm test` (foreground), expect prior + 3 new = 1770.
Run: `npm run build` (foreground), exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/building-defs.ts src/recipes.ts src/storage-categories.ts src/inventory-ui.ts src/placement.ts src/placement.test.ts
git commit -m "feat(ocean): 5 extractor buildings + raws + footprint validation (Task 8)"
```

---

### Task 9: Building catalog Part B — processors + Geothermal Generator (6 defs)

**Spec section:** §3

**Files:**
- Modify: `src/building-defs.ts` (add 6 defs: Brine Distillation Rig, Nodule Concentrator, Vent Mineral Refinery, Heavy Water Distiller, Geothermal Vent Generator)
- Modify: `src/recipes.ts` (add ~10 processing recipes + intermediates + 3 final products)
- Modify: `src/storage-categories.ts`, `src/inventory-ui.ts` (categorize new resources)
- Test: existing `src/recipes.test.ts` (extend with spec-literal tests for each new recipe)

- [ ] **Step 1: Write the failing tests**

Add to `src/recipes.test.ts`:

```typescript
describe('§3 ocean processing recipes', () => {
  it('lithium_brine_refine matches §3 spec literal', () => {
    const r = RECIPES.lithium_brine_refine!;
    expect(r.inputs).toEqual({ dilute_brine: 5 });
    expect(r.outputs).toEqual({ lithium_brine: 1 });
    expect(r.cycleSec).toBe(120);
  });
  // Similar for: salt_refine, bromine_refine, rare_earth_refine, cobalt_refine,
  //              exotic_alloy_seed_recipe, tritium_seed_recipe, heavy_water_recipe
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/recipes.test.ts -t "ocean processing"`
Expected: FAIL — recipes not defined.

- [ ] **Step 3: Add the 6 processor defs**

```typescript
brine_distillation_rig: {
  id: 'brine_distillation_rig',
  displayName: 'Brine Distillation Rig',
  tier: 3,
  footprint: SHAPES.square3,
  category: 'processing',
  placementCost: { carbon_steel: 120, glass: 30, microchip: 20 },
  power: { consumes: 800 },
  oceanPlacement: true,
  terrainReqs: ['shallows', 'deep'],
  glyph: '⌒',
} as const,

nodule_concentrator: {
  id: 'nodule_concentrator',
  displayName: 'Nodule Concentrator',
  tier: 4,
  footprint: SHAPES.square3,
  category: 'processing',
  placementCost: { exotic_alloy: 5, carbon_steel: 150, sulfuric_acid: 10 },
  power: { consumes: 1200 },
  oceanPlacement: true,
  terrainReqs: ['shallows', 'deep'],
  glyph: '◇',
} as const,

vent_mineral_refinery: {
  id: 'vent_mineral_refinery',
  displayName: 'Vent Mineral Refinery',
  tier: 5,
  footprint: SHAPES.square3,
  category: 'processing',
  placementCost: { exotic_alloy: 10, ai_core: 2, casimir_energy: 1 },
  power: { consumes: 1500 },
  oceanPlacement: true,
  terrainReqs: ['shallows', 'deep'],
  glyph: '◈',
} as const,

heavy_water_distiller: {
  id: 'heavy_water_distiller',
  displayName: 'Heavy Water Distiller',
  tier: 5,
  footprint: SHAPES.square3,
  category: 'processing',
  placementCost: { exotic_alloy: 8, ai_core: 1, optical_glass: 20 },
  power: { consumes: 1200 },
  oceanPlacement: true,
  terrainReqs: ['shallows', 'deep'],
  glyph: '≋',
} as const,

geothermal_vent_generator: {
  id: 'geothermal_vent_generator',
  displayName: 'Geothermal Vent Generator',
  tier: 6,
  footprint: SHAPES.square2,
  category: 'power',
  placementCost: { exotic_alloy: 6, ai_core: 1, plasma_containment_vessel: 1 },
  power: { produces: 2000 },
  oceanPlacement: true,
  terrainReqs: ['hydrothermal_vent'],
  glyph: '★',
} as const,
```

- [ ] **Step 4: Add the ~10 processing recipes**

```typescript
lithium_brine_refine: {
  building: 'brine_distillation_rig',
  inputs: { dilute_brine: 5 },
  outputs: { lithium_brine: 1 },
  cycleSec: 120,
  category: 'processing',
} as const,
salt_refine: { /* dilute_brine → salt */ },
bromine_refine: { /* concentrated_brine → bromine */ },
rare_earth_refine: { /* re_nodule + sulfuric_acid → rare_earth_concentrate */ },
cobalt_refine: { /* co_nodule + sulfuric_acid → refined_cobalt */ },
exotic_alloy_seed_recipe: { /* vent_exotic + casimir_energy → exotic_alloy_seed */ },
tritium_seed_recipe: { /* heavy_isotope_slurry → tritium_seed */ },
heavy_water_recipe: { /* concentrated_brine + microchip → heavy_water */ },
```

Numbers are Appendix-A placeholders; mirror existing land-processor recipe shapes.

- [ ] **Step 5: Add the intermediate + final ResourceIds**

```typescript
// In ResourceId enum/union:
lithium_brine, salt, bromine, rare_earth_concentrate, refined_cobalt,
exotic_alloy_seed, tritium_seed, heavy_water,
```

If `salt`, `bromine`, `lithium_brine` already exist (they might in the existing chemistry chain), reuse — don't duplicate.

- [ ] **Step 6: Categorize new resources**

Add to `storage-categories.ts` + `inventory-ui.ts` parallel.

- [ ] **Step 7: Run tests + build**

Run: `npm test` (foreground), expect prior + ~8 new = 1778.
Run: `npm run build` (foreground), exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/building-defs.ts src/recipes.ts src/recipes.test.ts src/storage-categories.ts src/inventory-ui.ts
git commit -m "feat(ocean): 5 processors + Geothermal Generator + ~8 recipes (Task 9)"
```

---

### Task 10: Anchor crediting + paused-reason economy hookup

**Spec section:** §4

**Files:**
- Modify: `src/economy.ts` (extend `paused` reason enum; ensure ocean-building output deposits to anchor)
- Modify: `src/inspector-ui.ts` (display chips for new paused reasons)
- Test: `src/economy.test.ts` (extend)

- [ ] **Step 1: Write the failing tests in `src/economy.test.ts`**

```typescript
describe('§4 ocean anchor crediting', () => {
  it('ocean platform output deposits to anchor island inventory, not geographic island', () => {
    const world = /* fixture: anchor island A (populated), ocean platform with anchorIslandId=A */;
    const state = /* world state */;
    advanceWorld(world, state, /* dt */);
    expect(state.byIsland.get('A')!.inventory.dilute_brine).toBeGreaterThan(0);
  });

  it('platform halts with paused="anchor-depopulated" when anchor loses populated flag', () => {
    const world = /* fixture: platform anchored to A, then A unpopulated */;
    const state = /* setup */;
    advanceWorld(world, state, /* dt */);
    const platform = /* lookup ocean platform */;
    expect(platform.paused).toBe('anchor-depopulated');
  });

  it('platform halts with paused="anchor-disconnected" when cable to anchor breaks', () => {
    // similar
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/economy.test.ts -t "ocean anchor"`
Expected: FAIL — anchor crediting not wired.

- [ ] **Step 3: Extend the `paused` reason enum + state machine in `src/economy.ts`**

Find the `PausedReason` type:

```typescript
export type PausedReason =
  // ... existing reasons ...
  | 'anchor-depopulated'
  | 'anchor-disconnected'
  | 'terrain-lost';
```

In the per-building tick (probably `advanceBuilding` or inline in `advanceIsland`), add the anchor check for ocean buildings:

```typescript
if (def.oceanPlacement && b.anchorIslandId) {
  const anchor = world.islands.find(i => i.id === b.anchorIslandId);
  if (!anchor || !anchor.populated) {
    b.paused = 'anchor-depopulated';
    continue;
  }
  if (!cablePathExists(world, b, anchor)) {
    b.paused = 'anchor-disconnected';
    continue;
  }
  // Production proceeds normally, but output deposits go to anchor's inventory:
  depositOutputs(state.byIsland.get(anchor.id)!, outputs);
}
```

`cablePathExists(world, building, anchor)` is a new helper using the §5.3 unified-pool component graph: checks whether the building's cell and the anchor's centre belong to the same connected component.

- [ ] **Step 4: Add display chips in `src/inspector-ui.ts`**

When inspecting an ocean platform, surface the paused reason as a chip in the header:

```typescript
const REASON_LABELS: Record<PausedReason, string> = {
  // ... existing ...
  'anchor-depopulated': 'Anchor island unpopulated',
  'anchor-disconnected': 'No cable path to anchor',
  'terrain-lost': 'Terrain lost',
};
```

- [ ] **Step 5: Run tests + build**

Run: `npm test` (foreground), expect prior + 3 new = 1781.
Run: `npm run build` (foreground), exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/economy.ts src/economy.test.ts src/inspector-ui.ts
git commit -m "feat(economy): ocean anchor crediting + paused reasons (Task 10)"
```

---

### Task 11: Feature glyph render + submarine cable visual + sonar ring

**Spec section:** §6

**Files:**
- Modify: `src/ocean.ts` (add feature glyph render pass)
- Modify: `src/satellite-overlay.ts` (sonar buoy range ring on inspector hover; submarine cable tint)
- Modify: `src/routes.ts` or wherever cable renders (submarine cable distinct tint)
- Test: `src/ocean.test.ts` (extend; minimal — test the pure helper, skip Sprite assertions)

- [ ] **Step 1: Write the failing test for the pure helper**

```typescript
import { describe, it, expect } from 'vitest';
import { shouldRenderFeatureGlyph } from './ocean.js';

describe('shouldRenderFeatureGlyph', () => {
  it('returns true when both revealed and depthRevealed AND terrain is rare', () => {
    const oceanCells = new Map([['5,5', { terrain: 'hydrothermal_vent' as const }]]);
    const revealed = new Set(['5,5']);
    const depthRevealed = new Set(['5,5']);
    expect(shouldRenderFeatureGlyph('5,5', revealed, depthRevealed, oceanCells)).toBe(true);
  });

  it('returns false when only surface revealed (depth not yet)', () => {
    const oceanCells = new Map([['5,5', { terrain: 'hydrothermal_vent' as const }]]);
    expect(shouldRenderFeatureGlyph('5,5', new Set(['5,5']), new Set(), oceanCells)).toBe(false);
  });

  it('returns false for bulk terrain (shallows, deep) even when both revealed', () => {
    const oceanCells = new Map([['5,5', { terrain: 'shallows' as const }]]);
    expect(shouldRenderFeatureGlyph('5,5', new Set(['5,5']), new Set(['5,5']), oceanCells)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, fail, implement, run, pass**

The helper:

```typescript
const RARE_TERRAINS: ReadonlySet<OceanTerrain> = new Set(['trench', 'hydrothermal_vent', 'nodule_field']);

export function shouldRenderFeatureGlyph(
  cellKey: string,
  revealedCells: ReadonlySet<string>,
  depthRevealedCells: ReadonlySet<string>,
  oceanCells: ReadonlyMap<string, OceanCellSpec>,
): boolean {
  if (!revealedCells.has(cellKey)) return false;
  if (!depthRevealedCells.has(cellKey)) return false;
  const terrain = oceanCells.get(cellKey)?.terrain;
  return terrain !== undefined && RARE_TERRAINS.has(terrain);
}
```

- [ ] **Step 3: Render integration in `src/ocean.ts`**

Add a feature-glyph render pass between the fog sprites and the weather overlay. For each cell where `shouldRenderFeatureGlyph(...)` is true, draw the appropriate glyph (∿ for vent, ⋮ for nodule, ▭ for trench) at the cluster's anchor cell (top-left of the cluster). Use fixed pixel size (scale-independent).

Use `clusterAnchorOf(world, cellKey)` from `ocean-cell.ts` (add this helper) to determine the anchor cell per cluster, so each cluster renders one glyph.

- [ ] **Step 4: Submarine cable tint**

In whatever file renders cables (probably `src/routes.ts` or `src/buildings.ts`), distinguish submarine cable cells by a slightly darker tint (e.g. `0x4a6680` vs land cable's `0x9caab8`):

```typescript
const tint = building.defId === 'submarine_cable' ? 0x4a6680 : 0x9caab8;
sprite.tint = tint;
```

- [ ] **Step 5: Sonar Buoy range ring**

In `src/satellite-overlay.ts` (or `src/inspector-ui.ts` if rings live there), when the inspector is open on a Sonar Buoy, render a faint cyan ring at radius `SONAR_BUOY_RADIUS_TILES * CELL_SIZE_TILES * TILE_PX` around its center. Mirror the Antenna/Lighthouse ring pattern.

- [ ] **Step 6: Run tests + build**

Run: `npm test` (foreground), expect prior + 3 new = 1784.
Run: `npm run build` (foreground), exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/ocean.ts src/ocean.test.ts src/satellite-overlay.ts src/routes.ts src/inspector-ui.ts
git commit -m "feat(ocean-render): feature glyphs + submarine cable tint + sonar ring (Task 11)"
```

---

### Task 12: Hover tooltip

**Spec section:** §6

**Files:**
- Create: `src/hover-tooltip.ts`
- Modify: `src/main.ts` (wire hover into input pipeline)
- Test: `src/hover-tooltip.test.ts` (new — pure helper only; DOM untested)

- [ ] **Step 1: Write the failing tests for the pure helper**

```typescript
import { describe, it, expect } from 'vitest';
import { cellInfoForHover } from './hover-tooltip.js';

describe('cellInfoForHover', () => {
  it('returns terrain + cluster info for revealed + depth-revealed rare ocean cells', () => {
    const world = /* fixture: 3x2 hydrothermal vent cluster anchored at (5, 5) */;
    const state = /* surface + depth both revealed for the cluster */;
    const info = cellInfoForHover(world, state, '5,5');
    expect(info.kind).toBe('ocean-rare');
    expect(info.terrain).toBe('hydrothermal_vent');
    expect(info.clusterSize).toEqual({ width: 3, height: 2 });
    expect(info.occupancy).toEqual({ used: 0, capacity: 1 });
  });

  it('returns "Unscouted depths" when surface revealed but depth not', () => {
    const world = /* fixture: vent cluster at (5, 5) */;
    const state = /* surface revealed, depth NOT */;
    const info = cellInfoForHover(world, state, '5,5');
    expect(info.kind).toBe('ocean-undepthed');
    expect(info.text).toBe('Unscouted depths');
  });

  it('returns "Open ocean" for entirely unrevealed cells', () => {
    const world = /* fixture */;
    const state = /* nothing revealed */;
    const info = cellInfoForHover(world, state, '5,5');
    expect(info.kind).toBe('ocean-unrevealed');
    expect(info.text).toBe('Open ocean');
  });

  it('surfaces weather state for any cell (land OR ocean)', () => {
    const world = /* fixture with active weather cycle */;
    const state = /* setup */;
    const info = cellInfoForHover(world, state, '5,5');
    expect(info.weather).toBeDefined();
    expect(info.weather!.state).toMatch(/Clear|Storm|High Wind|Tsunami/);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/hover-tooltip.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `cellInfoForHover`**

```typescript
import type { World, WorldState } from './world.js';
import { terrainAt, clusterAnchorOf } from './ocean-cell.js';
import { weatherAt } from './weather.js';

export type HoverInfo =
  | { kind: 'ocean-rare'; terrain: 'trench' | 'hydrothermal_vent' | 'nodule_field'; clusterSize: { width: number; height: number }; occupancy: { used: number; capacity: number }; weather: WeatherInfo | null }
  | { kind: 'ocean-undepthed'; text: string; weather: WeatherInfo | null }
  | { kind: 'ocean-revealed'; text: string; weather: WeatherInfo | null }
  | { kind: 'ocean-unrevealed'; text: string; weather: WeatherInfo | null }
  | { kind: 'land'; text: string; building: string | null; weather: WeatherInfo | null };

export interface WeatherInfo {
  state: string;
  forecastText: string | null;
}

export function cellInfoForHover(world: World, state: WorldState, cellKey: string): HoverInfo {
  // Implementer: parse cellKey, route by terrain + revealed state.
  // For rare ocean: walk cluster to find anchor + size; query placed buildings on the cluster.
  // For land: look up tile type + building.
  // Always include weather via weatherAt(cellX, cellY, nowMs).
}
```

- [ ] **Step 4: Implement DOM rendering**

```typescript
export function mountHoverTooltip(parentEl: HTMLElement, world: World, state: WorldState): {
  setHoverCell(cellKey: string | null): void;
  destroy(): void;
} {
  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.pointerEvents = 'none';
  el.style.background = 'rgba(20, 30, 40, 0.95)';
  el.style.color = '#cde';
  el.style.padding = '6px 10px';
  el.style.borderRadius = '4px';
  el.style.fontSize = '12px';
  el.style.fontFamily = 'monospace';
  el.style.display = 'none';
  el.style.zIndex = '1000';
  parentEl.appendChild(el);

  let currentCellKey: string | null = null;

  return {
    setHoverCell(cellKey) {
      currentCellKey = cellKey;
      if (cellKey === null) { el.style.display = 'none'; return; }
      const info = cellInfoForHover(world, state, cellKey);
      el.innerHTML = renderInfoToHtml(info);
      el.style.display = 'block';
      // Position near cursor — implementer wires from mousemove handler
    },
    destroy() { parentEl.removeChild(el); },
  };
}

function renderInfoToHtml(info: HoverInfo): string {
  // Format per spec §6 examples.
}
```

- [ ] **Step 5: Wire into `src/main.ts`**

```typescript
import { mountHoverTooltip } from './hover-tooltip.js';

const tooltip = mountHoverTooltip(document.body, world, worldState);

app.stage.eventMode = 'static';
app.stage.on('pointermove', (e) => {
  const worldPx = screenToWorldPx(e.global.x, e.global.y, cam);
  const cellX = Math.floor(worldPx.x / TILE_PX / CELL_SIZE_TILES);
  const cellY = Math.floor(worldPx.y / TILE_PX / CELL_SIZE_TILES);
  tooltip.setHoverCell(`${cellX},${cellY}`);
});

app.stage.on('pointerleave', () => tooltip.setHoverCell(null));
```

Throttle to ~30Hz if needed (`requestAnimationFrame` debounce).

- [ ] **Step 6: Run tests + build**

Run: `npm test` (foreground), expect prior + 4 new = 1788.
Run: `npm run build` (foreground), exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/hover-tooltip.ts src/hover-tooltip.test.ts src/main.ts
git commit -m "feat(ocean-ui): hover tooltip — cell info + weather readout (Task 12)"
```

---

## Final task (post-Task 12): SPEC.md update + TODO entry cleanup

**Files:**
- Modify: `SPEC.md` (add new §3.x or §16 ocean-layer subsection)

- [ ] **Step 1: Add SPEC.md subsection summarizing the shipped layer**

Cross-reference §2.6 weather, §5.3 power, §14.5 sat coverage. Match existing SPEC.md prose density. Don't restate the design doc; summarize.

- [ ] **Step 2: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): document the shipped ocean layer (Task 12 cleanup)"
```

---

## Self-review checklist

(Run by the lead after this plan is written; fix issues inline.)

- **Spec coverage:**
  - §1 Overview — covered by the plan as a whole (no implementation needed; descriptive only).
  - §2 Terrain + world-gen — Tasks 1, 2, 3.
  - §3 Catalog — Tasks 8, 9 (recipes + buildings); footprint validation in Task 8.
  - §4 Cable + anchor — Tasks 4, 5, 10.
  - §5 Discovery — Tasks 6, 7.
  - §6 Render + UI — Tasks 11, 12.
  - §7 Testing — covered inline at each task (TDD discipline reminder at the top).

- **Placeholder scan:** Recipe ratios + cycle times are explicitly Appendix-A placeholders per the spec; not a TODO. Specific test fixtures use comments like "/* fixture with X */" — those are intentional outlines that the implementer fills in based on the existing test patterns in each file. NOT pure-placeholder; the implementer has enough context (file path, test description, prior similar tests in the file) to write the fixture.

- **Type consistency:**
  - `OceanCellSpec`, `OceanTerrain`, `OceanWorld` interface used consistently across tasks.
  - `revealedCells`, `depthRevealedCells` typed as `Set<string>` everywhere.
  - `anchorIslandId` field name used in Tasks 4, 5, 10.
  - `SONAR_BUOY_RADIUS_TILES` exported from `sonar-buoy.ts`, imported elsewhere.

- **Cross-task dependencies:**
  - Task 1 (data primitives) → Tasks 2, 3, 4, 8, 9, 11, 12 depend on `OceanCellSpec` + world fields.
  - Task 2 (world-gen) → Task 3 (migration re-derives from generator).
  - Task 5 (anchor picker) → Task 10 (anchor crediting uses `anchorIslandId`).
  - Task 6 (Sonar Buoy) + Task 7 (Scanner Sat) both write to `depthRevealedCells` from Task 1.
  - All discovery + render tasks read `oceanCells` from Task 1.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-ocean-layer.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, run two-stage review (spec compliance + code quality) between tasks, fast iteration. This matches the pattern we've used all session.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
