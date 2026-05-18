// Ocean-layer §5 — Sonar Buoy per-tick depth-discovery.
//
// Pure layer (no PixiJS, no DOM). Walks every populated island's buildings,
// finds Sonar Buoys, and — if the buoy's island has enough power to run it —
// marks every ocean cell within `SONAR_BUOY_RADIUS_TILES` of the buoy as
// revealed in BOTH `revealedCells` and `depthRevealedCells`.
//
// Power check: an island is treated as "powered" iff the sum of
// `def.power.produces` across its placed buildings is at least the sum of
// `def.power.consumes`. This is a binary gate (no partial brownout), chosen
// because:
//   - The spec wording is "While powered" — a discrete on/off.
//   - Mirroring `computeRates` brownout (`min(1, P/C)`) would require a full
//     `IslandState` (inventory, lastTick, etc.) for tests that only care
//     about the spatial reveal.
//   - The §5.3 unified-pool / submarine-cable extensions live entirely in
//     `computeRates` / `routes.ts`; the buoy tick deliberately stays at the
//     "is the island self-sufficient" level for now. Cross-component / cable
//     power will be wired through `cableComponent.unified` in a follow-up if
//     buoy reveals turn out to be load-bearing in long brownouts.
//
// Antennas and Lighthouses also skip a power check today (they emit signal
// / vision regardless of brownout). The buoy is the first reveal-via-active-
// power building — the gate is intentional to match the spec.
//
// Cell math: a building at island-local `(b.x, b.y)` on island `spec` sits
// at world tile `(spec.cx + b.x + 0.5, spec.cy + b.y + 0.5)` — `+0.5` lands
// on the footprint center (a 1×1 SHAPES.single spans `[b.x, b.x+1)` ×
// `[b.y, b.y+1)`). `tileToCell` floors to the containing stratification
// cell. The buoy's reveal disk is centered on that cell.

import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { isOperational } from './construction.js';
import { revealOceanCells, tileToCell } from './discovery.js';
import type { WorldState } from './world.js';

/** §5 buoy reveal radius in cells (Appendix-A placeholder per design doc). */
export const SONAR_BUOY_RADIUS_TILES = 4;

/** Catalog id for the Sonar Buoy building def. Exported so the building-defs
 *  catalog and any UI / placement / picker code can refer to a single
 *  constant rather than the string literal. */
export const SONAR_BUOY_DEF_ID: BuildingDefId = 'sonar_buoy';

/** Returns true iff `spec`'s placed buildings produce at least as much power
 *  as they consume (binary "powered" gate — see file header). Pure: reads
 *  only `def.power.produces` / `def.power.consumes`, never `IslandState`.
 *
 *  Notable simplifications vs `computeRates`:
 *   - Solar / wind / heat / brownout multipliers ignored. A solar panel
 *     contributes its nominal `produces` here even at night.
 *   - Cable / Lattice cross-island sharing ignored. The gate is per-island.
 *   - Construction-in-progress buildings (`constructionRemainingMs > 0`)
 *     are NOT excluded — they're a §9.3 economy concept; the simple sum
 *     gate stays naive for now (a half-built coal gen still "produces"
 *     under this gate).
 *  These are deliberate test-simplicity trade-offs; tighten if buoy
 *  reveal accuracy ever becomes load-bearing in player feedback. */
function islandIsPowered(spec: { buildings: ReadonlyArray<{ defId: BuildingDefId }> }): boolean {
  let produced = 0;
  let consumed = 0;
  for (const b of spec.buildings) {
    const def = BUILDING_DEFS[b.defId];
    produced += def.power?.produces ?? 0;
    consumed += def.power?.consumes ?? 0;
  }
  return produced >= consumed;
}

/** §5 per-tick Sonar Buoy reveal. Idempotent within a tick (the reveal sets
 *  are Sets — re-adding the same key is a no-op). Cheap: O(islands × buoys ×
 *  disk-area) per tick; the disk is small (radius 4 cells = ≤81 cells per
 *  buoy) and Buoys are a player-built resource, not procedurally scattered. */
export function tickSonarBuoys(world: WorldState): void {
  for (const spec of world.islands) {
    if (!spec.populated) continue;
    // One island-wide power check, reused across every buoy on this island.
    // No buoys ⇒ skip the (cheap, but still pointless) sum entirely.
    let powered: boolean | null = null;
    for (const b of spec.buildings) {
      if (b.defId !== SONAR_BUOY_DEF_ID) continue;
      // §9.3 construction-in-progress buildings aren't active; biome-edit
      // invalidated buildings are also excluded (mirrors the
      // `economy.ts:525` precedent `!b.invalid && isOperational(b)`).
      if (b.invalid || !isOperational(b)) continue;
      if (powered === null) powered = islandIsPowered(spec);
      if (!powered) break; // every buoy on this island is gated identically
      // Footprint center in world-tile coords; floor to stratification cell.
      const { cellX, cellY } = tileToCell(spec.cx + b.x + 0.5, spec.cy + b.y + 0.5);
      revealOceanCells(world, cellX, cellY, SONAR_BUOY_RADIUS_TILES, {
        surface: true,
        depth: true,
      });
    }
  }
}
