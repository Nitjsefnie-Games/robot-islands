// Lightweight toast surface — top-center transient banners with a colour
// hint for success / failure / info. Used by the §14 launch flow so a
// launch result reads at a glance without keeping the orbital modal open.
// One DOM container, stacked toasts; each auto-removes after a fade-out at
// a configurable lifetime (default 4s).

export type ToastKind = 'success' | 'failure' | 'info';

const KIND_COLORS: Readonly<Record<ToastKind, { bg: string; border: string; fg: string }>> = {
  success: {
    bg: 'rgba(20, 60, 40, 0.92)',
    border: '#60d0a0',
    fg: '#c4f0d8',
  },
  failure: {
    bg: 'rgba(70, 18, 18, 0.92)',
    border: '#e6504c',
    fg: '#f8d0c8',
  },
  info: {
    bg: 'rgba(18, 32, 48, 0.92)',
    border: '#7dd3e8',
    fg: '#d8e6f0',
  },
};

const DEFAULT_LIFETIME_MS = 4_000;

export interface ToastHandle {
  /** Show a new toast. Multiple toasts stack vertically. */
  show(message: string, kind?: ToastKind, lifetimeMs?: number): void;
}

let singleton: ToastHandle | null = null;

/** Mount the toast surface once. Subsequent calls reuse the singleton.
 *  Top-center fixed position; pointer-events: none so it never blocks
 *  the player's clicks underneath. */
export function mountToastSurface(parentEl: HTMLElement = document.body): ToastHandle {
  if (singleton) return singleton;
  const stack = document.createElement('div');
  stack.id = 'ri-toast-stack';
  stack.style.cssText = [
    'position: fixed',
    'top: 12px',
    'left: 50%',
    'transform: translateX(-50%)',
    'display: flex',
    'flex-direction: column',
    'gap: 6px',
    'z-index: 2000',
    'pointer-events: none',
    'max-width: 480px',
    'align-items: center',
  ].join(';');
  parentEl.appendChild(stack);

  function show(message: string, kind: ToastKind = 'info', lifetimeMs = DEFAULT_LIFETIME_MS): void {
    const colors = KIND_COLORS[kind];
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText = [
      `background: ${colors.bg}`,
      `border: 1px solid ${colors.border}`,
      `color: ${colors.fg}`,
      'padding: 8px 14px',
      'border-radius: 3px',
      'font-family: var(--ri-mono, ui-monospace, monospace)',
      'font-size: 12px',
      'letter-spacing: 0.04em',
      'box-shadow: 0 2px 12px rgba(0,0,0,0.4)',
      'transition: opacity 250ms ease-out',
      'opacity: 1',
      'max-width: 100%',
      'text-align: center',
    ].join(';');
    stack.appendChild(el);
    window.setTimeout(() => {
      el.style.opacity = '0';
      window.setTimeout(() => {
        if (el.parentElement === stack) stack.removeChild(el);
      }, 260);
    }, lifetimeMs);
  }

  singleton = { show };
  return singleton;
}

/** Get the current toast handle without mounting (returns null if the
 *  surface hasn't been mounted yet). Convenience for callers that don't
 *  want to pass the handle down a dep chain. */
export function getToastHandle(): ToastHandle | null {
  return singleton;
}
