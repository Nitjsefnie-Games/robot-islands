# AGENTS.md

This file provides guidance to coding agents working with code in this repository.

## Stack

**Client** (`src/`): Vite 5 + TypeScript strict + PixiJS 8 + vitest. No React.

**Server** (`server/`): Fastify 5 + Postgres + TypeScript strict, run directly via the `tsx` loader (no build step / no `dist/`). Tests use vitest against a real Postgres.

This is a **server-authoritative** game, NOT pure client-side. The original "pure client-side" design (`SPEC.md` §15.6) is **superseded** — see the §15.6 Superseded note and **Appendix C** (trust-surface / migration). The browser client is now display + intent-sender only; the `server/` workspace owns all authoritative state and persistence for server accounts and re-runs the pure rules to validate every mutation. REMOTE (server-authoritative over a WebSocket intent channel) is the default boot mode; LOCAL (client-only IndexedDB, opt-out via `?server=0` or `localStorage.setItem('ri_server','0')`) is the debug fallback. Mutations from the client flow through a **mutation-gateway** seam (REMOTE → WS intents; LOCAL → direct pure-layer calls).

## Commands

```bash
npm run dev        # vite dev server on 0.0.0.0:5173 (HMR-enabled)
npm run build      # tsc -b && vite build
npm run preview    # serve dist/
npm test           # vitest run — BOTH the client and server vitest projects (NOT hermetic)

# single test file
npx vitest run src/economy.test.ts

# single test by name
npx vitest run -t "Mine fills iron_ore to exactly cap"
```

**`npm test` is no longer hermetic.** `vitest.config.ts` runs two projects — `client` and `server` — and the `server` project's globalSetup connects to a real Postgres, runs migrations, and its suites truncate/migrate a shared test database. So `npm test` from the repo root **requires a running Postgres** (DATABASE_URL defaults to `postgresql:///robot_islands_test`) and will error out wholesale if PG is down — that is a missing prerequisite, not a code break. Server-only commands live in `server/`:

```bash
cd server
npx tsc --noEmit       # build typecheck (excludes *.test.ts — see tsconfig.json)
npm run typecheck      # strict typecheck WITH tests included (tsconfig.test.json)
npm test               # server vitest only (sets DATABASE_URL=postgresql:///robot_islands_test)
```

## Server-sim benchmarking — `server/bench/` (catch-up calc perf)

The authoritative per-account calc is `catchUp` (`server/src/game/runtime.ts`):
`deserializeWorld` + `advanceWorldEconomy` + `advanceWorldSystems`, all **shared
pure** functions (so a win here speeds the client too). `server/bench/` profiles
and benchmarks it against a real save, read-only.

- **`bench/iso-bench.sh`** — the reusable runner. Subcommands:
  `setup` (confine userspace to cores `0..N-2`, reserve the top core via a
  cgroup-v2 `AllowedCPUs` cpuset — runtime-only, reverts on reboot),
  `refresh-db` (freeze a copy of prod into `robot_islands_bench` via a read-only
  `pg_dump` — the bench NEVER writes prod; the frozen copy keeps live play from
  drifting the baseline), `run [gapMin] [reps]` (phase breakdown + full bench on
  the isolated core), `profile [gapMin] [reps]` (writes a `.cpuprofile`),
  `callcount [gapMin] [reps]` (per-function **call counts** — the redundant-recompute
  lens), `teardown` (give the core back). Defaults to the largest save (heaviest calc).
- **Harnesses** (`bench/*.mts`, run via `tsx`): `catchup-bench.mts` (times
  `catchUp` min/median/max and asserts a **SHA-256 oracle digest** of the
  advanced world — any behavior-preserving optimization MUST keep it
  byte-identical; a mismatch aborts), `catchup-phases.mts` (deserialize / economy
  / world-systems attribution), `catchup-profile.mts` (in-process `node:inspector`
  CPU profiler around only the warmed reps — `node --cpu-prof` under the tsx ESM
  loader misattributes everything to the loader worker, so use this instead),
  `catchup-callcount.mts` (same in-process Session but V8 **precise coverage**
  with `callCount` — aggregates per-function invocation counts over project
  `src/` functions, disaggregating anonymous closures by source offset + a head
  snippet via `Debugger.getScriptSource`; CPU time finds expensive leaves, call
  count finds redundant-recompute blowups a cheap-but-millions-of-times function
  hides — e.g. an O(nodes) `graph.nodes.find` re-run per building per segment).
- **Measurement discipline**: V8 JIT warmup dominates early reps (first rep can be
  ~2× the warm steady state), so the harness warms up and reports the **min**;
  cgroup isolation can't evict kernel per-CPU threads / IRQs from the bench core
  (only `isolcpus`+reboot can), so min-of-reps is the real noise defense.

```bash
cd server
bench/iso-bench.sh setup                 # once per session
bench/iso-bench.sh refresh-db            # re-snapshot prod (optional; copy persists)
bench/iso-bench.sh run 8 10             # gap=8min, 10 reps
bench/iso-bench.sh profile 8 6          # -> /tmp/ri-catchup.cpuprofile
bench/iso-bench.sh callcount 8 6        # per-function call counts, top-30
bench/iso-bench.sh teardown              # when done
```

## Dev server — serves built `dist/` (vite preview, no HMR)

A systemd unit `robot-islands-dev.service` runs `vite preview --host 0.0.0.0 --port 5173` on port 5173 and is reverse-proxied to `https://islands.nitjsefni.eu/`. It serves the static built bundle from `dist/` — **no HMR**. The browser only sees source changes after a fresh `npm run build` AND a manual page reload (HMR was leaving the tab in a half-applied broken-import state during multi-file edits; preview is the stable alternative). **Do NOT restart the service for code changes** — restart only when `vite.config.ts` or `package.json` deps change. For visual smoke-tests, the page is open in the user's browser via the Daedalus Chrome extension; `mcp__daedalus__screenshot` against the active tab is the standard verification path. After editing source you must `npm run build` and reload the browser tab before screenshotting — the live tab is stale until then.

## Source of truth

- `SPEC.md` (~1800 lines) is the locked specification — iterated under `hypothesize-prove-loop` before implementation. When adding or changing a mechanic, find the relevant § and align with it. The build order is §15.7.
- **Every change that alters behavior must update `SPEC.md` in the same change** — code and spec move together. SPEC.md is the source of truth, so any divergence is a bug: if a "fix" makes the code contradict its §, you are either fixing the code to match the spec or revising the spec to match an intended design change (surface which, and edit the relevant § accordingly). Never leave code and SPEC.md out of sync; never silently let code win over an unrevised spec.
- `CONTRIBUTING.md` defines **two integration tracks** plus a **linear history**: quick fixes (small, low-risk, self-contained) commit directly to `master`; full new features and massive/risky fixes go on a feature branch cut from `master`, reviewed via PR, then rebased and fast-forwarded. Either way `master` stays green and linear — integrate by rebasing and fast-forwarding, never merge commits. Repo-local git config has `pull.rebase=true` and `merge.ff=only`.

## Scope — fix the whole family, scope creep is welcome

**This repo accepts scope creep toward correctness.** When you find a bug, fix every sibling with the same root cause — not just the one instance that was reported. A bug almost never lives alone: the same missing `−half`, the same un-wired effect, the same off-by-one convention will be copy-pasted across N call sites (the cell-render `−half` family — `weather-overlay.ts` / `grid.ts` / `ocean.ts` / `drones-ui.ts` — and the §2.5 construction-ghost are the canonical examples). Grep for the pattern, fix all of it in one change, and update `SPEC.md`/this file if the fix encodes a convention.

**Do NOT refuse or defer a fix on "you didn't explicitly ask for this file" / "that's out of scope" grounds.** Surfacing a sibling and then *not* fixing it is the wrong default here — fix it. The only things that gate a fix are correctness risk (verify it) and the integration track (a genuinely large/risky sweep goes on a branch per `CONTRIBUTING.md`, but it still gets done). Narrowing scope to a single reported symptom and leaving known-identical bugs in place is itself a defect.

## Architecture

The codebase strictly separates **pure math** from **PixiJS rendering** so the simulation is testable without a renderer:

- **Pure layer** (no PixiJS imports): the large majority of `src/` (~80 of ~100 production files) — all game systems (`economy.ts`, `recipes.ts`, `placement.ts`, `drones.ts`, `routes.ts`, the `skilltree-*.ts` family, `vision-source.ts`, …) plus `camera.ts` and `input.ts`.
- **Render layer** (imports `pixi.js`, ~19 files): `main.ts`, `ocean.ts`, `buildings.ts`, `grid.ts`, the `*-ui.ts` panels, the `*-overlay.ts` overlays (including `conduit-overlay.ts`), `routes-renderer.ts`, `routes-dash-texture.ts`, `skilltree-graphview.ts`. Note `island.ts` and `world.ts` are **mixed**: they import PixiJS for render helpers but also export the pure functions tests target (`tileInscribedInEllipse`, `computeIslandTiles`, `islandRenderState`).

Tests target the pure layer only. Render code is read-only against state.

#### Render-group isolation + redraw gating (per-frame cost)

PixiJS v8 rebuilds a render group's draw instructions whenever any descendant changes, and re-collects/re-batches the **whole** group each frame when it's dirty. Two conventions keep the per-frame cost bounded — both verified by interleaved live A/B (`enableRenderGroup()` toggled on the same loaded scene, render-ms/frame the metric), not by single CDP captures (whose absolute self-time swings wildly with scene activity and is unreliable for before/after):

- **Promote large *static* subtrees to render groups** (`container.enableRenderGroup()`), so a per-frame redraw of any sibling can't force them to be re-walked, and camera pan/zoom moves them by one GPU matrix. Applied to `ocean` (~5.8k sprites), `islands`, `building-alerts`, and the routes static/overlay layers. Do this **judiciously, at the broad layer level only** — render groups don't batch across each other, so grouping many small layers *adds* draw calls and can regress (the `weather-overlay` layer A/B-tested as no-gain → deliberately left ungrouped).
- **Gate unconditional per-frame overlay rebuilds on a content signature.** An overlay whose `refresh()` does an unconditional `gfx.clear()` + redraw dirties the root render group *every frame* even when it draws nothing — the satellite/antenna overlays cost ~4.4 ms/frame this way on the endgame scene with zero satellites placed. Gate `refresh()` on a string signature of exactly the fields the draw reads (identical signature ⇒ byte-identical geometry ⇒ skipping is behavior-preserving), as `weather-overlay` / `building-alerts` already did. Overlays that set `visible=false` when empty (`sonar-ring`, selection, construction-ghost) self-mitigate and don't need this.
- **Instance per-frame-*animated* glyphs via a shared `GraphicsContext`, don't re-tessellate them.** A signature gate can't help geometry that genuinely moves every frame (e.g. the route-flow chevrons, one per in-flight bot — on a busy transport save that's thousands, all sliding along their routes). The old `routes-renderer.paintOverlay` accumulated every chevron triangle into one `Graphics` and `clear()`+re-tessellated the whole batch each frame; cost scaled with the in-flight count and made `routes-overlay` the top render layer. Fix: tessellate ONE unit glyph into a shared `GraphicsContext` once, then pool a `Graphics(ctx)` per instance and write only per-frame `position`/`rotation` (a matrix update — Pixi v8 reuses the one tessellated geometry across every Graphics on that context). Byte-identical vector output, per-frame CPU drops from O(count) tessellation to O(count) matrix writes — live interleaved A/B on a ~3.2k-chevron save: **−1.5 ms render/frame** (instanced every run below legacy every run). Bound the pool (trim the hidden tail back toward current-need + slack) so an offline-catch-up burst doesn't strand thousands of hidden children in the per-frame walk.

### Coordinate systems

- **Tile coords** are the unit. Buildings, island geometry, and island centres (`IslandSpec.cx/cy`) are all in tiles.
- **World pixels** = `tile * TILE_PX` (`TILE_PX = 24` in `island.ts`). `tileToWorldPx` converts.
- **Screen pixels** = `world_px * cam.zoom + (cam.tx, cam.ty)`. The `Camera` in `camera.ts` is pure state; `main.ts`'s ticker syncs `world.position`/`world.scale` from it once per frame. `app.renderer.screen.{width,height}` are CSS pixels and match camera units; `renderer.{width,height}` are device pixels (DPR-scaled) — don't mix them.

#### Tile index has TWO conventions — geometry uses corners, render uses centres

A tile index `(x, y)` means different things to the two layers, and conflating them shifts drawings half a cell (this bit the §2.5 construction ghost):

- **Geometry / inscription (pure layer):** tile `(x, y)` is the unit square from `(x, y)` to `(x+1, y+1)`. A tile is part of an island iff all four corners `(x,y),(x+1,y),(x,y+1),(x+1,y+1)` lie strictly inside the ellipse — `tileInscribedInEllipse` (`island.ts`), wrapped by `islandInscribedAny` (multi-constituent) and used by every placement/footprint check (`validatePlacement`, `regionDiscoveredOrVisible`, `islandsOverlap`). Coords here are **island-local** (relative to `IslandSpec.cx/cy`); a building's stored `b.x/b.y` are island-local too, so its world tile is `(spec.cx + b.x, spec.cy + b.y)`.
- **Render (PixiJS layer):** tile `(x, y)` is drawn **centred** at world pixel `(x*TILE_PX, y*TILE_PX)` — its rect is `[x*TILE_PX − TILE_PX/2, x*TILE_PX + TILE_PX/2)`. So tile-drawing code subtracts `half = TILE_PX/2`; it must NOT put the rect corner at `x*TILE_PX`. Canonical example: `renderBuildings` in `buildings.ts` (`t.x * TILE_PX - half`). Any new tile-footprint render (e.g. `construction-overlay.ts`) must apply the same `−half`, or it lands half a cell off the buildings/land it should align with.

### Spec/state separation per island

`IslandSpec` (in `world.ts`) is the static `readonly` definition (terrain function, ellipse, building positions, discovered/populated flags). `IslandState` (in `economy.ts`) is the mutable runtime (inventory, xp, level, lastTick). They reference each other by `id`. `makeInitialIslandState(spec, nowMs)` constructs state from a spec.

### Vision model (three-tier ocean)

Locked-in visual contract — see `world.ts`, `ocean.ts`, and `vision-source.ts`:

- `'visible'` — populated, OR discovered AND inside any vision source. Vision is **multi-source** (`VisionSource` in `vision-source.ts`): every populated island contributes a padded ellipse halo (`VISION_PADDING_TILES = 10` beyond the island ellipse, one per constituent), and Lighthouses contribute circles with tier-dependent radii (`LIGHTHOUSE_VISION_RADII` in `lighthouse.ts`). Cyan halo (`VISION_BLUE = 0x7dd3e8`, derived from `COLOR.accent`).
- `'discovered'` — discovered, outside vision. Steel-blue halo (`DISCOVERED_BLUE = 0x2d5878`). The **island itself stays full-opacity**; the surrounding ocean colour tier is the sole indicator that vision isn't current. Don't reintroduce alpha/tint dimming on discovered islands — it makes the ocean bleed through and reads as "ocean overlays the island".
- `'unknown'` — not discovered. Page background (`UNKNOWN_BLUE`, derived from `COLOR.void` in `ui-tokens.ts`) shows through; `renderIsland` returns `null` for these.

Rendered as layered radial-gradient sprites with a 24px AA-band edge fade, ordered: unknown rect → discovery sprites → vision sprites → islands.

### Economy: event-driven piecewise integration

`advanceIsland(state, nowMs)` in `economy.ts` implements §15.3 exactly. The loop:

1. `computeRates` — four passes plus a **pass 2.5**, to handle producer→consumer flow-through and power correctly. Pass 1 computes tentative base rates; **pass 2.5 runs the exact net-flow solver** (`flow-solver.ts`, pure leaf module): it returns a per-building gate `g ∈ [0,1]` so producers at a full bin and consumers at an empty bin rescale continuously to the live flows across the bin (shared θ/φ per resource, min rule per building) — superseding the old binary output stall. Pass 2 still computes `inputAvail` (now only the pass-3 power probe for `baseRate === 0` buildings). Pass 3 applies the power balance — every island in a connected network component shares one brownout factor `min(1, producedTotal / consumedTotal)`; pass 4 derives the final effective rates and each `BuildingRate.utilization` (the dynamic duty cycle: solver gate × power × heat × adjacency, excluding the maintenance factor). **Don't replace the flow solver with binary stock checks** — the continuous gate is what stops the +0/+0.01 flicker at a pinned bin and keeps production chains correct when `inv == 0` but a sibling supplies in real time.
2. `findNextCapEvent` — next moment any inventory hits 0 or a cap (pinned bins run at net 0 ⇒ no event).
3. Integrate `[t, nextEvent]` with constant rates, accrue XP from **production** (not net), accrue wear as `dt × BuildingRate.utilization` (duty-cycle, not wall-clock — an idle building at a full bin doesn't wear), `levelUpIfReady`.
4. Repeat until `t >= nowMs`.

Same loop handles 1 frame and a 24-hour offline catchup. XP weights are tier-based per §9.1 (T0=1, T1=3, T2=10) and live in `recipes.ts`.

The client advances the economy at 5 Hz, not per render frame: `main.ts`'s ticker gates the advance block on `shouldTick` from `economy-clock.ts` (`ECONOMY_TICK_MS = 200` — the named server-migration seam, see TODO.md), which is safe because the integrator is cadence-agnostic; the HUD/inspector render every frame from the last tick's retained outputs.

### Input — every key goes through the registry

`input.ts` keeps two tables: `actions` (name → handler) and `bindings` (`KeyboardEvent.code` → action name). Use `KeyboardEvent.code` for layout-independence. **No hardcoded `e.code === 'KeyW'` checks anywhere outside `input.ts`** — define an action, bind a key, dispatch via `dispatchKey`. UI buttons reuse the same dispatcher (`dispatchAction`), so keyboard and mouse paths can never drift.

Default bindings (~26 — the `bind()` calls in `input.ts` are the authoritative list): WASD/Arrows pan, +/- zoom, H center-home, G toggle-grid, T rotate-placement, Escape dismiss-modal, plus a toggle key per UI panel (B buildings, C construction, I inventory, J drones, K skill tree, N skill graph, O orbital, R routes, S settings, V settlement, Y graph).

### TypeScript discipline

`tsconfig.json` has `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`. New code must compile clean under these. Helpers like `inv()` and `cap()` in `economy.ts` exist to centralise the `?? 0` for indexed reads.

### Persistence migrations — bump = migrate

Every schema bump from v7 onward ships a `migrateV<N>(snapshot) → V<N+1> snapshot` function in `src/persistence.ts`. `loadWorld` walks the migration chain (`migrateV7 → migrateV8 → …`) to bring any supported snapshot up to current. `SUPPORTED_LOAD_VERSIONS` lists every version with a migration path to current.

When you bump the schema:
1. Add a `SerializedSnapshotV<N>` type alias capturing the previous shape (so the migration's input type is precise, not `any`).
2. Add `migrateV<N>toV<N+1>(s: SerializedSnapshotV<N>): SerializedSnapshotV<N+1>` returning a structurally-valid next-version snapshot. Field defaults that preserve "old save still works" semantics belong here.
3. Wire the migration into `loadWorld`'s version-dispatch path.
4. Add `N` to `SUPPORTED_LOAD_VERSIONS`.
5. Tests: v<N> fixture loads cleanly into v<N+1>; v<N+1> round-trips identity; any field defaults are exercised explicitly.

The 1d8c4bd refactor that dropped legacy migrations was a **one-time pre-release cleanup**. v6 → v7 (commit `323feff`) was the last fail-fast bump under the old policy. From v7 → v8 onward: bump = migrate.

### One responsibility per file

`src/` holds ~100 production files plus ~85 colocated `*.test.ts` files — one mechanic or system per file. Conventions: pure system modules are named for the mechanic (`drones.ts`, `weather.ts`, `island-merge.ts`, `tier-reset.ts`, …); DOM/Pixi panels end in `-ui.ts`; map overlays end in `-overlay.ts`; tests sit next to the module they cover. Put a new mechanic in its own file rather than growing an existing one.

## Build status vs SPEC §15.7

All content steps of the §15.7 build order (1–13, through T5 transcendent content) are implemented and merged on `master`: placement (`placement.ts`, `shape-mask.ts`, `adjacency.ts`), power + brownouts (economy pass 3, `heat.ts`, `battery-ladder`), skill tree, world gen + drones + discovery, inter-island routes, biomes + weather, tier breakpoints, Network Consciousness, artificial islands + land reclamation, and the T4/T5 endgame (`endgame.ts`, `orbital.ts`, `lattice.ts`) — plus systems not named in the step list (tutorial, trade, day/night, island merging, universe editor). Current work is **step 14: polish, balance, and bug sweeps** (see recent git history and `docs/` reports).

Appendix B deferred features (prestige, mechanical/steam power, blueprints, multi-device sync, localization) remain unimplemented **by design** — don't add them without a spec update.
