# Network Consciousness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement NC route-graph reachability (#18) and settlement vehicle / NC Auto-Patronage interaction (#51).

**Architecture:** BFS over `Route[]` from home island to determine networked islands. NC buff multiplier applied in `computeRates`. Auto-Patronage spawns default routes when a new colony is settled and the 10-island milestone is active.

**Tech Stack:** TypeScript strict, vitest. Pure layer: `network-consciousness.ts`, `routes.ts`, `settlement.ts`, `economy.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/network-consciousness.ts` | Route-graph BFS, NC milestone detection, buff multiplier |
| `src/network-consciousness.test.ts` | Tests for graph reachability and milestone logic |
| `src/routes.ts` | Route creation helpers for Auto-Patronage |
| `src/settlement.ts` | Auto-Patronage trigger on settlement arrival |
| `src/economy.ts` | Apply `ncBuff` from `RatesContext` |
| `src/main.ts` | HUD indicator for NC milestone progress |

---

### Task 1: Route-Graph Reachability

**Files:**
- Create: `src/network-consciousness.ts`
- Create: `src/network-consciousness.test.ts`
- Modify: `src/economy.ts`
- Modify: `src/world.ts`

- [ ] **Step 1: BFS reachability from home**

```typescript
// src/network-consciousness.ts

import type { WorldState } from './world.js';

export function networkedIslandIds(world: WorldState): Set<string> {
  const home = world.islands.find(i => i.populated);
  if (!home) return new Set();

  const visited = new Set<string>();
  const queue = [home.id];
  visited.add(home.id);

  while (queue.length > 0) {
    const current = queue.shift()!;
    // Find all routes from current
    const outbound = world.routes.filter(r => r.from === current);
    for (const route of outbound) {
      if (!visited.has(route.to)) {
        visited.add(route.to);
        queue.push(route.to);
      }
    }
    // Also find inbound (graph is undirected for connectivity)
    const inbound = world.routes.filter(r => r.to === current);
    for (const route of inbound) {
      if (!visited.has(route.from)) {
        visited.add(route.from);
        queue.push(route.from);
      }
    }
  }

  return visited;
}
```

- [ ] **Step 2: NC milestone detection**

```typescript
export interface NCMilestone {
  readonly threshold: number;
  readonly buff: number;
  readonly unlocks: string[];
}

export const NC_MILESTONES: readonly NCMilestone[] = [
  { threshold: 3, buff: 0.05, unlocks: [] },
  { threshold: 5, buff: 0.10, unlocks: ['robotics_depth_3'] },
  { threshold: 10, buff: 0.25, unlocks: ['auto_patronage'] },
  { threshold: 20, buff: 0.25, unlocks: ['omniscient_lattice'] }, // buff doesn't increase at 20, just unlocks
] as const;

export function currentNCMilestone(world: WorldState): NCMilestone | null {
  const networked = networkedIslandIds(world);
  const t3Plus = Array.from(networked).filter(id => {
    const state = world.islandStates[id];
    return state && tierForLevel(state.level) >= 3;
  }).length;

  let best: NCMilestone | null = null;
  for (const m of NC_MILESTONES) {
    if (t3Plus >= m.threshold) best = m;
  }
  return best;
}
```

- [ ] **Step 3: Apply NC buff in `computeRates`**

`RatesContext.ncBuff` already exists in `economy.ts`. In `advanceIsland`:

```typescript
const milestone = currentNCMilestone(world);
const ctx: RatesContext = {
  // ...
  ncBuff: milestone?.buff ?? 0,
};
```

In `computeRates`, multiply all recipe outputs by `(1 + ncBuff)`:

```typescript
const ncMul = 1 + (ctx.ncBuff ?? 0);
// ...
const effectiveRate = baseRate * inputAvail * outputAvail * buffMul * gateMul * ncMul * (ctx.accelerationMul ?? 1);
```

- [ ] **Step 4: Replace existing simplified NC check**

`src/network-consciousness.ts:14` has a `FIXME(§9.6)` about simplified "populated at T3+" vs route-graph reachability. Replace that with the new `currentNCMilestone(world)`.

- [ ] **Step 5: Tests**

```typescript
describe('network consciousness', () => {
  it('home island is always networked', () => {
    const world = makeTestWorld();
    const net = networkedIslandIds(world);
    expect(net.has('home')).toBe(true);
  });
  it('island with no route is not networked', () => {
    // ...
  });
  it('3 T3+ islands gives +5% buff', () => {
    // ...
  });
  it('20 T3+ islands unlocks lattice prerequisite', () => {
    // ...
  });
});
```

- [ ] **Step 6: Commit**

```bash
git add src/network-consciousness.ts src/network-consciousness.test.ts src/economy.ts src/world.ts
git commit -m "feat(§9.6): NC route-graph reachability + tiered milestone buffs"
```

---

### Task 2: Auto-Patronage

**Files:**
- Modify: `src/settlement.ts`
- Modify: `src/routes.ts`
- Test: `src/settlement.test.ts`

- [ ] **Step 1: Detect 10-island milestone on settlement**

In `tickVehicles`, on successful arrival:

```typescript
// After populating target island
const milestone = currentNCMilestone(world);
const hasAutoPatronage = milestone && milestone.unlocks.includes('auto_patronage');
if (hasAutoPatronage) {
  spawnAutoPatronageRoutes(world, targetIslandId);
}
```

- [ ] **Step 2: Find nearest Patron Hub**

```typescript
function nearestPatronHub(world: WorldState, targetId: string): IslandSpec | null {
  const hubs = world.islands.filter(spec => {
    const state = world.islandStates[spec.id];
    return state && state.buildings.some(b => b.defId === 'patron_hub');
  });
  if (hubs.length === 0) return null;

  const target = world.islands.find(i => i.id === targetId)!;
  let best = hubs[0];
  let bestDist = Infinity;
  for (const hub of hubs) {
    const d = Math.hypot(hub.cx - target.cx, hub.cy - target.cy);
    if (d < bestDist || (d === bestDist && hub.id < best.id)) {
      best = hub;
      bestDist = d;
    }
  }
  return best;
}
```

- [ ] **Step 3: Spawn default routes**

```typescript
function spawnAutoPatronageRoutes(world: WorldState, targetId: string): void {
  const hub = nearestPatronHub(world, targetId);
  if (!hub) return;

  const targetState = world.islandStates[targetId];
  const targetTier = tierForLevel(targetState.level);
  const fuel = fuelForTier(targetTier);

  // Route 1: fuel
  world.routes.push(makeRoute({
    from: hub.id,
    to: targetId,
    type: 'cargo',
    filter: fuel,
    capacityPerSec: T1_CARGO_CAPACITY_UNITS_PER_SEC,
    transitTimeSec: distance / T1_CARGO_SPEED_TILES_PER_SEC,
  }));

  // Route 2: Foundation Kit components
  world.routes.push(makeRoute({
    from: hub.id,
    to: targetId,
    type: 'cargo',
    filter: null,
    priorityList: ['iron_ingot', 'brick', 'lumber', 'glass', 'gear'],
    capacityPerSec: T1_CARGO_CAPACITY_UNITS_PER_SEC,
    transitTimeSec: distance / T1_CARGO_SPEED_TILES_PER_SEC,
  }));

  // Route 3: misc T1 raws
  world.routes.push(makeRoute({
    from: hub.id,
    to: targetId,
    type: 'cargo',
    filter: null,
    priorityList: ['wood', 'stone', 'coal', 'iron_ore', 'copper_ore'],
    capacityPerSec: T1_CARGO_CAPACITY_UNITS_PER_SEC,
    transitTimeSec: distance / T1_CARGO_SPEED_TILES_PER_SEC,
  }));
}
```

- [ ] **Step 4: Tests**

```typescript
describe('Auto-Patronage', () => {
  it('spawns 3 routes on settlement when milestone active', () => {
    // ...
  });
  it('no-ops when no Patron Hub exists', () => {
    // ...
  });
  it('uses nearest Patron Hub by euclidean distance', () => {
    // ...
  });
});
```

- [ ] **Step 5: Commit**

```bash
git add src/settlement.ts src/routes.ts src/settlement.test.ts
git commit -m "feat(§9.6/§12.7): Auto-Patronage default routes on new settlement"
```

---

## Self-Review

**1. Spec coverage:**
- §9.6 route-graph reachability → Task 1
- §9.6 milestone buffs → Task 1
- §9.6 Auto-Patronage → Task 2
- §12.7 settlement / NC interaction → Task 2

**2. Placeholder scan:** No TBD.

**3. Type consistency:** `NCMilestone` thresholds match §9.6 exactly.
