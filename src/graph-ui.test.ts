import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountGraphUi } from './graph-ui.js';

describe('graph-ui close button', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('close-via-button syncs visible so toggle() reopens on first press', () => {
    const origDoc = (globalThis as Record<string, unknown>).document;
    const origRO = (globalThis as Record<string, unknown>).ResizeObserver;
    const origWindow = (globalThis as Record<string, unknown>).window;

    // Track elements by aria-label so the close button can be located by a
    // stable signal rather than positional clickHandlers[length-1].
    const closeHandlersByAriaLabel = new Map<string, () => void>();

    function makeEl(tag?: string) {
      let ariaLabel = '';
      const clickListeners: Array<() => void> = [];
      return {
        tagName: tag ?? 'DIV',
        style: {} as Record<string, string>,
        dataset: {} as Record<string, string>,
        classList: {
          add: (_c: string) => { /* no-op */ },
          remove: (_c: string) => { /* no-op */ },
          contains: () => false,
        },
        children: [] as unknown[],
        appendChild(c: unknown) {
          this.children.push(c);
          return c;
        },
        addEventListener(type: string, fn: () => void) {
          if (type === 'click') {
            clickListeners.push(fn);
            if (ariaLabel) closeHandlersByAriaLabel.set(ariaLabel, fn);
          }
        },
        setAttribute(name: string, value: string) {
          if (name === 'aria-label') {
            ariaLabel = value;
            // Bind any click already registered before setAttribute was called.
            const last = clickListeners[clickListeners.length - 1];
            if (last) closeHandlersByAriaLabel.set(ariaLabel, last);
          }
        },
        querySelector: () => null,
        focus: () => {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
        parentElement: null,
      };
    }

    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => globalThis.setTimeout(fn, 0));
    vi.stubGlobal('HTMLElement', class HTMLElement {});
    vi.stubGlobal('window', {
      setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
      innerWidth: 1920,
      innerHeight: 1080,
      addEventListener: () => {},
      removeEventListener: () => {},
      requestAnimationFrame: (fn: () => void) => globalThis.setTimeout(fn, 0),
    });
    vi.stubGlobal('document', {
      createElement: (tag: string) => makeEl(tag),
      body: { appendChild: () => {} },
    });

    try {
      const parent = makeEl();
      const ui = mountGraphUi(parent as unknown as HTMLElement);
      ui.show();
      expect(ui.isVisible()).toBe(true);

      // Locate close button by the stable aria-label it sets.
      const closeHandler = closeHandlersByAriaLabel.get('Close recipe graph');
      expect(closeHandler).toBeDefined();

      // Simulate the close button click — must sync the `visible` flag.
      closeHandler!();
      expect(ui.isVisible()).toBe(false);

      // toggle() should now reopen on the FIRST press (not require two presses).
      expect(ui.toggle()).toBe(true);
      expect(ui.isVisible()).toBe(true);
    } finally {
      vi.stubGlobal('document', origDoc);
      vi.stubGlobal('ResizeObserver', origRO);
      vi.stubGlobal('window', origWindow);
    }
  });
});
