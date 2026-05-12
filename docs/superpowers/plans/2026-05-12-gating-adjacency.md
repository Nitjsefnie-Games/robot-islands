# Gating Adjacency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement gating adjacency mechanics (#26) and display gating effects in the inspector (#32).

**Architecture:** `BuildingDef` gains a `gates` array describing adjacency requirements. `computeRates` checks gates before applying a building's rate; missing gates zero or degrade the rate. The inspector UI shows gate status with red/green indicators.

**Tech Stack:** TypeScript strict, vitest. Pure layer: `building-defs.ts`, `economy.ts`, `adjacency.ts`. Render layer: `inspector-ui.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/building-defs.ts` | `GateRequirement` type, add `gates` to `BuildingDef` |
| `src/economy.ts` | Gate evaluation in `computeRates` |
| `src/adjacency.ts` | `checkGates(building, allBuildings)` helper |
| `src/adjacency.test.ts` | Tests for gate logic |
| `src/inspector-ui.ts` | Gate status display |

---

### Task 1: Gating Adjacency Mechanics

**Files:**
- Modify: `src/building-defs.ts`
- Modify: `src/adjacency.ts`
- Modify: `src/economy.ts`
- Test: `src/adjacency.test.ts`

- [ ] **Step 1: Define gate types**

```typescript
// src/building-defs.ts

export type GateMatchType = 'same_def' | 'same_category' | 'def_id' | 'heat_source' | 'cooling_tower';

export interface GateRequirement {
  readonly matchType: GateMatchType;
  /** Specific defId when matchType === 'def_id'. */
  readonly defId?: BuildingDefId;
  /** Minimum number of adjacent matches required (default 1). */
  readonly minCount?: number;
  /** If true, missing gate zeros output entirely. If false, degrades. */
  readonly hard?: boolean;
  /** Degraded output multiplier when soft-gate is unmet (default 0.5). */
  readonly degradeMul?: number;
}
```

Add `gates?: ReadonlyArray<GateRequirement>` to `BuildingDef`.

- [ ] **Step 2: Add gates to relevant defs**

```typescript
// Smelter requires adjacent Heat Source
smelter: {
  // ... existing fields ...
  gates: [
    { matchType: 'heat_source', hard: true },
  ],
},

// Refinery soft-gated by Wastewater Treatment
refinery: {
  // ... existing fields ...
  gates: [
    { matchType: 'def_id', defId: 'wastewater_treatment', hard: false, degradeMul: 0.5 },
  ],
},

// Crystal Growth Lab hard-gated by Cooling Tower
crystal_growth_lab: {
  // ... existing fields ...
  gates: [
    { matchType: 'cooling_tower', hard: true },
  ],
},

// Chemical Reactor toxicity risk from adjacent Chemical Reactor
chemical_reactor: {
  // ... existing fields ...
  gates: [
    { matchType: 'same_def', hard: false, degradeMul: 1.0 }, // special: triggers event, not rate reduction
  ],
},
```

Note: `wastewater_treatment`, `crystal_growth_lab`, `chemical_reactor` may not exist yet. Add them as new defs if needed, or gate only existing defs first.

- [ ] **Step 3: Implement `checkGates`**

```typescript
// src/adjacency.ts

export interface GateResult {
  readonly satisfied: boolean;
  readonly effectiveMul: number; // 0 if hard gate fails, degradeMul if soft
  readonly toxicTrigger?: boolean; // for chemical reactor adjacency event
}

export function checkGates(
  building: PlacedBuilding,
  all: PlacedBuilding[],
  defs: DefCatalog
): GateResult {
  const def = defs[building.defId];
  if (!def.gates || def.gates.length === 0) {
    return { satisfied: true, effectiveMul: 1 };
  }

  const neighbors = computeLocalAdjacency(building, all);
  const neighborDefs = neighbors.map(b => defs[b.defId]);

  let minMul = 1;
  for (const gate of def.gates) {
    const matches = neighborDefs.filter(nd => matchesGate(nd, gate)).length;
    const needed = gate.minCount ?? 1;
    if (matches < needed) {
      if (gate.hard) return { satisfied: false, effectiveMul: 0 };
      minMul = Math.min(minMul, gate.degradeMul ?? 0.5);
    }
    // Special: chemical reactor toxicity event
    if (gate.matchType === 'same_def' && def.id === 'chemical_reactor' && matches >= 1) {
      return { satisfied: true, effectiveMul: minMul, toxicTrigger: true };
    }
  }
  return { satisfied: minMul >= 1, effectiveMul: minMul };
}

function matchesGate(nd: BuildingDef, gate: GateRequirement): boolean {
  switch (gate.matchType) {
    case 'same_def': return nd.id === gate.defId;
    case 'same_category': return nd.category === gate.defId; // gate.defId used as category here — adjust type
    case 'def_id': return nd.id === gate.defId;
    case 'heat_source': return !!nd.heatSource;
    case 'cooling_tower': return nd.id === 'cooling_tower';
  }
  return false;
}
```

Fix `same_category`: pass category string separately or overload `defId`.

- [ ] **Step 4: Integrate into `computeRates`**

Before computing a building's effective rate:

```typescript
const gateResult = checkGates(b, state.buildings, defs);
if (gateResult.effectiveMul === 0) {
  // Skip entirely — no inputs consumed, no outputs produced
  continue;
}
// Apply gate multiplier to rate
const baseRate = 1 / recipe.cycleSec;
const effectiveRate = baseRate * inputAvail * outputAvail * buffMul * gateResult.effectiveMul * (ctx.accelerationMul ?? 1);
```

- [ ] **Step 5: Chemical Reactor toxicity event**

In `advanceIsland`, after computing rates:

```typescript
for (const b of state.buildings) {
  if (b.defId !== 'chemical_reactor') continue;
  const gate = checkGates(b, state.buildings, defs);
  if (gate.toxicTrigger) {
    // 5% per real-time hour per reactor with adjacent reactor
    const TOXIC_CHANCE_PER_HOUR = 0.05;
    const dtHours = dtMs / (3600 * 1000);
    const rng = makeSeededRng(`${world.seed}_toxic_${b.id}_${Math.floor(nowMs / 3600000)}`);
    if (rng() < TOXIC_CHANCE_PER_HOUR * dtHours) {
      // Apply toxic debuff: throughput 50% for 1 hour
      // Store debuff end time on building
      (b as any).toxicUntilMs = nowMs + 3600 * 1000;
    }
  }
}
```

In `computeRates`, check `toxicUntilMs`:

```typescript
if ((b as any).toxicUntilMs && nowMs < (b as any).toxicUntilMs) {
  effectiveRate *= 0.5;
}
```

- [ ] **Step 6: Tests**

```typescript
describe('gating adjacency', () => {
  it('smelter with no heat source produces zero', () => {
    // ...
  });
  it('refinery without wastewater treatment runs at 50%', () => {
    // ...
  });
  it('chemical reactor triggers toxicity event', () => {
    // ...
  });
});
```

- [ ] **Step 7: Commit**

```bash
git add src/building-defs.ts src/adjacency.ts src/economy.ts src/adjacency.test.ts
git commit -m "feat(§4.5): gating adjacency — hard gates, soft degradation, toxicity events"
```

---

### Task 2: Inspector Gate Display

**Files:**
- Modify: `src/inspector-ui.ts`

- [ ] **Step 1: Render gate status row**

When inspecting a building with `gates`, show each gate as a pill:

```typescript
function renderGateStatus(
  building: PlacedBuilding,
  all: PlacedBuilding[],
  container: HTMLElement
): void {
  const def = BUILDING_DEFS[building.defId];
  if (!def.gates) return;

  const row = document.createElement('div');
  row.className = 'gate-row';

  for (const gate of def.gates) {
    const result = checkGates(building, all, BUILDING_DEFS);
    const pill = document.createElement('span');
    pill.className = `gate-pill ${result.satisfied ? 'satisfied' : 'missing'}`;
    pill.textContent = gateLabel(gate);
    row.appendChild(pill);
  }

  container.appendChild(row);
}
```

- [ ] **Step 2: CSS**

```css
.gate-pill {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  margin-right: 4px;
}
.gate-pill.satisfied { background: #1a5c1a; color: #88ff88; }
.gate-pill.missing { background: #5c1a1a; color: #ff8888; }
```

- [ ] **Step 3: Commit**

```bash
git add src/inspector-ui.ts
git commit -m "feat: inspector gate status pills"
```

---

## Self-Review

**1. Spec coverage:**
- §4.5 gating adjacency examples → Task 1
- §4.5 chemical reactor toxicity → Task 1
- Inspector display → Task 2

**2. Placeholder scan:** No TBD.

**3. Type consistency:** `GateRequirement` added to `BuildingDef`, `GateResult` used in `computeRates`.
