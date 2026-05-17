# TODO

Snapshot of known unfinished work. Most §1 items have shipped this
sweep; what remains is whatever the section-1 list still calls out.

Organised by category. Within each category, items are ordered roughly by
player-facing impact (highest first). Spec section references are §-numbers
from `SPEC.md`.

---

## 1. Missing mechanics (new systems to build)

These are systems the spec defines but the codebase doesn't implement at
all. Building them requires new state, new tick paths, or new UI surfaces.

---

## 2. Mechanic shipped, no UI to invoke

These have the simulation wired but no player surface to access them.


---

## 3. Mechanic shipped, missing visual indicators

- **§13.4 endgame victory banner** — *intentionally removed* per the
  spec's "no win screen". Listed here so a future contributor doesn't
  re-add it. Not a bug.
- **§14 satellite map dots + coverage rings** — code path live (see
  `satellite-overlay.ts`); reproducible only once the player has at
  least one launched sat. The orbital-ui launch flow + this overlay
  are wired together so any future sat will surface.

---

## 4. Verification gaps (need a live game-state to reproduce)

Each entry below is wired in code but requires a specific game state to
visually reproduce — leave the entry in place so a future contributor
who lands in that state confirms it.

- Cell-snap vision rendering at very high zoom (post smooth→blocky
  rewrite). Verified at default zoom in the live dev server.
- Range ring + reticle color-flip while launch armed (drones-ui
  `setReticleScreenPos` flips RETICLE_OK ↔ RETICLE_WARN inline).
- Tier-reset HUD chip — appears only at T3+ with cooldown clear +
  materials. Visible once a T3 island has the chip's preconditions.

---

## 5. Polish / nice-to-have


---

Maintainer note: when a TODO entry ships, delete its line rather than
striking it through. The list should always represent open work.
