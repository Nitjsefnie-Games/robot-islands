// L1 self-check: replay dispatch + tick goldens from the JSON `input` ALONE
// (no generator closures) against the real implementation, prove `expected`.
import { readFileSync } from 'node:fs';
import { dispatchDrone, tickDrones, firePulse, type Drone } from '../src/drones.js';
import { makeInitialIslandState } from '../src/world.js';
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
  const s = {
    id, buildings, inventory: { ...inventory }, storageCaps: {}, xp: 0, level,
    unspentSkillPoints: 0, unlockedNodes: new Set(), unlockedEdges: new Set(), everProduced: new Set(),
  };
  return s;
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

let pass = 0, fail = 0;
const fails: string[] = [];
function eq(a: any, b: any) { return JSON.stringify(a) === JSON.stringify(b); }
function check(name: string, got: any, want: any) {
  if (eq(got, want)) pass++;
  else { fail++; fails.push(`${name}\n  got=${JSON.stringify(got)}\n  want=${JSON.stringify(want)}`); }
}

// ----- dispatch -----
for (const c of g.dispatch) {
  const inp = c.input;
  const w = world([]);
  const buildings = Array.from({ length: inp.island.probability_engines ?? 0 }, () => ({ defId: 'probability_engine' }));
  const o = islandState(inp.island.id, inp.island.level, inp.island.inventory, buildings);
  // reset module counter so launch ids match: dispatch a throwaway then can't — instead rely on first id.
  // The generator reset before each case; emulate by exact id-agnostic compare on non-id fields.
  for (const pd of inp.pre_dispatches ?? []) dispatchDrone(w, o, pd.origin_x, pd.origin_y, pd.heading_x, pd.heading_y, pd.fuel_units, pd.at_ms, pd.waypoints, pd.selected_tier);
  const call = inp.call;
  const res: any = dispatchDrone(w, o, call.origin_x, call.origin_y, call.heading_x, call.heading_y, call.fuel_units, call.at_ms, call.waypoints, call.selected_tier);
  const got: any = res.ok
    ? { ok: true, drone: { ...c.expected.result.drone, launch_id: undefined } }  // id is process-counter; compare shape minus id
    : { ok: false, reason: res.reason };
  // Re-derive observable result minus id from the live res for a real comparison:
  const live: any = res.ok ? {
    ok: true,
    drone: {
      home_id: res.drone.fromIslandId, origin_x: res.drone.originX, origin_y: res.drone.originY,
      heading_x: res.drone.dirX, heading_y: res.drone.dirY, trip_half_tiles: res.drone.outboundTiles,
      scan_half_width: res.drone.scanRadius, launch_at_ms: res.drone.launchTime, return_at_ms: res.drone.expectedReturnTime,
      tier: res.drone.tier, fuel_units: res.drone.fuelLoaded, fuel_kind: res.drone.fuelResource,
      status: res.drone.status, waypoints: res.drone.waypoints, dark: res.drone.darkMode, rare_bias: res.drone.probabilityBias,
    },
  } : { ok: false, reason: res.reason };
  const wantNoId = c.expected.result.ok
    ? { ok: true, drone: { ...c.expected.result.drone, launch_id: undefined } }
    : c.expected.result;
  if (live.ok) (live.drone as any).launch_id = undefined;
  check(`dispatch:${c.name}:result`, live, wantNoId);
  check(`dispatch:${c.name}:drone_count`, w.drones.length, c.expected.drone_count);
  const invAfter = Object.fromEntries(Object.keys(inp.island.inventory).map((k) => [k, o.inventory[k] ?? 0]));
  check(`dispatch:${c.name}:inventory_after`, invAfter, c.expected.inventory_after);
}

// ----- pulse -----
for (const c of g.pulse) {
  const inp = c.input;
  const o = islandState(inp.origin.id, inp.origin.level, { cryogenic_hydrogen: inp.origin.cryogenic_hydrogen }, inp.origin.has_launch_tower ? [{ defId: 'launch_tower' }] : []);
  const islands = inp.islands.map(spec);
  const w = world(islands);
  const result = firePulse(w, o, inp.at_ms);
  check(`pulse:${c.name}:result`, result, c.expected.result);
  check(`pulse:${c.name}:fuel_after`, o.inventory['cryogenic_hydrogen'] ?? 0, c.expected.fuel_after);
  check(`pulse:${c.name}:discovered_after`, Object.fromEntries(islands.map((i) => [i.id, i.discovered])), c.expected.discovered_after);
}

// ----- tick -----
for (const c of g.tick_reveal) {
  const inp = c.input;
  const islands = inp.islands.map(spec);
  const di = inp.drone;
  const d: Drone = {
    id: 'drone-1', fromIslandId: 'home', originX: di.origin_x, originY: di.origin_y,
    dirX: di.heading_x, dirY: di.heading_y, outboundTiles: di.trip_half_tiles, scanRadius: di.scan_half_width,
    launchTime: di.launch_at_ms, expectedReturnTime: di.return_at_ms, tier: di.tier, fuelLoaded: 10,
    fuelResource: 'biofuel', status: 'active', waypoints: [], darkMode: false, darkModeDiscoveries: [],
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
      returned: r.returned.length, lost: r.lost.length, drone_status: live?.status, drone_dark: live?.darkMode,
      buffer_size: live?.scanBuffer.size, revealed_cells_total: w.revealedCells.size,
    });
  }
  check(`tick:${c.name}:steps`, steps, c.expected.steps);
  check(`tick:${c.name}:discovered_after`, Object.fromEntries(islands.map((i) => [i.id, i.discovered])), c.expected.discovered_after);
}

console.log(`REPLAY CHECK: pass=${pass} fail=${fail}`);
if (fail) { for (const f of fails) console.log('FAIL ' + f); process.exit(1); }
