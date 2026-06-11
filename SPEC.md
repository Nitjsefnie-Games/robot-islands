# Robot Islands: Specification

A browser-based 2D idle game. The player roleplays a self-expanding industrial robot intelligence growing across an infinite world of discrete islands. The robot discovers, develops, and networks islands into a production empire, climbing through five technology tiers culminating in post-physics transcendence.

\---

## Implementation Status

Per-section snapshot of what is live in the code today. Sections not
listed are fully implemented. For the granular punch list (sub-mechanics,
catalog gaps, UI deferrals) see `TODO.md`.

Legend: **L** = live · **P** = partial · **N** = not implemented.

| Section | Status | Notes |
|---|---|---|
| §2.1 Stratified placement | L | Lazy per-cell generation via `ensureCellGenerated`; boot sweep handles cells in `[-10, +10]²`, lazy hook extends infinitely as drones / satellites enter new cells. Single island per cell, density 0.08, overlap buffer 16 tiles. |
| §2.2 Discovery via drones | L | T1 / T2 / T3 / T4 / T5 dispatch; Drone Pad (T2) is the gate, launchable drone tier ranges from T1 up to current island tier. |
| §2.3 Settlement | P | Vehicle dispatch + arrival + Foundation Kit. Per-tier vehicle stats (speed, range, loadout, failureRate, weatherMul) for both ships and helicopters via SHIP_STATS / HELICOPTER_STATS. T5 Spacetime Anchor bypass not implemented. |
| §2.4 Inter-island routes | P | Cargo / drone / airship / mass_driver / teleporter / cable types. Teleporter routes consume per-tile biofuel so the Network skill has a primary scaling axis. Mass-driver routes consume Diesel per dispatch volume per §9.5; T5 spacetime-anchor routes not implemented as a distinct dispatch path (the enum exists; cables already cover power-link semantics). Priority-list dispatch with drag-to-reorder UI in the routes ledger. |
| §2.5 Artificial islands | L | T3 / T4 / T5 founder caps in `MAX_RADIUS_BY_TIER` (8 / 12 / 16). |
| §2.6 Weather | L | Forecast model, biome modulation, vehicle destruction rolls, route capacity modulation, in-flight loss, satellite immunity. Map overlay snaps to vision cells. |
| §2.7 Day-night cycle | L | Solar multiplier per phase, weather-phase modulation (+25% severe-storm Night/Dawn), full-viewport tint overlay. |
| §3.1-3.4 Island spec / biomes / tile types / shape | L | All six biomes, ellipse geometry, Land Reclamation expansion, max-size table. |
| §3.5 Modifiers | L | Roll distribution, biome-tagged sampling, Stable exclusivity. High Wind variance + +50% wind-power. Cursed Storms -10% global prod + 2× rare-find trickle (Mining helium_3 + Forestry exotic-species) via `rareFindMul`. |
| §3.6 Joining | L | Geometric overlap detection, largest-absorbs, ellipse list, building global coords via offsets, route redirect/delete, modifier voiding. |
| §3.7 Starting state | L | Empty home Plains island, Drone Pad gated at L5. Starter inventory ships as `60 stone + 40 wood + 1 Foundation Kit` (bootstrap deviation from the §3.7 literal — see §3.7 Implementation note). |
| §4.1-4.3 Building footprint / rotation / placement | L | All shape masks, 4 rotations, terrain-requirement gates. |
| §4.4 Adjacency rules | L | 4-neighbor metadata computation. |
| §4.5 Adjacency effects | L | Heat (§5.2), reactor toxicity, §8.7 Exhaust Scrubber (soft-gate on coke_oven / naphtha_cracker / lubricant_refinery / diesel_refinery), and §8.7 Wastewater Treatment (soft-gate on sulfuric_acid_plant / hcl_plant / chlor_alkali_plant). Crystal Lab building absent, so the Cooling Tower → Crystal Lab gate has no consumers. |
| §4.6 Storage caps | L | Specialized + generic storage, per-resource caps, destruction clamping. |
| §4.7 Maintenance | P | Operating-time accrual, threshold + 4h linear degrade, auto-maintain materials check, atomic recipe consumption, most-degraded targeting policy. Only buildings with productive recipe outputs accrue operating time — power producers / storage / antennas / drone pads / shipyards skip accrual since their maintenance factor has no effect on output. Eternal Servitor flag is honoured; Servitor Conversion Kit + Reality Forge mechanic (`convertToServitor` in `buildings.ts`, inspector UI button) is L. |
| §5.1 Electrical grid | L | Per-island brownout factor, active-only summing, gating predicate. |
| §5.2 Heat adjacency | L | N:1 source assignment, free-source priority, fuel-burn scaling with served count. |
| §5.3 Inter-island power | L | Per-component binary-gated unified pool: gate passes iff Σ cable capacity ≥ min(Σ per-island surplus, Σ per-island deficit). Unified component shares one brownout `min(1, ΣP/ΣC)`; gate fail = cables inert that tick. T5 Spacetime Anchor route counts as infinite-capacity (always passes). |
| §6 Resource catalog | P | T0-T5 raws/intermediates/components mostly complete. Cold-Storage temperature-sensitive resources (`liquid_nitrogen`, `cryo_coolant`, `cryogenic_compound`) present in `recipes.ts` and `storage-categories.ts`; Cold Storage has live consumers (cryo\_compound\_lab consumes liquid\_nitrogen + cryo\_coolant; cryogenic\_generator consumes cryo\_coolant). A handful of T2-T3 minor intermediates (e.g. Bearing) absent — substitutions noted at use sites. |
| §6.7 Byproducts + demolition | P | Scrap recovery on demolish; Oxygen Converter consumes scrap. Spec's "2 Scrap = 1 Pig iron co-input at Steel Mill" N. |
| §7 Recipe chains | P | Iron/steel, copper, aluminum, oil/petrochem, glass, electronics, construction, power components, mechanical, T4 endgame, T5 transcendent: all chains have producers. Chlor-alkali downstream present (chlorine→Lubricant Refinery, sodium_hydroxide→Bauxite Refinery, chemical_reactor co-outputs both); a few minor T2-T3 intermediates remain absent (e.g. Bearing — substitutions noted at use sites). |
| §8 Building catalog | P | All §8.1-§8.10 buildings exist as catalog rows with placement cost + power values. All named T5 buildings are implemented: Reality Forge (live recipe + Servitor Conversion mechanic), Singularity Battery (wired into §5.1 brownout buffer), Spacetime Resonator multi-output rotation (`rotateOutputs`), Universe Editor (`editIslandBiome`), Probability Engine (live drone scan-radius bias in `drones.ts`), Genesis Chamber (free-creation mechanic in `economy.ts`). No T5 buildings remain as inert visual rows. |
| §9.1 Per-island levels | L | Polynomial-then-exponential XP curve. Skill-point grant: `max(1, floor(1.031^level))`. |
| §9.2 Tier breakpoints | L | T1-T5 by level; T6 by Ascendant-Core-crafted + Spaceport. |
| §9.3 Skill tree | L | Directed graph: 5 branches × 4 sub-paths = 20 sub-paths. Each sub-path is a chain of filler nodes + hand-curated notables + keystones. Total ~357 nodes (246 filler + 111 notables/keystones). Purchases use `costToUnlock` (Dijkstra over the graph from owned nodes) and `buyNode` (charges cheapest-path SP cost, auto-owns intermediates). Threshold-bridges activate when branch-SP spent crosses a threshold. Keystone AND-prereqs gate deep nodes. Aura-bearing notables amplify adjacent owned nodes up to ×1.50. Depth→tier purchase gate via `tierRequiredForDepth` / `depthTierEligible` (depths 3/4/5/8 require T3/T4/T5/T6), enforced in `buyNode` and as a path-exclusion in `costToUnlock`; no sub-path commitment lock. |
| §9.5 Biome-locked uniques | L | All six biome uniques in catalog; placement gated by biome; artificial-island block honoured. |
| §9.6 Network Consciousness | P | Network reachability + 3/5/10/20-island milestone tiers + global production buff. Auto-Patronage at 10-island milestone (3 default routes from nearest Patron Hub) L. |
| §9.7 Tier Reset | L | Reset logic + cost formula + cooldown + spec'd preserve/clear sets. Merged-island reset operates on the absorber's IslandState transparently (no merge-specific code needed). UI cost preview in the Skill Tree's reset row + confirm dialog. |
| §9.8 Trade Offers | L | Signal Exchange (T1 logistics) building + online-only expiring barter offers (`trade.ts`/`trade-ui.ts`). Ever-produced get-gate, fill-biased give/get pick, tier-reach cap, `xp_weight`-ratio pricing × `0.8^Δtier` spread, size cap to give-stock % clamped to output headroom; accept grants no XP. Persisted per-island online-time cooldown (`tradeCooldownMs`, refresh-proof) + 1%/accept compounding speedup floored at ~1 min (`tradeAcceptCount`), both at schema v20. Logistics-Network skill cluster tunes frequency/size/reach/spread. Offers themselves ephemeral (not serialized). |
| §9.9 Active-play production bonus | L | +0.1%/min focused, −0.3%/min away (incl. closed), floor 0, no cap; world-level recipe-rate multiplier, schema v22. |
| §10 Funneling | L | Per-resource consumed-on-route XP bonus while below T3. |
| §11 Drones | P | T1/T2/T3 drone dispatch via Drone Pad; T4 omnidirectional pulse via Launch Tower; T5 path-drawn via Path Drone Foundry. Drone Pad (T2) is the gate; once built, the tier picker lets the player launch any tier from T1 up to the launching island's current tier (T1 = biofuel = cheap entry option for short scouts). Fuel auto-computed per click. |
| §11.7 Fuel / range / dispatch | L | Per-tier fuel matching, range = fuel × efficiency, per-craft concurrency caps, lost-on-timeout failure model. |
| §12 Settlement vehicles | P | Ship + helicopter dispatch + arrival + Foundation Kit for T1-T4. Per-tier vehicle stats per `SHIP_STATS` / `HELICOPTER_STATS`; T5 Spacetime Anchor bypass N. Auto-placed dock lands at island centre regardless of geometry. |
| §13.1 T5 access | L | Level 50 + AI core flip. |
| §13.2-13.3 T5 buildings + capabilities | P | Time Lock (banking + spending + acceleration queue). Path Drone Foundry. Lattice Node + Omniscient Lattice activation + unified-inventory pool + cross-island adjacency. Singularity Battery power-buffer charges from surplus and discharges into deficits via the §5.1 brownout path. Spacetime Resonator + Aetheric Conduit multi-output rotation via `rotateOutputs`. Universe Editor biome reassignment (`editIslandBiome` in `universe-editor.ts` + inspector UI). Eternal Servitor (`convertToServitor` + inspector Convert button when a Reality Forge is present). Genesis Chamber, Probability Engine N. |
| §13.4 Endgame goals | L | Three artifacts (Genesis Cell, Omniscient Lattice activation, Ascendant Core) all craftable / activatable. Per spec there is **no win screen** — the game continues indefinitely; no banner / popup / acknowledgement fires when artifacts complete. |
| §14.1 T6 access | L | Per-island gate (Ascendant Core + Spaceport). |
| §14.2 Buildings | L | Spaceport + Orbital Tracking Station exist. Spaceport tier I/II/III in-place upgrade lifecycle (`upgradeSpaceport` consumes the §14.2 cost table and bumps `placed.tier` in place; UI affordance in the orbital modal). T6 Antenna doubles as a satellite dish: its signal radius adds to ground-station comm range when present on a launching island. |
| §14.3 Satellite variants | L | Scanner / Sweeper / Relay variants buildable from a Spaceport. Stat ceilings scale with Spaceport tier. |
| §14.4 Communication network | L | Asymmetric comm radius, store-and-forward buffers per sat (cap configurable via Communication skill), packet hand-off through connected graph. |
| §14.5 Coverage / discovery / weather | L | Scanner Sat weather visibility + per-cell dwell-ramp discovery (rate configurable via Discovery skill). |
| §14.6 Movement | L | Onboard fuel reserve (Resilience-skill multiplied), move-command spends fuel proportional to distance, low-probability failure manifests as a 5–20% misdrop in a random direction with extra fuel burned for the offset (clamped to 0 — sat stranded, recoverable via Repair Drone). |
| §14.7 Launch + failure | L | Success rate = base + Launch-skill bonuses, clamped 0-0.99. Pad-explosion / orbit-explosion split (~30/70, divisible by Launch-skill mitigation). Pad explosion reverts the Spaceport to tier I (upgrade investment lost; building persists). |
| §14.8 Debris | L | Per-cell field with discrete fragment count, hit-probability formula, lodge vs destruction split, Kessler cascade, Orbital Tracking Station detection range, Sweeper cleanup over real time. |
| §14.9 Orbital skill sub-path | L | Four sub-paths (Launch / Communication / Discovery / Resilience) drive live mechanics. |
| §14.10 Recipes | P | Satellite variant recipes use some substitutions where the spec ingredient is absent from the catalog. Antimatter Propellant production present. Orbital Insertion Package present. |
| §14.11 Tier interactions | L | Scanner Sats extend weather visibility; T5 path drones get partial dark-mode mitigation through sat coverage; Mass Driver vs Spaceport distinction respected. |
| §14.12 Repair Drone operations | L | Repair Pack consumption, smaller fuel load, ~50% travel time, target lock-out + pending-repair state, mechanical-failure roll (Resilience-skill divisible), restore lodges + refuel on success. |
| §15.1 Data structures | L | World / Island / PlacedBuilding / Route / Drone / SettlementVehicle / Satellite / DebrisField shapes all match spec. |
| §15.2 Tick model | L | Per-island advance + global route/drone/vehicle/sat ticks. |
| §15.3 Piecewise integration | L | Event-driven `findNextCapEvent` with cap/floor/maintenance/construction boundaries; offline-catchup handles 24h+ gaps. |
| §15.4 Inter-island flow | L | Proportional distribution under contention. |
| §15.5 Offline math | L | Persisted state survives reload; `lastTick` shifts to current perf-clock domain; weather/toxicity rolls deterministic at any catchup duration. |
| §15.6 Stack | L | Vite 5 + TypeScript strict + PixiJS 8 + vitest. No React, no backend, fully client-side. |
| §15.7 Build order | — | Reference ordering, not a runtime concern. |

\---

## 1\. Core Loop

**Moment-to-moment:** view an island, place buildings, plan adjacency, dispatch drones, manage routes between islands, spend skill points.

**Session-to-session:** islands accrue XP and resources while the player is offline. On return, the player spends accumulated skill points, redirects production, founds or funnels new colonies, pushes drones into unexplored regions, advances toward T4/T5 endgame artifacts.

**Long-term:** drive as many islands as possible up the tier ladder; build a transcendent network governed by T5 constructs (Ascendant Core, Genesis Cell, Omniscient Lattice).

\---

## 2\. World Architecture

### 2.1 Stratified Island Placement

The world is partitioned into invisible square cells of side R (the discovery guarantee radius). Each cell holds at most one island, placed at a random point within the cell using a deterministic seed. The point is the cell centre plus a uniform jitter of ±40% of the cell extent on each axis, snapped to integer tile coordinates. (The ±40% margin off the cell edge reduces inter-cell collisions but does not guarantee an island fits entirely inside its cell; the inter-island spacing check below is the actual overlap guard.) Cell (0,0) is unconditionally reserved for the home island and never receives a generated island. The first-island roll is `density = 0.02` placeholder; cells that fail the roll stay open ocean. Inter-island spacing is enforced by a 16-tile buffer between ellipse edges — a candidate that would land too close to any already-placed neighbour drops, and the cell stays empty.

**Implementation note — ocean terrain layer.** The ocean between islands carries a sparse `World.oceanCells: Map<string, OceanCellSpec>` keyed `"cellX,cellY"`. Cells absent from the map are implicit `'deep'` (the default tier). Five terrain types are seeded during `generateWorld` (after island placement) via `generateOceanTerrain` in `src/ocean-gen.ts`: `'shallows'` (within R=2 cells of any island edge), `'trench'` (0–3 per world; 2×N or rare 3×N rectangles, N=4–8), `'nodule_field'` (2–5 per world; 3×3 clusters in deep zones >R=8 from any island edge), `'hydrothermal_vent'` (0–3 per Volcanic island; 2×2/3×2/2×3 clusters within R=5 cells of the island edge), and `'deep'` (default; not stored). Non-overlap: nodule fields never overwrite trenches; vents never overwrite trenches or nodule fields. Each feature pass uses an isolated RNG stream (`${seed}_ocean_<feature>`) to prevent future generation steps from perturbing existing seeds. Full terrain + building catalog and recipe depth are specified in `docs/superpowers/specs/2026-05-18-ocean-layer-design.md` §2–§6.

The player only sees discovered islands. The cell grid is invisible. From the player's perspective the world is procedurally random; from the engine's perspective it is fully seed-deterministic.

**Implementation note — biome selection.** Once a cell passes the density gate, its island's biome is drawn from a weighted distribution in `world-gen.ts` `rollBiome`. Current weights are a placeholder (sum 100, treated as percentages): `plains` 25, `forest` 20, `coast` 15, `volcanic` 10, `desert` 15, `arctic` 15. These values have no principled basis; they were set from the task brief at §15.7 step 6 and should be rebalanced when biome-encounter pacing is tuned.

### 2.2 Discovery via Drones

Drones discover islands but cannot settle them. A discovered island appears on the world map but cannot be developed, built on, or used as a route endpoint until it has been populated by a settlement vehicle (see Section 2.3). Drones are dispatched from any island with a Drone Pad. Each launch specifies:

* Origin island
* Direction vector (normalized)
* Fuel loaded (determines range)
* Drone tier (determines speed, scan radius, special capabilities)

Drones travel in real time. They scan for islands within a corridor along their path (corridor width determined by drone tier and scan radius). On return, they report all islands discovered.

**Vision also discovers.** Beyond drones, satellites (§14), and the T4 pulse (§11.5), any island that an active *vision source* overlaps is discovered automatically — no sortie required. Vision sources are a populated island's padded vision halo and a Lighthouse's vision circle (radius by Lighthouse tier). Discovery uses the same any-cell overlap rule as drone scans: an island is found the moment any of its footprint cells lands inside any vision source, and discovery is monotonic — once found it stays found even after vision recedes (it then renders on the steel-blue "discovered" tier). A high-tier Lighthouse therefore reveals every island within its radius at once; drones and satellites remain the tools for reaching islands beyond any vision source. Discovery is whole-island: when a source touches any part of an island, its full footprint is revealed (every cell it occupies), so no part renders as fog even if the vision source covered only an edge — the same whole-island reveal drone discovery performs. Only the island itself is revealed; the surrounding seabed terrain still requires a drone or depth scan to read.

Drones can fail and never return. Failure modes (per §11.4): fuel exhaustion mid-journey, or destruction by weather (per-cell roll, see §2.6). Fuel is a real game resource produced by infrastructure on the launching island; fuel grade matches the launching island's tier per §11.7.

**Drone tiers.** Drone Pad (T2) gates drone launches; once built, the player can launch any drone tier from T1 up to the launching island's current tier. T1 drones are the entry option (biofuel-fueled, short range); higher tiers cost richer fuel grades but fly farther and are more weather-rugged:

* T1 drone: cheap entry option — biofuel-fueled, short range, narrow scan corridor; the most weather-fragile tier
* T2 drone: modest range, modest scan corridor, biome-type detection at distance
* T3 drone: long-range expedition, wider scan, multi-target (records all islands within capsule corridor)
* T4 drone: omnidirectional pulse, launched from a Launch Tower — single disk scan of radius `R\_T4 = 3R` centered on the launch site, where `R` is the stratification cell side length (placeholder: T4 pulse covers a 3-cell-radius disk)

### 2.3 Settlement

Discovered islands are not usable until populated. Population is performed by sending a settlement vehicle (ship or helicopter) from a populated island to the target. On arrival, the target becomes a populated island at level 1, with no buildings except an automatically placed dock or helipad matching the arriving vehicle type. The island is then ready for development.

**Ship**

* Launched from a Shipyard (T1, requires coastal placement)
* Slower travel
* Larger cargo loadout, longer effective range per fuel unit
* Drops a Cargo Dock on arrival (enables T1 cargo routes immediately)
* Cheaper per settlement, but commits more time

**Helicopter**

* Launched from a Helipad (T2)
* Faster travel
* Smaller cargo loadout, shorter range per fuel unit
* Higher fuel consumption
* Drops a Helipad on arrival (enables drone and helicopter operation)
* More expensive per settlement, but fast

Both vehicles consume:

* Fuel matching their tier
* A Foundation Kit (a composite craftable: bundle of T1 raw materials used to establish initial infrastructure on arrival)

Both vehicles can fail with low probability (lost at sea or crashed). On failure, the vehicle, its fuel, and its Foundation Kit are lost; the target island remains unpopulated and can be retried.

**Vehicle tiers** track the launching island's tier:

* T1 Cargo Ship / T2 Light Helicopter: short to medium range
* T2 Heavy Freighter / T3 Heavy Lift Helicopter: longer range, larger loadout
* T3 Industrial Carrier / T4 VTOL Tilt-Rotor: very long range, fast, large loadout
* T5 Spacetime Anchor populates instantaneously and bypasses the vehicle stage entirely (one of its T5 unique abilities)

**Discovery and settlement pipeline:**

1. Drone scouts and discovers (cheap reconnaissance)
2. Ship or helicopter settles (commits Foundation Kit + fuel + vehicle)
3. Player develops via building, leveling, and funneling

### 2.4 Inter-Island Routes

Routes connect islands and move resources between them. Each route specifies:

* Source island, destination island
* Transport type (cargo, drone, cable, teleporter)
* Capacity per second
* Resource filter (specific resource or any)

Per global tick, each route moves `min(capacity \* elapsed\_time, available\_at\_source, capacity\_at\_destination)` of the filtered resource.

If multiple routes contend for the same resource at one source, the available amount is distributed proportionally to route capacity.

**`filter = any` selection rule.** A route configured with `filter = any` also stores a player-defined priority list — an ordered list of resource IDs. Each tick, the route attempts to move resources in priority order: it moves as much of priority-1 as the per-tick capacity allows, then continues to priority-2 with remaining capacity, and so on. Resources not on the priority list are not moved by this route. The player edits the priority list at any time from the route configuration UI; reordering takes effect on the next tick. This makes "any" routes behave as configurable bulk movers rather than as undefined catch-alls.

**Transit time.** Routes use a hybrid latency model:

* T1 cargo, T2 drone cargo, T3 airship: resources have a real-time-of-flight equal to `distance / route\_speed` (route speeds per tier are tuning placeholders). The §15.4 throughput formula gates dispatch (units only leave source if the destination has cap headroom at dispatch time). Units in flight then appear at destination on arrival.
* T4 teleporter and T5 spacetime anchor: zero latency. Resources move instantly per tick, exactly as the basic throughput formula describes. No in-flight buffer.

In-flight inventory is tracked per-route in the architecture data model (§15.1). When a route is destroyed mid-flight, all in-flight units on that route are lost.

**Networked islands** (used elsewhere in this spec — §9.6 NC buff, §13.3 Omniscient Lattice — to define the buff target set): an island is networked if there exists a path of routes (any tier, any type) from it back to the home island. Routes form a directed graph; reachability is computed undirected (a route from A to B counts toward connectedness regardless of source-vs-destination role). Newly settled colonies start non-networked until the player builds an outbound route. Disconnected sub-graphs are independent, and only the connected component containing the home island counts as "the network".

**Transport tiers:**

* T1 cargo: short range, low throughput, slow travel
* T2 drone cargo: longer range, higher throughput, fuel cost
* T3 airship: very long range, high throughput, fuel + lubricant cost
* T4 teleporter pad: instant, very high throughput, paired endpoints, high power draw
* T5 spacetime anchor: links islands as one logical unit, ignores distance entirely

### 2.5 Artificial Islands

A T3+ island with a Platform Constructor building can construct an artificial island. Construction consumes large amounts of materials, scales with target size and biome. The material cost is `tileCount × LAND_TILE_COST × biome surcharge`, where `tileCount ≈ π × major × minor` (the ellipse area), `LAND_TILE_COST` is the shared per-land-tile structural basket (`building-defs.ts`), and Volcanic/Arctic carry a ×1.5 surcharge.

Artificial islands:

* Start at level 1
* Have a chosen biome (subject to constraints)
* Have a chosen size (capped by founder's tier, expressed as ellipse radii — T3 founder caps at major=8, minor=8; T4 caps at 12,12; T5 caps at 16,16). Artificial islands are constructed circular and can be expanded into ovals via Land Reclamation just like natural islands.
* Can have any starting layout because terrain is artificial
* Cannot have rare-biome modifiers or unique-feature tiles (those are natural-only)

### 2.6 Weather System

The world has a dynamic weather system. Weather is partitioned into zones matching the stratification cell grid; each cell holds a weather state that evolves deterministically as a function `weather(seed, cx, cy, t) -> state`. The function is pure — no persistent state, no desync risk, replayable for offline simulation.

**Forecast model.** Weather is generated by layered Perlin (or simplex) noise sampled over (cx, cy, t/dwell\_unit), composed at multiple frequencies:

* **Low-frequency spatial component** (placeholder noise scale: ~5 cells per period) produces broad storm fronts spanning 3-6 contiguous cells. Adjacent cells are strongly correlated — the player observing one cell's current state can usually infer the next 1-2 cells' states with high confidence.
* **Slow temporal component** governs how weather drifts. Each cell's state typically dwells 1-4 real-time hours (placeholder) before transitioning. Severe and Catastrophic events are shorter-lived (under 1 real-time hour each) and rarer.
* **Biome modulation** shifts the cell's weather distribution toward thematic states based on the biome of the island in that cell (if any):
  * Plains: baseline distribution
  * Volcanic: storm frequency +50%
  * Arctic: severe-storm frequency +30%; longer cold-storm dwell
  * Coast: fog frequency +50%, storm frequency +20%
  * Desert: Clear-baseline (storms rare); occasional sandstorm (treated as Storm)
  * Forest: near-Plains, slightly elevated storm rate

Empty cells (no island) follow the Plains baseline.

Practical effect: a player observing one cell's current state can typically infer the next 1-2 cells' state with reasonable confidence (strong spatial correlation), and the next 1-2 hours' state at any cell (slow temporal drift). Forecast buildings (Advanced Weather Station, Scanner Sats) extend the confidence horizon beyond direct observation.

**Weather states:**

|State|Effect on vehicles|Effect on drone scan|
|-|-|-|
|Clear|None|Full scan radius|
|Light fog|None|Scan radius -50%|
|Storm|2% per-tile destruction chance|Scan radius -25%|
|Severe storm|8% per-tile destruction chance|Scan radius -75%|
|Catastrophic event (rare)|20% per-tile destruction chance|Scan effectively disabled|

**Visibility:**

The player only sees weather in cells within visibility range of any populated island. Default range R\_weather (placeholder: 5 cells in each direction). Outside this range, weather is unknown; the player must commit launches blind.

Visibility is extended by:

* Weather Station (T2): +3 cells from this island
* Advanced Weather Station (T3): +6 cells, plus 1-cycle ahead forecasting

When multiple weather stations are placed on the same island their visibility bonuses **stack additively** (e.g. one Weather Station + one Advanced Weather Station = baseline + 9 cells). The Advanced Weather Station's forecast layer covers the same radius as its current-cycle reveal — the T3 station's gift is the temporal lookahead, not extra spatial range beyond what its `+6` already provides. Because cell dwell varies (30 min – 4 h, no fixed cycle length), "1-cycle ahead" is sampled at the dwell midpoint (~2 real-time hours) so the forecast lands one typical dwell into the future.

**Vehicle vulnerability multipliers:**

|Vehicle|Multiplier on base destruction chance|
|-|-|
|T1 drone|x1.5 (cheap entry option; most fragile)|
|T2 drone|x1.0|
|T3 drone|x0.7|
|T4 drone|x0.5 (sensors avoid worst)|
|T5 path drone|x0.5 (robust, see Section 11.6)|
|Cargo Ship (T1)|x1.0|
|Heavy Freighter (T2)|x0.9|
|Industrial Carrier (T3)|x0.8|
|Light Helicopter (T2)|x1.1|
|Heavy Lift (T3)|x0.9|
|VTOL Tilt-Rotor (T4)|x0.7|

Final per-tile destruction chance = state\_chance × vehicle\_multiplier, applied at each cell traversed.

**Cell traversal rule.** The vehicle's flight path is rasterized into the ordered sequence of cells it crosses from source to destination. For each cell on that sequence, exactly one destruction roll happens — at the timestamp the path enters the cell. Dwell time within a cell does not increase destruction probability; only the act of entering counts. Per-cell entry timestamps are deterministic functions of the launch parameters (origin, direction, speed, fuel) so offline simulation produces identical resolutions to online play.

**Weather and routes:**

Established cargo routes (cargo, drone, airship, mass_driver) are not destroyed by weather, but storm-affected cells reduce route capacity temporarily: -50% during Storm cells, -90% during Severe. In addition, **in-flight cargo loses some units when its path crosses storm cells**: per-cell roll, scaled by storm severity (placeholder: 5% of in-flight units lost per Storm cell, 15% per Severe storm cell, 30% per Catastrophic cell). The route itself continues operating; only the units in flight at the time take losses. Teleporter Pad routes and T5 Spacetime Anchor are immune (no in-flight buffer to damage).

**Satellites are immune to weather.** Per §14, satellites operate above the weather layer — they take no damage rolls from any weather state in their cell. The only damage source for satellites is orbital debris (§14.8). This makes the Scanner Sat's weather-visibility role especially valuable: it observes weather in cells without ever being affected by it.

**Weather and offline math:**

Vehicles in flight while the player is offline are resolved at return-time using the deterministic forecast. For each cell on the vehicle's path at the time it would have crossed, evaluate destruction probability and consume RNG. This produces a stable answer regardless of when the player logs back in.

### 2.7 Day-Night Cycle

The world's day-night cycle tracks the **real sun at the player's chosen geographic coordinates** (`world.playerLat` / `world.playerLon`), computed via SunCalc. The phase label, the full-viewport tint, the during-night gameplay gate, and the economy integrator's segment boundaries all derive from the sun's true altitude `h` there. Phases are **not** equal-length and vary by season and latitude:

* `h ≥ 0°` — Day
* `−6° ≤ h < 0°`, rising — Dawn
* `−6° ≤ h < 0°`, falling — Dusk
* `h < −6°` (civil twilight) — Night

**Solar buildings (Solar Panel, Sunspire, Solar cell production):** output is `sin(h)` clamped to `[0, 1]` (0 below the horizon), i.e. real insolation — full at the sun's zenith, ramping smoothly through dawn and dusk, zero at night. This is the long-standing `solarMultiplier(t, lat, lon)` behaviour.

When no location is set (fixtures / tests / pre-picker frames) the system falls back to a synthetic 24-hour quadrant clock (`dayPhase`/`dayPhaseName`, four equal 6-hour quadrants offset so `t = 0` lands in Day). **Weather phase-modulation (below) deliberately stays on this synthetic clock** — its severe-storm boost runs in a per-cell historical replay loop where real astronomy is prohibitively expensive, and the boost is imperceptible as real time-of-day. Polar latitudes: the altitude-based phase has no singularity (polar night is never Day; midnight sun is always Day); sunrise/sunset-dependent readouts (the HUD countdown) are simply omitted where no such event exists.

A solar-dependent island must plan for night-time stockpile via Battery (T2) or Singularity Battery (T5) reserves; otherwise its economy stalls during the night phase.

**Mirror Sat boost (§14.3).** A T6 Mirror Sat parked in orbit contributes an additive boost to its ground islands' effective solar multiplier with Lorentzian falloff in lateral distance — `raw = peakBoost / (1 + (d / r_half)²)`, zeroed below `raw < 0.05`. Effective multiplier per island per tick is `min(1, solarMultiplier(t) + Σ mirrorBoost(sat, islandCentre))`, summed over all locked mirror sats reaching the island. The composition is **additive** so mirrors function at night (multiplicative would zero out alongside `solarMultiplier(night) = 0`); the cap at 1.0 makes "fourth mirror is wasted past full sun" visible to the player as saturation.

**Weather modulation by phase:** severe-storm and catastrophic-event formation rates both increase by ~25% during Night and Dawn (placeholder). Other states unchanged.

**Implementation note — CO₂-driven storm amplification (§2.6 extension).** Each island accumulates `co2Kg` as fossil-fuel buildings run; `sumIslandCo2` totals it across the world. `co2WeatherMultiplier(totalCo2Kg)` returns a band multiplier applied to storm/severe_storm/catastrophic weights inside `weather()`: <100 kg → ×1.0 (baseline); <10 t → ×1.1; <100 t → ×1.3; ≥100 t → ×1.6 (crisis). A companion `rollHeatwave(seed, day, totalCo2Kg)` function (threshold ≥10 t, ~5 % per day) exists as a stub but is not yet wired into `WeatherState` or any game path; its integration is deferred.

The day-night cycle is global, so the player can plan around it: dispatch fuel-hungry tasks on solar-heavy islands during Day, schedule sensitive launches during Day or Dusk if solar power is the launch infrastructure's input. The cycle is purely time-driven and does not depend on the player's session — at offline resolution, day/night is just `phase(t)` evaluated at the relevant tick.

\---

## 3\. Island Specification

### 3.1 Properties

Each island has:

* Unique ID
* World coordinates
* Biome type
* Size: ellipse parameters (major radius, minor radius, rotation in degrees) — see §3.4. Merged islands store a list of constituent ellipses (see §3.6).
* Modifier list (zero or more bonuses/hazards)
* Terrain grid (static, derived from seed)
* Building list (dynamic, placed by player)
* Local inventory (per-resource stockpile)
* Storage caps (derived from buildings)
* Level (uncapped — 50 is a tier breakpoint, not a hard cap; the XP curve becomes exponential past 50, see §9.1)
* XP
* Unlocked skill tree nodes and edges
* Unspent skill points
* Last-tick timestamp

### 3.2 Biomes

|Biome|Tile types|Power source|Notes|
|-|-|-|-|
|Plains|grass, stone, ore vein, coal vein|Solar Panel|Balanced, large grids — solar suits the open terrain and bootstraps without fuel (see §3.7)|
|Forest|tree, dense forest, grass, water|Biomass Plant|Wood-rich, modest size|
|Coast|water, sand, ore vein, saltwater shore|Wind Turbine|Maritime, narrow shapes|
|Volcanic|rock, magma vent, rare ore|Geothermal Vent|Rich and dangerous, smaller|
|Desert|sand, copper vein, rare crystal, quartz outcrop|Solar Panel|Scarce water, rare ores|
|Arctic|ice, cryo deposit, rare bio|Cryogenic Generator (T2)|Specialty, hard to power|

### 3.3 Tile Types

* Grass (build anywhere)
* Forest tree (logger required, or clear for grass)
* Dense forest (T2 logger required, more wood)
* Stone outcrop (quarry, or expensive clear)
* Fresh water tile (well source, naval anchor)
* Saltwater shore (coast only, desalination recipes)
* Marsh (drain to grass, or build wetland recipes)
* Cliff (terrain modification required to clear)
* Sand (build, or quarry to sand resource)
* Ore vein (mine required)
* Coal vein (mine required)
* Magma vent (volcanic only, geothermal output)
* Cryo deposit (arctic only)
* Rare crystal (desert only)
* Quartz outcrop (desert only, high-purity silica source)

### 3.4 Size, Shape, and Expansion

Islands are ellipses on the tile grid. Each island has a major radius, a minor radius, and a rotation angle. A tile (x, y) — meaning the unit square from (x, y) to (x+1, y+1) — is part of the island if and only if all four corners of that square lie strictly inside the ellipse. Partial overlap does not qualify; only fully-inscribed tiles are buildable terrain. This produces a slightly puffy circular/oval outline at the tile-grid scale.

Initial radii by biome (placeholders):

|Biome|Major radius|Minor radius|Notes|
|-|-|-|-|
|Plains|14|14|Circular, balanced, large grids. **Home island exception:** the starting home island uses major=16, minor=16 per §3.7 — the 14×14 default applies only to procedurally generated Plains islands.|
|Forest|10|10|Circular, modest size|
|Coast|14|7|Oval, narrow maritime profile|
|Volcanic|7|7|Circular, smaller and dangerous|
|Desert|12|12|Circular|
|Arctic|10|10|Circular|

Initial rotation is 0 for circular biomes. Coast islands generate with a biome-randomized rotation (multiples of 22.5 degrees from world seed).

Maximum natural size, via Land Reclamation Hub at T2+ (placeholders):

|Biome|Max major|Max minor|
|-|-|-|
|Plains|28|28|
|Forest|20|20|
|Coast|28|14|
|Volcanic|14|14|
|Desert|24|24|
|Arctic|14|14|

Each Land Reclamation expansion adds 1 to either the major or the minor radius (player-chosen) at a material cost equal to the number of new inscribed tiles gained × the shared per-land-tile structural basket (`LAND_TILE_COST`, `building-defs.ts`). Rotation cannot be changed after generation.

**Implementation note — rotation is metadata-only.** `IslandSpec.rotation` is stored and seeded for Coast islands (see `src/world-gen.ts` `rollCoastRotation`), but no geometry consumer applies it yet. `tileInscribedInEllipse`, `tileInscribedInOffsetEllipse`, `computeIslandTiles`, and `islandsOverlap` all treat the ellipse as axis-aligned; the overlap test uses an axis-aligned Minkowski-sum approximation that becomes a conservative over-estimate once true rotation lands. When rotation is wired into the geometry layer, the tile-inscription functions will need a rotated-ellipse corner test and `islandsOverlap` will need a rotated-ellipse SAT replacement.

### 3.5 Modifiers

Each island has zero to three modifiers, rolled at generation via a two-step process:

1. **Modifier count** is sampled from a weighted distribution (placeholder): 50% → 0 modifiers, 30% → 1, 15% → 2, 5% → 3.
2. **Specific modifiers** are sampled from the table below, that many at a time, without replacement, weighted by per-modifier rarity.

Biome-tagged modifiers only roll on matching biomes (Frozen Core only on Arctic; Geothermal Active is Volcanic-favored — its weight doubles on Volcanic islands and halves elsewhere).

**Stable mutual exclusivity.** Stable is sampled only on the FIRST modifier draw of step 2. If the first draw lands on Stable, the island's modifier count is collapsed to 1 and the final set is `{Stable}` regardless of what the original count roll said. If the first draw is non-Stable, Stable is removed from the table for any remaining draws (count 2 or 3) — it cannot co-exist with other modifiers under any circumstance.

|Modifier|Weight (placeholder)|Effect|
|-|-|-|
|High Wind|10|Wind power +50%, but all output has ±20% random variance|
|Geothermal Active|6 (12 on Volcanic, 3 elsewhere)|Free heat to all buildings, no need for adjacent heat source|
|Mineral Rich|10|+25% raw extraction|
|Cursed Storms|3|-10% production overall, but rare resource finds doubled|
|Stable|5|No negative modifiers, no random events; mutually exclusive with all others|
|Aetheric Anomaly|1|T5 raw extraction efficiency +50% on this island (applies to all T5 extractors per §8.10) — very rare|
|Frozen Core|6|Arctic-only; cryo recipes 2× efficient|
|Fertile|6|Forestry +50% (no agricultural meaning, just bonus)|

### 3.6 Joining

Two islands merge into one when their footprint ellipses overlap. The trigger is geometric: each tick, the engine checks whether any pair of islands has overlapping ellipses. The most common cause is a player using Land Reclamation Hub on island A to expand its radius until A reaches a neighboring island B.

**Multi-overlap ordering.** If a single tick produces multiple overlapping pairs (e.g., A simultaneously reaches both B and C), the engine processes one pair per tick to avoid ambiguous simultaneous merges. The pair with the largest combined tile count is processed first; smaller is absorbed into larger per the rules below. Remaining unmerged pairs re-evaluate on the next tick — by that point, the merged identity has new ellipses and may now overlap further targets, which then process the same way. Ties in combined tile count break deterministically by the lower-ID island's identity.

When islands A and B touch:

* The larger island absorbs the smaller. "Larger" is determined by current tile count; on tie, by level.
* The merged island stores both ellipses as constituents. The union of two ellipses is generally not an ellipse, so the merged island's footprint is "the union of all constituent ellipses". A tile is part of the merged island if it is fully inscribed inside any constituent ellipse.
* The smaller island's inventory transfers into the larger's inventory; overflow above the larger's storage caps is lost.
* The smaller's spent and unspent skill points are refunded as unspent points on the merged island; the player may freely re-spec.
* The smaller's level and XP are discarded; the merged island keeps the absorber's level and XP. Skill-point refund preserves the player's progression value; only the redundant level number is lost.
* All buildings on both islands remain in place. Adjacency is recomputed across the seam — buildings near the boundary may gain new neighbors that weren't there before.
* Routes targeting the absorbed island redirect to the merged island, and routes originating from the absorbed island are likewise redirected. Routes between A and B (in either direction) are deleted (they are now intra-island).
* Drones in transit returning to the absorbed island return to the merged island.
* Settlement vehicles whose target or origin is the absorbed island are retargeted to the merged island.
* The absorber's modifiers are kept; the absorbed island's are voided.

**Implementation note — biome after merge.** The merged island carries a single `biome` field (the absorber's). After merge, `terrainAt` calls `terrainAtForBiome(spec.biome, ...)` for every tile, including tiles inscribed in absorbed constituent ellipses — absorbed tiles are queried under the absorber's biome, not the absorbed island's original biome. No per-constituent biome is stored. Biome-locked unique buildings already placed on the absorbed island remain in place and continue operating (they were placed legally; the island-ownership biome check is at placement time only). No per-constituent biome model is specced; this is the settled behavior.

Joining is permanent — there is no un-merge.

A merged island can continue to expand. If it grows to touch a third island, the same join procedure applies, accumulating ellipses.

**Building coordinates after merge.** Each constituent ellipse retains its own coordinate origin via the `offsetX` / `offsetY` fields in the architecture data model (§15.1). Buildings on the absorbed island are stored at their original local (x, y) within their ellipse, but globally they live at `(x + offsetX, y + offsetY)` where (offsetX, offsetY) is the absorbed ellipse's offset relative to the absorber. By construction, two buildings can never land on the same global coordinate — the absorber's ellipse has offset (0, 0), and the absorbed ellipse's offset is the displacement between the two original islands' world positions, which is by definition non-zero (otherwise they would have been the same island). Footprint conflicts at merge time are impossible.

### 3.7 Starting State

A new game begins with:

* One populated home island. Biome: Plains. Size: major radius 16, minor radius 16, rotation 0. (Effective tile area is the inscribed grid of that circle.)
* No starting modifiers — Stable trait by default.
* Empty building grid: no pre-placed buildings, no power, no extraction.
* Empty inventory: no starter resources, no Foundation Kit.
* Level 1, 0 XP, 0 skill points.
* Dark world map: only the home island is known. No discovered neighbors.
* No Drone Pad. The player cannot dispatch drones until the home island reaches level 5 (Tier 2) and a Drone Pad is built — see §11.

Bootstrap loop: the player places a Solar Panel (Plains' default power source per §3.2 — works without fuel, day-cycle dependent per §2.7) on any buildable tile, then a Workshop / Logger / Mine on a suitable tile, accumulating XP through production. Solar produces nothing during night phase, so a fresh game's first night requires either patience or a Battery (T2, requires more progression). Once level 5 is reached, the Drone Pad becomes available; the player builds it and dispatches the first scouting drone into the dark map. The first drone return is the first multi-island moment.

The starting world seed determines the home island's terrain (positions of ore veins, coal veins, water tiles within the ellipse) and the position and biome of every other island in the world (most of which are dark to the player at session 0).

**Implementation note — bootstrap starter inventory.** The shipped game seeds the home island with `1200 stone + 600 wood + 30 iron_ore + 80 coal + 60 iron_ingot + 25 bolt + 15 limestone + 4 saltwater_cell + 1 foundation_kit + 5000 scrap` instead of the empty-inventory literal above. The §14 placement-cost basket (Mine `30 stone + 15 wood`, Coal Generator `50 + 25`, Antenna T1 `15 + 5`, plus the §12.3 Foundation Kit needed to dispatch the first settlement vehicle) makes the literal empty start unplayable — the player has no path to the first extraction building. The starter kit is sized to reach a first `battery_bank` within ~45 minutes via the `cell_press` chain, and the 5000-scrap salvage cache bootstraps the steel chain (scrap → steel). It still leaves the deeper extraction/refining loop to the player rather than shipping a finished economy. Source of truth: `src/world.ts` `startingInventory()`.

**Implementation note — tutorial onboarding system.** A 72-step guided tutorial (`src/tutorial.ts`) runs alongside normal play. It is a pure state-machine with no DOM dependencies: `TUTORIAL_STEPS` is an ordered array of `TutorialStep` objects each carrying `id`, `mechanic`, `hint`, `expectedAction`, `triggerCondition`, `dismissalCondition`, and optional `targetDefId`. `currentStep(world)` scans the array and returns the first step whose `triggerCondition` fires and whose `id` is not in `TutorialState.completed`. A bottom-left hint overlay (`tutorial-ui.ts`) renders the active step; clicking it calls `markCompleted`. Concept steps auto-dismiss via a `stepShownFor` TTL. `TutorialState` carries: `completed: Set<ObjectiveId>` (persisted), `completedAt` and `shownAt` (transient timestamps, not serialized), and `xpBumpClaimed: Set<ObjectiveId>` (persisted at schema v21 — prevents XP re-grant after `restart()` or `skipAll()`). The `current: ObjectiveId | null` field in `TutorialState` is serialized for forward-compatibility but is **not read by `currentStep`** — the active step is always recomputed. The default value `'place_solar'` seeded in new-game and persistence-fallback paths is a legacy placeholder; no step with that id exists in `TUTORIAL_STEPS`.

\---

## 4\. Building System

### 4.1 Footprint Shapes

Buildings occupy 1x1 to 4x4 tiles. Shape is defined as a list of relative offsets from an anchor cell. Standard shapes include:

* 1x1 (single tile)
* 1x2, 2x1 (line)
* 2x2 (square)
* L-tromino, L-tetromino
* T-tetromino
* 1x3, 3x1 (long line)
* 3x3 (large square)
* 4x4 (very large)
* Custom irregular masks for unique buildings

### 4.2 Rotation

All buildings support 4 rotations (0/90/180/270 degrees). The shape mask transforms according to standard 2D rotation: `(dx, dy) -> (-dy, dx)` for 90 degrees clockwise.


### 4.3 Placement Rules

A building can be placed if and only if:

* Every tile in the rotated shape mask is within the island bounds (i.e. its unit square is fully inscribed inside one of the island's constituent ellipses; see §3.4 and §3.6)
* Every tile in the rotated shape mask is buildable (not occupied by another building, not blocked by uncleared terrain, not requiring a specific tile type the building doesn't allow)
* All terrain-tile requirements are satisfied (e.g. Mine requires every cell of its footprint to be on an ore/coal vein)

**Implementation note — ocean-placed buildings.** Building defs that carry `oceanPlacement: true` (e.g. `sonar_buoy`, `seawater_intake_rig`, `nodule_harvester`, `trench_drill`, `vent_tap`, and the §5-processor / §6-power ocean catalog) bypass the island-bounds rule entirely — their footprints are validated against `world.oceanCells` instead. `validateOceanPlacement` (`placement.ts`) checks: (1) no land-tile overlap (5-sample test per cell), (2) every footprint cell matches `def.terrainReqs` via `footprintMatches`, and (3) at least one populated island lies within `ANCHOR_MAX_RANGE_CELLS` (= 50 cells, Appendix-A placeholder) of the placement cell — computed by `candidateAnchors` (`anchor-picker.ts`). When validation passes, the anchor-picker modal (`mountAnchorPicker`) opens so the player selects the island that receives the platform's output and supplies its power (§5.3). The chosen anchor id is stored on the `PlacedBuilding` and read by the economy tick. Land defs routed through `validateOceanPlacement` defensively return `def-not-ocean`.

### 4.4 Adjacency Rules

Adjacency is computed using 4-neighbors. For a multi-tile building, the adjacent set is the union of tiles bordering any cell of the footprint, minus the footprint itself.

### 4.5 Adjacency Effects

Two categories:

**Buff adjacency (universal per-category cluster):** every building gains a flat, linear, uncapped multiplier from the size of its same-category 4-connected **cluster**: `rate = 1 + (k − 1) × CATEGORY_ADJACENCY_RATE[category]`, where `k` is the number of buildings in the focal building's maximal same-category cluster — buildings joined through same-category 4-neighbour links (§4.4), a multi-tile building counting once. The bonus is **uniform** across every member of a cluster. Connectivity only: enclosed empty tiles do not break a cluster, and a different-category building between two same-category buildings does not bridge them. The multiplier applies to the building's recipe rate and, for generators, to power output (NOT power consumption). The per-category rate lives in `CATEGORY_ADJACENCY_RATE` (`building-defs.ts`), seeded uniform at 0.10. Cross-island lattice neighbours (§13.3) do not feed this term. Skill-tree `exoticAdjacency` pair-boosts (§9.1) stack multiplicatively on top. Resolution: `clusterBonusMul` / `clusterBonusMuls` / `computeBuffStack` in `adjacency.ts`.

**Gating adjacency:** building cannot operate, or operates in a degraded mode, unless an adjacent requirement is met. Examples:

* Smelter requires adjacent Heat Source; without one, output is zero
* Refinery without adjacent Wastewater Treatment operates only on low-grade recipe (efficiency -50%)
* Crystal Growth Lab adjacent to Cooling Tower unlocks rare crystal recipes
* Chemical Reactor adjacent to another Chemical Reactor risks toxicity event: 5% per real-time hour per reactor that has at least one adjacent Chemical Reactor. On trigger, that specific reactor's throughput drops to 50% for 1 real-time hour, then auto-resolves. Adjacent reactors are unaffected unless they trigger their own roll. Player can mitigate by spacing reactors with non-reactor buildings between them.

### 4.6 Storage Caps

Storage is per-resource. A storage building's capacity is credited to the island's caps **when the building becomes operational** (construction completes), not at the moment it is placed or upgraded — a still-under-construction storage shell contributes nothing. This matches the deferral of production and power, which likewise wait for the construction timer (§4.8, §15.3). A fresh placement credits its base capacity on completion; an in-progress floor upgrade credits its flat per-level capacity increment on completion. Cancelling an unfinished build therefore strips no cap (none was ever granted); only demolition of a finished building removes a cap (§6.7). Buildings come in two flavors.

**Specialized storage** holds resources of one category only:

* Silo: dry goods (raw extractables — wood, stone, ore, coal, sand, salt, sulfur, phosphate, graphite, etc.)
* Tank: liquids and gases (water, crude oil, natural gas, hydrogen, naphtha, heavy oil, lubricant, acids, fuels including Biofuel/Diesel/Aviation Kerosene/Cryogenic Hydrogen)
* Cold Storage: temperature-sensitive (cryogenic compound, cryo-coolant, liquid nitrogen, certain plastics)
* Component Warehouse: manufactured components (T2-T3 fabricated parts: Wire, Bolt, Bearing, Spring, Gear, Battery, Microchip, PCB, Solar cell, Glass panel, Sheet metal, Pipe, etc.)
* Vault: rare/valuable (gold ore, silver ore, lithium, mercury, diamond ore, rare earth, uranium ore, helium-3, all T4-T6 components)

A specialized building accepts only resources whose category matches. Categories are static, defined by the resource catalog (§6).

**Generic storage** (Crate, Warehouse) holds one player-chosen resource per building. At placement, the player labels the building with the resource it will hold. Re-labeling is a free UI action and requires the building to be empty (or accepts a force-clear that destroys current contents).

**Percentage model.** A storage building's `capacity` is a **multiplier**, not an absolute unit count. Its per-resource contribution is `capacity × storage_base(r)`, where `storage_base(r) = max(5, baseline_cap(r))` — the resource's baseline cap (the `RESOURCE_BASE_CAP` override if present, else its category default), floored at 5 so resources with a tiny or zero baseline (rare = 1, AI core = 0) still receive usable storage. The floor applies only to building *contributions*: the fresh-island baseline cap itself stays literal (AI core legitimately starts at 0 — no storage building, no holding). Scaling off each resource's base keeps a building's boost proportional across resources of differing magnitudes — a Crate (×5) adds +500 to iron ore (base 100) but +100 to bolt (base 20) — rather than granting a flat count that dwarfs small-base resources.

The cap for resource `r` on an island is the sum of its baseline cap plus:

* Specialized buildings whose category includes `r`, each contributing `capacity × storage_base(r)`
* Generic buildings explicitly assigned to `r`, each contributing `capacity × storage_base(r)`

When resource `r` hits its cap, only buildings producing `r` are affected — they throttle continuously to the live consumer draw on `r` (§15.3 net-flow), down to zero when nothing consumes it. Other recipes on the island continue to run. The throttle propagates upstream continuously: a throttled building consumes its inputs at the throttled rate, so supplying chains rescale proportionally rather than cascading through binary stalls.

If a storage building is destroyed (by launch failure, debris damage, demolition, etc.), its capacity disappears immediately. If current inventory of any affected resource now exceeds the reduced cap, the excess is lost — inventory clamps down to the new cap.

### 4.7 Maintenance

**Scope.** Only buildings with productive recipe outputs accrue operating
time (and therefore demand maintenance). Power producers, storage,
antennas, lighthouses, drone pads, shipyards, and other recipe-less
catalog rows never accrue, since their primary output isn't routed
through the maintenance factor and degrading would have no gameplay
effect. Eternal Servitors are always exempt.


Every placed building has an internal operating-time counter. **It accrues in utilization-scaled operating time — duty cycle, not wall clock (net-flow rework; see `docs/superpowers/specs/2026-06-10-net-flow-economy-design.md`).** Each segment a building accrues `dt × utilization`, where `utilization` is the same `[0,1]` duty cycle that scales its effective rate: the product of the building's dynamic gates (net-flow solver gate `g`, power brownout factor for consumers, heat throttle, adjacency soft-gate). `utilization` **excludes** the maintenance factor itself (no degradation-slows-degradation feedback — a building past its threshold still wears at full duty speed), time-acceleration, and variance. A building idling against a full bin (`utilization` 0) no longer wears at all.

This **deliberately inverts** the old rule that idle/stalled/inactive buildings accrued maintenance time identically to active ones ("maintenance is a function of presence, not productivity"): under the net-flow model maintenance pressure follows actual duty, so a building can escape it by sitting at a capped output with no consumer. Eternal Servitor conversion (§13.3) keeps its long-term value: exempt-from-maintenance is exempt from a real ongoing cost regardless of how the building is used.

Once accumulated operating time reaches the maintenance threshold for the building's tier (placeholder: T1 = 12h, T2 = 16h, T3 = 20h, T4 = 24h, T5 = 24h), the building enters a "needs maintenance" state.

In that state, output efficiency degrades linearly from 100% to 50% over the next 4 real-time hours (placeholder). If still unmaintained at 50%, output stays at 50% indefinitely. Buildings do not stop entirely and are never randomly destroyed by neglect; they simply run at reduced rate.

To restore the building to 100%, maintenance materials must be present in the island's inventory at maintenance-cycle time. The engine consumes materials and resets the timer automatically. A player may also trigger a manual maintenance refresh from the building inspector, which consumes 50% of the building's placement cost (a different basket than the tier maintenance recipe) to reset the building to full efficiency immediately.

|Building tier|Maintenance recipe (placeholder)|
|-|-|
|T1|2 Lubricant + 5 Bolt|
|T2|3 Lubricant + 5 Bearing|
|T3|5 Lubricant + 1 Electric motor + 1 Capacitor|
|T4|10 Lubricant + 1 Exotic Alloy fragment + 1 Microchip|
|T5|15 Lubricant + 1 Phase Converter + 1 Eldritch Processor|
|T6|25 Lubricant + 1 Reality Anchor fragment + 1 Memetic Core|

If maintenance materials are not present when due, the building stays in its degraded state. The instant materials become available, an automatic maintenance cycle runs and the building returns to 100%. The operating-time counter restarts from zero on each successful maintenance.

The player's responsibility is to keep maintenance supplies flowing — plant Workshops and Assemblers producing Lubricant and tier-appropriate parts, route them to producing islands. A late-game island typically dedicates a small portion of its production capacity to its own (and its protégés') maintenance loop.

**Eternal Servitor exemption.** Buildings converted into Eternal Servitors (§13.3) skip both maintenance and fuel-consumption checks entirely.

### 4.8 Construction Queue

**Running slots.** Each island has a fixed number of concurrent under-construction slots (base 1). A newly placed building or upgrade begins ticking its construction timer immediately if a slot is free. When all running slots are occupied, new placements/upgrades are **enqueued** rather than rejected — cost is paid at enqueue time, FIFO order is stamped via `queueSeq`. Only when the queue is also full is placement rejected with `'queue-full'`.

**Queue capacity.** Base queue depth = 2. The 1:2 running:queue ratio holds across all Robotics skill investment:

| State | Running slots | Queue slots |
|---|---|---|
| Base (no Robotics) | 1 | 2 |
| `robotics.notable.parallelFoundries` (+2) | 3 | 2 |
| `robotics.notable.queueFoundries` (+4) | 1 | 6 |
| Both notables | 3 | 6 |
| Both notables + `robotics.keystone.parallelConstruction` (+1) | 4 | 6 |
| Both notables + `robotics.keystone.queueConstruction` (+2) | 3 | 8 |
| All four nodes | 4 | 8 |

`parallelConstruction` is a structural keystone (AND-prereqs: `swarmAssembly` + `parallelFoundries`); `queueConstruction` is its mirror keystone (AND-prereqs: `swarmAssembly` + `queueFoundries`).

**Queued state.** A queued building occupies its footprint and has paid its placement cost, but `queued === true` on the `PlacedBuilding` prevents it from ticking and from being counted as a running slot. Its `constructionRemainingMs` is set at enqueue but does not count down until promoted.

**Promotion.** Whenever a running build completes its timer (construction-completion boundary inside `advanceIsland`), `promoteQueuedBuilds` immediately promotes the FIFO head of the queue (lowest `queueSeq`) into the freed slot. Promotion happens within the same advance/offline-catchup pass.

**Cancel.** An in-progress build (running OR queued) can be cancelled for a **100% material refund**. This is distinct from §6.7 demolish (~30% Scrap recovery) and from relocate (half-fee). For a fresh placement (`floorLevel === 0`), cancel removes the building entirely; for an in-progress upgrade it reverts the building to `floorLevel − 1` and clears the construction timer. Because storage caps are granted only at construction completion (§4.6), an unfinished build holds no cap and cancel strips none — it touches only the building/level and the material refund. Cancel is only valid while `constructionRemainingMs > 0`.

**Level badge.** Every placed building shows its current floor level (displayed as `floorLevel + 1`, range 1–10) as a persistent badge in the bottom-right corner of its tile footprint, rendered via the building-alerts overlay regardless of construction state.

\---

## 5\. Power System

### 5.1 Electrical Grid (Per-Island)

Each island has a single local electrical grid. No inter-island electrical transmission below T4.

Power buildings produce W. Machines consume W. The instantaneous balance is computed every tick:

```
P\_produced = sum of building.powerProduction for active buildings
P\_consumed = sum of building.powerConsumption for active buildings
power\_factor = P\_consumed == 0 ? 1 : min(1, P\_produced / P\_consumed)
```

`power\_factor` multiplies the production rate of every consumer on the island. This produces smooth brownout: under-supplied islands see proportional output reduction, never hard cutoffs or building damage.

**Throughput-scaled draw.** A consumer's electrical draw scales with how hard it is actually running: `P\_consumed` for a building is its nominal consumption × its throughput factor. That throughput factor is the **net-flow solver gate `g`** (§15.3) — formerly `inputAvail × outputAvail`. The extremes are identical (`g = 0` when fully starved/blocked ⇒ no draw; `g = 1` when unconstrained ⇒ full draw); the middle is now the continuous shared-factor solve rather than a product of two binary-ish terms. **A power producer's wattage is never gated by `g`:** a generator whose recipe output sits at cap keeps producing its full W — the solver gate throttles only its resource side, not its electrical output (`casimir_tap`, `cryogenic_generator`).

**`active` definition.** A building is `active` iff its solver gate `g > 0` (per §15.3) AND all gates pass: terrain/tile requirement, adjacency requirement (heat, cooling, etc. per §5.2), and direct fuel-consumption stockpile if applicable. Solar-class buildings additionally require the current day-cycle phase (§2.7) to provide non-zero solar output. Otherwise inactive: contributes zero to `P\_produced` and `P\_consumed`. A generator's `P\_produced` is additionally scaled by its §4.5 cluster-bonus multiplier (clustered generators boost each other); `P\_consumed` is not.

### 5.2 Heat (Adjacency-Based)

Heat is not a grid. It is an adjacency requirement on specific recipes.

A building requiring heat must have at least one adjacent Heat Source. The relationship is **N:1** — a single Heat Source can serve many adjacent heat-requiring buildings simultaneously, up to its thermal capacity. Each source has a finite `thermalKW` output; each consumer a `heatDemandKW` draw. When the consumers assigned to a source demand more heat than it supplies, every consumer it serves is throttled by `ratio = min(1, thermalKW / total heatDemandKW)` (the throttle scales that consumer's production rate); a consumer whose throttle falls below `MIN_HEAT_FACTOR` (0.1) is treated as having no heat and fully stalls that tick. The Heat Source's fuel consumption multiplies by the number of heat consumers it currently serves: a Coal Furnace serving 4 Smelters burns 4× the coal of a Coal Furnace serving 1 Smelter. This rewards compact hot-zone layouts and makes the no-fuel Heat Sources (Geothermal Vent, Fusion Core) especially valuable when surrounded by many consumers.

**Source priority when multiple are adjacent.** When a heat consumer borders multiple Heat Sources, free Heat Sources (Geothermal Vent, Plasma Heater, Fusion Core) take priority — they satisfy the consumer at zero fuel cost. Fuel-burning sources (the Coal Furnace) bill only if no free source is adjacent to that specific consumer. If multiple fuel-burners are adjacent and no free source is, the source with the lowest cost-per-cycle bills (deterministic tie-break: lowest source building ID).

**Assignment algorithm.** When N consumers and M sources share adjacency relationships, the engine walks consumers in ascending building-ID order; each consumer independently selects its assignment per the priority rule above. Two consumers may both bill the same Coal Furnace — the Furnace then multiplies its fuel use by the number of consumers it serves (per the N:1 rule). Consumers do NOT compete for a free source's fuel: a Geothermal Vent serving 5 adjacent consumers bills zero fuel regardless of count — though if their combined `heatDemandKW` exceeds the Vent's `thermalKW`, all five are throttled proportionally per §5.2's capacity rule. Greedy per-consumer assignment is deterministic, predictable, and near-optimal in practice.

Heat Sources include:

* Coal Furnace (T1, consumes coal, produces heat)
* Geothermal Vent (T1, free, volcanic biome only)
* Plasma Heater (T3, free, power-driven — draws electrical W, burns no fuel)
* Fusion Core (T4, free, very high output)

### 5.3 Inter-Island Power (T4+)

T4 unlocks Power Cable routes that join islands into a shared electrical pool. Per tick, every connected-cable component of islands is evaluated against a single binary gate: the sum of cable capacity inside the component must be at least the required transmission, where required transmission is the smaller of the component's total per-island surplus and total per-island deficit (each island contributing `max(0, produced − consumed)` to one side and `max(0, consumed − produced)` to the other).

When the gate passes, all islands in the component share one brownout factor `min(1, componentProduced / componentConsumed)` — every consumer on every member island sees the same throttle. When the gate fails, each island operates with its own local balance and cables go inert for that tick. The gate is strictly binary — no partial unification. Player progression is to stack enough cable capacity to keep the gate passing under expected peak demand.

T5 Spacetime Anchor (`route.type === 'spacetime'`) links count as infinite-capacity for the gate, so any component containing one trivially passes — matching the spec's distance-independent framing.

The §4 ocean layer adds `route.type === 'submarine_cable'` as a sibling power-link RouteType. It behaves identically to land `cable` for §5.3 purposes — `isPowerLink` returns true, capacities sum into the same component total, dispatch never moves cargo across it. The two differ only in visual rendering (submarine cable traces across ocean cells) and in the player-facing recipe / tier-gating that governs route creation. Both endpoints of a submarine cable still terminate at `power_substation` buildings like land cable.

\---

## 6\. Resource Catalog

### 6.1 T0 Raw Materials

Wood, Stone, Limestone, Sand, Clay, Quartz, Iron ore, Copper ore, Tin ore, Nickel ore, Chromium ore, Zinc ore, Coal, Bauxite, Lead ore, Manganese ore, Tungsten ore, Sulfur, Phosphate, Salt, Graphite, Crude oil, Natural gas, Fresh water, Saltwater, Hydrogen (electrolysis output)

### 6.2 T1 Refined Intermediates

Lumber, Plank, Charcoal, Coke, Brick, Mortar, Cement, Concrete, Quicklime, Slaked lime, Iron ingot, Copper ingot, Tin ingot, Pig iron, Glass, Biofuel, Solder

### 6.3 T2 Alloys, Refined, Components

Steel, Carbon steel, Galvanized steel, Bronze, Brass, Aluminum, Alumina, Rigid plastic, Flexible plastic, Synthetic rubber, Lubricant, Sulfuric acid, Hydrochloric acid, Sodium hydroxide, Chlorine, Naphtha, Heavy oil, Tar, Asphalt, Diesel (T2 fuel for drones, vehicles, satellite launches — see §11.7), Wire, Heavy cable, Sheet metal, Steel beam, Pipe, Bolt, Bearing, Spring, Gear, Battery, Glass panel, Coolant, Ceramic insulator

### 6.4 T3 Advanced Raw, Refined, Components

Gold ore, Silver ore, Lithium, Mercury, Diamond ore, Cryogenic compound, Rare earth, Uranium ore, Helium-3, Stainless steel, Tool steel, Magnetic alloy, Carbon fiber, Silicon (high purity), Silicon wafer, Optical glass, Glass fiber, Optical fiber, Transistor, Capacitor, Resistor, PCB, Microchip, Circuit board, Memory module, Processor, Computing module, Magnet, Electric motor, Generator, Hydraulic actuator, Pneumatic actuator, Pump, Solar cell, Fuel cell, Cryo-coolant, Liquid nitrogen, Argon, Oxygen, Phosphor, Aviation Kerosene (T3 fuel — see §11.7)

### 6.5 T4 Endgame

Quantum chip, AI core, Antimatter capsule, Exotic alloy, Nuclear fuel rod, Plasma containment vessel, Particle accelerator core, Cryo containment unit, Singularity sensor, Self-replication module, Cryogenic Hydrogen (T4 fuel — see §11.7)

### 6.6 T5 Transcendent

**Raw:** Dark matter, Zero-point flux, Tachyon stream, Neutronium, Strange matter, Higgs flux, Casimir energy, Quantum foam, Aetheric current, Spacetime fragment

**Refined / Components:** Reality Anchor, Probability Calculator, Dimensional Fold, Causal Regulator, Singularity Battery, Tachyonic Transmitter, Phase Converter, Memetic Core, Eldritch Processor, Plasma Charge (T5 fuel — see §11.7)

**Endgame Artifacts:** Ascendant Core, Universe Editor, Reality Engine, Genesis Cell, Omniscient Lattice, Eternal Servitor, Aether Beacon, Probability Engine, Time Lock

### 6.7 Byproducts

Slag (from smelting), Ash (from combustion), Waste heat, Exhaust gas, Wastewater, Trace minerals (from slag reprocessing), Scrap (from demolishing buildings — see below)

**Demolition recovery.** Demolishing any T1+ placed building produces Scrap proportional to its build cost (placeholder recovery rate: ~30% of the building's recipe ingredients, expressed as Scrap rather than the original components). Scrap is a T1 resource in the dry-goods storage category. Steel recipes accept Scrap as a substitute for fresh Pig iron at a 2:1 ratio (2 Scrap = 1 Pig iron's worth of steel input). This makes layout redesign less wasteful: demolishing a building isn't pure loss but a partial credit toward future builds.

**Implementation note — demolish also refunds 50% of invested materials.** In addition to the scrap credit, `demolishBuilding` returns `floor(totalInvestedCost[r] / 2)` of each original placement resource (`stone`, `wood`, etc.) directly to inventory, clamped per-resource to the post-demolish storage cap (excess is lost, per §4.6). `totalInvestedCost` = base `placementCost` + `floorLevel × ceil(0.8 × placementCost)`, so upgraded buildings refund proportionally more. This 50% in-kind refund is distinct from the scrap recovery: both fire on every demolish of a completed building. Source of truth: `demolishBuilding` in `src/placement.ts`, `DemolishResult.refunded` field.

**Construction cancel (distinct from demolish).** A building currently under construction (running OR queued, i.e. `constructionRemainingMs > 0`) can be cancelled for a **100% material refund** — no Scrap penalty. For a fresh placement (`floorLevel 0`) the building is removed entirely; for an in-progress upgrade the building reverts to the previous floor level. Demolish (~30% Scrap) applies only to completed buildings; relocate (half-fee) is a third distinct action. See §4.8 for queue/cancel mechanics.

Byproducts must be handled. Untreated wastewater applies an efficiency penalty. Slag can be reprocessed for trace minerals (gold, silver, rare metals at low yield).

\---

## 7\. Recipe Chains

Recipes are defined as `inputs -> outputs` with a cycle time, executed by a specific building type.

### 7.0 Recipe timing — real-world derivation

Cycle times are **not hand-tuned per recipe**. Each recipe's `cycleSec` is generated from real-world 24/7 industrial throughput, area-normalized to our 1 m² = 1 tile buildings, and scaled by a single global pace constant:

```
cycleSec(base)      = output_kg_per_cycle / (areal_density × footprint_m² × M)
output_kg_per_cycle = Σ(output_units × RESOURCE_META.massPerUnitKg)   // all outputs
```

- **`areal_density`** [kg·s⁻¹·m⁻²] — the real 24/7 nameplate throughput of the analogous industrial process divided by its real footprint (e.g. hard-rock mining 8.6, BOF steel 2.1, **logging/timber 0.49** from a 60 m³/h feller-buncher ÷ 24 m²). Full sourced table: see the design docs below.
- **`footprint_m²`** — the building's tile count (single = 1, 2×2 = 4, 3×3 = 9, 4×4 = 16).
- **`M` (global pace multiplier) = `1.4535×10⁻³`** — the one constant that sets world tempo, fixed by anchoring a 1-floor Mine to a 20 s cycle: `M = 1 / (8.6 × 4 × 20)`. Equivalently the sim runs at **≈ 1/688 of real-world throughput** (`1 / M ≈ 688`). There is no per-recipe time tuning; balance comes from this scale plus the floor (≤ ×10) and skill (≤ ×10) multipliers, NOT from compressing the ~6-order real density spread.

The areal densities are real *harvesting/processing* rates (a logger strip-mines decades of standing timber, not the ~µg·s⁻¹·m⁻² a forest regrows), so the figures are industrial nameplate, not sustainable yield. `M` is a **generation-time** constant: the resulting `cycleSec` values are baked into `recipes.ts` per recipe; `RESOURCE_META.massPerUnitKg` is the live input that survives in code. Canonical derivation + per-building sources: `docs/superpowers/specs/2026-05-29-throughput-floors-rebalance-design.md` and its companion `…-throughput-density-table.md`.

### 7.1 Iron / Steel

```
Iron ore + Coal       -> Iron ingot           (Smelter, basic)
Coal                  -> Coke                 (Coke Oven)
Iron ingot + Coke     -> Pig iron             (Blast Furnace, requires heat)
Pig iron + Scrap      -> Steel                (Steel Mill)
Steel + Manganese     -> Carbon steel
Steel + Chromium + Nickel -> Stainless steel
Steel + Tungsten      -> Tool steel
Steel + Zinc bath     -> Galvanized steel
Steel rolling         -> Sheet metal, Beam, Pipe, Bolt, Bearing, Rebar
```

### 7.2 Copper / Brass

```
Copper ore           -> Copper ingot          (Smelter)
Copper + Tin         -> Bronze
Copper + Zinc        -> Brass
Copper drawn         -> Wire, Heavy cable
Copper rolled        -> Copper sheet
Lead + Tin           -> Solder
```

### 7.3 Aluminum

```
Bauxite + chemistry  -> Alumina               (Chemical Reactor)
Alumina + power      -> Aluminum              (Electrolyzer, very high power draw)
Aluminum             -> Sheet, Foil, Frame
```

### 7.4 Oil / Petrochemical

```
Crude oil cracking   -> Naphtha + Diesel + Heavy oil + Asphalt + Tar  (Cracker)
Naphtha              -> Plastic precursor + Solvents
Heavy oil            -> Lubricant + Bitumen
Plastic precursor    -> Rigid plastic, Flexible plastic, Synthetic rubber
```

### 7.5 Chemistry

```
Sulfur + water       -> Sulfuric acid
Salt + power (electrolysis) -> Chlorine + Sodium hydroxide
Limestone + heat     -> Quicklime
Quicklime + water    -> Slaked lime
Air separation (cryo)-> Oxygen + Nitrogen + Argon + Liquid nitrogen
Phosphate + acid     -> Phosphor
```

### 7.6 Glass / Ceramics

```
Sand + Limestone + heat       -> Glass
Quartz (high purity) + heat   -> Optical glass
Clay + heat                   -> Ceramic insulator
Glass + extreme heat          -> Glass fiber, Optical fiber
```

### 7.7 Electronics

```
Quartz                        -> Silica
Silica + extreme purity       -> Silicon
Silicon                       -> Silicon wafer
Wafer + doping                -> Transistor, Capacitor, Resistor
Wafer + photolithography      -> Microchip                     (Lithography Lab, T3)
Copper sheet + Plastic        -> PCB
PCB + Transistors + Capacitors + Resistors + Solder -> Circuit board
Circuit board + Memory module + Processor -> Computing module
Microchip + Rare earth doping + Cryo processing -> Quantum chip
```

### 7.8 Construction

```
Quicklime + Sand + Clay       -> Cement
Cement + Sand + Water         -> Concrete
Concrete + Steel rebar        -> Reinforced concrete
```

### 7.9 Power Components

```
Lithium + Electrolyte + Plastic casing      -> Battery
Hydrogen + Catalyst + Polymer membrane      -> Fuel cell
Doped silicon + Glass + Aluminum frame      -> Solar cell
Magnet + Wire + Steel core                  -> Electric motor
Magnet + Wire + Turbine blade               -> Generator
Many capacitors + Chassis                   -> Capacitor bank
```

### 7.10 Mechanical Composites

```
Motor + Pipe + Valve + Casing               -> Pump
Pipe + Lubricant + Cylinder + Piston        -> Hydraulic actuator
Pipe + Compressed air + Piston              -> Pneumatic actuator
```

### 7.11 T4 Endgame

```
Quantum chip + Memory + Cryo cooling + Power conditioner -> AI core
Particle accelerator + Electromagnetic containment       -> Antimatter capsule
Tungsten + Cobalt + Rare earth + extreme conditions      -> Exotic alloy
Lab quantum manipulation                                  -> Time crystal
AI core + Drone parts + Manufacturing programming        -> Self-replication module
```

### 7.12 T5 Transcendent

T5 recipes consume T4 components and T5 raws in extreme quantities with hour-long cycle times. (Cycle figures below reflect the 2026-05-18 ÷3 display-visibility rebalance — Reality Anchor / Genesis Cell were 24h, Lattice Node was 12h, Antimatter Propellant was 30 min.)

```
4 AI core + 1 Antimatter capsule + 1 Time crystal + 1 Exotic alloy + 8h cycle                -> Reality Anchor
4 Reality Anchor + 1 Zero-point flux + 2 Causal Regulator + 1 Memetic Core + 8h cycle        -> Genesis Cell
2 Reality Anchor + 4 Causal Regulator + 1 Memetic Core + 4h cycle                            -> Lattice Node
N Lattice Nodes (one per networked T5 island, N = 20 = Network Consciousness threshold) -> Omniscient Lattice activation (a threshold check, not a craft: no consumable, no cycle)
3 Reality Anchor + 1 Eldritch processor + 5 AI core + 2 Computing module + 40 min cycle  -> Ascendant Core
```

**T5 mastery** (Omniscient Lattice gate): a qualifying island has reached T5 (level 50+ — `tierForLevel(level) >= 5`) AND has crafted at least one AI core. This predicate (`isT5Mastered` in `lattice.ts`) gates the Omniscient Lattice: the lattice activates once 20 networked, T5-mastered islands each carry a Lattice Node. The Ascendant Core itself has NO multi-island gate — it is the local `ascendant_assembly` recipe above, and first local production auto-unlocks T6 access (flips `ascendantCoreCrafted`).

**T6 fuel — Antimatter Propellant** is produced at the Antimatter Refinery (a T6 building) once T6 access is unlocked (`ascendantCoreCrafted && hasSpaceport`):

```
1 Antimatter capsule + 1 Plasma containment vessel + 5 Cryogenic Hydrogen + 100 MW for 10 min cycle   ->  1 Antimatter Propellant
```

The recipe ties T6 launch fuel back to the T4 antimatter chain — a player who has not built out T4 antimatter production cannot fuel T6 launches at any meaningful rate.

\---

## 8\. Building Catalog

### 8.1 Extraction

|Building|Footprint|Tier|Tile requirement|Power|Notes|
|-|-|-|-|-|-|
|Logger|1x1|T1|tree|none|Wood output|
|Heavy Logger|2x2|T2|dense forest|medium|Wood output, higher rate|
|Mine|2x2|T1|ore vein or coal vein|medium|Ore or coal output by tile|
|Deep Mine|2x3|T2|ore vein|high|Higher rate, deeper veins, requires Mining sub-path|
|Quarry|2x2|T1|stone or sand|low|Stone/sand output|
|Well|1x1|T1|water|low|Fresh water output|
|Pump Jack|2x2|T2|(placed near oil)|medium|Crude oil output|
|Gas Extractor|2x2|T2|(placed near gas vent)|medium|Natural gas|
|Drilling Rig|3x3|T3|(deep vein)|high|Rare earth, lithium, uranium|

### 8.2 Smelting / Refining

|Building|Footprint|Tier|Notes|
|-|-|-|-|
|Furnace|1x1|T1|Basic smelting, low throughput|
|Smelter|2x2|T1|Standard ore -> ingot|
|Coke Oven|2x2|T2|Coal -> coke|
|Blast Furnace|3x3|T2|Iron + coke -> pig iron, requires adjacent Heat Source|
|Steel Mill|3x3|T2|Pig iron -> steel|
|Electric Arc Furnace|2x3|T3|High-tier alloys, electricity-driven|
|Cracker|3x3|T2|Crude oil cracking, byproduct outputs|
|Chemical Reactor|2x2|T2|Acid, plastic precursor, alumina|
|Electrolyzer|2x2|T3|Aluminum electrolysis, very high power|
|Air Separator|3x3|T3|Cryogenic distillation: O2, N2, Ar|
|Lithography Lab|4x4|T3|Silicon wafer -> microchip|
|Particle Accelerator|4x4|T4|Antimatter production, exotic alloys|
|Cryo Lab|3x3|T3|Cryogenic compound processing|

### 8.3 Manufacturing

|Building|Footprint|Tier|Notes|
|-|-|-|-|
|Evaporator|1x1|T1|Salt|
|Glassworks|2x2|T1|Glass|
|Kit Assembler|2x2|T1|Foundation Kit|
|Lumber Mill|2x2|T1|Lumber|
|Plank Mill|2x2|T1|Plank|
|Workshop|2x2|T1|Basic gears, bolts, simple components|
|Assembler|2x2|T2|Gear|
|Beam Mill|2x2|T2|Steel Beam|
|Bearing Press|2x2|T2|Bearing|
|Brass Alloyer|2x2|T2|Brass|
|Bronze Alloyer|2x2|T2|Bronze|
|Cable Drawer|2x2|T2|Heavy Cable|
|Carbon Steel Mill|3x3|T2|Carbon Steel|
|Ceramic Kiln|2x2|T2|Ceramic Insulator|
|Coolant Synthesizer|2x2|T2|Coolant|
|Flexible Plastic Press|2x2|T2|Flexible Plastic|
|Galvanizing Bath|3x3|T2|Galvanized Steel|
|Glass Panel Press|2x2|T2|Glass Panel|
|Metal Rolling Mill|2x2|T2|Wire|
|Pipe Mill|2x2|T2|Pipe|
|Rigid Plastic Press|2x2|T2|Rigid Plastic|
|Rubber Synthesizer|2x2|T2|Synthetic Rubber|
|Sheet Metal Mill|2x2|T2|Sheet Metal|
|Solder Alloyer|2x2|T2|Solder|
|Spring Winder|2x2|T2|Spring|
|Battery Factory|3x3|T3|Battery|
|Fuel Cell Lab|2x2|T3|Fuel Cell|
|Generator Lab|2x2|T3|Generator|
|Glass Fiber Spinner|2x2|T3|Glass Fiber|
|Hydraulic Assembly|2x2|T3|Hydraulic Actuator|
|Kit Assembler Enriched|2x2|T3|Foundation Kit Enriched|
|Mag Forge|2x2|T3|Magnet|
|Magnetic Alloyer|2x2|T3|Magnetic Alloy|
|Motor Assembly|2x2|T3|Electric Motor|
|Optical Fiber Drawer|2x2|T3|Optical Fiber|
|Optical Glass Kiln|2x2|T3|Optical Glass|
|Pneumatic Assembly|2x2|T3|Pneumatic Actuator|
|Pump Assembly|2x2|T3|Pump|
|Stainless Steel Mill|3x3|T3|Stainless Steel|
|Tool Steel Mill|3x3|T3|Tool Steel|
|Cryo Containment Assembler|2x2|T4|Cryo Containment Unit|
|Fuel Rod Assembler|2x2|T4|Nuclear Fuel Rod|
|Kit Assembler Refined|3x3|T4|Foundation Kit Refined|
|Plasma Containment Assembler|2x2|T4|Plasma Containment Vessel|
|Quantum Manipulator|3x3|T4|Time Crystal|
|Self-Replication Lab|3x3|T4|Self Replication Module|
|Aether Beacon Lab|3x3|T5|Aether Beacon|
|Ascendant Assembly|4x4|T5|Ascendant Core|
|Causal Regulator Lab|3x3|T5|Causal Regulator|
|Dimensional Fold Lab|3x3|T5|Dimensional Fold|
|Eldritch Refiner|3x3|T5|Eldritch Processor|
|Genesis Forge|4x4|T5|Genesis Cell|
|Memetic Forge|3x3|T5|Memetic Core|
|Phase Refiner|3x3|T5|Phase Converter|
|Plasma Forge|3x3|T5|Plasma Charge|
|Probability Calculator Lab|3x3|T5|Probability Calculator|
|Reality Engine Lab|3x3|T5|Reality Engine|
|Reality Forge|4x4|T5|Reality Anchor|
|Singularity Battery Factory|3x3|T5|Singularity Battery Unit|
|Tachyonic Transmitter Lab|3x3|T5|Tachyonic Transmitter|
|Antimatter Refinery|3x3|T6|Antimatter Propellant|
|Mirror Sat Assembly|3x3|T6|Mirror Sat|
|OIP Assembly|3x3|T6|Orbital Insertion Package|
|Relay Sat Assembly|3x3|T6|Relay Sat|
|Repair Drone Assembly|3x3|T6|Repair Drone|
|Repair Pack Assembly|3x3|T6|Repair Pack|
|Scanner Sat Assembly|3x3|T6|Scanner Sat|
|Sweeper Sat Assembly|3x3|T6|Sweeper Sat|

### 8.4 Storage

|Building|Footprint|Tier|Notes|
|-|-|-|-|
|Crate|1x1|T1|×5 base-cap multiplier on one player-chosen resource (generic, see §4.6; e.g. +500 to a base-100 resource)|
|Warehouse|3x3|T1|×10 base-cap multiplier on one player-chosen resource (generic, see §4.6)|
|Silo|2x2|T1|×2000 base-cap multiplier; specialized to dry goods category only (+200000 to a base-100 dry good)|
|Tank|2x2|T2|×1000 base-cap multiplier; specialized to liquids/gases category only|
|Cold Storage|2x2|T2|×1000 base-cap multiplier; specialized to temperature-sensitive category only|
|Component Warehouse|2x2|T2|×1000 base-cap multiplier; specialized to manufactured-components category (T2-T3 fabricated parts)|
|Vault|3x3|T3|×1000 base-cap multiplier; specialized to rare/valuable category only (rare bases floor to 5 → +5000 each)|
|Singularity Battery|2x2|T5|Effectively infinite electrical power storage (not a resource storage building)|

### 8.5 Power Generation

|Building|Footprint|Tier|Tile requirement|Notes|
|-|-|-|-|-|
|Wind Turbine|1x1|T1|coast tile|Free, low output|
|Solar Panel|1x1|T1|open sand/grass|Free, medium output|
|Coal Generator|2x2|T1|any|Consumes coal|
|Biomass Plant|2x2|T1|any|Consumes wood|
|Geothermal Vent|2x2|T1|magma vent|Free, high output|
|Cryogenic Generator|2x2|T2|cryo deposit (arctic)|Cryo compound -> power|
|Nuclear Reactor|4x4|T3|any|Uranium fuel rods, very high output|
|Fusion Core|4x4|T4|any|Helium-3 fuel, massive output|
|Casimir Tap|2x2|T5|any|Free vacuum energy|

### 8.6 Heat Sources (used as adjacency)

|Building|Footprint|Tier|Notes|
|-|-|-|-|
|Coal Furnace|1x1|T1|Consumes coal|
|Geothermal Vent (also power)|2x2|T1|Volcanic, free|
|Plasma Heater|2x2|T3|Power-driven, no fuel|
|Fusion Core (also power)|4x4|T4|Free heat in addition to power|

### 8.7 Cooling / Treatment

|Building|Footprint|Tier|Notes|
|-|-|-|-|
|Cooling Tower|2x2|T2|Adjacency: required for some chemistry recipes|
|Wastewater Treatment|2x2|T2|Adjacency: prevents efficiency penalty for chemistry|
|Exhaust Scrubber|1x1|T2|Required for clean operation of high-emission buildings|

### 8.8 Logistics

|Building|Footprint|Tier|Notes|
|-|-|-|-|
|Cargo Dock|2x2|T1|Establishes T1 cargo route; auto-placed on ship-settled islands|
|Shipyard|3x3|T1|Builds and launches ships for settlement and cargo; coastal placement required|
|Helipad|2x2|T1|Builds and launches helicopters; auto-placed on helicopter-settled islands|
|Drone Pad|1x1|T2|Drone scouting only (does not settle islands)|
|Airship Dock|3x3|T3|T3 long-range airship routes|
|Teleporter Pad|2x2|T4|T4 instant transport, paired endpoints|
|Spacetime Anchor|2x2|T5|Logical island unification|
|Power Substation|2x2|T4|Inter-island power cable endpoint|

### 8.9 Special / Endgame

|Building|Footprint|Tier|Notes|
|-|-|-|-|
|Land Reclamation Hub|3x3|T2|Expands island grid|
|Terrain Modifier|2x2|T2|Clears or converts tiles|
|Weather Station|2x2|T2|Extends weather visibility +3 cells from this island|
|Advanced Weather Station|2x2|T3|Extends visibility +6 cells, adds 1-cycle forecasting|
|Platform Constructor|4x4|T3|Builds artificial islands|
|Patron Hub|2x2|T3|Manages funneling routes outbound|
|Launch Tower|3x3|T4|T4 omnidirectional drone pulse|
|Path Drone Foundry|3x3|T5|Required to launch T5 path-drawn drones|
|Probability Engine|2x2|T5|Manipulates RNG outcomes for the island|
|Genesis Chamber|4x4|T5|Creates raw matter from energy|
|Lattice Node|2x2|T5|Network unity (one per island, requires N to activate)|
|Universe Editor|3x3|T5|Rewrites local biome and tile mix|
|Time Lock|3x3|T5|Banks offline-time stockpile per island; spends to accelerate any chosen island's tick rate (see §13.3)|

**Terrain Modifier action cost.** A terrain_modifier fires a single 16-tile shot to a player-chosen target, charged UPFRONT at placement (on top of the building's placement cost). Mapping a tile to a rare resource costs 30 days of that resource's base extraction (`ceil(baseRate_per_sec × 2,592,000)`, one basket for the whole shot); clearing to a natural target costs its per-tile basket × 16.

### 8.10 T5 Raw Extraction (T5 only)

T5 raw resources (§6.6) are extracted by specialized T5 buildings. Each requires T5 access on the island (level 50 + AI core, see §13.1) and draws extreme power per cycle. Extraction is slow — placeholder cycle times of ~10 minutes to ~80 minutes per unit (2026-05-18 ÷3 for display visibility; was 30 minutes to 4 hours). Aetheric Anomaly islands (§3.5) extract at bonus efficiency.

|Building|Footprint|Outputs|Notes|
|-|-|-|-|
|Casimir Tap|2x2|Casimir energy, Zero-point flux, plus electrical power|Doubles as T5 power source (also listed in §8.5). Each cycle taps vacuum to produce continuous bulk power and a discrete unit of Casimir energy or Zero-point flux. Inputs free; operation cost dominated by build cost rather than ongoing fuel.|
|Aetheric Conduit|3x3|Aetheric current, Quantum foam|Channels exotic atmospheric phenomena. Continuous heavy power draw (placeholder: 60 MW).|
|Spacetime Resonator|3x3|Spacetime fragment, Tachyon stream|Manipulates local spacetime to harvest fragments. Highest power cost of the T5 extractors (placeholder: 100 MW). Required for any Spacetime Anchor production or T5 Path-Drawn Drone construction.|
|Eldritch Sieve|3x3|Dark matter, Strange matter, Higgs flux|Filters from cosmic background; produces exactly one of the three outputs per cycle, drawn at equal probability (1/3 each, deterministic given world seed + cycle index). Player does not pick. Heavy power draw (placeholder: 80 MW). Aetheric Anomaly modifier interaction: applies the uniform +50% extraction-rate bonus (more outputs of all three) rather than biasing toward any specific output.|

Neutronium (the remaining T5 raw) is not directly extracted — it is a refined product derived from combinations of the above raws via T5 refining recipes (§7.12).

Aetheric Anomaly modifier (§3.5) provides +50% extraction efficiency on all four T5 extractors when present on the island.

Total: \~245 building types.

\---

## 9\. Progression System

### 9.1 Per-Island Levels

Each island has an independent level from 1 to 50. There is no global tech tree.

**XP gain is tier-weighted production.** Every resource has an `xp\_weight` constant scaling superlinearly with the resource's tier (placeholder: T0 raw = 1, T1 = 3, T2 = 10, T3 = 30, T4 = 100, T5 = 300, T6 = 1000). Per tick, the island gains:

```
xp\_per\_tick = sum over resources r of ( production\_rate\[r] \* xp\_weight\[r] ) + funneling\_bonus
```

The `production\_rate\[r]` figure already incorporates `power\_factor` (§5.1), so brownout under-supply reduces XP proportionally without a separate penalty layer.

**XP follows realized production.** XP accrues on what a building actually produces, so a building throttled by a capped output bin or scarce inputs (§15.3 net-flow) earns XP at its throttled rate, not its nominal rate. A cap-pinned producer with zero consumers realizes zero production and therefore earns zero XP — there is no XP farm at a full bin. The player must manage caps, build additional storage, or consume the bottlenecked resource downstream to keep progression moving at full rate.

**Funneling bonus** is the second source — see §10.1 for the formula. It applies only while the island is below Tier 3.

XP-to-level curve: superlinear, two-segment.

* For levels 1 through 50, polynomial: `xp\_for\_level\_n = 25 \* n^2.2` (placeholder; rebalanced from the original `100 \* n^2.2` for ~4× faster early-game leveling — see `src/economy.ts` `xpForLevel`).
* For levels past 50, exponential: `xp\_for\_level\_n (n > 50) = xp\_for\_level\_50 \* 1.2^(n - 50)` (placeholder multiplier 1.2).

Levels are uncapped — 50 is the T5 access breakpoint (§13.1), not a hard ceiling. The exponential softcap past 50 means islands continue to accrue progression indefinitely but at a dramatically slowing pace: level 70 costs ~38× more XP per level than level 50, level 100 costs ~9100×. Practical effect: a fully-developed island never permanently stalls, but each new level past 50 represents a real long-haul commitment.

Each level grants skill points to spend, on a geometric ramp: `points\_granted(level) = max(1, floor(1.031^level))` (placeholder; rebalanced from a flat `1 point / level` so the deep nodes are reachable given the `round(1.5^(depth - 1))` cost ramp in §9.3 — flat-1 made full sub-paths require ~500k levels). L1-L22 still grant 1 SP each (1.031^L stays under 2); first tick to 2 at L23, 4 at L50, 8 at L70, 21 at L100, 97 at L150. Source of truth: `src/skilltree.ts` `skillPointsForLevelUp`. Because levels are uncapped, skill points eventually outpace the available skill-tree nodes (which are mutual-exclusively capped at ~25-30 accessible per island, see §9.3) — the post-cap excess accumulates and feeds late-game prestige-style spending (see §9.3).

### 9.2 Tier Breakpoints

Tiers are passive thresholds that gate building and recipe availability:

* Tier 1: levels 1-5
* Tier 2: levels 5-15 (crossing 5 unlocks T2 buildings, recipes, sub-paths)
* Tier 3: levels 15-30 (crossing 15 unlocks T3)
* Tier 4: levels 30-50 (crossing 30 unlocks T4, plus biome-locked uniques)
* Tier 5: level 50 + AI core crafted (unlocks hidden T5 sub-band on the skill tree)
* Tier 6: Ascendant Core crafted on this island + Spaceport built (unlocks Orbital sub-path under Logistics; satellite operations available — see Section 14)

### 9.3 Skill Tree Structure

The skill tree is a **directed graph** of nodes connected by edges. Five top-level branches each contain four sub-paths (20 sub-paths total).

**Extraction**

* Mining (ore output, vein depth, rare reveal)
* Forestry (wood output, regrowth, exotic species)
* Drilling (oil/gas/deep mineral)
* Robotics (construction speed, parallel building + build-queue capacity, drone production efficiency)

**Refinement**

* Smelting (iron, copper, alloy chains)
* Chemistry (oil cracking, polymers, acids)
* Electronics (silicon, circuits, precision)
* Power systems (efficiency, advanced generation)

**Logistics**

* Storage (caps, specialized vaults, rare material handling)
* Transport (route capacity, drone fuel, airship range)
* Network (teleporter reach, multi-hop, automation)
* Patronage (funneling efficiency, colony support)

**Orbital** (T6, see §14.9)

* Launch (success rate, pad-explosion mitigation)
* Communication (antenna and satellite comm range, store-and-forward bandwidth)
* Discovery (Scanner Sat dwell ramp, coverage radius)
* Resilience (debris-lodge slowdown reduction, onboard fuel reserve, repair-launch reliability)

**Ocean**

* Aquaculture (marine biomass, reef cultivation)
* Hydroprocessing (desalination, underwater refining)
* Submarine (deep-sea extraction, abyssal logistics)
* Oceanography (current prediction, bioluminescent mapping)

**Graph anatomy.** Each sub-path is a linear chain of shallow filler nodes (templated, depth-graded) interleaved with hand-curated **notables** (typically 4 per sub-path) and capped by **keystones** (1–2 per sub-path). Filler nodes provide flat % bonuses; notables introduce unique mechanics, auras, or unlocks; keystones are high-cost capstones with AND-prerequisite gates. In addition, **threshold-bridges** (edges activated when a branch has spent enough SP) create cross-sub-path and cross-branch shortcuts. **Graft sockets** on the outer rim reserve slots for future expansion. After the v2 de-node pass the catalog totals 357 nodes (246 filler + 81 notables + 30 keystones); the budget guard caps each sub-path at ≤2 distinct filler lever-families and ≤23 total nodes (`src/skilltree-budget.test.ts`).

**Purchasing.** Players do not buy nodes directly. Instead they nominate a **target node** and the engine computes the cheapest path from any already-owned node to that target using multi-source Dijkstra (`costToUnlock`). Edge weights are the skill-point cost of the node at the edge's destination. The player pays the path total and automatically owns every intermediate node along the way (`buyNode`). This means:

* You can "skip" to a deep notable by paying through its filler chain in one action.
* You can reach a distant notable via an active threshold-bridge if you have invested enough in its source branch.
* Redundant edges (multiple paths to the same node) are allowed; the cheapest available path is always charged.

**Keystone gates.** Each keystone has an AND-prerequisite list of specific upstream nodes that must already be owned before the keystone can be purchased (`canBuyKeystone` / `buyKeystone`). This is separate from the graph pathing — even if a path exists, the keystone stays locked until every prereq is satisfied.

**Aura amplification.** Notables may carry an aura (radius 1–2 edges, bonus up to +15%). Every owned node adjacent to an aura source has its effect magnitude multiplied by the aura bonus. Multiple auras stack multiplicatively per target, capped at ×1.50.

**Node costs.** Filler costs follow a geometric ramp `round(1.5^(depth - 1))` (depth 1 ≈ 1, depth 5 ≈ 5, depth 10 ≈ 38). Notables and keystones have hand-set costs (typically 3–8 SP). Combined with the skill-point grant curve `max(1, floor(1.031^level))` (§9.1), a late-game island at level 70+ has enough points to complete several sub-paths.

**Effect kinds.** Nodes emit one of the following effect types, consumed by the economy and orbital engines:

* Multiplier effects — `recipeRateMul`, `storageCapMul`, `powerProductionMul`, `powerConsumptionMul`, `routeCapacityMul`, `commRangeMul`, `maintenanceThresholdMul`, `scannerCoverageMul`, `debrisProtectionMul`, `droneFuelEfficiencyMul`, `airshipRangeMul`, `padExplosionReduceMul`, `satBufferCapMul`, `scannerDwellRateMul`, `satFuelReserveMul`, `repairDroneReliabilityMul`, `storageCategoryCapMul`, `constructionTimeMul`, `teleporterEfficiencyMul`, `mineYieldBonusMul`, `mineRareTrickleMul`, `loggerYieldBonusMul`, `loggerExoticTrickleMul`, `droneScanRadiusMul`, `xpGainMul`.
* Unlock effects — `unlockRecipe` (adds a recipe to a building), `biomeBypass` (removes biome restriction for listed buildings), `tierBypass` (lowers tier requirement by 1 for listed buildings).
* Structural effects — `exoticAdjacency` (new adjacency pair-boost rules), `structural` (shared power grid, parallel construction (`parallelConstruction` +1 running slot), build-queue capacity (`parallelQueue` +2 queue slots)), `conditionalBonus` (multiplier active only during storms, night, etc.), `crossIslandShared` (resource pool shared across networked T3+ islands).
* Orbital effects — `launchSuccessAdditive` (flat +% to launch success).

A depth→tier gate caps individual nodes by the island's level-derived tier (`tierRequiredForDepth`: depth ≤2 → T2, 3 → T3, 4 → T4, ≥5 → T5, ≥8 → T6), enforced in both `buyNode` and `costToUnlock`; an under-tier node (or a path through one) is rejected before any SP is charged. Beyond that gate there is no sub-path commitment lock and no sequential-completion restriction. Any node reachable via the graph topology can be bought as soon as the player has both the SP and the required tier. (Keystones are bought via `buyKeystone`, which checks only SP plus its AND-prereqs — it does not apply the depth→tier gate.)

**Practical reach by stage.**

* Mid-game island (level ~25): ~10–15 nodes total, mostly shallow fillers and 1–2 notables
* Late-game island (level 50): ~30–50 nodes, several sub-paths partially advanced, first keystone reachable
* Very-late-game island (level 70+): ~80–100+ nodes, multiple sub-paths near completion, bridge shortcuts active
* Extreme-late-game island (level 100+): trending toward complete tree mastery; all keystones and cross-branch bridges accessible

> **Graph-view UI (canonical, 2026-05-23):** the skill graph is rendered
> as a full-page, pannable / zoomable PixiJS overlay (see
> `src/skilltree-graphview.ts` + `src/skilltree-layout.ts`). Per-node
> click triggers `buyNode` via the cheapest-path solver (or
> `buyKeystone` for AND-gated keystones). The v1 4-column text list
> that briefly shipped in `src/skilltree-ui.ts` was transitional;
> the legacy modal now contains only the stats strip, tier-reset
> section, and an "Open Skill Graph" button.

**Implementation note — crystal sockets.** The skill tree ships a live crystal-socket system (`src/skilltree-crystals.ts`, `bindCrystal` / `unbindCrystal` in `src/skilltree.ts`). Skill Crystals (tiered per branch: Mining, Forestry, Drilling, Robotics, Smelting, …) are crafted items that slot into designated socket nodes on the graph; binding a crystal auto-owns the socket node and applies the crystal's sub-graph of bonus nodes, unbinding removes them. `IslandState.socketBindings` persists the current crystal loadout.

### 9.4 Fledgling Island Boost

A freshly-settled island runs every production recipe faster so the early game isn't an hours-long wait. The boost is a level-scaled multiplier applied to each recipe's throughput in `computeRates` (alongside skill, floor, and modifier multipliers):

```
fledglingRecipeMul(level) = 1 + 1.5 × max(0, (10 − level) / 9)
```

It starts at **+150% (×2.5) at level 1** and ramps linearly to **+0% (×1.0) at level 10**, then stays neutral for all higher levels (`max(0, …)` self-clamps — the boost is never negative). It scales the whole recipe (outputs and input consumption together), so production chains speed up uniformly without unbalancing their ratios.

The boost is a pure function of the island's level — no persisted state. XP accrues on the boosted production (§9.1), so the early levels pass quickly and the island leaves the boost window on its own; the mechanic is self-limiting. The inspector recipe panel surfaces the active multiplier in its bonuses line (e.g. `fledgling ×2.50`) while it is in effect.

| Level | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10+ |
|---|---|---|---|---|---|---|---|---|---|---|
| ×mult | 2.50 | 2.33 | 2.17 | 2.00 | 1.83 | 1.67 | 1.50 | 1.33 | 1.17 | 1.00 |

### 9.5 Biome-Locked Uniques (T4)

At Tier 4, biome-specific unique buildings unlock per island. These buildings are bottlenecks: each one is the only place in the world where its key resource can be produced. Endgame players must therefore colonize at least one island of every relevant biome to access the full T4 supply chain. Artificial islands cannot host biome-locked uniques (see §2.5).

|Biome|Building|Footprint|Bottleneck output|Notes|
|-|-|-|-|-|
|Plains|Mass Driver|4x4|none — logistics|Establishes a permanent point-to-point cargo route (Route.type = `mass_driver` per §15.1) from this island to one chosen target. Lower maximum range than Airship Dock but vastly higher per-second throughput (placeholder: ~5× airship capacity). Consumes Diesel (T2 fuel grade) per dispatch volume. Weather-affected: storm cells along the path reduce capacity per §2.6 like other transport, but the route itself is not destroyed. One Mass Driver = one outbound route per island; only one Mass Driver per Plains island.|
|Forest|Carbon Forge|3x3|Carbon Fiber, Glass Fiber, Optical Fiber|Only producer of T4-grade Carbon Fiber and the optical-fiber family. Forest's wood/charcoal abundance feeds the chain. Heavy power draw; requires adjacent Heat Source.|
|Coast|Tidal Array|3x3|none — T4 renewable power|Massive constant electrical output (placeholder: 50 MW). No fuel cost. Requires a coastal water tile. Coast's signature T4 power option; alternative is Fusion Core (universal but Helium-3 fuel-hungry).|
|Volcanic|Pyroforge|3x3|Exotic Alloy|Only producer of Exotic Alloy in the world. Exotic Alloy is required for Reality Anchor, Genesis Cell, satellite recipes (§14.10), and other T5/T6 components — Volcanic colonies are mandatory for T5/T6 progression. Massive heat draw; requires adjacent Geothermal Vent (Volcanic-only by §8.5).|
|Desert|Sunspire|3x3|none — T4 renewable power|Peak solar output (placeholder: 60 MW). No fuel cost. Combined with Desert's standard Solar Panel synergies, Desert becomes the preferred long-term renewable-power biome.|
|Arctic|Cryogenic Compute Center|4x4|AI Core|Only producer of AI Cores in the world. Arctic ambient cold halves this building's compute-recipe power draw — the cooling bonus is intrinsic to the biome and cannot be replicated by terraforming. AI Core is required for T5 mastery (§13.1), Self-Replication Module, and the Spaceport's satellite payloads (§14.10) — Arctic colonies are mandatory for T5/T6 progression.|

A player who colonizes one island of each biome can run the complete T4 chain. Skipping a biome means giving up its bottleneck output.

**One biome-unique per island.** Each island can host at most one biome-locked unique building. For natural islands this is the building matching the island's biome. A player owning multiple colonies of the same biome can run multiple instances of that biome's unique in parallel — three Volcanic colonies produce three Pyroforges' worth of Exotic Alloy. Wide colonization scales the bottleneck output linearly.

**Cryogenic Hydrogen production (T4 fuel).** Cryogenic Hydrogen, the T4 fuel grade per §11.7, is produced by the Cryo Lab (T3, see §8.2) via the recipe `Hydrogen + Cryo-coolant + heavy power → Cryogenic Hydrogen`. It is not biome-locked. Arctic colonies produce T4 fuel more efficiently than other biomes because Cryo Lab benefits from cold ambient conditions, but any island with a Cryo Lab can produce it.

### 9.6 Network Consciousness Milestone

A wide-play goal visible from the start. The buffs below are recipe-production-rate multipliers applied to every networked T3+ island; they do NOT multiply XP gain, route capacity, or storage caps (those have their own scaling systems). "Networked" is defined in §2.4 — an island route-graph-connected to home.

* 3 islands at Tier 3+: small global production buff (+5%)
* 5 islands at Tier 3+: moderate global buff (+10%) and unlocks Robotics breadth nodes
* 10 islands at Tier 3+: large global buff (+25%) and unlocks "Auto-Patronage" passive (see Auto-Patronage details below)
* 20 islands at Tier 3+: production buff plateaus at +25% (same as the 10-island milestone — no additional numeric buff) and the Network Consciousness gate is satisfied, which is a prerequisite for Omniscient Lattice (T5 endgame artifact); see §13.3 for the Lattice Node count check (`LATTICE_ACTIVATION_THRESHOLD = 20`).

**Implementation note — milestone-4 buff.** `MILESTONE_TABLE` in `network-consciousness.ts` sets `buff: 1.25` for both the ≥10 and ≥20 rows. Reaching milestone 4 does not raise the multiplier; it only satisfies `LATTICE_ACTIVATION_THRESHOLD` so that `computeLatticeActive` in `lattice.ts` can fire.

**Auto-Patronage details.** When a new colony is settled after the 10-island milestone is achieved, the engine automatically establishes three default funneling routes from the nearest Patron Hub island to the new colony:

* Route 1: fuel matching the new colony's tier (e.g., Biofuel for a T1 colony, Diesel for T2, etc.) — T1 cargo tier, default capacity per route type
* Route 2: Foundation Kit components — a multi-resource priority list `[Iron ingot, Brick, Lumber, Glass, Gear]` — T1 cargo tier, default capacity
* Route 3: misc T1 raws — a multi-resource priority list `[Wood, Stone, Coal, Iron ore, Copper ore]` — T1 cargo tier, default capacity

The Patron Hub island pays the routes' fuel costs from its own fuel reserves. If the Patron Hub runs out of fuel, the routes pause (consistent with normal route fuel rules). Player can manually delete or reconfigure these routes at any time after creation.

**No-Hub case and tiebreak.** If no Patron Hub building exists in the player's network when the 10-island milestone is reached (or when a new colony is settled afterward), Auto-Patronage silently no-ops — newly-settled colonies get no automatic routes. The engine does not auto-build a Patron Hub for the player; that remains a manual decision. "Nearest Patron Hub" is computed as straight-line euclidean distance between island world coordinates; ties (rare, but possible when a new colony is equidistant from two Hubs) are broken deterministically by lower-ID Patron Hub island.

### 9.7 Tier Reset

A player may pay to revert an island to Tier 1, primarily to redo skill-tree choices. Available from Tier 3 onward — pre-T3 islands have nothing meaningful to reset.

**Cost (placeholder):** a pile of T2-T3 components scaling with the island's current level (placeholder formula: cost proportional to level²). High-level resets represent serious production commitment, not casual undo.

**Cleared by reset:**

* Level → 1, XP → 0
* All spent skill points refunded as unspent
* `unlockedNodes` and `unlockedEdges` cleared (full skill-tree wipe)
* Tier breakpoint state reverts to T1 — T2+ buildings remain placed but stop operating until the island re-climbs into their tier band

**Preserved by reset:**

* All placed buildings (inactive if above current tier; the player may delete and rebuild during re-progression)
* Terrain and tile types
* Modifiers (rare modifiers do not re-roll)
* Local inventory (full stockpile preserved)
* Storage caps (derive from preserved buildings)

**Cooldown:** placeholder 24 real-time hours between resets on the same island. Prevents spam-resets to grind funneling XP.

**Skill-point economics (a net gain, not a neutral respec).** The refund and the re-climb interact: reset returns *every* SP the player had spent, then re-leveling 1→L re-grants the entire level→SP curve a second time, because SP is granted per level-up (`skillPointsForLevelUp` in §9.1) with no per-level high-water-mark — nothing tracks "already earned this level." After one cycle back to the prior level the player therefore holds ~2× their cumulative SP, and because the grant is geometric (`floor(1.031^level)`) almost all of that value sits in the handful of top levels re-crossed. This is intentional, not an exploit: Tier Reset is the engine that produces the post-cap SP overflow that §9.1 routes into late-game prestige-style spending — it is a prestige loop, not merely a skill-tree redo. The loop is **rate-limited, not SP-priced**: the 24h cooldown, the level²-component cost, and the fact that T2+ buildings sit inactive (throttling production) until the island re-crosses their tier band are what keep re-climbing from being free SP. Balancing this loop means tuning those three brakes, not the refund itself.

**Merged islands:** a Tier Reset on a merged island (§3.6) operates on the entire merged identity. All constituent ellipses, all buildings on each, the unified inventory — all reset together. There is no way to "split" a merged island via Tier Reset; merge remains permanent.

### 9.8 Trade Offers

A short-cadence engagement loop layered over the hours-long tier climb. A cheap Tier-1 **Signal Exchange** building periodically surfaces a single expiring **barter offer** on the island that hosts it: dump some of your fullest stockpile for an under-stocked resource you already make. The world advances on a live per-frame ticker but its reward cadence runs on the scale of hour-long tier climbs; Trade Offers add a seconds-scale decision the player can act on minute-to-minute.

The mechanic is also a **cap-stall pressure-valve**. Per §9.1 a resource sitting at its storage cap with no consumers idles its producer at zero XP (with any live draw it earns only at the throttled rate) — a capped silo is dead weight. An offer biased toward dumping overflow stock relieves that pressure, converting a stuck resource into one the player is short on.

**No XP from trades.** Accepting an offer shifts inventory and nothing else — trades grant zero XP. Progression stays strictly production-only; trading is logistics convenience, not a leveling path. This is a deliberate exclusion, not an oversight: pricing a swap to grant XP would turn the barter window into a leveling printer.

**The Signal Exchange building.** A Logistics-category Tier-1 building, 1×1 footprint, cheap placement cost (placeholder: 40 wood + 20 stone), no recipe and no power draw (so it accrues no §4.7 maintenance). Its sole effect is to make its island eligible to receive offers. Each island either has a Signal Exchange (eligible) or does not (no offers); the building is the gate.

#### 9.8.1 Offer generation

When an eligible island's spawn cooldown reaches zero (§9.8.3), the engine attempts to generate one offer for it:

* **Give pool** = every resource the island currently holds in positive stock (`inv > 0`). **Get pool** = every resource the island has *ever produced* (`everProduced`), regardless of current inventory. The ever-produced filter is the structural guard against chain-skipping: **you can only receive a resource you already make**, so a trade can never shortcut a production chain you haven't built, and the eligible pool self-scales with progression. If either pool is empty, no offer is generated.
* **Fill-biased selection.** Each side rolls `biasK` candidates (placeholder: 2) from its pool and keeps the most extreme by fill fraction (`inv / cap`): the give side keeps the *highest* fill (prime to dump), the get side keeps the *lowest* fill (most under-stocked). A resource at `cap == 0` with positive stock reads as fully overflowing. If the two sides collide on the same resource, the engine falls back to any distinct give candidate; if none exists the attempt is abandoned and retried.
* **Tier-reach gate.** Reject and retry if `|tier(get) − tier(give)|` exceeds the offer's reach (placeholder `maxReach` = 2). Resource tier is read off the §9.1 `xp\_weight` ladder (weights 1, 3, 10, 30, 100, 300, 1000 map to tiers T0–T6, nearest-rung).
* **Pricing.** The fair baseline output-per-input is the per-unit weight ratio `xp\_weight[give] / xp\_weight[get]` — verified fair against the recipe table, whose realized tier-up multiplier tracks the ≈3.16×/tier ladder. That baseline is multiplied by a rolled **spread** centred on `0.8^Δtier` (with bounded random variance and the skill-tuned favourability shift). The spread is the deal-quality signal: near-tier swaps land favourable, far-tier swaps land lossy, and offers average ≈neutral. The flat tier-distance tax is what stops a full silo of bulk T0 from converting into a fortune of endgame components — quantity, not per-unit price, is where exploits would live, so the size cap and ever-produced gate (below) carry that load.
* **Size.** The give quantity is a fraction of current give-stock (placeholder `sizePct` = 10%), clamped so the received quantity never exceeds the get resource's output **headroom** (`cap[get] − inv[get]`). Whichever side binds, the other is back-computed from the price so the swap is exact. If either side clamps to zero the attempt is abandoned.

A generated offer records its give/get resources and quantities, a spawn timestamp, and an expiry timestamp (`spawnedAt + expiryMs`, placeholder expiry = 5 minutes).

#### 9.8.2 Acceptance

On accept, the engine re-clamps the offer against the island's *current* give-stock and *current* output headroom — production may have moved stock between spawn and accept — then subtracts the (re-clamped) give quantity and adds the get quantity in place. **No XP is granted.** The offer is consumed and its slot frees.

#### 9.8.3 Lifecycle — online-only, refresh-proof cadence

Offers exist only while the player is present, and the cadence that paces them is persisted so it cannot be farmed by reloading.

* **Online predicate.** An island's offer machinery only advances on **online** frames, defined as `document.visibilityState === 'visible'`. "Visible" excludes a minimized window or a backgrounded tab; a visible-but-unfocused window (another window on top with focus elsewhere) still counts as online — the earlier `hasFocus()` requirement was dropped (owner request 2026-06-10). On any non-online frame, zero online time is credited.
* **One offer per island.** At most one active offer per Signal-Exchange island at a time. While an offer is live, no new one spawns for that island.
* **Persisted online-time cooldown.** The spawn timer is a per-island `tradeCooldownMs` field that lives in persisted island state, *not* in ephemeral runtime. Each online frame an eligible island with no active offer burns its cooldown down by the frame's online time, and spawns an offer the moment the cooldown reaches zero. The per-frame credit is capped (`ONLINE\_DT\_CAP\_MS`, placeholder 3 s) so a long hidden→focused jump cannot dump accumulated wall-clock time into the countdown and spawn instantly.
* **Offers themselves stay ephemeral.** Active offers are runtime-only and are never serialized (§9.8.5). Reloading with an offer on screen forfeits it; the already-running cooldown is unaffected. Because the *cooldown* (not the offer) is what persists, the original ephemeral-cadence behaviour — which let a player load, accept the immediately-spawned offer, reload, and repeat — is closed: a fresh load reads the mid-countdown cooldown and no offer appears until real online time elapses.
* **Reset on resolution.** When an offer resolves — by accept *or* by expiry — that island's cooldown is reset to its effective cadence (§9.8.4), starting the next wait. The cooldown is reset only on resolution, never at spawn, so an accept's compounding increment (below) lands on the very next offer. The first offer after the building is placed is immediate (cooldown seeds to 0).

#### 9.8.4 Compounding speedup

Each island carries a `tradeAcceptCount`. Every accepted trade or manual reject on that island increments it, and the island's **effective cadence** is

```
effective\_cadence\_ms = max(FLOOR\_MS, base\_cadence\_ms \* 0.99^tradeAcceptCount)
```

so every timely reaction (accept or manual reject) makes that island's next offer arrive ≈1% sooner — "every trade you react to on time makes the next one come a little faster." `base\_cadence\_ms` is the per-island base spawn interval (placeholder 2 hours of online time, already folded with the frequency skill of §9.8.6). The result is floored at `FLOOR\_MS` (placeholder ~1 minute) so an enthusiastic trader cannot drive cadence toward zero and re-open the farm by another route. The accept counter is per-island, matching the per-island Signal Exchange / cadence / state. **Silent expiry (timeout) is a lapse, not a reaction: it resets `tradeAcceptCount` to 0**, forfeiting the accumulated speedup, then resets the cooldown to the (now base) cadence to start the next wait. Only a timely reaction compounds; letting an offer lapse sends the next offer's interval all the way back to base.

#### 9.8.5 Persistence

`tradeCooldownMs` and `tradeAcceptCount` persist per island (schema v20; backfilled to 0 for pre-v20 saves via `migrateV19toV20`). Active offers do **not** persist — they are regenerated fresh after load once the cooldown elapses. Offers are, however, deterministic per `(worldSeed, islandId, tradeAcceptCount)` so a reload cannot re-roll the terms.

Both fields are **preserved across Tier Reset (§9.7)** — a Tier Reset does not clear `tradeAcceptCount`; the §9.7 preserve-set extends to it. (Tier-Reset preservation and the §9.8.4 timeout-reset are independent concerns: a Tier Reset leaves the accumulator intact, whereas letting an offer lapse resets it to 0.)

#### 9.8.6 Skill tuning

A **Logistics → Network** cluster tunes four offer parameters (skill nodes; all base values above are placeholders the cluster modulates upward — multipliers are clamped so a node can never worsen the base tuning):

* **Frequency** — divides the base cadence (more frequent offers).
* **Size** — multiplies the per-offer fraction of give-stock.
* **Tier reach** — adds to the maximum `|Δtier|` between give and get (wider swaps).
* **Spread favourability** — shifts the spread centre toward better deals.

The 1%-per-accept compounding speedup (§9.8.4) is a flat mechanic, not a tunable node, and stacks on top of the frequency skill.

#### 9.8.7 Offline parity

Trade Offers preserve the offline-parity pillar of §15.5. Both the cooldown countdown and the accept accumulator advance on **focused online time only** — offline (or unfocused) time advances neither. An absent player simply misses optional offers; the base economic simulation and offline catch-up are unchanged. Wall-clock pacing was rejected precisely because a returning player would otherwise get an instant offer, softening the online-only contract.

\---

### 9.9 Active-Play Production Bonus

A global recipe-rate buff that rewards focused presence, complementing §9.8's online-only trade cadence. Every focused minute adds **+0.1%** to every recipe rate on **every** island; every unfocused minute — alt-tabbed, minimized, or with the game closed — burns the accrued bonus at **−0.3%/min**, floored at 0. There is no cap: decay is the only counterweight (an overnight gap erases any realistic balance, so in practice this is a same-session mechanic despite being persisted).

* **Focus condition** — identical to §9.8.3 trading: `document.visibilityState === 'visible'` (visibility-only; `hasFocus()` dropped per owner request 2026-06-10).
* **State** — `WorldState.activeBonusMs`, a balance of "effective focused milliseconds". Bonus fraction = `activeBonusMs / 60000 × 0.001`; the multiplier `1 + fraction` threads into `computeRates` as `RatesContext.activeBonusMul` alongside `ncBuff`. XP accrues on the boosted production, like every rate buff. Unlike `ncBuff` (networked T3+ only) it applies to every island.
* **Accrual law** — one rule covers every loss mode: focused frame-dt accrues (clamped to the §9.8.3 3 s online-dt cap); every other wall-clock millisecond decays at 3×. A hidden-tab gap (rAF stops) is charged on the refocus frame; a closed-game gap is charged at load from the snapshot's `savedAt`, before offline catch-up runs — catch-up production uses the post-decay multiplier.
* **Sampling** — the multiplier drifts 0.1%/min, so it is sampled per advance call as a constant; §15.3's constant-rate piecewise integration is unaffected.
* **UI** — the HUD economy panel shows an always-visible "Active bonus" row (`+X.X%`, `—` at 0); the inspector recipe bonuses line appends `active ×N.NN` when above 1.
* **Persistence** — schema v22 (`activeBonusMs`; v21 saves migrate with 0).

Source of truth: `src/active-bonus.ts`.

\---

## 10\. Funneling (Patron-Protégé)

### 10.1 Mechanic

While a destination island is below Tier 3, resources it consumes from incoming routes generate bonus XP. For each unit of resource `r` actually consumed from an inbound route — meaning the destination's local recipes pulled it as input — the destination gains:

```
funneling\_xp\_per\_unit = xp\_weight\[r] \* funneling\_bonus\_percent
```

The same `xp\_weight[r]` table from §9.1 applies. This means the strategic value of a funneled resource scales with its tier: funneling T5 raws into a Tier-1 colony levels it dramatically faster than funneling wood, even at identical route capacity. Placeholder `funneling\_bonus\_percent` = 50%.

When the destination crosses Tier 3, the funneling bonus zeroes out: no further funnel credit accrues on inbound deliveries. Inbound resources continue to feed production normally (their primary purpose); they simply stop generating XP-on-import. (Funnel credit accrued *before* the colony reached Tier 3 continues to convert to XP as those resources are consumed — only further accumulation stops.)

Important: the bonus applies to imported-AND-consumed resources. A resource that arrives but sits in storage without being consumed by a recipe gives no bonus XP until it is actually used. Players cannot funnel-and-stockpile their way to free levels.

### 10.2 Caps

Funneling has no separate cap. Natural limits:

* Route capacity per second (set by route type)
* Destination's own per-second consumption (gated by its building count and active recipes)

### 10.3 Patron Hub Building

A Tier-3 logistics building. It is not required for ordinary (manual) funneling — `funnelPending` credit accrues on any inbound delivery regardless of whether a hub exists. Its actual role is to gate **Auto-Patronage** (§9.6 / §12.7): when a new settlement is founded, automatic supply routes are spawned only from the nearest island that hosts an operational Patron Hub; with no hub anywhere in the network, settlements receive no automatic supply lines.

\---

## 11\. Drones

### 11.1 Launch

Launched from Drone Pad (T2+) or Launch Tower (T4 only). Specify:

* Direction vector (player-chosen)
* Fuel loaded (player-chosen, gates range — fuel resource matches launching island's tier per §11.7; range = fuel × tier efficiency)

Drone launches originate from the Drone Pad's footprint centre on the launching island (same idiom §14.5 specifies for Spaceport satellite launches). When multiple Drone Pads are placed on a single island, the first one in placement order is used.

### 11.2 Travel

Drones travel in real time at speed determined by tier. They scan a **capsule-shaped corridor** along their flight path: the set of all points within scan radius `r` of any point on the path. In 2D this is a swept-disk shape (rectangle along the path with circular end-caps at launch and turnaround points). An island is revealed when any of its **footprint cells** (not merely its centre) falls inside the corridor. Reveals are delivered live each tick while the drone's position sits inside an antenna's signal range; cells scanned out of antenna range are buffered and reported on return (see §11.3 and §11.6).

For T1-T3 drones, the path is a straight outbound line + return; for T5 path-drawn drones, the path follows the player-drawn waypoint sequence. T4 omnidirectional pulse is a special case — a single disk of radius R centered on the Launch Tower (no flight path).

### 11.3 Return

While in flight, a drone reveals corridor cells live each tick whenever its position is inside an antenna's signal range. Cells scanned out of antenna range are buffered onboard and flushed on return — this buffered dark-mode telemetry applies to every drone, not just the T5 path drone (§11.6). New islands become visible on the world map. Discovered islands cannot be developed or used as route endpoints until populated by a settlement vehicle (see Section 12).

### 11.4 Failure

A drone is lost (does not return, fuel and unit consumed) if any of the following occur in transit:

* Fuel exhausted mid-journey
* Destroyed by weather (per-cell roll, see Section 2.6)

### 11.5 Drone Tiers

Drone Pad (T2) gates drone launches; once built, the player picks any tier from T1 up to the launching island's current tier via the Drone Ops tier picker. A higher-tier island can deliberately launch a cheap lower-tier drone (e.g. T1 biofuel scout from a T5 island) for short hops instead of always burning the highest-grade fuel:

* T1: cheap entry option — biofuel-fueled, short range, narrow scan corridor; most weather-fragile tier
* T2: range R, scan corridor radius W (capsule shape per §11.2), biome-type detection at distance
* T3: range 3R, scan corridor radius 2W, multi-target — records all islands within the capsule corridor
* T4: omnidirectional pulse from Launch Tower — single disk of radius `R\_T4 = 3R` centered on origin (no flight path; not corridor-shaped). `R` is the stratification cell side length (§2.1), so T4 covers a 3-cell-radius disk per launch.
* T5: path-drawn drone with dark-mode telemetry (see Section 11.6)

* T6: Spaceport-launched long-range drone; available only when T6 access is unlocked (`ascendantCoreCrafted && hasSpaceport`). Burns Antimatter Propellant (§11.7 / §14.10). `tier_efficiency = 18` (placeholder), scan corridor radius `= 16 tiles` (placeholder), weather-destruction multiplier `= 0.2` (most rugged tier).

**Implementation note — T6 drone constants are design-spec-locked placeholders.** `DRONE_TIER_EFFICIENCY[6] = 18`, `DRONE_TIER_SCAN_RADIUS[6] = 16`, `DRONE_TIER_MULTIPLIERS[6] = 0.2` in `drones.ts`; launch building is the Spaceport (§14.2).

### 11.6 T5 Path-Drawn Drone

Available only on islands with Tier 5 access (level 50, AI core crafted, Path Drone Foundry built).

**Launch process:**

The player draws a path on the world map as a sequence of waypoints. The path can have arbitrary length up to a fuel-imposed limit. The drone follows the path at T5 speed, scanning a wide corridor along the entire route.

**Telemetry and dark mode:**

* Within an antenna's signal range (computed from populated islands' Antenna buildings, not island vision range): the drone transmits live. Discovered islands appear on the map immediately as the drone passes them.
* Beyond any antenna's signal range: the drone enters **dark mode**. It continues recording everything it scans, but transmits nothing. All findings are reported only on return.

This makes long-range path drones high-risk, high-reward. The player commits fuel and a Foundation Kit equivalent of components to send a drone far. If it returns, it dumps a complete record of everything in its corridor. If it fails (fuel, weather), all that data is lost.

**Use cases:**

* Systematic area sweep: zigzag path covering a large region
* Targeted long-range probe: straight line into deep unexplored space
* Rare-feature hunt: search for unique-feature islands in remote areas

**Failure modes:**

* Fuel exhausted mid-path: lost, no data returned
* Destroyed by weather (in dark mode the player may not learn for hours of real time that it failed)
* Returns successfully: full data dump, including everything found in dark mode

**Weather interaction:**

T5 path drones have x0.5 destruction multiplier. They are still vulnerable in severe storms, especially over long paths. Weather visibility does not help once the drone is in dark mode: a storm developing in its corridor while it is out of range is unforeseeable.

### 11.7 Fuel, Range, and Dispatch

This section is the canonical reference for fuel, range, and dispatch behavior across all flying assets — drones, settlement vehicles, and T6 satellite launches.

**Fuel by tier.** Each tier of dispatch consumes its own dedicated fuel resource:

|Tier|Fuel resource|Catalog reference|
|-|-|-|
|T1|Biofuel|§6.2|
|T2|Diesel|§6.3|
|T3|Aviation Kerosene|§6.4|
|T4|Cryogenic Hydrogen|§6.5|
|T5|Plasma Charge|§6.6|
|T6|Antimatter Propellant|§14.10|

A craft of tier T can only burn tier-T fuel; it cannot fall back to a lower grade. Producing a higher-tier fuel requires the matching refining infrastructure, so expanding a high-tier island's reach requires investment in that island's fuel chain. An island that has reached T4 mechanically but neglected its fuel chain has T4 vehicles it cannot launch.

**Range formula.** Range scales linearly with fuel loaded:

```
range\_in\_cells = fuel\_units \* tier\_efficiency
```

Where `tier\_efficiency` is a per-tier per-vehicle base value (placeholder), further scaled at dispatch by the launching island's skilltree drone-fuel-efficiency multiplier (and the scan-corridor radius by a drone-scan-radius multiplier). Higher-tier vehicles have higher efficiency — they go farther per unit of their (more expensive) fuel. A T3 drone burns more T3 fuel per range unit than a T1 drone burns T1 fuel in absolute material count, but its T3 fuel grade is harder to produce, so the effective economic cost ratio between tiers is what tuning targets.

**Dispatch capacity.** One craft in flight per launch building:

|Building|Concurrent slots|Notes|
|-|-|-|
|Drone Pad (T2+)|1 drone|Builds and launches scout drones|
|Launch Tower (T4)|1 drone|Independent of Drone Pad on the same island; T4 omnidirectional pulse|
|Path Drone Foundry (T5)|1 path-drawn drone|T5 only|
|Shipyard (T1)|1 ship|Coastal placement required|
|Helipad (T2)|1 helicopter||
|Spaceport (T6)|1 satellite or 1 repair drone|Cannot dispatch a sat and a repair drone simultaneously|

The player builds additional Pads, Shipyards, etc. (or develops more islands with their own buildings) to dispatch in parallel.

**Failure notification.** The player only learns of a failed dispatch when the craft's expected return or arrival time elapses without the craft arriving.

* While in flight, UI shows "in flight, expected back at T+Xh" (drones) or "in transit, expected to arrive at T+Xh" (settlement vehicles, satellites).
* If T+Xh elapses without the event, UI flips to "lost". Fuel, payload (Foundation Kit / Orbital Insertion Package), and craft itself are all consumed.
* The failure cell on the path is not revealed. The player does not learn anything about distant weather conditions from a failure event.

This preserves the dark-zone experience: distant launches commit information-blind, the world resolves deterministically, and the player only learns the binary outcome at the planned end-of-flight timestamp. Internally, the deterministic weather model has already decided the craft's fate at launch time; failure resolution is a non-event from the player's perspective until the timer elapses.

\---

## 12\. Settlement Vehicles

### 12.1 Lifecycle

Identical to drones at the engine level: a launched vehicle has a source, direction, fuel, expected return/arrival time, and a tier. Differences are in destination and effect.

* Drone returns to source after scanning. Adds discovered islands to the map.
* Settlement vehicle (ship or helicopter) travels one-way to a specified discovered target island. On arrival, populates the target. Vehicle is consumed in the process.

### 12.2 Launch Requirements

To launch a settlement vehicle the source island must:

* Have the appropriate launch building (Shipyard for ship, Helipad for helicopter)
* Have sufficient fuel for the vehicle
* Have a Foundation Kit in inventory

Player specifies the target (must be a discovered, unpopulated island within range) and the vehicle tier.

### 12.3 Foundation Kit

A composite craftable item used as the "starter package" delivered on arrival. There are three tiered variants matching vehicle tier:

```
Standard Foundation Kit (foundation_kit):           5 Iron ingot + 10 Wood + 5 Bolt
Enriched Foundation Kit (foundation_kit_enriched):   5 Steel + 1 Microchip + 5 Wire + 5 Gear
Refined Foundation Kit  (foundation_kit_refined):    5 Stainless steel + 1 Quantum chip + 1 Fuel cell + 1 Computing module
```

T6 vehicles use the Orbital Insertion Package (§14.10) instead — orbital-grade payloads carry their own bootstrap mass, distinct from the Foundation Kit chain.

Standard kits craft at a dedicated Kit Assembler building (T1). Enriched and Refined require a Kit Assembler Enriched (T3) and Kit Assembler Refined (T4) respectively. Each kit is stored as a single inventory item. (Note: dispatch currently consumes only the Standard `foundation_kit` resource regardless of vehicle tier — the tiered-kit requirements below describe intended design, not enforced gates.)

**Vehicle-to-kit mapping:**

|Vehicle|Required kit|Extra notes|
|-|-|-|
|T1 Cargo Ship|Standard||
|T2 Light Helicopter|Standard||
|T2 Heavy Freighter|Standard|Carries 1-2 kits per §12.6 loadout|
|T3 Industrial Carrier|Enriched|Carries 2 kits — colony arrives at level ~5 due to the richer starter cargo (see §12.6)|
|T3 Heavy Lift Helicopter|Enriched|Carries 1 kit + extras|
|T4 VTOL Tilt-Rotor|Refined|Carries 2 kits|
|T5 Spacetime Anchor|Refined|Skips the vehicle stage entirely; consumes one Refined kit but no fuel and no vehicle (per §12.6)|

### 12.4 Travel and Arrival

Travel time scales with distance and is determined by vehicle tier (helicopter is faster than ship at the same tier). On arrival:

1. Target island is marked populated, set to level 1.
2. A starting building is automatically placed at a default position: Cargo Dock for ships, Helipad for helicopters.
3. The Foundation Kit is consumed.
4. The island becomes available for full interaction (player can now place buildings, set up routes, dispatch its own drones once it has the supporting infrastructure).

**Richer drop for T3+ carriers.** Higher-tier carriers consume their extra Foundation Kits (per §12.6 loadouts) to deliver a richer starting state on arrival. The colony arrives at level 1 in all cases — XP is not directly granted. The "level ~5" shorthand in §12.6 refers to the richer starter cargo and pre-placed buildings, not a level grant.

|Carrier|Pre-placed buildings (in addition to Cargo Dock / Helipad)|Starter inventory|Free skill points|
|-|-|-|-|
|T3 Industrial Carrier|1 Solar Panel + 1 Workshop + 1 Mine|Contents of the delivered Standard Foundation Kit(s)|4|
|T3 Heavy Lift Helicopter|1 Solar Panel + 1 Workshop|Contents of the delivered Standard Foundation Kit(s)|4|
|T4 VTOL Tilt-Rotor|1 Solar Panel + 1 Workshop + 1 Coal Generator + 1 Storage Crate|Contents of the delivered Standard Foundation Kit(s)|6|

Pre-placed buildings are placed by the engine at deterministic default positions (inscribed tiles in scan order, skipping the auto-placed dock/helipad). Skill points are added to the new colony's `unspentSkillPoints` total.

**Foundation Kit decomposition on arrival.** The kit, which lives in source-island inventory as a single composite item per §12.3, decomposes into its raw constituent resources (5 Iron ingot + 10 Wood + 5 Bolt for the Standard kit; this Standard recipe is credited per kit regardless of vehicle tier) the moment it arrives at the colony. A level-1 colony has no storage buildings, so the kit contents are held under a one-time **starter inventory grace cap** that allows the colony to hold the kit's raw contents even with zero specialized or generic storage. The grace cap shrinks resource-by-resource as the player builds proper storage (Crates, Silos, etc.) — once normal cap meets or exceeds current inventory for a given resource, that resource's grace allowance is removed. Resources still held under grace cannot exceed the kit-delivered quantities (player can't "fill" the grace bucket with more from routes; routes still respect normal caps).

### 12.5 Failure

Settlement vehicles can be lost in transit due to:

* **Base mechanical failure:** small chance per voyage (2% for T1 ship, 2.5% for T1 helicopter, declining with vehicle tier). Represents critical malfunction.
* **Weather destruction:** per-cell roll along the entire path, using the vehicle multiplier from Section 2.6.

On failure (any cause):

* Vehicle, fuel, and Foundation Kit are lost
* Target island remains unpopulated (can be retried with another vehicle)

Long routes through bad weather become genuinely risky, especially with low-tier vehicles. The player can mitigate by waiting for weather windows (visible only within Weather Station range), using higher-tier vehicles, or routing through known-clear cells.

### 12.6 Vehicle Tiers

|Vehicle|Tier|Speed|Loadout|Range|Notes|
|-|-|-|-|-|-|
|Cargo Ship|1|low|1 kit|medium|Coastal departure, slow|
|Heavy Freighter|2|low|1-2 kits|long|Larger ship, can carry surplus T1/T2 starter materials|
|Industrial Carrier|3|medium|2 kits|very long|Drops the colony at level \~5 due to richer starter cargo|
|Light Helicopter|2|high|1 kit|short|Fast, fuel-hungry|
|Heavy Lift|3|high|1 kit + extras|medium|Faster than freighter|
|VTOL Tilt-Rotor|4|very high|2 kits|long|Late-game settlement vehicle|

T5: Spacetime Anchor bypasses the vehicle stage. A T5 island can populate any discovered island instantly, consuming a Foundation Kit but no vehicle and no fuel.

### 12.7 Interaction with Network Consciousness

At Network Consciousness milestone of 10 islands at Tier 3+, "Auto-Patronage" passive activates: a newly populated island automatically receives default funneling routes from the nearest Patron Hub. This dramatically reduces manual setup for late-game expansion.

\---

## 13\. Tier 5: Transcendence

### 13.1 Access

T5 is a hidden T5 sub-band on the skill tree (the depth-5+ nodes of the §9.3 sub-paths, gated by `tierRequiredForDepth(5)`). It unlocks on an island only after:

* Island reaches level 50
* Island has crafted at least one AI core (T4 endgame)

### 13.2 T5 Buildings

Listed in Section 8.5 (Casimir Tap), 8.4 (Reality Forge, Singularity Battery), 8.9 (Probability Engine, Genesis Chamber, Lattice Node, Universe Editor).

### 13.3 T5 Capabilities Unlocked

Mechanically:

* **Time manipulation — Time Lock.** A T5 building (catalog entry in §8.9). Each Time Lock has its own banked-time stockpile (cap placeholder: 24 real-time-hours equivalent of banked time per Lock).

  *Banking:* while the player is offline, the player can configure each Time Lock-equipped island to BANK its tick instead of advancing. A banked island sits paused for the offline period — it produces nothing, levels nothing — and the Time Lock accumulates 1 banked-time unit per real-time minute of offline on that island, up to the per-Lock cap. The trade-off is real: banking means giving up offline progression on that island in exchange for stockpiled time. The player picks per-island per-session whether to bank or to let the island advance.

  Spending and banking units are symmetric: 1 banked unit = 1 real-time minute of offline accumulation = 1 real-time minute of 3× tick-rate acceleration when spent. A 24-hour offline window banks 1440 units (capped at the Time Lock's stockpile cap), which spends as 1440 minutes (24 hours) of 3× acceleration on a target island.

  *Spending:* while the player is online, banked time is spent on demand from any Time Lock to accelerate any target island's tick rate. Placeholder conversion: 1 unit of banked time = 1 real-time minute of 3× tick-rate acceleration on the target island. During acceleration, every system on that island (production, XP gain, recipe cycles, drone construction) runs at 3× speed.

  **Concurrency.** A target island can only be under one acceleration spell at a time. Multiple Time Locks pooling spend onto the same target stack their durations sequentially in a queue: the first Lock's duration runs to completion, then the next Lock's duration begins, then the next. The acceleration multiplier itself never compounds — always 3× regardless of how many Locks are spending on the target. This avoids inter-island flow conservation problems (a 9× island would pull 9× from routes that exist in real time, breaking other islands' inventories). To accelerate an island for longer, queue more spends; to accelerate two different islands in parallel, dispatch from different Locks to different targets simultaneously.

  *Cap and waste:* banked-time stockpile above the per-Lock cap is wasted on the spot — the player must spend or lose. Players extend total capacity by building more Time Locks on more T5-mastered islands.

* **Free creation — Genesis Chamber.** The player picks a target resource from the T1-T4 catalog. The Chamber consumes large amounts of electrical power continuously and outputs the chosen resource at a slow rate (placeholder cycle: 5 minutes per unit). Power draw scales superlinearly with target tier (placeholder: T1 ~50 kW, T2 ~500 kW, T3 ~5 MW, T4 ~50 MW). T5+ resources cannot be materialized — those still require natural extraction or T5 recipes. The Chamber bypasses missing chain inputs; it does not skip the high-tier endgame.

* **Spacetime folding — Spacetime Anchor.** Links islands as one logical unit (zero-distance transport, see §2.4 transport tiers).

* **Reality editing — Universe Editor.** The player picks a target biome from the standard list (§3.2). The island's biome is reassigned and its terrain regenerated according to the new biome's rules — ore vein positions, water tiles, etc. are re-rolled from the world seed under the new biome. Existing buildings remain placed but may become invalid due to changed underlying tiles (a Mine on what used to be an ore vein will halt if the regenerated tile no longer has the vein). Invalid buildings stop operating until the player clears them. **Modifiers are wiped on Universe Editor use** and re-rolled per the new biome's modifier distribution (§3.5) — but rare/natural-only modifiers (Aetheric Anomaly, Frozen Core, etc.) are excluded from the re-roll, since those remain natural-generation-only. An island losing Aetheric Anomaly to a Universe Editor pass is a real cost: the +50% T5 raw extraction efficiency goes with the modifier. Each use consumes substantial T5 components and is not instant; the building is reusable but each invocation is a heavy commitment.

* **Probability control — Probability Engine.** While powered, every drone launched from this island gains a +X% chance to encounter rare or unique islands per scan (placeholder: +25%). Multiple Probability Engines on the same island stack with diminishing returns (placeholder: 2 Engines = +40%, 3 Engines = +50%, 4+ Engines = asymptotic toward +60%). Affects only drones launched from this island; does not affect drones launched from networked or non-Engine islands. Continuous heavy T5 power draw while the Engine is active. Turning the Engine off (cutting power) suspends the bias but does not unlearn discoveries already made.

* **Network unity — Omniscient Lattice.** Activates when one Lattice Node is built on each of N T5-mastered islands (N = Network Consciousness threshold, default 20 from §9.6). Lattice Nodes are inert placeholders until the network reaches N; the moment the Nth Node is placed and active, the Lattice ignites globally. Once active:
  * All networked islands share a unified inventory pool — any building on any networked island can draw any resource from the global pool, with no transport delay
  * Cross-island adjacency applies through **Lattice Node portals**: a building 4-adjacent to its island's Lattice Node can claim adjacency from any building 4-adjacent to any OTHER Lattice Node on the network. The relationship is bidirectional and transitive — a Smelter adjacent to A's Lattice Node treats Heat Sources adjacent to B's, C's, etc. Lattice Nodes as if they were neighbors. Lattice Nodes therefore become spatial-puzzle anchors: the player clusters key shared resources (Heat Sources, Cooling Towers, Wastewater Treatments) adjacent to each Lattice Node to provide cross-network coverage. Buildings NOT adjacent to a Lattice Node retain only their normal local adjacency.
  * Storage caps sum across the network (the unified pool's cap for each resource is the sum of all networked islands' caps for that resource)
  * Routes between networked islands become redundant and may be deleted; transport to non-networked islands continues to use the route system as normal

  Activating Omniscient Lattice is the late-game logistics endpoint. Once it fires, the player's networked production is effectively a single very large island for resource and adjacency purposes.

* **Self-perpetuation — Eternal Servitor.** A T5 conversion mechanic. The player crafts a Servitor Conversion Kit at a Reality Forge and applies it to a placed building. The targeted building converts to its Eternal Servitor variant — permanently exempt from fuel consumption AND from the maintenance system (§4.7). Conversion is permanent; converted buildings cannot revert. Each Eternal Servitor is a per-building commitment using its own Conversion Kit.

  Conversion Kit recipe = `1 Eldritch Processor + 1 Phase Converter + the contents of the target building's tier maintenance recipe` (per the table in §4.7). For a T4 building: 1 Eldritch Processor + 1 Phase Converter + 10 Lubricant + 1 Exotic Alloy fragment + 1 Microchip. Higher-tier buildings cost more to convert because their maintenance materials are pricier.

  Late-game players use Servitor conversion strategically — typically on the most-supplied or hardest-to-resupply buildings (Fusion Cores, Particle Accelerators, Path Drone Foundries).

* **Path-drawn discovery:** T5 Path-Drawn Drone (see Section 11.6) allows arbitrary path tracing with dark-mode telemetry, enabling systematic remote-area sweeps and far-distant probing.

### 13.4 Endgame Goals

The "you have effectively mastered this universe" goals:

* Craft the first **Genesis Cell**: build new islands without geographical constraint
* Activate **Omniscient Lattice**: full network unity
* Construct **Ascendant Core**: requires T5 mastery on at least 3 islands; final transcendence object

No win screen. The game continues indefinitely after Ascendant Core; the player has effectively become a god-tier robot consciousness.

\---

## 14\. Tier 6: Orbital

T6 is the post-Ascendant horizon. The Ascendant Core ends the T5 transcendence arc; T6 is what follows when a robot intelligence with no remaining terrestrial limits looks up.

### 14.1 Access

T6 unlocks on an island only after both:

* An Ascendant Core has been crafted on this island (see 13.4)
* A Spaceport has been built on this island (see 14.2)

T6 mastery is per-island, like T5. T6 buildings, recipes, and skill nodes appear only on islands that meet both conditions.

### 14.2 Buildings

**Spaceport** (T6, footprint 4x4): single building serving as launch facility, ground-side communications antenna, and repair-launch facility. Tiers I / II / III progressively raise base launch success rate and ground-station comm range (200 / 300 / 400 tiles). Satellite stats themselves do not scale with Spaceport tier — they scale with the launching island's Orbital skill-tree investment (see 14.3).

**In-place tier upgrade.** Spaceport upgrades are a single-building lifecycle — the same placed Spaceport advances from tier I to II to III by consuming upgrade-recipe components (placeholder: tier I → II requires `5 Phase Converter + 2 Memetic Core + 50 Cryogenic Hydrogen`; tier II → III requires `10 Reality Anchor fragment + 5 Memetic Core + 100 Antimatter Propellant`). Upgrade is one-way; downgrade is not supported. Satellites already deployed by the Spaceport are unaffected by an upgrade — they keep their original launch-time stats.

If the Spaceport suffers a pad explosion (§14.7), its `tier` field is reset to 1 in-place — the building persists on the island; only the upgrade investment is lost. Skill-tree progress and existing satellites in orbit are independent of Spaceport state and persist regardless. Players concerned about tier-loss risk should colocate their highest-tier Spaceport on islands with strong launch-success skill investment.

**Orbital Tracking Station** (T6, footprint 3x3): ground-based radar. Detects orbital debris within a fixed range from the island. Without Tracking coverage, debris exists but is invisible to the player. Multiple Tracking Stations across multiple islands compose into a wider debris-detection network.

### 14.3 Satellite Variants


|Variant|Coverage radius|Comm range|Role|
|-|-|-|-|
|Scanner Sat|Large|Modest|Discovery + weather scan|
|Sweeper Sat|Medium|Modest|Passive debris cleanup|
|Relay Sat|None|Very large|Comm-graph extension only|
|Mirror Sat|N/A (boost ring at r\_half = 200 tiles)|Modest|Reflects sunlight to ground islands — additive boost to §2.7 effective solar multiplier with Lorentzian falloff (peakBoost = 0.7, half-power at d = 200 tiles, cut off at raw < 0.05 around d ≈ 720). Per-sat fields locked.|
|Repair Drone|N/A|N/A|Single-use maintenance, no orbital lock|

Stat ceilings per variant scale with the launching Spaceport's tier. Final stats per launch = variant base × Spaceport-tier multiplier. Mirror Sat's peakBoost / r\_half are LOCKED per the §14.3 implementation; they do not scale with Spaceport tier (saturation cap at 1.0 in §2.7 composition is the deliberate balance valve).

### 14.4 Communication Network

Each Spaceport and each satellite has a spherical communications radius. Two nodes form a comm link when `distance \<= max(range\_A, range\_B)` — only one node needs to reach the other.

This asymmetric reach is justified by the satellites' AI Core: each satellite's onboard AI buffers data and forwards it store-and-forward when a peer comes into range, even if the originating node was out of range when the message was generated. The narrative is "neighbour leaves a packet at a known address; the addressee picks it up later."

The communication graph is the union of all such links between Spaceports and satellites. Data (sat scan results, weather snapshots, debris detection) reaches the player only if a path exists through this graph from the satellite to a Spaceport on a populated island.

If the graph is disconnected:

* Disconnected satellites continue scanning and queue their data locally in a bounded buffer (placeholder cap: 100 entries per satellite). Each scan result (discovery, weather snapshot, debris detection) takes one entry.
* When the buffer fills, the oldest entries are evicted FIFO to make room for new ones — recent observations always preserved over old.
* Queued data delivers in bulk when (and if) the graph reconnects.
* If a satellite is destroyed before reconnection, all queued data is lost.

**Packet propagation through the connected graph (hand-off model).** A scan-result packet generated at satellite S moves through the comm graph one hop per tick toward any Spaceport. The next hop is chosen greedily — at each tick, the packet advances to the connected neighbor that has the shortest path to a Spaceport (BFS distance, ties broken by lower satellite ID). Packets do not duplicate: a single packet traverses one path. If the intermediate node holding a packet is destroyed before the next-hop tick, the packet is lost. If the intermediate node moves out of comm range of the packet's intended next hop before the hop occurs, the packet re-evaluates routing on the following tick (and may re-route through a different neighbor or buffer locally if no neighbor is in range).


The first satellite from a fresh Spaceport must be launched within the Spaceport's own comm range to remain connected. Subsequent satellites can chain outward by remaining in range of any existing connected node.

### 14.5 Coverage, Discovery, Weather

A locked Scanner Sat provides:

* **Discovery**: each tick, probability `p` of revealing any undiscovered island within coverage. `p` ramps from a low initial value toward an asymptote over real-time dwell on the cell. A few minutes catches most local islands; deep-orbit islands may take hours of continuous observation to surface. The dwell ramp is per-cell, so moving the satellite resets ramps in cells outside the new coverage.

**Implementation note — dwell-ramp formula and Discovery-skill multiplier.** The ramp is a saturating exponential: `p(dwell) = p_initial + (p_asymptote − p_initial) × (1 − exp(−dwell / τ))` with placeholder constants `p_initial = 0.001`, `p_asymptote = 0.05`, `τ = 5 min` (`SCANNER_INITIAL_P_PER_TICK`, `SCANNER_ASYMPTOTE_P_PER_TICK`, `SCANNER_DWELL_TIME_CONSTANT_MS` in `orbital.ts`). The per-cell dwell counter (`dwellByCellKey`) accumulates live `tickDeltaMs` each tick and cells that leave coverage are dropped immediately. The Discovery-skill `scannerDwellRateMul` bonus is a scalar multiplier baked into the sat at launch (`dwellRateMul` field); it inflates *effective* dwell passed to the formula (`effectiveDwell = dwell × dwellRateMul`) so the ramp reaches its asymptote sooner. The live counter itself always tracks real elapsed ms; the multiplier is the only launch-time component. Scanner Sat coverage also reveals ocean cells (both surface + depth) inside its disk, per §5 of the ocean-layer design doc.

Launched sats spawn at the Spaceport and travel to a player-chosen target tile, consuming onboard fuel proportional to distance; coverage / weather effects activate once the sat reaches station.

During transit (between launch and lock) the satellite is inert: every per-tick effect (scanner discovery, debris exposure, comm-graph participation) is gated on the satellite being locked, so an in-transit sat does not scan, is not reachable through the comm graph, and provides no coverage at all.

### 14.6 Movement

A locked satellite can be relocated by the player. Each satellite has an onboard maneuvering fuel reserve loaded at launch.

* Issuing a move command spends fuel proportional to relocation distance
* Move takes real time proportional to distance and thrust
* Movement can fail with low probability. Failure does NOT destroy the satellite — empty orbital space has nothing to destroy it. Instead the failure is a navigational miscalculation: the satellite arrives at an offset of 5–20% of its planned trip distance in a random direction, burning additional fuel proportional to the misdrop. If the burn would exceed onboard reserves, fuel clamps to zero and the satellite is stranded at the misdrop tile (recoverable via Repair Drone). No debris field is produced on move failure.

The initial launch is itself a move from the Spaceport to the player-chosen target; subsequent relocations use the same fuel/speed math. (Launch-time failures — pad explosion and orbit explosion in §14.7 — are distinct from in-transit move failure and retain destructive semantics, including debris generation.)

When the reserve depletes, the satellite cannot move further until a Repair Drone tops it up (Repair Drones serve double duty as repair and refuel).

### 14.7 Launch and Failure

Each Spaceport launch requires:

* Sufficient fuel for the chosen variant
* The variant's full recipe (in inventory)
* An Orbital Insertion Package (T6 Foundation-Kit equivalent — see 14.10)

Launch success is rolled against the island's current launch success rate, computed as additive percentages on probability with a hard cap:

```
success\_rate = clamp( base\[Spaceport tier] + sum(Orbital sub-path bonuses), 0.0, 0.99 )
```

Each skill node bonus is a flat additive value on the probability scale (a `+5%` node adds 0.05). Base rates per Spaceport tier are tuning placeholders — for example, Spaceport I starts around 0.30, Spaceport III around 0.70. Cumulative Orbital sub-path bonuses can push success near 0.99 but never reach 1.0 — there is always a residual ~1% chance of failure for dramatic tension. Success rate is always visible to the player; every launch is informed risk.

**Failure modes (probabilistic split, placeholder ~30 / ~70):**

* **Pad explosion:** the Spaceport reverts to tier I in place (its upgrade investment is lost, but the building itself remains). No surrounding terrain damage; no other building on the island is damaged. Fuel and the launch payload are lost. The Tracking Station and other satellites are unaffected (subject to debris consequences in 14.8).
* **Orbit explosion:** the satellite reaches orbit but breaks up after lock. The Spaceport is preserved. A debris field is generated along the spawn→target trajectory (the breakup happens partway to the player's chosen target rather than at a fixed offset from the Spaceport).

Both failure types preserve all other infrastructure on the island. The pad-explosion path is recoverable: re-upgrade the tier-I Spaceport back up and re-launch. Per-island skill-tree investment is independent of building state, so success-rate progress is not lost when a Spaceport is destroyed.

### 14.8 Debris

**Field representation.** Each debris field is anchored to a single stratification cell and stores a discrete fragment count for that cell. Hit probability per tick on any satellite within the cell is `fragments × hit_constant × satellite_cross_section_factor` (tuning placeholders). Fields do not spread to neighboring cells and do not decay over real time. A field is removed only when its fragment count is reduced to zero by Sweeper Sat cleanup.

**Generation:**

* Orbit-explosion failures: a debris field forms in the cell containing the failed lock point. Initial fragment count placeholder: 20 fragments.
* Destroyed satellites in flight or in orbit: a configurable amount of new fragments (placeholder: 10 fragments per destroyed satellite) added to the cell where the satellite was located. If that cell already has a debris field, fragments stack into the existing field; otherwise a new field is created.

**Detection:**

* Debris is invisible to the player unless covered by an Orbital Tracking Station's detection range.

**Per-tick effect on satellites within a debris field:**

Each tick, every satellite inside a debris field rolls for a hit. Hit probability is proportional to debris density and the satellite's orbital cross-section.

On hit, two outcomes:

* **High chance: lodge.** A randomly chosen sub-stat (scan refresh rate, weather refresh rate, or comm reliability) is permanently slowed by a small percentage. Lodges are cumulative across multiple hits; a satellite can carry several different sub-stat penalties simultaneously. A single Repair Drone delivery restores all slowdowns to 100%.
* **Low chance: destruction.** The satellite is destroyed and new fragments are added to the field.

**Kessler cascade:** because destruction generates more debris, a destroyed satellite in a debris field can hit other satellites, which can themselves destruct, which seed further fragments. A runaway cascade can render an orbital region effectively unusable until cleanup completes. Active management of debris is a real T6 problem.

**Cleanup:** Sweeper Sats parked in a debris field passively clear fragments over real time at a fixed rate per Sweeper. Sustained presence is the only way to permanently clean a region; a single Sweeper in a heavy field clears slowly, multiple Sweepers stack.

### 14.9 Orbital Skill Sub-path

Orbital is the fourth top-level branch of the skill tree, parallel to Extraction / Refinement / Logistics / Ocean (per §9.3). It contains four sub-paths: Launch, Communication, Discovery, Resilience.

Representative nodes (depth-ordered placeholders):

* Launch Discipline — base launch success rate +X%
* AI Stabilization — comm range of all satellites from this island +X%
* Solid-State Insertion — pad-explosion share of failures halved
* Orbital Reconnaissance — Scanner Sat dwell ramps faster (higher `p` per tick)
* Orbital Maneuvering — onboard fuel reserve doubled
* Cooperative Network — Relay Sat range +X%
* Resilient Plating — debris hit probability reduced (debrisProtection divides the per-tick hit chance; the lodge slowdown magnitude itself is unchanged)
* Hyperfine Optics — Scanner Sat coverage radius +X%

Deep nodes unlock at higher tier breakpoints and cost more skill points.

### 14.10 Recipes (placeholders)

```
Scanner Sat   = 4 Exotic Alloy + 2 AI core + 1 Spacetime fragment + 50 Aluminum + 1 Orbital Insertion Package
Sweeper Sat   = 4 Exotic Alloy + 1 AI core + 100 Carbon Steel + 20 Magnet + 1 Orbital Insertion Package
Relay Sat     = 6 Exotic Alloy + 1 AI core + 200 Optical Fiber + 1 Orbital Insertion Package
Mirror Sat    = 4 Exotic Alloy + 1 AI core + 150 Aluminum + 10 Optical Glass + 1 Orbital Insertion Package
Repair Drone  = 2 Exotic Alloy + 50 Carbon Steel + 1 Foundation Kit
Orbital Insertion Package = 100 Iron ingot + 30 Brick + 20 Glass + 10 Carbon Fiber + 5 AI core
```

(Mirror Sat's 150 Aluminum is bulk reflective surface; 10 Optical Glass is sun-tracking precision optics.)

All values are placeholders to be tuned. Costs are deliberately heavy: a T6 launch must represent real production commitment, so launch failures land with weight.

Each launch additionally consumes **Antimatter Propellant** (T6 fuel) proportional to the launch's intended range, per §11.7. Antimatter Propellant is produced at an Antimatter Refinery (T6 building) on a T6-mastered island; recipe is defined in §7.12.

### 14.11 Interactions with Other Tiers

* **Weather (§2.6):** Scanner Sat coverage extends weather visibility well beyond ground Weather Stations and is immune to weather effects itself. Late-game players use Scanner Sats to plan long-distance vehicle dispatches that would otherwise commit blind.
* **Drones (§11):** Drones remain the cheap-corridor scouting tool. Scanner Sats supplement, do not replace, drone discovery — drones are launched at any tier and carry corridor scans across regions where the player has no satellite presence.
* **T5 Path Drones (§11.6):** Dark mode operates as before. Where Scanner Sat coverage overlaps a path drone's planned route, dark mode is partially mitigated — telemetry is live in covered cells. Far-distant uncovered probes remain blind.
* **Mass Driver (§9.5):** Distinct from the Spaceport. Mass Driver is the Plains-locked T4 long-range cargo launcher. Spaceport is the orbital-launch facility, available on any biome at T6.

### 14.12 Repair Drone Operations

Repair Drones differ from the three persistent orbital sat variants in several important ways:

* **Payload.** A Repair Drone consumes a Repair Pack instead of an Orbital Insertion Package. Placeholder recipe: `1 Repair Pack = 1 Exotic Alloy + 5 Lubricant + 5 Microchip`. Significantly cheaper than an OIP, so repair launches are a routine maintenance operation rather than a heavy commitment.
* **Fuel.** Same Antimatter Propellant as a satellite launch (T6 fuel per §11.7), but in a smaller load — roughly proportional to the rendezvous distance.
* **Travel time.** A flat placeholder of 100 seconds, independent of rendezvous distance. Smaller payload, faster rendezvous; encourages responsive maintenance.
* **Targeting and lockout.** When the player dispatches a Repair Drone, the target satellite enters a "pending repair" state. While in this state, the satellite cannot be moved (§14.6 movement is blocked) — but everything else continues normally: the sat keeps scanning, relays comm packets through the graph, and is still vulnerable to debris hits in its current cell. If the satellite is destroyed by debris before the Repair Drone arrives, the inbound Repair Drone is lost in transit (its target no longer exists; drone, Repair Pack, and propellant all consumed; no debris generated by the lost drone). The lockout ends on drone arrival (success or in-flight mechanical failure) or on drone loss.
* **Failure mode.** A single flat mechanical-failure roll pre-rendezvous (placeholder: 5%). On failure, the Repair Drone, its Repair Pack, and its propellant load are all lost; no debris is generated. Player simply dispatches another. Failure rate can be reduced by Orbital sub-path nodes (§14.9).
* **Effect on success.** Restores all slowdown damage on the target satellite to 0% (clears every lodged-debris penalty). Tops off the target's onboard maneuvering fuel reserve to full. Resets the target's "needs maintenance" state if applicable.

\---

## 15\. Architecture

### 15.1 Data Structures (TypeScript)

```typescript
interface World {
  seed: string;
  tick: number;
  lastSaveTime: number;
  islands: Map<IslandId, Island>;
  routes: Route\[];
  drones: Drone\[];
  vehicles: SettlementVehicle\[];
  discoveredCells: Set<string>;
  networkConsciousnessLevel: number;
  // Weather is computed deterministically from (seed, tick, cell). No persistent state.
}

interface Island {
  id: IslandId;
  position: { x: number; y: number };
  biome: BiomeType;
  modifiers: ModifierId\[];
  size: {
    ellipses: { major: number; minor: number; rotation: number; offsetX: number; offsetY: number }[];
    // Initial: a single ellipse at offset (0, 0) with biome-default radii.
    // Land Reclamation grows ellipses[0]'s radii. Joining (§3.6) appends new ellipses
    // with offsets equal to the absorbed island's position relative to the absorber.
  };
  terrain: TerrainType\[]\[];
  buildings: PlacedBuilding\[];
  inventory: Record<ResourceId, number>;
  storageCaps: Record<ResourceId, number>;
  level: number;
  xp: number;
  unlockedNodes: Set<NodeId>;
  unlockedEdges: Set<EdgeId>;
  socketBindings: Map<string, CrystalId>;  // skill-tree v2: crystal sockets keyed by node/socket id
  unspentSkillPoints: number;
  lastTick: number;
  nextQueueSeq: number;         // monotone counter for build-queue FIFO stamps; incremented on each enqueue
  populated: boolean;  // false if discovered but not yet settled
}

interface PlacedBuilding {
  id: string;
  defId: BuildingDefId;
  x: number; y: number;
  rotation: 0 | 1 | 2 | 3;
  floorLevel?: number;          // 0-indexed upgrade depth (0 = fresh, 9 = max); displayed as floorLevel+1 (1..10)
  constructionRemainingMs?: number;  // ms remaining until construction completes; 0 = fully built
  queued?: boolean;             // true while waiting in the build queue (not yet occupying a running slot)
  queueSeq?: number;            // FIFO stamp assigned at enqueue; lower = promoted first
  state?: any;
}

interface BuildingDef {
  id: BuildingDefId;
  category: BuildingCategory;
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  shape: { dx: number; dy: number }\[];
  recipe?: { in: Record<ResourceId, number>; out: Record<ResourceId, number>; cycleSec: number };
  power?: { produces?: number; consumes?: number };
  heatSource?: boolean;
  requiresHeat?: boolean;
  storage?: Record<ResourceId, number>;
  adjacencyEffects?: AdjacencyEffect\[];
  requiredTile?: TerrainType\[];
  requiredBiomes?: BiomeType\[];
  requiredNodes?: NodeId\[];
  artificialIslandAllowed?: boolean;
  weatherVisibilityBonus?: number;  // Weather Station: +cells of visibility
}

interface AdjacencyEffect {
  kind: 'buff' | 'gating' | 'recipe-unlock' | 'penalty';
  match: BuildingDefId | TerrainType;
  statKey?: string;
  perMatch?: number;
  cap?: number;
  recipeId?: string;
}

interface Route {
  id: string;
  from: IslandId;
  to: IslandId;
  type: 'cargo' | 'drone' | 'airship' | 'mass\_driver' | 'teleporter' | 'cable' | 'spacetime' | 'submarine\_cable';
  capacityPerSec: number;
  filter: ResourceId | null;
  priorityList?: ResourceId[];      // ordered priority list when filter === null ("any") — see §2.4
  transitTimeSec: number;           // 0 for teleporter/spacetime; positive for cargo/drone/airship
  inFlight: { resourceId: ResourceId; amount: number; arrivalTick: number }[];  // batches currently in transit
}

interface Drone {
  id: string;
  from: IslandId;
  fuelLoaded: number;
  scanRadius: number;
  speed: number;
  launchTime: number;
  expectedReturnTime: number;
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  // T1-T4 use direction; T5 uses path waypoints
  direction?: { dx: number; dy: number };
  path?: { x: number; y: number }\[];  // T5 only: waypoints
  // T5 dark-mode buffer: discoveries made out of visibility, transmitted on return
  pendingDiscoveries?: IslandId\[];
  weatherMultiplier: number;  // tier-based vulnerability factor
}

interface SettlementVehicle {
  id: string;
  kind: 'ship' | 'helicopter';
  tier: 1 | 2 | 3 | 4;
  from: IslandId;
  target: IslandId;
  fuelLoaded: number;
  foundationKitCount: number;
  speed: number;
  launchTime: number;
  expectedArrivalTime: number;
  weatherMultiplier: number;
}
```

**Weather is not stored.** Weather state for cell `(cx, cy)` at tick `t` is a pure function `weather(seed, cx, cy, t)`. This means weather is deterministic, never desyncs from save, costs zero storage, and offline simulation can replay it exactly. The forecast model (placeholder: layered noise function with time evolution) is implemented as a stateless function.

### 15.2 Tick Model

Two clocks:

* Render tick (60Hz): visual updates only, no state mutation.
* Game logic tick: there is no fixed background tick rate. State is advanced lazily on demand via `advanceIsland(island, now)`, which fast-forwards an island's state from its stored `lastTick` to `now` using the event-driven piecewise integration in §15.3.

State is read (and therefore advanced) by:

* Player actions that observe or mutate an island (viewing, building, dispatching, etc.)
* Inbound events targeting the island (drone return, route arrival, vehicle arrival, satellite data delivery)
* The periodic save (every 30s of wall-clock and on `visibilitychange`) — save reads each island, which advances it
* Visibility recompute when the player pans the world map

There is no automatic 1Hz / 30Hz / 60Hz background process advancing islands. Truly idle islands accumulate `now - lastTick` of pending advancement; the next read catches them up in one event-driven integration. This makes offline play and active play the same code path.

*Implementation note (2026-06-10):* the client ticker advances populated islands at a fixed 5 Hz cadence (`ECONOMY_TICK_MS = 200` in `economy-clock.ts`) rather than once per render frame — the §15.3 integrator is cadence-agnostic, so this is purely a wiring choice in `main.ts`, and the named constant is the seam a future authoritative server takes over.

### 15.3 Per-Island Advancement (Event-Driven Piecewise Integration)

```typescript
function advanceIsland(island: Island, now: number) {
  let t = island.lastTick;
  while (t < now) {
    const rates = computeRates(island);
    const nextEvent = findNextCapEvent(island, rates, t, now);
    const dt = (nextEvent - t) / 1000;
    applyRates(island, rates, dt);
    accrueXp(island, rates, dt);
    levelUpIfReady(island);
    t = nextEvent;
  }
  island.lastTick = now;
}

function computeRates(island: Island) {
  // Sum power
  let powerProd = 0, powerCon = 0;
  for (const b of island.buildings) {
    const def = catalog\[b.defId];
    if (def.power?.produces) powerProd += def.power.produces;
    if (def.power?.consumes) powerCon += def.power.consumes;
  }
  const powerFactor = powerCon === 0 ? 1 : Math.min(1, powerProd / powerCon);

  // Compute per-resource rates
  const rates: Record<ResourceId, number> = {};
  for (const b of island.buildings) {
    const def = catalog\[b.defId];
    if (!def.recipe) continue;

    if (def.requiresHeat \&\& !hasAdjacentHeatSource(island, b)) continue;
    const recipeOk = adjacencyGatesSatisfied(island, b);
    if (!recipeOk) continue;

    const adjBonus = computeAdjacencyBuff(island, b);
    // All buffs (modifiers, Network Consciousness) stack multiplicatively.
    const buffStack = adjBonus
                    \* computeModifierBuffs(island, def.recipe)
                    \* computeNetworkBuff(world, island);
    // Net-flow throttle (supersedes the old binary outputAvail): a single
    // shared per-building gate `g` ∈ [0,1] replaces `min(inputAvail,
    // outputAvail)`. `g` is solved exactly across the island so producers at
    // a full bin and consumers at an empty bin rescale to the live flows on
    // the other side of the bin (continuous, not binary). See the net-flow
    // throttle note below for the math.
    const g = flowGate(island, b);                                   // continuous [0,1]; 0 = idle (no flow, no XP)
    const rate = (1 / def.recipe.cycleSec) \* powerFactor \* buffStack \* g;
    addToRates(rates, def.recipe, rate);
  }
  return rates;
}
```

`findNextCapEvent` returns the timestamp at which any inventory hits its cap or empties given current rates, or `now` if nothing changes within the interval.

**Net-flow throttle (supersedes the binary `outputAvail`).** `outputAvail` is
no longer a binary stall — a single output bin at cap once froze the whole
building (no inputs, no outputs, no XP, no power draw), which oscillated
stall→drain→wake→refill against any live consumer. It is now a *continuous,
demand-coupled* throttle. For each constrained resource a single shared factor
is solved across the island so realized production exactly matches realized
consumption at a pinned bin: a capped resource `r` yields a shared throttle
`θ[r]` over all of `r`'s producers (target = the consumers' realized draw), and
an empty resource `r` yields a shared factor `φ[r]` over all of `r`'s consumers
(target = the producers' realized supply) — `φ` generalizes the old
`inputAvail`. Each building takes the **min rule**: its gate `g` is the minimum
of 1, every `θ` over its capped outputs, and every `φ` over its emptied inputs,
so the most-constrained stream governs the whole building (a full byproduct bin
still chokes a multi-output building, continuously). The factors are solved
*exactly* via an active-set / piecewise-linear method (a constraint binds only
while it would actually be violated; deactivating constraints relax the other
producers), not by a fixed-point relaxation. The §15.3 piecewise-constant-rate
invariant is **preserved**: factors are constant between events, so rates stay
piecewise-constant. A pinned bin runs at net exactly 0 and therefore **emits no
cap event** — `findNextCapEvent` skips a stock already at its boundary, so a
steady throttled state advances in O(1) segments instead of one boundary event
per segment forever. **Coal-burn cap-side demand (§5.2):** the per-furnace coal
burn (`coalPerCycle × servedCount / 30 s`) is solver-visible on the cap side as
a synthetic consumer entry, so a coal producer at a pinned coal bin throttles to
recipe-draw + burn rather than flickering; this synthetic demand is skipped when
coal is at zero, where §5.2's all-or-none fuel gate owns the regime.
**Generator wattage is never solver-gated:** a power producer whose recipe
output is cap-pinned keeps producing its full W; the gate throttles its resource
side only (§5.1). Implementation: `src/flow-solver.ts` (pure leaf module — no
PixiJS, like `ocean-gen.ts` in §2.1) holds the exact solve; `computeRates` feeds
it in a pass-2.5 and consumes the gate in passes 3–4. Full design and worked
examples: `docs/superpowers/specs/2026-06-10-net-flow-economy-design.md`.

Construction completions are also event boundaries: when `constructionRemainingMs` reaches zero during a segment, the loop iterates there. At that completion point a storage building's capacity multiplier is credited to the island's caps (§4.6, expanded to `multiplier × storage_base(r)` per affected resource) — the base multiplier for a fresh placement (floorLevel 0), the flat per-level multiplier increment for a completed floor upgrade (floorLevel ≥ 1); the same loop runs every segment, so a build completing mid-offline-catchup is credited correctly. Immediately after each segment `promoteQueuedBuilds` promotes the FIFO head of the build queue (lowest `queueSeq`) into any newly freed running slot, so queued builds start ticking within the same advance/offline-catchup call (§4.8).

### 15.4 Inter-Island Flow Resolution

Per global tick, walk all routes:

1. For each route, attempt to move `min(capacity \* elapsed, source\_inventory, dest\_remaining\_cap)` of `route.filter` from source to destination.
2. If multiple routes contend for the same resource at one source, distribute proportionally to capacity.

### 15.5 Offline Math

Identical code path. When player returns, every island runs `advanceIsland(island, Date.now())`. Event-driven integration converges in milliseconds even for multi-day offline periods.

### 15.6 Stack

* **Build tool:** Vite
* **Language:** TypeScript
* **Renderer:** PixiJS 8 (canvas-based, sprite-batched)
* **UI:** Vanilla TypeScript DOM overlay on top of the Pixi canvas (no React/Solid framework)
* **State:** A plain mutable `WorldState` object (no Zustand); islands advance lazily via `advanceIsland`
* **Persistence:** IndexedDB via idb-keyval. World state (key `robot-islands:save:v14`, schema version 17) serialized to JSON, saved every 30s and on `visibilitychange`. UI prefs (camera transform only) live in a separate `robot-islands:prefs:v1` key with a 500 ms-debounced write cadence so pan/zoom feels persistent on a quick refresh without churning the main save blob.
* **No backend:** pure client-side

### 15.7 Build Order

1. Static single-island scene. 16x16 grid, place hardcoded buildings, no economy.
2. Shape masks, rotation, adjacency. Validate placement with 4x4 shapes.
3. Resources and tick loop. Single resource, then chains. `advanceIsland` working with offline-gain testing (mock-advance the clock).
4. Power and brownouts. Add power buildings, smooth-degradation factor.
5. Skill tree. UI, XP gain, node effects.
6. World map and stratified placement. Multiple islands, drone dispatch, discovery.
7. Inter-island routes. Funneling.
8. Biomes and modifiers.
9. Tier breakpoints, T2 and T3 content unlock.
10. Network Consciousness milestones.
11. Artificial island construction.
12. T4 endgame content.
13. T5 transcendent content.
14. Polish, balance, content expansion.

Steps 1 to 5 yield a playable single-island sandbox. That is the first milestone for validating the core loop.

\---

## Appendix B: Deferred Features

Out of scope for first release; designed but not implemented:

* Prestige (discover-and-relocate or other; revisit once core loop is mature)
* Mechanical/Steam as a third power form
* Blueprints (layout save/copy convenience)
* Multi-device sync (would require backend)
* Localization

