// Offline catch-up accept/reject modal (§9.9 / Appendix C). On a fresh REMOTE
// WS connect with an offline gap, the server pushes the PRE-gap snapshot then
// an `offline-pending` frame and BLOCKS normal intents until the client sends
// an `offline/accept` or `offline/reject` intent. This modal forces that
// choice.
//
// NON-DISMISSIBLE BY DESIGN: the server will not accept any normal play intent
// until the offline gap is resolved, so there is no valid "dismiss without
// choosing" state — letting Escape / scrim / × close the modal would just hide
// the only UI that can unblock play. `mountModal` routes the ×-button and
// scrim-click through `onClose`, so wiring `onClose` to a no-op disables both;
// Escape is dispatched by main.ts's global `dismiss-modal` action which only
// hides the fixed set of game-panel modals (not this one), so Escape can't
// dismiss it either.
//
// Pure DOM — no PixiJS. Built on the shared `mountModal` shell; buttons use the
// `.ri-btn` conventions (see sibling `*-ui.ts`).

import { mountModal, type ModalHandle } from './ui-modal.js';

/** Humanize a millisecond gap into a compact "Xd Yh", "Xh Ym", "Xm", or
 *  "Xs" string for the modal copy. */
function humanizeGap(gapMs: number): string {
  const totalSec = Math.max(0, Math.floor(gapMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const m = totalMin % 60;
    return m > 0 ? `${totalHr}h ${m}m` : `${totalHr}h`;
  }
  const totalDay = Math.floor(totalHr / 24);
  const h = totalHr % 24;
  return h > 0 ? `${totalDay}d ${h}h` : `${totalDay}d`;
}

/** Mount the non-dismissible offline catch-up modal and show it immediately.
 *  `onAccept` is wired to "Accept offline progress" (server applies catch-up
 *  + decays the §9.9 active bonus 3×gap); `onReject` to "Keep active bonus"
 *  (server forfeits the catch-up, preserves the bonus). Both buttons disable
 *  on first click so a slow ack can't be double-sent. */
export function mountOfflineModal(
  parentEl: HTMLElement,
  gapMs: number,
  onAccept: () => void,
  onReject: () => void,
): ModalHandle {
  let acceptBtn: HTMLButtonElement | null = null;
  let rejectBtn: HTMLButtonElement | null = null;

  function lockButtons(): void {
    if (acceptBtn) acceptBtn.disabled = true;
    if (rejectBtn) rejectBtn.disabled = true;
  }

  const handle = mountModal(parentEl, {
    title: 'WHILE YOU WERE AWAY',
    subtitle: `/ ${humanizeGap(gapMs)}`,
    // Non-dismissible: see file header. The server blocks play until the
    // player chooses, so the × button and scrim-click (both routed here) do
    // nothing; Escape is not wired to this modal at all.
    onClose: () => undefined,
    buildBody(body) {
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.gap = '10px';

      const lead = document.createElement('p');
      lead.style.margin = '0';
      lead.textContent = `You were away for ${humanizeGap(gapMs)}.`;
      body.appendChild(lead);

      const tradeoff = document.createElement('p');
      tradeoff.style.margin = '0';
      tradeoff.textContent =
        'Accept the offline progress to bank that production and XP — but the ' +
        'active-play bonus burns down three times as fast for the time you were ' +
        'gone. Keep the bonus instead to forfeit the offline catch-up entirely.';
      body.appendChild(tradeoff);
    },
    buildFooter(footer) {
      rejectBtn = document.createElement('button');
      rejectBtn.className = 'ri-btn';
      rejectBtn.textContent = 'Keep active bonus';
      rejectBtn.addEventListener('click', () => {
        if (rejectBtn?.disabled) return;
        lockButtons();
        onReject();
      });

      acceptBtn = document.createElement('button');
      acceptBtn.className = 'ri-btn ri-btn--primary';
      acceptBtn.textContent = 'Accept offline progress';
      acceptBtn.addEventListener('click', () => {
        if (acceptBtn?.disabled) return;
        lockButtons();
        onAccept();
      });

      footer.appendChild(rejectBtn);
      footer.appendChild(acceptBtn);
    },
  });

  handle.show();
  return handle;
}
