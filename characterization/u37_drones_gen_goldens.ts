// U37 drones characterization golden generator. Runs the ORIGINAL.
// npx tsx characterization/u37_drones_gen_goldens.ts > characterization/u37_drones_goldens.json
import {
  firePulse,
  dispatchDrone,
  probabilityBiasForIsland,
  droneCurrentPosition,
  pointToSegmentDistSq,
  tickDrones,
  _resetDroneIdCounter,
  DRONE_TIER_EFFICIENCY,
  DRONE_TIER_SCAN_RADIUS,
  DRONE_TIER_MULTIPLIERS,
  DRONE_SPEED_TILES_PER_SEC,

  DRONE_T5_SPEED_TILES_PER_SEC,
  DRONE_T5_WEATHER_MULTIPLIER,
  DRONE_T5_SCAN_RADIUS_TILES,
  MIN_FUEL_PER_DRONE,
  MAX_FUEL_PER_DRONE,
  T4_PULSE_RADIUS_TILES,
  T4_PULSE_FUEL_COST,
  type Drone,
} from '../src/drones.js';
import type { IslandSpec, WorldState } from '../src/world.js';
import { CELL_SIZE_TILES } from '../src/world.js';
import type { IslandState } from '../src/economy.js';
import { rollVehicleDestruction } from '../src/weather.js';

// ----- fixture builders (NOT part of spec; just to exercise the real code) ---
function spec(over: Partial<IslandSpec> & { id: string; cx: number; cy: number }): IslandSpec {
  return {
    name: over.id,
    biome: 'temperate' as IslandSpec['biome'],
    majorRadius: 4,
    minorRadius: 4,
    populated: false,
    discovered: false,
    buildings: [],
    modifiers: [],
    ...over,
  } as IslandSpec;
}

function islandState(over: {
  id: string;
  level?: number;
  inventory?: Record<string, number>;
  buildings?: Array<{ defId: string; x?: number; y?: number }>;
}): IslandState {
  return {
    id: over.id,
    buildings: (over.buildings ?? []).map((b) => ({ defId: b.defId, x: b.x ?? 0, y: b.y ?? 0 })) as any,
    inventory: (over.inventory ?? {}) as any,
    storageCaps: {} as any,
    xp: 0,
    level: over.level ?? 1,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
    everProduced: new Set(),
  } as unknown as IslandState;
}

function world(over: Partial<WorldState> & { seed: string }): WorldState {
  return {
    islands: [],
    drones: [],
    routes: [],
    vehicles: [],
    revealedCells: new Set<string>(),
    states: {},
    ...over,
  } as unknown as WorldState;
}

function round(v: number): number {
  // keep full precision; JSON.stringify already preserves doubles
  return v;
}

const out: any = {
  unit: 'U37',
  description:
    'Scout-drone dispatch gates, tier resolution, range=fuel*efficiency*skill, travel time, scan radius, per-tick corridor reveal with antenna-gated dark-mode buffering + flush-on-return, T4 instant pulse, T5 path-drawn drone, probability-engine rare bias, weather destruction roll (INVARIANT). RNG via replicated PRNG seeded by world seed + vehicle id.',
  // neutral keys (NOT the original export identifiers) — the rewrite is free
  // to name its own constants; goldens assert these neutral names.
  constants: {
    fuel_efficiency_by_tier: DRONE_TIER_EFFICIENCY,
    scan_radius_by_tier: DRONE_TIER_SCAN_RADIUS,
    weather_multiplier_by_tier: DRONE_TIER_MULTIPLIERS,
    straight_line_speed_tiles_per_sec: DRONE_SPEED_TILES_PER_SEC,
    path_drawn_efficiency: DRONE_TIER_EFFICIENCY[5],
    path_drawn_speed_tiles_per_sec: DRONE_T5_SPEED_TILES_PER_SEC,
    path_drawn_weather_multiplier: DRONE_T5_WEATHER_MULTIPLIER,
    path_drawn_scan_radius: DRONE_T5_SCAN_RADIUS_TILES,
    min_fuel_per_drone: MIN_FUEL_PER_DRONE,
    max_fuel_per_drone: MAX_FUEL_PER_DRONE,
    pulse_radius_tiles: T4_PULSE_RADIUS_TILES,
    pulse_fuel_cost: T4_PULSE_FUEL_COST,
    cell_size_tiles: CELL_SIZE_TILES,
  },
  probability_bias: [],
  point_to_segment_distsq: [],
  current_position: [],
  dispatch: [],
  pulse: [],
  tick_reveal: [],
  weather_roll_invariant: [],
  skill_multiplier_property: [],
};

// ---------- probabilityBiasForIsland ----------
for (const n of [0, 1, 2, 3, 4, 5]) {
  const buildings = Array.from({ length: n }, () => ({ defId: 'probability_engine' }));
  out.probability_bias.push({ engineCount: n, bias: probabilityBiasForIsland({ buildings }) });
}
out.probability_bias.push({
  name: 'mixed_nonengine_ignored',
  buildings: ['probability_engine', 'antenna_t1', 'probability_engine'],
  bias: probabilityBiasForIsland({
    buildings: [{ defId: 'probability_engine' }, { defId: 'antenna_t1' }, { defId: 'probability_engine' }],
  }),
});

// ---------- pointToSegmentDistSq ----------
const ptsCases: Array<[string, number, number, number, number, number, number]> = [
  ['degenerate_AB_equal', 5, 5, 0, 0, 0, 0],
  ['foot_inside_segment', 5, 0, 0, 0, 10, 0],
  ['clamp_before_A', -5, 0, 0, 0, 10, 0],
  ['clamp_after_B', 15, 3, 0, 0, 10, 0],
  ['on_segment_zero', 4, 0, 0, 0, 10, 0],
  ['diagonal', 0, 4, 0, 0, 4, 4],
];
for (const [name, px, py, ax, ay, bx, by] of ptsCases) {
  out.point_to_segment_distsq.push({ name, px, py, ax, ay, bx, by, distSq: pointToSegmentDistSq(px, py, ax, ay, bx, by) });
}

// ---------- droneCurrentPosition ----------
function mkDrone(over: Partial<Drone>): Drone {
  return {
    id: 'd',
    fromIslandId: 'home',
    originX: 0,
    originY: 0,
    dirX: 1,
    dirY: 0,
    outboundTiles: 30,
    scanRadius: 2,
    launchTime: 0,
    expectedReturnTime: 0,
    tier: 1,
    fuelLoaded: 20,
    fuelResource: 'biofuel' as any,
    status: 'active',
    waypoints: [],
    darkMode: false,
    darkModeDiscoveries: [],
    scanBuffer: new Set<string>(),
    probabilityBias: 0,
    ...over,
  } as Drone;
}
{
  // straight-line tier1, speed 0.5 tiles/sec, outbound 30 -> total 60.
  const d = mkDrone({ outboundTiles: 30, tier: 1, dirX: 1, dirY: 0, launchTime: 0 });
  for (const [name, t] of [
    ['at_launch', 0],
    ['outbound_half', 30000],
    ['at_apex', 60000],
    ['return_half', 90000],
    ['at_return', 120000],
    ['past_return_clamped', 999999],
  ] as Array<[string, number]>) {
    out.current_position.push({ name, kind: 'straight_line', trip_half_tiles: 30, tier: 1, heading_x: 1, heading_y: 0, speed: DRONE_SPEED_TILES_PER_SEC, at_ms: t, pos: droneCurrentPosition(d, t) });
  }
}
{
  // polyline T5
  const wp = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];
  const total = 20; // outbound path length
  const d = mkDrone({ waypoints: wp, outboundTiles: total, tier: 5, launchTime: 0 });
  for (const [name, t] of [
    ['poly_launch', 0],
    ['poly_mid_seg1', 6250], // speed 0.8 -> 5 tiles -> at (5,0)
    ['poly_apex', 25000], // 20 tiles -> (10,10)
    ['poly_return_mid', 31250], // returned 5 tiles back along reverse
    ['poly_return', 50000],
  ] as Array<[string, number]>) {
    out.current_position.push({ name, kind: 'path_drawn', waypoints: wp, trip_half_tiles: total, tier: 5, speed: DRONE_T5_SPEED_TILES_PER_SEC, at_ms: t, pos: droneCurrentPosition(d, t) });
  }
}

// ---------- dispatchDrone ----------
// REPLAYABLE: each case carries a neutral `input` block (island + call args) so
// a source-blind harness can rebuild the call from drones.json alone, plus the
// `expected` outputs. Pre-existing-drone setup (for the per-pad cap) is given as
// a list of prior dispatches under `input.pre_dispatches`.
interface DispatchInput {
  island: { id: string; level: number; inventory: Record<string, number>; probability_engines?: number };
  pre_dispatches?: Array<DispatchArgs>;
  call: DispatchArgs;
}
interface DispatchArgs {
  origin_x: number;
  origin_y: number;
  heading_x: number;
  heading_y: number;
  fuel_units: number;
  at_ms: number;
  waypoints?: Array<{ x: number; y: number }>;
  selected_tier?: number;
}

function runDispatchInput(inp: DispatchInput) {
  _resetDroneIdCounter();
  const w = world({ seed: 's' });
  const buildings = Array.from({ length: inp.island.probability_engines ?? 0 }, () => ({ defId: 'probability_engine' }));
  const o = islandState({ id: inp.island.id, level: inp.island.level, inventory: { ...inp.island.inventory }, buildings });
  for (const pd of inp.pre_dispatches ?? []) {
    dispatchDrone(w, o, pd.origin_x, pd.origin_y, pd.heading_x, pd.heading_y, pd.fuel_units, pd.at_ms, pd.waypoints, pd.selected_tier as any);
  }
  const c = inp.call;
  const res = dispatchDrone(w, o, c.origin_x, c.origin_y, c.heading_x, c.heading_y, c.fuel_units, c.at_ms, c.waypoints, c.selected_tier as any);
  return { res, world: w, island: o };
}

function dispatchCase(name: string, input: DispatchInput, note?: string) {
  const { res, world: w, island: o } = runDispatchInput(input);
  const expected: any = {
    result: serializeDispatch(res),
    drone_count: w.drones.length,
    // post-call stock of every fuel grade the input seeded (so fuel deduction is checked)
    inventory_after: Object.fromEntries(Object.keys(input.island.inventory).map((k) => [k, o.inventory[k as any] ?? 0])),
  };
  const c: any = { name, input, expected };
  if (note) c.note = note;
  out.dispatch.push(c);
}

dispatchCase('invalid_direction_zero', {
  island: { id: 'home', level: 1, inventory: { biofuel: 100 } },
  call: { origin_x: 100, origin_y: 100, heading_x: 0, heading_y: 0, fuel_units: 20, at_ms: 1000 },
});

dispatchCase('already_in_flight', {
  island: { id: 'home', level: 1, inventory: { biofuel: 100 } },
  pre_dispatches: [{ origin_x: 100, origin_y: 100, heading_x: 1, heading_y: 0, fuel_units: 20, at_ms: 1000 }],
  call: { origin_x: 100, origin_y: 100, heading_x: 0, heading_y: 1, fuel_units: 20, at_ms: 2000 },
}, 'second launch from the same pad while the first is active -> already-in-flight; drone_count stays 1');

dispatchCase('insufficient_fuel_wrong_grade', {
  // level 15 -> tier 3 -> needs aviation_kerosene; only biofuel stocked -> reject (no fallback)
  island: { id: 'home', level: 15, inventory: { biofuel: 100 } },
  call: { origin_x: 0, origin_y: 0, heading_x: 1, heading_y: 0, fuel_units: 20, at_ms: 1000 },
}, 'tier-3 island, only tier-1 fuel stocked: no fallback to a cheaper grade');

dispatchCase('insufficient_fuel_zero_loaded', {
  island: { id: 'home', level: 1, inventory: { biofuel: 100 } },
  call: { origin_x: 0, origin_y: 0, heading_x: 1, heading_y: 0, fuel_units: 0, at_ms: 1000 },
}, 'fuel_units <= 0 -> insufficient-fuel');

dispatchCase('success_t1_straightline', {
  island: { id: 'home', level: 1, inventory: { biofuel: 100 } },
  call: { origin_x: 0, origin_y: 0, heading_x: 3, heading_y: 4, fuel_units: 20, at_ms: 1000 },
}, 'heading (3,4) normalises to (0.6,0.8); fuel 20 * eff 3 = range 60 -> trip_half 30, return 1000+120000');

dispatchCase('selected_tier_lower_honored', {
  // level 50 -> tier 5; pick tier 2 -> needs diesel, leaves plasma untouched
  island: { id: 'home', level: 50, inventory: { diesel: 100, plasma_charge: 100 } },
  call: { origin_x: 0, origin_y: 0, heading_x: 1, heading_y: 0, fuel_units: 10, at_ms: 1000, selected_tier: 2 },
}, 'tier-5 island flying a tier-2 drone burns diesel, not plasma_charge');

dispatchCase('selected_tier_above_island_fallback', {
  island: { id: 'home', level: 1, inventory: { biofuel: 100, plasma_charge: 100 } },
  call: { origin_x: 0, origin_y: 0, heading_x: 1, heading_y: 0, fuel_units: 10, at_ms: 1000, selected_tier: 5 },
}, 'requested tier 5 > island tier 1 -> fallback to tier 1 (biofuel)');

dispatchCase('selected_tier_6_unreachable_via_level', {
  island: { id: 'home', level: 9999, inventory: { plasma_charge: 100, antimatter_propellant: 100 } },
  call: { origin_x: 0, origin_y: 0, heading_x: 1, heading_y: 0, fuel_units: 10, at_ms: 1000, selected_tier: 6 },
}, 'level->tier step function caps at 5, so a requested tier 6 > island tier 5 -> fallback to island tier 5 (plasma_charge), NOT antimatter_propellant');

dispatchCase('pathdrawn_t5_ok', {
  island: { id: 'home', level: 50, inventory: { plasma_charge: 100 } },
  call: { origin_x: 0, origin_y: 0, heading_x: 1, heading_y: 0, fuel_units: 10, at_ms: 1000, waypoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
}, 'path length 20, one-way 20 <= fuel 10 * tier-eff 15 = 150; tier 5, trip_half 20, return 1000+(20/0.8)*1000');

dispatchCase('pathdrawn_path_too_long', {
  island: { id: 'home', level: 50, inventory: { plasma_charge: 100 } },
  call: { origin_x: 0, origin_y: 0, heading_x: 1, heading_y: 0, fuel_units: 10, at_ms: 1000, waypoints: [{ x: 0, y: 0 }, { x: 200, y: 0 }] },
}, 'path length 200, one-way 200 > fuel 10 * tier-eff 15 = 150 -> path-too-long');

// Re-key the result onto NEUTRAL field names (not the original Drone interface
// keys). The implementer names its own record; goldens assert these neutral
// keys. Observable string VALUES (reason codes, status) are content, kept.
function serializeDispatch(res: any) {
  if (!res.ok) return { ok: false, reason: res.reason };
  const d = res.drone;
  return {
    ok: true,
    drone: {
      launch_id: d.id,
      home_id: d.fromIslandId,
      origin_x: d.originX,
      origin_y: d.originY,
      heading_x: d.dirX,
      heading_y: d.dirY,
      trip_half_tiles: d.outboundTiles,
      scan_half_width: d.scanRadius,
      launch_at_ms: d.launchTime,
      return_at_ms: d.expectedReturnTime,
      tier: d.tier,
      fuel_units: d.fuelLoaded,
      fuel_kind: d.fuelResource,
      status: d.status,
      waypoints: d.waypoints,
      dark: d.darkMode,
      rare_bias: d.probabilityBias,
    },
  };
}

// ---------- firePulse ----------
// REPLAYABLE: `input` carries the origin island (id/level/fuel/launch_tower
// present?) and the full island list (id + centre + discovered flag). The
// rewrite rebuilds the world from this and fires the pulse at `at_ms`.
interface PulseInput {
  origin: { id: string; level: number; cryogenic_hydrogen: number; has_launch_tower: boolean };
  islands: Array<{ id: string; cx: number; cy: number; populated?: boolean; discovered: boolean }>;
  at_ms: number;
}
function runPulseInput(inp: PulseInput) {
  const o = islandState({
    id: inp.origin.id,
    level: inp.origin.level,
    inventory: { cryogenic_hydrogen: inp.origin.cryogenic_hydrogen },
    buildings: inp.origin.has_launch_tower ? [{ defId: 'launch_tower' }] : [],
  });
  const islands = inp.islands.map((i) =>
    spec({ id: i.id, cx: i.cx, cy: i.cy, populated: i.populated ?? false, discovered: i.discovered }),
  );
  const w = world({ seed: 's', islands });
  const result = firePulse(w, o, inp.at_ms);
  return { result, fuelAfter: o.inventory['cryogenic_hydrogen'], islands };
}
function pulseCase(name: string, input: PulseInput, note?: string) {
  const { result, fuelAfter, islands } = runPulseInput(input);
  const c: any = {
    name,
    input,
    expected: {
      result,
      fuel_after: fuelAfter,
      discovered_after: Object.fromEntries(islands.map((i) => [i.id, i.discovered])),
    },
  };
  if (note) c.note = note;
  out.pulse.push(c);
}

pulseCase('no_launch_tower', {
  origin: { id: 'home', level: 30, cryogenic_hydrogen: 100, has_launch_tower: false },
  islands: [{ id: 'home', cx: 0, cy: 0, populated: true, discovered: true }],
  at_ms: 0,
});
pulseCase('tier_too_low', {
  origin: { id: 'home', level: 1, cryogenic_hydrogen: 100, has_launch_tower: true },
  islands: [{ id: 'home', cx: 0, cy: 0, populated: true, discovered: true }],
  at_ms: 0,
});
pulseCase('insufficient_fuel', {
  origin: { id: 'home', level: 30, cryogenic_hydrogen: 5, has_launch_tower: true },
  islands: [{ id: 'home', cx: 0, cy: 0, populated: true, discovered: true }],
  at_ms: 0,
});
pulseCase('no_origin_spec', {
  origin: { id: 'home', level: 30, cryogenic_hydrogen: 100, has_launch_tower: true },
  islands: [],
  at_ms: 0,
}, 'origin id absent from the island list -> no-origin-spec');
pulseCase('success_reveals_within_radius', {
  // radius 48 inclusive: dist 0(home), 10(already), 30(in), 48(edge -> in), 49(out)
  origin: { id: 'home', level: 30, cryogenic_hydrogen: 100, has_launch_tower: true },
  islands: [
    { id: 'home', cx: 0, cy: 0, populated: true, discovered: true },
    { id: 'isl_in', cx: 30, cy: 0, discovered: false },
    { id: 'isl_edge', cx: 48, cy: 0, discovered: false },
    { id: 'isl_out', cx: 49, cy: 0, discovered: false },
    { id: 'isl_already', cx: 10, cy: 0, discovered: true },
  ],
  at_ms: 12345,
}, 'reveals isl_in + isl_edge (48 inclusive); isl_out (49) excluded; fuel 100->90; fires regardless of count');

// ---------- tickDrones corridor reveal ----------
// REPLAYABLE: each case carries an `input` block describing the world (islands +
// optional antenna emitter + optional probability engines on home) and ONE drone
// built directly from neutral fields (NOT dispatched — so we can set an arbitrary
// scan half-width to isolate the bias widening), plus a tick schedule. The runner
// rebuilds the drone object, pre-generates cells so island generation is a no-op,
// and replays the ticks. `expected` carries the per-tick deltas and final state.
interface TickIslandInput {
  id: string;
  cx: number;
  cy: number;
  populated?: boolean;
  discovered: boolean;
  modifiers?: string[];
  antenna?: string; // content id of an antenna building on this (populated) island, e.g. antenna_t6
}
interface TickDroneInput {
  origin_x: number;
  origin_y: number;
  heading_x: number;
  heading_y: number;
  trip_half_tiles: number;
  scan_half_width: number;
  launch_at_ms: number;
  return_at_ms: number;
  tier: number;
  rare_bias: number;
}
interface TickStep {
  label: string;
  prev_ms: number;
  now_ms: number;
}
interface TickInput {
  islands: TickIslandInput[];
  drone: TickDroneInput;
  pre_generate_cells_radius?: number; // tiles; pre-mint cells so generation is deterministic no-op
  steps: TickStep[];
}

function buildTickDrone(di: TickDroneInput): Drone {
  return mkDrone({
    originX: di.origin_x,
    originY: di.origin_y,
    dirX: di.heading_x,
    dirY: di.heading_y,
    outboundTiles: di.trip_half_tiles,
    scanRadius: di.scan_half_width,
    launchTime: di.launch_at_ms,
    expectedReturnTime: di.return_at_ms,
    tier: di.tier as any,
    probabilityBias: di.rare_bias,
    status: 'active',
  });
}

function runTickInput(inp: TickInput) {
  const islands = inp.islands.map((i) =>
    spec({
      id: i.id,
      cx: i.cx,
      cy: i.cy,
      populated: i.populated ?? false,
      discovered: i.discovered,
      modifiers: (i.modifiers ?? []) as any,
      buildings: i.antenna ? [{ defId: i.antenna, x: 0, y: 0 } as any] : [],
    }),
  );
  const d = buildTickDrone(inp.drone);
  const w = world({ seed: 's', islands, drones: [d] });
  if (inp.pre_generate_cells_radius !== undefined) {
    (w as any).generatedCells = preGen(d.originX, d.originY, inp.pre_generate_cells_radius);
  }
  const stepResults: any[] = [];
  for (const s of inp.steps) {
    const r = tickDrones(w, s.now_ms, s.prev_ms);
    const live = w.drones.find((x) => x.id === d.id);
    stepResults.push({
      label: s.label,
      revealed_cells_added: r.revealedCellsAdded,
      newly_discovered: r.newlyDiscoveredIslandIds,
      returned: r.returned.length,
      lost: r.lost.length,
      drone_status: live?.status,
      drone_dark: live?.darkMode,
      buffer_size: live?.scanBuffer.size,
      revealed_cells_total: w.revealedCells.size,
    });
  }
  return { stepResults, islands, world: w };
}

function tickCase(name: string, input: TickInput, note?: string) {
  const { stepResults, islands } = runTickInput(input);
  const c: any = {
    name,
    input,
    expected: {
      steps: stepResults,
      discovered_after: Object.fromEntries(islands.map((i) => [i.id, i.discovered])),
    },
  };
  if (note) c.note = note;
  out.tick_reveal.push(c);
}

// In-antenna-range flush: a populated island with a tier-6 antenna covering the
// whole flight. One full-flight tick reveals immediately; buffer ends empty.
// Tier-1 drone: fuel 10, eff 3 -> range 30 -> trip_half 15; return at (30/0.5)*1000.
tickCase('in_range_flushes_cells', {
  islands: [{ id: 'home', cx: 0, cy: 0, populated: true, discovered: true, antenna: 'antenna_t6' }],
  drone: {
    origin_x: 0.5, origin_y: 0.5, heading_x: 1, heading_y: 0,
    trip_half_tiles: 15, scan_half_width: 2, launch_at_ms: 0, return_at_ms: 60000, tier: 1, rare_bias: 0,
  },
  pre_generate_cells_radius: 200,
  steps: [{ label: 'full_flight', prev_ms: 0, now_ms: 60000 }],
}, 'antenna covers the flight: single full-flight tick reveals corridor immediately, buffer empties, status returned');

// Out-of-antenna-range corridor drone: dark-mode buffering then flush on return.
tickCase('dark_mode_buffers_then_flush_on_return', {
  islands: [{ id: 'home', cx: 0, cy: 0, populated: true, discovered: true }],
  drone: {
    origin_x: 0.5, origin_y: 0.5, heading_x: 1, heading_y: 0,
    trip_half_tiles: 15, scan_half_width: 2, launch_at_ms: 0, return_at_ms: 60000, tier: 1, rare_bias: 0,
  },
  pre_generate_cells_radius: 200,
  steps: [
    { label: 'mid_flight_dark', prev_ms: 0, now_ms: 30000 },
    { label: 'return', prev_ms: 30000, now_ms: 60001 },
  ],
}, 'no antenna: mid tick buffers (dark, 0 revealed); return tick flushes. This path lies entirely in CLEAR weather (destruction chance 0), so the drone survives DETERMINISTICALLY regardless of RNG — the whole golden (incl. returned=1, status=returned, 6 revealed on the return step) is EXACT and replayable. The INVARIANT weather roll only matters where the path crosses storm/severe/catastrophic cells (§9).');

// Rare-island bias bypasses the antenna gate AND the (1+bias) widening reaches
// an island the base corridor misses. Drone has NO antenna (pure dark), scan
// half-width 40, rare_bias 0.6 -> expanded 64. A rare island (>=2 modifiers)
// sits in a cell only the EXPANDED corridor covers; an ordinary island sits in
// the same expanded-only band. Mid-flight, still dark: the rare island flips
// discovered (bias bypasses the antenna gate AND needs the widening), while the
// ordinary one does NOT (no bias widening for non-rare; no reveal in dark).
tickCase('rare_bias_widening_bypasses_antenna_gate', {
  islands: [
    { id: 'home', cx: 0, cy: 0, populated: true, discovered: true },
    // cell (3,-4) center ~ (56,-56): only-in-expanded for the line y=0.5, base 40 vs expanded 64.
    { id: 'rare_one', cx: 56, cy: -56, discovered: false, modifiers: ['aetheric_anomaly', 'volcanic'] },
    { id: 'plain_one', cx: 40, cy: -56, discovered: false, modifiers: [] },
  ],
  drone: {
    origin_x: 0.5, origin_y: 0.5, heading_x: 1, heading_y: 0,
    trip_half_tiles: 100, scan_half_width: 40, launch_at_ms: 0, return_at_ms: 400000, tier: 1, rare_bias: 0.6,
  },
  pre_generate_cells_radius: 400,
  steps: [{ label: 'mid_flight_dark', prev_ms: 0, now_ms: 200000 }],
}, 'rare island in the expanded-only band flips discovered mid-flight in dark mode (bias bypasses antenna gate; widening reaches it); ordinary island in the same band stays undiscovered.');

// ---------- weather roll INVARIANT property ----------
// Pin the documented property: roll uses seed `${worldSeed}_vehicle_${vehicleId}`,
// per-cell chance = base[state] * tierMultiplier. We expose enough to property-check
// the rewrite's OWN output rather than golden a destroyed/survived boolean.
out.weather_roll_invariant.push({
  property: 'seed_format',
  value: '`${worldSeed}_vehicle_${vehicleId}`',
});
out.weather_roll_invariant.push({
  property: 'final_chance',
  value: 'WEATHER_DESTRUCTION_CHANCE[cellState] * tierMultiplier, per rasterized path cell; first cell whose rng()<finalChance destroys',
  tierMultipliers: DRONE_TIER_MULTIPLIERS,
});
// Demonstrate determinism: identical (seed, path, multiplier, vehicleId) -> identical result.
{
  const path = Array.from({ length: 20 }, (_, i) => ({ cx: i, cy: 0, entryMs: i * 1000 }));
  const a = rollVehicleDestruction('seedX', path, 1.5, 'drone-1');
  const b = rollVehicleDestruction('seedX', path, 1.5, 'drone-1');
  const cDiffId = rollVehicleDestruction('seedX', path, 1.5, 'drone-2');
  out.weather_roll_invariant.push({
    property: 'deterministic_replay',
    sameSeedSameVehicle_equal: JSON.stringify(a) === JSON.stringify(b),
    differentVehicle_independentStream: JSON.stringify(a) !== JSON.stringify(cDiffId) || 'may_coincide',
  });
}

// Skill-multiplier path: all live goldens use the no-skill island (both
// multipliers = 1), so the dispatch goldens above pin the mult=1 arithmetic.
// The multiplier APPLICATION is pinned here as a property the rewrite must
// satisfy (a non-1 multiplier must scale the corresponding output), not as a
// captured value — exercising it live requires a fully-built skill graph,
// which is out of this unit's scope.
out.skill_multiplier_property.push({
  property: 'fuel_efficiency_multiplier',
  rule: 'range = fuel_units * fuel_efficiency_by_tier[tier] * fuel_efficiency_multiplier; with mult>1 the outbound (trip_half_tiles) and return time grow proportionally; the fuel cost (fuel_units deducted) is unchanged.',
  baseline_mul: 1,
});
out.skill_multiplier_property.push({
  property: 'scan_radius_multiplier',
  rule: 'scan_half_width = scan_radius_by_tier[tier] * scan_radius_multiplier; with mult>1 the corridor widens proportionally.',
  baseline_mul: 1,
});

function preGen(cx: number, cy: number, span: number): Set<string> {
  const s = new Set<string>();
  const r = Math.ceil(span / CELL_SIZE_TILES) + 2;
  const ccx = Math.floor(cx / CELL_SIZE_TILES);
  const ccy = Math.floor(cy / CELL_SIZE_TILES);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) s.add(`${ccx + dx},${ccy + dy}`);
  return s;
}

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
