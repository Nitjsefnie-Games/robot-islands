# AGENTS.md

This file provides guidance to coding agents working with code in this repository.

## Stack

Vite 5 + TypeScript strict + PixiJS 8 + vitest. No React, no backend. Pure client-side per `SPEC.md` §15.6.

## Commands

```bash
npm run dev        # vite dev server on 0.0.0.0:5173 (HMR-enabled)
npm run build      # tsc -b && vite build
npm run preview    # serve dist/
npm test           # vitest run (one-shot, all tests)

# single test file
npx vitest run src/economy.test.ts

# single test by name
npx vitest run -t "Mine fills iron_ore to exactly cap"
```

## Dev server — serves built `dist/` (vite preview, no HMR)

A systemd unit `robot-islands-dev.service` runs `vite preview --host 0.0.0.0 --port 5173` on port 5173 and is reverse-proxied to `https://islands.nitjsefni.eu/`. It serves the static built bundle from `dist/` — **no HMR**. The browser only sees source changes after a fresh `npm run build` AND a manual page reload (HMR was leaving the tab in a half-applied broken-import state during multi-file edits; preview is the stable alternative). **Do NOT restart the service for code changes** — restart only when `vite.config.ts` or `package.json` deps change. For visual smoke-tests, the page is open in the user's browser via the Daedalus Chrome extension; `mcp__daedalus__screenshot` against the active tab is the standard verification path. After editing source you must `npm run build` and reload the browser tab before screenshotting — the live tab is stale until then.

## Source of truth

- `SPEC.md` (~1800 lines) is the locked specification — iterated under `hypothesize-prove-loop` before implementation. When adding or changing a mechanic, find the relevant § and align with it. The build order is §15.7.
- `CONTRIBUTING.md` defines **two integration tracks** plus a **linear history**: quick fixes (small, low-risk, self-contained) commit directly to `master`; full new features and massive/risky fixes go on a feature branch cut from `master`, reviewed via PR, then rebased and fast-forwarded. Either way `master` stays green and linear — integrate by rebasing and fast-forwarding, never merge commits. Repo-local git config has `pull.rebase=true` and `merge.ff=only`.

## Architecture

The codebase strictly separates **pure math** from **PixiJS rendering** so the simulation is testable without a renderer:

- **Pure layer** (no PixiJS imports): the large majority of `src/` (~80 of ~100 production files) — all game systems (`economy.ts`, `recipes.ts`, `placement.ts`, `drones.ts`, `routes.ts`, the `skilltree-*.ts` family, `vision-source.ts`, …) plus `camera.ts` and `input.ts`.
- **Render layer** (imports `pixi.js`, ~18 files): `main.ts`, `ocean.ts`, `buildings.ts`, `grid.ts`, the `*-ui.ts` panels, the `*-overlay.ts` overlays, `routes-renderer.ts`, `routes-dash-texture.ts`, `skilltree-graphview.ts`. Note `island.ts` and `world.ts` are **mixed**: they import PixiJS for render helpers but also export the pure functions tests target (`tileInscribedInEllipse`, `computeIslandTiles`, `islandRenderState`).

Tests target the pure layer only. Render code is read-only against state.

### Coordinate systems

- **Tile coords** are the unit. Buildings, island geometry, and island centres (`IslandSpec.cx/cy`) are all in tiles.
- **World pixels** = `tile * TILE_PX` (`TILE_PX = 24` in `island.ts`). `tileToWorldPx` converts.
- **Screen pixels** = `world_px * cam.zoom + (cam.tx, cam.ty)`. The `Camera` in `camera.ts` is pure state; `main.ts`'s ticker syncs `world.position`/`world.scale` from it once per frame. `app.renderer.screen.{width,height}` are CSS pixels and match camera units; `renderer.{width,height}` are device pixels (DPR-scaled) — don't mix them.

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

1. `computeRates` — four-pass to handle producer→consumer flow-through and power correctly. Pass 1 computes tentative base rates considering only output caps; pass 2 computes `inputAvail` per recipe using the supply pool from pass 1 (excluding self); pass 3 applies the power balance — every island in a connected network component shares one brownout factor `min(1, producedTotal / consumedTotal)`; pass 4 derives the final effective rates. **Don't simplify pass 2 to "binary on inventory presence"** — it breaks production chains where `inv == 0` but a sibling building supplies in real time.
2. `findNextCapEvent` — next moment any inventory hits 0 or a cap.
3. Integrate `[t, nextEvent]` with constant rates, accrue XP from **production** (not net), `levelUpIfReady`.
4. Repeat until `t >= nowMs`.

Same loop handles 1 frame and a 24-hour offline catchup. XP weights are tier-based per §9.1 (T0=1, T1=3, T2=10) and live in `recipes.ts`.

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
