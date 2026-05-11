// Per-instance building placement + rendering.
//
// `PlacedBuilding` is the per-instance runtime: a unique id, the BuildingDefId
// pointer into the static catalog (`building-defs.ts`), and tile coordinates.
// Static per-kind data — footprint, fill, stroke, recipe binding, power —
// lives on `BuildingDef`; rendering looks it up via `BUILDING_DEFS[b.defId]`.
//
// The split lands per SPEC §15.1: many instances share one def, the def
// table drives the Building Catalog UI, and the placement runtime stays
// minimal. Rotation lives here too — wired into the type as
// `rotation: 0|1|2|3` but unused for step 9 (placement is deferred to
// step 2.5, so every demo instance ships rotation: 0).

import { Container, Graphics } from 'pixi.js';

import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { TILE_PX } from './island.js';

/** Per-instance placement. `id` is unique across the world; `defId` points
 *  into BUILDING_DEFS. (x, y) is the top-left tile of the footprint —
 *  footprint extends to (x + def.width - 1, y + def.height - 1). */
export interface PlacedBuilding {
  readonly id: string;
  readonly defId: BuildingDefId;
  readonly x: number;
  readonly y: number;
  /** Per §15.1 BuildingDef shape, but placement (step 2.5) isn't built;
   *  every demo instance ships rotation: 0. Optional for forward-compat. */
  readonly rotation?: 0 | 1 | 2 | 3;
}

// Step-9 home-island layout. Tile coords are island-local; the home island's
// ellipse has radius 14. Footprints are verified non-overlapping; the Smelter
// at (-4, 6) sits inside the radius-14 ellipse and below the workshop.
//
// Typed as `PlacedBuilding[]` (mutable) rather than ReadonlyArray since
// step-2.5 placement pushes onto the spec's `buildings` field, which is the
// same array reference. We don't actually mutate this seed at module scope;
// `makeInitialWorld` spreads each spec into a fresh copy with its own array
// (see world.ts `makeInitialWorld`).
export const HOME_ISLAND_BUILDINGS: PlacedBuilding[] = [
  // T1 staples preserved from step 1-8 (same positions, defId redirects).
  { id: 'home-solar-1',    defId: 'solar',    x: 2,  y: -1 },
  { id: 'home-workshop-1', defId: 'workshop', x: -1, y: 1 },
  // §8.1 Mine output branches on tile — this one sits on the ore cluster at
  // (-7,2)..(-6,3) (all 4 footprint tiles are 'ore' per defaultTerrainAt) so
  // it produces iron_ore via the resolveRecipe → mine_on_ore branch.
  { id: 'home-mine-1',     defId: 'mine',     x: -7, y: 2 },
  // §8.1 second Mine on the coal cluster at (8,5)..(9,6). All 4 footprint
  // tiles are 'coal' per defaultTerrainAt — resolveRecipe → mine_on_coal
  // → produces 1 coal / 5s. Without this, the home economy has no coal
  // source beyond the seeded 50 starter units (which the iron-chain
  // exhausts in ~120s), and the iron→steel pipeline stalls. The coal Mine
  // restores the iron-chain loop end-to-end.
  { id: 'home-mine-coal-1', defId: 'mine',    x: 8,  y: 5 },
  { id: 'home-dock-1',     defId: 'dock',     x: 7,  y: 1 },
  { id: 'home-coalgen-1',  defId: 'coal_gen', x: 3,  y: 4 },
  { id: 'home-dronepad-1', defId: 'dronepad', x: 5,  y: -3 },
  // New for step 9 — Smelter at (-4, 6). 2×2 footprint: (-4,6),(-3,6),(-4,7),
  // (-3,7). All inside the radius-14 ellipse; no overlap with other tiles.
  // Demo intent: with Mine seeding iron_ore + coal already on the home island,
  // Smelter immediately starts producing iron_ingot, showing the new T1
  // refining link.
  { id: 'home-smelter-1',  defId: 'smelter',  x: -4, y: 6 },
  // Silo for storage-aggregation demo — single 2×2 at (-7, -3). All four
  // tiles (-7,-3),(-6,-3),(-7,-2),(-6,-2) inside radius 14. Raises every
  // resource cap on the home island from 100 → 2100, per the §15.7-step-9
  // aggregation rule (see world.ts `aggregateStorageCaps`).
  { id: 'home-silo-1',     defId: 'silo',     x: -7, y: -3 },
  // Step-12: Kit Assembler at (-1, -5). 2×2 footprint inside the radius-14
  // ellipse, no overlap with neighbours (dronepad at 5,-3; workshop at
  // -1,1). Lets the player craft `foundation_kit` on demand once the
  // initial seed of 3 kits runs out.
  { id: 'home-kit-assembler-1', defId: 'kit_assembler', x: -1, y: -5 },
  // Step-12: Shipyard at (4, 6). 3×3 footprint inside the radius-14
  // ellipse (corners (4,6)..(6,8) all within √(36+64) = 10.0 < 14).
  // No overlap with workshop(-1,1)..(0,2), coal_gen(3,4)..(4,5),
  // smelter(-4,6)..(-3,7), or dock(7,1)..(8,2). Coastal-tile gating
  // deferred — see §12.2 / building-defs.ts comment on `shipyard`.
  { id: 'home-shipyard-1',     defId: 'shipyard',      x: 4, y: 6 },
];

/**
 * Render PlacedBuildings into a fresh container. Each instance's screen
 * rectangle is computed from its def's width/height + fill/stroke (so a
 * single rendering function handles every building kind uniformly).
 *
 * Coordinate convention matches `renderIslandTiles`: world (0,0) is the
 * centre of tile (0,0), so a footprint origin shifts by -TILE_PX/2 in each
 * axis. The inset leaves a thin gap so the underlying terrain colour is
 * still visible around the building edge.
 */
export function renderBuildings(buildings: ReadonlyArray<PlacedBuilding>): Container {
  const layer = new Container();
  layer.label = 'buildings';

  const half = TILE_PX / 2;
  const inset = 2;
  const g = new Graphics();
  for (const b of buildings) {
    const def = BUILDING_DEFS[b.defId];
    const px = b.x * TILE_PX - half + inset;
    const py = b.y * TILE_PX - half + inset;
    const w = def.width * TILE_PX - inset * 2;
    const h = def.height * TILE_PX - inset * 2;
    g.rect(px, py, w, h)
      .fill(def.fill)
      .stroke({ width: 2, color: def.stroke, alignment: 1 });
  }
  layer.addChild(g);
  return layer;
}
