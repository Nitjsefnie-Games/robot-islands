// Island tile-grid math and rendering.
//
// Per SPEC §3.4: islands are ellipses on the tile grid. A tile (x, y) — meaning
// the unit square from (x, y) to (x+1, y+1) — belongs to the island iff all four
// corners of that square lie strictly inside the ellipse
//   (x²/major²) + (y²/minor²) < 1
// This produces a slightly puffy boundary at the tile-grid scale.
//
// For step 1 we render a circular Plains island (major = minor = 14) centered at
// world origin, with a hardcoded deterministic terrain assignment.

import { Container, Graphics } from 'pixi.js';
import type { Biome } from './world.js';

export type TerrainKind =
  | 'grass'
  | 'stone'
  | 'ore'
  | 'coal'
  | 'water'
  // Step 8 biome palette additions.
  | 'tree'
  | 'sand'
  | 'ice'
  | 'magma_vent'
  // Step 4A — new terrain kinds for extractors
  | 'oil_well'
  | 'gas_seep'
  | 'helium_vent'
  // §6.1 T0 mineral raw: limestone (used by Limekiln in §7.5 chemistry chain).
  | 'limestone'
  // §6.1 T0 mineral raw: clay (Task 1.3)
  | 'clay_pit'
  // §6.1 T0 mineral raw: sulfur (Task 1.4)
  | 'sulfur_vein'
  // §6.1 T0 mineral raw: phosphate (Task 1.5)
  | 'phosphate_deposit'
  // §6.1 T0 mineral raw: graphite (Task 1.6)
  | 'graphite_vein'
  // §6.1 T0 mineral raws: copper/tin/lead (Task 1.7)
  | 'copper_vein'
  | 'tin_vein'
  | 'lead_vein'
  // §6.1 T0 mineral raw: bauxite (Task 1.8)
  | 'bauxite_vein'
  // Phase 3 — T2-T3 steel alloy chain terrain kinds
  | 'manganese_vein'
  | 'zinc_vein'
  | 'chromium_vein'
  | 'nickel_vein'
  | 'tungsten_vein'
  // Phase 10 — T3 mineral terrain kinds (Task 10.1)
  | 'mercury_pit'
  // Phase 10 — T3 mineral terrain kinds (Task 10.2)
  | 'diamond_vein'
  // Phase 10b — T3 mineral terrain kinds (Task 10.4.5)
  | 'lithium_vein'
  // Phase 16.1 — §6.4 T3 mineral terrain: uranium (Task 16.1)
  | 'uranium_vein';

export interface Tile {
  /** Tile grid x. The tile occupies the unit square [x, x+1) × [y, y+1). */
  readonly x: number;
  readonly y: number;
  readonly terrain: TerrainKind;
}

/** Tile size in pixels for the screen render. */
export const TILE_PX = 24;

const TERRAIN_COLOR: Readonly<Record<TerrainKind, number>> = {
  grass: 0x4a7c44,
  stone: 0x8a8a8a,
  ore: 0x5a4a3a,
  coal: 0x1a1a1a,
  water: 0x3b6fa3,
  // Step 8 biome palette colors.
  tree: 0x2d5a2d,        // dark green — distinguishable from grass
  sand: 0xc4a062,        // tan
  ice: 0xc8e6f0,         // pale blue
  magma_vent: 0xd04020,  // orange-red
  // Step 4A — new terrain colors
  oil_well: 0x1a0f05,     // near-black crude
  gas_seep: 0x8a9a4a,     // sulfur-green
  helium_vent: 0xc0c8e0,  // pale helium-grey
  limestone: 0xc8c0a8,    // pale calcareous beige
  clay_pit: 0xa67555,      // earthen red
  sulfur_vein: 0xd0c020,   // pale sulfur-yellow
  phosphate_deposit: 0xd5b04a, // mustard-tan
  graphite_vein: 0x2a2a2e,    // anthracite gray
  copper_vein: 0xb87333,       // copper oxide orange
  tin_vein: 0xc0c4cb,          // pale tin-grey
  lead_vein: 0x4a4a52,         // dark lead-grey
  bauxite_vein: 0xd07845,      // bauxite ochre
  // Phase 3 — T2-T3 steel alloy chain terrain colors
  manganese_vein: 0x7e4d6f,    // muted manganese purple
  zinc_vein: 0x8c93a0,          // pale zinc blue-grey
  chromium_vein: 0x5c6068,      // dark chromium grey
  nickel_vein: 0xa0a098,        // pale nickel grey-green
  tungsten_vein: 0x4a5060,      // dark tungsten blue-grey
  // Phase 10 — T3 mineral terrain colors (Task 10.1)
  mercury_pit: 0xc0c0c8,        // mercury-silver
  // Phase 10 — T3 mineral terrain colors (Task 10.2)
  diamond_vein: 0xd0e8f5,       // pale ice-blue
  // Phase 10b — T3 mineral terrain colors (Task 10.4.5)
  lithium_vein: 0xe04060,       // lithium magenta
  // Phase 16.1 — §6.4 T3 mineral terrain: uranium (Task 16.1)
  uranium_vein: 0x80c060,       // yellow-green glow
};

/**
 * Returns true iff all four corners of the unit square [x, x+1) × [y, y+1)
 * lie strictly inside the ellipse (px²/major²) + (py²/minor²) < 1.
 *
 * Strictly-inside means corners on the ellipse don't qualify; only fully
 * inscribed tiles are buildable terrain (SPEC §3.4).
 */
export function tileInscribedInEllipse(
  x: number,
  y: number,
  majorRadius: number,
  minorRadius: number,
): boolean {
  const a2 = majorRadius * majorRadius;
  const b2 = minorRadius * minorRadius;
  const corners: Array<[number, number]> = [
    [x, y],
    [x + 1, y],
    [x, y + 1],
    [x + 1, y + 1],
  ];
  for (const c of corners) {
    const px = c[0];
    const py = c[1];
    if ((px * px) / a2 + (py * py) / b2 >= 1) return false;
  }
  return true;
}

/** §3.6 extra-ellipse view consumed by `computeIslandTiles`. Each extra is
 *  an axis-aligned ellipse offset from the island's primary centre — its
 *  centre in island-local coords is `(offsetX, offsetY)`. */
export interface ExtraEllipseDef {
  readonly major: number;
  readonly minor: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Like `tileInscribedInEllipse` but for an off-centre ellipse at
 *  `(offsetX, offsetY)`. Internal helper for the §3.6 union test.
 *  Exported for `discovery.ts → islandCells` which needs to enumerate
 *  only the cells that contain at least one inscribed tile (avoiding
 *  the cell-bbox over-inclusion that put fog squares over open ocean). */
export function tileInscribedInOffsetEllipse(
  x: number,
  y: number,
  major: number,
  minor: number,
  offsetX: number,
  offsetY: number,
): boolean {
  const a2 = major * major;
  const b2 = minor * minor;
  for (const [cx, cy] of [
    [x, y],
    [x + 1, y],
    [x, y + 1],
    [x + 1, y + 1],
  ] as const) {
    const dx = cx - offsetX;
    const dy = cy - offsetY;
    if ((dx * dx) / a2 + (dy * dy) / b2 >= 1) return false;
  }
  return true;
}

/**
 * Compute the set of tiles belonging to a circular/elliptical island centered
 * at the world origin. Result is in scan order (ascending y, then ascending x).
 *
 * §3.6: when `extras` is supplied, the result is the UNION of tiles inscribed
 * in the primary ellipse (centred at 0,0) plus any tile inscribed in any
 * extra (centred at its offset). Duplicates from constituents that share a
 * tile are removed; the primary's terrain wins for shared tiles (the primary
 * is scanned first). Single-ellipse callers pass `extras` undefined and see
 * identical behaviour to the pre-§3.6 function.
 */
export function computeIslandTiles(
  majorRadius: number,
  minorRadius: number,
  terrainAt: (x: number, y: number) => TerrainKind,
  extras?: ReadonlyArray<ExtraEllipseDef>,
): Tile[] {
  const tiles: Tile[] = [];
  const seen = new Set<string>();
  // Bounding box: a tile fully inside the ellipse must satisfy |x|, |x+1| < major
  // and |y|, |y+1| < minor. So x ∈ [-major, major-1] is a safe over-approximation.
  const xMin = -Math.ceil(majorRadius);
  const xMax = Math.ceil(majorRadius) - 1;
  const yMin = -Math.ceil(minorRadius);
  const yMax = Math.ceil(minorRadius) - 1;
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      if (tileInscribedInEllipse(x, y, majorRadius, minorRadius)) {
        tiles.push({ x, y, terrain: terrainAt(x, y) });
        seen.add(`${x},${y}`);
      }
    }
  }
  if (extras && extras.length > 0) {
    for (const e of extras) {
      const exMin = Math.floor(e.offsetX - e.major);
      const exMax = Math.ceil(e.offsetX + e.major);
      const eyMin = Math.floor(e.offsetY - e.minor);
      const eyMax = Math.ceil(e.offsetY + e.minor);
      for (let y = eyMin; y <= eyMax; y++) {
        for (let x = exMin; x <= exMax; x++) {
          const key = `${x},${y}`;
          if (seen.has(key)) continue;
          if (tileInscribedInOffsetEllipse(x, y, e.major, e.minor, e.offsetX, e.offsetY)) {
            tiles.push({ x, y, terrain: terrainAt(x, y) });
            seen.add(key);
          }
        }
      }
    }
  }
  return tiles;
}

/**
 * Hardcoded deterministic terrain assignment for the step-1 home island.
 * Defaults to grass, with a small set of named tile coordinates promoted to
 * stone / ore / coal / water clusters. The exact positions don't have to mean
 * anything — they just need to look varied and live on tiles that exist within
 * a radius-14 disk inscribed grid.
 */
/**
 * Mutate an island spec's biome and terrain function. The caller supplies the
 * new `terrainAt` closure so this module avoids a runtime import cycle with
 * `biomes.ts` (which already depends on `island.ts`).
 */
export function regenerateTerrain(
  spec: { biome: Biome; terrainAt?: ((x: number, y: number) => TerrainKind) | null },
  newBiome: Biome,
  newTerrainAt: (x: number, y: number) => TerrainKind,
): void {
  spec.biome = newBiome;
  spec.terrainAt = newTerrainAt;
}

export function defaultTerrainAt(x: number, y: number): TerrainKind {
  // Stone outcrops — scattered.
  const stoneTiles: ReadonlyArray<readonly [number, number]> = [
    [-9, -2], [-8, 5], [3, 9], [7, -6], [10, 1], [-2, -10],
  ];
  // §3.7 / §8.1 bootstrap seed: 2x2 stone cluster so a 2x2 Quarry can place.
  // South-west safe zone, clear of every existing home building.
  const stoneClusterTiles: ReadonlyArray<readonly [number, number]> = [
    [-11, 4], [-10, 4], [-11, 5], [-10, 5],
  ];
  // Ore vein cluster — needs to sit under the Mine (placed at top-left of a 2×2).
  const oreTiles: ReadonlyArray<readonly [number, number]> = [
    [-7, 2], [-6, 2], [-7, 3], [-6, 3], [-5, 2], [-5, 3],
  ];
  // Coal vein. 2×2 cluster so a 2×2 Mine footprint anchored at (8, 5)
  // satisfies the §4.3 requirement that EVERY footprint tile be ore/coal.
  // The cluster was moved/squared up from the original 3-tile L-shape at
  // (5,6)/(6,6)/(5,7) when the §4.3 terrain-tile requirement landed — the
  // old footprint would have included a grass corner and failed the gate.
  // Old location also overlapped the home Shipyard at (4,6)..(6,8); the
  // new (8,5)..(9,6) site sits clear of every existing home building.
  const coalTiles: ReadonlyArray<readonly [number, number]> = [
    [8, 5], [9, 5], [8, 6], [9, 6],
  ];
  // §3.7 / §8.1 bootstrap seed: tree tiles so a 1x1 Logger can place.
  // North-east safe zone, clear of every existing home building.
  const treeTiles: ReadonlyArray<readonly [number, number]> = [
    [6, -3], [7, -3], [6, -4],
  ];
  // Small fresh-water cluster.
  const waterTiles: ReadonlyArray<readonly [number, number]> = [
    [-1, -5], [0, -5], [-1, -4], [0, -4],
  ];
  // §7.4 / §11.5 fuel chain bootstrap: one oil_well tile so the §7.4
  // petrochemical chain (Pump Jack → Lubricant Refinery) is reachable on
  // home without inter-island migration. A Pump Jack is 2×2 but only one
  // footprint tile must satisfy the §4.3 requiredTile gate, so a single
  // seeded tile is enough. South-west sector, clear of every home building
  // (Mine cluster ends at (-5, 3); Crate at (3, 4); Shipyard at (4..6, 6..8);
  // coal cluster (8..9, 5..6); water cluster (-1..0, -5..-4); tree cluster
  // (6..7, -3..-4); stone cluster (-11..-10, 4..5)). (-4, 8) sits south of
  // every cluster and inside the radius-14 inscribed disk.
  const oilWellTiles: ReadonlyArray<readonly [number, number]> = [
    [-4, 8],
  ];
  // §7.5 chemistry chain bootstrap: one limestone tile so a Limekiln can
  // place its §7.5 limestone + heat → quicklime recipe. (-9, 7) sits
  // south-west, clear of every cluster above.
  const limestoneTiles: ReadonlyArray<readonly [number, number]> = [
    [-9, 7],
  ];

  for (const t of waterTiles) if (t[0] === x && t[1] === y) return 'water';
  for (const t of coalTiles) if (t[0] === x && t[1] === y) return 'coal';
  for (const t of treeTiles) if (t[0] === x && t[1] === y) return 'tree';
  for (const t of oilWellTiles) if (t[0] === x && t[1] === y) return 'oil_well';
  for (const t of limestoneTiles) if (t[0] === x && t[1] === y) return 'limestone';
  for (const t of stoneClusterTiles) if (t[0] === x && t[1] === y) return 'stone';
  for (const t of oreTiles) if (t[0] === x && t[1] === y) return 'ore';
  for (const t of stoneTiles) if (t[0] === x && t[1] === y) return 'stone';
  return 'grass';
}

// ---------------------------------------------------------------------------
// Pure color helpers — used by tile-jitter + glyph-tinting + building palette
// desaturation. No PixiJS or DOM. Hex inputs/outputs in PIXI's 0xRRGGBB form.
// ---------------------------------------------------------------------------

/** Extract (r, g, b) channels from a 0xRRGGBB integer. */
function rgbOf(hex: number): { r: number; g: number; b: number } {
  return {
    r: (hex >>> 16) & 0xff,
    g: (hex >>> 8) & 0xff,
    b: hex & 0xff,
  };
}

/** Pack (r, g, b) channels (each 0..255, clamped) back to 0xRRGGBB. */
function packRgb(r: number, g: number, b: number): number {
  const rc = Math.max(0, Math.min(255, Math.round(r)));
  const gc = Math.max(0, Math.min(255, Math.round(g)));
  const bc = Math.max(0, Math.min(255, Math.round(b)));
  return (rc << 16) | (gc << 8) | bc;
}

/**
 * Deterministic FNV-1a-style hash of (x, y) → uniform [0, 1). Pure function.
 * Same input always returns same output across runs.
 *
 * Used for per-tile brightness jitter so terrain reads as organic rather
 * than as a perfectly uniform Excel-grid. Cheaper than the per-island
 * `tileHash01` in biomes.ts because there's no islandId — every island
 * uses the SAME jitter pattern, which gives a consistent texture across
 * the world without leaking gameplay info through the visuals.
 */
export function tileHash01(x: number, y: number): number {
  let h = 2166136261 >>> 0;
  // Mix x and y bytes into the hash. Use bit-shifted bytes so negative
  // tiles (the home island spans negative coords) still produce
  // well-distributed outputs.
  const xx = x | 0;
  const yy = y | 0;
  const bytes = [xx & 0xff, (xx >>> 8) & 0xff, (xx >>> 16) & 0xff, (xx >>> 24) & 0xff,
                 yy & 0xff, (yy >>> 8) & 0xff, (yy >>> 16) & 0xff, (yy >>> 24) & 0xff];
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1_000_003) / 1_000_003;
}

/**
 * Compute a tile's brightness-jittered fill colour. Pure function: same
 * (x, y, baseColor) always returns the same tinted hex.
 *
 * The jitter is ±5% lightness, applied by linearly blending the base
 * colour toward white (for positive jitter) or black (for negative).
 * Stays in RGB space — no HSL conversion needed for a small lightness
 * shift, and the result is visually indistinguishable for these small
 * deltas.
 *
 * Used in `renderIslandTiles` to break up the per-terrain flat fills
 * so the tile grid doesn't read as Excel cells.
 */
export function tileBrightnessJitter(x: number, y: number, baseColor: number): number {
  const h = tileHash01(x, y); // [0, 1)
  // Map [0, 1) → ±0.05. Negative half darkens, positive half lightens.
  const jitter = -0.05 + h * 0.10;
  const { r, g, b } = rgbOf(baseColor);
  if (jitter >= 0) {
    // Blend toward white by jitter weight.
    const a = jitter; // [0, 0.05]
    return packRgb(r + (255 - r) * a, g + (255 - g) * a, b + (255 - b) * a);
  }
  // Blend toward black.
  const a = -jitter; // [0, 0.05]
  return packRgb(r * (1 - a), g * (1 - a), b * (1 - a));
}

/**
 * Desaturate a colour by `amount` (0..1). Pure function: same input always
 * returns the same output.
 *
 * Reduces chroma without changing perceived lightness much — uses the
 * Rec. 601 luma coefficients to compute a grayscale target and
 * interpolates each channel toward it. `amount = 0` is identity, `amount
 * = 1` is full grayscale.
 *
 * Used to soften the building catalog's full-saturation fills so the
 * world reads as a weathered engineering schematic rather than a candy-
 * coloured RTS overlay.
 */
export function desaturate(hex: number, amount: number): number {
  const a = Math.max(0, Math.min(1, amount));
  const { r, g, b } = rgbOf(hex);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return packRgb(
    r + (luma - r) * a,
    g + (luma - g) * a,
    b + (luma - b) * a,
  );
}

/**
 * Lighten a colour by linearly blending toward white by `amount` (0..1).
 * Used to tint building glyphs slightly above their fill for readability.
 */
export function lighten(hex: number, amount: number): number {
  const a = Math.max(0, Math.min(1, amount));
  const { r, g, b } = rgbOf(hex);
  return packRgb(
    r + (255 - r) * a,
    g + (255 - g) * a,
    b + (255 - b) * a,
  );
}

/**
 * Render the tile grid into a fresh container. The container is positioned so
 * that world (0, 0) is the *center* of the centre tile (tile (0, 0)); the caller
 * is responsible for centering the container in the viewport.
 *
 * Each tile (x, y) is drawn at local pixel coordinates
 *   (x * TILE_PX - TILE_PX/2, y * TILE_PX - TILE_PX/2)
 * so that tile (0, 0) sits in the square [-TILE_PX/2, TILE_PX/2)² around the
 * origin. With this convention, placing the container at the canvas centre
 * visually centres a symmetric island regardless of viewport size.
 *
 * Visual polish:
 *   - Per-tile brightness jitter via `tileBrightnessJitter` breaks up the
 *     flat per-terrain fills (±5% deterministic noise).
 *   - The 1px black grid stroke that previously sat on top of every tile
 *     is dropped — with AA on and the jitter texture, the grid reads as
 *     debug-overlay noise rather than as terrain detail.
 *   - An island silhouette outline is drawn along the boundary tiles
 *     (each tile gets a 2px dark stroke on every side whose neighbour
 *     tile is NOT in the island set), so the island reads as a body
 *     "sitting on" the ocean rather than dissolving into it.
 */
export function renderIslandTiles(tiles: ReadonlyArray<Tile>): Container {
  const layer = new Container();
  layer.label = 'island-tiles';

  const half = TILE_PX / 2;
  const g = new Graphics();

  // Per-tile jittered fills. One rect per tile, jitter is deterministic so
  // a second render of the same island matches pixel-for-pixel (helpful
  // when the player re-discovers an island after the layer rebuild).
  for (const t of tiles) {
    const px = t.x * TILE_PX - half;
    const py = t.y * TILE_PX - half;
    const baseColor = TERRAIN_COLOR[t.terrain];
    const tinted = tileBrightnessJitter(t.x, t.y, baseColor);
    g.rect(px, py, TILE_PX, TILE_PX).fill(tinted);
  }

  // Island silhouette: dark 2px stroke on every tile edge whose neighbour
  // is outside the island. Builds a string-keyed set first so the
  // neighbour test is O(1) per tile.
  const tileSet = new Set<string>();
  for (const t of tiles) tileSet.add(`${t.x},${t.y}`);
  const has = (x: number, y: number): boolean => tileSet.has(`${x},${y}`);
  const SILHOUETTE = 0x000000;
  const SILHOUETTE_ALPHA = 0.5;
  for (const t of tiles) {
    const px = t.x * TILE_PX - half;
    const py = t.y * TILE_PX - half;
    // Top edge — neighbour at (x, y-1).
    if (!has(t.x, t.y - 1)) {
      g.moveTo(px, py).lineTo(px + TILE_PX, py)
        .stroke({ width: 2, color: SILHOUETTE, alpha: SILHOUETTE_ALPHA, alignment: 0.5 });
    }
    // Bottom edge — neighbour at (x, y+1).
    if (!has(t.x, t.y + 1)) {
      g.moveTo(px, py + TILE_PX).lineTo(px + TILE_PX, py + TILE_PX)
        .stroke({ width: 2, color: SILHOUETTE, alpha: SILHOUETTE_ALPHA, alignment: 0.5 });
    }
    // Left edge — neighbour at (x-1, y).
    if (!has(t.x - 1, t.y)) {
      g.moveTo(px, py).lineTo(px, py + TILE_PX)
        .stroke({ width: 2, color: SILHOUETTE, alpha: SILHOUETTE_ALPHA, alignment: 0.5 });
    }
    // Right edge — neighbour at (x+1, y).
    if (!has(t.x + 1, t.y)) {
      g.moveTo(px + TILE_PX, py).lineTo(px + TILE_PX, py + TILE_PX)
        .stroke({ width: 2, color: SILHOUETTE, alpha: SILHOUETTE_ALPHA, alignment: 0.5 });
    }
  }

  layer.addChild(g);
  return layer;
}
