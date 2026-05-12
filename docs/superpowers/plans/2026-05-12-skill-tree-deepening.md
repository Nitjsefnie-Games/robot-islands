# Skill Tree Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend skill tree from depth 2 to depth 15 per §9.3, with tier gates, geometric costs, and unique unlocks at depth 6+.

**Architecture:** Append nodes to `NODE_CATALOG` in `skilltree.ts`. Add new `SkillEffect` kinds for unique unlocks (recipe unlocks, structural changes). `effectiveSkillMultipliers` folds the deeper nodes. UI in `skilltree-ui.ts` renders deeper nodes.

**Tech Stack:** TypeScript strict, vitest. Pure layer: `skilltree.ts`. Render layer: `skilltree-ui.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/skilltree.ts` | `NODE_CATALOG` extension, new `SkillEffect` kinds, tier gating |
| `src/skilltree.test.ts` | Tests for cost curve, tier gates, unique unlocks |
| `src/skilltree-ui.ts` | Render deeper nodes, depth-gate visual indicators |
| `src/recipes.ts` | Recipe unlock flags (if adding recipe-unlock effects) |

---

### Task 1: Extend NODE_CATALOG to Depth 15

**Files:**
- Modify: `src/skilltree.ts`
- Test: `src/skilltree.test.ts`

- [ ] **Step 1: Add depth→tier and depth→cost mapping**

```typescript
export function tierRequiredForDepth(depth: number): Tier {
  if (depth <= 2) return 2;
  if (depth === 3) return 3;
  if (depth === 4) return 4;
  if (depth <= 7) return 5;
  return 6;
}

export function costForDepth(depth: number): number {
  return 2 ** (depth - 1); // 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384
}

export function magnitudeForDepth(depth: number): number {
  if (depth <= 5) {
    // geometric: 5%, 10%, 20%, 40%, 80%
    return 0.05 * (2 ** (depth - 1));
  }
  // depth 6+ uses unique unlocks, not flat %
  return 0;
}
```

- [ ] **Step 2: Add new SkillEffect kinds for unique unlocks**

```typescript
export type SkillEffect =
  | { readonly kind: 'recipeRateMul'; readonly category: RecipeCategory }
  | { readonly kind: 'storageCapMul' }
  | { readonly kind: 'powerProductionMul' }
  | { readonly kind: 'powerConsumptionMul'; readonly reduce: true }
  | { readonly kind: 'placeholder' }
  // New:
  | { readonly kind: 'unlockRecipe'; readonly recipeDefId: BuildingDefId }
  | { readonly kind: 'exoticAdjacency'; readonly description: string }
  | { readonly kind: 'biomeBypass'; readonly biomes: Biome[] }
  | { readonly kind: 'structural'; readonly description: string };
```

- [ ] **Step 3: Generate deep nodes for each sub-path**

For each of the 11 sub-paths + 4 Orbital sub-paths, generate nodes depth 3-15. Use a helper:

```typescript
function makeNodes(subPath: SubPathId, depthStart: number, depthEnd: number): SkillNode[] {
  const nodes: SkillNode[] = [];
  for (let d = depthStart; d <= depthEnd; d++) {
    const id = `${subPath}.${d}`;
    const cost = costForDepth(d);
    const tier = tierRequiredForDepth(d);
    let effect: SkillEffect;
    let magnitude = magnitudeForDepth(d);
    let description: string;

    if (d <= 5) {
      // Continue the existing flat-% pattern
      effect = { kind: 'recipeRateMul', category: subPathToCategory(subPath) };
      description = `${subPath} rate +${(magnitude * 100).toFixed(0)}%`;
    } else {
      // Unique unlock placeholders
      effect = { kind: 'structural', description: `${subPath} depth-${d} unique unlock` };
      magnitude = 0;
      description = `${subPath} unique unlock (depth ${d})`;
    }

    nodes.push({ id, subPath, depth: d, cost, magnitude, effect, description });
  }
  return nodes;
}
```

Append to `NODE_CATALOG`:

```typescript
export const NODE_CATALOG: readonly SkillNode[] = [
  // existing depth-1 and depth-2 nodes ...
  ...makeNodes('mining', 3, 15),
  ...makeNodes('forestry', 3, 15),
  ...makeNodes('drilling', 3, 15),
  ...makeNodes('robotics', 3, 15),
  ...makeNodes('smelting', 3, 15),
  ...makeNodes('chemistry', 3, 15),
  ...makeNodes('electronics', 3, 15),
  ...makeNodes('power_systems', 3, 15),
  ...makeNodes('storage', 3, 15),
  ...makeNodes('transport', 3, 15),
  ...makeNodes('network', 3, 15),
  // Orbital sub-paths (depth 1-15)
  ...makeNodes('launch', 1, 15),
  ...makeNodes('communication', 1, 15),
  ...makeNodes('discovery', 1, 15),
  ...makeNodes('resilience', 1, 15),
] as const;
```

- [ ] **Step 4: Update purchase validation**

In `canPurchaseNode` (or wherever purchase checks happen):

```typescript
const node = NODE_CATALOG.find(n => n.id === nodeId);
if (!node) return false;
const islandTier = tierForLevel(state.level);
if (islandTier < tierRequiredForDepth(node.depth)) return false;
// ... existing checks ...
```

- [ ] **Step 5: Update `effectiveSkillMultipliers` to fold unique unlocks**

Add a new return field for unlocked recipes / structural effects:

```typescript
export interface ResolvedSkillEffects {
  rateMul: Record<RecipeCategory, number>;
  storageCapMul: number;
  powerProductionMul: number;
  powerConsumptionMul: number;
  unlockedRecipes: BuildingDefId[];
  exoticAdjacencies: string[];
  biomeBypasses: Biome[];
}
```

In `effectiveSkillMultipliers`, when folding nodes:

```typescript
if (node.effect.kind === 'unlockRecipe') {
  unlockedRecipes.push(node.effect.recipeDefId);
}
if (node.effect.kind === 'biomeBypass') {
  biomeBypasses.push(...node.effect.biomes);
}
```

- [ ] **Step 6: Tests**

```typescript
describe('skill tree depth', () => {
  it('depth 3 requires T3', () => {
    expect(tierRequiredForDepth(3)).toBe(3);
  });
  it('depth 8 requires T6', () => {
    expect(tierRequiredForDepth(8)).toBe(6);
  });
  it('cost doubles each depth', () => {
    expect(costForDepth(5)).toBe(16);
    expect(costForDepth(10)).toBe(512);
  });
  it('magnitude doubles through depth 5', () => {
    expect(magnitudeForDepth(1)).toBe(0.05);
    expect(magnitudeForDepth(5)).toBe(0.80);
    expect(magnitudeForDepth(6)).toBe(0);
  });
});
```

- [ ] **Step 7: Commit**

```bash
git add src/skilltree.ts src/skilltree.test.ts
git commit -m "feat(§9.3): skill tree depths 3-15 with tier gates and geometric costs"
```

---

## Self-Review

**1. Spec coverage:**
- §9.3 depth gates → Task 1
- §9.3 geometric costs → Task 1
- §9.3 magnitude curve → Task 1
- §9.3 unique unlocks at depth 6+ → Task 1

**2. Placeholder scan:** Unique unlock descriptions are placeholders but the effect kinds are real.

**3. Type consistency:** `SkillEffect` union extended; all existing folds still handle base cases.
