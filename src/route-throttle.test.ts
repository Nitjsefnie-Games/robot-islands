import { describe, expect, it } from 'vitest';

import { routeThrottleReason, throttleBadge } from './route-throttle.js';
import type { Route } from './routes.js';
import { type IslandState } from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import type { IslandSpec, WorldState } from './world.js';
import type { PlacedBuilding } from './buildings.js';

function blank(fill: number): Record<ResourceId, number> {
  const o = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) o[r] = fill;
  return o;
}

function mkState(id: string, over: Partial<IslandState> = {}): IslandState {
  return {
    id, buildings: [], inventory: blank(0), storageCaps: blank(100),
    xp: 0, level: 1, unspentSkillPoints: 0, unlockedNodes: new Set(), unlockedEdges: new Set(),
    auraAmpVersion: 0, auraAmpCache: null, auraAmpCacheVersion: -1, co2Kg: 0,
    funnelPending: blank(0), aiCoreCrafted: false, ascendantCoreCrafted: false, lastResetAt: null,
    timeLockBankedMin: 0, accelerationQueue: [], accelerationRemainingMin: 0, bankingEnabled: false,
    genesisTarget: null, batteryStoredWs: 0, starterInventoryGrace: {} as Record<ResourceId, number>,
    socketBindings: new Map(), everProduced: new Set(), tradeCooldownMs: 0, tradeAcceptCount: 0, lastTick: 0,
    ...over,
  };
}

function mkSpec(id: string, buildings: PlacedBuilding[] = []): IslandSpec {
  return { id, name: id, biome: 'plains', cx: 0, cy: 0, majorRadius: 10, minorRadius: 10,
    populated: true, discovered: true, buildings, modifiers: [] };
}

function mkWorld(islands: IslandSpec[], routes: Route[]): WorldState {
  return { islands, drones: [], routes, vehicles: [], revealedCells: new Set(), satellites: [], repairDrones: [],
    debrisFields: [], latticeActive: false,
    latticeNodeIslands: [], commPackets: [], totalCo2Kg: 0, playerLat: 0, playerLon: 0, seed: 't',
    oceanCells: new Map(), depthRevealedCells: new Set(), recentBuildAttempts: new Set(), recentBuildAttemptTs: new Map() } as unknown as WorldState;
}

function mkRoute(over: Partial<Route> = {}): Route {
  return { id: 'r1', from: 'home', to: 'colony', type: 'cargo', capacityPerSec: 0.5, transitTimeSec: 10,
    mode: 'split', cargo: [{ resourceId: 'wood' }], inFlight: [], sourceBuildingId: 'dock-1', ...over } as unknown as Route;
}

function setup(srcWood: number, destWood: number, destCapWood: number) {
  const dock: PlacedBuilding = { id: 'dock-1', defId: 'dock', x: 0, y: 0 } as unknown as PlacedBuilding;
  const route = mkRoute();
  const world = mkWorld([mkSpec('home', [dock]), mkSpec('colony')], [route]);
  const states = new Map<string, IslandState>([
    ['home', mkState('home', { buildings: [dock], inventory: { ...blank(0), wood: srcWood } })],
    ['colony', mkState('colony', { inventory: { ...blank(0), wood: destWood }, storageCaps: { ...blank(100), wood: destCapWood } })],
  ]);
  return { world, states, route };
}

describe('routeThrottleReason', () => {
  it('flowing when source has stock and destination has headroom', () => {
    const { world, states, route } = setup(50, 0, 100);
    expect(routeThrottleReason(world, states, route)).toBe('flowing');
  });

  it('source-empty when the source has no stock of any targeted resource', () => {
    const { world, states, route } = setup(0, 0, 100);
    expect(routeThrottleReason(world, states, route)).toBe('source-empty');
  });

  it('dest-full when the source has stock but the destination is at cap', () => {
    const { world, states, route } = setup(50, 100, 100);
    expect(routeThrottleReason(world, states, route)).toBe('dest-full');
  });

  it('weather when an otherwise-flowing route is throttled by §2.6 weather', () => {
    const { world, states, route } = setup(50, 0, 100);
    // weatherMul < 1 ⇒ the route would flow but bad weather is cutting capacity.
    expect(routeThrottleReason(world, states, route, 0.5)).toBe('weather');
    // Clear weather (mul 1) ⇒ plain flowing.
    expect(routeThrottleReason(world, states, route, 1)).toBe('flowing');
  });

  it('weather is irrelevant when nothing can flow (dest full takes precedence)', () => {
    const { world, states, route } = setup(50, 100, 100);
    expect(routeThrottleReason(world, states, route, 0.3)).toBe('dest-full');
  });

  it('draining overrides everything', () => {
    const { world, states, route } = setup(50, 0, 100);
    route.draining = true;
    expect(routeThrottleReason(world, states, route)).toBe('draining');
  });

  it('idle when the route carries no cargo', () => {
    const { world, states, route } = setup(50, 0, 100);
    route.cargo = [];
    expect(routeThrottleReason(world, states, route)).toBe('idle');
  });

  it('badges map each reason to text + tone', () => {
    expect(throttleBadge('flowing')).toEqual({ text: '▶ flowing', tone: 'ok' });
    expect(throttleBadge('weather')).toEqual({ text: '⛈ weather', tone: 'warn' });
    expect(throttleBadge('source-empty')).toEqual({ text: '⏸ source empty', tone: 'muted' });
    expect(throttleBadge('dest-full')).toEqual({ text: '⛔ dest full', tone: 'warn' });
    expect(throttleBadge('draining')).toEqual({ text: 'draining', tone: 'muted' });
    expect(throttleBadge('idle')).toEqual({ text: 'idle', tone: 'muted' });
  });

  it('dest-full when one resource has stock-but-no-room even if another is empty', () => {
    const { world, states, route } = setup(0, 100, 100);
    // wood: dest full; add stone with stock but also full dest → still blocked, dominant = dest-full
    states.get('home')!.inventory.stone = 30;
    states.get('colony')!.inventory.stone = 100;
    states.get('colony')!.storageCaps.stone = 100;
    route.cargo = [{ resourceId: 'wood' }, { resourceId: 'stone' }];
    expect(routeThrottleReason(world, states, route)).toBe('dest-full');
  });
});
