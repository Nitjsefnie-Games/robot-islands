import { describe, expect, it } from 'vitest';

import { makeLocalGateway, makeRemoteGateway, unwrapGatewayResult } from './mutation-gateway.js';
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

  it('#52: surfaces a server-side { ok: false } ack with the machine-readable reason', async () => {
    const gateway = makeRemoteGateway(ackingClient({ seq: 1, ok: false, error: 'insufficient-resources' }));
    const result = await gateway.demolishBuilding('home', 'b-1');
    expect(result).toEqual({ ok: false, error: 'insufficient-resources', reason: 'insufficient-resources' });
  });

  it('passes through a successful ack as { ok: true }', async () => {
    const gateway = makeRemoteGateway(ackingClient({ seq: 1, ok: true }));
    const result = await gateway.demolishBuilding('home', 'b-1');
    expect(result).toEqual({ ok: true });
  });
});

function makeTwoPopulatedIslands() {
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
  return { now, world, islandStates, home, colony };
}

function makeDrainingRoute() {
  const { now, world, islandStates, colony } = makeTwoPopulatedIslands();
  const gateway = makeLocalGateway(world, islandStates);
  const create = unwrapGatewayResult(gateway.createRoute('home', colony.id, 'dock-1', 'wood'));
  expect(create.ok).toBe(true);
  const route = world.routes[0]!;
  route.inFlight.push({
    resourceId: 'wood',
    amount: 1,
    arrivalTime: now + 60_000,
    dispatchTime: now,
    id: 'batch-1',
  });
  const drain = unwrapGatewayResult(gateway.deleteRoute(route.id));
  expect(drain.ok).toBe(true);
  expect(route.draining).toBe(true);
  return { now, world, islandStates, gateway, route };
}

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
    const { world, islandStates, colony } = makeTwoPopulatedIslands();
    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.createRoute('home', colony.id, 'dock-1', 'not_a_resource' as unknown as import('./recipes.js').ResourceId);
    expect(result).toEqual({ ok: false, error: 'unknown filterResource' });
  });

  it('rejects from===to', () => {
    const { world, islandStates } = makeTwoPopulatedIslands();
    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.createRoute('home', 'home', 'dock-1');
    expect(result).toEqual({ ok: false, error: 'from and to must differ' });
  });

  it('rejects a teleporter route when destination has no teleporter pad', () => {
    const { now, world, islandStates, colony } = makeTwoPopulatedIslands();
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings = [{
      id: 'tp-1', defId: 'teleporter_pad', x: 0, y: 0,
      constructionRemainingMs: 0, placedAt: now,
    }];
    islandStates.get('home')!.buildings = home.buildings;
    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.createRoute('home', colony.id, 'tp-1');
    expect(result).toEqual({ ok: false, error: 'destination has no teleporter pad' });
  });

  it('rejects a non-transport building', () => {
    const { now, world, islandStates, colony } = makeTwoPopulatedIslands();
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings = [{
      id: 'mine-1', defId: 'mine', x: 0, y: 0,
      constructionRemainingMs: 0, placedAt: now,
    }];
    islandStates.get('home')!.buildings = home.buildings;
    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.createRoute('home', colony.id, 'mine-1');
    expect(result).toEqual({ ok: false, error: 'building is not a transport building' });
  });
});


describe('makeLocalGateway — rename / edit-biome / construct-island parity', () => {
  it('renames an island', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.renameIsland('home', 'Renamed');
    expect(result).toEqual({ ok: true });
    expect(world.islands.find((s) => s.id === 'home')!.name).toBe('Renamed');
  });

  it('rejects an invalid rename', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const gateway = makeLocalGateway(world, islandStates);
    const result = unwrapGatewayResult(gateway.renameIsland('home', ''));
    expect(result.ok).toBe(false);
  });

  it('rejects edit-biome for same biome', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const home = world.islands.find((s) => s.id === 'home')!;
    const state = islandStates.get('home')!;
    state.level = 30;
    home.buildings.push({
      id: 'ue-1', defId: 'universe_editor', x: 0, y: 0,
      constructionRemainingMs: 0, placedAt: now,
    });
    state.buildings = home.buildings;
    state.inventory.reality_anchor = 10;
    state.inventory.memetic_core = 10;
    state.inventory.phase_converter = 10;
    const gateway = makeLocalGateway(world, islandStates);
    const result = unwrapGatewayResult(gateway.editBiome('home', 'plains'));
    expect(result.ok).toBe(false);
  });

  it('constructs an artificial island locally', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const home = world.islands.find((s) => s.id === 'home')!;
    const state = islandStates.get('home')!;
    state.level = 15;
    home.buildings.push({
      id: 'pc-1', defId: 'platform_constructor', x: 0, y: 0,
      constructionRemainingMs: 0, placedAt: now,
    });
    state.buildings = home.buildings;
    state.inventory.steel_beam = 10000;
    state.inventory.concrete = 10000;
    const gateway = makeLocalGateway(world, islandStates);
    const result = unwrapGatewayResult(
      gateway.constructIsland({
        founderIslandId: 'home',
        biome: 'plains',
        majorRadius: 4,
        minorRadius: 4,
        cx: 100,
        cy: 100,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value!.newSpec.id).toBe('art-1');
    expect(result.value!.newSpec.biome).toBe('plains');
  });
});

describe('makeLocalGateway — validation parity with server intents', () => {
  it('#46 expandIsland rejects when axis is already at max', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const home = world.islands.find((s) => s.id === 'home')!;
    home.majorRadius = 28;
    home.minorRadius = 28;
    home.buildings.push({
      id: 'hub-1', defId: 'land_reclamation_hub', x: 0, y: 0,
      constructionRemainingMs: 0, placedAt: now,
    });
    islandStates.get('home')!.buildings = home.buildings;
    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.expandIsland('home', 'major');
    expect(result).toEqual({ ok: false, error: 'axis-at-max', reason: 'axis-at-max' });
  });

  it('#49 dispatchDrone rejects an out-of-range selectedTier', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.dispatchDrone('home', 0, 0, 1, 0, 10, now, undefined, 99 as unknown as import('./drones.js').DroneTier);
    expect(result).toEqual({ ok: false, error: 'selectedTier must be an integer 1..6' });
  });

  it('#66 draining route rejects setRouteMode, setCargoWeight, setCargoFloorPct, reorderRouteCargo, setRouteCargo', () => {
    const { gateway, route } = makeDrainingRoute();
    expect(gateway.setRouteMode(route.id, 'balanced')).toEqual({ ok: false, error: 'route is draining' });
    expect(gateway.setCargoWeight(route.id, 0, 2)).toEqual({ ok: false, error: 'route is draining' });
    expect(gateway.setCargoFloorPct(route.id, 0, 50)).toEqual({ ok: false, error: 'route is draining' });
    expect(gateway.reorderRouteCargo(route.id, 0, 0)).toEqual({ ok: false, error: 'route is draining' });
    expect(gateway.setRouteCargo(route.id, [{ resourceId: 'wood' }])).toEqual({ ok: false, error: 'route is draining' });
  });

  it('#68 relabelCargo rejects an invalid resource label', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings.push({
      id: 'crate-1', defId: 'crate', x: 0, y: 0,
      constructionRemainingMs: 0, placedAt: now,
    });
    islandStates.get('home')!.buildings = home.buildings;
    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.relabelCargo('home', 'crate-1', 'not-a-resource' as unknown as import('./recipes.js').ResourceId);
    expect(result).toEqual({ ok: false, error: 'newLabel must be a valid resource id' });
  });

  it('#69 setBuildingActiveFloors rejects out-of-range disabledFloors', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings.push({
      id: 'ws-1', defId: 'workshop', x: 0, y: 0,
      constructionRemainingMs: 0, placedAt: now,
    });
    islandStates.get('home')!.buildings = home.buildings;
    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.setBuildingActiveFloors('home', 'ws-1', 5);
    expect(result).toEqual({ ok: false, error: 'disabledFloors out of range' });
  });

  it('#70 setRouteCargo rejects duplicate resources', () => {
    const { gateway, route } = makeDrainingRoute();
    route.draining = false; // unset draining so validation reaches cargo list
    const result = gateway.setRouteCargo(route.id, [
      { resourceId: 'wood' },
      { resourceId: 'wood' },
    ]);
    expect(result).toEqual({ ok: false, error: 'duplicate cargo resourceId wood' });
  });

  it('#71 placeBuilding rejects an invalid cargoLabel', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.placeBuilding('home', 'crate', 0, 0, 0, {
      cargoLabel: 'not-a-resource' as unknown as import('./recipes.js').ResourceId,
    });
    expect(result).toEqual({ ok: false, error: 'cargoLabel must be a valid resource id' });
  });

  it('#72 dispatchSettler rejects fractional foundationKitCount and does not throw', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const home = world.islands.find((s) => s.id === 'home')!;
    const colony = world.islands.find((s) => s.id !== 'home')!;
    colony.discovered = true;
    colony.populated = false;
    home.buildings.push({
      id: 'sy-1', defId: 'shipyard', x: 0, y: 0,
      constructionRemainingMs: 0, placedAt: now,
    });
    const state = islandStates.get('home')!;
    state.buildings = home.buildings;
    state.inventory.biofuel = 200;
    state.inventory.foundation_kit = 10;
    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.dispatchSettler('home', colony.id, 'ship', 1, 200, 1.5, now);
    expect(result).toEqual({ ok: false, error: 'foundationKitCount must be a positive integer' });
  });

  it('#72 dispatchSettler rejects an out-of-range tier and does not throw', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const home = world.islands.find((s) => s.id === 'home')!;
    const colony = world.islands.find((s) => s.id !== 'home')!;
    colony.discovered = true;
    colony.populated = false;
    home.buildings.push({
      id: 'sy-1', defId: 'shipyard', x: 0, y: 0,
      constructionRemainingMs: 0, placedAt: now,
    });
    const state = islandStates.get('home')!;
    state.buildings = home.buildings;
    state.inventory.biofuel = 200;
    state.inventory.foundation_kit = 10;
    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.dispatchSettler('home', colony.id, 'ship', 5 as unknown as import('./settlement.js').VehicleTier, 200, 1, now);
    expect(result).toEqual({ ok: false, error: 'tier must be 1..4' });
  });

  it('#89 setCargoWeight rejects non-positive / non-finite weight', () => {
    const { gateway, route } = makeDrainingRoute();
    route.draining = false;
    expect(gateway.setCargoWeight(route.id, 0, 0)).toEqual({ ok: false, error: 'weight must be positive' });
    expect(gateway.setCargoWeight(route.id, 0, Number.NaN)).toEqual({ ok: false, error: 'weight must be positive' });
  });

  it('#111 setCargoFloorPct rejects out-of-range sourceFloorPct and draining routes', () => {
    const { gateway, route } = makeDrainingRoute();
    route.draining = false;
    expect(gateway.setCargoFloorPct(route.id, 0, 101)).toEqual({ ok: false, error: 'sourceFloorPct must be 0..100' });
    expect(gateway.setCargoFloorPct(route.id, 0, Number.NaN)).toEqual({ ok: false, error: 'sourceFloorPct must be 0..100' });
    route.draining = true;
    expect(gateway.setCargoFloorPct(route.id, 0, 50)).toEqual({ ok: false, error: 'route is draining' });
  });

  it('#135 dispatchDrone rejects when the island has no operational Drone Pad', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    // Home starts building-less (§3.7); give it fuel so the ONLY failure is the
    // missing Drone Pad gate the server enforces (intents.ts: dispatch-drone).
    islandStates.get('home')!.inventory.biofuel = 50;
    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.dispatchDrone('home', 0, 0, 1, 0, 10, now);
    expect(result).toEqual({ ok: false, error: 'no-operational-dronepad' });
  });

  it('#138 convertToServitor rejects when the island has no operational Reality Forge', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const home = world.islands.find((s) => s.id === 'home')!;
    home.buildings.push({
      id: 'ws-1', defId: 'workshop', x: 0, y: 0,
      constructionRemainingMs: 0, placedAt: now,
    });
    islandStates.get('home')!.buildings = home.buildings;
    const gateway = makeLocalGateway(world, islandStates);
    const result = gateway.convertToServitor('home', 'ws-1');
    expect(result).toEqual({ ok: false, error: 'requires an operational Reality Forge' });
  });

  it('#138 acceptTrade rejects an expired offer', () => {
    const now = Date.now();
    const { world, islandStates } = createNewGame(now);
    const gateway = makeLocalGateway(world, islandStates);
    const offer = {
      id: 'offer-1', islandId: 'home',
      give: { res: 'wood' as const, qty: 1 },
      get: { res: 'stone' as const, qty: 1 },
      spawnedAt: now - 10_000,
      expiresAt: now - 1,
    };
    const result = gateway.acceptTrade(offer);
    expect(result).toEqual({ ok: false, error: 'offer expired' });
  });

  it('#138 setBuildingActiveFloors drains routes owned by a building dropped to 0 active floors', () => {
    const { world, islandStates, colony } = makeTwoPopulatedIslands();
    const gateway = makeLocalGateway(world, islandStates);
    const create = unwrapGatewayResult(gateway.createRoute('home', colony.id, 'dock-1', 'wood'));
    expect(create.ok).toBe(true);
    const route = world.routes[0]!;
    expect(route.sourceBuildingId).toBe('dock-1');
    expect(route.draining).not.toBe(true);
    // dock-1 has floorLevel 0 → 1 displayed floor → activeFloors 1; disabling
    // that one floor drops active floors to 0, which must drain its routes
    // (server intents.ts: set-active-floors).
    expect(gateway.setBuildingActiveFloors('home', 'dock-1', 1)).toEqual({ ok: true });
    expect(route.draining).toBe(true);
  });
});

describe('makeRemoteGateway — rename / edit-biome / construct-island forwarding', () => {
  it('forwards rename-island', async () => {
    let captured: { type: string; payload: unknown } | null = null;
    const client: GameServerClient = {
      sendIntent(type: string, payload: unknown) {
        captured = { type, payload };
        return Promise.resolve({ seq: 1, ok: true });
      },
      close() {},
    };
    const gateway = makeRemoteGateway(client);
    await gateway.renameIsland('home', 'x');
    expect(captured).toEqual({ type: 'rename-island', payload: { islandId: 'home', name: 'x' } });
  });
});

function makeT5CargoRoute() {
  const { world, islandStates, home, colony } = makeTwoPopulatedIslands();
  islandStates.get('home')!.level = 50; // tier 5
  const gateway = makeLocalGateway(world, islandStates);
  const create = unwrapGatewayResult(gateway.createRoute('home', colony.id, 'dock-1', 'wood'));
  expect(create.ok).toBe(true);
  const route = world.routes[0]!;
  return { world, islandStates, gateway, route, home, colony };
}

describe('makeLocalGateway — setRouteWaypoints', () => {
  it('sets waypoints on a T5 cargo route', () => {
    const { gateway, route } = makeT5CargoRoute();
    const result = gateway.setRouteWaypoints(route.id, [{ x: 10, y: 20 }]);
    expect(result).toEqual({ ok: true });
    expect(route.waypoints).toEqual([{ x: 10, y: 20 }]);
  });

  it('unbends a route with an empty waypoint list', () => {
    const { gateway, route } = makeT5CargoRoute();
    unwrapGatewayResult(gateway.setRouteWaypoints(route.id, [{ x: 10, y: 20 }]));
    const result = gateway.setRouteWaypoints(route.id, []);
    expect(result).toEqual({ ok: true });
    expect(route.waypoints).toBeUndefined();
  });

  it('rejects a non-T5 source island', () => {
    const { world, islandStates, colony } = makeTwoPopulatedIslands();
    const gateway = makeLocalGateway(world, islandStates);
    const create = unwrapGatewayResult(gateway.createRoute('home', colony.id, 'dock-1', 'wood'));
    expect(create.ok).toBe(true);
    const route = world.routes[0]!;
    const result = gateway.setRouteWaypoints(route.id, [{ x: 10, y: 20 }]);
    expect(result).toEqual({ ok: false, error: 'source island not T5' });
  });

  it('rejects >4 waypoints', () => {
    const { gateway, route } = makeT5CargoRoute();
    const result = gateway.setRouteWaypoints(route.id, [
      { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }, { x: 5, y: 5 },
    ]);
    expect(result).toEqual({ ok: false, error: 'at most 4 bend points' });
  });
});

describe('makeRemoteGateway — setRouteWaypoints forwarding', () => {
  it('forwards set-route-waypoints', async () => {
    let captured: { type: string; payload: unknown } | null = null;
    const client: GameServerClient = {
      sendIntent(type: string, payload: unknown) {
        captured = { type, payload };
        return Promise.resolve({ seq: 1, ok: true });
      },
      close() {},
    };
    const gateway = makeRemoteGateway(client);
    await gateway.setRouteWaypoints('r1', [{ x: 10, y: 20 }]);
    expect(captured).toEqual({ type: 'set-route-waypoints', payload: { routeId: 'r1', waypoints: [{ x: 10, y: 20 }] } });
  });
});
