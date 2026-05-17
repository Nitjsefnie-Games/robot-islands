// Hover-tooltip for terrain cells on populated islands. Surfaces the
// terrain id (e.g. `copper_vein`) plus the list of consumer buildings
// that have it in `requiredTile`. Pure-data lookup — no economy, no sim
// — driven by the main-canvas mousemove handler.
//
// The tooltip is a single DOM element positioned absolutely. Hidden by
// default; `setHover(...)` shows it and updates content; `hide()` clears.

import {
  BUILDING_DEFS,
  type BuildingDef,
  type BuildingDefId,
} from './building-defs.js';
import { shapeHeight, shapeWidth } from './shape-mask.js';
import type { TerrainKind } from './island.js';

interface ConsumerSummary {
  readonly defId: BuildingDefId;
  readonly displayName: string;
  readonly w: number;
  readonly h: number;
}

/** Precomputed terrain → consumers index. Built once per module load by
 *  walking `BUILDING_DEFS`. Terrains absent from this map have no consumer
 *  (or only buildings that don't gate on `requiredTile`); the tooltip
 *  still surfaces the terrain id but omits the consumer line. */
const CONSUMERS_BY_TERRAIN: Map<TerrainKind, ConsumerSummary[]> = (() => {
  const out = new Map<TerrainKind, ConsumerSummary[]>();
  for (const [id, defRaw] of Object.entries(BUILDING_DEFS)) {
    const def = defRaw as BuildingDef;
    if (!def.requiredTile || def.requiredTile.length === 0) continue;
    const summary: ConsumerSummary = {
      defId: id as BuildingDefId,
      displayName: def.displayName,
      w: shapeWidth(def.footprint),
      h: shapeHeight(def.footprint),
    };
    for (const t of def.requiredTile) {
      const arr = out.get(t) ?? [];
      arr.push(summary);
      out.set(t, arr);
    }
  }
  return out;
})();

/** Terrains that read as "background" — not worth a tooltip even if some
 *  building consumes them (e.g. grass is the default for Plains, not a
 *  meaningful spawn). Keeps the tooltip from flashing on every cell of
 *  every island. */
const BACKGROUND_TERRAINS: ReadonlySet<TerrainKind> = new Set<TerrainKind>([
  'grass',
]);

export interface TerrainTooltipHandle {
  /** Show / update the tooltip at the cursor position with the given
   *  terrain id. No-op if the terrain is "background" or unknown. */
  setHover(screenX: number, screenY: number, terrain: TerrainKind): void;
  /** Hide the tooltip. */
  hide(): void;
}

export function mountTerrainTooltip(parentEl: HTMLElement): TerrainTooltipHandle {
  const tip = document.createElement('div');
  tip.id = 'ri-terrain-tooltip';
  tip.style.cssText = [
    'position: fixed',
    'pointer-events: none',
    'z-index: 1000',
    'background: var(--ri-panel-solid, rgba(8, 14, 22, 0.95))',
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
  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'color: var(--ri-accent, #7dd3e8); font-weight: 600; margin-bottom: 2px';
  const consumersEl = document.createElement('div');
  consumersEl.style.cssText = 'color: var(--ri-fg-3, #94aabc); font-size: 10.5px';
  tip.appendChild(titleEl);
  tip.appendChild(consumersEl);
  parentEl.appendChild(tip);

  let lastTerrain: TerrainKind | null = null;

  function setHover(screenX: number, screenY: number, terrain: TerrainKind): void {
    if (BACKGROUND_TERRAINS.has(terrain)) {
      hide();
      return;
    }
    if (lastTerrain !== terrain) {
      lastTerrain = terrain;
      titleEl.textContent = terrain;
      const consumers = CONSUMERS_BY_TERRAIN.get(terrain);
      if (consumers && consumers.length > 0) {
        consumersEl.textContent =
          'needs: ' +
          consumers
            .map((c) => `${c.displayName} (${c.w}×${c.h})`)
            .join(', ');
        consumersEl.style.display = '';
      } else {
        consumersEl.style.display = 'none';
      }
    }
    tip.style.display = '';
    // Offset so the cursor doesn't sit on top of the tooltip. Anchor
    // bottom-left of the tooltip near the cursor's top-right.
    tip.style.left = `${screenX + 14}px`;
    tip.style.top = `${screenY + 14}px`;
  }

  function hide(): void {
    if (tip.style.display !== 'none') {
      tip.style.display = 'none';
      lastTerrain = null;
    }
  }

  return { setHover, hide };
}
