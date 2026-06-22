// Pure-layer tests for the cluster-conduit graph/attachment/legality helpers
// (`src/conduits.ts`) per the Task-3 spec — no DOM, no PixiJS. Fixtures mirror
// the building-placement style in `src/adjacency.test.ts`: a WorldState with
// ≥2 islands, each carrying placed conduits and ordinary buildings at known
// tile coords.

import { describe, expect, it } from 'vitest';

import {
  CONDUIT_DEF_IDS,
  isConduit,
  buildingIslandIndex,
  canWire,
  addConduitLink,
  removeConduitLink,
  pruneConduitLinksForBuilding,
  conduitComponents,
  attachedBuildings,
  conduitClusterUnions,
  conduitClusterDataFor,
  eligibleWireTargets,
} from './conduits.js';
import type { PlacedBuilding } from './buildings.js';
import type { ConduitLink, WorldState } from './world.js';

// --- fixture helpers ---------------------------------------------------------

const b = (id: string, defId: string, x: number, y: number): PlacedBuilding =>
  ({ id, defId: defId as never, x, y }) as PlacedBuilding;

/** Minimal WorldState carrying only the fields these pure helpers read
 *  (islands[].id, islands[].buildings, conduitLinks). Everything else is cast
 *  away — the conduit helpers never touch it. */
function makeWorld(
  islands: ReadonlyArray<{ id: string; name?: string; buildings: PlacedBuilding[] }>,
  conduitLinks: ConduitLink[] = [],
): WorldState {
  return { islands, conduitLinks } as unknown as WorldState;
}

// cluster_conduit + lattice_conduit are footprint `single` / `square2`
// respectively; cell_press (manufacturing) and solar (power) are single-tile
// producers with participatesInCluster true at floorLevel 0.

describe('isConduit / CONDUIT_DEF_IDS', () => {
  it('CONDUIT_DEF_IDS holds exactly the two conduit defs', () => {
    expect([...CONDUIT_DEF_IDS].sort()).toEqual(['cluster_conduit', 'lattice_conduit']);
  });

  it('isConduit is true for both conduit defs, false for a normal def', () => {
    expect(isConduit('cluster_conduit' as never)).toBe(true);
    expect(isConduit('lattice_conduit' as never)).toBe(true);
    expect(isConduit('cell_press' as never)).toBe(false);
    expect(isConduit('solar' as never)).toBe(false);
  });
});

describe('buildingIslandIndex', () => {
  it('maps every building id to its island id', () => {
    const w = makeWorld([
      { id: 'isl-1', buildings: [b('c1', 'cluster_conduit', 0, 0), b('p1', 'cell_press', 1, 0)] },
      { id: 'isl-2', buildings: [b('c2', 'cluster_conduit', 0, 0)] },
    ]);
    const idx = buildingIslandIndex(w);
    expect(idx.get('c1')).toBe('isl-1');
    expect(idx.get('p1')).toBe('isl-1');
    expect(idx.get('c2')).toBe('isl-2');
    expect(idx.size).toBe(3);
  });
});

describe('canWire — legality', () => {
  // isl-1: two cluster conduits + one lattice conduit. isl-2: a cluster + a lattice.
  const makeLegalityWorld = (links: ConduitLink[] = []) =>
    makeWorld(
      [
        {
          id: 'isl-1',
          buildings: [
            b('cc1', 'cluster_conduit', 0, 0),
            b('cc2', 'cluster_conduit', 5, 0),
            b('lc1', 'lattice_conduit', 10, 0),
            b('press', 'cell_press', 2, 2),
          ],
        },
        {
          id: 'isl-2',
          buildings: [b('cc3', 'cluster_conduit', 0, 0), b('lc2', 'lattice_conduit', 5, 0)],
        },
      ],
      links,
    );

  it('self link → illegal (reason self)', () => {
    expect(canWire(makeLegalityWorld(), 'cc1', 'cc1')).toEqual({ ok: false, reason: 'self' });
  });

  it('missing building → illegal (reason missing)', () => {
    expect(canWire(makeLegalityWorld(), 'cc1', 'nope').ok).toBe(false);
    expect(canWire(makeLegalityWorld(), 'cc1', 'nope').reason).toBe('missing');
  });

  it('non-conduit endpoint → illegal (reason not-conduit)', () => {
    expect(canWire(makeLegalityWorld(), 'cc1', 'press')).toEqual({ ok: false, reason: 'not-conduit' });
  });

  it('duplicate link (order-insensitive) → illegal (reason duplicate)', () => {
    const w = makeLegalityWorld([{ a: 'cc1', b: 'cc2' }]);
    expect(canWire(w, 'cc1', 'cc2').reason).toBe('duplicate');
    expect(canWire(w, 'cc2', 'cc1').reason).toBe('duplicate'); // reversed order still caught
  });

  it('same-island cluster↔cluster → legal', () => {
    expect(canWire(makeLegalityWorld(), 'cc1', 'cc2')).toEqual({ ok: true });
  });

  it('same-island lattice↔cluster → legal', () => {
    expect(canWire(makeLegalityWorld(), 'cc1', 'lc1')).toEqual({ ok: true });
  });

  it('cross-island cluster↔cluster → illegal (needs lattice)', () => {
    expect(canWire(makeLegalityWorld(), 'cc1', 'cc3').reason).toBe('cross-island-needs-lattice');
  });

  it('cross-island lattice↔cluster → illegal (needs BOTH lattice)', () => {
    expect(canWire(makeLegalityWorld(), 'lc1', 'cc3').reason).toBe('cross-island-needs-lattice');
  });

  it('cross-island lattice↔lattice → legal', () => {
    expect(canWire(makeLegalityWorld(), 'lc1', 'lc2')).toEqual({ ok: true });
  });
});

describe('addConduitLink / removeConduitLink / prune', () => {
  it('addConduitLink dedups and canonicalizes (a < b)', () => {
    const w = makeWorld([
      { id: 'isl-1', buildings: [b('zz', 'cluster_conduit', 0, 0), b('aa', 'cluster_conduit', 5, 0)] },
    ]);
    addConduitLink(w, 'zz', 'aa'); // reversed input
    expect(w.conduitLinks).toEqual([{ a: 'aa', b: 'zz' }]); // canonical order
    addConduitLink(w, 'aa', 'zz'); // same pair again
    expect(w.conduitLinks).toHaveLength(1); // deduped
  });

  it('addConduitLink does nothing for an illegal wire', () => {
    const w = makeWorld([{ id: 'isl-1', buildings: [b('cc1', 'cluster_conduit', 0, 0)] }]);
    addConduitLink(w, 'cc1', 'cc1'); // self
    expect(w.conduitLinks).toHaveLength(0);
  });

  it('removeConduitLink removes the matching link order-insensitively', () => {
    const w = makeWorld(
      [{ id: 'isl-1', buildings: [b('a', 'cluster_conduit', 0, 0), b('z', 'cluster_conduit', 5, 0)] }],
      [{ a: 'a', b: 'z' }],
    );
    removeConduitLink(w, 'z', 'a'); // reversed
    expect(w.conduitLinks).toHaveLength(0);
  });

  it('pruneConduitLinksForBuilding drops every link touching the id', () => {
    const w = makeWorld(
      [{ id: 'isl-1', buildings: [] }],
      [
        { a: 'x', b: 'y' },
        { a: 'y', b: 'z' },
        { a: 'p', b: 'q' },
      ],
    );
    pruneConduitLinksForBuilding(w, 'y');
    expect(w.conduitLinks).toEqual([{ a: 'p', b: 'q' }]);
  });
});

describe('conduitComponents', () => {
  it('unions transitively: C1-C2, C2-C3 → one component {C1,C2,C3}', () => {
    const w = makeWorld(
      [{ id: 'isl-1', buildings: [] }],
      [
        { a: 'C1', b: 'C2' },
        { a: 'C2', b: 'C3' },
      ],
    );
    const comps = conduitComponents(w);
    expect(comps).toHaveLength(1);
    expect([...comps[0]!].sort()).toEqual(['C1', 'C2', 'C3']);
  });

  it('keeps disjoint wire sets as separate components', () => {
    const w = makeWorld(
      [{ id: 'isl-1', buildings: [] }],
      [
        { a: 'C1', b: 'C2' },
        { a: 'D1', b: 'D2' },
      ],
    );
    const comps = conduitComponents(w).map((c) => [...c].sort());
    expect(comps).toHaveLength(2);
    expect(comps).toContainEqual(['C1', 'C2']);
    expect(comps).toContainEqual(['D1', 'D2']);
  });
});

describe('attachedBuildings', () => {
  // A cluster conduit at (0,0). A cell_press at (1,0) is 4-adjacent. A cell_press
  // at (3,3) is NOT adjacent. A second conduit at (0,1) is adjacent but excluded
  // (conduits never attach). A press on another island is excluded.
  const makeAttachWorld = () =>
    makeWorld([
      {
        id: 'isl-1',
        buildings: [
          b('cc', 'cluster_conduit', 0, 0),
          b('near', 'cell_press', 1, 0), // east neighbour of (0,0) → adjacent
          b('far', 'cell_press', 3, 3), // not adjacent
          b('cc2', 'cluster_conduit', 0, 1), // adjacent but is itself a conduit
        ],
      },
      {
        id: 'isl-2',
        buildings: [b('other', 'cell_press', 1, 0)], // adjacent coords but wrong island
      },
    ]);

  it('returns a 4-adjacent same-island participating non-conduit building', () => {
    const out = attachedBuildings('cc', makeAttachWorld());
    expect(out.map((x) => x.id)).toEqual(['near']);
  });

  it('excludes non-adjacent buildings, conduits, and other-island buildings', () => {
    const ids = attachedBuildings('cc', makeAttachWorld()).map((x) => x.id);
    expect(ids).not.toContain('far');
    expect(ids).not.toContain('cc2');
    expect(ids).not.toContain('other');
    expect(ids).not.toContain('cc');
  });

  it('returns [] for an unknown conduit id', () => {
    expect(attachedBuildings('ghost', makeAttachWorld())).toEqual([]);
  });
});

describe('conduitClusterUnions', () => {
  // Two cluster conduits cc1 (0,0) and cc2 (10,0) on the same island, wired
  // together. press-a (1,0) attaches to cc1; press-b (11,0) attaches to cc2 —
  // both manufacturing. solar-a (1,1)?? we put a power building attached to cc1
  // to prove cross-category never pairs. A bridge building bridge (0,1) is
  // 4-adjacent to BOTH cc1 (south) and cc2? not adjacent to cc2; instead place a
  // single press adjacent to two conduits in one component to prove dedup.
  it('pairs same-category buildings across wired conduits in a component', () => {
    const w = makeWorld(
      [
        {
          id: 'isl-1',
          buildings: [
            b('cc1', 'cluster_conduit', 0, 0),
            b('cc2', 'cluster_conduit', 10, 0),
            b('pa', 'cell_press', 1, 0), // attaches cc1 (manufacturing)
            b('pb', 'cell_press', 11, 0), // attaches cc2 (manufacturing)
          ],
        },
      ],
      [{ a: 'cc1', b: 'cc2' }],
    );
    const pairs = conduitClusterUnions(w).map((p) => [...p].sort());
    // pa and pb both manufacturing in one component → exactly one connecting pair.
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual(['pa', 'pb']);
  });

  it('never pairs across different categories', () => {
    const w = makeWorld(
      [
        {
          id: 'isl-1',
          buildings: [
            b('cc1', 'cluster_conduit', 0, 0),
            b('cc2', 'cluster_conduit', 10, 0),
            b('pa', 'cell_press', 1, 0), // manufacturing, attaches cc1
            b('pb', 'cell_press', 11, 0), // manufacturing, attaches cc2
            b('sa', 'solar', 0, 1), // power, attaches cc1 (south neighbour)
          ],
        },
      ],
      [{ a: 'cc1', b: 'cc2' }],
    );
    const flat = conduitClusterUnions(w).flatMap((p) => [...p]);
    // Only one manufacturing pair; solar (power, lone in its category) yields no pair.
    const pairs = conduitClusterUnions(w);
    expect(pairs).toHaveLength(1);
    // solar never appears in any pair (alone in its category, and never bridged
    // across categories).
    expect(flat).not.toContain('sa');
    expect(pairs[0]!.slice().sort()).toEqual(['pa', 'pb']);
  });

  it('dedups a building attached to two conduits in one component (no self-pair)', () => {
    // press shared (0,1) is 4-adjacent to cc1 (0,0) (north) AND cc-down (0,2)
    // (south). cc1 and cc-down are wired → one component. The shared press must
    // appear once and produce NO self-pair.
    const w = makeWorld(
      [
        {
          id: 'isl-1',
          buildings: [
            b('cc1', 'cluster_conduit', 0, 0),
            b('ccd', 'cluster_conduit', 0, 2),
            b('shared', 'cell_press', 0, 1), // between the two conduits, adjacent to both
          ],
        },
      ],
      [{ a: 'cc1', b: 'ccd' }],
    );
    const pairs = conduitClusterUnions(w);
    expect(pairs).toHaveLength(0); // single building → no pair, no self-pair
  });

  it('emits no pairs when conduits are unwired (separate components)', () => {
    const w = makeWorld(
      [
        {
          id: 'isl-1',
          buildings: [
            b('cc1', 'cluster_conduit', 0, 0),
            b('cc2', 'cluster_conduit', 10, 0),
            b('pa', 'cell_press', 1, 0),
            b('pb', 'cell_press', 11, 0),
          ],
        },
      ],
      [], // no links → each conduit is its own (empty) component; nothing wires
    );
    expect(conduitClusterUnions(w)).toHaveLength(0);
  });
});

describe('conduitClusterDataFor (per-island, drives the inspector display)', () => {
  it('returns the same-island pairs touching the island, with no remote', () => {
    const w = makeWorld(
      [
        {
          id: 'isl-1',
          buildings: [
            b('cc1', 'cluster_conduit', 0, 0),
            b('cc2', 'cluster_conduit', 10, 0),
            b('pa', 'cell_press', 1, 0),
            b('pb', 'cell_press', 11, 0),
          ],
        },
      ],
      [{ a: 'cc1', b: 'cc2' }],
    );
    const data = conduitClusterDataFor(w, 'isl-1');
    expect(data.pairs.map((p) => [...p].sort())).toEqual([['pa', 'pb']]);
    expect(data.remote).toHaveLength(0);
  });

  it('is empty when there are no conduit links (inert)', () => {
    const w = makeWorld(
      [{ id: 'isl-1', buildings: [b('cc1', 'cluster_conduit', 0, 0), b('pa', 'cell_press', 1, 0)] }],
      [],
    );
    const data = conduitClusterDataFor(w, 'isl-1');
    expect(data.pairs).toHaveLength(0);
    expect(data.remote).toHaveLength(0);
  });
});


describe('eligibleWireTargets', () => {
  const makeTargetsWorld = (links: ConduitLink[] = []) =>
    makeWorld(
      [
        {
          id: 'isl-1',
          name: 'Alpha',
          buildings: [
            b('cc1', 'cluster_conduit', 0, 0),
            b('cc2', 'cluster_conduit', 5, 0),
            b('lc1', 'lattice_conduit', 10, 0),
          ],
        },
        {
          id: 'isl-2',
          name: 'Beta',
          buildings: [
            b('cc3', 'cluster_conduit', 0, 0),
            b('lc2', 'lattice_conduit', 5, 0),
          ],
        },
      ],
      links,
    );

  it('lists another same-island conduit as eligible', () => {
    const w = makeTargetsWorld();
    const targets = eligibleWireTargets(w, 'cc1');
    expect(targets.map((t) => t.id).sort()).toEqual(['cc2', 'lc1']);
  });

  it('does NOT list a cross-island cluster_conduit', () => {
    const w = makeTargetsWorld();
    const targets = eligibleWireTargets(w, 'cc1');
    expect(targets.some((t) => t.id === 'cc3')).toBe(false);
  });

  it('DOES list another cross-island lattice_conduit', () => {
    const w = makeTargetsWorld();
    const targets = eligibleWireTargets(w, 'lc1');
    expect(targets.some((t) => t.id === 'lc2')).toBe(true);
  });

  it('excludes an already-linked pair (canWire returns duplicate)', () => {
    const w = makeTargetsWorld([{ a: 'cc1', b: 'cc2' }]);
    const targets = eligibleWireTargets(w, 'cc1');
    expect(targets.some((t) => t.id === 'cc2')).toBe(false);
    expect(targets.some((t) => t.id === 'lc1')).toBe(true);
  });

  it('labels include displayName + island name + coords', () => {
    const w = makeTargetsWorld();
    const lc1 = eligibleWireTargets(w, 'cc2').find((t) => t.id === 'lc1');
    expect(lc1?.label).toContain('Lattice Conduit');
    expect(lc1?.label).toContain('Alpha');
    expect(lc1?.label).toContain('@10,0');
  });
});
