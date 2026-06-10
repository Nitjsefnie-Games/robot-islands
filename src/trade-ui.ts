// Trade offer card — house panel mounted in Zone.TL (below the build-queue
// panel, order 1 so they stack rather than overlap). Shows the active
// island's pending signal_exchange offer (give→get, countdown, ACCEPT) plus a
// "N waiting elsewhere" hint for offers on non-active islands.
//
// Styling tracks the theme via the .ri-panel chrome classes + CSS custom
// properties (var(--ri-*)) — no hardcoded hex, no raw z-index (mountPanel
// owns placement + z-index via the Z tokens in ui-tokens.ts).

import type { TradeRuntime, TradeOffer } from './trade.js';
import { mountPanel, Zone } from './ui-zones.js';

export interface TradeUiHandle {
  readonly el: HTMLDivElement;
  update(rt: TradeRuntime, activeIslandId: string, nowMs: number): void;
}

export function mountTradeUi(
  onAccept: (offer: TradeOffer) => void,
  onReject: (offer: TradeOffer) => void,
): TradeUiHandle {
  const el = document.createElement('div');
  el.classList.add('ri-panel');
  el.id = 'trade-offer-panel';

  const head = document.createElement('div');
  head.classList.add('ri-panel__head');
  const titleEl = document.createElement('span');
  titleEl.classList.add('ri-panel__title');
  titleEl.textContent = 'TRADE OFFER';
  head.appendChild(titleEl);
  el.appendChild(head);

  const body = document.createElement('div');
  body.classList.add('ri-panel__body');
  el.appendChild(body);

  const panel = mountPanel(el, {
    id: 'trade-offer-panel',
    zone: Zone.TL,
    // Build-queue panel mounts at Zone.TL order 0; order 1 stacks the trade
    // card directly below it (the zone manager offsets by prev height + gap).
    order: 1,
    minWidth: 220,
    maxWidth: 320,
  });

  // Content-key early-out: update() runs ~60fps but only the 1s countdown
  // changes between most frames. Skip the innerHTML rebuild + onclick rebind
  // when the rendered content is identical to last frame. `''` forces the
  // first render after each (re)show.
  let lastKey = '';

  function update(rt: TradeRuntime, activeIslandId: string, nowMs: number): void {
    const here = rt.offers.find((o) => o.islandId === activeIslandId);
    const elsewhere = rt.offers.filter((o) => o.islandId !== activeIslandId).length;
    if (!here && elsewhere === 0) {
      if (el.style.display !== 'none') {
        el.style.display = 'none';
        panel.requestLayout();
      }
      lastKey = '';
      return;
    }
    if (el.style.display === 'none') {
      el.style.display = '';
      panel.requestLayout();
    }

    const secs = here ? Math.max(0, Math.ceil((here.expiresAt - nowMs) / 1000)) : 0;
    const key = `${here?.id ?? 'none'}:${secs}:${elsewhere}`;
    if (key === lastKey) return;
    lastKey = key;

    const parts: string[] = [];
    if (here) {
      parts.push(
        '<div class="ri-sectionhead">Offer · ' + secs + 's</div>' +
          '<div class="ri-kv" style="margin:4px 0 8px;">' +
            '<span class="ri-kv__k">Give <b class="ri-mono">' + here.give.qty.toFixed(0) + ' ' + here.give.res + '</b></span>' +
            '<span class="ri-kv__v ri-mono" style="color:var(--ri-accent);">→</span>' +
            '<span class="ri-kv__v">Get <b class="ri-mono" style="color:var(--ri-success);">' + here.get.qty.toFixed(0) + ' ' + here.get.res + '</b></span>' +
          '</div>' +
          '<button class="ri-accentbtn" data-accept="' + here.id + '">Accept</button>' +
          '<button class="ri-btn" data-reject="' + here.id + '" style="margin-left:8px;">Reject</button>',
      );
    }
    if (elsewhere > 0) {
      parts.push('<div class="ri-muted" style="margin-top:8px;font-size:11px;">' + elsewhere + ' offer' + (elsewhere === 1 ? '' : 's') + ' waiting elsewhere</div>');
    }
    body.innerHTML = parts.join('');

    const acceptBtn = body.querySelector<HTMLButtonElement>('button[data-accept]');
    if (acceptBtn && here) acceptBtn.onclick = () => onAccept(here);
    const rejectBtn = body.querySelector<HTMLButtonElement>('button[data-reject]');
    if (rejectBtn && here) rejectBtn.onclick = () => onReject(here);
  }

  return { el, update };
}
