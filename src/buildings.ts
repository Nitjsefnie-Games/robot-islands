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

import { Container, Graphics, Text } from 'pixi.js';

import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { TILE_PX, desaturate, lighten } from './island.js';
import type { ResourceId } from './recipes.js';

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
  /** §4.6 generic-storage label. Meaningful ONLY for buildings whose def
   *  carries `storage.category === 'generic'` (Crate, Warehouse). Names the
   *  single ResourceId this storage instance contributes capacity to.
   *  Undefined → no resource cap contribution (forward-compat with old saves
   *  written before this field existed; those Crates load with no label and
   *  the player can label them via the inspector). The economy treats
   *  undefined-label generic storage as zero-cap; on load it does NOT
   *  back-fill a default — the inspector relabel path is the only way to
   *  attach a resource to a previously-unlabeled Crate. */
  readonly cargoLabel?: ResourceId;
  /** §4.7 maintenance: wall-clock perf-domain timestamp this building was
   *  placed at. Optional for forward-compat with saved buildings minted
   *  before the maintenance system shipped — those load with the field
   *  undefined and behave as if freshly placed (operatingMs = 0, factor 1.0)
   *  until the first auto-maintenance check stamps a real value. */
  readonly placedAt?: number;
  /** §4.7 accumulated operating time since last maintenance, in ms. Ticks
   *  every advanceIsland segment regardless of whether the building actually
   *  ran (§4.7: "Idle buildings ... accrue maintenance time the same as
   *  actively-producing ones"). Resets to 0 on a successful maintenance
   *  cycle. Missing on legacy saves = treated as 0 by `maintenanceFactor`. */
  readonly operatingMs?: number;
  /** §4.7 perf-domain timestamp of the most recent successful auto-maintain
   *  cycle. Defaults to `placedAt` on a fresh placement. Missing on legacy
   *  saves = also undefined (the inspector reports "since placement" then). */
  readonly maintainedAt?: number;
  /** §13.3 Eternal Servitor flag. When `true`, the building skips all
   *  maintenance accrual and degradation (and, when wired, fuel-consumption
   *  checks). The Servitor Conversion Kit recipe and the Reality-Forge
   *  conversion mechanic that flips this flag are DEFERRED — the flag is
   *  honoured wherever `maintenanceFactor` / `tryAutoMaintain` read it, but
   *  nothing in the catalog turns it on yet. */
  readonly eternalServitor?: true;
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
  // tiles (-7,-3),(-6,-3),(-7,-2),(-6,-2) inside radius 14. Per §4.6
  // categorized storage, Silo bumps only dry_goods resources (coal, wood,
  // iron_ore, stone, sand, salt, quartz, scrap, iron_ingot, coke, pig_iron,
  // lumber, glass, foundation_kit). Liquid_gas resources (biofuel, water,
  // etc.) and components stay at the baseline 2000.
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
 * Visual polish constants. The "weathered industrial schematic" direction
 * means buildings sit on the terrain with weight (drop shadow) and read as
 * dimensional rather than flat (bevel + glyph).
 *
 *   - DESAT_AMOUNT: 0.30 pulls 30% toward grayscale. Keeps each building
 *     identifiable by hue but stops the workshop's saturated orange / dock's
 *     candy-blue from screaming.
 *   - SHADOW_*: 2px down-right offset, dark fill at 0.4 alpha. Sells the
 *     "raised plate" feel without a real lighting pass.
 *   - BEVEL_*: 1px inner-top highlight + 1px inner-bottom shadow give a
 *     subtle stamped-metal look. Alphas tuned to read at zoom 1.0 without
 *     swamping the glyph.
 *   - GLYPH_SCALE: glyph height = TILE_PX × footprint-min × this. 0.5 lands
 *     ~24px on a 2×2 building and ~48px on a 4×4 — readable at default zoom.
 *   - GLYPH_LIGHTEN: 70% blend toward white. Glyph reads as light-on-dark on
 *     every fill, including the cyan / pink / pale-mint pastels in the T5
 *     band. (Bitwise tricks vary wildly across fills; a fixed blend is
 *     consistent.)
 */
const DESAT_AMOUNT = 0.30;
const SHADOW_OFFSET = 2;
const SHADOW_ALPHA = 0.40;
const BEVEL_ALPHA = 0.28;
const GLYPH_SCALE = 0.5;
const GLYPH_LIGHTEN = 0.70;
const GLYPH_ALPHA = 0.85;

/**
 * Render PlacedBuildings into a fresh container. Each instance's screen
 * rectangle is computed from its def's width/height + fill/stroke (so a
 * single rendering function handles every building kind uniformly).
 *
 * Coordinate convention matches `renderIslandTiles`: world (0,0) is the
 * centre of tile (0,0), so a footprint origin shifts by -TILE_PX/2 in each
 * axis. The inset leaves a thin gap so the underlying terrain colour is
 * still visible around the building edge.
 *
 * Visual polish (z-order, back to front per building):
 *   1. Drop shadow — dark rect at +2px offset, alpha 0.4.
 *   2. Main fill — desaturated catalog fill, with stroke.
 *   3. Bevel — 1px inner-top highlight + 1px inner-bottom shadow.
 *   4. Glyph — centred Unicode mark, lightened against the fill.
 *
 * All buildings share one Graphics for shapes (cheap to flush) and one
 * Container child for glyph Texts (Text needs its own object). The caller
 * destroys the Container via `destroy({ children: true })`, which cascades
 * to the Text instances and frees their textures.
 */
export function renderBuildings(buildings: ReadonlyArray<PlacedBuilding>): Container {
  const layer = new Container();
  layer.label = 'buildings';

  const half = TILE_PX / 2;
  const inset = 2;
  const g = new Graphics();
  const glyphLayer = new Container();
  glyphLayer.label = 'building-glyphs';

  for (const b of buildings) {
    const def = BUILDING_DEFS[b.defId];
    const px = b.x * TILE_PX - half + inset;
    const py = b.y * TILE_PX - half + inset;
    const w = def.width * TILE_PX - inset * 2;
    const h = def.height * TILE_PX - inset * 2;

    // 1) Drop shadow — same shape, offset down-right, dark fill at low
    // alpha. Drawn first so everything else stacks on top.
    g.rect(px + SHADOW_OFFSET, py + SHADOW_OFFSET, w, h).fill({
      color: 0x000000,
      alpha: SHADOW_ALPHA,
    });

    // 2) Main fill — desaturated to read as weathered/aged. Stroke uses
    // the def's full-saturation stroke colour for definition.
    const fillCol = desaturate(def.fill, DESAT_AMOUNT);
    g.rect(px, py, w, h)
      .fill(fillCol)
      .stroke({ width: 2, color: def.stroke, alignment: 1 });

    // 3) Bevel — 1px inner-top lighter line + 1px inner-bottom darker
    // line. Drawn 1px inside the stroke so the building reads as a
    // stamped metal plate.
    const beveled = lighten(fillCol, 0.30);
    // Inner top edge (highlight).
    g.moveTo(px + 1, py + 1).lineTo(px + w - 1, py + 1)
      .stroke({ width: 1, color: beveled, alpha: BEVEL_ALPHA });
    // Inner left edge (highlight).
    g.moveTo(px + 1, py + 1).lineTo(px + 1, py + h - 1)
      .stroke({ width: 1, color: beveled, alpha: BEVEL_ALPHA });
    // Inner bottom edge (shadow).
    g.moveTo(px + 1, py + h - 1).lineTo(px + w - 1, py + h - 1)
      .stroke({ width: 1, color: 0x000000, alpha: BEVEL_ALPHA });
    // Inner right edge (shadow).
    g.moveTo(px + w - 1, py + 1).lineTo(px + w - 1, py + h - 1)
      .stroke({ width: 1, color: 0x000000, alpha: BEVEL_ALPHA });

    // 4) Glyph — centred Text. Size scales with footprint dimension so a
    // 4×4 building gets a beefier mark than a 1×1. Lightened against the
    // fill for contrast; alpha holds it back from competing with the
    // hover/select overlays.
    const minSide = Math.min(def.width, def.height);
    const fontSize = Math.round(minSide * TILE_PX * GLYPH_SCALE);
    const glyphColor = lighten(fillCol, GLYPH_LIGHTEN);
    const t = new Text({
      text: def.glyph,
      style: {
        fontFamily: 'ui-monospace, monospace',
        fontSize,
        // PIXI 8 Text.style.fill accepts a hex number directly.
        fill: glyphColor,
      },
    });
    t.alpha = GLYPH_ALPHA;
    t.anchor.set(0.5);
    // Centre on the footprint. Note px/py already include the inset; the
    // footprint centre is at (px + w/2, py + h/2). Subtle 1px down nudge
    // optically balances the bevel highlight.
    t.position.set(px + w / 2, py + h / 2);
    glyphLayer.addChild(t);
  }

  layer.addChild(g);
  layer.addChild(glyphLayer);
  return layer;
}
