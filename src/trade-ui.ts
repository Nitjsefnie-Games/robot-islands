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

  // Build the offer card's DOM ONCE and keep references; update() only mutates
  // text and visibility. Rebuilding innerHTML each frame (the old design did so
  // every time the 1s countdown changed the content key) recreated the Accept/
  // Reject nodes, so a click straddling the rebuild was dropped — the bug. The
  // buttons bind once to a closure-held `currentOffer`, so they never need
  // re-creating or re-binding as terms/countdown change.
  let currentOffer: TradeOffer | null = null;

  const offerBlock = document.createElement('div');
  const offerHead = document.createElement('div');
  offerHead.classList.add('ri-sectionhead');
  const kv = document.createElement('div');
  kv.classList.add('ri-kv');
  kv.style.margin = '4px 0 8px';
  const giveSpan = document.createElement('span');
  giveSpan.classList.add('ri-kv__k');
  const giveB = document.createElement('b');
  giveB.classList.add('ri-mono');
  giveSpan.append('Give ', giveB);
  const arrowSpan = document.createElement('span');
  arrowSpan.classList.add('ri-kv__v', 'ri-mono');
  arrowSpan.style.color = 'var(--ri-accent)';
  arrowSpan.textContent = '→';
  const getSpan = document.createElement('span');
  getSpan.classList.add('ri-kv__v');
  const getB = document.createElement('b');
  getB.classList.add('ri-mono');
  getB.style.color = 'var(--ri-success)';
  getSpan.append('Get ', getB);
  kv.append(giveSpan, arrowSpan, getSpan);
  const acceptBtn = document.createElement('button');
  acceptBtn.classList.add('ri-accentbtn');
  acceptBtn.textContent = 'Accept';
  acceptBtn.onclick = () => { if (currentOffer) onAccept(currentOffer); };
  const rejectBtn = document.createElement('button');
  rejectBtn.classList.add('ri-btn');
  rejectBtn.style.marginLeft = '8px';
  rejectBtn.textContent = 'Reject';
  rejectBtn.onclick = () => { if (currentOffer) onReject(currentOffer); };
  offerBlock.append(offerHead, kv, acceptBtn, rejectBtn);

  const elsewhereLine = document.createElement('div');
  elsewhereLine.classList.add('ri-muted');
  elsewhereLine.style.marginTop = '8px';
  elsewhereLine.style.fontSize = '11px';

  body.append(offerBlock, elsewhereLine);

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
  // changes between most frames. Skip the text writes when the rendered content
  // is identical to last frame. The button NODES persist regardless. `''`
  // forces the first render after each (re)show. `lastStruct` tracks which
  // blocks are visible so a layout is requested only when that changes.
  let lastKey = '';
  let lastStruct = '';

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
    const key = `${here?.id ?? 'none'}:${secs}:${here?.give.qty ?? 0}:${here?.give.res ?? ''}:${here?.get.qty ?? 0}:${here?.get.res ?? ''}:${elsewhere}`;
    if (key === lastKey) return;
    lastKey = key;

    currentOffer = here ?? null;
    if (here) {
      offerBlock.style.display = '';
      offerHead.textContent = 'Offer · ' + secs + 's';
      giveB.textContent = here.give.qty.toFixed(0) + ' ' + here.give.res;
      getB.textContent = here.get.qty.toFixed(0) + ' ' + here.get.res;
    } else {
      offerBlock.style.display = 'none';
    }

    if (elsewhere > 0) {
      elsewhereLine.style.display = '';
      elsewhereLine.textContent = elsewhere + ' offer' + (elsewhere === 1 ? '' : 's') + ' waiting elsewhere';
    } else {
      elsewhereLine.style.display = 'none';
    }

    // Only the show/hide of whole blocks changes panel height; request a layout
    // pass when that structure flips, not on every countdown tick.
    const struct = `${here ? 1 : 0}:${elsewhere > 0 ? 1 : 0}`;
    if (struct !== lastStruct) {
      lastStruct = struct;
      panel.requestLayout();
    }
  }

  return { el, update };
}
