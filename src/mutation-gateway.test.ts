import { describe, expect, it } from 'vitest';

import { makeLocalGateway, makeRemoteGateway } from './mutation-gateway.js';
import { createNewGame } from './new-game.js';
import { makeInitialIslandState } from './world.js';
import type { Ack, GameServerClient } from './server-client.js';

/** Fake client whose `sendIntent` REJECTS — modelling the real reject sources
 *  in server-client.ts: intent timeout, socket-not-open, and socket-close-
 *  before-ack. The gateway must convert these to a resolved `{ ok: false }`
 *  so panel callsites' `if (!result.ok)` guards cover transport failures
 *  instead of producing an unhandled promise rejection. */
function rejectingClient(message: string): GameServerClient {
  return {
    sendIntent(): Promise<Ack> {
      return Promise.reject(new Error(message));
    },
    close(): void {
      /* no-op */
    },
  };
}

function nonErrorRejectingClient(value: unknown): GameServerClient {
  return {
    sendIntent(): Promise<Ack> {
      return Promise.reject(value);
    },
    close(): void {
      /* no-op */
    },
  };
}

function ackingClient(ack: Ack): GameServerClient {
  return {
    sendIntent(): Promise<Ack> {
      return Promise.resolve(ack);
    },
    close(): void {
      /* no-op */
    },
  };
}

describe('makeRemoteGateway — gateway-rejection contract', () => {
  it('converts a sendIntent rejection (Error) to a resolved { ok: false, error }', async () => {
    const gateway = makeRemoteGateway(rejectingClient('Intent 7 timed out'));
    const result = await gateway.demolishBuilding('home', 'b-1');
    expect(result).toEqual({ ok: false, error: 'Intent 7 timed out' });
  });

  it('never throws for any mutation method when the client rejects', async () => {
    const gateway = makeRemoteGateway(rejectingClient('Socket is not open'));
    // A representative spread of mutation methods — each returns a Promise in
    // REMOTE mode and must resolve (not reject) to the failure contract.
    const r1 = await gateway.placeBuilding('home', 'mine', 0, 0, 0);
    const r2 = await gateway.applyUpgrade('home', 'b-1');
    const r3 = await gateway.expandIsland('home', 'major');
    for (const r of [r1, r2, r3]) {
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ error: 'Socket is not open' });
    }
  });

  it('stringifies a non-Error rejection value', async () => {
    const gateway = makeRemoteGateway(nonErrorRejectingClient('socket closed'));
    const result = await gateway.demolishBuilding('home', 'b-1');
    expect(result).toEqual({ ok: false, error: 'socket closed' });
  });

  it('still surfaces a server-side { ok: false } ack as a failure result', async () => {
    const gateway = makeRemoteGateway(ackingClient({ seq: 1, ok: false, error: 'insufficient-resources' }));
    const result = await gateway.demolishBuilding('home', 'b-1');
    expect(result).toEqual({ ok: false, error: 'insufficient-resources' });
  });

  it('passes through a successful ack as { ok: true }', async () => {
    const gateway = makeRemoteGateway(ackingClient({ seq: 1, ok: true }));
    const result = await gateway.demolishBuilding('home', 'b-1');
    expect(result).toEqual({ ok: true });
  });
});

describe('makeLocalGateway — createRoute parity', () => {
  it('rejects an unpopulated endpoint (Fix 7)', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const colony = world.islands.find((s) => s.id !== 'home')!;
    colony.discovered = true;
    // colony stays unpopulated.
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings.push({
      id: 'dock-1', defId: 'dock', x: 0, y: 0,
      constructionRemainingMs: 0, placedAt: now,
    });
    islandStates.get('home')!.buildings = home.buildings;

    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.createRoute('home', colony.id, 'dock-1');
    expect(result).toEqual({ ok: false, error: 'island not populated' });
  });

  it('rejects an unknown filterResource id (Fix 6 LOCAL)', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const colony = world.islands.find((s) => s.id !== 'home')!;
    colony.populated = true;
    colony.discovered = true;
    islandStates.set(colony.id, makeInitialIslandState(colony, now));
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings.push({
      id: 'dock-1', defId: 'dock', x: 0, y: 0,
      constructionRemainingMs: 0, placedAt: now,
    });
    islandStates.get('home')!.buildings = home.buildings;

    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.createRoute('home', colony.id, 'dock-1', 'not_a_resource' as unknown as import('./recipes.js').ResourceId);
    expect(result).toEqual({ ok: false, error: 'unknown filterResource' });
  });
});
