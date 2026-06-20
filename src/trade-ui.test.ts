// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { mountTradeUi } from './trade-ui.js';
import type { TradeRuntime, TradeOffer } from './trade.js';
import type { ResourceId } from './recipes.js';

function makeOffer(over: Partial<TradeOffer> = {}): TradeOffer {
  return {
    id: 'offer1',
    islandId: 'island1',
    give: { res: 'iron_ore' as ResourceId, qty: 10 },
    get: { res: 'copper_ore' as ResourceId, qty: 5 },
    spawnedAt: 0,
    expiresAt: 60_000,
    ...over,
  };
}

describe('mountTradeUi', () => {
  it('keeps the Accept/Reject button nodes as the countdown ticks', () => {
    // The card refreshes ~60fps and the 1s countdown changes its content key.
    // Rebuilding body.innerHTML each second recreates the buttons, so a click
    // straddling the rebuild (mousedown → rebuild → mouseup) is dropped. The
    // button nodes must persist across countdown ticks.
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const handle = mountTradeUi(onAccept, onReject);
    const rt: TradeRuntime = { offers: [makeOffer()] };

    handle.update(rt, 'island1', 0);
    const accept = handle.el.querySelector<HTMLButtonElement>('button.ri-accentbtn');
    const reject = handle.el.querySelector<HTMLButtonElement>('button.ri-btn');
    expect(accept).toBeTruthy();
    expect(reject).toBeTruthy();

    // Advance the countdown by one second — content changes, nodes must not.
    handle.update(rt, 'island1', 1000);
    expect(accept!.isConnected).toBe(true);
    expect(reject!.isConnected).toBe(true);
    expect(handle.el.querySelector('button.ri-accentbtn')).toBe(accept);
    expect(handle.el.querySelector('button.ri-btn')).toBe(reject);

    // And the persisted buttons still wire to the live offer.
    accept!.click();
    expect(onAccept).toHaveBeenCalledTimes(1);
    reject!.click();
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});
