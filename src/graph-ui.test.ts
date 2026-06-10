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

    // Collect created elements so we can find the close button later.
    const clickHandlers: Array<() => void> = [];
    const elPool: Array<{
      tagName?: string;
      type?: string;
      style: Record<string, string>;
      dataset: Record<string, string>;
      classList: { add: (c: string) => void; remove: (c: string) => void; contains: () => boolean };
      children: unknown[];
      appendChild(c: unknown): unknown;
      addEventListener(type: string, fn: unknown): void;
      setAttribute(): void;
      querySelector(): null;
      focus(): void;
      getBoundingClientRect(): { left: number; top: number; width: number; height: number };
      parentElement: null;
      textContent?: string;
    }> = [];

    function makeEl(tag?: string) {
      const e = {
        tagName: tag ?? 'DIV',
        style: {} as Record<string, string>,
        dataset: {} as Record<string, string>,
        classList: {
          add: (c: string) => { /* no-op */ },
          remove: (c: string) => { /* no-op */ },
          contains: () => false,
        },
        children: [] as unknown[],
        appendChild(c: unknown) {
          this.children.push(c);
          return c;
        },
        addEventListener(type: string, fn: () => void) {
          if (type === 'click') clickHandlers.push(fn);
        },
        setAttribute: () => {},
        querySelector: () => null,
        focus: () => {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
        parentElement: null,
      };
      elPool.push(e);
      return e;
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

      // Open the panel.
      expect(ui.toggle()).toBe(true);
      expect(ui.isVisible()).toBe(true);

      const ui2 = mountGraphUi(parent as unknown as HTMLElement);
      ui2.show();
      expect(ui2.isVisible()).toBe(true);

      // The close button handler is the last click handler registered
      // (mountGraphUi registers closeBtn after building the header).
      expect(clickHandlers.length).toBeGreaterThan(0);
      const closeHandler = clickHandlers[clickHandlers.length - 1]!;

      // Simulate the close button click.
      closeHandler();
      expect(ui2.isVisible()).toBe(false);

      // toggle() should now reopen on the FIRST press.
      expect(ui2.toggle()).toBe(true);
      expect(ui2.isVisible()).toBe(true);
    } finally {
      vi.stubGlobal('document', origDoc);
      vi.stubGlobal('ResizeObserver', origRO);
      vi.stubGlobal('window', origWindow);
    }
  });
});
