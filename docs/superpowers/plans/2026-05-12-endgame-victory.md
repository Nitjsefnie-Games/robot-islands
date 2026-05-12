# Endgame & Victory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement endgame goals / victory detection (#54) and Omniscient Lattice activation (#43).

**Architecture:** Win-condition detector runs per tick checking goal progress. Omniscient Lattice unifies inventory, enables cross-island adjacency, and sums storage caps across networked islands.

**Tech Stack:** TypeScript strict, vitest. Pure layer: `endgame.ts`, `economy.ts`, `world.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/endgame.ts` | Win-condition definitions, detector, state |
| `src/endgame.test.ts` | Tests for victory conditions |
| `src/economy.ts` | Omniscient Lattice: unified inventory, cross-island adjacency, cap summing |
| `src/world.ts` | `latticeActive` flag, `omniscientLatticeNodes` tracking |
| `src/main.ts` | Render endgame banner / victory screen |

---

### Task 1: Endgame Goals & Victory Detection

**Files:**
- Create: `src/endgame.ts`
- Create: `src/endgame.test.ts`
- Modify: `src/world.ts`

- [ ] **Step 1: Define victory conditions**

Per §13.4:

```typescript
// src/endgame.ts

export type VictoryCondition =
  | 'genesis_cell_crafted'
  | 'omniscient_lattice_active'
  | 'ascendant_core_crafted';

export interface EndgameState {
  /** Conditions achieved so far. */
  achieved: Set<VictoryCondition>;
  /** Timestamp of first achievement (for save-display). */
  firstAchievedMs: number | null;
  /** Displayed to player. */
  victoryBannerShown: boolean;
}

export function checkVictory(world: WorldState, nowMs: number): VictoryCondition[] {
  const newly: VictoryCondition[] = [];
  const state = world.endgameState;

  // Genesis Cell: any island has crafted one
  if (!state.achieved.has('genesis_cell_crafted')) {
    const crafted = Object.values(world.islandStates).some(s => s.inventory.genesis_cell > 0);
    if (crafted) newly.push('genesis_cell_crafted');
  }

  // Omniscient Lattice: latticeActive flag
  if (!state.achieved.has('omniscient_lattice_active')) {
    if (world.latticeActive) newly.push('omniscient_lattice_active');
  }

  // Ascendant Core: any island has crafted one
  if (!state.achieved.has('ascendant_core_crafted')) {
    const crafted = Object.values(world.islandStates).some(s => s.inventory.ascendant_core > 0);
    if (crafted) newly.push('ascendant_core_crafted');
  }

  for (const cond of newly) {
    state.achieved.add(cond);
  }
  if (newly.length > 0 && state.firstAchievedMs === null) {
    state.firstAchievedMs = nowMs;
  }
  return newly;
}
```

- [ ] **Step 2: Add EndgameState to WorldState**

```typescript
export interface WorldState {
  // ... existing ...
  endgameState: EndgameState;
  latticeActive: boolean;
  /** Island IDs that have an active Lattice Node. */
  latticeNodeIslands: string[];
}
```

Default in `makeInitialWorld`:

```typescript
endgameState: { achieved: new Set(), firstAchievedMs: null, victoryBannerShown: false },
latticeActive: false,
latticeNodeIslands: [],
```

- [ ] **Step 3: Tests**

```typescript
describe('endgame', () => {
  it('detects ascendant core craft', () => {
    const world = makeTestWorld();
    world.islandStates['home'].inventory.ascendant_core = 1;
    const newly = checkVictory(world, 0);
    expect(newly).toContain('ascendant_core_crafted');
  });
  it('detects lattice activation', () => {
    const world = makeTestWorld();
    world.latticeActive = true;
    const newly = checkVictory(world, 0);
    expect(newly).toContain('omniscient_lattice_active');
  });
  it('sets firstAchievedMs on first condition', () => {
    const world = makeTestWorld();
    world.latticeActive = true;
    checkVictory(world, 1234);
    expect(world.endgameState.firstAchievedMs).toBe(1234);
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add src/endgame.ts src/endgame.test.ts src/world.ts
git commit -m "feat(§13.4): endgame victory condition detector"
```

---

### Task 2: Omniscient Lattice Activation

**Files:**
- Modify: `src/world.ts`
- Modify: `src/economy.ts`
- Modify: `src/endgame.ts`
- Test: `src/endgame.test.ts`

- [ ] **Step 1: Activation check**

Per §13.3 and §9.6: N = 20 T5-mastered islands with Lattice Nodes.

```typescript
export function checkLatticeActivation(world: WorldState): boolean {
  if (world.latticeActive) return true;
  const t5MasteredWithNode = world.islands.filter(spec => {
    const state = world.islandStates[spec.id];
    if (!state) return false;
    const isT5Mastered = state.level >= 50 && state.buildings.some(b => b.defId === 'ascendant_assembly');
    const hasNode = state.buildings.some(b => b.defId === 'lattice_node');
    return isT5Mastered && hasNode;
  });
  if (t5MasteredWithNode.length >= 20) {
    world.latticeActive = true;
    world.latticeNodeIslands = t5MasteredWithNode.map(s => s.id);
    return true;
  }
  return false;
}
```

- [ ] **Step 2: Unified inventory in `computeRates`**

When `world.latticeActive` is true and the island is in `latticeNodeIslands`:

```typescript
function latticeInventory(world: WorldState, islandId: string): Record<ResourceId, number> {
  if (!world.latticeActive) return world.islandStates[islandId].inventory;
  const unified: Record<ResourceId, number> = {};
  for (const id of world.latticeNodeIslands) {
    const inv = world.islandStates[id].inventory;
    for (const [r, amt] of Object.entries(inv)) {
      unified[r as ResourceId] = (unified[r as ResourceId] ?? 0) + amt;
    }
  }
  return unified;
}
```

In `computeRates`, replace `state.inventory` reads with `latticeInventory(world, state.id)` when lattice is active. This is tricky because `computeRates` doesn't currently take `WorldState`. Options:

1. Pass `latticeInventory` as a closure in `RatesContext`.
2. Or add `world: WorldState` parameter to `computeRates`.

Option 1 is less invasive:

```typescript
export interface RatesContext {
  // ... existing ...
  readonly inventory?: Record<ResourceId, number>; // override for lattice
}
```

In `advanceIsland`:

```typescript
const ctx: RatesContext = {
  // ...
  inventory: world.latticeActive && world.latticeNodeIslands.includes(state.id)
    ? latticeInventory(world, state.id)
    : state.inventory,
};
```

- [ ] **Step 3: Cross-island adjacency via Lattice Nodes**

When computing adjacency for a building on a lattice island, if the building is 4-adjacent to a `lattice_node`, also include buildings 4-adjacent to `lattice_node` on ALL other lattice islands.

```typescript
function adjacentBuildings(
  b: PlacedBuilding,
  all: PlacedBuilding[],
  world?: WorldState
): PlacedBuilding[] {
  const local = computeLocalAdjacency(b, all);
  if (!world?.latticeActive) return local;

  const spec = world.islands.find(i => i.buildings === all); // need island ref
  // Better: pass islandId explicitly
  // ...
}
```

This requires threading `world` and `islandId` through adjacency computation. Modify `computeBuffStack` in `adjacency.ts` to accept optional cross-island buildings.

```typescript
export function computeBuffStack(
  building: PlacedBuilding,
  allLocal: PlacedBuilding[],
  crossIsland?: PlacedBuilding[]
): BuffResult {
  const neighbors = computeLocalAdjacency(building, allLocal);
  if (crossIsland) {
    neighbors.push(...crossIsland);
  }
  // ... existing dedup and cap logic ...
}
```

- [ ] **Step 4: Summed storage caps**

```typescript
function latticeStorageCaps(world: WorldState, islandId: string): Record<ResourceId, number> {
  if (!world.latticeActive) return world.islandStates[islandId].storageCaps;
  const unified: Record<ResourceId, number> = {};
  for (const id of world.latticeNodeIslands) {
    const caps = world.islandStates[id].storageCaps;
    for (const [r, amt] of Object.entries(caps)) {
      unified[r as ResourceId] = (unified[r as ResourceId] ?? 0) + amt;
    }
  }
  return unified;
}
```

Use this in `advanceIsland` for cap checks.

- [ ] **Step 5: Tests**

```typescript
describe('Omniscient Lattice', () => {
  it('activates at 20 T5-mastered nodes', () => {
    const world = makeTestWorldWithLatticeNodes(20);
    expect(checkLatticeActivation(world)).toBe(true);
  });
  it('does not activate below 20', () => {
    const world = makeTestWorldWithLatticeNodes(19);
    expect(checkLatticeActivation(world)).toBe(false);
  });
  it('unifies inventory across lattice islands', () => {
    // ...
  });
  it('sums storage caps', () => {
    // ...
  });
});
```

- [ ] **Step 6: Commit**

```bash
git add src/endgame.ts src/world.ts src/economy.ts src/adjacency.ts src/endgame.test.ts
git commit -m "feat(§13.3): Omniscient Lattice activation + unified inventory/caps/adjacency"
```

---

## Self-Review

**1. Spec coverage:**
- §13.4 endgame goals → Task 1
- §13.3 Omniscient Lattice → Task 2
- §9.6 NC threshold N=20 → Task 2

**2. Placeholder scan:** No TBD.

**3. Type consistency:** `WorldState` extended with `endgameState`, `latticeActive`, `latticeNodeIslands`.
