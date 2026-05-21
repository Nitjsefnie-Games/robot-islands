# Inventory panel — rolling-average rate display

**Date:** 2026-05-21
**Status:** approved (design)

## Problem

The inventory modal's `Net /s` column shows the *instantaneous* net rate
sourced from the economy's `computeRates` (passed into `refresh` as `net`).
Because the economy is an event-driven piecewise integrator, that rate steps
abruptly whenever a recipe hits an output cap or an input stalls — the number
visibly jumps and is hard to read as "how fast is this stockpile moving".

The `Time to ⤓/⤒` column is derived from the same instantaneous rate, so it
jumps in lockstep.

## Goal

Replace the instantaneous rate with the **average speed over a rolling 5-second
window** — measured from how much the stockpile *actually* changed, not from the
economy's claimed rate.

## Approach — inventory-delta ring buffer

Chosen over (B) time-averaging the economy `net` rate and (C) an exponential
moving average. Approach A measures realized stock movement, so it reads ~0
when a resource is cap-pinned (B would still show the economy's claimed
non-zero rate); the 5s window is exact (C's is a soft time-constant); and it
fully decouples the panel from the economy's `net`.

## Design

All changes are local to `src/inventory-ui.ts` plus one call-site update in
`src/main.ts`.

### Sample buffer

A per-panel array of samples:

```ts
interface RateSample { t: number; inv: Record<ResourceId, number>; }
```

- `t` is `performance.now()` at sample time.
- `inv` is a **copy** of the active island's inventory values (the live
  `IslandState.inventory` is mutated in place by the economy — a reference
  would be useless).
- One sample pushed per `refresh()` call. `refresh()` already early-returns
  when the panel is hidden, so samples accumulate only while the panel is open.

### Pruning

After each push, drop samples older than `now − WINDOW_MS` (`WINDOW_MS = 5000`),
keeping the most recent sample that is *at or past* the window edge so the
window covers a full 5s once warmed up.

### Rate computation

A pure, exported helper:

```ts
averageRate(buffer: RateSample[], nowInv, now): Record<ResourceId, number>
```

For each resource `r`: `rate = (nowInv[r] − oldest.inv[r]) / ((now − oldest.t) / 1000)`.

This `rate` replaces `net[r]` everywhere in `paintRows` — it feeds **both** the
`Net /s` column and the `Time to EMPTY/FULL` column, so the two never disagree.

### Warm-up (panel just opened / island just switched)

Partial-window average — average over whatever history exists. Guard: if
`now − oldest.t < 250ms` or fewer than 2 samples, the rate is reported as `0`
(rendered as `·`). This avoids a divide-by-near-zero single-frame spike. After
~¼ second the value is a real measured number that converges to the full 5s
average.

### Island switch

Track `lastIslandId`. When `getState().id` differs from it, clear the buffer
and reset — a fresh warm-up for the newly-selected island.

### `refresh` signature

The economy's `net` value is no longer used by the panel. Drop the `net`
parameter from `refresh`; update the single call site in `main.ts`
(`inventoryUi.refresh(activeS, net)` → `inventoryUi.refresh(activeS)`).

### Header label

The `Net /s` column header becomes `Net /s (5s avg)` so the column is
self-explanatory. The sort chip label stays `Net /s` (footer space).

## Testing

`averageRate` is pure and unit-tested in a new `src/inventory-ui.test.ts` (or
appended to an existing inventory test file if one exists):

- warm-up guard: `< 2` samples → all-zero; `< 250ms` span → all-zero.
- partial window: 1s of history → rate computed over 1s.
- full window: ≥ 5s of history, oldest sample pruned correctly.
- cap-pinned: stock unchanged across the window → rate `0` even if the economy
  would report non-zero.
- island switch: buffer cleared, rate returns to warm-up state.

## Out of scope

- The HUD (`hud.ts`) rate display — this change is scoped to the inventory
  modal only.
- Configurable window length — fixed 5s constant.
