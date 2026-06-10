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

Full brainstorm → spec → plan when the owner says go.
