// §13.1 tier breakpoint lookup. Split out from skilltree.ts so the pure-data
// catalog (building-defs.ts) can use it without pulling in the skill-tree
// module graph, which would otherwise create a runtime import cycle back to
// recipes.ts through skilltree's ALL_RECIPE_CATEGORIES import.

import type { Tier } from './skilltree.js';

/** Map an island level to its unlocked tier breakpoint. Source of truth for
 *  both `buildingUnlocked` (building-defs.ts) and the skill-tree module. */
export function tierForLevel(level: number): Tier {
  if (level >= 50) return 5;
  if (level >= 30) return 4;
  if (level >= 15) return 3;
  if (level >= 5) return 2;
  return 1;
}
