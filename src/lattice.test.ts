import { describe, expect, it } from 'vitest';
import type { Route } from './routes.js';
import {
  computeLatticeActive,
  crossIslandNeighbors,
  isLatticeActive,
  latticeIslands,
  latticeStorageCaps,
  LATTICE_ACTIVATION_THRESHOLD,
} from './lattice.js';
import { makeInitialIslandState, makeInitialWorld } from './world.js';

function makeTestWorld() {
  const world = makeInitialWorld(0);
  const map = new Map();
  for (const spec of world.islands) {
    map.set(spec.id, makeInitialIslandState(spec, 0));
  }
  (world as typeof world & { islandStates: typeof map }).islandStates = map;
  return world as typeof world & { islandStates: typeof map };
}

/** Add a cargo route from `home` to `toId` so `toId` is networked. */
function networkTo(world: ReturnType<typeof makeTestWorld>, toId: string): void {
  const route: Route = {
    id: `route-${world.routes.length}`,
    from: 'home',
    to: toId,
    type: 'cargo',
    capacityPerSec: 1,
    mode: 'priority',
    cargo: [],
    transitTimeSec: 1,
    inFlight: [],
  };
  world.routes.push(route);
}

describe('computeLatticeActive', () => {
  it('returns false when no lattice nodes exist', () => {
    const world = makeTestWorld();
    expect(computeLatticeActive(world)).toBe(false);
    expect(world.latticeActive).toBe(false);
    expect(world.latticeNodeIslands).toEqual([]);
  });

  it('returns false below threshold even with T5 islands', () => {
    const world = makeTestWorld();
    for (let i = 0; i < LATTICE_ACTIVATION_THRESHOLD - 1; i++) {
      world.islands.push({
        id: `t5-${i}`,
        name: `t5-${i}`,
        biome: 'plains',
        cx: 100 + i * 10,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: [{ id: `node-${i}`, defId: 'lattice_node', x: 0, y: 0 }],
        modifiers: [],
      });
      const s = makeInitialIslandState(world.islands[world.islands.length - 1]!, 0);
      s.level = 50;
      s.aiCoreCrafted = true;
      world.islandStates.set(`t5-${i}`, s);
    }
    expect(computeLatticeActive(world)).toBe(false);
    expect(world.latticeActive).toBe(false);
  });

  it('activates at exactly the threshold when all are networked', () => {
    const world = makeTestWorld();
    for (let i = 0; i < LATTICE_ACTIVATION_THRESHOLD; i++) {
      world.islands.push({
        id: `t5-${i}`,
        name: `t5-${i}`,
        biome: 'plains',
        cx: 100 + i * 10,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: [{ id: `node-${i}`, defId: 'lattice_node', x: 0, y: 0 }],
        modifiers: [],
      });
      const s = makeInitialIslandState(world.islands[world.islands.length - 1]!, 0);
      s.level = 50;
      s.aiCoreCrafted = true;
      world.islandStates.set(`t5-${i}`, s);
      networkTo(world, `t5-${i}`);
    }
    expect(computeLatticeActive(world)).toBe(true);
    expect(world.latticeActive).toBe(true);
    expect(world.latticeNodeIslands.length).toBe(LATTICE_ACTIVATION_THRESHOLD);
  });

  it('does NOT activate at threshold when none are networked (§13.3 strict gate)', () => {
    const world = makeTestWorld();
    for (let i = 0; i < LATTICE_ACTIVATION_THRESHOLD; i++) {
      world.islands.push({
        id: `t5-${i}`,
        name: `t5-${i}`,
        biome: 'plains',
        cx: 100 + i * 10,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: [{ id: `node-${i}`, defId: 'lattice_node', x: 0, y: 0 }],
        modifiers: [],
      });
      const s = makeInitialIslandState(world.islands[world.islands.length - 1]!, 0);
      s.level = 50;
      s.aiCoreCrafted = true;
      world.islandStates.set(`t5-${i}`, s);
      // No route added — t5-i remains disconnected from home.
    }
    expect(computeLatticeActive(world)).toBe(false);
    expect(world.latticeActive).toBe(false);
    expect(world.latticeNodeIslands).toEqual([]);
  });

  it('does NOT activate when 19 of 20 are networked (one isolated)', () => {
    const world = makeTestWorld();
    for (let i = 0; i < LATTICE_ACTIVATION_THRESHOLD; i++) {
      world.islands.push({
        id: `t5-${i}`,
        name: `t5-${i}`,
        biome: 'plains',
        cx: 100 + i * 10,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: [{ id: `node-${i}`, defId: 'lattice_node', x: 0, y: 0 }],
        modifiers: [],
      });
      const s = makeInitialIslandState(world.islands[world.islands.length - 1]!, 0);
      s.level = 50;
      s.aiCoreCrafted = true;
      world.islandStates.set(`t5-${i}`, s);
      // Network only the first 19; t5-19 stays isolated.
      if (i < LATTICE_ACTIVATION_THRESHOLD - 1) networkTo(world, `t5-${i}`);
    }
    expect(computeLatticeActive(world)).toBe(false);
    expect(world.latticeActive).toBe(false);
  });

  it('flips inactive → active when a previously-isolated island becomes networked', () => {
    const world = makeTestWorld();
    for (let i = 0; i < LATTICE_ACTIVATION_THRESHOLD; i++) {
      world.islands.push({
        id: `t5-${i}`,
        name: `t5-${i}`,
        biome: 'plains',
        cx: 100 + i * 10,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: [{ id: `node-${i}`, defId: 'lattice_node', x: 0, y: 0 }],
        modifiers: [],
      });
      const s = makeInitialIslandState(world.islands[world.islands.length - 1]!, 0);
      s.level = 50;
      s.aiCoreCrafted = true;
      world.islandStates.set(`t5-${i}`, s);
      if (i < LATTICE_ACTIVATION_THRESHOLD - 1) networkTo(world, `t5-${i}`);
    }
    // 19 networked, 1 isolated — gate fails.
    expect(computeLatticeActive(world)).toBe(false);
    // Player builds the route that brings the 20th into the graph.
    networkTo(world, `t5-${LATTICE_ACTIVATION_THRESHOLD - 1}`);
    expect(computeLatticeActive(world)).toBe(true);
    expect(world.latticeActive).toBe(true);
    expect(world.latticeNodeIslands.length).toBe(LATTICE_ACTIVATION_THRESHOLD);
  });

  it('flips active → inactive when a networked island becomes isolated (re-evaluates every call)', () => {
    const world = makeTestWorld();
    for (let i = 0; i < LATTICE_ACTIVATION_THRESHOLD; i++) {
      world.islands.push({
        id: `t5-${i}`,
        name: `t5-${i}`,
        biome: 'plains',
        cx: 100 + i * 10,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: [{ id: `node-${i}`, defId: 'lattice_node', x: 0, y: 0 }],
        modifiers: [],
      });
      const s = makeInitialIslandState(world.islands[world.islands.length - 1]!, 0);
      s.level = 50;
      s.aiCoreCrafted = true;
      world.islandStates.set(`t5-${i}`, s);
      networkTo(world, `t5-${i}`);
    }
    expect(computeLatticeActive(world)).toBe(true);
    // Cut the route to t5-0; only 19 remain networked.
    world.routes = world.routes.filter((r) => r.to !== 't5-0');
    expect(computeLatticeActive(world)).toBe(false);
    expect(world.latticeActive).toBe(false);
    expect(world.latticeNodeIslands).toEqual([]);
  });

  it('ignores non-T5 islands with lattice nodes', () => {
    const world = makeTestWorld();
    for (let i = 0; i < LATTICE_ACTIVATION_THRESHOLD; i++) {
      world.islands.push({
        id: `t5-${i}`,
        name: `t5-${i}`,
        biome: 'plains',
        cx: 100 + i * 10,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: [{ id: `node-${i}`, defId: 'lattice_node', x: 0, y: 0 }],
        modifiers: [],
      });
      const s = makeInitialIslandState(world.islands[world.islands.length - 1]!, 0);
      // level 1, no aiCoreCrafted — NOT T5-mastered
      world.islandStates.set(`t5-${i}`, s);
    }
    expect(computeLatticeActive(world)).toBe(false);
  });

  it('ignores invalid lattice nodes', () => {
    const world = makeTestWorld();
    for (let i = 0; i < LATTICE_ACTIVATION_THRESHOLD; i++) {
      world.islands.push({
        id: `t5-${i}`,
        name: `t5-${i}`,
        biome: 'plains',
        cx: 100 + i * 10,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: [{ id: `node-${i}`, defId: 'lattice_node', x: 0, y: 0, invalid: true }],
        modifiers: [],
      });
      const s = makeInitialIslandState(world.islands[world.islands.length - 1]!, 0);
      s.level = 50;
      s.aiCoreCrafted = true;
      world.islandStates.set(`t5-${i}`, s);
    }
    expect(computeLatticeActive(world)).toBe(false);
  });

  it('counts only islands with both T5 mastery and a node', () => {
    const world = makeTestWorld();
    // Mix: some T5 with node, some T5 without node, some non-T5 with node
    for (let i = 0; i < LATTICE_ACTIVATION_THRESHOLD + 5; i++) {
      const hasNode = i % 2 === 0;
      const isT5 = i < LATTICE_ACTIVATION_THRESHOLD + 2;
      world.islands.push({
        id: `mix-${i}`,
        name: `mix-${i}`,
        biome: 'plains',
        cx: 200 + i * 10,
        cy: 0,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: hasNode
          ? [{ id: `node-${i}`, defId: 'lattice_node', x: 0, y: 0 }]
          : [],
        modifiers: [],
      });
      const s = makeInitialIslandState(world.islands[world.islands.length - 1]!, 0);
      if (isT5) {
        s.level = 50;
        s.aiCoreCrafted = true;
      }
      world.islandStates.set(`mix-${i}`, s);
    }
    // Only even indices < 22 have both T5 mastery and a node: 11 islands < threshold 20.
    expect(computeLatticeActive(world)).toBe(false);
  });
});

describe('latticeIslands', () => {
  it('returns empty set when inactive', () => {
    const world = makeTestWorld();
    expect(latticeIslands(world).size).toBe(0);
  });

  it('returns the node islands when active', () => {
    const world = makeTestWorld();
    world.latticeActive = true;
    world.latticeNodeIslands = ['a', 'b'];
    expect(latticeIslands(world)).toEqual(new Set(['a', 'b']));
  });
});

describe('isLatticeActive', () => {
  it('reads the world flag', () => {
    const world = makeTestWorld();
    expect(isLatticeActive(world)).toBe(false);
    world.latticeActive = true;
    expect(isLatticeActive(world)).toBe(true);
  });
});

describe('crossIslandNeighbors', () => {
  it('returns undefined when lattice is inactive', () => {
    const world = makeTestWorld();
    expect(crossIslandNeighbors(world, 'home')).toBeUndefined();
  });

  it('returns undefined for a non-lattice island', () => {
    const world = makeTestWorld();
    world.latticeActive = true;
    world.latticeNodeIslands = ['other'];
    expect(crossIslandNeighbors(world, 'home')).toBeUndefined();
  });

  it('returns buildings on other lattice islands', () => {
    const world = makeTestWorld();
    world.islands.push({
      id: 'remote',
      name: 'remote',
      biome: 'plains',
      cx: 100,
      cy: 0,
      majorRadius: 10,
      minorRadius: 10,
      populated: true,
      discovered: true,
      buildings: [
        { id: 'remote-mine', defId: 'mine', x: 0, y: 0 },
        { id: 'remote-workshop', defId: 'workshop', x: 2, y: 0 },
      ],
      modifiers: [],
    });
    world.latticeActive = true;
    world.latticeNodeIslands = ['home', 'remote'];
    const neighbors = crossIslandNeighbors(world, 'home');
    expect(neighbors).toBeDefined();
    expect(neighbors!.length).toBe(2);
    expect(neighbors!.map((b) => b.id)).toContain('remote-mine');
    expect(neighbors!.map((b) => b.id)).toContain('remote-workshop');
  });

  it('excludes invalid buildings', () => {
    const world = makeTestWorld();
    world.islands.push({
      id: 'remote',
      name: 'remote',
      biome: 'plains',
      cx: 100,
      cy: 0,
      majorRadius: 10,
      minorRadius: 10,
      populated: true,
      discovered: true,
      buildings: [
        { id: 'remote-mine', defId: 'mine', x: 0, y: 0 },
        { id: 'remote-bad', defId: 'workshop', x: 2, y: 0, invalid: true },
      ],
      modifiers: [],
    });
    world.latticeActive = true;
    world.latticeNodeIslands = ['home', 'remote'];
    const neighbors = crossIslandNeighbors(world, 'home');
    expect(neighbors!.length).toBe(1);
    expect(neighbors![0]!.id).toBe('remote-mine');
  });

  it('excludes the queried island itself', () => {
    const world = makeTestWorld();
    world.latticeActive = true;
    world.latticeNodeIslands = ['home'];
    const neighbors = crossIslandNeighbors(world, 'home');
    expect(neighbors).toBeDefined();
    expect(neighbors!.length).toBe(0);
  });
});

describe('latticeStorageCaps', () => {
  it('returns undefined when lattice is inactive', () => {
    const world = makeTestWorld();
    expect(latticeStorageCaps(world)).toBeUndefined();
  });

  it('sums caps across lattice islands', () => {
    const world = makeTestWorld();
    const homeState = world.islandStates.get('home')!;
    homeState.storageCaps.iron_ore = 1000;
    world.islands.push({
      id: 'remote',
      name: 'remote',
      biome: 'plains',
      cx: 100,
      cy: 0,
      majorRadius: 10,
      minorRadius: 10,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
    });
    const remoteState = makeInitialIslandState(world.islands[world.islands.length - 1]!, 0);
    remoteState.storageCaps.iron_ore = 500;
    world.islandStates.set('remote', remoteState);
    world.latticeActive = true;
    world.latticeNodeIslands = ['home', 'remote'];
    const caps = latticeStorageCaps(world);
    expect(caps).toBeDefined();
    expect(caps!.iron_ore).toBe(1500);
  });

  it('defaults missing resources to 0 in the sum', () => {
    const world = makeTestWorld();
    world.latticeActive = true;
    world.latticeNodeIslands = ['home'];
    const caps = latticeStorageCaps(world);
    expect(caps).toBeDefined();
    // home's caps are the default from makeInitialIslandState
    expect(caps!.iron_ore).toBe(world.islandStates.get('home')!.storageCaps.iron_ore);
  });
});
