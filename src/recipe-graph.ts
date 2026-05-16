// Pure data layer for the §15 recipe-graph modal. Generates a Mermaid
// `flowchart LR` source string from the static RECIPES + BUILDING_DEFS
// tables. No DOM. No PixiJS. Safe to memoise at module scope.
//
// Node naming:
//   - Buildings:  `bld_<buildingDefId>(["<label>"]):::tier<N>`
//   - Resources:  `res_<resourceId>(("<label>"))`
//
// Edges per recipe owned by building B:
//   - For each input resource r:  `res_<r> --> bld_<B>`
//   - For each output resource r: `bld_<B> --> res_<r>`
//
// Owner resolution: RecipeId is BuildingDefId | 'mine_on_ore' | 'mine_on_coal'
// (recipes.ts:869). The two `mine_on_*` keys both belong to the `mine`
// building; everything else maps id→id.

import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { RECIPES, type ResourceId } from './recipes.js';

const TIER_PALETTE: Record<number, { fill: string; stroke: string }> = {
  0: { fill: '#1f2933', stroke: '#3a4856' },
  1: { fill: '#243b1f', stroke: '#4a7035' },
  2: { fill: '#1f3340', stroke: '#3a6680' },
  3: { fill: '#3a2f1f', stroke: '#806035' },
  4: { fill: '#3a1f3a', stroke: '#803580' },
  5: { fill: '#3a1f1f', stroke: '#803535' },
  6: { fill: '#1f3a3a', stroke: '#358080' },
};

function ownerOf(recipeKey: string): BuildingDefId {
  if (recipeKey === 'mine_on_ore' || recipeKey === 'mine_on_coal') {
    return 'mine';
  }
  return recipeKey as BuildingDefId;
}

function resourceLabel(id: ResourceId): string {
  // Title-case the snake_case id for display.
  return id
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

let cached: string | null = null;

export function buildRecipeGraphMermaid(): string {
  if (cached !== null) return cached;

  const lines: string[] = ['flowchart LR'];

  // classDef block — one per tier in TIER_PALETTE.
  for (const [tier, c] of Object.entries(TIER_PALETTE)) {
    lines.push(
      `classDef tier${tier} fill:${c.fill},stroke:${c.stroke},color:#e0e6ed,stroke-width:1px`,
    );
  }
  // Resource nodes have their own class for visual distinction.
  lines.push('classDef resource fill:#0e1726,stroke:#3a6680,color:#cfe1f5,stroke-width:1px');

  const buildingsNeeded = new Set<BuildingDefId>();
  const resourcesNeeded = new Set<ResourceId>();
  const edges: string[] = [];

  for (const [recipeKey, recipe] of Object.entries(RECIPES)) {
    if (!recipe) continue;
    const owner = ownerOf(recipeKey);
    buildingsNeeded.add(owner);

    for (const r of Object.keys(recipe.inputs) as ResourceId[]) {
      resourcesNeeded.add(r);
      edges.push(`res_${r} --> bld_${owner}`);
    }
    for (const r of Object.keys(recipe.outputs) as ResourceId[]) {
      resourcesNeeded.add(r);
      edges.push(`bld_${owner} --> res_${r}`);
    }
  }

  // Building node declarations (sorted for stable diffs).
  for (const id of [...buildingsNeeded].sort()) {
    const def = BUILDING_DEFS[id];
    const label = def?.displayName ?? id;
    const tier = def?.tier ?? 0;
    lines.push(`bld_${id}(["${label}"]):::tier${tier}`);
  }

  // Resource node declarations (sorted for stable diffs).
  for (const id of [...resourcesNeeded].sort()) {
    lines.push(`res_${id}(("${resourceLabel(id)}")):::resource`);
  }

  // De-duplicate edges (a resource appearing in both inputs and outputs of
  // related recipes would otherwise emit the same line twice).
  for (const edge of [...new Set(edges)]) {
    lines.push(edge);
  }

  cached = lines.join('\n');
  return cached;
}

// Test-only escape hatch — vitest reuses the module between tests in the
// same file, so the module-scoped cache would freeze the output. Reset
// between describes if a test ever needs to mutate inputs (none currently).
export function _resetRecipeGraphCache(): void {
  cached = null;
}
