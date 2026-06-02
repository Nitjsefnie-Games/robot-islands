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

// process-local id counter; offers are ephemeral/runtime-only (never persisted), so reset-per-process is fine
let _offerSeq = 0;

/** Generate one trade offer for an island, or null if no valid pair exists. */
export function generateOffer(
  state: IslandState,
  rng: () => number,
  tuning: TradeTuning,
  nowMs: number,
): TradeOffer | null {
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
      id: `offer-${++_offerSeq}`,
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
  offers: TradeOffer[];                 // active offers (runtime-only, never persisted)
  nextSpawnAt: Map<string, number>;     // islandId -> earliest next spawn (ms)
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
    maxReach: DEFAULT_TRADE_TUNING.maxReach + Math.round(mult.tradeReachAdd),
    spreadShift: DEFAULT_TRADE_TUNING.spreadShift + mult.tradeSpreadShiftAdd,
  };
}

/**
 * Advance offer spawning/expiry. Pure given (rng, nowMs); the caller invokes this
 * ONLY while the tab is visible, so spawns accrue on online time only. Mutates `rt`.
 */
export function tickTradeOffers(
  rt: TradeRuntime,
  islandStates: ReadonlyMap<string, IslandState>,
  rng: () => number,
  tuningFor: (state: IslandState) => TradeTuning,
  nowMs: number,
): void {
  // 1. prune expired
  rt.offers = rt.offers.filter((o) => o.expiresAt > nowMs);

  // 2. spawn for eligible islands with no active offer and cadence elapsed.
  // NOTE: `nextSpawnAt` entries are intentionally never pruned — island count
  // is bounded, and a rebuilt signal exchange on the same island id reuses its
  // elapsed entry (not a leak).
  for (const [id, state] of islandStates) {
    if (!islandHasSignalExchange(state)) continue;
    if (rt.offers.some((o) => o.islandId === id)) continue;
    const due = rt.nextSpawnAt.get(id) ?? 0;
    if (nowMs < due) continue;
    const tuning = tuningFor(state);
    const offer = generateOffer(state, rng, tuning, nowMs);
    if (offer) rt.offers.push(offer);
    rt.nextSpawnAt.set(id, nowMs + tuning.cadenceMs);
  }
}
