import type { TradeRuntime, TradeOffer } from './trade.js';
import type { IslandState } from './economy.js';

export interface TradeUiHandle {
  readonly el: HTMLDivElement;
  update(rt: TradeRuntime, activeIslandId: string, islandStates: ReadonlyMap<string, IslandState>, nowMs: number): void;
}

export function mountTradeUi(onAccept: (offer: TradeOffer) => void): TradeUiHandle {
  const el = document.createElement('div');
  el.className = 'ri-trade-ui';
  el.style.cssText = 'position:fixed;left:12px;top:12px;z-index:40;font:13px system-ui;color:#e8e6df;max-width:280px;';
  document.body.appendChild(el);

  function update(rt: TradeRuntime, activeIslandId: string, _islandStates: ReadonlyMap<string, IslandState>, nowMs: number): void {
    const here = rt.offers.find((o) => o.islandId === activeIslandId);
    const elsewhere = rt.offers.filter((o) => o.islandId !== activeIslandId).length;
    if (!here && elsewhere === 0) { el.style.display = 'none'; return; }
    el.style.display = 'block';

    const parts: string[] = [];
    if (here) {
      const secs = Math.max(0, Math.ceil((here.expiresAt - nowMs) / 1000));
      parts.push(
        '<div style="background:#252420;border:1.5px solid #3a3833;border-radius:10px;padding:12px 14px;margin-bottom:8px;">' +
          '<div style="color:#8f8d82;font:11px ui-monospace;text-transform:uppercase;letter-spacing:.06em;">Trade offer · ' + secs + 's</div>' +
          '<div style="margin:6px 0;">Give <b>' + here.give.qty.toFixed(0) + ' ' + here.give.res + '</b> → Get <b style="color:#8FA56E;">' + here.get.qty.toFixed(0) + ' ' + here.get.res + '</b></div>' +
          '<button data-accept="' + here.id + '" style="font:11px ui-monospace;background:#D97757;color:#1B1A17;border:none;border-radius:7px;padding:7px 14px;cursor:pointer;font-weight:700;">ACCEPT</button>' +
        '</div>',
      );
    }
    if (elsewhere > 0) {
      parts.push('<div style="color:#8f8d82;font-size:12px;">' + elsewhere + ' offer' + (elsewhere === 1 ? '' : 's') + ' waiting elsewhere</div>');
    }
    el.innerHTML = parts.join('');

    const btn = el.querySelector<HTMLButtonElement>('button[data-accept]');
    if (btn && here) btn.onclick = () => onAccept(here);
  }

  return { el, update };
}
