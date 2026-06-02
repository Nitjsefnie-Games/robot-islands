# Trade — persisted cadence + compounding speedup — design spec

> **Format note:** The canonical human-facing version is the sibling
> `2026-06-02-trade-persist-compounding-design.html` (house style, publishable
> to docs-hub). This `.md` is the agent-consumable companion for the
> `writing-plans` step.

**Branch:** `feat/trade-persist-cadence-compounding` · **Date:** 2026-06-02 ·
**Amends:** `2026-06-02-trade-offers-design` · **Next step:** writing-plans

## Context

The Trade Offers mechanic (Signal Exchange building, online-only expiring barter
offers) shipped with the offer *spawn cadence* held entirely in ephemeral
runtime state (`TradeRuntime.nextSpawnAt`) and keyed on the `performance.now()`
clock. Both facts independently defeat the 2-hour cadence across a page reload:
the map is empty on load **and** `performance.now()` resets to ~0. The result is
an **infinite-trade-via-refresh exploit** — load, accept the immediately-spawned
offer, refresh, repeat — bypassing the cadence entirely.

This spec (a) closes that exploit by persisting the cadence as an online-time
cooldown, keeping offers themselves ephemeral per the original design, and
(b) adds a per-island compounding speedup: each accepted trade makes that
island's next offer arrive 1% sooner.

## Decision

1. **Persisted online-time cooldown.** Replace the ephemeral `performance.now()`
   spawn gate with a per-island `tradeCooldownMs` field in `IslandState`
   (persisted). It counts down only on **online** frames — defined as
   `document.visibilityState === 'visible' && document.hasFocus()` (visible
   covers minimize / other-tab; `hasFocus()` covers another window on top or
   focus loss; "covered but still focused" is not JS-detectable, accepted as the
   limit). Per-frame decrement is capped (`ONLINE_DT_CAP_MS`) so a
   hidden→focused jump can't dump time. Offers stay **ephemeral** (never
   serialized) — refreshing with an offer on screen forfeits it and the
   already-started cooldown runs its course. Exploit closed.

2. **Per-island compounding speedup.** New per-island `tradeAcceptCount` field.
   On accept, increment it; the effective cadence is
   `max(FLOOR_MS, baseCadence × 0.99^tradeAcceptCount)` with `FLOOR_MS = 60_000`
   (~1 min) so the compounding is fast-but-bounded and can't soft-reopen the
   farm.

- **Why floored & per-island:** per-island matches the per-island Signal
  Exchange / cadence / state; the floor keeps an enthusiastic trader from
  driving cadence to near-zero (offers-every-second).
- **Deliberately unchanged:** offers remain ephemeral and grant no XP;
  online-only / offline-parity (§15.5) is preserved (offline time advances
  neither the cooldown nor the accumulator); valuation, bias, size, reach are
  untouched.

## Background & motivation

- The original design (`2026-06-02-trade-offers-design`, Out-of-scope #3) made
  **offers** ephemeral on purpose — fresh offers regenerate on load, kept out of
  the save / offline-replay path. That decision is sound and is **retained**.
- The oversight was that the *spawn timer* was also ephemeral. Ephemeral offers
  are fine; an ephemeral cadence gate is the bug. The fix persists only the gate
  (a single number per island), not the offers.
- Keeping the cooldown in an **online-time** domain (not wall-clock) preserves
  the offline-parity pillar: an absent player neither accrues nor loses cadence
  progress. Wall-clock was rejected because a returning player would get an
  instant offer, softening online-only.

## The cooldown lifecycle

Per Signal-Exchange island, each **online** frame (predicate above), when the
island has **no active offer**:

1. `tradeCooldownMs = max(0, tradeCooldownMs − onlineDtMs)` where
   `onlineDtMs = min(frameElapsedMs, ONLINE_DT_CAP_MS)`.
2. If `tradeCooldownMs <= 0`: `generateOffer(...)`; the offer is pushed to the
   ephemeral runtime list (unchanged generation logic).

When an offer **resolves**:

- **Accepted** (`tradeUi` handler): `tradeAcceptCount += 1`, then
  `tradeCooldownMs = effectiveCadence(state)`, then remove the offer.
- **Expired** (in `tickTradeOffers` prune): `tradeCooldownMs =
  effectiveCadence(state)`.

Resetting the cooldown on *resolution* (not at spawn) makes the accept's
increment land on the very next offer — "every trade you accept makes the next
trade come 1% faster." First offer stays immediate (`tradeCooldownMs` seeds to
0).

`effectiveCadence(state) = max(FLOOR_MS, tuningFor(mults).cadenceMs ×
0.99^state.tradeAcceptCount)`. `tuningFor(...).cadenceMs` already folds in the
Logistics-Network frequency skill multiplier; the accept-speedup stacks on top.

## Change inventory

| File | Change |
|---|---|
| `src/economy.ts` | Add `tradeCooldownMs: number` and `tradeAcceptCount: number` to `IslandState`; seed both to `0` in `makeInitialIslandState`. |
| `src/trade.ts` | Add `effectiveCadence(state)` + `FLOOR_MS`/`ONLINE_DT_CAP_MS` consts. Rework `tickTradeOffers` to take `onlineDtMs` and drive the per-island `tradeCooldownMs` countdown (replacing `nextSpawnAt`); reset cooldown on expiry. Drop `TradeRuntime.nextSpawnAt` (cadence now lives in `IslandState`). |
| `src/main.ts` | Add `isOnline()` (`visibilityState === 'visible' && document.hasFocus()`); compute `onlineDtMs` from the capped frame elapsed and pass it to `tickTradeOffers` (replaces the `!document.hidden` gate). Accept handler: `tradeAcceptCount += 1` then `tradeCooldownMs = effectiveCadence(...)`. |
| `src/persistence.ts` | Schema **v19 → v20**: add `tradeCooldownMs` + `tradeAcceptCount` to `SerializedIslandState`; `migrateV19toV20` backfills both to `0`. Add `SerializedSnapshotV19` alias, bump `SCHEMA_VERSION`, extend `SUPPORTED_LOAD_VERSIONS`, wire into `loadWorld`. (de)serialize the two fields. |
| `src/trade.test.ts` | Cooldown countdown + spawn-at-zero; expiry resets cooldown; `effectiveCadence` compounding + floor; online-gating (no decrement on offline frames). |
| `src/persistence*.test.ts` | v19→v20 migration backfills 0; v20 round-trips identity; field defaults exercised. |
| design docs | This `.md` + `.html`; note the amendment in the original trade-offers doc's Out-of-scope #3 (cadence now persisted; offers still ephemeral). |

## Verification

- **Exploit closed:** with a persisted cooldown, a fresh load reads the
  mid-countdown value; no offer spawns until online time elapses. Spawning an
  offer then "refreshing" forfeits it and does not reset the countdown.
- **Online-gating:** `tickTradeOffers` does not decrement when passed
  `onlineDtMs = 0` (offline / unfocused); a hidden→focused jump decrements by at
  most `ONLINE_DT_CAP_MS`.
- **Compounding + floor:** `effectiveCadence` halves by ~69 accepts, and never
  drops below `FLOOR_MS`.
- **Migration:** a v19 fixture loads into v20 with both fields `0`; v20
  round-trips identity.
- **Full suite + `tsc -b && vite build`** green before PR.

## Risks

| Risk | Sev | Mitigation |
|---|---|---|
| `onlineDtMs` uncapped → a long hidden gap dumps hours into the countdown on the first focused frame, spawning instantly (a different farm). | MED | Cap per-frame `onlineDtMs` at `ONLINE_DT_CAP_MS` (a few seconds); test the hidden→focused jump. |
| Unbounded compounding re-opens the farm (offers every second). | LOW | `FLOOR_MS` floor on `effectiveCadence`; test the floor. |
| v19→v20 migration correctness (bump = migrate discipline). | LOW | `SerializedSnapshotV19` alias, `migrateV19toV20`, wire into `loadWorld`, add 20 to `SUPPORTED_LOAD_VERSIONS`, round-trip test. |
| Removing `nextSpawnAt` from `TradeRuntime` breaks callers/tests referencing it. | LOW | `findReferences` before the edit; update the ticker + trade tests. |

## Out of scope

- **Offer persistence across reload** — still ephemeral by design; only the
  cadence cooldown persists.
- **Tier Reset interaction** — `tradeAcceptCount` is treated as permanent
  engagement (not in §9.7's reset-cleared set). Revisit if it should reset.
- **Global (cross-island) accumulator** — chosen per-island; a world-wide
  accumulator is a later idea.
- **Skill-node integration of the accept-speedup** — the 1%/accept is a flat
  mechanic, not a tunable node, for now.
