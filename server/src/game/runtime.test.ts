// server/src/game/runtime.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from '../test-helpers.js';
import { createUser } from '../auth/users.js';
import { saveSnapshot, loadSnapshot } from './persistence.js';
import { loadAndCatchUp } from './runtime.js';
import { createInitialSnapshot } from './new-game.js';
import { SCHEMA_VERSION, type SaveSnapshot } from '../../../src/persistence.js';

const pool = testPool();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

let userSeq = 0;
async function aUser() { return (await createUser(pool, `r${userSeq++}@x.com`, 'h')).id; }

describe('runtime loadAndCatchUp', () => {
  it('returns deserialized state and persists an advanced snapshot', async () => {
    const uid = await aUser();
    // Save a snapshot stamped ~2 hours ago so there is an offline gap.
    const twoHoursAgo = Date.now() - 2 * 3600_000;
    const snap = createInitialSnapshot(twoHoursAgo);
    await saveSnapshot(pool, uid, snap);

    const result = await loadAndCatchUp(pool, uid, Date.now());
    expect(result).not.toBeNull();
    expect(result!.islandStates.get('home')).toBeDefined();

    // Persisted snapshot's savedAt advanced to ~now (catch-up was saved).
    const after = await loadSnapshot(pool, uid);
    expect(after!.savedAt).toBeGreaterThan(snap.savedAt);
  });

  // Offline catch-up must integrate with the FULL economy environment (the
  // shared `advanceWorldEconomy`), not the old ctx-less per-island loop. These
  // two tests pin the regression: a biome modifier and the active-play bonus
  // both change server-side production over an identical offline gap.
  //
  // Setup helper: a home island with a coal-fueled generator + an ore-tile mine
  // (extraction category — the modifiers that target it). Coal is over-stocked
  // and the ore/coal caps lifted so the mine runs steadily across the gap
  // instead of stalling on an empty fuel bin; only the economy environment
  // (modifiers / activeBonus) then differentiates the two runs.
  function homeWithMine(
    snap: SaveSnapshot,
    modifiers: readonly string[],
    activeBonusMs: number,
  ): SaveSnapshot {
    const s = JSON.parse(JSON.stringify(snap)) as SaveSnapshot & {
      world: { islands: Array<Record<string, unknown>>; activeBonusMs: number };
      islandStates: Array<{ id: string; state: Record<string, unknown> }>;
    };
    s.world.activeBonusMs = activeBonusMs;
    const home = s.world.islands.find((i) => i['id'] === 'home')!;
    home['modifiers'] = [...modifiers];
    // Spec.buildings is what deserialize re-links onto IslandState.buildings.
    // The ore tile at (-7, 2) is deterministic from the home terrain seed.
    home['buildings'] = [
      { id: 'gen', defId: 'coal_gen', x: 0, y: 0 },
      { id: 'm1', defId: 'mine', x: -7, y: 2 },
    ];
    const st = s.islandStates.find((e) => e.id === 'home')!.state as {
      inventory: Record<string, number>;
      storageCaps: Record<string, number>;
    };
    st.inventory['coal'] = 1e9;
    st.storageCaps['coal'] = 1e12;
    st.storageCaps['iron_ore'] = 1e12;
    return s as unknown as SaveSnapshot;
  }

  async function ironOreAfterGap(snap: SaveSnapshot): Promise<number> {
    const uid = await aUser();
    await saveSnapshot(pool, uid, snap);
    const game = await loadAndCatchUp(pool, uid, snap.savedAt + 3_600_000);
    return game!.islandStates.get('home')!.inventory.iron_ore;
  }

  it('applies biome modifiers during offline catch-up (fertile out-produces no-modifier)', async () => {
    const base = createInitialSnapshot(Date.now() - 3_600_000);
    const stableOre = await ironOreAfterGap(homeWithMine(base, ['stable'], 0));
    const fertileOre = await ironOreAfterGap(homeWithMine(base, ['fertile'], 0));
    // fertile = extraction × 1.50, so it must out-produce the no-modifier run.
    expect(fertileOre).toBeGreaterThan(stableOre);
  });

  it('applies the active-play bonus during offline catch-up (stored activeBonusMs raises output)', async () => {
    const base = createInitialSnapshot(Date.now() - 3_600_000);
    const noBonusOre = await ironOreAfterGap(homeWithMine(base, ['stable'], 0));
    // 36e6 ms == 600 focused minutes -> activeBonusMul = 1.60.
    const bonusOre = await ironOreAfterGap(homeWithMine(base, ['stable'], 36_000_000));
    expect(bonusOre).toBeGreaterThan(noBonusOre);
  });

  it('returns null when the account has no save', async () => {
    const uid = await aUser();
    expect(await loadAndCatchUp(pool, uid, Date.now())).toBeNull();
  });

  it('migrates an older-version snapshot on load and re-persists at the current version', async () => {
    const uid = await aUser();
    // Build a complete current snapshot, then DOWNGRADE it to v23 by removing the
    // single field v23->v24 added at the island-state level (buildJobs). A fresh
    // game has no disabled buildings, so the building-level part of that migration
    // is moot here. This yields a valid v23 input that deserializeWorld migrates.
    const current = createInitialSnapshot(0);
    const v23 = JSON.parse(JSON.stringify(current)) as SaveSnapshot & {
      islandStates: Array<{ id: string; state: Record<string, unknown> }>;
    };
    v23.v = 23 as SaveSnapshot['v'];
    for (const entry of v23.islandStates) delete entry.state.buildJobs;
    await saveSnapshot(pool, uid, v23 as unknown as SaveSnapshot);

    const game = await loadAndCatchUp(pool, uid, Date.now());
    expect(game).not.toBeNull();
    expect(game!.islandStates.get('home')).toBeDefined();

    // Re-persisted snapshot is now at the current schema version.
    const reloaded = await loadSnapshot(pool, uid);
    expect(reloaded!.v).toBe(SCHEMA_VERSION);
  });
});
