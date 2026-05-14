# Handoff — Robot Islands (post-2026-05-14 plan run)

> Transient resume note. **DELETE on resuming** (`rm HANDOFF.md` once read).

## Current state

- **Branch**: `master` @ `d0ed492` (19 commits ahead of `origin/master` at `Nitjsefnie-Games/robot-islands` — push when ready)
- **Tests**: 1067 / 1067 passing across 40 files (up from 1001 at run-start)
- **Build**: `tsc -b && vite build` clean
- **Live URL**: `https://islands.nitjsefni.eu/` via `robot-islands-dev.service` (Vite HMR — don't restart for source edits)

## This run

Executed `docs/superpowers/plans/2026-05-14-handoff-resolution.md` via subagent-driven-development, mostly with Kimi K2.6 as the implementation subagent.

| Phase | Status | Notes |
|---|---|---|
| P1 Bootstrap deadlock | ✅ 1/1 | Home Plains seeded with tree + 2×2 stone cluster |
| P2 Real runtime bugs | ✅ 3/3 | repair-drone perfShift, declaredAt/lastResetAt perfShift, soft-gate effectiveMul |
| P3 Mechanical cleanup | ✅ 4/4 | DEFERRED-comment cleanup, tier-helper drift, drone tier hardcode, tier-reset TODO cross-ref |
| P4 Partial stubs | 🟡 3/8 | 4.1 Servitor, 4.2 artificial-island modifiers, 4.6 Foundation Kit grace cap done; rest below |
| P5 Missing buildings | ✅ 17 defs across 5/5 commits | §8.1 / §8.3 / §8.5 / §8.7 / §8.8+§8.9 / §9.5 |
| P6 Orbital live mechanics | ❌ 0/7 | Not started — full subsystem |
| P7 Persistence test coverage | ✅ 1/1 | 11 round-trip tests added |
| Final | ❌ | Pending |

19 commits total. Co-author trailers: Kimi K2.6 for the implementer dispatches (most of them), Claude Opus 4.7 for the plan-file commit and one comment-only fix (Task 3.4).

## 🚨 Verification debt (do this BEFORE trusting code below)

Two UI-touching commits shipped without a Daedalus visual check (no
`islands.nitjsefni.eu` tab registered at session-end; `mcp__daedalus__list_tabs`
returned only `tikety` / `kimi-dash` / `ccudash`). Both have passing unit tests
but the user-visible behavior is unverified:

- **Bootstrap fix (`b3859b9`)** — the only fix to the only flagged BLOCKER. Tests
  prove the tree + 2×2 stone coordinates exist in `defaultTerrainAt`. They do
  NOT prove that on a fresh game the player can interactively place a Logger
  on a tree tile and a Quarry on the stone cluster, with terrain rendered and
  inspector affordances responsive. Open `https://islands.nitjsefni.eu/` in a
  Daedalus-instrumented Chrome window, force a fresh game (clear IndexedDB +
  reload), and confirm the bootstrap chain is actually playable. If not, this
  run did not in fact resolve the BLOCKER.

- **Eternal Servitor UI (`c6ef66f`)** — Kimi's reply explicitly said "requires
  post-merge visual check." Place a Reality Forge (will need T5 access state
  on the home island — `state.aiCoreCrafted = true` and `level = 50`), open
  inspector on a non-Servitor building, click "Convert to Eternal Servitor",
  confirm cost-deduction + flag-flip + UI flip to "ETERNAL SERVITOR — exempt".

## Final-phase code review (skipped this run)

The plan's Final-phase cross-cutting code-quality + spec-compliance reviewer
pass over commits `2a8736f..HEAD` was NOT performed. Per-task reviews caught
per-task issues; a sweep catches combinatorial things — e.g., the new
`starterInventoryGrace` map and the new `eternalServitor` flag both touch
PlacedBuilding / IslandState; does saving a colony with kit-grace inventory
AND a Servitor-converted building survive deserialize correctly?
Run the final reviewer on `git log 2a8736f..HEAD` before merge / PR.

## What's left (in priority order)

### Pending resource-catalog additions (PREREQUISITE for 4.3 / 4.5 / 4.8)

Three resource-catalog gaps block four P4 tasks. Add these as a single task
mirroring how `5.5b` added `carbon_fiber` across 5 registries (ResourceId
union, ALL_RESOURCES, XP_WEIGHT, RESOURCE_STORAGE_CATEGORY,
RESOURCE_CATEGORY):

- `gold_ore` (§6.4 T3 raw — for 4.5 slag reprocessing output)
- `silver_ore` (§6.4 T3 raw — for 4.5)
- `rare_earth` (§6.4 T3 raw — for 4.5)
- `memetic_core` (§6.6 T5 refined — for 4.8 T6 maintenance literal)

Optionally also `uranium_ore` (§6.4) so Nuclear Reactor's coal-placeholder fuel
in commit `b83e294` can switch to the real T3/T4 fuel.

Should also decide on `chemical_reactor` def (§8.2) — needed for 4.3. Two paths:
either ship a generic def as an explicit toxicity-event anchor, or change 4.3's
gating to apply to any two adjacent `category: 'chemistry'` buildings. Pick before
implementing 4.3.

### P4 remaining stubs

#### 4.4 — §5.3 cable W-capacity transmission (UNBLOCKED, moderate)

`power_substation` def now ships (commit `6316c4a`). Mechanic to implement:
- Cable routes (RouteType `'cable'` already exists in `routes.ts:40`) interpret `capacityPerSec` as Watts.
- When both endpoints have at least one `power_substation` placed, the destination island's power balance treats the cable as a virtual producer at up to `capacityPerSec` W.
- Source-side deduction: simplified scope says don't deduct from source's available power (cable is "free wattage on dest"). More-correct scope deducts the transmitted W from source's `P_produced` aggregate. Pick the scope.

Touches: `economy.ts` (add cable inflow to `powerProduced` for the destination island; threading via `RatesContext` or a new `crossIsland.cableInflowW` field), `routes.ts` (recognize cable routes don't transfer items), call sites in `main.ts` that build the context.

Test plan: place power_substation on home + a discovered island, create a cable route, assert the destination's `powerProduced` includes the cable W.

#### 4.7 — §11.5 T4 Launch Tower omnidirectional pulse (design call needed first)

Current `dispatchDrone` uses tier from launching island, but a Launch Tower drone behaves fundamentally differently per §11.5:
- No flight path / no travel time ("no flight path; not corridor-shaped")
- Reveals a single disk of radius 3R centered on launch origin (R = stratification cell side length)
- Resolves at launch time (no return-trip wait)

**Recommended design** (pick before dispatching): add a separate `firePulse(world, origin, nowMs)` function in `drones.ts` that handles Launch-Tower-specific dispatch. Keep `dispatchDrone` focused on corridor / path-drawn drones. Rationale:
- A pulse doesn't fit the `Drone` data model cleanly (no direction, no travel time, no return event). Forcing it into `dispatchDrone` via a `mode` param creates dead branches throughout that function.
- A `firePulse` function can produce its own simpler result (immediate discovery list, fuel deduction, one-shot "pulse" log entry) without touching `Drone`.
- Launch Tower's UI button calls `firePulse` directly; `dispatchDrone` continues serving Drone Pad / Path Drone Foundry.

If the next implementer disagrees with this design, brief them to flag the alternative before writing.

#### 4.3 — §4.5 Chemical Reactor toxicity event (BLOCKED on chemical_reactor decision)

See "Pending resource-catalog additions" above for the `chemical_reactor` def decision. Once made, implement the 5%/hr-per-adjacent-reactor roll → 50% throughput for 1h cycle; new module `src/reactor-toxicity.ts` (pure-layer, seeded RNG from `${world.seed}_toxicity_${reactorId}_${hourTick}`).

#### 4.5 — §6.7 slag reprocessing (BLOCKED on §6.4 resource additions)

Blocked until `gold_ore` / `silver_ore` / `rare_earth` ship. Then add a slag-reprocessor recipe at low yield per §6.7 ("trace minerals at low yield").

#### 4.8 — §4.7 T6 maintenance recipe literal (BLOCKED on memetic_core)

Once `memetic_core` ships, swap `maintenance.ts:78` from `eldritch_processor` substitution back to the spec literal.

### P6 — §14 orbital live mechanics (full subsystem)

Seven tasks in the plan; each implements one §14 section in `src/orbital.ts`:
- 6.1 §14.2 Orbital Tracking Station def + debris visibility
- 6.2 §14.8 Debris fields + orbit-explosion generation + lodge events
- 6.3 §14.6 Satellite movement (fuel-spend)
- 6.4 §14.5 Scanner dwell-ramp discovery
- 6.5 §14.7 Launch success — Orbital sub-path additive
- 6.6 §14.4 Per-tick comm-packet propagation
- 6.7 §14.8 Sweeper passive cleanup + §14.12 Repair Drone proportional fuel

Each is bounded to `src/orbital.ts` + tests. The §14.10 satellite recipes and §14.2 Spaceport upgrade lifecycle already ship; what's missing is the live mechanics. Watch for `orbital.ts` size growth — split into `orbital-debris.ts`, `orbital-comm.ts`, `orbital-movement.ts` if it exceeds ~800 lines.

### Final phase

Cross-cutting code-quality + spec-compliance reviewer pass over commits `2a8736f..HEAD`. Then `superpowers:finishing-a-development-branch` to merge / PR / cleanup.

## Lessons from this run

- **Kimi as implementation subagent works very well** for well-scoped briefs with verbatim spec quotes, file:line references, test code in code blocks, and explicit "do not touch" lists. Each brief ran 30s–4 min and shipped a clean commit with full `npm test` + `npm run build` passes.
- **Three early dispatches used the claude-side Agent tool by mistake** and stopped at the commit step (controller had to backfill). Kimi never did this — it ran the full TDD → test → build → commit cycle end-to-end.
- **Just-in-time concretization works.** Briefs were drafted right before dispatch, with the spec section pre-verified and the failing-test code embedded. Plan-level TBDs would have produced shallower output.
- **Dependency-aware ordering matters.** Several P4 tasks turned out to depend on P5 defs / resource-catalog additions that the plan placed AFTER P4. Reordering to do def-only P5 work before mechanic-completing P4 work was the right call mid-run.

## Files NOT to touch without thought

- `SPEC.md` — locked spec; iterate via `hypothesize-prove-loop` if changing.
- `AGENTS.md` — architecture invariants.
- `persistence.ts` schema constants — `SCHEMA_VERSION = 3`. Per user policy: forward-version integrity only.
- The 11 round-trip tests in `persistence.test.ts` added in `d0ed492` are now the safety net — keep them green.

## DELETE THIS FILE ON RESUMING

`rm HANDOFF.md` after reading. Not committed to git; intentional.
