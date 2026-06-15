import { makeSeededRng } from './rng.js';
import { XP_WEIGHT, type ResourceId } from './recipes.js';
import { inv, cap, type IslandState } from './economy.js';
import type { PlacedBuilding } from './buildings.js';
import type { SkillMultipliers } from './skilltree.js';

export interface TradeOffer {
  readonly id: string;
  readonly islandId: string;
  readonly give: { readonly res: ResourceId; readonly qty: number };
  readonly get: { readonly res: ResourceId; readonly qty: number };
  readonly spawnedAt: number;
  readonly expiresAt: number;
}

export interface TradeTuning {
  readonly biasK: number;       // candidates rolled per side (take higher/lower fill)
  readonly maxReach: number;    // max |Δtier| between give and get
  readonly sizePct: number;     // fraction of give-stock an offer may move
  readonly spreadShift: number; // additive favorability on the spread center
  readonly cadenceMs: number;   // spawn interval per island (online time)
  readonly expiryMs: number;    // offer lifetime before it lapses
}

export const DEFAULT_TRADE_TUNING: TradeTuning = {
  biasK: 2,
  maxReach: 2,
  sizePct: 0.10,
  spreadShift: 0,
  cadenceMs: 2 * 60 * 60 * 1000, // 2 hours
  expiryMs: 5 * 60 * 1000,       // 5 minutes
};

/** Minimum effective cadence (ms). The compounding accept-speedup can't drive
 *  offers below this, keeping the loop fast-but-bounded so it can't soft-reopen
 *  the refresh farm. ~1 minute. */
export const FLOOR_MS = 60_000;

/** Max online time (ms) credited to a cooldown in a single tick. The caller
 *  passes `min(frameElapsedMs, ONLINE_DT_CAP_MS)` so a long unfocused gap can't
 *  dump hours into the countdown on the first focused frame. */
export const ONLINE_DT_CAP_MS = 3_000;

/** Effective per-island cadence: the base cadence compounded 1% faster per
 *  accepted trade (`0.99^acceptCount`), floored at `FLOOR_MS`. Pure on numbers
 *  so both the ticker and the accept handler can reuse it. */
export function effectiveCadenceMs(acceptCount: number, baseCadenceMs: number): number {
  return Math.max(FLOOR_MS, baseCadenceMs * Math.pow(0.99, acceptCount));
}

const TIER_LADDER = [1, 3, 10, 30, 100, 300, 1000];

/** Resource tier from the XP-weight ladder (1,3,10,30,100,300,1000 -> T0..T6). */
export function tierOf(res: ResourceId): number {
  const w = XP_WEIGHT[res] ?? 1;
  let best = 0, bestDist = Infinity;
  for (let t = 0; t < TIER_LADDER.length; t++) {
    const d = Math.abs(TIER_LADDER[t]! - w);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

/** Fill fraction for ranking. cap 0 with stock > 0 reads as fully overflowing. */
function fillPct(state: IslandState, res: ResourceId): number {
  const c = cap(state, res);
  const i = inv(state, res);
  if (c <= 0) return i > 0 ? 1 : 0;
  return Math.min(1, i / c);
}

/** Roll k candidates from pool; keep highest (dir=1) or lowest (dir=-1) fill%. */
function biasPick(
  pool: ResourceId[],
  state: IslandState,
  rng: () => number,
  k: number,
  dir: 1 | -1,
): ResourceId {
  let chosen = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!;
  let chosenFill = fillPct(state, chosen);
  for (let r = 1; r < k; r++) {
    const cand = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!;
    const f = fillPct(state, cand);
    if (dir === 1 ? f > chosenFill : f < chosenFill) { chosen = cand; chosenFill = f; }
  }
  return chosen;
}

/** Output-per-input multiplier: fair per-unit weight ratio x a rolled spread
 *  centered on 0.8^Δtier (deal quality) plus the tuning favorability shift. */
function priceMultiplier(give: ResourceId, get: ResourceId, rng: () => number, tuning: TradeTuning): number {
  const wGive = XP_WEIGHT[give] ?? 1;
  const wGet = XP_WEIGHT[get] ?? 1;
  const dTier = Math.abs(tierOf(get) - tierOf(give));
  const center = Math.pow(0.8, dTier) + tuning.spreadShift;
  const variance = 0.25;
  const spread = center * (1 + (rng() - 0.5) * 2 * variance);
  return (wGive / wGet) * Math.max(0.05, spread);
}

/** Generate one trade offer for an island, or null if no valid pair exists. */
export function generateOffer(
  state: IslandState,
  rngOrSeed: (() => number) | string,
  tuning: TradeTuning,
  nowMs: number,
): TradeOffer | null {
  // Deterministic per-offer seeding:
  //   seed = `${worldSeed}_trade_${islandId}_${reactionCount}`
  // Refresh mid-offer → same seed + same persisted count → same offer regenerates
  // (the count is only ever changed at resolution, never while an offer is live).
  // Accept or manual reject → count bumps → genuinely new offer next cycle.
  // Timeout → count resets to 0 → next offer regenerates from the base-count seed.
  // Live inventory / everProduced still influence the give/get pool, so extreme
  // inventory drift can still alter terms. The offer's expiresAt/spawnedAt stay
  // runtime (a reload restarts the 5-minute window — acceptable).
  const rng = typeof rngOrSeed === 'string'
    ? makeSeededRng(`${rngOrSeed}_trade_${state.id}_${state.tradeAcceptCount}`)
    : rngOrSeed;
  const givePool = (Object.keys(state.inventory) as ResourceId[]).filter((r) => inv(state, r) > 0);
  const getPool = [...state.everProduced];
  if (givePool.length === 0 || getPool.length === 0) return null;

  for (let attempt = 0; attempt < 12; attempt++) {
    let give = biasPick(givePool, state, rng, tuning.biasK, 1);
    const get = biasPick(getPool, state, rng, tuning.biasK, -1);
    // collision: fall back to first distinct give candidate (bias skipped for this attempt)
    if (give === get) {
      const alt = givePool.find((r) => r !== get);
      if (!alt) continue;
      give = alt;
    }
    if (Math.abs(tierOf(get) - tierOf(give)) > tuning.maxReach) continue;

    const giveByStock = inv(state, give) * tuning.sizePct;
    const mult = priceMultiplier(give, get, rng, tuning);
    const headroom = Math.max(0, cap(state, get) - inv(state, get));
    let getQty = giveByStock * mult;
    let giveQty = giveByStock;
    if (getQty > headroom) { getQty = headroom; giveQty = mult > 0 ? headroom / mult : 0; }
    if (giveQty <= 0 || getQty <= 0) continue;

    return {
      // Stable, persistence-safe id: one live offer per island at a time, so
      // island + accept-count + wall-clock spawn time uniquely names it. No
      // process-global counter (would collide across a server restart with a
      // persisted offer). The terms are still deterministic from the seed.
      id: `${state.id}-${state.tradeAcceptCount}-${nowMs}`,
      islandId: state.id,
      give: { res: give, qty: giveQty },
      get: { res: get, qty: getQty },
      spawnedAt: nowMs,
      expiresAt: nowMs + tuning.expiryMs,
    };
  }
  return null;
}

/**
 * Apply an accepted offer to the island, mutating inventory in place.
 * Re-clamps against current give-stock and output headroom. Grants NO XP.
 * Returns the amounts actually moved.
 */
export function applyOffer(state: IslandState, offer: TradeOffer): { give: number; get: number } {
  const haveGive = inv(state, offer.give.res);
  const headroom = Math.max(0, cap(state, offer.get.res) - inv(state, offer.get.res));
  const rate = offer.give.qty > 0 ? offer.get.qty / offer.give.qty : 0;
  let giveQty = Math.min(offer.give.qty, haveGive);
  let getQty = giveQty * rate;
  if (getQty > headroom) { getQty = headroom; giveQty = rate > 0 ? headroom / rate : 0; }
  state.inventory[offer.give.res] = haveGive - giveQty;
  state.inventory[offer.get.res] = inv(state, offer.get.res) + getQty;
  return { give: giveQty, get: getQty };
}


export interface TradeRuntime {
  offers: TradeOffer[]; // active offers (runtime-only, never persisted)
}

export function islandHasSignalExchange(state: IslandState): boolean {
  return state.buildings.some((b: PlacedBuilding) => b.defId === 'signal_exchange');
}

/** Resolve a per-island `TradeTuning` from that island's skill multipliers.
 *  Logistics-Network notables tune frequency/size/reach/spread; the
 *  `Math.max(1, …)` guards keep multipliers from ever WORSENING the base
 *  tuning (identity multipliers are 1, additives 0). */
export function tuningFor(mult: SkillMultipliers): TradeTuning {
  return {
    ...DEFAULT_TRADE_TUNING,
    cadenceMs: DEFAULT_TRADE_TUNING.cadenceMs / Math.max(1, mult.tradeFrequencyMul),
    sizePct: DEFAULT_TRADE_TUNING.sizePct * Math.max(1, mult.tradeSizeMul),
    // Floor reach at 0 so a (future) negative reach node can't silently block
    // all offers — generateOffer rejects any pair when |Δtier| > maxReach.
    maxReach: Math.max(0, DEFAULT_TRADE_TUNING.maxReach + Math.round(mult.tradeReachAdd)),
    spreadShift: DEFAULT_TRADE_TUNING.spreadShift + mult.tradeSpreadShiftAdd,
  };
}

/**
 * Advance offer spawning/expiry. `nowMs` (a `performance.now()` value) stamps
 * ephemeral offer `spawnedAt`/`expiresAt`; `onlineDtMs` is the capped online
 * time elapsed this frame (0 when the tab isn't visible+focused) and is what
 * burns down each island's persisted `tradeCooldownMs`. The cadence gate thus
 * lives in persisted island state, not in ephemeral runtime — refresh-proof.
 * Mutates `rt` and each island's `tradeCooldownMs`.
 */
export function tickTradeOffers(
  rt: TradeRuntime,
  islandStates: ReadonlyMap<string, IslandState>,
  worldSeed: string,
  tuningFor: (state: IslandState) => TradeTuning,
  nowMs: number,
  onlineDtMs: number,
): void {
  // 1. prune expired offers. A timeout is a LAPSE, not a reaction: it resets the
  //    island's compounding `tradeAcceptCount` to 0 (the accumulated 0.99^count
  //    speedup is forfeited), then resets the cooldown to the now-base cadence to
  //    start the next wait. (Accept/manual-reject, by contrast, INCREMENT the
  //    count — that lives in the UI handlers.) Track which islands just expired
  //    so step 2 doesn't also decrement their freshly-reset cooldown this tick.
  const live: TradeOffer[] = [];
  const justExpired = new Set<string>();
  for (const o of rt.offers) {
    if (o.expiresAt > nowMs) { live.push(o); continue; }
    const st = islandStates.get(o.islandId);
    if (st) {
      st.tradeAcceptCount = 0;
      st.tradeCooldownMs = effectiveCadenceMs(st.tradeAcceptCount, tuningFor(st).cadenceMs);
      justExpired.add(o.islandId);
    }
  }
  rt.offers = live;

  // 2. for each eligible island with no active offer: burn the online-time
  //    cooldown, spawn when it reaches 0. Cooldown is NOT touched at spawn —
  //    it's reset only on resolution (accept/expiry), so an accept's increment
  //    lands on the very next offer. Islands whose offer just expired this tick
  //    skip decrement — their cooldown was just set fresh.
  for (const [id, state] of islandStates) {
    if (!islandHasSignalExchange(state)) continue;
    if (rt.offers.some((o) => o.islandId === id)) continue;
    if (justExpired.has(id)) continue;
    state.tradeCooldownMs = Math.max(0, state.tradeCooldownMs - onlineDtMs);
    if (state.tradeCooldownMs > 0) continue;
    const tuning = tuningFor(state);
    const offer = generateOffer(state, worldSeed, tuning, nowMs);
    if (offer) rt.offers.push(offer);
  }
}
