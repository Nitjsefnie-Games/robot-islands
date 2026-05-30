// §13.3 Universe Editor — reassigns an island's biome and regenerates its
// terrain + modifiers. Pure layer (no PixiJS, no DOM); the UI lives in
// inspector-ui.ts and calls `editIslandBiome` when the player commits the pick.
//
// Per §13.3, target biome comes from the §3.2 standard list. Terrain re-rolls
// under the new biome from the world seed via the closure rebind below.
// Existing buildings remain placed but may become invalid (a Mine off its ore
// vein halts) — marked `b.invalid = true`. Modifiers are wiped and re-rolled,
// excluding natural-only entries (`rerollModifiers` filters them). Each use is
// a heavy commitment: it costs real T5 materials and Aetheric Anomaly / Frozen
// Core modifiers are lost without compensation (§13.3 "real cost").

import { BUILDING_DEFS } from './building-defs.js';
import { hasOperationalBuilding } from './buildings.js';
import { rerollModifiers } from './biomes.js';
import type { ResourceId } from './recipes.js';
import { footprintTiles, type Rotation } from './shape-mask.js';
import type { Biome, WorldState } from './world.js';

/** Placeholder cost for one Universe Editor invocation. Tune via Appendix A. */
export const UNIVERSE_EDITOR_COST: Readonly<Partial<Record<ResourceId, number>>> = {
  reality_anchor: 5,
  memetic_core: 2,
  phase_converter: 1,
};

export type UniverseEditorReason =
  | 'no-island'
  | 'no-state'
  | 'no-universe-editor'
  | 'same-biome'
  | 'invalid-biome'
  | 'insufficient-resources';

export type UniverseEditorResult =
  | { readonly ok: true; readonly invalidated: number }
  | { readonly ok: false; readonly reason: UniverseEditorReason };

const KNOWN_BIOMES: ReadonlySet<Biome> = new Set<Biome>([
  'plains',
  'forest',
  'desert',
  'volcanic',
  'arctic',
  'coast',
]);

export function editIslandBiome(
  world: WorldState,
  islandId: string,
  newBiome: Biome,
): UniverseEditorResult {
  const spec = world.islands.find((s) => s.id === islandId);
  if (!spec) return { ok: false, reason: 'no-island' };
  const state = world.islandStates?.get(islandId);
  if (!state) return { ok: false, reason: 'no-state' };
  if (!KNOWN_BIOMES.has(newBiome)) return { ok: false, reason: 'invalid-biome' };
  if (spec.biome === newBiome) return { ok: false, reason: 'same-biome' };
  if (!hasOperationalBuilding(state.buildings, 'universe_editor')) {
    return { ok: false, reason: 'no-universe-editor' };
  }
  for (const [r, need] of Object.entries(UNIVERSE_EDITOR_COST)) {
    if ((state.inventory[r as ResourceId] ?? 0) < (need ?? 0)) {
      return { ok: false, reason: 'insufficient-resources' };
    }
  }
  for (const [r, need] of Object.entries(UNIVERSE_EDITOR_COST)) {
    state.inventory[r as ResourceId] =
      (state.inventory[r as ResourceId] ?? 0) - (need ?? 0);
  }
  // Mutate biome. `attachTerrainAt` bound `terrainAt` to read `spec.biome`
  // dynamically, so the next call to `spec.terrainAt(x, y)` already uses
  // the new biome's tile distribution without re-attaching.
  (spec as { biome: Biome }).biome = newBiome;
  // Re-roll modifiers, excluding natural-only entries per §13.3.
  spec.modifiers = rerollModifiers(world.seed, newBiome);
  // Walk every placed building: if its `requiredTile` set no longer matches
  // every footprint tile under the regenerated terrain, mark invalid.
  let invalidated = 0;
  const terrainAt = spec.terrainAt;
  if (!terrainAt) return { ok: true, invalidated: 0 };
  for (const b of state.buildings) {
    const def = BUILDING_DEFS[b.defId];
    if (!def?.requiredTile || def.requiredTile.length === 0) continue;
    const rotation = (b.rotation ?? 0) as Rotation;
    const tiles = footprintTiles(def.footprint, b.x, b.y, rotation);
    let allMatch = true;
    for (const t of tiles) {
      const terrain = terrainAt(t.x, t.y);
      if (!def.requiredTile.includes(terrain)) {
        allMatch = false;
        break;
      }
    }
    const wasInvalid = b.invalid === true;
    (b as { invalid?: boolean }).invalid = !allMatch;
    if (!allMatch && !wasInvalid) invalidated += 1;
  }
  return { ok: true, invalidated };
}
