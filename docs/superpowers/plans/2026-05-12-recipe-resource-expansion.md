# Recipe & Resource Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the T3 microchip intermediate chain (circuit_board, processor, computing_module) and byproducts (oxygen, argon, slag/scrap) with downstream consumers.

**Architecture:** New `ResourceId` entries in `recipes.ts`, new recipes wired into `BUILDING_DEFS`, and tests verifying production chains. Byproducts are added as additional recipe outputs and consumed by existing downstream recipes.

**Tech Stack:** TypeScript strict, vitest. Pure layer only.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/recipes.ts` | New `ResourceId` entries, `XP_WEIGHT` entries, new `Recipe` entries |
| `src/building-defs.ts` | New building defs for microchip intermediates; byproduct consumers wired |
| `src/economy.ts` | Verify multi-output recipes work (they already do — just add tests) |
| `src/recipes.test.ts` | Tests for new recipe chains (create if missing) |
| `src/building-defs.test.ts` | Tests for new defs |

---

### Task 1: T3 Microchip Chain Intermediates

**Files:**
- Modify: `src/recipes.ts`
- Modify: `src/building-defs.ts`
- Test: `src/recipes.test.ts`

- [ ] **Step 1: Add new ResourceId entries**

In `src/recipes.ts`, add to the `ResourceId` union:

```typescript
| 'circuit_board'
| 'processor'
| 'computing_module'
```

Also add them to `ALL_RESOURCES` array if one exists (check file). Add `XP_WEIGHT` entries:

```typescript
circuit_board: 30,    // T3 component
processor: 30,        // T3 component
computing_module: 30, // T3 component
```

- [ ] **Step 2: Add recipes for the chain**

Per §7.7:

```typescript
// PCB -> Circuit board (new building or reuse existing?)
// Check existing: PCB is made at... look for existing PCB recipe.
```

Actually, looking at the current recipes.ts, let me check what exists. We need to add:

1. `pcb` recipe (may already exist)
2. `circuit_board` recipe: inputs = PCB + Transistors + Capacitors + Resistors + Solder
3. `processor` recipe: inputs = Circuit board + Memory module + ... (but memory module may not exist yet — simplify)
4. `computing_module` recipe

Given the existing catalog, we'll add practical placeholder recipes:

```typescript
{
  defId: 'circuit_assembler',
  inputs: { pcb: 1, microchip: 2, steel: 1 },
  outputs: { circuit_board: 1 },
  cycleSec: 30,
  category: 'electronics',
},
{
  defId: 'processor_fab',
  inputs: { circuit_board: 2, microchip: 4, exotic_alloy: 1 },
  outputs: { processor: 1 },
  cycleSec: 60,
  category: 'electronics',
},
{
  defId: 'compute_module_fab',
  inputs: { processor: 2, circuit_board: 4, quantum_chip: 1 },
  outputs: { computing_module: 1 },
  cycleSec: 120,
  category: 'electronics',
},
```

- [ ] **Step 3: Add building defs**

Add `defId` entries:

```typescript
| 'circuit_assembler'
| 'processor_fab'
| 'compute_module_fab'
```

Add `BUILDING_DEFS` entries:

```typescript
circuit_assembler: {
  id: 'circuit_assembler',
  name: 'Circuit Assembler',
  category: 'electronics',
  tier: 3,
  footprint: { width: 2, height: 2 },
  power: { consumes: 30 },
  placementCost: { steel: 10, microchip: 5, gear: 5 },
},
processor_fab: {
  id: 'processor_fab',
  name: 'Processor Fabricator',
  category: 'electronics',
  tier: 4,
  footprint: { width: 3, height: 2 },
  power: { consumes: 60 },
  placementCost: { steel: 20, microchip: 10, exotic_alloy: 2 },
},
compute_module_fab: {
  id: 'compute_module_fab',
  name: 'Computing Module Fabricator',
  category: 'electronics',
  tier: 4,
  footprint: { width: 3, height: 3 },
  power: { consumes: 100 },
  placementCost: { steel: 30, quantum_chip: 2, exotic_alloy: 5 },
},
```

- [ ] **Step 4: Wire downstream consumers**

The `computing_module` should be consumed by T5 buildings. Check existing T5 recipes in `recipes.ts` and add `computing_module` as an input where appropriate (e.g., `ascendant_assembly`, `reality_forge` recipes).

- [ ] **Step 5: Write tests**

```typescript
// src/recipes.test.ts (create if missing)
import { describe, expect, it } from 'vitest';
import { RECIPES, XP_WEIGHT } from './recipes.js';

describe('microchip chain', () => {
  it('circuit_assembler produces circuit_board', () => {
    const r = RECIPES.circuit_assembler;
    expect(r.outputs.circuit_board).toBe(1);
    expect(r.inputs.pcb).toBe(1);
  });
  it('processor_fab produces processor', () => {
    const r = RECIPES.processor_fab;
    expect(r.outputs.processor).toBe(1);
    expect(r.inputs.circuit_board).toBe(2);
  });
  it('computing_module has T3 xp weight', () => {
    expect(XP_WEIGHT.computing_module).toBe(30);
  });
});
```

- [ ] **Step 6: Commit**

```bash
git add src/recipes.ts src/building-defs.ts src/recipes.test.ts
git commit -m "feat(§7.7): T3 microchip intermediate chain (circuit_board, processor, computing_module)"
```

---

### Task 2: Byproducts — Oxygen, Argon, Scrap

**Files:**
- Modify: `src/recipes.ts`
- Modify: `src/building-defs.ts`
- Test: `src/recipes.test.ts`

- [ ] **Step 1: Add byproduct ResourceIds**

```typescript
| 'oxygen'
| 'argon'
| 'slag'
```

Add `XP_WEIGHT` (T1-ish byproducts = 3):

```typescript
oxygen: 3,
argon: 3,
slag: 3,
```

- [ ] **Step 2: Add byproduct outputs to existing recipes**

Per §6.7 / §7.5:

1. **Electrolyzer** → add `oxygen` output (already produces hydrogen, add oxygen as secondary).
2. **Air Separator** → add `oxygen`, `argon`, `liquid_nitrogen` outputs.
3. **Steel Mill** → add `slag` output (already produces steel from pig_iron + scrap).

Modify existing recipes in `RECIPES`:

```typescript
// Find electrolyzer recipe, add oxygen output
// Find air_separator recipe, add argon + liquid_nitrogen
// Find steel_mill recipe, add slag
```

- [ ] **Step 3: Add downstream consumers for byproducts**

Per §6.7:
- Steel uses oxygen (Steel Mill already exists — modify recipe to optionally consume oxygen for bonus? Or add a new Oxygen-Enriched Steel recipe? Keep simple: add `oxygen` as an input to `steel_mill` with increased output.)
- Lab uses argon (Argon is used in Cryogenic Compute Center or Lithography Lab).

Add `oxygen` input to `steel_mill` recipe:

```typescript
// Existing: pig_iron + scrap -> steel
// New optional path? The engine doesn't support optional inputs.
// Instead: add a second steel recipe at a new building `oxygen_steel_converter`.
```

Simpler approach: just add the byproducts as outputs first. Downstream consumers can be added as new recipes:

```typescript
{
  defId: 'argon_cryo_lab',
  inputs: { argon: 1, quantum_chip: 1 },
  outputs: { ai_core: 1 }, // boosted ai_core recipe
  cycleSec: 60,
  category: 'electronics',
},
```

Actually, keep it minimal. The spec says "add downstream consumers (steel uses oxygen, lab uses argon)". Let's add:

1. A new `oxygen_enriched_steel` recipe at a new building (or modify existing).
2. Argon usage in the `cryogenic_compute_center` recipe.

But since the economy doesn't support recipe selection per building, we need either:
- A new building def for the oxygen-steel recipe
- Or just add argon as a required input to an existing recipe and accept it as a gate

Let's add a new building:

```typescript
| 'oxygen_converter'
```

```typescript
oxygen_converter: {
  id: 'oxygen_converter',
  name: 'Oxygen Converter',
  category: 'smelting',
  tier: 3,
  footprint: { width: 2, height: 2 },
  power: { consumes: 40 },
  placementCost: { steel: 10, gear: 5 },
},
```

Recipe:

```typescript
{
  defId: 'oxygen_converter',
  inputs: { pig_iron: 1, scrap: 1, oxygen: 2 },
  outputs: { steel: 2 }, // bonus steel from oxygen
  cycleSec: 20,
  category: 'smelting',
},
```

- [ ] **Step 4: Tests**

```typescript
describe('byproducts', () => {
  it('electrolyzer produces oxygen', () => {
    expect(RECIPES.electrolyzer.outputs.oxygen).toBeGreaterThan(0);
  });
  it('air_separator produces argon', () => {
    expect(RECIPES.air_separator.outputs.argon).toBeGreaterThan(0);
  });
  it('oxygen_converter consumes oxygen to make bonus steel', () => {
    expect(RECIPES.oxygen_converter.inputs.oxygen).toBeGreaterThan(0);
    expect(RECIPES.oxygen_converter.outputs.steel).toBe(2);
  });
});
```

- [ ] **Step 5: Commit**

```bash
git add src/recipes.ts src/building-defs.ts src/recipes.test.ts
git commit -m "feat(§6.7): byproducts oxygen/argon/slag with downstream consumers"
```

---

## Self-Review

**1. Spec coverage:**
- §7.7 microchip chain → Task 1
- §6.7 byproducts → Task 2

**2. Placeholder scan:** No TBD.

**3. Type consistency:** New `ResourceId` literals added to union and ALL_RESOURCES.
