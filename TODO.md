# TODO

Snapshot of known unfinished work as of commit `b2999e0`. Compiled from the
81 `STILL-DEFERRED` markers in `src/*.ts` plus session audits.

Organised by category. Within each category, items are ordered roughly by
player-facing impact (highest first). Spec section references are §-numbers
from `SPEC.md`.

---

## 1. Missing mechanics (new systems to build)

These are systems the spec defines but the codebase doesn't implement at
all. Building them requires new state, new tick paths, or new UI surfaces.

- **§4.5 adjacency effects (catalog)** — placement records adjacency
  metadata; effect computation is wired only for heat (§5.2) and reactor
  toxicity. The broader catalog of buff/gating adjacencies (Cooling
  Tower → Crystal Lab unlocks rare recipes, Wastewater Treatment →
  Refinery efficiency, etc.) is unimplemented.
  Files: `placement.ts:14, 21`, `building-defs.ts:1530`.
- **§4.7 Servitor Conversion Kit + Reality Forge mechanic** — the
  `eternalServitor` flag on `PlacedBuilding` is honoured by `maintenanceFactor`,
  but no recipe at the Reality Forge produces a Conversion Kit and no UI
  applies one to a placed building. Players can't actually create
  Eternal Servitors.
  Files: `buildings.ts:71`, `maintenance.ts:23`.
- **§13.3 Reality Forge biome reassignment** — Reality Forge ships as
  an inert catalog row. The mechanic to pick a target biome, re-roll
  terrain from world seed under the new biome, and invalidate buildings
  on now-wrong tiles isn't implemented.
  File: `building-defs.ts:1902`.
- **§13.3 Singularity Battery power storage** — ships as inert; the
  "effectively infinite electrical power storage" mechanic per §13.3 is
  deferred. Building exists, does nothing.
  File: `building-defs.ts:1845`.
- **§13.3 Spacetime Resonator multi-output rotation** — produces only
  the spacetime_fragment side of its `(spacetime_fragment OR tachyon_stream
  per cycle)` rotation. Rotation deferred.
  Files: `building-defs.ts:1811`, `recipes.ts:1812`.
- **§14 Spaceport tier I/II/III upgrade lifecycle** — the `tier` field
  on a placed Spaceport exists, but no upgrade-recipe consumption path
  promotes I→II→III. Permanently stuck at tier 1 = 30% launch success.
  File: `building-defs.ts:2024`.
- **§14.7 Pad-explosion → tier reset** — current behaviour DELETES the
  Spaceport entirely. Spec says it should revert to tier I (losing only
  the upgrade investment). Functional regression, not just missing
  feature.
  Files: `orbital.ts:198-202`, `building-defs.ts:2026`.
- **§14 Antenna T6 dish dual-role** — T6 Antenna is supposed to double
  as a satellite dish for orbital launches. Dish-side dual-role isn't
  implemented; T6 antenna only does signal range.
  Files: `antenna.ts:10`, `building-defs.ts:3699, 3775`.
- **§7.3 chlor-alkali variant consumer recipes** — Chlor-alkali plant
  produces; the downstream consumer chain that uses Chlorine / Sodium
  Hydroxide as inputs for plastic precursor / alumina is deferred.
  Files: `recipes.ts:1618, 1619`.
- **§3.6 merged-island Tier Reset integration** — Tier Reset on a
  merged island is documented as deferred until §3.6's merge mechanic
  shipped. §3.6 has shipped; the merge-aware reset code hasn't.
  File: `tier-reset.ts:35`.
- **Settlement vehicle per-tier loadouts/speeds** — every vehicle uses
  one base stat set. Per-tier variation (T1 Cargo Ship vs T2 Heavy
  Freighter range/speed/loadout) deferred.
  File: `settlement.ts:10`.
- **Foundation Kit mid-flight decomposition** — currently decomposes
  on arrival. Spec implies in-flight decomposition for the §12.3
  grace-cap mechanic.
  File: `settlement.ts:19`.
- **Settlement dock landing position** — newly-settled colonies'
  starter dock auto-places at island centre regardless of geometry. Real
  placement (coastal tile, corner-of-buildable-area) deferred.
  File: `settlement.ts:429`.
- **T4/T5 founder tiers for Platform Constructor** — T3 founder caps
  artificial islands at 8×8 per §2.5. T4 (12×12) and T5 (16×16) caps in
  `MAX_RADIUS_BY_TIER` are deferred.
  Files: `artificial-island.ts:26, 134, 158`.
- **Cold Storage consumers** — `temp_sensitive` storage category exists,
  but the resources that should land in it (cryogenic compound, liquid
  nitrogen) aren't in the catalog yet, so Cold Storage has no consumers.
  File: `storage-categories.ts:53`.
- **§2.1 infinite map + density tuning** — SPEC.md line 3 calls the
  world "infinite" and §2.1 says each cell contains at least one island
  with additional islands per cell via geometric decline (placeholder
  0.30, cap 4 per Appendix A). Implementation is finite
  (`DEFAULT_GEN_OPTS.halfExtentCells = 10`, 21×21 cell window, one
  generation pass at game start) and uses a per-cell roll at p=0.3 with
  at most one island per cell, producing ~64 islands in a ~340-tile
  square that read as "too dense, too close together" rather than
  "almost stranded but one next island always reachable" (visually
  verified — 14-tile plains islands stack into peanut shapes because
  `world-gen.ts` `overlapsAny` only enforces a 4-tile buffer between
  ellipse edges).
  Wanted: (a) infinite generation — lazily produce island specs for
  any cell the player can reach via drone/satellite/route, rather than
  pre-generating a finite block; (b) tuning that biases toward the
  stranded-but-reachable feel — concrete starter knobs are density
  0.3 → 0.15 and `overlapsAny` buffer 4 → 12, but reconsider in the
  context of the infinite-cell-grid rewrite.
  Migration for existing saves: keep every populated island exactly
  as-is (state + spec + buildings), keep `revealedCells` as-is so the
  player doesn't lose discovered ocean, but drop the saved
  discovered-but-not-populated island specs and regenerate them under
  the new generator. Save-format bump (v3 → v4) probably warranted so
  the migration step runs exactly once.
  Files: `world-gen.ts:23,59`, `world.ts:788` (`DEFAULT_GEN_OPTS`),
  `persistence.ts` (migration path).
- **§4.7 maintenance degradation only affects recipe rate** — spec
  §4.7 calls maintenance a "function of presence, not productivity":
  every building accrues `operatingMs` and demands maintenance
  materials regardless of whether it's producing. But the engine only
  multiplies the maintenance factor into `effectiveRate` for resource
  recipes (`economy.ts:863`). Power producers, storage, antennas,
  lighthouses, drone pads, shipyards, lab/utility buildings — anything
  without a `recipe` — suffer ZERO consequence from being neglected.
  They burn through maintenance materials with no payoff for keeping
  them maintained, which makes the system pointless for ~half the
  catalog. Spec wording "output efficiency degrades from 100% to 50%"
  needs a defined "output" per building category:
    - power producers: `power.produces` × maintFactor (note: cascades
      into brownout — needs care to avoid double-dipping)
    - antennas / lighthouses: signal range / vision radius × maintFactor
    - storage: cap × maintFactor (forces overflow / loss)
    - drone pads / shipyards: vehicle capacity or dispatch rate ×
      maintFactor
  OR the spec can be reread to mean "if a building has no productive
  output, skip maintenance accrual entirely so it doesn't waste
  materials". Either interpretation is sane; pick one and ship it.
  Files: `economy.ts:839-863` (factor application site), `maintenance.ts`
  (accrual + tryAutoMaintain), spec §4.7.
- **§3.5 rare-find rolls system** — the "Cursed Storms doubled-rare"
  modifier is wired as -10% production (which works) but doubled-rare
  is deferred since there's no rare-find roll system. Same for Mining
  "rare reveal" / Forestry "exotic species" — currently modelled as
  continuous trickle (mathematically equivalent over time but loses the
  "you got lucky" flavor).
  Files: `biomes.ts:210`, `skilltree.ts` (mining.3 / forestry.3).
- **§5.2 high-emission Exhaust Scrubber adjacency** — Exhaust Scrubber
  exists as a catalog row; its adjacency requirement for high-emission
  buildings isn't wired.
  File: `building-defs.ts:1530`.
- **§4.7 Servitor / §5.2 dish dual-role / etc — many catalog rows
  shipped as inert defs** awaiting their owning mechanic. See
  `building-defs.ts` lines 1293, 1464, 1498, 1516, 1587, 1688, 1922,
  2065 for the full set of "def ships, mechanic deferred" markers.

---

## 2. Mechanic shipped, no UI to invoke

These have the simulation wired but no player surface to access them.

- **Routes drag-to-reorder priority editor** — priority list IS used
  by the dispatch loop but only configurable via the data model. UI is
  a static display.
  Files: `routes-ui.ts:455, 509`.
- **Inspector construction-time text** — cyan tint + progress arc on
  the building shows that a build is in progress, but the inspector
  doesn't show "Construction: 89s remaining" text.
- **Inspector skill-bonus annotations** — buildings affected by skill
  multipliers (every Mine, Logger, Smelter etc.) don't display "base rate
  × N skills" — multipliers are invisible.
- **Skill-tree branch-lock visual** — committed sub-paths have no
  visual flag; sibling-locked sub-paths don't read as "blocked until you
  complete the committed one". Players discover the lock by clicking
  and getting rejected.
- **Tier-reset cost preview** — action works; the UI doesn't preview
  the steel+gear cost before commit.
- **Multi-island HUD** — HUD shows the active island only. Top-bar
  chips give per-island level/power; the detail panel doesn't switch.
  File: `main.ts:620`.
- **Antenna signal-range overlay** — drones outside antenna range lose
  scanned cells; no on-map indication of where signal reaches.
- **Hover a coloured terrain cell to show its type + consumer buildings**
  — every non-default terrain tile (oil_well, gas_seep, copper_vein …)
  is rendered with a distinguishing colour but there's no on-map
  affordance telling the player what it is or which buildings need it.
  Want: hovering a tile (or a 3×3 cluster cell) surfaces a small
  tooltip with the terrain id and a one-line list of `requiredTile`
  consumers from `BUILDING_DEFS` (e.g. "copper_vein — needs Copper Mine
  (2×2)"). Pure-data lookup, no new sim.
  Files: `building-defs.ts` (consumer lookup), `inspector-ui.ts` or a
  new hover-tooltip surface near `main.ts`'s mouse handlers.

---

## 3. Mechanic shipped, missing visual indicators

- **§2.7 day-night background tint** — shipped earlier this session;
  not visually re-verified at dusk/night specifically.
- **§4.7 maintenance corner dots** — shipped; not visually re-verified
  after subsequent overlay changes.
- **§14 satellite map dots + coverage rings** — never reproduced in
  browser (player has no sats).
- **§13.4 endgame victory banner** — *intentionally removed this
  session* (the spec says "no win screen"). Listed here so a future
  contributor doesn't re-add it.

---

## 4. Verification gaps (claimed working, never visually tested)

- Cell-snap vision rendering at high zoom after the smooth→blocky
  rewrite.
- Range ring + reticle color-flip while launch armed.
- Tier-reset HUD chip — appears only at T3+ with cooldown clear +
  materials. Not reproduced.
- Endgame banner display (now removed; was never reproduced before
  removal either).

---

## 5. Polish / nice-to-have

- Spaceport tier upgrade UI button + cost display.
- Satellite-launch result toast (success / failure split) instead of
  the modal's small flash message.
- Drone dispatch ETA prediction in the dock (current code shows max-
  flight-time only).
- Per-island per-resource net rate sparkline in the HUD detail panel.
- Save-export / save-import for backup + cross-device sync (idb-keyval
  is the only persistence path today).

---

Maintainer note: when a TODO entry ships, delete its line rather than
striking it through. The list should always represent open work.
