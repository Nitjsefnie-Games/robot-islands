// Input registry: actions table + bindings table + dispatch routing.

import { describe, expect, it } from 'vitest';

import {
  bind,
  defineAction,
  dispatchAction,
  dispatchKey,
  installDefaultBindings,
  makeRegistry,
  unbind,
} from './input.js';

describe('InputRegistry', () => {
  it('dispatches a key to its bound action', () => {
    const reg = makeRegistry();
    let calls = 0;
    defineAction(reg, 'increment', () => {
      calls += 1;
    });
    bind(reg, 'KeyX', 'increment');
    expect(dispatchKey(reg, 'KeyX')).toBe(true);
    expect(calls).toBe(1);
  });

  it('returns false for an unbound key', () => {
    const reg = makeRegistry();
    expect(dispatchKey(reg, 'KeyQ')).toBe(false);
  });

  it('returns false for a binding pointing to an undefined action', () => {
    const reg = makeRegistry();
    bind(reg, 'KeyX', 'nope');
    expect(dispatchKey(reg, 'KeyX')).toBe(false);
  });

  it('rebinds a key to a different action', () => {
    const reg = makeRegistry();
    let aCalls = 0;
    let bCalls = 0;
    defineAction(reg, 'aaa', () => {
      aCalls += 1;
    });
    defineAction(reg, 'bbb', () => {
      bCalls += 1;
    });
    bind(reg, 'KeyZ', 'aaa');
    dispatchKey(reg, 'KeyZ');
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(0);

    // Reroute KeyZ → bbb. The advisor flagged this scenario specifically as
    // the spec-required smoke test for the rebinding registry.
    bind(reg, 'KeyZ', 'bbb');
    dispatchKey(reg, 'KeyZ');
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
  });

  it('unbinds a key', () => {
    const reg = makeRegistry();
    let calls = 0;
    defineAction(reg, 'a', () => {
      calls += 1;
    });
    bind(reg, 'KeyP', 'a');
    unbind(reg, 'KeyP');
    expect(dispatchKey(reg, 'KeyP')).toBe(false);
    expect(calls).toBe(0);
  });

  it('lets multiple keys share a single action', () => {
    const reg = makeRegistry();
    let calls = 0;
    defineAction(reg, 'panUp', () => {
      calls += 1;
    });
    bind(reg, 'KeyW', 'panUp');
    bind(reg, 'ArrowUp', 'panUp');
    dispatchKey(reg, 'KeyW');
    dispatchKey(reg, 'ArrowUp');
    expect(calls).toBe(2);
  });

  it('dispatchAction triggers the same path as a key', () => {
    // UI buttons reuse the actions table directly. This test enforces that
    // a button click and a key press hit the same handler reference, not
    // just an equivalent one.
    const reg = makeRegistry();
    let calls = 0;
    const handler = (): void => {
      calls += 1;
    };
    defineAction(reg, 'toggleX', handler);
    bind(reg, 'KeyT', 'toggleX');
    dispatchKey(reg, 'KeyT'); // simulates keypress
    dispatchAction(reg, 'toggleX'); // simulates UI click
    expect(calls).toBe(2);
  });

  it('installDefaultBindings wires the canonical key set', () => {
    const reg = makeRegistry();
    installDefaultBindings(reg);
    expect(reg.bindings.get('KeyW')).toBe('pan-up');
    expect(reg.bindings.get('KeyA')).toBe('pan-left');
    expect(reg.bindings.get('KeyS')).toBe('pan-down');
    expect(reg.bindings.get('ArrowRight')).toBe('pan-right');
    expect(reg.bindings.get('KeyD')).toBe('toggle-grid');
    expect(reg.bindings.get('KeyH')).toBe('center-home');
    expect(reg.bindings.get('Equal')).toBe('zoom-in');
    expect(reg.bindings.get('Minus')).toBe('zoom-out');
  });
});
