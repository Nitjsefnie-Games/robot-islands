// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountConstructionUi } from './construction-ui.js';
import { createNewGame } from './new-game.js';
import { type WorldState } from './world.js';
import type { IslandState } from './economy.js';
import type { MutationGateway } from './mutation-gateway.js';

function makeRemoteGateway(result: { ok: true } | { ok: false; error: string }): MutationGateway {
  return {
    constructIsland: vi.fn().mockResolvedValue(result),
  } as unknown as MutationGateway;
}

function makeWorld(): { world: WorldState; islandStates: Map<string, IslandState> } {
  const now = Date.now();
  const { world, islandStates } = createNewGame(now);
  const home = world.islands.find((s) => s.id === 'home')!;
  const state = islandStates.get('home')!;
  state.level = 15;
  state.inventory.steel_beam = 10000;
  state.inventory.concrete = 10000;
  home.buildings.push({
    id: 'pc-1',
    defId: 'platform_constructor',
    x: 0,
    y: 0,
    constructionRemainingMs: 0,
    placedAt: now,
  });
  state.buildings = home.buildings;
  return { world, islandStates };
}

describe('mountConstructionUi — REMOTE construct', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  it('#47: closes and resets the panel on a successful REMOTE construct', async () => {
    const { world, islandStates } = makeWorld();
    const gateway = makeRemoteGateway({ ok: true });
    const onConstruct = vi.fn();

    const ui = mountConstructionUi(container, {
      world,
      islandStates,
      gateway,
      onConstruct,
    });

    ui.show();
    expect(ui.isVisible()).toBe(true);

    // Fill in a custom name so we can verify it resets.
    const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    nameInput.value = 'Test Isle';
    nameInput.dispatchEvent(new Event('input'));

    // Pick a founder from the dropdown.
    const founderSelect = container.querySelector('select') as HTMLSelectElement;
    founderSelect.value = 'home';
    founderSelect.dispatchEvent(new Event('change'));

    // Pick a non-overlapping position.
    const numberInputs = container.querySelectorAll('input[type="number"]');
    const posXInput = numberInputs[0] as HTMLInputElement;
    const posYInput = numberInputs[1] as HTMLInputElement;
    posXInput.value = '200';
    posYInput.value = '200';
    posXInput.dispatchEvent(new Event('input'));
    posYInput.dispatchEvent(new Event('input'));

    // Click the Construct button.
    const constructBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === '▶ CONSTRUCT',
    )!;
    expect(constructBtn.disabled).toBe(false);
    constructBtn.click();

    // Wait for the async gateway call.
    await vi.waitFor(() => expect(gateway.constructIsland).toHaveBeenCalled());

    // REMOTE success must reset the UI and hide the panel without calling
    // onConstruct (the authoritative snapshot push will append the island).
    expect(ui.isVisible()).toBe(false);
    expect(nameInput.value).toBe('');
    expect(onConstruct).not.toHaveBeenCalled();
  });
});
