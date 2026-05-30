// DOM action strip — a vertical column of icon buttons that mirrors the
// keyboard action registry. Mounts in the TR zone via the floating-panel
// manager so it can never overlap the HUD or the top-center island bar.
//
// Each `UiButtonSpec` dispatches its action through `dispatchAction` — the
// same path as keyboard input, so mouse and keyboard can't drift.

import { dispatchAction, type InputRegistry } from './input.js';
import { mountPanel, Zone } from './ui-zones.js';
import { icon, type IconId } from './ui-icons.js';

export interface UiButtonSpec {
  readonly icon: IconId;
  readonly action: string;
  readonly label: string;
  readonly kbd: string;
}

/** Mount a vertical icon strip in zone TR. Returns the panel element. */
export function mountUi(
  reg: InputRegistry,
  buttons: ReadonlyArray<UiButtonSpec>,
): HTMLDivElement {
  const strip = document.createElement('div');
  strip.classList.add('ri-actionstrip');

  for (const spec of buttons) {
    const b = document.createElement('button');
    b.classList.add('ri-iconbtn');
    b.setAttribute('title', `${spec.label} (${spec.kbd})`);
    b.setAttribute('aria-label', spec.label);
    b.dataset['kbd'] = spec.kbd;
    b.dataset['action'] = spec.action;
    b.appendChild(icon(spec.icon, 18));
    b.addEventListener('click', () => {
      dispatchAction(reg, spec.action);
      b.blur();
    });
    strip.appendChild(b);
  }
  mountPanel(strip, { id: 'action-strip', zone: Zone.TR, order: 0 });
  return strip;
}
