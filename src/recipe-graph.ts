// Pure data layer for the §15 recipe-graph modal: flat recipe table rows
// from the static RECIPES + BUILDING_DEFS tables.
// No DOM. No PixiJS. No module-level cache.

import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { RECIPES, type RecipeCategory, type ResourceId } from './recipes.js';
import { buildingForRecipe } from './recipe-density.js';

export interface RecipeTableEntry {
  readonly resource: ResourceId;
  readonly n: number;
}

/** Per spec v2 section 05 — eight gate dimensions in the data.
 *  Status (met / pending / N/A) is decided at RENDER time against the
 *  active island; this layer is pure and stores only the requirement. */
export type GateKind =
  | 'tier'      // def.tier (1-4) -- runtime: tierForLevel(state.level) >= def.tier
  | 't5'        // def.tier === 5 -- runtime: t5Unlocked(state)
  | 't6'        // def.tier === 6 -- runtime: t6Unlocked(state, hasSpaceport)
  | 'biome'     // def.requiredBiomes -- runtime: canPlaceOnIsland(def, spec)
  | 'tile'      // def.requiredTile -- placement-time only (catalog row = N/A)
  | 'coastal'   // def.coastal -- placement-time only (catalog row = N/A)
  | 'heat'      // def.requiresHeat -- runtime adjacency (catalog row = N/A)
  | 'adjacency';// def.gates[] -- runtime adjacency (catalog row = N/A)

export interface GateEntry {
  readonly kind: GateKind;
  /** Display string (e.g. "L≥30", "biome=volcanic", "tile=ore|coal", "heat-src"). */
  readonly label: string;
}

export interface RecipeTableRow {
  readonly category: RecipeCategory;
  readonly recipeKey: string;
  readonly buildingId: BuildingDefId;
  readonly buildingLabel: string;
  readonly tier: number;
  readonly inputs: ReadonlyArray<RecipeTableEntry>;
  readonly outputs: ReadonlyArray<RecipeTableEntry>;
  readonly cycleSec: number;
  readonly gates: ReadonlyArray<GateEntry>;
}



export function buildRecipeTableRows(): ReadonlyArray<RecipeTableRow> {
  const rows: RecipeTableRow[] = [];

  for (const [recipeKey, recipe] of Object.entries(RECIPES)) {
    if (!recipe) continue;

    const inputs = Object.entries(recipe.inputs)
      .map(([resource, n]) => ({ resource: resource as ResourceId, n: n ?? 0 }))
      .sort((a, b) => a.resource.localeCompare(b.resource));

    const outputs = Object.entries(recipe.outputs)
      .map(([resource, n]) => ({ resource: resource as ResourceId, n: n ?? 0 }))
      .sort((a, b) => a.resource.localeCompare(b.resource));

    if (inputs.length === 0 && outputs.length === 0) continue;

    const buildingId = buildingForRecipe(recipeKey);
    const def = BUILDING_DEFS[buildingId];
    const buildingLabel = def?.displayName ?? buildingId;
    const tier = def?.tier ?? 0;

    const gates: GateEntry[] = [];
    if (def) {
      // Tier band — splits T5 / T6 into endgame kinds since their status
      // predicates differ (need aiCoreCrafted / ascendantCoreCrafted flags).
      if (def.tier === 5) {
        gates.push({ kind: 't5', label: 'L≥50 · ai_core' });
      } else if (def.tier === 6) {
        // Spaceport is exempt from the spaceport-placed half (chicken-and-egg)
        if (buildingId === 'spaceport') {
          gates.push({ kind: 't6', label: 'ascendant_core' });
        } else {
          gates.push({ kind: 't6', label: 'ascendant_core · spaceport' });
        }
      } else if (def.tier > 1) {
        // L≥6 / L≥11 / L≥16 / etc. — tierForLevel band edges (spec §9.2).
        const lvl = (def.tier - 1) * 5 + 1;
        gates.push({ kind: 'tier', label: `L≥${lvl}` });
      }
      if (def.requiredBiomes && def.requiredBiomes.length > 0) {
        gates.push({ kind: 'biome', label: `biome=${def.requiredBiomes.join('|')}` });
      }
      if (def.requiredTile && def.requiredTile.length > 0) {
        gates.push({ kind: 'tile', label: `tile=${def.requiredTile.join('|')}` });
      }
      if (def.coastal) {
        gates.push({ kind: 'coastal', label: 'coastal' });
      }
      if (def.requiresHeat) {
        gates.push({ kind: 'heat', label: 'heat-src' });
      }
      if (def.gates && def.gates.length > 0) {
        for (const g of def.gates) {
          let label: string;
          switch (g.matchType) {
            case 'def_id':       label = `adj=${g.defId ?? '?'}`; break;
            case 'same_category':label = `adj=${g.category ?? '?'}`; break;
            case 'heat_source':  label = 'adj=heat-src'; break;
            default:             label = `adj=${String(g.matchType)}`;
          }
          gates.push({ kind: 'adjacency', label });
        }
      }
    }

    rows.push({
      category: recipe.category,
      recipeKey,
      buildingId,
      buildingLabel,
      tier,
      inputs,
      outputs,
      cycleSec: recipe.cycleSec,
      gates,
    });
  }

  rows.sort((a, b) => {
    const byCat = a.category.localeCompare(b.category);
    if (byCat !== 0) return byCat;
    const byLabel = a.buildingLabel.localeCompare(b.buildingLabel);
    if (byLabel !== 0) return byLabel;
    return a.recipeKey.localeCompare(b.recipeKey);
  });

  return rows;
}
