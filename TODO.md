# TODO

## Working directive — read first

All implementation work in this repo MUST go through subagents. Lead
session writes briefs and dispatches; subagents do the source reads,
edits, tests, and commits. Lead context is coordination only — every
full-file read on the lead burns context that should be spent
dispatching.

Pattern: Lead → Agent (background) → wait for task-notification → read
the agent's reported commit sha + test count → pick next item from
this TODO. Foreground agents only for genuinely sub-15s work with
prior runtime evidence; default to `run_in_background: true` and
respond to the `<task-notification>` event.

Per-dispatch checklist:
- (a) make the fix
- (b) check SPEC.md for any sentence/table the fix invalidates, update if so
- (c) delete the matching TODO entry
- (d) commit all together with the standard
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer

Subagent runtime: kimi usage was depleted at the time of last session
(reset ~20h after 2026-05-18). Default to Claude-side Agent tool
dispatches — that's what every subagent in the prior 30+ commits used.
Check kimi quota before considering kimi delegation.

---

Consolidated punch list from the 4-agent sweep (200% file coverage,
~244 raw findings, deduped + verified against source + SPEC.md).

---

## Next major (owner-declared 2026-06-10) — server-authoritative migration

Owner intent: move the simulation off the browser to a server;
browser becomes display + intent-sender. Decided inputs (start the
future brainstorm from these, don't re-litigate):

1. **Server-authoritative, NOT shared-sim.** Rationale: anti-cheat +
   future player interactions. Client sends intents (place, spend,
   trade, dispatch); server validates against the same pure-layer
   rules and owns all state. Player-to-player interaction stays
   entirely server-side.
2. **The pure layer ports as-is.** Proven headless in node:
   `scripts/profile-economy.ts` boots a real save via
   `deserializeWorld` + ticks `advanceIsland` with zero browser. The
   server is "that, behind persistence + a socket".
3. **Tick model**: event-driven integrator already handles arbitrary
   dt (24h catchup = same code path); server ticks lazily or at the
   5 Hz cadence (see ECONOMY_TICK_MS seam from the 2026-06-10 perf
   pass — that constant is the line the server later owns).
4. **Persistence**: SerializedSnapshot + the v7→v22 migration chain
   move to a server DB; SPEC §15.6 (pure client-side) is superseded
   at that point; Appendix B "multi-device sync" flips in-scope.
5. **Determinism as bandwidth**: seed-deterministic weather/daynight
   render client-side from (seed, t) — no need to sync them.
6. **Known seams to finish splitting**: island.ts / world.ts mixed
   files, main.ts wiring, UI panels reading live state objects
   (would read a synced replica).

Supersedes nothing yet — this is a recorded design input, not a spec.
Full brainstorm → spec → plan when the owner says go.

---

## Next major after Ocean — Multi-biome §3.6 merge rework

Current §3.6 merge collapses absorbed island's biome into absorber's:
former-Coast water tiles become Plains grass, ore deposits disappear,
biome modifiers (Coast wave power, Volcanic free heat) are voided.
Player loses everything they invested in the absorbed island except
the building positions. That's a straight downgrade — the opposite of
what a player merging two specialized islands wants.

Design locked 2026-05-18 (skip this brainstorm next time, it's done):

1. **Per-constituent biome + seed**. `extraEllipses` entries gain
   `biome: Biome` and `seedId: string`. `terrainAt` dispatches per
   tile to the constituent that contains it.
2. **Overlap rule**: where primary + extra both contain a tile,
   absorber's primary biome wins. Single, easy-to-reason rule.
3. **§3.5 modifiers per-constituent**: a building gets modifier bonuses
   only from the constituent its tile sits in. Coast wave-power
   applies only to former-Coast tiles.
4. **Reclamation outward** uses absorber's primary biome (consistent
   "new growth is always primary" rule).
5. **Migration skipped** — solo-dev playtesting, no live joined-island
   saves to preserve.

Files: `src/world.ts` (extraEllipses type extension, terrainAt closure
dispatch), `src/island-merge.ts` (performMerge propagates biome+seed
on the appended ellipse), `src/biomes.ts` (per-constituent modifier
application surface), `src/economy.ts` / `src/heat.ts` /
`src/reactor-toxicity.ts` (any modifier-application site needs to
look up the building's constituent, not the island's primary biome).

Estimated ~4-6 commits. Independent of Ocean; queue when Ocean Tasks
9-12 land.

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
- **`src/recipes.ts` step #19 ×10/×20/×40/×60 cycle multipliers**
  through most recipes; SPEC.md cycle-time placeholders untouched.
- **`src/weather.ts:42`** `catastrophic: 0` (100% capacity kill); spec
  §2.6 silent on catastrophic. Code extrapolated; may be too harsh.
- **`src/routes.ts:96`** `TELEPORTER_FUEL_PER_TILE = 0.005` — entire
  teleporter-fuel mechanic is an in-game design addition (not in spec).

---

## 5. Deferred UI surfaces

- **Route-type picker in routes-ui.ts.** `src/routes-ui.ts:516` hardcodes
  `type: 'cargo'` for all UI-created routes. `mass_driver` and
  `submarine_cable` exist at the data layer but cannot be created through
  the UI. Implementing a route-type picker would unblock both. Existing
  `cargo` / `drone` / `airship` / `teleporter` types are also all reachable
  only via this single path today.

---

## 6. Brittle patterns / type-discipline notes

- **Two-place constants that must stay in sync.**
  - `FUNNELING_BONUS_PERCENT` in `src/routes.ts:103` and
    `FUNNELING_BONUS_PERCENT_FOR_DRAIN` in `src/economy.ts:1113`.
    Documented in both comments; drift caught by economy test.
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

## Appendix — recurring lesson patterns

Captured from prior sessions; check against new work to avoid
re-discovering these.

### Time-domain mismatches

Code that reads time MUST be explicit about wall-clock vs
performance.now() domain. `performance.now()` resets to ~0 on every
page reload; `Date.now()` is wall-clock and survives. The §2.7 solar
gate had to be refactored to thread wall-clock through every callsite
(`computeRates` → `advanceIsland` → `main.ts` ticker) — see commit
`847e010` for the pattern.

Pre-flight check on any new "sample value at time t" code: which
domain is `t` in? Will it survive a refresh?

### Recipe / catalog drift

Code comments self-flagging "spec-literal pending — using stand-in"
tend to accumulate. Periodically grep `STILL-DEFERRED` and the
patterns it indicates. When the spec ingredient lands in the catalog
later, the original recipe doesn't automatically migrate; needs an
explicit pass. Examples: §4.7 T2 maintenance bolt → bearing
(`72ac25f`), Sunspire missing solar-flag (`a4f9f98`).

### Audit-trust caveat

Multi-agent audits find divergences but can't tell which side is
wrong. Code-vs-spec mismatches always need a designer call:
sometimes spec is the design truth (code is buggy → fix code),
sometimes code is the design truth (spec is stale → update spec).
The T1-drone case in this codebase was the latter — every auditor
flagged code as wrong; the resolution was a SPEC update (see commit
`8d69e92`).

Before fixing each audit finding, ask: "is this code-bug or spec-
drift?" Don't reflexively assume code is wrong.

---

Maintainer note: when a TODO entry ships, delete its line rather than
striking it through. The list should always represent open work.
