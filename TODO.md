# TODO

Consolidated punch list from the 4-agent sweep (200% file coverage,
~244 raw findings, deduped + verified against source + SPEC.md).

> **Meta** — `SPEC.md` "Implementation Status" table is out of sync with
> code in three load-bearing places. Future agents who trust the table
> will mis-plan:
> - §2.4 marked **P** listing route types `cargo / drone / airship /
>   teleporter / cable` — `mass_driver` missing from `RouteType` despite
>   §9.5 Mass Driver building and §15.1 `Route.type = 'mass_driver'`. (§1.)

---

## 1. Spec divergence — real bugs a player would notice

- **§7.12 `reality_forge` recipe diverges from spec by ~50% of inputs
  and 1/18 of cycle time.** `src/recipes.ts:1337-1342` ships `2
  exotic_alloy + 1 ai_core + 1 casimir_energy` / 4800s; spec literal is
  `4 ai_core + 1 antimatter_capsule + 1 time_crystal + 1 exotic_alloy` /
  24h. The 1260-line comment cites "missing T4 raws" but both
  `antimatter_capsule` and `time_crystal` now exist in the catalog (recipes
  at `:745-747`). Either bring recipe in line with spec or update SPEC.md
  to acknowledge the simplification.
  *(Flagged by Agents B, C — same finding.)*

- **§7.12 `antimatter_refinery` recipe wrong inputs + 4× spec cycle.**
  `src/recipes.ts:1996-2001` uses `1 exotic_alloy + 1 reality_anchor + 2
  casimir_energy` / 7200s. Spec §7.12 says `1 antimatter_capsule + 1
  plasma_containment_vessel + 5 cryogenic_hydrogen` / 30 min. Both spec
  inputs exist in catalog. Off-spec on inputs, scale, and conceptual chain
  (ties T6 fuel back to T4 antimatter chain per spec; current ties to T5
  reality_anchor).
  *(Flagged by Agent C.)*

- **§14.10 `comm_sat_assembly` `optical_fiber` reduced 200 → 50 with no
  spec authority.** `src/recipes.ts:2015` — the in-line comment
  literally says `"Agent C: extreme ratio, suspected copy-paste from
  spec"`, but spec §14.10 is the spec. Either restore 200 or document
  the deviation in SPEC.md.
  *(Flagged by Agents B, C.)*

- **§13.3 Omniscient Lattice activates without route-connectivity check.**
  `src/lattice.ts:35-49` counts every T5-mastered island with a Lattice
  Node toward the activation threshold (N=20) regardless of whether
  those islands are networked. §13.3 ties N to "Network Consciousness
  threshold (§9.6)" and §9.6 explicitly defines "networked" as
  route-graph-reachable from home. Fix: filter `nodeIslands` against
  `networkedIslandIds(world)` before length-check.
  *(Flagged by Agent A.)*

- **§2.4 `any` route seeds priority with EVERY resource (opposite of
  spec).** `src/routes-ui.ts:518` `priorityList: isAny ? [...ALL_RESOURCES]
  : []`. Spec §2.4: "Resources not on the priority list are not moved
  by this route." A fresh `any` route therefore moves every resource in
  alphabetic order until the player edits — the inverse of the spec
  contract ("configurable bulk movers"). Should default to `[]` and let
  the player add entries.
  *(Flagged by Agent B.)*

- **§15.1 / §9.5 `RouteType` is missing `'mass_driver'`.** `src/routes.ts:33-39`
  enumerates `cargo | drone | airship | teleporter | cable | spacetime`.
  Spec §15.1 says `Route.type = 'mass_driver'` for the §9.5 Plains
  biome-unique Mass Driver building (which IS in BUILDING_DEFS). The
  building exists with nothing to dispatch.
  *(Flagged by Agent A.)*

- **§2.7 `solarMultiplier` is piecewise-constant, not linear ramp.**
  `src/daynight.ts:60-71` returns dawn=0.5, day=1.0, dusk=0.5,
  night=0.0. Spec §2.7: "Dawn: 50% output (linear ramp 0 → 100)";
  "Dusk: 50% output (linear ramp 100 → 0)". The module head justifies
  the simplification as a time-average — fine for offline integrals,
  wrong for any UI readout or weather-phase-boundary code that samples
  instantaneously. Worth either implementing the ramp or documenting
  the deviation in SPEC.md.
  *(Flagged by Agents A, B.)*

- **§5.3 cable inflow doesn't deduct source W.** `src/routes.ts:147-164`
  `cableInflowForIsland` adds capacity to the destination without
  removing it from the source. Comment acknowledges. Spec §5.3 says
  cables "transmit electrical power between islands" — power should
  conserve, not multiply. Probably intentional placeholder; flag as a
  real economy bug rather than a polish item.
  *(Flagged by Agent D.)*

---

## 2. Missing mechanics (spec calls for it, code doesn't ship it)

- **§4.6 generic-storage label picker at placement time.**
  `src/placement.ts:47-53` `DEFAULT_CARGO_LABEL = 'iron_ore'` is a
  hardcoded stand-in; spec §4.6 says the player labels at placement.
  Relabel-after-placement is the workaround. Every Crate / Warehouse
  starts holding iron_ore regardless of player intent. *(A, B, C.)*

- **§2.6 Weather Station visibility extension not wired through the
  weather overlay.** `src/weather-overlay.ts:17-20` self-documents the
  gap — "The §2.6 Weather Station bonus is not yet wired through this
  path". Spec §2.6 promises Weather Station (T2) `+3 cells` and
  Advanced Weather Station (T3) `+6 cells, +1-cycle forecast`. *(D.)*

- **§3.4 Coast island rotation never randomized.** `src/world.ts:177`
  carries `rotation` as forward-compat but always sets it to 0. Spec
  §3.4: "Coast islands generate with a biome-randomized rotation
  (multiples of 22.5 degrees from world seed)." SPEC.md status §3.1-3.4
  marks shape as L. *(B.)*

- **§14.10 Repair Drone recipe / Repair Pack ambiguity.** §14.10
  literal: `Repair Drone = 2 Exotic Alloy + 50 Carbon Steel + 1
  Foundation Kit`. §14.12 says Repair Drone consumes a `Repair Pack`
  instead of OIP. `src/orbital.ts:525` correctly checks `repair_pack`.
  Either §14.10 should be updated (Foundation Kit → Repair Pack) or the
  code reconciled. Spec drift, not code drift. *(D.)*

- **§14.5 satellite coverage skips perimeter cells.**
  `src/orbital.ts:791-806` `cellsCoveredBySat` admits only cells whose
  CENTRE is within `coverageRadius`. Cells whose centre is outside but
  whose area overlaps are skipped — under-counts perimeter coverage,
  visible at tight radii. *(D.)*

---

## 3. Stale STILL-DEFERRED / out-of-date comments

A flat list. One sweep-and-clean commit. All verified against the
current implementation (each comment claims something is deferred that
the code now ships).

- `src/building-defs.ts:16-33` — header says §13.3 (time banking, free
  creation, biome reassignment, network unity, Probability Engine) is
  STILL-DEFERRED. All live (`spendTimeLock`, `genesis_chamber`,
  `editIslandBiome`, `latticeActive`, `probability_engine` in
  drone scan bias).
- `src/building-defs.ts:42` — T4 omnidirectional pulse "STILL-DEFERRED
  — only the def is added in step 12." `firePulse` is wired.
- `src/building-defs.ts:176-183, 2038-2040` — "§14.2-14.8 / §14.12 …
  Spaceport upgrade, satellite launches, debris fields, comm graph,
  Repair Drone operations … all STILL-DEFERRED." All live in
  `orbital.ts`.
- `src/building-defs.ts:1610` — Cryogenic Compute Center "Arctic
  ambient cold halves compute-recipe power draw — STILL-DEFERRED;
  modelled at static 1200W."
- `src/building-defs.ts:1711-1712` — Launch Tower T4 pulse "STILL-DEFERRED".
- `src/building-defs.ts:1905-1909` — Genesis Chamber free-creation
  "STILL-DEFERRED to step 14"; mechanic lives in
  `src/economy.ts:542-598, 792-804`.
- `src/buildings.ts:71` — Eternal Servitor "Conversion Kit recipe and
  Reality-Forge conversion mechanic that flips this flag are
  STILL-DEFERRED"; `convertToServitor` is the next function in the
  same file and is wired through `inspector-ui.ts:1372`.
- `src/economy.ts:155` — "§9.7 Tier Reset path that clears [the
  specializationRole] back to null is STILL-DEFERRED"; `tier-reset.ts`
  ships.
- `src/maintenance.ts:32-34` — "T6 is forward-compat — Spaceport (§14)
  exists as a def but live mechanics are STILL-DEFERRED."
- `src/orbital.ts:164-167` — `launchSatellite` docblock "full debris
  mechanics are STILL-DEFERRED to a later step"; `addDebrisFragments`
  fires on the orbit-explosion path; full debris tick lives in the
  same file.
- `src/placement.ts:14-18` — "broader §4.5 catalog of buff/gating
  adjacencies (Cooling Tower → Crystal Lab unlocks, Wastewater
  Treatment → Refinery efficiency) is STILL-DEFERRED". Wastewater
  Treatment + Exhaust Scrubber soft-gates are live per impl-status §4.5;
  only Cooling Tower → Crystal Lab remains. Comment overstates.
- `src/recipes.ts:1158` — Cryogenic Compute Center "STILL-DEFERRED —
  modelled at static 1200W." (See also building-defs.ts:1610.)
- `src/recipes.ts:1260-1264` — Reality Forge "missing T4 raws"; both
  `antimatter_capsule` and `time_crystal` ship.
- `src/recipes.ts:1807` — `metal_rolling_mill` "sheet_metal, pipe,
  beam STILL-DEFERRED until they have an explicit consumer";
  `sheet_metal_mill` / `pipe_mill` / `beam_mill` ARE defined.
- `src/recipes.ts:1817-1818` — Lithography Lab wafer intermediate
  "STILL-DEFERRED"; `wafer_lab` + `silicon_wafer` ship (unused by
  Lithography Lab though — see §1 below if you want to wire the chain).
- `src/recipes.ts:1961-1966` — T6 orbital recipes "data-only ship.
  §14.2-14.8 / §14.12 launch + debris + lodge + repair mechanics are
  STILL-DEFERRED — payloads/fuel inert until the live launch system
  lands." Launch system is live.
- `src/network-consciousness.ts:14-16` — milestone-4 buff comment says
  "Omniscient Lattice unlock arrives with the T5 endgame artifact, not
  implemented yet"; Lattice is live.
- `src/specialization.ts:12` — "§9.7 Tier Reset is STILL-DEFERRED";
  tier-reset.ts ships.
- `src/main.ts:670` — "multi-island HUD is a STILL-DEFERRED step-14
  polish concern"; `hud.ts` paints multi-island.
- `src/world.ts:177` — `rotation` "not yet wired — always 0 for now"
  (see §2 above — partly genuine missing mechanic for Coast islands).

---

## 4. Tuning placeholders (Appendix A backlog)

Numeric values shipped as designer-eye placeholders, all carrying
explicit "tune in Appendix A" markers. Not bugs; balance pass owes
them explicit values + rationale.

- **`src/building-defs.ts` ~80 `placementCost` entries** marked
  `// §14 placeholder — tune in Appendix A.` One per def, copy-paste
  pattern by tier (e.g. every T2 chemistry plant at `steel:50, gear:10`).
- **Antenna + Lighthouse signal radii.** `src/antenna.ts:21-28`
  (80→700 across 6 tiers), `src/lighthouse.ts:36-43` (50→300). Whole
  Antenna / Lighthouse system is a §11 design addition; not in spec §8
  catalog.
- **Construction times per tier.** `src/construction.ts:22-29`
  `BASE_CONSTRUCTION_MS_BY_TIER = 30s / 2m / 5m / 15m / 30m / 60m`.
- **`src/land-reclamation.ts:56-59`** stone-only `5 × r²` cost; spec
  §3.4 says "scales superlinearly … material cost" without basket. T2-T3
  components should plausibly appear in late-game expansions.
- **`src/tier-reset.ts:68-71`** `{ steel: level², gear: floor(level²/2) }`
  — both T2 components. Spec §9.7 calls for "T2-T3 components".
- **`src/universe-editor.ts:34-38`** `UNIVERSE_EDITOR_COST = {
  reality_anchor: 5, memetic_core: 2, phase_converter: 1 }`.
- **`src/orbital.ts` constants block** (lines 28, 111-130, 533) — debris
  hit constant, fragment counts, sat fuel/move/cleanup rates, repair-drone
  travel time, tracking detection radius, all "placeholder Appendix A".
- **`src/orbital.ts:200-202`** Spaceport tier I/II/III base success
  rates `0.30 / 0.50 / 0.70` hardcoded inline (spec says T1≈0.30, T3≈0.70;
  T2 is invented interpolation).
- **`src/orbital.ts:273-274`** ground-station comm range per tier
  `200 / 300 / 400` — three magic numbers no Appendix-A tag.
- **`src/artificial-island.ts:55-60`** `STEEL_PER_TILE=5,
  IRON_INGOT_PER_TILE=3, WOOD_PER_TILE=10`, hard-biome 1.5× surcharge.
- **`src/world-gen.ts:165-172`** biome weight table `{plains:25,
  forest:20, coast:15, volcanic:10, desert:15, arctic:15}` — spec has no
  biome-frequency target.
- **`src/economy.ts:1122-1129`** `xpForLevel` coefficient was rebalanced
  from 100 to 25 (step #19); SPEC.md §9.1 still says `100 * n^2.2`.
- **`src/skilltree.ts:287-289 + :298-300`** `costForDepth = round(1.5^(d-1))`
  + `skillPointsForLevelUp = floor(1.1^L)` together make the tree ~100×
  cheaper than spec's `2^(d-1)` cost + flat-1/level grant. Documented
  deliberate deviation — but SPEC.md still cites the spec literals as
  Appendix A placeholders. Reconcile (update SPEC.md or document
  deviation explicitly).
- **`src/recipes.ts` step #19 ×10/×20/×40/×60 cycle multipliers**
  through most recipes; SPEC.md cycle-time placeholders untouched.
- **`src/weather.ts:42`** `catastrophic: 0` (100% capacity kill); spec
  §2.6 silent on catastrophic. Code extrapolated; may be too harsh.
- **`src/routes.ts:96`** `TELEPORTER_FUEL_PER_TILE = 0.005` — entire
  teleporter-fuel mechanic is an in-game design addition (not in spec).

---

## 5. Dead code / dead exports

- **`src/hud.ts:327-335`** `renderMultiIslandBar` — no-op stub
  documented "deprecated, kept as no-op stub", zero non-test consumers.
- **`src/world.ts:62-68`** `DISCOVERY_RADIUS_TILES = 24` exported as
  DEPRECATED with no in-tree consumer; kept "for external debug
  tools". Pure dead export.
- **`src/main.ts:700-737`** `forest-ne` demo-seed block (bumps level
  50, sets `aiCoreCrafted = true`, seeds T4/T5 inventory). Comment at
  `:679-685` notes the block is now a no-op in production because
  forest-ne is no longer auto-populated per §3.7. Either re-purpose
  for a dev/test fixture path or excise.

---

## 6. Brittle patterns / type-discipline notes

- **Two-place constants that must stay in sync.**
  - `FUNNELING_BONUS_PERCENT` in `src/routes.ts:103` and
    `FUNNELING_BONUS_PERCENT_FOR_DRAIN` in `src/economy.ts:1113`.
    Documented in both comments; drift caught by economy test.
  - `BASELINE_STORAGE_CAP = 2000` in `src/world.ts:953` AND
    `src/persistence.ts:568` (same constant, copied "to keep in sync").
  - `CELL_SIZE_TILES = 16` declared in `src/world.ts`, re-exported from
    `src/discovery.ts:19`, AND inlined as a literal in
    `src/vision-source.ts:69` and `src/satellite-overlay.ts:51-52`
    (`d.cellX * 16 * TILE_PX`). Three sources of truth.
  - `LATTICE_ACTIVATION_THRESHOLD = 20` in `src/lattice.ts:12` is
    independent of `NC_THRESHOLDS` in `network-consciousness.ts` despite
    spec saying "N = 20 = Network Consciousness threshold".
  - `src/orbital-ui.ts:170-173` duplicates the Spaceport upgrade cost
    table from `src/orbital.ts:877-879`. UI shows numbers, backend
    charges them — drift = mis-display.
  - `src/specialization.ts` `ROLE_DEFS` (UI strings) and
    `effectiveSpecializationMultipliers` (switch over magic numbers)
    are parallel data. Tests cover both surfaces.
  - `src/skilltree-ui.ts:317-323` `ROLE_CONFIRM_SUMMARY` is a third
    copy of role-effect text alongside `ROLE_DEFS.description`.

- **Hardcoded def-id lists where tag-driven lookup would be cleaner.**
  `src/economy.ts:854-862` walks a long literal list (`mine | deep_mine
  | copper_mine | tin_mine | …`) for the Mining `buildingBonus`. Every
  new mining building has to be added here or silently loses the bonus.

- **`as unknown as { … }` casts to mutate `readonly` fields.** Pervasive
  pattern: `src/world.ts:349` (modifiers reassign), `src/routes-ui.ts:694`
  (priorityList mutate), `src/inspector-ui.ts:751, 109`
  (Mutable<PlacedBuilding>), `src/reactor-toxicity.ts:84`
  (toxicityExpiryMs), `src/buildings.ts:137` (eternalServitor flip),
  `src/orbital.ts:221` (spaceport tier revert). Each is pragmatic at
  its site; collectively they undercut the `readonly` contract on
  PlacedBuilding / Route / IslandSpec.

- **`src/persistence.ts:346-348 / SCHEMA_VERSION = 4`** drops any
  v1/v2/v3 save to an unknown-schema error. Comments accept the
  trade-off but it's a real player-cost for long-time saves; no
  migration path exists.

- **`src/world.ts:938-946`** `startingInventory()` explicitly violates
  §3.7 ("Empty inventory: no starter resources, no Foundation Kit") by
  seeding 60 stone + 40 wood + 1 foundation_kit. The 22-line
  justification comment notes that §3.7 + §14 placement costs together
  make the game unplayable; the divergence is real and unilateral. Update
  SPEC.md §3.7 or carry the gap as a known exception in impl-status.

- **`src/recipes.ts:1060-1072`** `steel_mill_from_scrap` (600s, synthetic,
  fires inside a regular Steel Mill via scrap-substitution) and
  `steel_mill_scrap` (200s, real T2 building def) coexist with the SAME
  inputs but 3× different cycle times. Player-visible "Steel Mill Scrap"
  is the 3× faster one; designer-discovery gotcha.

- **`src/recipe-graph.ts:24-29`** `ownerOf` only knows about
  `mine_on_ore` / `mine_on_coal`. Steel Mill's `steel_mill_from_scrap`
  variant will surface in the recipe-graph modal as the literal
  synthetic id ("steel_mill_from_scrap") instead of "Steel Mill".

- **`src/biomes.ts:524-525`** `rerollModifiers` mixes `Date.now()` into
  the seed. Player-action one-shot (Universe Editor) so not a
  save-replay break, but the sibling `rollModifiersArtificial` takes
  `nowMs` as a parameter — pass it here for symmetry.

- **`src/storage-categories.ts`** ~150 resources × 1 hand-mapped
  category. No test enforces correct category choice; new resources
  silently land somewhere reasonable-looking and stick.

- **`src/inventory-ui.ts:41-200+`** parallel resource-category map.
  Overlaps `RESOURCE_STORAGE_CATEGORY` from `storage-categories.ts`
  with different category labels; two-place classification.

---

## 7. Dropped — verified STALE or FALSE

- (Audit A MED) **`src/network-consciousness.ts:47-52` milestone 3 and
  4 both = 1.25.** Re-read §9.6: milestone 4 (20 islands) "unlocks
  Network Consciousness, prerequisite for Omniscient Lattice" — the
  unlock IS the reward, not a numeric buff. Spec is silent on extra %.
  The dup is consistent; A flagged for tuning attention, not as a bug.
- (Audit A LOW) **`src/heat.ts:163` `localeCompare` on string ids vs
  spec "lowest source building ID".** Strings, lexicographic order;
  matches spec intent in practice. No-op finding.
- (Audit C LOW) **`src/orbital.ts:535` repair drone id `repair_${nowMs}`
  collision risk.** Same-ms collision is theoretical at human click
  cadence. Same boat as `sat_${nowMs}`. Note for future; not bug-list.
- (Audit B LOW) **`src/satellite-overlay.ts` only renders scanner /
  comm / sweeper.** True, but consequence of the `SatelliteVariant`
  union — already captured under §1 Relay finding.
- (Audit C MED) **`src/discovery.ts:120-142` `pointToSegmentDistSq2`
  inline copy of `drones.ts` version.** Documented as cycle-avoidance.
  Both are pure math — duplication risk only if someone changes one
  formula. Worth a watch but not actionable now.
- (Audit B MED) **`src/economy.ts:484-490` 4-pass composition order
  asserted by comments only.** Reordering is unlikely; tests cover the
  end-to-end. Code-discipline note only.
- (Audit D MED) **`src/main.ts:1699-1706` `window.__cam / __reg / etc.`
  debug handles ship in production.** True but harmless; gating under
  `import.meta.env.DEV` is a polish item, not a TODO entry-worthy bug.
- (Audit B LOW) **`src/persistence.ts` IDB `console.warn`-and-continue
  paths.** Documented design; toast-on-save-fail is a UX wishlist, not
  a defect.
- (Audit C MED) **`src/island-merge.ts:130-162` absorbed-building
  collision risk.** Spec §3.6 promises non-collision by geometric
  construction; current code trusts it. Defensive guard would be polish.
- (Audit D LOW) **`src/orbital.ts:215` `padShare = 0.30 /
  skill.padExplosionReduce`.** Matches spec §14.7 "30/70 split,
  divisible by Launch-skill mitigation".

---

Maintainer note: when a TODO entry ships, delete its line rather than
striking it through. The list should always represent open work.
