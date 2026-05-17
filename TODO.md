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

---

## 2. Mechanic shipped, no UI to invoke

These have the simulation wired but no player surface to access them.


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


---

Maintainer note: when a TODO entry ships, delete its line rather than
striking it through. The list should always represent open work.
