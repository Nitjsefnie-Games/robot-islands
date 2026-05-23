// §13.3 Universe Editor — reassigns an island's biome and regenerates its
// terrain + modifiers. Pure layer (no PixiJS, no DOM); the UI lives in
// inspector-ui.ts and calls `editIslandBiome` when the player commits the
// biome pick.
//
// Spec literal (§13.3, "Reality editing — Universe Editor"):
//   - Player picks a target biome from the §3.2 standard list.
//   - Biome is reassigned; terrain re-rolls under the new biome's rules
//     from the world seed. (`attachTerrainAt` rebinds the closure via
//     `spec.biome`, so mutating biome on the spec implicitly re-rolls
//     terrain — the closure reads `spec.biome` dynamically.)
//   - Existing buildings remain placed but may become invalid (a Mine on
//     what used to be an ore vein halts if the new tile isn't ore). We
//     set `b.invalid = true` on any building whose footprint no longer
//     matches its `requiredTile`.
//   - Modifiers are wiped + re-rolled per the new biome's distribution,
//     excluding rare/natural-only modifiers (`rerollModifiers` handles
//     this — natural-only entries are filtered out post-roll).
//   - Each use consumes substantial T5 components (placeholder cost
//     below; tune via Appendix A once T5 throughput is balanced).
//
// Each invocation is a heavy commitment — the building is reusable but
// invocations cost real materials, and Aetheric Anomaly / Frozen Core
// modifiers are lost without compensation (per §13.3 "real cost").

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
