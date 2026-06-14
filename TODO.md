# TODO

(Prior punch list — audit findings, tuning placeholders, §3.6 merge
rework, code-health notes — dropped 2026-06-10 by owner decision;
recover from git history if ever needed. One open item, below.)

## Current TODO — server-authoritative migration

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
7. **Authentication is in scope** (owner, 2026-06-10): accounts are
   the identity the server keys saves and anti-cheat on.
8. **Import/export save buttons are DROPPED in the migration** (owner,
   2026-06-10): saves live server-side only; client-side save
   import/export contradicts the anti-cheat model. The settings-panel
   buttons and their plumbing go away with §15.6.

Hardening note carried from the perf-audit era: the pervasive
`as unknown as` readonly-mutation casts and the trade/XP paths become
the sensitive trust surface once state crosses a network boundary —
fold into the migration spec.

### Status — IN PROGRESS (2026-06-14): 3 of 5 slices delivered + deployed

Owner said go (2026-06-14). Decomposed into 5 slices; each ran
brainstorm → spec → plan → implement → Opus spec-review + code-review,
committed linearly to `master`. Live on the box as
`robot-islands-auth.service` (127.0.0.1:5180, tsx runtime). Designs +
plans published to docs-hub under `robot-islands/`.

- ✅ **Slice 1 — Auth + user store.** Fastify + Postgres; email+password
  (scrypt), revocable server-side sessions. `users`/`sessions` tables.
- ✅ **Slice 2 — Server runtime + persistence.** Hosts the pure layer;
  `SerializedSnapshot` + the v7→v24 migration chain (note: chain is now
  v7→v24, deserializeWorld migrates internally) move to a Postgres
  `saves` table; offline catch-up via `advanceIsland`. §15.6 annotated
  superseded-for-state-ownership (cutover pending). `src/new-game.ts`
  extracted (pure `createNewGame`).
- ✅ **Slice 3 — Transport + intent protocol.** Authenticated WebSocket
  `/api/game/ws`; `{type,payload,seq}` intent envelope; validation =
  re-running the pure entry fn on authoritative state (anti-cheat);
  no-partial-persist. 30 player intents cataloged, **9 core wired**
  (place/demolish/cancel/upgrade/set-active-floors/dispatch-drone/
  create-route/unlock-skill-node); **accept-trade deferred** (offers are
  runtime-only/unpersisted — needs server-deterministic offers).
- ⏭ **Slice 4 — Client cutover** (NOT started). Rewire the PixiJS client
  (`main.ts` + UI panels) to read the server projection + send intents
  instead of mutating local state. Product/UX decisions outstanding;
  item 8 (drop import/export save buttons) lands here.
- ⏭ **Slice 5 — Trust-surface hardening** (NOT started). Harden the
  `as unknown as` readonly-mutation casts + the trade/XP paths (the
  hardening note above); harden pure fns that currently trust their
  caller (slice-3 handlers added authoritative pre-checks as a stopgap).

Open follow-ups (server-side, no client/product decisions needed):
- Wire the 21 non-core intents (same dispatch pattern as slice 3).
- accept-trade via server-deterministic offers (derive from seed +
  `tradeAcceptCount`, or persist the active offer).
- Pure serialization/world-core seam split (item 6): `persistence.ts`
  pulls render+idb, `world.ts` pulls pixi; server typechecks with a DOM
  lib stopgap until split.
- Set Fastify `trustProxy` + a rate-limit-triggers test once nginx
  fronts the server (do NOT enable trustProxy before the proxy is in
  front — unset X-Forwarded-For is spoofable).
- Typecheck server test files (`server/tsconfig.json` excludes
  `**/*.test.ts`).

Strategic note: a separate **clean-room rewrite** of this whole
migration exists at `/root/islands` (`@ri/*` monorepo — WS protocol
w/ 42 actions, full sim, React client). This in-place port (slices
above) is the alternative path; its service was stopped/disabled on
2026-06-14 per owner. Decide in-place-vs-adopt before slice 4.

Specs/plans: `docs/superpowers/specs/2026-06-1{3,4}-*-slice-design.{md,html}`,
`docs/superpowers/plans/2026-06-1{3,4}-*-slice.md`.

## Balance / recipe sweep — ranked fixes (2026-06-13 inspection)

From a recipe + building-cost inspection (`recipes.ts` RECIPES,
`building-defs.ts` BUILDING_DEFS). Ranked by impact. Each requires the
matching `SPEC.md` § to move in lockstep.

1. `coal_gen` 5 MW → ~1 MW (or 5× its cost) — single biggest balance
   distortion.
2. Alloy mills (carbon/stainless/tool/galvanized steel, bronze, brass,
   solder) → minority alloying ratios + slag byproduct.
3. `lithography_lab` microchip recipe → add real consumables (it's the
   mid-game chokepoint).
4. `geothermal_vent` T1 → raise cost or output, given it's free
   perpetual power + heat.
5. Differentiate the T6 satellite-assembly baskets; raise their
   exotic-input counts.
