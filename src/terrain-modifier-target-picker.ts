// §03 terrain_modifier (v5 spec) — placement-time target-biome picker. Opened
// BEFORE the placement-ui arms the brush; the resolved TerrainKind threads
// into PlacedBuilding.terrainTarget on commit. Mirrors cargo-label-picker.ts:
// same modal chrome, promise-supersede pattern, and Escape/scrim cancel.

import {
  conversionCostForTarget,
  NATURAL_TARGET_TERRAINS,
  RARE_TARGET_TERRAINS,
} from './terrain-modifier.js';
import type { TerrainKind } from './island.js';
import type { ResourceId } from './recipes.js';
import { mountModal, type ModalHandle } from './ui-modal.js';

export interface TerrainTargetPickerHandle {
  /** Open the picker. Resolves with the player's TerrainKind pick or null on
   *  cancel. Mirrors CargoLabelPickerHandle.pick semantics: a previously-
   *  pending promise gets resolved as null before the fresh modal opens. */
  pick(): Promise<TerrainKind | null>;
}

const NATURAL_ORDER: TerrainKind[] = [
  'grass', 'sand', 'stone', 'water', 'tree', 'ice', 'magma_vent',
];

// Drift guard: every natural target must appear in NATURAL_ORDER so the picker
// doesn't silently omit a newly-added kind.
if (
  new Set(NATURAL_ORDER).size !== NATURAL_TARGET_TERRAINS.size ||
  ![...NATURAL_TARGET_TERRAINS].every((k) => NATURAL_ORDER.includes(k))
) {
  throw new Error(
    'terrain-modifier-target-picker: NATURAL_ORDER out of sync with NATURAL_TARGET_TERRAINS',
  );
}

function rareSortedList(): TerrainKind[] {
  return Array.from(RARE_TARGET_TERRAINS).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function formatBasket(basket: Partial<Record<ResourceId, number>>): string {
  const entries = Object.entries(basket).filter(([, n]) => (n ?? 0) > 0);
  if (entries.length === 0) {
    // Reserved for future free-target classifications; today every target has
    // a non-zero cost basket.
    return '(free)';
  }
  return entries.map(([r, n]) => `${n} ${r}`).join(' + ');
}

export function mountTerrainModifierTargetPicker(
  parentEl: HTMLElement,
): TerrainTargetPickerHandle {
  let pending: ((value: TerrainKind | null) => void) | null = null;
  let selected: TerrainKind = 'grass';

  function resolveWith(value: TerrainKind | null): void {
    if (pending) {
      pending(value);
      pending = null;
    }
    handle.hide();
  }

  function cancel(): void {
    resolveWith(null);
  }

  const buttonByKind = new Map<TerrainKind, HTMLButtonElement>();

  function repaintSelection(): void {
    for (const [kind, btn] of buttonByKind) {
      btn.dataset['active'] = kind === selected ? 'true' : 'false';
    }
  }

  function makeRow(kind: TerrainKind): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ri-chip';
    btn.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;' +
      'width:100%;margin:2px 0;';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = kind.toUpperCase();
    const costSpan = document.createElement('span');
    costSpan.textContent = formatBasket(conversionCostForTarget(kind));
    costSpan.style.color = NATURAL_TARGET_TERRAINS.has(kind)
      ? 'var(--ri-fg-3)'
      : 'var(--ri-clay)';
    btn.appendChild(nameSpan);
    btn.appendChild(costSpan);
    btn.addEventListener('click', () => resolveWith(kind));
    btn.addEventListener('mouseenter', () => {
      selected = kind;
      repaintSelection();
    });
    buttonByKind.set(kind, btn);
    return btn;
  }

  const handle: ModalHandle = mountModal(parentEl, {
    title: 'TERRAIN MODIFIER — pick target',
    onClose: cancel,
    buildBody(body): void {
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.gap = '14px';
      body.style.padding = '10px 12px';
      body.style.maxHeight = '60vh';
      body.style.overflow = 'auto';

      const natHead = document.createElement('div');
      natHead.textContent = 'NATURAL TARGETS';
      natHead.style.cssText = 'font-family:ui-monospace,monospace;font-size:11px;letter-spacing:0.06em;color:var(--ri-fg-3);';
      body.appendChild(natHead);
      for (const k of NATURAL_ORDER) body.appendChild(makeRow(k));

      const rareHead = document.createElement('div');
      rareHead.textContent = 'RARE VEINS — cost scales by K × rate × 90';
      rareHead.style.cssText = 'font-family:ui-monospace,monospace;font-size:11px;letter-spacing:0.06em;color:var(--ri-clay);margin-top:6px;';
      body.appendChild(rareHead);
      for (const k of rareSortedList()) body.appendChild(makeRow(k));

      repaintSelection();
    },
  });
  handle.hide();

  function onKeydown(e: KeyboardEvent): void {
    if (!handle.isVisible()) return;
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
    if (e.key === 'Enter') { e.preventDefault(); resolveWith(selected); return; }
  }
  document.addEventListener('keydown', onKeydown);

  return {
    pick(): Promise<TerrainKind | null> {
      if (pending) { pending(null); pending = null; }
      selected = 'grass';
      repaintSelection();
      return new Promise<TerrainKind | null>((resolve) => {
        pending = resolve;
        handle.show();
      });
    },
  };
}
