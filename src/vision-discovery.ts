// §2.2 — vision discovers islands.
//
// Beyond drones (§11), satellites (§14), and the T4 pulse (§11.5), any island
// a live VISION SOURCE overlaps is automatically discovered: a populated
// island's padded halo or a Lighthouse's vision circle. This is the same
// any-cell overlap rule the drone scan uses (`islandIntersectsCells`), fed the
// cells the vision sources cover. Monotonic and idempotent — only flips
// `discovered` false→true, so once found an island stays found even when
// vision later recedes (it then renders on the steel-blue 'discovered' tier).
//
// Pure layer: no PixiJS, no DOM. The single mutation is `isl.discovered = true`.
// Only the island flag is flipped — surrounding seabed terrain still requires a
// drone / depth scan to read (revealedCells is untouched here).

import { islandIntersectsCells, markIslandDiscovered } from './discovery.js';
import { computeVisionSources } from './lighthouse.js';
import { visibleCellsFromVision } from './vision-source.js';
import type { WorldState } from './world.js';

/** Discover every undiscovered island that any active vision source overlaps.
 *  Returns the ids newly discovered by this sweep (for telemetry / UI). Safe
 *  to call every tick — short-circuits when nothing is undiscovered. */
export function discoverIslandsInVision(
  world: Pick<WorldState, 'islands' | 'revealedCells'>,
): string[] {
  // Short-circuit the common steady state: everything already known.
  if (world.islands.every((s) => s.discovered)) return [];
  const populated = world.islands.filter((s) => s.populated);
  const visibleCells = visibleCellsFromVision(computeVisionSources(populated));
  const discovered: string[] = [];
  for (const isl of world.islands) {
    if (isl.discovered) continue;
    if (islandIntersectsCells(isl, visibleCells)) {
      // Whole-island reveal: a vision source clipping one edge still reveals
      // the full footprint (incl. cells outside the source), so the rest
      // doesn't render as fog. Matches drone/init discovery semantics.
      markIslandDiscovered(isl, world.revealedCells);
      discovered.push(isl.id);
    }
  }
  return discovered;
}
