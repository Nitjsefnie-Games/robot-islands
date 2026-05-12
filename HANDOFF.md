# Handoff — Robot Islands

> Session `bfb35be4-452d-4c27-89b6-bf4963313012` (2026-05-11 10:42 → 18:18 UTC)
> Do NOT commit this file — runtime handoff artifact only.

---

## 1. Repo state

| | |
|---|---|
| Branch | `master` |
| HEAD | `b77936c` feat: settlement vehicle mechanical-failure rolls §12.5 |
| Last feature | `b77936c` §12.5 Vehicle mechanical-failure rolls |
| Tests | **731 / 731** passing (34 test files) |
| Build | `npm run build` clean (tsc strict + vite production) |
| Stack | Vite 5 + TypeScript strict + PixiJS 8 + vitest, pure-client per SPEC §15.6 |

---

## 2. What shipped (16 tasks, 12 feature commits)

| # | Commit | Subject | Tests delta |
|---|--------|---------|-------------|
| 1 | `1163701` | §11.7 Tier-matched fuel grades | +16 (522 total) |
| 2 | `5f60f1a` | §2.7 Day-night cycle modulating solar | +21 (543 total) |
| 3 | `8d07dfb` | §4.5 Buff adjacency capped stacking | +15 (558 total) |
| 4 | `c28bf33` | §9.7 Tier Reset with cooldown | +34 (592 total) |
| 5 | `8487316` | §3.4 Land Reclamation Hub | +17 (604 total) |
| 6 | `7da1442` | §3.6 Island joining via ellipse overlap | +31 (642 total) |
| 7 | `769cccc` | Vision per-island ellipse +50 padding | +3 (645→rebased to 587) |
| 8 | `10777b7` | `art-N` counter persistence seeding fix | +2 (606→rebased) |
| 9 | `6cc6fa1` | Island renaming (display name vs id) | +9 (615 total) |
| 10 | `78d0e75` | Lighthouse buildings → vision via buildings | +15 (657 total) |
| 11 | `0591362` | Antenna telemetry + per-cell ocean discovery | +40 (697 total) |
| 12 | `45291e5` | Cleanup: extract vision-source, dedupe islandCells, drop dead helper | +7 (704 total) |
| 13 | `729d84a` | Default to procedural new-game (drop demo seed) | +9 (713 total) |
| 14 | `c37ba6a` | Fix: fog overlay must only mask island interior cells | +2 (715 total) |
| 15 | `61d1d8e` | §14 Placement costs + 50% demolish refund | +6 (721 total) |
| — | `d1bca7b` | gitignore `.claude/scheduled_tasks.lock` | — |
| 16 | `1f559b8` | §8.8 Drone Pad T1→T2 | +0 (trivial data bump) |
| 17 | `d19faa9` | Cold Storage consumers audit | +0 (comment/test only) |
| 18 | `c20821d` | §10.1 Funnel per-unit provenance | +3 (731 total) |
| 19 | `18a5555` | §8.1 Tile-gating for all extractors | +5 (736→rebased to 731) |
| 20 | `b77936c` | §12.5 Vehicle mechanical-failure rolls | +2 (731 total) |

**All commits reviewed** via subagent-driven-development: implementer → spec reviewer → code quality reviewer. Zero commits landed without both reviews passing.

---

## 3. Architecture state

### Coordinate systems (unchanged)
- Tile coords = unit. Buildings, geometry, island centres (`cx/cy`) all in tiles.
- World pixels = `tile * TILE_PX` (`TILE_PX = 24`).
- Screen pixels = `world_px * cam.zoom + (cam.tx, cam.ty)`.

### Vision / discovery model (NEW — tasks 10–11)
- **Vision** (what you can *see* right now): union of
  1. Baseline ellipse per populated island: `(majorRadius + 10, minorRadius + 10)`
  2. Per-Lighthouse circles: `LIGHTHOUSE_VISION_RADII` T1=50 … T6=300
  - Rendered as cyan halos in `ocean.ts`
  - `islandRenderState(spec, visionSources)` returns `'visible'` if inside any source
- **Discovery** (what you *know* exists): `WorldState.revealedCells: Set<"cellX,cellY">` (16-tile stratification cells)
  - Drone corridor reveals cells tick-by-tick **only when drone is inside antenna signal range**
  - Out-of-range = data lost (no onboard buffer)
  - Islands flip `discovered` on any-cell rule each tick
  - Rendered as steel-blue squares; fog overlay masks unrevealed cells inside island footprints
- **Antenna signal**: `ANTENNA_SIGNAL_RADII` T1=80 … T6=700 tiles; T1 is zero-power (basic beacon)
- `src/lighthouse.ts`, `src/antenna.ts`, `src/discovery.ts`, `src/vision-source.ts` are all pure (no PixiJS/DOM).

### Island geometry (NEW — task 6)
- `IslandSpec.extraEllipses?: Array<{major, minor, rotation, offsetX, offsetY}>`
- `computeIslandTiles` unions all constituents; deduplicates shared tiles
- `pointInIsland`, `findPopulatedIslandAt`, `pointInVisionEllipse` all walk constituents
- `islandTileCount` deduplicates
- Merge rules: larger absorbs smaller (tile count → level → lower id); one pair per tick; inventory transfers with cap-clamp overflow loss; skill points refunded as unspent; routes/drones/vehicles redirected

### Economy (NEW — tasks 1–3)
- `fuelForTier(t)` in `recipes.ts`: T1=biofuel, T2=diesel, T3=aviation_kerosene, T4=cryogenic_hydrogen, T5=plasma_charge, T6=antimatter_propellant
- `Drone.fuelResource` / `SettlementVehicle.fuelResource` captured at dispatch time; no fallback to lower grade
- Day-night: `dayPhase(nowMs)` → quadrant → `solarMultiplier(t)`; `BuildingDef.power.solar?: boolean`; only Solar Panel tagged solar currently
- Buff adjacency: `AdjacencyBuff` on `BuildingDef` with match kinds `same_def | same_category | def_id`; 4-neighbor walk; dedup by building id; cap at `maxMatches`; multiplicative across entries
- `computeRates` threads `nowMs` for solar and `defs` for buff lookup

### Placement (NEW — task 15)
- `BuildingDef.placementCost?: Partial<Record<ResourceId, number>>`
- All 88 defs carry a cost (tier-scaled baskets: T1=stone+wood, T2=+iron_ingot, T3=+steel+microchip, etc.)
- `placeBuilding` discriminated union: `{ok:true, placed} | {ok:false, reason:'insufficient-resources', missing}`
- Cost re-checked at commit time (race-safe vs validate→commit gap)
- `demolishBuilding` refunds 50% floor per resource + existing scrap credit
- `placement-ui.ts` shows cost row, red on shortfall; inspector shows combined scrap+refund

### Starting state (NEW — task 13)
- `makeInitialWorld` seeds single empty home island via `generateWorld(...)`
- `startingInventory()` returns `{stone:60, wood:40, foundation_kit:1}`
- `DEMO_ISLANDS` renamed to `DEMO_ISLANDS_TEST_FIXTURE` (test-only)
- Home starts with `antenna_t1` at `(5,-1)` so drone demo keeps working

---

## 4. Pending tasks (30 open, #26–#56)

Created at 17:46 UTC after user demanded full enumeration of deferred mechanics. Task tracker is `TaskUpdate` tool, not `SetTodoList`. Dependencies wired for 9 tasks.

### 4.1 Dependency chains

| Task | Subject | Blocked by | Why |
|------|---------|------------|-----|
| 36 | §2.6 Weather system (core) | — | Root of weather chain |
| 37 | §2.6 Weather × routes | #36 | Needs weather states to exist |
| 38 | §2.6 Weather × drone destruction | #36 | Needs weather states to exist |
| 27 | §3.5 Modifier effects integration | #36 | High Wind needs weather variance |
| 49 | T6 recipe placeholder intermediates | — | Root of satellite chain |
| 46 | §14 Orbital — satellites + dispatch | #49 | Needs T6 intermediates |
| 47 | §14 Spaceport upgrade lifecycle | #46 | Needs satellites to exist |
| 48 | §14.4 Comm network extension | #46 | Needs satellites to exist |
| 50 | §14.12 T6 Repair Drone operations | #46 | Needs satellites to exist |
| 26 | §4.5 Gating adjacency mechanics | — | Root of gating chain |
| 32 | Adjacency effects in inspector | #26 | Needs gating adjacency to display |
| 18 | §9.6 NC route-graph reachability | — | Root of NC chain |
| 51 | §12.7 Settlement vehicle / NC interaction | #18 | Needs NC reachability |

### 4.2 Unblocked — small / pure-layer (good resume targets)

~~**#17 — §10.1 Funnel per-unit provenance**~~ ✅ DONE
- Location: `src/economy.ts:730` had `FIXME(§10.1)` — fixed in `c20821d`
- Fix: net-consumption drain (local production shields local use)
- Size: small; touches `economy.ts` + tests

~~**#19 — Drone Pad T1→T2 per spec**~~ ✅ DONE
- Location: `src/building-defs.ts` — fixed in `1f559b8`
- Fix: bumped `tier` to 2
- Size: trivial

~~**#20 — §13 ai_core / ascendant_core auto-flip**~~ ✅ DONE
- Hooked into `advanceIsland` after `computeRates`; flips `state.aiCoreCrafted` / `ascendantCoreCrafted` on first local production
- Committed in `b5535c0`
- Size: small

~~**#21 — §8.1 Tile-gating for extractors**~~ ✅ DONE
- Added `oil_well`, `gas_seep`, `helium_vent` terrain kinds; wired `requiredTile` into all 9 extractor defs; runtime stall in `computeRates`
- Fixed in `18a5555`
- Size: medium; touches `placement.ts` validator + `economy.ts` rate computation + building defs + biomes

~~**#22 — §6.7 Scrap demolition recovery**~~ ✅ DONE
- Changed scrap from `footprintTiles(...).length * 3` to `floor(sum(placementCost) * 0.3)`
- Updated `previewScrapForBuilding` in `inspector-ui.ts` to match
- Committed in `e6d2b1f`
- Size: small; touches `placement.ts` + `inspector-ui.ts` + tests

~~**#23 — §12.4 Foundation Kit decomposition**~~ ✅ DONE
- On settlement arrival, credits `kit_assembler` recipe inputs × `foundationKitCount` to new colony
- Starter inventory grace cap remains deferred
- Committed in `8e3faed`
- Size: small; touches `settlement.ts` + tests

~~**#24 — Shipyard coastal-tile gating**~~ ✅ DONE
- Added `coastal: true` to `shipyard` def (at least one water tile, not all tiles)
- Wired in `validatePlacement` and `computeRates`; added placement tests
- Committed in `c7ad6f3`
- Size: trivial → expanded to small due to new `coastal` mechanism

~~**#25 — Cold Storage resource consumers**~~ ✅ DONE
- `cryo_coolant` already tagged; audited + hardened tests in `d19faa9`
- Size: trivial

### 4.3 Unblocked — medium

~~**#28 — §12.5 Vehicle mechanical-failure rolls**~~ ✅ DONE
- Deterministic failure rolls (2% T1 ship, 1% T2 helicopter) via `makeSeededRng`; persistence backfill; `TickVehiclesResult.failures`
- Fixed in `b77936c`
- Size: medium; touches `settlement.ts` + `settlement-ui.ts` + tests

**#29 — §11.6 T5 path-drawn drones**
- Player-defined waypoint sequence (not straight outbound)
- Data shape exists (`PathDroneFoundry` building); mechanic doesn't
- Multi-segment scan capsule along waypoint polyline
- Note: may conflict with antenna "no onboard buffer" model — design decision needed
- Size: large

~~**#30 — §9.4 Specialization route-capacity doubling**~~ ✅ DONE
- Added `routeCapacityMultiplier` in `specialization.ts`; applied in `routes.ts` `dispatchPhase`
- Routes from `logistics_hub` islands dispatch at 2× base capacity
- Committed in `bcaefb8`
- Size: medium

**#31 — Route priority drag-to-reorder UI**
- `filter:null + priorityList` ordered list has no UI for reordering
- Pure data structure already supports per-route `priorityList`
- Size: medium; render-layer only (`routes-ui.ts`)

**#33 — T3 microchip chain intermediates**
- Spec implies: microchip → circuit_board → processor → computing_module
- Currently microchip is terminal T3 component
- Add three intermediates with recipes; wire as inputs to later T4-T5 buildings per §7.7
- Size: medium; touches `recipes.ts` + `building-defs.ts` + tests

**#34 — Byproducts: oxygen / argon / scrap**
- Electrolyzer (oxygen), Air Separator (argon), some refining (slag/dross) have spec'd byproducts that are currently dropped
- Add to recipe outputs; add downstream consumers (steel uses oxygen, lab uses argon)
- Size: medium

**#35 — §4.1 Custom footprint shapes**
- Building footprints are rectangles (width × height)
- Spec allows L-tromino and tetromino shapes (square, line, T, L, S, Z)
- `BuildingDef.shape` array of `{dx, dy}` per §15.1 exists but isn't wired
- Add shape parsing to placement + collision detection + rotation handling
- Size: large

### 4.4 Unblocked — large / subsystem

**#39 — §13.3 Time Lock — banking + acceleration**
- T5 building; per-Lock 24-hour banked-time stockpile
- Accrual while offline; spend while online to 3× target island's tick rate
- Multi-system speed boost (production, XP, recipe cycles, drone construction)
- UI to select target island
- Size: large

**#40 — §13.3 Genesis Chamber — free-creation**
- T5 building; player picks target resource from T1-T4 catalog
- Continuous power consumption (T1 ~50kW → T4 ~50MW superlinear)
- Outputs chosen resource at slow rate (~5min/unit)
- T5+ resources cannot be materialized
- Size: large

**#41 — §13.3 Probability Engine — drone bias**
- T5 building; +25% chance to encounter rare/unique islands per scan
- Diminishing returns: 2 engines +40%, 3 +50%, 4+ ~+60%
- Affects only drones launched from this island
- Heavy power draw
- Currently substituted with Time Lock in catalog — flip entry back
- Size: medium

**#42 — §13.3 Reality Forge — biome reassignment**
- T5 building; reassigns island's biome to player-chosen one
- Regenerates terrain; modifiers voided
- One-shot per use; cooldown placeholder
- Power-consuming + recipe-intensive build
- Size: large; touches `world.ts`, `island.ts`, `biomes.ts`, render layer

**#43 — §13.3 Omniscient Lattice**
- Network unity meta-mechanic
- Activates when one Lattice Node placed on each of N T5-mastered islands (N = NC threshold, default 20)
- Effects: unified inventory across all Lattice islands, cross-island adjacency (buildings count as neighbors despite distance), endgame "win condition" mechanics
- Size: very large; likely needs own module + careful economy integration

**#44 — §13.3 Singularity Battery**
- T5 power-storage building
- Stores excess generated power as bankable W-seconds
- Backup during brownouts / night solar gaps / launches
- Capacity per battery placeholder; chain multiple for headroom
- Integrates with §5.1 power balance
- Size: medium

**#45 — §8.10 T5 extractor multi-output rotation**
- Aetheric Conduit cycles between {aetheric_current, quantum_foam}
- Spacetime Resonator: {spacetime_fragment, tachyon_stream}
- Eldritch Sieve: {dark_matter, strange_matter, higgs_flux} at 1/3 each, deterministic from seed + cycle index
- Player doesn't pick; recipe model needs multi-output rotation pattern (not currently supported)
- Size: large

**#52 — Per-tier settlement vehicle loadouts**
- Currently all vehicles use T1 ship / T1 helicopter constants
- Spec §12.6 lists per-tier stats (T1-T4): different speeds, fuel efficiencies, payload capacities
- Size: medium

**#53 — Skill tree past depth 2**
- Each sub-path needs nodes at depths 3-15 per SPEC §9.3
- Depth gates: 3 needs T3, 4 needs T4, 5-7 needs T5, 8+ needs T6
- Cost grows geometrically (2^(depth-1))
- Magnitudes geometric through depth 5 then unique unlocks (recipe unlocks, structural changes, exotic adjacencies, biome-bypass access)
- Per-sub-path enumeration deferred to Appendix A per spec — pick reasonable placeholders
- Size: large; touches `skilltree.ts` + UI

**#54 — §13.4 Endgame goals / victory**
- Define and wire win-condition surface
- Spec mentions: deploy N satellites in orbit, activate Omniscient Lattice, complete all T6 buildings, etc.
- Currently zero — game continues forever
- Add win-state detector and endgame screen / banner
- Size: large

**#55 — Multi-island HUD**
- HUD currently tracks only active island
- Add slim multi-island bar showing all populated islands: name, level, brownout status, alert badge (storage cap hit)
- Click to make active
- Deferred per `main.ts:536`
- Size: medium; render-layer only

**#56 — Tutorial / first-time onboarding**
- No tutorial exists; new players see blank island + zero context
- Stepped onboarding: place Mine → Coal Gen → Smelter → Antenna → build first drone, etc.
- Sequence of objective banner cues or tooltip overlays
- Size: large; render-layer / DOM overlay

---

## 5. FIXMEs in source

| Location | Text | Task |
|----------|------|------|
| `src/network-consciousness.ts:14` | `FIXME(§9.6)` — "populated at T3+" simplified vs route-graph reachability | #18 |
| `src/specialization.ts:96` | ~~Route capacity doubling deferred~~ ✅ DONE in `bcaefb8` | #30 |
| `src/main.ts:536` | Multi-island HUD deferred | #55 |
| `src/building-defs.ts` | Multiple `// §14 placeholder — tune in Appendix A` on costs | #15 follow-up |

---

## 6. Known non-blocking nits from reviews

1. **`inspector-ui.ts:126`** reads `def.placementCost ?? {}` directly instead of `placementCostFor()` helper. DRY drift.
2. ~~`previewScrapForBuilding` vs `demolishBuilding` scrap drift~~ ✅ FIXED in `e6d2b1f` — both now use `floor(sum(placementCost) * 0.3)`.
3. **12 of 88 defs** use `"Lighthouse placeholder — tune in Appendix A"` / `"Antenna placeholder..."` instead of standard `"§14 placeholder..."` pattern. Greppable inconsistency.
4. **`fuelForTier(t: 1|2|3|4|5|6)`** in `recipes.ts:311` re-spells the `Tier` union from `skilltree.ts:79`. Could import `Tier` or move both to shared base module.
5. **No render-layer smoke test** for `renderOceanFogOverlay` on merged-island fixtures. Coverage is transitive through `islandCells`.

---

## 7. Resume guidance

### Method
This session used **subagent-driven-development**: sequential implementer → spec reviewer → code quality reviewer per task. Do NOT dispatch multiple implementers in parallel (file conflicts on shared modules like `economy.ts`, `world.ts`, `building-defs.ts`).

### Suggested first tasks
If picking one task to warm up:
1. **#19 Drone Pad T1→T2** — trivial, one-line change + test adjustment
2. **#25 Cold Storage consumers** — trivial, tag resources
3. **#17 §10.1 funnel provenance** — small, well-scoped, touches pure layer only

If picking a meatier task:
4. **#21 §8.1 tile-gating** — medium, high gameplay impact
5. **#28 §12.5 vehicle failure rolls** — medium, self-contained

Avoid starting with #36 (weather core) unless you're ready to commit to the full chain (#37, #38, #27) because they all block on it.

### Context you will need
- `SPEC.md` is the locked specification (~1800 lines). When adding or changing a mechanic, find the relevant § and align with it.
- `AGENTS.md` governs: pure/render separation, coordinate systems, economy loop, input registry, vision model, build order.
- The codebase enforces `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`. New code must compile clean.

---

## 8. Session reference

- Full session analysis: `python3 ~/analyst/scripts/parse_session.py bfb35be4-452d-4c27-89b6-bf4963313012 --cache`
- Task tracker: `TaskUpdate` tool events in session JSONL (not `SetTodoList`)
- All 32 agent launches completed; 3 background bash tasks completed; none in flight at exit
- Cron was set for Wed 21:05 UTC (23:05 Prague) 2026-05-13; session may have restarted since then
