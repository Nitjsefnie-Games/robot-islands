// §13.4 victory banner.
//
// DOM-only render — mirrors tutorial-ui's pattern. Pure layer (`endgame.ts`)
// stays renderer-agnostic; this file owns the visual.

import type { EndgameState, VictoryCondition } from './endgame.js';

const CONDITION_LABEL: Record<VictoryCondition, string> = {
  genesis_cell_crafted: 'Genesis Cell forged',
  omniscient_lattice_active: 'Omniscient Lattice online',
  ascendant_core_crafted: 'Ascendant Core ignited',
};

const ORDER: VictoryCondition[] = [
  'genesis_cell_crafted',
  'omniscient_lattice_active',
  'ascendant_core_crafted',
];

export function renderEndgameBanner(state: EndgameState): HTMLElement | null {
  if (state.achieved.size === 0) return null;
  const banner = document.createElement('div');
  banner.id = 'endgame-banner';
  banner.style.cssText = `
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--ri-elev);
    border: 1px solid #e6b800;
    box-shadow: 0 0 0 1px rgba(230, 184, 0, 0.25), 0 4px 14px rgba(0, 0, 0, 0.6);
    padding: 10px 18px;
    border-radius: 4px;
    color: var(--ri-fg-1);
    font-family: ui-monospace, monospace;
    font-size: 13px;
    z-index: 250;
    display: flex;
    flex-direction: column;
    gap: 4px;
    text-align: center;
    min-width: 260px;
  `;
  const title = document.createElement('strong');
  title.textContent = 'VICTORY';
  title.style.cssText = 'color: #e6b800; letter-spacing: 0.18em; font-size: 12px;';
  banner.appendChild(title);
  for (const cond of ORDER) {
    if (!state.achieved.has(cond)) continue;
    const row = document.createElement('div');
    row.textContent = CONDITION_LABEL[cond];
    banner.appendChild(row);
  }
  if (ORDER.every((c) => state.achieved.has(c))) {
    const final = document.createElement('div');
    final.textContent = 'Transcendence complete.';
    final.style.cssText = 'margin-top: 4px; color: #e6b800; font-weight: 600;';
    banner.appendChild(final);
  }
  return banner;
}

/** Stable membership key — same `achieved` set yields the same string so the
 *  ticker can skip DOM work when nothing changed. */
export function endgameMembershipKey(state: EndgameState): string {
  return ORDER.filter((c) => state.achieved.has(c)).join(',');
}
