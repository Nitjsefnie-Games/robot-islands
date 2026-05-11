// Settings UI — pure helpers tested without DOM (the project's test runner
// doesn't use jsdom, so the visible-only DOM glue of mountSettingsUi stays
// covered by integration smoke; the rebind logic is the load-bearing piece
// and lives in a pure helper that's directly unit-testable).

import { describe, expect, it } from 'vitest';

import {
  bind,
  defineAction,
  installDefaultBindings,
  makeRegistry,
} from './input.js';
import {
  actionRows,
  applyCapturedKey,
  resetBindingsToDefaults,
} from './settings-ui.js';

const NOOP = (): void => undefined;

describe('applyCapturedKey', () => {
  it('binds a code that was previously unbound, no confirm needed', () => {
    const reg = makeRegistry();
    defineAction(reg, 'toggle-grid', NOOP);
    let confirmCalls = 0;
    const result = applyCapturedKey(reg, 'KeyG', 'toggle-grid', () => {
      confirmCalls += 1;
      return true;
    });
    expect(result.applied).toBe(true);
    expect(result.displacedAction).toBeNull();
    expect(confirmCalls).toBe(0);
    expect(reg.bindings.get('KeyG')).toBe('toggle-grid');
  });

  it('rebinds idempotently when the code already points at the same action', () => {
    const reg = makeRegistry();
    defineAction(reg, 'pan-up', NOOP);
    bind(reg, 'KeyW', 'pan-up');
    let confirmCalls = 0;
    const result = applyCapturedKey(reg, 'KeyW', 'pan-up', () => {
      confirmCalls += 1;
      return true;
    });
    expect(result.applied).toBe(true);
    expect(result.displacedAction).toBeNull();
    expect(confirmCalls).toBe(0); // no conflict, no prompt
    expect(reg.bindings.get('KeyW')).toBe('pan-up');
  });

  it('prompts on conflict and overrides when confirm returns true', () => {
    const reg = makeRegistry();
    defineAction(reg, 'pan-up', NOOP);
    defineAction(reg, 'toggle-grid', NOOP);
    bind(reg, 'KeyG', 'toggle-grid');
    let promptedWith: string | null = null;
    const result = applyCapturedKey(reg, 'KeyG', 'pan-up', (msg) => {
      promptedWith = msg;
      return true;
    });
    expect(promptedWith).toContain('toggle-grid');
    expect(result.applied).toBe(true);
    expect(result.displacedAction).toBe('toggle-grid');
    expect(reg.bindings.get('KeyG')).toBe('pan-up');
  });

  it('leaves the registry untouched when confirm returns false', () => {
    const reg = makeRegistry();
    defineAction(reg, 'pan-up', NOOP);
    defineAction(reg, 'toggle-grid', NOOP);
    bind(reg, 'KeyG', 'toggle-grid');
    const result = applyCapturedKey(reg, 'KeyG', 'pan-up', () => false);
    expect(result.applied).toBe(false);
    expect(result.displacedAction).toBe('toggle-grid');
    // The prior binding is preserved.
    expect(reg.bindings.get('KeyG')).toBe('toggle-grid');
  });
});

describe('resetBindingsToDefaults', () => {
  it('restores the default key set even after mutations', () => {
    const reg = makeRegistry();
    installDefaultBindings(reg);
    // Snapshot the defaults so we can compare after a round trip.
    const beforeKeyG = reg.bindings.get('KeyG');
    const beforeKeyS = reg.bindings.get('KeyS');
    expect(beforeKeyG).toBe('toggle-grid');
    expect(beforeKeyS).toBe('toggle-settings');
    // Mutate: drop a binding, swap another.
    reg.bindings.delete('KeyG');
    reg.bindings.set('KeyS', 'pan-up');
    expect(reg.bindings.get('KeyG')).toBeUndefined();
    expect(reg.bindings.get('KeyS')).toBe('pan-up');
    // Reset.
    resetBindingsToDefaults(reg);
    expect(reg.bindings.get('KeyG')).toBe('toggle-grid');
    expect(reg.bindings.get('KeyS')).toBe('toggle-settings');
  });

  it('clears any bindings not present in defaults', () => {
    const reg = makeRegistry();
    installDefaultBindings(reg);
    // Add a custom binding.
    reg.bindings.set('F12', 'made-up-action');
    expect(reg.bindings.get('F12')).toBe('made-up-action');
    resetBindingsToDefaults(reg);
    expect(reg.bindings.get('F12')).toBeUndefined();
  });
});

describe('actionRows', () => {
  it('returns one row per action with all keys joined and sorted', () => {
    const reg = makeRegistry();
    defineAction(reg, 'pan-up', NOOP);
    defineAction(reg, 'toggle-grid', NOOP);
    bind(reg, 'KeyW', 'pan-up');
    bind(reg, 'ArrowUp', 'pan-up');
    bind(reg, 'KeyG', 'toggle-grid');
    const rows = actionRows(reg);
    expect(rows.length).toBe(2);
    // Alphabetical by action name.
    expect(rows[0]!.action).toBe('pan-up');
    expect(rows[0]!.codes).toEqual(['ArrowUp', 'KeyW']);
    expect(rows[1]!.action).toBe('toggle-grid');
    expect(rows[1]!.codes).toEqual(['KeyG']);
  });

  it('includes registered actions even when they have no binding', () => {
    const reg = makeRegistry();
    defineAction(reg, 'unbound-action', NOOP);
    const rows = actionRows(reg);
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe('unbound-action');
    expect(rows[0]!.codes).toEqual([]);
  });

  it('represents the default binding set for at least the core actions', () => {
    const reg = makeRegistry();
    // Define each action that installDefaultBindings binds to, so
    // actionRows surfaces them all even though main.ts adds the handlers.
    for (const a of [
      'pan-up',
      'pan-down',
      'pan-left',
      'pan-right',
      'toggle-grid',
      'center-home',
      'toggle-skill-tree',
      'toggle-buildings',
      'dismiss-modal',
      'toggle-drones',
      'toggle-routes',
      'toggle-construction',
      'rotate-placement',
      'toggle-settlement',
      'toggle-inventory',
      'toggle-settings',
      'zoom-in',
      'zoom-out',
    ]) {
      defineAction(reg, a, NOOP);
    }
    installDefaultBindings(reg);
    const rows = actionRows(reg);
    const byName = new Map(rows.map((r) => [r.action, r.codes]));
    expect(byName.get('toggle-settings')).toEqual(['KeyS']);
    expect(byName.get('pan-up')?.slice().sort()).toEqual(['ArrowUp', 'KeyW']);
    expect(byName.get('toggle-grid')).toEqual(['KeyG']);
  });
});
