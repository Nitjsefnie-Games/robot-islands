// §6 hover-tooltip — universal cell-info readout.
//
// Mouse-over on any cell (land OR ocean) opens a small DOM tooltip near
// the cursor showing structured info. The tooltip is the player's
// always-works channel for cell state because the weather overlay paints
// opaque tint over cells during storms — feature glyphs alone are not a
// reliable read.
//
// This module has two surfaces:
//   1. Pure `cellInfoForHover(world, cellKey, nowMs)` → `HoverInfo` — unit
//      tested, no DOM, no PixiJS. Routes by cell state per the design doc:
//        - revealed + depth-revealed + rare terrain → cluster bbox +
//          occupancy
//        - revealed + depth-revealed + bulk terrain → terrain name
//        - revealed, NOT depth-revealed              → "Unscouted depths"
//        - NOT revealed                              → "Open ocean"
//        - tile lies inside a populated island       → land tile + building
//      Weather (current cycle + forecast) is appended to every result.
//   2. `mountHoverTooltip(parentEl)` → DOM handle with
//      `setHover(world, cellKey | null, screenX, screenY, nowMs)`. The
//      caller drives positioning from a mousemove handler; this module
//      owns the DOM element + its content. `pointer-events: none` so
//      it never intercepts canvas clicks.
//
// The hover tooltip COEXISTS with the existing terrain-tooltip (consumer
// hints for land tiles). When a populated land cell is hovered, the
// hover tooltip surfaces the same terrain name plus the building one-
// liner; main.ts decides whether the terrain-tooltip's consumer list
// stays visible alongside or is suppressed.

import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { CELL_SIZE_TILES } from './constants.js';
import { RARE_TERRAINS, terrainAt, type OceanTerrain } from './ocean-cell.js';
import { buildingAtTile, findOceanBuildingAt } from './placement.js';
import { findPopulatedIslandAt, type IslandSpec, type WorldState } from './world.js';
import { biomeForCell, weather, type WeatherState, WEATHER_FORECAST_LOOKAHEAD_MS } from './weather.js';

// ---------------------------------------------------------------------------
// Display strings
// ---------------------------------------------------------------------------

/** Player-facing label per ocean terrain id. The bulk terrains (shallows,
 *  deep) also surface; rare terrains read the same here and add cluster
 *  info downstream. */
const OCEAN_TERRAIN_LABEL: Readonly<Record<OceanTerrain, string>> = {
  shallows: 'Shallows',
  deep: 'Deep Water',
  trench: 'Trench',
  hydrothermal_vent: 'Hydrothermal Vent',
  nodule_field: 'Nodule Field',
};

/** Player-facing label per weather state. Used in the "current cycle"
 *  string the tooltip renders for both land and ocean cells. */
const WEATHER_STATE_LABEL: Readonly<Record<WeatherState, string>> = {
  clear: 'Clear',
  light_fog: 'Light fog',
  storm: 'Storm',
  severe_storm: 'Severe storm',
  catastrophic: 'Catastrophic',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Weather summary surfaced on every hover info. `state` is the current
 *  cycle label (e.g. "Clear", "Storm"); `forecastText` is null when no
 *  state-change is known within the lookahead window. */
export interface WeatherInfo {
  readonly state: string;
  readonly forecastText: string | null;
}

export interface OceanRareInfo {
  readonly kind: 'ocean-rare';
  readonly terrain: 'trench' | 'hydrothermal_vent' | 'nodule_field';
  readonly terrainLabel: string;
  readonly clusterSize: { readonly width: number; readonly height: number };
  readonly occupancy: { readonly used: number; readonly capacity: number };
  readonly weather: WeatherInfo | null;
}

export interface OceanBulkInfo {
  readonly kind: 'ocean-revealed';
  readonly terrain: 'shallows' | 'deep';
  readonly text: string;
  readonly weather: WeatherInfo | null;
}

export interface OceanUndepthedInfo {
  readonly kind: 'ocean-undepthed';
  readonly text: string;
  readonly weather: WeatherInfo | null;
}

export interface OceanUnrevealedInfo {
  readonly kind: 'ocean-unrevealed';
  readonly text: string;
  readonly weather: WeatherInfo | null;
}

export interface LandInfo {
  readonly kind: 'land';
  /** Land tile type label (e.g. "iron_ore"). Empty string when the
   *  island carries no `terrainAt`. */
  readonly text: string;
  /** One-line building description (`displayName T{tier}`), or null when
   *  no building covers the hovered tile. */
  readonly building: string | null;
  readonly weather: WeatherInfo | null;
}

export type HoverInfo =
  | OceanRareInfo
  | OceanBulkInfo
  | OceanUndepthedInfo
  | OceanUnrevealedInfo
  | LandInfo;

// ---------------------------------------------------------------------------
// Cell-key parsing + cluster bbox
// ---------------------------------------------------------------------------

function parseCellKey(cellKey: string): { x: number; y: number } | null {
  const idx = cellKey.indexOf(',');
  if (idx < 0) return null;
  const x = Number.parseInt(cellKey.slice(0, idx), 10);
  const y = Number.parseInt(cellKey.slice(idx + 1), 10);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Flood-fill the rare-terrain cluster containing `cellKey` and return its
 *  axis-aligned bounding box + cell membership. Mirrors `clusterAnchorOf`'s
 *  flood walk; needed here for the size readout (anchor alone doesn't carry
 *  bbox). Returns null when the cell isn't a rare-terrain ocean cell. */
function clusterBboxOf(
  world: Pick<WorldState, 'oceanCells'>,
  cellKey: string,
): { minX: number; minY: number; maxX: number; maxY: number; cells: string[] } | null {
  const parsed = parseCellKey(cellKey);
  if (!parsed) return null;
  const cell = world.oceanCells.get(cellKey);
  if (!cell || !RARE_TERRAINS.has(cell.terrain)) return null;
  const wanted = cell.terrain;
  const visited = new Set<string>([cellKey]);
  const stack: Array<readonly [number, number]> = [[parsed.x, parsed.y]];
  let minX = parsed.x;
  let maxX = parsed.x;
  let minY = parsed.y;
  let maxY = parsed.y;
  const cells: string[] = [];
  while (stack.length > 0) {
    const next = stack.pop()!;
    const [cx, cy] = next;
    cells.push(`${cx},${cy}`);
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
    const neighbours: ReadonlyArray<readonly [number, number]> = [
      [cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1],
    ];
    for (const n of neighbours) {
      const nk = `${n[0]},${n[1]}`;
      if (visited.has(nk)) continue;
      const nCell = world.oceanCells.get(nk);
      if (!nCell || nCell.terrain !== wanted) continue;
      visited.add(nk);
      stack.push(n);
    }
  }
  return { minX, minY, maxX, maxY, cells };
}

/** Count how many ocean platforms whose terrain-required slot footprint
 *  is 2×2 cells (the canonical rare-terrain extractor shape) currently
 *  occupy the cluster. A 2×2 platform's footprint covers 4 cluster cells;
 *  we deduplicate by building id so it counts once.
 *
 *  Capacity is `floor(W/2) * floor(H/2)` — the maximum non-overlapping
 *  count of 2×2 platforms that can fit in a W×H cluster. Matches the
 *  pin in the plan (2×2 cluster → capacity 1; 3×2 cluster → capacity 1;
 *  3×3 nodule_field → capacity 1).
 *
 *  `used` walks every populated island's ocean buildings and asks
 *  `findOceanBuildingAt` per cluster cell — first-match wins; the same
 *  building won't be counted twice because we collect into a Set keyed
 *  by id. */
function rareClusterOccupancy(
  world: Pick<WorldState, 'islands'>,
  cluster: { minX: number; minY: number; maxX: number; maxY: number; cells: string[] },
): { used: number; capacity: number; width: number; height: number } {
  const width = cluster.maxX - cluster.minX + 1;
  const height = cluster.maxY - cluster.minY + 1;
  const capacity = Math.floor(width / 2) * Math.floor(height / 2);
  const ids = new Set<string>();
  for (const k of cluster.cells) {
    const parsed = parseCellKey(k);
    if (!parsed) continue;
    // findOceanBuildingAt expects tile coords, not cell coords. The
    // building hit-test snaps to the nearest integer tile — using the
    // top-left tile of the cell (cell * CELL_SIZE_TILES) is safe.
    const tx = parsed.x * CELL_SIZE_TILES;
    const ty = parsed.y * CELL_SIZE_TILES;
    const hit = findOceanBuildingAt(world.islands, tx, ty);
    if (hit) ids.add(hit.building.id);
  }
  return { used: ids.size, capacity, width, height };
}

// ---------------------------------------------------------------------------
// Weather summary
// ---------------------------------------------------------------------------

/** Format a millisecond duration as "~Nh" / "~NNm" / "~Ns". Used in the
 *  forecast line. Negative or zero falls through as "now". */
function formatDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `~${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `~${m}m`;
  const h = Math.round(m / 60);
  return `~${h}h`;
}

/** Build the weather summary for a cell. Always returned (per the spec:
 *  "Weather (universal, both ocean and land)"). The forecast line uses
 *  the next-state change inside the §2.6 lookahead window. */
function weatherInfoForCell(
  world: Pick<WorldState, 'seed' | 'islands'>,
  cellX: number,
  cellY: number,
  nowMs: number,
): WeatherInfo {
  const biome = biomeForCell(world, cellX, cellY);
  const cur = weather(world.seed, cellX, cellY, nowMs, biome);
  const stateLabel = WEATHER_STATE_LABEL[cur.state];
  // Next cycle: query just after `untilMs` to see what state follows.
  let forecastText: string | null = null;
  const remainingMs = cur.untilMs - nowMs;
  if (remainingMs > 0 && remainingMs <= WEATHER_FORECAST_LOOKAHEAD_MS) {
    const next = weather(world.seed, cellX, cellY, cur.untilMs + 1, biome);
    if (next.state !== cur.state) {
      forecastText = `→ ${WEATHER_STATE_LABEL[next.state]} in ${formatDuration(remainingMs)}`;
    } else {
      forecastText = `→ ${WEATHER_STATE_LABEL[next.state]} continues`;
    }
  }
  return { state: stateLabel, forecastText };
}

// ---------------------------------------------------------------------------
// Land helpers
// ---------------------------------------------------------------------------

/** Find the populated island whose union footprint covers the centre tile
 *  of `(cellX, cellY)`. Cell center tile is `(cellX * CELL_SIZE_TILES +
 *  CELL_SIZE_TILES/2, ...)` — close to the visual centre, so the hover
 *  reads the same island the cursor sits on. */
function islandAtCell(
  world: Pick<WorldState, 'islands'>,
  cellX: number,
  cellY: number,
): IslandSpec | null {
  const tx = cellX * CELL_SIZE_TILES + Math.floor(CELL_SIZE_TILES / 2);
  const ty = cellY * CELL_SIZE_TILES + Math.floor(CELL_SIZE_TILES / 2);
  return findPopulatedIslandAt(tx, ty, world.islands as IslandSpec[]);
}

function buildingOneLiner(b: { defId: string }): string {
  const def = BUILDING_DEFS[b.defId as BuildingDefId];
  if (!def) return b.defId;
  return `${def.displayName} T${def.tier}`;
}

// ---------------------------------------------------------------------------
// Pure helper — `cellInfoForHover`
// ---------------------------------------------------------------------------

/** Structural slice of `WorldState` that `cellInfoForHover` reads. Kept
 *  narrow so the helper is trivial to fixture in unit tests. */
type HoverWorld = Pick<
  WorldState,
  'seed' | 'islands' | 'oceanCells' | 'revealedCells' | 'depthRevealedCells'
>;

export function cellInfoForHover(
  world: HoverWorld,
  cellKey: string,
  nowMs: number,
): HoverInfo {
  const parsed = parseCellKey(cellKey);
  const weatherInfo = parsed ? weatherInfoForCell(world, parsed.x, parsed.y, nowMs) : null;

  // ---- Land path: a populated island covers the cell centre tile.
  if (parsed) {
    const isl = islandAtCell(world, parsed.x, parsed.y);
    if (isl) {
      // Pick the tile under the cursor's cell centre for the terrain readout.
      // Pure code can't know the cursor's exact sub-cell position, so we use
      // the cell centre as the canonical representative. The DOM caller may
      // pass a sub-cell key in the future if needed.
      const localTx = parsed.x * CELL_SIZE_TILES + Math.floor(CELL_SIZE_TILES / 2) - isl.cx;
      const localTy = parsed.y * CELL_SIZE_TILES + Math.floor(CELL_SIZE_TILES / 2) - isl.cy;
      const terrainFn = isl.terrainAt;
      const terrainText = terrainFn ? terrainFn(Math.round(localTx), Math.round(localTy)) : '';
      const b = buildingAtTile(isl, localTx, localTy);
      return {
        kind: 'land',
        text: terrainText,
        building: b ? buildingOneLiner(b) : null,
        weather: weatherInfo,
      };
    }
  }

  // ---- Ocean path: route by reveal tiers.
  const isRevealed = world.revealedCells.has(cellKey);
  if (!isRevealed) {
    return { kind: 'ocean-unrevealed', text: 'Open ocean', weather: weatherInfo };
  }
  const isDepth = world.depthRevealedCells.has(cellKey);
  if (!isDepth) {
    return { kind: 'ocean-undepthed', text: 'Unscouted depths', weather: weatherInfo };
  }
  // Depth-revealed: terrain readable. Bulk cells just show the label;
  // rare cells walk the cluster.
  const terrain = terrainAt(world, parsed?.x ?? 0, parsed?.y ?? 0);
  if (!RARE_TERRAINS.has(terrain)) {
    return {
      kind: 'ocean-revealed',
      terrain: terrain as 'shallows' | 'deep',
      text: OCEAN_TERRAIN_LABEL[terrain],
      weather: weatherInfo,
    };
  }
  // Rare-feature path: cluster bbox + occupancy. Any cell in the cluster
  // surfaces the same info — bbox is reconstructed by flood-fill rather
  // than cached, so per-hover work stays bounded by the cluster size
  // (vents/nodules ≤9 cells, trenches ≤24 per §3).
  const bbox = clusterBboxOf(world, cellKey);
  if (!bbox) {
    // Defensive: shouldn't happen if `RARE_TERRAINS.has(terrain)` was true
    // and the cell is in oceanCells, but fall back gracefully.
    return {
      kind: 'ocean-revealed',
      terrain: 'deep',
      text: OCEAN_TERRAIN_LABEL[terrain],
      weather: weatherInfo,
    };
  }
  const occ = rareClusterOccupancy(world, bbox);
  return {
    kind: 'ocean-rare',
    terrain: terrain as 'trench' | 'hydrothermal_vent' | 'nodule_field',
    terrainLabel: OCEAN_TERRAIN_LABEL[terrain],
    clusterSize: { width: occ.width, height: occ.height },
    occupancy: { used: occ.used, capacity: occ.capacity },
    weather: weatherInfo,
  };
}

// ---------------------------------------------------------------------------
// DOM renderer
// ---------------------------------------------------------------------------

export interface HoverTooltipHandle {
  /** Show / update the tooltip at the cursor position with the cell info
   *  derived from the current world state. Pass `cellKey === null` to
   *  hide. The caller is responsible for cursor coords (CSS pixels). */
  setHover(
    world: HoverWorld,
    cellKey: string | null,
    screenX: number,
    screenY: number,
    nowMs: number,
  ): void;
  /** Force hide. */
  hide(): void;
  /** Remove the tooltip element from the DOM (test cleanup). */
  destroy(): void;
}

/** Format a `HoverInfo` to inline HTML for the tooltip body. Each section
 *  is a single line; the weather line appears last. */
function renderInfoHtml(info: HoverInfo): string {
  const lines: string[] = [];
  switch (info.kind) {
    case 'ocean-rare': {
      const { used, capacity } = info.occupancy;
      const { width, height } = info.clusterSize;
      const free = Math.max(0, capacity - used);
      lines.push(
        `<div class="ri-hover-title">${escapeHtml(info.terrainLabel)}</div>`,
        `<div class="ri-hover-sub">${width}×${height} cluster — ${free}/${capacity} building slot${capacity === 1 ? '' : 's'} free</div>`,
      );
      break;
    }
    case 'ocean-revealed':
      lines.push(`<div class="ri-hover-title">${escapeHtml(info.text)}</div>`);
      break;
    case 'ocean-undepthed':
    case 'ocean-unrevealed':
      lines.push(`<div class="ri-hover-title">${escapeHtml(info.text)}</div>`);
      break;
    case 'land': {
      if (info.text) lines.push(`<div class="ri-hover-title">${escapeHtml(info.text)}</div>`);
      if (info.building) lines.push(`<div class="ri-hover-sub">${escapeHtml(info.building)}</div>`);
      break;
    }
    default: {
      // Exhaustive: every `HoverInfo.kind` must be handled above. Adding a
      // 6th kind without updating this switch will fail the `: never` cast
      // at compile time.
      const _exhaustive: never = info;
      void _exhaustive;
      return '';
    }
  }
  if (info.weather) {
    lines.push(`<div class="ri-hover-weather">${escapeHtml(info.weather.state)}</div>`);
    if (info.weather.forecastText) {
      lines.push(`<div class="ri-hover-forecast">${escapeHtml(info.weather.forecastText)}</div>`);
    }
  }
  return lines.join('');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function mountHoverTooltip(parentEl: HTMLElement): HoverTooltipHandle {
  const tip = document.createElement('div');
  tip.id = 'ri-hover-tooltip';
  tip.style.cssText = [
    'position: fixed',
    'pointer-events: none',
    // z-index below the modal scrim (ui.css `.ri-modal-scrim` is z-index: 60),
    // so opening inventory / construction / cargo-label / anchor-picker hides
    // the hover tooltip naturally instead of letting it ghost over the modal.
    'z-index: 50',
    'background: var(--ri-panel-solid, rgba(8, 14, 22, 0.96))',
    'border: 1px solid var(--ri-border-strong, rgba(125, 211, 232, 0.35))',
    'color: var(--ri-fg-1, #d8e6f0)',
    'padding: 6px 8px',
    'font-size: 11px',
    'font-family: var(--ri-mono, ui-monospace, monospace)',
    'letter-spacing: 0.04em',
    'max-width: 260px',
    'line-height: 1.4',
    'box-shadow: 0 2px 8px rgba(0,0,0,0.4)',
    'display: none',
    'border-radius: 2px',
  ].join(';');
  // Lightweight inline style hooks for the three line types.
  const style = document.createElement('style');
  style.textContent = `
    #ri-hover-tooltip .ri-hover-title { color: var(--ri-accent, #7dd3e8); font-weight: 600; margin-bottom: 2px; }
    #ri-hover-tooltip .ri-hover-sub { color: var(--ri-fg-2, #b6c8d8); font-size: 10.5px; margin-bottom: 2px; }
    #ri-hover-tooltip .ri-hover-weather { color: var(--ri-fg-3, #94aabc); font-size: 10.5px; margin-top: 4px; }
    #ri-hover-tooltip .ri-hover-forecast { color: var(--ri-fg-3, #7da0b8); font-size: 10px; }
  `;
  parentEl.appendChild(style);
  parentEl.appendChild(tip);

  let lastKey: string | null = null;
  let lastHtml = '';
  // Single-entry per-second cache. `cellInfoForHover` does a flood-fill plus
  // 2× `weather()` samples per call — on a held cursor at 60 fps that's ~72k
  // ops/sec for the same cell. Keying on (cellKey, floor(nowMs/1000)) means
  // cache misses on cell change AND on second boundary, so weather forecasts
  // still tick. Single entry is fine — cursor sits over one cell at a time.
  let cachedKey: string | null = null;
  let cachedSecond = -1;
  let cachedInfo: HoverInfo | null = null;

  function setHover(
    world: HoverWorld,
    cellKey: string | null,
    screenX: number,
    screenY: number,
    nowMs: number,
  ): void {
    if (cellKey === null) {
      hide();
      return;
    }
    const second = Math.floor(nowMs / 1000);
    let info: HoverInfo;
    if (cachedKey === cellKey && cachedSecond === second && cachedInfo !== null) {
      info = cachedInfo;
    } else {
      info = cellInfoForHover(world, cellKey, nowMs);
      cachedKey = cellKey;
      cachedSecond = second;
      cachedInfo = info;
    }
    // Re-render only on cell-change OR weather-change. The cell key is
    // a cheap identity; weather state moves slowly. We rebuild HTML when
    // the cell key changes or every call (HTML diff is cheap); position
    // is updated on every call regardless.
    if (cellKey !== lastKey) {
      lastKey = cellKey;
      lastHtml = renderInfoHtml(info);
      tip.innerHTML = lastHtml;
    } else {
      // Same cell — refresh content (weather + occupancy may shift). Cheap.
      const html = renderInfoHtml(info);
      if (html !== lastHtml) {
        lastHtml = html;
        tip.innerHTML = html;
      }
    }
    // Offset so the cursor doesn't sit on top of the tooltip. The +60 on Y
    // stacks this tooltip BELOW the existing terrain-tooltip (in
    // `terrain-tooltip.ts`, which anchors at `(cursor+14, cursor+14)` with
    // ~50 px of body height) so the two surfaces — terrain consumers vs.
    // terrain + building + weather — don't overlap on land cells. A future
    // pass should merge them into one panel.
    tip.style.left = `${screenX + 14}px`;
    tip.style.top = `${screenY + 14 + 60}px`;
    tip.style.display = '';
  }

  function hide(): void {
    if (tip.style.display !== 'none') {
      tip.style.display = 'none';
      lastKey = null;
      lastHtml = '';
      cachedKey = null;
      cachedSecond = -1;
      cachedInfo = null;
    }
  }

  function destroy(): void {
    if (tip.parentElement) tip.parentElement.removeChild(tip);
    if (style.parentElement) style.parentElement.removeChild(style);
  }

  return { setHover, hide, destroy };
}
