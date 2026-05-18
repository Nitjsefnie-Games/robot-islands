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
- `CONTRIBUTING.md` mandates **linear history**: rebase, never merge. `master` is the integration branch. Repo-local git config has `pull.rebase=true` and `merge.ff=only`.

## Architecture

The codebase strictly separates **pure math** from **PixiJS rendering** so the simulation is testable without a renderer:

- **Pure layer** (no PixiJS imports): `economy.ts`, `recipes.ts`, `camera.ts`, `input.ts`, the geometry functions in `island.ts` (`tileInscribedInEllipse`, `computeIslandTiles`), the classification function in `world.ts` (`islandRenderState`).
- **Render layer** (imports PixiJS): `renderIslandTiles`, `renderBuildings`, `renderIsland`, `renderOcean`, `renderCellGrid`, `hud.ts`, `ui.ts`, `main.ts`.

Tests target the pure layer only. Render code is read-only against state.

### Coordinate systems

- **Tile coords** are the unit. Buildings, island geometry, and island centres (`IslandSpec.cx/cy`) are all in tiles.
- **World pixels** = `tile * TILE_PX` (`TILE_PX = 24` in `island.ts`). `tileToWorldPx` converts.
- **Screen pixels** = `world_px * cam.zoom + (cam.tx, cam.ty)`. The `Camera` in `camera.ts` is pure state; `main.ts`'s ticker syncs `world.position`/`world.scale` from it once per frame. `app.renderer.screen.{width,height}` are CSS pixels and match camera units; `renderer.{width,height}` are device pixels (DPR-scaled) — don't mix them.

### Spec/state separation per island

`IslandSpec` (in `world.ts`) is the static `readonly` definition (terrain function, ellipse, building positions, discovered/populated flags). `IslandState` (in `economy.ts`) is the mutable runtime (inventory, xp, level, lastTick). They reference each other by `id`. `makeInitialIslandState(spec, nowMs)` constructs state from a spec.

### Vision model (three-tier ocean)

Locked-in visual contract — see `world.ts` and `ocean.ts`:

- `'visible'` — populated, OR discovered AND inside a populated island's `VISION_RADIUS_TILES` (= 80). Cyan halo (`VISION_BLUE = 0x7dd3e8`).
- `'discovered'` — discovered, outside vision. Steel-blue halo (`DISCOVERED_BLUE = 0x2d5878`). The **island itself stays full-opacity**; the surrounding ocean colour tier is the sole indicator that vision isn't current. Don't reintroduce alpha/tint dimming on discovered islands — it makes the ocean bleed through and reads as "ocean overlays the island".
- `'unknown'` — not discovered. Page background (`UNKNOWN_BLUE = 0x0a0e14`) shows through; `renderIsland` returns `null` for these.

Rendered as layered radial-gradient sprites with a 24px AA-band edge fade, ordered: unknown rect → discovery sprites → vision sprites → islands.

### Economy: event-driven piecewise integration

`advanceIsland(state, nowMs)` in `economy.ts` implements §15.3 exactly. The loop:

1. `computeRates` — two-pass to handle producer→consumer flow-through correctly. Pass 1 computes tentative rates considering only output caps; pass 2 computes `inputAvail` per recipe using the supply pool from pass 1 (excluding self). **Don't simplify pass 2 to "binary on inventory presence"** — it breaks production chains where `inv == 0` but a sibling building supplies in real time.
2. `findNextCapEvent` — next moment any inventory hits 0 or a cap.
3. Integrate `[t, nextEvent]` with constant rates, accrue XP from **production** (not net), `levelUpIfReady`.
4. Repeat until `t >= nowMs`.

Same loop handles 1 frame and a 24-hour offline catchup. XP weights are tier-based per §9.1 (T0=1, T1=3, T2=10) and live in `recipes.ts`.

### Input — every key goes through the registry

`input.ts` keeps two tables: `actions` (name → handler) and `bindings` (`KeyboardEvent.code` → action name). Use `KeyboardEvent.code` for layout-independence. **No hardcoded `e.code === 'KeyW'` checks anywhere outside `input.ts`** — define an action, bind a key, dispatch via `dispatchKey`. UI buttons reuse the same dispatcher (`dispatchAction`), so keyboard and mouse paths can never drift.

Default bindings: WASD/Arrows pan, +/- zoom, H center-home, G toggle-grid.

### TypeScript discipline

`tsconfig.json` has `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`. New code must compile clean under these. Helpers like `inv()` and `cap()` in `economy.ts` exist to centralise the `?? 0` for indexed reads.

### One responsibility per file

`island.ts` (geometry math) · `world.ts` (multi-island data + state factory) · `economy.ts` (tick loop) · `recipes.ts` (recipe + xp_weight tables) · `camera.ts` · `input.ts` · `ui.ts` (DOM button overlay) · `hud.ts` (DOM economy panel) · `ocean.ts` (vision/fog) · `grid.ts` (debug overlay) · `buildings.ts` (building data + rendering) · `main.ts` (PixiJS bootstrap + wiring).

## Build-order deviation from SPEC §15.7

The spec lists: 1 static island → 2 placement (shape masks/rotation/adjacency) → 3 resources/tick → 4 power → … Step 2 was **repurposed** to camera/map/fog/keybind foundation; placement mechanics remain to be built. Suggest naming the next placement work "step 2.5" rather than re-numbering.

Current state: steps 1, 2 (repurposed), and 3 are merged on `master`. Next likely work: step 4 (power + brownouts), step 2.5 (placement), or polish (biome palettes, click-to-inspect, persisted camera).
