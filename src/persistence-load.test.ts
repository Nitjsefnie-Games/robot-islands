import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorld, STORAGE_KEY, SCHEMA_VERSION, serializeWorld } from './persistence.js';
import { makeInitialWorld, makeInitialIslandState } from './world.js';

const store = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: (key: string) => Promise.resolve(store.get(key)),
  set: (key: string, value: unknown) => {
    store.set(key, value);
    return Promise.resolve();
  },
  del: (key: string) => {
    store.delete(key);
    return Promise.resolve();
  },
}));

describe('loadWorld IDB walker', () => {
  beforeEach(() => {
    store.clear();
  });

  it('migrates v7 → v8, writes to current key, and deletes old key', async () => {
    // Build a minimal v7 snapshot.
    const nowMs = Date.now();
    const world = makeInitialWorld(nowMs);
    const islandState = makeInitialIslandState(world.islands[0]!, nowMs);
    const v7 = {
      v: 7,
      savedAt: Date.now(),
      savedAtPerf: performance.now(),
      world: {
        islands: world.islands,
        drones: [],
        routes: [],
        vehicles: [],
        satellites: [],
        repairDrones: [],
        debrisFields: [],
        commPackets: [],
      },
      islandStates: [
        {
          id: islandState.id,
          state: {
            id: islandState.id,
            buildings: islandState.buildings,
            inventory: islandState.inventory,
            storageCaps: islandState.storageCaps,
            funnelPending: islandState.funnelPending,
            starterInventoryGrace: {},
            xp: islandState.xp,
            level: islandState.level,
            unspentSkillPoints: islandState.unspentSkillPoints,
            unlockedNodes: [...islandState.unlockedNodes],
            subPathProgress: [],
            specializationRole: null,
            declaredAt: null,
            lastResetAt: null,
            lastTick: islandState.lastTick,
            aiCoreCrafted: false,
            ascendantCoreCrafted: false,
            timeLockBankedMin: 0,
            accelerationQueue: [],
            accelerationRemainingMin: 0,
            bankingEnabled: false,
            genesisTarget: null,
            singularityStoredWs: 0,
          },
        },
      ],
    };

    const v7Key = 'robot-islands:save:v7';
    store.set(v7Key, v7);

    const result = await loadWorld();
    expect(result).not.toBeNull();
    expect(result!.world).toBeDefined();
    expect(result!.islandStates.has(islandState.id)).toBe(true);

    expect(store.has(STORAGE_KEY)).toBe(true);
    const migrated = store.get(STORAGE_KEY) as { v: number };
    expect(migrated.v).toBe(23);

    expect(store.has(v7Key)).toBe(false);
  });

  it('returns null when no save exists in any version', async () => {
    const result = await loadWorld();
    expect(result).toBeNull();
  });

  it('loads a current-version snapshot stored at the v=SCHEMA_VERSION key and re-homes it to STORAGE_KEY', async () => {
    const nowMs = Date.now();
    const world = makeInitialWorld(nowMs);
    const islandState = makeInitialIslandState(world.islands[0]!, nowMs);
    const snapshot = serializeWorld(
      world,
      new Map([[islandState.id, islandState]]),
      nowMs,
      performance.now(),
    );
    const schemaVersionKey = `robot-islands:save:v${SCHEMA_VERSION}`;
    store.set(schemaVersionKey, snapshot);
    // Ensure the primary key is empty so the fallback walker is exercised.
    expect(store.has(STORAGE_KEY)).toBe(false);

    const result = await loadWorld();
    expect(result).not.toBeNull();
    expect(result!.world).toBeDefined();
    expect(result!.islandStates.has(islandState.id)).toBe(true);

    // Migrate-write-back: the snapshot should now live at STORAGE_KEY.
    expect(store.has(STORAGE_KEY)).toBe(true);
    const migrated = store.get(STORAGE_KEY) as { v: number };
    expect(migrated.v).toBe(SCHEMA_VERSION);

    // The old key should have been deleted.
    expect(store.has(schemaVersionKey)).toBe(false);
  });
});
