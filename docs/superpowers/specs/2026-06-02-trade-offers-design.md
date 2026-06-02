# Trade Offers — design spec

> **Format note:** The canonical human-facing version of this spec is the
> sibling `2026-06-02-trade-offers-design.html` (published to docs-hub). This
> `.md` is the agent-consumable companion for the `writing-plans` step.

**Branch:** `feat/trade-offers` · **Date:** 2026-06-02 · **Next step:** writing-plans

## Context

robot-islands is a keep-it-open idle game whose reward cadence runs on the scale
of hours-long tier climbs, leaving nothing to *do* minute-to-minute. Trade Offers
add a short-cadence decision loop: a cheap building periodically surfaces an
expiring barter offer biased toward dumping overflow stock for an under-stocked
resource.

## Decision

A cheap **T1 "Signal Exchange"** building surfaces periodic, **online-only,
expiring** barter offers — biased to dump your fullest stock for your emptiest
**ever-produced** resource, priced at **fair per-unit XP-weight value** modulated
by a **tier-distance spread** (`0.8^Δtier`).

- **Why:** self-correcting inventory pressure-valve (a capped resource stalls its
  producer and earns zero XP per §9.1) + the seconds-scale decision loop the game
  lacks. Chain-skipping is foreclosed at the root by the ever-produced output
  filter: you can only receive a resource you already make.
- **Deliberately not done:** trades grant **no XP** (progression stays
  production-only); offers are **not persisted** (ephemeral, excluded from offline
  replay); no cross-island or multi-party trading.

## Background & motivation

- The world advances on a live per-frame ticker (visually alive when watched), but
  its reward cadence is hours-long. Trade Offers supply a minute-to-minute reason
  to be present.
- **Cap-stall relief:** per §9.1 a resource at its storage cap halts its producer
  and earns zero XP; an offer that dumps overflow relieves that.
- **Online-only** preserves offline parity (§15.5): an absent player just misses
  optional offers; the base simulation is unchanged.
- **Valuation basis (verified):** a per-unit analysis of the live recipe table
  found the realized XP-weight multiplier across tier-up recipes is **median
  ≈ 3.20 / tier**, matching the §9.1 ladder (1, 3, 10, 30, 100, 300, 1000 ≈
  3.16×/tier). Pricing a swap at the per-unit weight ratio is therefore fair value.
  Quantity, not per-unit price, is where exploits live — hence the size cap and the
  ever-produced gate.

## Why these rules (rejected vs chosen)

**Rejected — naive value-neutral trades**
- Pricing purely on `xp_weight` lets a full silo of T0 bulk convert into hundreds
  of endgame components.
- A tier-distance cap alone is blunt and unrelated to actual progress.
- A flat `0.8`/tier tax barely dents the ≈3.16×/tier ramp — far trades stay favorable.
- Granting XP on swaps turns trading into a leveling printer.

**Chosen — ever-produced + per-unit + spread**
- **Ever-produced output filter:** you can only receive a resource you already
  make → trades never shortcut a chain, and the eligible pool self-scales with
  progression.
- **Per-unit weight-ratio pricing** is fair value, verified against the recipe table.
- **Rolled spread centered on `0.8^Δtier`** is the deal-quality signal — near-tier
  favorable, far-tier lossy — making each offer a judgment call that averages
  ≈ neutral.
- **No XP:** progression stays production-only.

## The offer algorithm

Per Signal-Exchange island, when its spawn timer fires (online time only):

1. **Build pools (per island).** *Give pool* = resources with `inv > 0`. *Get pool*
   = resources in `everProduced` (regardless of current inventory). Fill% =
   `inv / cap`; treat `cap == 0 && inv > 0` as ≥100% (prime to dump); exclude
   `inv == 0 && cap == 0`.
2. **Bias-sample.** Give: roll `k = 2` from the give pool, keep the **higher**
   fill%. Get: roll `k = 2` from the get pool, keep the **lower** fill%. Resample
   if `get == give`. Higher `k` (skill) sharpens the bias.
3. **Tier gate.** Reject and resample if `Δtier = |tier(get) − tier(give)|`
   exceeds the reach (base 2, skill 3–4). Tier is read from `XP_WEIGHT` via the
   §9.1 ladder.
4. **Price.** Baseline output-per-input = `weight[give] / weight[get]` (fair per
   unit). Multiply by a rolled spread centered on `0.8^Δtier` with variance.
5. **Size.** `giveQty = min(sizePct · inv[give], headroomLimit)` where the output
   is clamped to `getQty ≤ cap[get] − inv[get]`; whichever side binds, back-compute
   the other so the swap is exact.
6. **Emit** a `TradeOffer` with `spawnedAt` / `expiresAt`.

**Acceptance.** On accept, re-clamp against current `inv[give]` and current
headroom (production may have moved stock since spawn), then instantly subtract
`giveQty` and add `getQty`. The offer is consumed. **No XP granted.**

**Lifecycle.** The spawn timer advances only while the tab is focused
(`visibilityState === 'visible'`). One active offer per island (skill may allow a
small queue). On accept or expiry the slot frees; the next spawns after the
cadence. Offers are runtime-only and never persisted.

**Surface.** Detailed offer card on the active island (if it has a Signal
Exchange) + a global badge "N offers waiting elsewhere".

## Tuning constants & skill nodes

All placeholders; skill nodes live as a cluster in **Logistics → Network**.

| Knob | Base default | Skill-tuned to | Effect kind |
|---|---|---|---|
| Cadence | 1 offer / 2 h online | more frequent | `tradeOfferFrequencyMul` |
| Expiry | 5 min | (fixed) | — |
| Bias k | 2 | 3+ | `tradeBiasKAdd` |
| Tier reach Δ | 2 | 3–4 | `tradeReachAdd` |
| Size % | 10% of give-stock | higher | `tradeSizeMul` |
| Spread center | `0.8^Δtier` | shift favorable | `tradeSpreadShift` |
| Concurrency | 1 active / island | small queue | `tradeQueueAdd` (opt.) |

## Change inventory

Pure-layer logic stays free of PixiJS, per the repo's pure/render split.

- **`src/trade.ts`** *(NEW, pure)* — `TradeOffer` type,
  `generateOffer(islandState, rng) → TradeOffer | null`, `applyOffer(islandState,
  offer)`. No PixiJS; fully unit-testable.
- **`src/trade-ui.ts`** *(NEW, render)* — DOM overlay: active-island offer card +
  global "N waiting" badge + countdown, in the existing vanilla-DOM idiom.
- **`src/economy.ts` & `src/world.ts`** — add `everProduced: Set<ResourceId>` to
  `IslandState`; set the flag where inventory first goes positive in
  `advanceIsland` (one-liner).
- **`src/building-defs.ts` & `src/buildings.ts`** — `signal_exchange` catalog row:
  Logistics, T1, 1×1, cheap cost (≈ a Crate), no recipe, no power (so no §4.7
  maintenance accrual).
- **`src/skilltree-catalog.ts` & `src/skilltree.ts`** — 3–4 notables in Logistics →
  Network (frequency, reach, size, spread); new effect kinds + aggregation + hover
  formatter. `skilltree-budget.test.ts` (≤23 nodes/sub-path) must still pass.
- **`src/persistence.ts`** — schema bump + migration: add `everProduced`, default
  it to the keys of current inventory via `migrateV18toV19`. Master is at
  `SCHEMA_VERSION = 18` (building-overhaul already landed), so this is a **v18 → v19**
  bump. Follow the bump=migrate discipline (`SerializedSnapshotV18` alias, migration
  fn, wire into `loadWorld`, add 19 to `SUPPORTED_LOAD_VERSIONS`). Offers are not
  serialized.
- **`src/main.ts`** — drive spawn/expiry timers on online-focused time; mount the
  trade-ui overlay.

## Verification

Pure-layer tests in `src/trade.test.ts` + a migration test; render layer manual.

- **Ever-produced gate:** `generateOffer` never outputs a resource absent from
  `everProduced`; never gives a resource with `inv == 0`.
- **Bias direction:** over many rolls, give skews high fill%, get skews low fill%.
- **Tier reach:** no emitted offer exceeds configured Δtier; raising reach widens it.
- **Size + headroom:** `giveQty ≤ sizePct·stock` and `getQty ≤ output headroom`,
  swap exact at the binding constraint.
- **Pricing:** output/input ≈ `weight[give]/weight[get]` × spread; spread center
  tracks `0.8^Δtier`.
- **Accept semantics:** `applyOffer` shifts inventory exactly, grants zero XP,
  re-clamps if stock changed since spawn.
- **Migration:** v18 fixture loads into v19 with `everProduced` defaulted to
  inventory keys; v19 round-trips identity.
- **Budget guard:** `skilltree-budget.test.ts` still passes after the node cluster.
- **Manual:** build a Signal Exchange, fast-forward the spawn timer (test hook),
  accept an offer, confirm inventory shifts and the badge updates.

## Risks

| Risk | Sev | Mitigation |
|---|---|---|
| Residual marginal-cost skip (convert overflow into extra units of something you already make) | LOW | Per-unit fair pricing + size cap + zero XP → logistics convenience, not a break; only amplifies production you're already set up for. |
| Online-only timer mis-wired so hidden-tab time counts (ticker throttles when hidden) | MED | Gate spawn timer strictly on `visibilityState === 'visible'`; focus/blur test of timer advancement. |
| Migration correctness for the `v18 → v19` bump (master already at v18 post building-overhaul) | LOW | Follow bump=migrate discipline: `SerializedSnapshotV18` alias, `migrateV18toV19`, wire into `loadWorld`, add 19 to `SUPPORTED_LOAD_VERSIONS`, round-trip test. |
| `everProduced` unbounded growth | LOW | Set of resource ids, bounded by the catalog (≈250); negligible save size. |

## Out of scope

- **Cross-island / pooled offers** — offers are per-island; network-wide combined
  offers are a later idea.
- **Multi-party / faction trading** — no backend; anonymous barter
  (scavenger-network fiction), no real counterparties.
- **Offer persistence across reload** — ephemeral by design.
  > **Amended 2026-06-02 (trade-persist-compounding):** offers remain ephemeral,
  > but the spawn *cadence* is now persisted per island as an online-time
  > cooldown — see `2026-06-02-trade-persist-compounding-design`. The original
  > ephemeral-cadence behavior was the source of a refresh-farm exploit.
- **Auto-accept / automation** — acceptance is the engagement point; automation
  would defeat it.
