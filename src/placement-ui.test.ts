// Targeted unit test for the §4.6 placement-UI picker-cancel path.
//
// AGENTS.md says "tests target the pure layer only" and placement-ui.ts
// imports PixiJS for the preview-layer Container/Graphics/Text. Those are
// plain JS classes — they construct fine in node (WebGL is only needed at
// render time, and these tests never call `app.render`). The only purpose
// here is to assert the cancel-from-picker contract: when `pickCargoLabel`
// resolves null, `begin()` exits cleanly without arming placement and
// without ever invoking `placeBuilding` (so `spec.buildings` stays empty).
//
// If a future Pixi version moves browser-globals to module-init time this
// file should be the first casualty — drop it and rely on the placement.ts
// pure-layer tests for the rest of the §4.6 contract.

import { describe, expect, it } from 'vitest';

import { mountPlacementUi } from './placement-ui.js';
import { makeInitialIslandState } from './world.js';
import type { IslandSpec } from './world.js';
import type { IslandState } from './economy.js';

function makeSpec(): IslandSpec {
  return {
    id: 'test',
    name: 'test',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: [],
  };
}

function makeState(spec: IslandSpec): IslandState {
  const s = makeInitialIslandState(spec, 0);
  s.level = 5;
  s.inventory.stone = 10000;
  s.inventory.wood = 10000;
  return s;
}

describe('§4.6 placement-ui cancel-from-picker', () => {
  it('does not place a building when the picker resolves null', async () => {
    const spec = makeSpec();
    const state = makeState(spec);
    let placedCalled = 0;
    const ui = mountPlacementUi({
      getTargetSpec: () => spec,
      getTargetState: () => state,
      screenToWorldTile: (x, y) => ({ x, y }),
      onPlaced: () => {
        placedCalled++;
      },
      // Cancel: picker resolves null → placement must abort entirely.
      pickCargoLabel: () => Promise.resolve(null),
    });
    ui.begin('crate');
    // Flush microtasks so the picker promise resolves before assertions.
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.isActive()).toBe(false);
    expect(spec.buildings).toHaveLength(0);
    expect(placedCalled).toBe(0);
    // Even an explicit commit attempt after cancel must no-op (no active
    // session to commit, no building added).
    const r = ui.attemptCommit();
    expect(r.ok).toBe(false);
    expect(spec.buildings).toHaveLength(0);
  });

  it('arms placement and threads the chosen label through when the picker resolves a ResourceId', async () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const ui = mountPlacementUi({
      getTargetSpec: () => spec,
      getTargetState: () => state,
      // Identity transform — attemptCommit() reads cursorScreenX/Y (both 0
      // at construction) and runs screenToWorldTile(0,0) → tile (0,0),
      // which is the island center, inside r=14. We deliberately skip
      // setCursorScreenPos because that path triggers Pixi Text bounds
      // measurement (CanvasTextMetrics) and node-Pixi has no canvas.
      screenToWorldTile: (x, y) => ({ x, y }),
      onPlaced: () => {},
      pickCargoLabel: () => Promise.resolve('copper_ore'),
    });
    ui.begin('crate');
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.isActive()).toBe(true);
    const r = ui.attemptCommit();
    expect(r.ok).toBe(true);
    expect(spec.buildings).toHaveLength(1);
    expect(spec.buildings[0]!.cargoLabel).toBe('copper_ore');
  });

  it('bypasses the picker for non-generic-storage defs (Mine arms immediately)', async () => {
    const spec = makeSpec();
    const state = makeState(spec);
    let pickerInvoked = 0;
    const ui = mountPlacementUi({
      getTargetSpec: () => spec,
      getTargetState: () => state,
      screenToWorldTile: (x, y) => ({ x, y }),
      onPlaced: () => {},
      pickCargoLabel: () => {
        pickerInvoked++;
        return Promise.resolve(null);
      },
    });
    ui.begin('mine');
    // Non-generic defs arm synchronously — no await needed for isActive.
    expect(ui.isActive()).toBe(true);
    expect(pickerInvoked).toBe(0);
  });
});
