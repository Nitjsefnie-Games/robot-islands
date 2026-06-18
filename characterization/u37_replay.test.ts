// Golden replay test (#124): replay the u37 dispatch/pulse/tick goldens from
// the JSON `input` ALONE (no generator closures) against the real drone
// implementation and assert the recorded `expected`. Previously a manual
// `npx tsx u37_replay_check.ts` that was NOT in `npm test`, so the golden could
// (and did) silently rot. Wiring it into vitest makes golden drift fail CI.
//
// Regenerate the golden after an intentional behavior change with:
//   npx tsx characterization/u37_drones_gen_goldens.ts > characterization/u37_drones_goldens.json
//
// This file is plain replay glue over untyped JSON, so `any` is used liberally.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dispatchDrone, tickDrones, firePulse, type Drone } from '../src/drones.js';
import type { IslandSpec, WorldState } from '../src/world.js';

const g = JSON.parse(readFileSync(new URL('./u37_drones_goldens.json', import.meta.url), 'utf8'));

function spec(o: any): IslandSpec {
  return {
    id: o.id, name: o.id, biome: 'temperate', cx: o.cx, cy: o.cy,
    majorRadius: 4, minorRadius: 4, populated: o.populated ?? false,
    discovered: o.discovered, buildings: o.antenna ? [{ defId: o.antenna, x: 0, y: 0 }] : [],
    modifiers: o.modifiers ?? [],
  } as any;
}
function islandState(id: string, level: number, inventory: any, buildings: any[]): any {
  return {
    id, buildings, inventory: { ...inventory }, storageCaps: {}, xp: 0, level,
    unspentSkillPoints: 0, unlockedNodes: new Set(), unlockedEdges: new Set(), everProduced: new Set(),
  };
}
function world(islands: IslandSpec[], drones: Drone[] = []): WorldState {
  return { islands, seed: 's', drones, routes: [], vehicles: [], revealedCells: new Set(), states: {} } as any;
}
function preGen(ox: number, oy: number, span: number): Set<string> {
  const s = new Set<string>(); const r = Math.ceil(span / 16) + 2;
  const cx = Math.floor(ox / 16), cy = Math.floor(oy / 16);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) s.add(`${cx + dx},${cy + dy}`);
  return s;
}

describe('u37 drone goldens — dispatch replay (#124)', () => {
  for (const c of g.dispatch) {
    it(c.name, () => {
      const inp = c.input;
      const w = world([]);
      const buildings = Array.from({ length: inp.island.probability_engines ?? 0 }, () => ({ defId: 'probability_engine' }));
      const o = islandState(inp.island.id, inp.island.level, inp.island.inventory, buildings);
      for (const pd of inp.pre_dispatches ?? []) {
        dispatchDrone(w, o, pd.origin_x, pd.origin_y, pd.heading_x, pd.heading_y, pd.fuel_units, pd.at_ms, pd.waypoints, pd.selected_tier);
      }
      const call = inp.call;
      const res: any = dispatchDrone(w, o, call.origin_x, call.origin_y, call.heading_x, call.heading_y, call.fuel_units, call.at_ms, call.waypoints, call.selected_tier);
      // Observable result minus the process-counter launch id (compared id-agnostic).
      const live: any = res.ok ? {
        ok: true,
        drone: {
          home_id: res.drone.fromIslandId, origin_x: res.drone.originX, origin_y: res.drone.originY,
          heading_x: res.drone.dirX, heading_y: res.drone.dirY, trip_half_tiles: res.drone.outboundTiles,
          scan_half_width: res.drone.scanRadius, launch_at_ms: res.drone.launchTime, return_at_ms: res.drone.expectedReturnTime,
          tier: res.drone.tier, fuel_units: res.drone.fuelLoaded, fuel_kind: res.drone.fuelResource,
          status: res.drone.status, waypoints: res.drone.waypoints, rare_bias: res.drone.probabilityBias,
          launch_id: undefined,
        },
      } : { ok: false, reason: res.reason };
      const want = c.expected.result.ok
        ? { ok: true, drone: { ...c.expected.result.drone, launch_id: undefined } }
        : c.expected.result;
      expect(live).toEqual(want);
      expect(w.drones.length).toBe(c.expected.drone_count);
      const invAfter = Object.fromEntries(Object.keys(inp.island.inventory).map((k) => [k, o.inventory[k] ?? 0]));
      expect(invAfter).toEqual(c.expected.inventory_after);
    });
  }
});

describe('u37 drone goldens — pulse replay (#124)', () => {
  for (const c of g.pulse) {
    it(c.name, () => {
      const inp = c.input;
      const o = islandState(inp.origin.id, inp.origin.level, { cryogenic_hydrogen: inp.origin.cryogenic_hydrogen }, inp.origin.has_launch_tower ? [{ defId: 'launch_tower' }] : []);
      const islands = inp.islands.map(spec);
      const w = world(islands);
      const result = firePulse(w, o, inp.at_ms);
      expect(result).toEqual(c.expected.result);
      expect(o.inventory['cryogenic_hydrogen'] ?? 0).toBe(c.expected.fuel_after);
      expect(Object.fromEntries(islands.map((i: IslandSpec) => [i.id, i.discovered]))).toEqual(c.expected.discovered_after);
    });
  }
});

describe('u37 drone goldens — tick replay (#124)', () => {
  for (const c of g.tick_reveal) {
    it(c.name, () => {
      const inp = c.input;
      const islands = inp.islands.map(spec);
      const di = inp.drone;
      const d: Drone = {
        id: 'drone-1', fromIslandId: 'home', originX: di.origin_x, originY: di.origin_y,
        dirX: di.heading_x, dirY: di.heading_y, outboundTiles: di.trip_half_tiles, scanRadius: di.scan_half_width,
        launchTime: di.launch_at_ms, expectedReturnTime: di.return_at_ms, tier: di.tier, fuelLoaded: 10,
        fuelResource: 'biofuel', status: 'active', waypoints: [], darkModeDiscoveries: [],
        scanBuffer: new Set(), probabilityBias: di.rare_bias,
      } as any;
      const w = world(islands, [d]);
      if (inp.pre_generate_cells_radius !== undefined) (w as any).generatedCells = preGen(d.originX, d.originY, inp.pre_generate_cells_radius);
      const steps: any[] = [];
      for (const s of inp.steps) {
        const r = tickDrones(w, s.now_ms, s.prev_ms);
        const live = w.drones.find((x) => x.id === d.id);
        steps.push({
          label: s.label, revealed_cells_added: r.revealedCellsAdded, newly_discovered: r.newlyDiscoveredIslandIds,
          returned: r.returned.length, lost: r.lost.length, drone_status: live?.status,
          buffer_size: live?.scanBuffer.size, revealed_cells_total: w.revealedCells.size,
        });
      }
      expect(steps).toEqual(c.expected.steps);
      expect(Object.fromEntries(islands.map((i: IslandSpec) => [i.id, i.discovered]))).toEqual(c.expected.discovered_after);
    });
  }
});
