// §2 Ocean-layer data primitives.
//
// Per the ocean-layer design doc §2: the world maintains a sparse map of
// ocean cells keyed `"cellX,cellY"`. Cells NOT in the map are implicit
// `deep` — the default ocean tier — so empty seas cost zero memory.
//
// This module is pure (no PixiJS, no DOM) and holds the type + the two
// lookup helpers everything else (placement, render glyphs, sonar
// reveal) builds on:
//
//   - `terrainAt(world, x, y)`    — point lookup with implicit 'deep'
//                                   fallback for unmapped cells.
//   - `footprintMatches(world, ax, ay, w, h, allowed)` — predicate used
//                                   by building placement to confirm an
//                                   AABB lies entirely on the required
//                                   terrain(s). Accepts an OR list so
//                                   buildings that need "shallows OR deep"
//                                   (e.g. ocean-floor anchored) can
//                                   share one helper with the strict
//                                   single-terrain extractors.

export type OceanTerrain =
  | 'shallows'
  | 'deep'
  | 'trench'
  | 'hydrothermal_vent'
  | 'nodule_field';

export interface OceanCellSpec {
  readonly terrain: OceanTerrain;
}

/** Structural slice of `WorldState` that this module needs. Kept narrow so
 *  unit tests can construct minimal fixtures without standing up a whole
 *  world. The full `WorldState` (in `world.ts`) is assignable to this. */
interface OceanWorld {
  readonly oceanCells: ReadonlyMap<string, OceanCellSpec>;
}

const key = (x: number, y: number): string => `${x},${y}`;

/** Look up the terrain at an ocean cell. Returns 'deep' for cells not
 *  explicitly stored in the map (the implicit default for empty sea). */
export function terrainAt(world: OceanWorld, cellX: number, cellY: number): OceanTerrain {
  return world.oceanCells.get(key(cellX, cellY))?.terrain ?? 'deep';
}

/** Returns true iff every tile under the building's footprint
 *  (anchorX..anchorX+w-1, anchorY..anchorY+h-1) matches one of the
 *  required terrains. */
export function footprintMatches(
  world: OceanWorld,
  anchorX: number,
  anchorY: number,
  footprintW: number,
  footprintH: number,
  requiredTerrains: readonly OceanTerrain[],
): boolean {
  for (let dy = 0; dy < footprintH; dy++) {
    for (let dx = 0; dx < footprintW; dx++) {
      const t = terrainAt(world, anchorX + dx, anchorY + dy);
      if (!requiredTerrains.includes(t)) return false;
    }
  }
  return true;
}
