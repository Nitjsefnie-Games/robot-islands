// DOM HUD overlay for the live island economy state.
//
// Phase 3 rebuild: all chrome uses `.ri-*` classes from `ui.css`. Only runtime
// values (meter `--ri-meter-pct`, `data-tone` attributes) are set inline.
// The panel mounts in zone BR via `ui-zones.ts`; the multi-island bar is
// extracted to `mountIslandBar` in zone TC.

import { activeBonusMul } from './active-bonus.js';
import { BIOME_DEFS, MODIFIER_DEFS } from './biomes.js';
import { BUILDING_DEFS, type BuildingCategory, type BuildingDefId } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import { nextSunEvent, realPhaseName, solarMultiplier, type DayPhase } from './daynight.js';
import { cap, inv, type IslandState, type PowerBalance, xpForLevel } from './economy.js';
import { fmtPower } from './format.js';
import { dispatchAction, type InputRegistry } from './input.js';
import type { NetworkConsciousnessState } from './network-consciousness.js';
import {
  RATE_WINDOW_MS,
  averageRate,
  pruneRateBuffer,
  snapshotInventory,
  type RateSample,
} from './rate-history.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { effectiveIslandTier, hasPickableSkill, type Tier } from './skilltree.js';
import { islandHasSignalExchange } from './trade.js';
import { canTierReset } from './tier-reset.js';
import { toDisplayName } from './ui-tokens.js';
import { mountPanel, Zone } from './ui-zones.js';
import type { IslandSpec, WorldState } from './world.js';


/**
 * Mounts a fixed-position panel and returns an `update` function. Calling
 * `update(state, net, power, …)` refreshes the panel's contents to match the
 * given state (retained DOM: structure rebuilds only when a row-set signature
 * changes; otherwise only changed values are written).
 * The `net` argument carries per-resource net production rate
 * (units/sec), consumed by the alarms section. The `power` argument carries
 * the §5.1 electrical balance; `factor` colour-codes brownout severity.
 */
export interface HudHandle {
  readonly el: HTMLDivElement;
  /** Per-frame refresh. `saveAgeSec` is the integer seconds since the last
   *  successful save (`null` if no save has happened yet this session).
   *  `vehiclesEnRoute` (§12) is the count of in-flight settlement vehicles. */
  update(
    state: IslandState,
    net: Record<ResourceId, number>,
    power: PowerBalance,
    spec: IslandSpec,
    ncState: NetworkConsciousnessState,
    saveAgeSec: number | null,
    vehiclesEnRoute: number,
    activeIslandId: string,
    islandPower: Map<string, PowerBalance>,
  ): void;
}

// Tier-breakpoint thresholds, mirroring `tierForLevel` in skilltree.ts.
const NEXT_TIER_LEVEL: Readonly<Record<Tier, number>> = {
  1: 5,
  2: 15,
  3: 30,
  4: 50,
  5: Number.POSITIVE_INFINITY,
  6: Number.POSITIVE_INFINITY,
};

const PHASE_LABEL: Readonly<Record<DayPhase, string>> = {
  dawn: 'Dawn',
  day: 'Day',
  dusk: 'Dusk',
  night: 'Night',
};

/** Compact "7h12m" / "12m" / "<1m" countdown for the day-phase readout. */
function formatCountdown(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Display label for a BuildingCategory, used by the HUD's per-category
 * enumeration. The mapping is a tight 1:1 rename of the canonical category
 * ids: `extraction → Extract`, `smelting → Refine`, the rest title-cased.
 */
export const CATEGORY_HUD_LABEL: Readonly<Record<BuildingCategory, string>> = {
  extraction: 'Extract',
  smelting: 'Refine',
  chemistry: 'Chemistry',
  manufacturing: 'Manufacturing',
  electronics: 'Electronics',
  power: 'Power',
  storage: 'Storage',
  logistics: 'Logistics',
  special: 'Special',
  cooling: 'Cooling',
  production: 'Production',
};

/** HUD display order for category rows. Categories absent from a building
 *  list are suppressed at render time. */
export const HUD_CATEGORY_ORDER: ReadonlyArray<BuildingCategory> = [
  'extraction',
  'smelting',
  'chemistry',
  'manufacturing',
  'electronics',
  'power',
  'storage',
  'logistics',
  'special',
  'cooling',
  'production',
];

/** A single defId entry in the buildings enumeration. */
export interface BuildingsEnumerationEntry {
  readonly defId: BuildingDefId;
  readonly displayName: string;
  readonly count: number;
}

/** A category row in the buildings enumeration. */
export interface BuildingsEnumerationRow {
  readonly category: BuildingCategory;
  readonly label: string;
  readonly entries: ReadonlyArray<BuildingsEnumerationEntry>;
}

/**
 * Group the placed buildings on an island by category, collapsing instances
 * of the same defId into a single `defId × count` entry. Returns rows in
 * `HUD_CATEGORY_ORDER`; categories with no buildings are omitted entirely.
 * Within a category, entries are sorted by descending count (most-deployed
 * first), with defId as a stable tiebreaker.
 *
 * Pure — no DOM, no PixiJS. Caller can stringify a row's entries as
 * `${name} ×${count}` joined by ` · `.
 */
export function enumerateBuildings(
  buildings: ReadonlyArray<PlacedBuilding>,
): ReadonlyArray<BuildingsEnumerationRow> {
  // Per-category aggregation: defId → count.
  const buckets = new Map<BuildingCategory, Map<BuildingDefId, number>>();
  for (const b of buildings) {
    const def = BUILDING_DEFS[b.defId];
    let bucket = buckets.get(def.category);
    if (!bucket) {
      bucket = new Map<BuildingDefId, number>();
      buckets.set(def.category, bucket);
    }
    bucket.set(b.defId, (bucket.get(b.defId) ?? 0) + 1);
  }
  const rows: BuildingsEnumerationRow[] = [];
  for (const category of HUD_CATEGORY_ORDER) {
    const bucket = buckets.get(category);
    if (!bucket || bucket.size === 0) continue;
    const entries: BuildingsEnumerationEntry[] = [];
    for (const [defId, count] of bucket) {
      entries.push({ defId, count, displayName: BUILDING_DEFS[defId].displayName });
    }
    // Sort by count desc, then defId for stability.
    entries.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.defId < b.defId ? -1 : a.defId > b.defId ? 1 : 0;
    });
    rows.push({ category, label: CATEGORY_HUD_LABEL[category], entries });
  }
  return rows;
}

/** Per-frame alarm classification result. Resources listed in `full` are at
 *  ≥95% of cap; resources in `low` are draining and will hit zero within 60s
 *  at the current negative net rate. Empty arrays = no alarm; HUD suppresses
 *  the row in that case. */
export interface AlarmsReport {
  readonly full: ReadonlyArray<ResourceId>;
  readonly low: ReadonlyArray<ResourceId>;
}

/** Threshold at which a resource is considered "full" for alarm purposes. */
const ALARM_FULL_FRACTION = 0.95;
/** Lookahead window (seconds) for the trending-low alarm. */
const ALARM_LOW_LOOKAHEAD_SEC = 60;

/**
 * Compute the alarm sets for an island given current per-resource net rates.
 *
 * `full` — resources whose stored amount is ≥ 95% of capped capacity AND
 *          cap > 0 (skip resources with no storage at all).
 * `low`  — resources whose net rate is negative AND whose current stockpile
 *          would be exhausted within `ALARM_LOW_LOOKAHEAD_SEC` seconds at
 *          that rate. Skip resources at zero (they're already empty — the
 *          downstream recipe stall is the real signal).
 *
 * Pure — reads through `inv()`/`cap()` for skill+specialization-adjusted
 * caps. No DOM, no PixiJS.
 */
export function computeAlarms(
  state: IslandState,
  net: Record<ResourceId, number>,
): AlarmsReport {
  const full: ResourceId[] = [];
  const low: ResourceId[] = [];
  for (const r of ALL_RESOURCES) {
    const capVal = cap(state, r);
    const have = inv(state, r);
    if (capVal > 0 && have >= capVal * ALARM_FULL_FRACTION) {
      full.push(r);
    }
    const rate = net[r] ?? 0;
    if (rate < 0 && have > 0) {
      const secToZero = have / -rate;
      if (secToZero < ALARM_LOW_LOOKAHEAD_SEC) low.push(r);
    }
  }
  return { full, low };
}

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

/** Format a number for display. Integers shown without decimal; otherwise
 *  one decimal place. The economy uses fractional inventories internally
 *  (rate × dt) so we round for display. */
const fmt = (n: number): string => {
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(1);
};

function powerTone(factor: number): 'success' | 'warn' | 'danger' {
  if (factor >= 1) return 'success';
  if (factor >= 0.5) return 'warn';
  return 'danger';
}

// ---------------------------------------------------------------------------
// Multi-island bar (extracted to zone TC)
// ---------------------------------------------------------------------------

export function mountIslandBar(
  world: WorldState,
  onSelect: (id: string) => void,
): { update(activeId: string, islandPower: Map<string, PowerBalance>, saveAgeSec: number | null): void } {
  const bar = document.createElement('div');
  bar.classList.add('ri-panel', 'topbar');
  bar.id = 'island-bar';

  mountPanel(bar, { id: 'island-bar', zone: Zone.TC, order: 0 });

  let lastIslandSig = '';
  let popOpen = false;
  const optMap = new Map<string, HTMLButtonElement>();

  // Island selector — one dropdown rather than a chip per island, which scales
  // badly: 6+ islands overflow the topbar.
  const selectWrap = document.createElement('div');
  selectWrap.classList.add('ri-island-select');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.classList.add('ri-island-trigger');
  const trigDot = document.createElement('span');
  trigDot.classList.add('ri-dot');
  const trigName = document.createElement('span');
  trigName.classList.add('ri-island-trigger__name');
  const trigLevel = document.createElement('span');
  trigLevel.classList.add('ri-mono', 'ri-muted');
  const trigCaret = document.createElement('span');
  trigCaret.classList.add('ri-island-caret');
  trigCaret.textContent = '▾';
  trigger.append(trigDot, trigName, trigLevel, trigCaret);

  const pop = document.createElement('div');
  pop.classList.add('ri-island-pop');
  pop.hidden = true;

  selectWrap.append(trigger, pop);

  function setPopOpen(open: boolean): void {
    popOpen = open;
    pop.hidden = !open;
    trigger.dataset.open = open ? 'true' : 'false';
  }
  trigger.addEventListener('click', (ev) => {
    ev.stopPropagation();
    setPopOpen(!popOpen);
  });
  document.addEventListener('click', (ev) => {
    if (popOpen && !selectWrap.contains(ev.target as Node)) setPopOpen(false);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && popOpen) setPopOpen(false);
  });

  const phaseEl = document.createElement('div');
  phaseEl.classList.add('phase');

  const savedEl = document.createElement('div');
  savedEl.classList.add('saved-indicator');

  bar.append(selectWrap, phaseEl, savedEl);

  function dotTone(factor: number): string {
    return factor >= 1 ? 'ok' : factor >= 0.5 ? 'warn' : 'danger';
  }

  function buildOption(spec: IslandSpec, state: IslandState): HTMLButtonElement {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.classList.add('ri-island-opt');
    const dot = document.createElement('span');
    dot.classList.add('ri-dot');
    const name = document.createElement('span');
    name.classList.add('ri-island-opt__name');
    name.textContent = spec.name ?? spec.id;
    const level = document.createElement('span');
    level.classList.add('ri-mono', 'ri-muted');
    level.textContent = `L${state.level}`;
    const pickableDot = document.createElement('span');
    pickableDot.className = 'ri-dot ri-dot--pickable';
    opt.append(dot, name, level, pickableDot);
    opt.dataset.pickable = 'false';
    opt.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onSelect(spec.id);
      setPopOpen(false);
    });
    return opt;
  }

  function update(
    activeId: string,
    islandPower: Map<string, PowerBalance>,
    saveAgeSec: number | null,
  ): void {
    const populated = world.islands.filter((i) => i.populated);
    const sig = populated.map((i) => i.id).join(',');
    if (sig !== lastIslandSig) {
      lastIslandSig = sig;
      while (pop.firstChild) pop.removeChild(pop.firstChild);
      optMap.clear();
      for (const spec of populated) {
        const state = world.islandStates?.get(spec.id);
        if (!state) continue;
        const opt = buildOption(spec, state);
        optMap.set(spec.id, opt);
        pop.appendChild(opt);
      }
    }

    // Update each option's tone / level / active flag / pickable flag / name.
    // §15.3: name is also updated per-frame so renames are reflected without
    // requiring the id-signature to change (the trigger label reads spec.name
    // per frame and is already correct; the dropdown options were not).
    let anyPickable = false;
    for (const spec of populated) {
      const opt = optMap.get(spec.id);
      if (!opt) continue;
      const factor = islandPower.get(spec.id)?.factor ?? 1;
      opt.dataset.active = spec.id === activeId ? 'true' : 'false';
      opt.dataset.tone = powerTone(factor);
      const dot = opt.querySelector('.ri-dot') as HTMLElement | null;
      if (dot) dot.dataset.tone = dotTone(factor);
      const nameEl = opt.querySelector('.ri-island-opt__name') as HTMLElement | null;
      if (nameEl) nameEl.textContent = spec.name ?? spec.id;
      const state = world.islandStates?.get(spec.id);
      const level = opt.querySelector('.ri-mono') as HTMLElement | null;
      if (state && level) level.textContent = `L${state.level}`;
      if (state) {
        const pickable = hasPickableSkill(state);
        opt.dataset.pickable = pickable ? 'true' : 'false';
        if (pickable) anyPickable = true;
      }
    }
    bar.classList.toggle('has-pickable', anyPickable);

    // Reflect the active island on the trigger.
    const activeSpec = populated.find((i) => i.id === activeId) ?? populated[0];
    if (activeSpec) {
      const factor = islandPower.get(activeSpec.id)?.factor ?? 1;
      const state = world.islandStates?.get(activeSpec.id);
      trigName.textContent = activeSpec.name ?? activeSpec.id;
      trigLevel.textContent = state ? `L${state.level}` : '';
      trigDot.dataset.tone = dotTone(factor);
      trigger.dataset.tone = powerTone(factor);
    }
    trigCaret.hidden = populated.length <= 1;

    // Phase — real sun at the player's location (§2.7).
    const nowMs = Date.now();
    const phaseName = realPhaseName(nowMs, world.playerLat, world.playerLon);
    const mul = solarMultiplier(nowMs, world.playerLat, world.playerLon);
    const ev = nextSunEvent(nowMs, world.playerLat, world.playerLon);
    const countdown = ev ? ` · ${ev.kind} in ${formatCountdown(ev.atMs - nowMs)}` : '';
    phaseEl.textContent = `${PHASE_LABEL[phaseName]}${countdown} · solar ${mul.toFixed(1)}×`;

    if (saveAgeSec === null) {
      savedEl.innerHTML = 'Saved <span class="ri-mono ri-muted">—</span>';
    } else if (saveAgeSec < 2) {
      savedEl.innerHTML = 'Saved <span class="ri-mono ri-muted">just now</span>';
    } else {
      savedEl.innerHTML = `Saved <span class="ri-mono ri-muted">${saveAgeSec}s ago</span>`;
    }
  }

  return { update };
}

// ---------------------------------------------------------------------------
// Mount HUD
// ---------------------------------------------------------------------------

// Per-(island, resource) rolling history of net rates. Sampled every
// HUD `update()` call (one per frame); the rendered HUD shows the most
// recent N samples as an inline SVG sparkline next to each rate row so a
// player can see if production is climbing or stalling without watching
// the number tick. Module-level + ring-buffer rather than DOM state so
// the panel can be re-rendered every frame without losing history.
const SPARK_HISTORY_LEN = 60;
const sparkHistory: Map<string, number[]> = new Map();

/** Per-island inventory-snapshot buffers feeding the shared 60s rolling
 *  average — the same figure the inventory panel shows. Keyed by island id. */
const rateBuffers: Map<string, RateSample[]> = new Map();

function sparkKey(islandId: string, resourceId: ResourceId): string {
  return `${islandId}:${resourceId}`;
}

function pushSparkSample(islandId: string, resourceId: ResourceId, rate: number): void {
  const key = sparkKey(islandId, resourceId);
  const buf = sparkHistory.get(key) ?? [];
  buf.push(rate);
  if (buf.length > SPARK_HISTORY_LEN) buf.shift();
  sparkHistory.set(key, buf);
}

const SPARK_W = 60;
const SPARK_H = 14;

/** Pure path-data builder for the sparkline polyline. Symmetric scale around
 *  0 so a flipping sign is visible (negatives dip below the midline;
 *  positives sit above). The 2-decimal `toFixed` quantization doubles as the
 *  redraw gate: visually-identical frames produce the same string. */
function sparklinePathD(samples: ReadonlyArray<number>): string {
  const peak = Math.max(0.0001, ...samples.map((s) => Math.abs(s)));
  const mid = SPARK_H / 2;
  const stepX = SPARK_W / Math.max(1, samples.length - 1);
  let d = '';
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0;
    const x = i * stepX;
    const y = mid - (s / peak) * (mid - 1);
    d += (i === 0 ? 'M' : ' L') + x.toFixed(2) + ' ' + y.toFixed(2);
  }
  return d;
}

/** Retained sparkline — SVG + children created once per rate row, mutated in
 *  place. Per frame only the path's `d` (gated on the formatted/quantized
 *  path string, so identical-looking frames skip the canvas work entirely)
 *  and `stroke` (gated on tone) are written. With <2 samples the path and
 *  baseline are detached so the output matches the legacy empty `<svg>`. */
interface RetainedSparkline {
  readonly svg: SVGSVGElement;
  readonly path: SVGPathElement;
  readonly base: SVGLineElement;
  attached: boolean;
  lastD: string;
  lastStroke: string;
}

function makeRetainedSparkline(): RetainedSparkline {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(SPARK_W));
  svg.setAttribute('height', String(SPARK_H));
  svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.style.cssText = 'display: inline-block; vertical-align: middle; margin-right: 4px';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-width', '1');
  // Zero baseline.
  const base = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  base.setAttribute('x1', '0');
  base.setAttribute('x2', String(SPARK_W));
  base.setAttribute('y1', String(SPARK_H / 2));
  base.setAttribute('y2', String(SPARK_H / 2));
  base.setAttribute('stroke', 'var(--ri-border-strong, #2a3340)');
  base.setAttribute('stroke-width', '0.5');
  return { svg, path, base, attached: false, lastD: '', lastStroke: '' };
}

function updateSparkline(
  sp: RetainedSparkline,
  samples: ReadonlyArray<number>,
  tone: 'success' | 'danger',
): void {
  if (samples.length < 2) {
    if (sp.attached) {
      sp.svg.removeChild(sp.path);
      sp.svg.removeChild(sp.base);
      sp.attached = false;
    }
    return;
  }
  if (!sp.attached) {
    sp.svg.appendChild(sp.path);
    sp.svg.appendChild(sp.base);
    sp.attached = true;
  }
  const d = sparklinePathD(samples);
  if (d !== sp.lastD) {
    sp.lastD = d;
    sp.path.setAttribute('d', d);
  }
  const stroke =
    tone === 'success' ? 'var(--ri-success, #60d0a0)' : 'var(--ri-danger, #e6504c)';
  if (stroke !== sp.lastStroke) {
    sp.lastStroke = stroke;
    sp.path.setAttribute('stroke', stroke);
  }
}

// ---------------------------------------------------------------------------
// Change-gated DOM writers — house pattern (orbital-ui / build-queue-ui /
// settlement-ui): structure rebuilds only on signature change; per-frame
// value writes compare against the last-written string and skip the DOM
// write when equal.
// ---------------------------------------------------------------------------

/** Change-gated `textContent` writer. */
function gatedText(el: HTMLElement): (text: string) => void {
  let last: string | null = null;
  return (text) => {
    if (text === last) return;
    last = text;
    el.textContent = text;
  };
}

/** Change-gated `data-tone` writer. */
function gatedTone(el: HTMLElement): (tone: string) => void {
  let last: string | null = null;
  return (tone) => {
    if (tone === last) return;
    last = tone;
    el.dataset.tone = tone;
  };
}

/** Change-gated CSS custom-property writer. */
function gatedStyleProp(el: HTMLElement, prop: string): (value: string) => void {
  let last: string | null = null;
  return (value) => {
    if (value === last) return;
    last = value;
    el.style.setProperty(prop, value);
  };
}

export function mountHud(
  parentEl: HTMLElement,
  world: WorldState,
  _onSelect: (id: string) => void,
  reg: InputRegistry,
): HudHandle {
  const panel = document.createElement('div');
  panel.classList.add('ri-panel');
  panel.id = 'hud-economy';
  parentEl.appendChild(panel);
  mountPanel(panel, { id: 'hud-economy', zone: Zone.BR, order: 0, minWidth: 260, maxWidth: 360 });

  const head = document.createElement('div');
  head.classList.add('ri-panel__head');
  const titleEl = document.createElement('span');
  titleEl.classList.add('ri-panel__title');
  const subEl = document.createElement('span');
  subEl.classList.add('ri-panel__sub');
  head.appendChild(titleEl);
  head.appendChild(subEl);
  panel.appendChild(head);

  const body = document.createElement('div');
  body.classList.add('ri-panel__body');
  panel.appendChild(body);

  // Persistent interactive elements — created once so their click targets
  // (and listeners) are never recreated. The data attribute is the legacy
  // persistence marker; kept for styling/test hooks even though the whole
  // body is now retained.
  const tierResetRow = document.createElement('div');
  tierResetRow.classList.add('ri-kv');
  tierResetRow.dataset.hudPersistent = 'true';
  const trK = document.createElement('span');
  trK.classList.add('ri-kv__k');
  trK.textContent = '↺ TIER RESET';
  const trV = document.createElement('button');
  trV.classList.add('ri-kv__v');
  trV.textContent = 'available → K';
  trV.style.cssText = 'background: transparent; border: 1px solid var(--ri-accent); color: var(--ri-accent); cursor: pointer; padding: 1px 8px; font: inherit; border-radius: 3px;';
  trV.addEventListener('click', () => dispatchAction(reg, 'toggle-skill-tree'));
  tierResetRow.appendChild(trK);
  tierResetRow.appendChild(trV);

  const invBtn = document.createElement('button');
  invBtn.classList.add('ri-btn', 'ri-btn--ghost');
  invBtn.dataset.hudPersistent = 'true';
  invBtn.textContent = 'Inventory (I)';
  invBtn.addEventListener('click', () => dispatchAction(reg, 'toggle-inventory'));

  // ── Static skeleton — built ONCE ──────────────────────────────────────────
  // perf: the legacy per-frame teardown/rebuild (clearDynamicChildren +
  // createElement for every row) profiled at 3.1% inclusive CPU plus GC
  // churn. The body structure is now retained; update() only writes values
  // that changed, and rebuilds a sub-region only when its row-set signature
  // changes (which resources show, tier-reset/offer presence).

  // XP block.
  const xpKv = document.createElement('div');
  xpKv.classList.add('ri-kv');
  const xpK = document.createElement('span');
  xpK.classList.add('ri-kv__k');
  const xpV = document.createElement('span');
  xpV.classList.add('ri-kv__v');
  xpKv.appendChild(xpK);
  xpKv.appendChild(xpV);

  const xpMeter = document.createElement('div');
  xpMeter.classList.add('ri-meter');
  const xpFill = document.createElement('div');
  xpFill.classList.add('ri-meter__fill');
  xpMeter.appendChild(xpFill);

  // Power row.
  const powerKv = document.createElement('div');
  powerKv.classList.add('ri-kv');
  const powerK = document.createElement('span');
  powerK.classList.add('ri-kv__k');
  powerK.textContent = '⚡ POWER';
  const powerV = document.createElement('span');
  powerV.classList.add('ri-kv__v');
  powerKv.appendChild(powerK);
  powerKv.appendChild(powerV);

  const powerMeter = document.createElement('div');
  powerMeter.classList.add('ri-meter');
  const powerFill = document.createElement('div');
  powerFill.classList.add('ri-meter__fill');
  powerMeter.appendChild(powerFill);

  // Network row.
  const netKv = document.createElement('div');
  netKv.classList.add('ri-kv');
  const netK = document.createElement('span');
  netK.classList.add('ri-kv__k');
  netK.textContent = '⌬ NETWORK';
  const netV = document.createElement('span');
  netV.classList.add('ri-kv__v');
  netKv.appendChild(netK);
  netKv.appendChild(netV);

  // Site section.
  const siteHead = document.createElement('div');
  siteHead.classList.add('ri-sectionhead');
  siteHead.textContent = 'Site';

  const modRow = document.createElement('div');
  modRow.classList.add('modifiers');

  // Signal Exchange next-offer row — created once, attached only while the
  // island hosts a Signal Exchange (presence managed in update()).
  const offerKv = document.createElement('div');
  offerKv.classList.add('ri-kv');
  const offerK = document.createElement('span');
  offerK.classList.add('ri-kv__k');
  offerK.textContent = 'Next offer';
  const offerV = document.createElement('span');
  offerV.classList.add('ri-kv__v');
  offerKv.appendChild(offerK);
  offerKv.appendChild(offerV);

  // §9.9 active-play bonus row.
  const abKv = document.createElement('div');
  abKv.classList.add('ri-kv');
  const abK = document.createElement('span');
  abK.classList.add('ri-kv__k');
  abK.textContent = 'Active bonus';
  const abV = document.createElement('span');
  abV.classList.add('ri-kv__v');
  abKv.appendChild(abK);
  abKv.appendChild(abV);

  // Output rates section.
  const ratesHead = document.createElement('div');
  ratesHead.classList.add('ri-sectionhead');
  ratesHead.textContent = 'Output rates';

  // Placeholder shown when no resource has a non-zero displayed rate.
  const emptyRates = document.createElement('div');
  emptyRates.classList.add('ri-kv__k');
  emptyRates.textContent = 'no production';

  // Assemble in render order. Conditional elements (tierResetRow before
  // xpMeter, offerKv before abKv, rate rows before invBtn) are inserted
  // against these stable anchors when their presence flips.
  body.appendChild(xpKv);
  body.appendChild(xpMeter);
  body.appendChild(powerKv);
  body.appendChild(powerMeter);
  body.appendChild(netKv);
  body.appendChild(siteHead);
  body.appendChild(modRow);
  body.appendChild(abKv);
  body.appendChild(ratesHead);
  body.appendChild(invBtn);

  // Change-gated value writers.
  const setTitle = gatedText(titleEl);
  const setSub = gatedText(subEl);
  const setXpK = gatedText(xpK);
  const setXpV = gatedText(xpV);
  const setXpPct = gatedStyleProp(xpFill, '--ri-meter-pct');
  const setPowerV = gatedText(powerV);
  const setPowerVTone = gatedTone(powerV);
  const setPowerMeterTone = gatedTone(powerMeter);
  const setPowerPct = gatedStyleProp(powerFill, '--ri-meter-pct');
  const setNetV = gatedText(netV);
  const setNetVTone = gatedTone(netV);
  const setOfferV = gatedText(offerV);
  const setAbV = gatedText(abV);

  // Structural state — what the retained DOM currently shows.
  let tierResetShown = false;
  let offerShown = false;
  let lastModSig: string | null = null;
  let lastRatesSig: string | null = null;
  let ratesRegion: HTMLElement[] = [];

  // Rate-row cache, keyed by resource id (bounded by |ALL_RESOURCES| — no
  // eviction needed, unlike build-queue-ui's unbounded building ids). The
  // label is resource-derived and island-independent; tones/values/sparkline
  // are rewritten per frame, so rows are safely reused across island switches.
  interface RateRowEntry {
    readonly row: HTMLDivElement;
    readonly setDotTone: (t: string) => void;
    readonly setVTone: (t: string) => void;
    readonly setVText: (t: string) => void;
    readonly spark: RetainedSparkline;
  }
  const rateRowCache = new Map<ResourceId, RateRowEntry>();

  function makeRateRow(r: ResourceId): RateRowEntry {
    const row = document.createElement('div');
    row.classList.add('ri-kv');
    const k = document.createElement('span');
    k.classList.add('ri-kv__k');
    const dot = document.createElement('span');
    dot.classList.add('ri-dot');
    k.appendChild(dot);
    k.appendChild(document.createTextNode(' ' + toDisplayName(r)));
    const v = document.createElement('span');
    v.classList.add('ri-kv__v');
    const spark = makeRetainedSparkline();
    const vTextNode = document.createTextNode('');
    v.appendChild(spark.svg);
    v.appendChild(vTextNode);
    row.appendChild(k);
    row.appendChild(v);
    let lastVText: string | null = null;
    return {
      row,
      setDotTone: gatedTone(dot),
      setVTone: gatedTone(v),
      setVText: (t) => {
        if (t === lastVText) return;
        lastVText = t;
        vTextNode.data = t;
      },
      spark,
    };
  }

  function update(
    state: IslandState,
    net: Record<ResourceId, number>,
    power: PowerBalance,
    spec: IslandSpec,
    ncState: NetworkConsciousnessState,
    _saveAgeSec: number | null,
    vehiclesEnRoute: number,
    _activeIslandId: string,
    _islandPower: Map<string, PowerBalance>,
  ): void {
    setTitle(spec.name);
    // #134: surface the composite tier so a fully-T6 island (Ascendant Core +
    // Spaceport) reads "T6 · Biome" instead of capping at T5. T6 has no level
    // threshold, so the XP block's tier>=5 "MAX ISLAND TIER" branch correctly
    // covers both the top level-band (T5) and T6.
    const tier = effectiveIslandTier(state, spec);
    const biomeName = BIOME_DEFS[spec.biome].displayName;
    setSub(`T${tier} · ${biomeName}`);

    // ---- XP block ---------------------------------------------------------
    const need = xpForLevel(state.level + 1);
    const xpPct = need > 0 ? Math.min(100, Math.round((state.xp / need) * 100)) : 100;
    if (tier >= 5) {
      setXpK(`Level ${state.level} · MAX ISLAND TIER`);
    } else {
      const gap = NEXT_TIER_LEVEL[tier] - state.level;
      setXpK(`Level ${state.level} · ${gap} to T${tier + 1}`);
    }
    setXpV(`XP ${fmt(state.xp)} / ${fmt(need)}`);
    setXpPct(`${xpPct}%`);

    // §9.7 tier reset surface — present only when applicable; absent from the
    // DOM rather than hidden-and-orphaned. Presence is structural, so the
    // insert/remove happens only on transitions (slot: after xpKv, before
    // xpMeter — same order the legacy per-frame rebuild produced).
    const tierResetOk = canTierReset(state, Date.now()).ok;
    if (tierResetOk !== tierResetShown) {
      tierResetShown = tierResetOk;
      if (tierResetOk) body.insertBefore(tierResetRow, xpMeter);
      else body.removeChild(tierResetRow);
    }

    // ---- Power row --------------------------------------------------------
    const pTone = powerTone(power.factor);
    setPowerVTone(pTone);
    setPowerV(`${fmtPower(power.rawProduced)} / ${fmtPower(power.rawConsumed)} · ${power.factor.toFixed(2)}×`);
    setPowerMeterTone(pTone);
    const powerPct = power.rawProduced > 0 ? Math.min(100, Math.round((power.rawConsumed / power.rawProduced) * 100)) : 0;
    setPowerPct(`${powerPct}%`);

    // ---- Network row ------------------------------------------------------
    const enRouteSuffix = vehiclesEnRoute > 0 ? ` · +${vehiclesEnRoute} en route` : '';
    if (ncState.tier3PlusCount === 0) {
      setNetV(enRouteSuffix === '' ? '—' : `—${enRouteSuffix}`);
      setNetVTone(vehiclesEnRoute > 0 ? 'success' : 'dim');
    } else {
      const buffPct = Math.round((ncState.globalProductionBuff - 1) * 100);
      setNetV(`${ncState.tier3PlusCount} at T3+ · NC tier ${ncState.milestone} · +${buffPct}%${enRouteSuffix}`);
      setNetVTone('success');
    }

    // ---- Site section -----------------------------------------------------
    // Chips derive entirely from the modifier-id list (static MODIFIER_DEFS),
    // so the row-set signature is just the joined ids — rebuild on island
    // switch / modifier change only. Chips carry no event listeners.
    const modSig = spec.modifiers.join(',');
    if (modSig !== lastModSig) {
      lastModSig = modSig;
      while (modRow.firstChild) modRow.removeChild(modRow.firstChild);
      if (spec.modifiers.length === 0) {
        const empty = document.createElement('span');
        empty.classList.add('ri-kv__k');
        empty.textContent = '—';
        modRow.appendChild(empty);
      } else {
        for (const id of spec.modifiers) {
          const def = MODIFIER_DEFS[id];
          const chip = document.createElement('span');
          chip.classList.add('ri-chip');
          chip.textContent = def.displayName;
          chip.title = def.description + (def.placeholder ? ' (placeholder — system pending)' : '');
          const tone =
            def.category === 'positive' ? 'success' :
            def.category === 'warning' ? 'warn' :
            def.category === 'exotic' ? 'exotic' :
            undefined;
          if (tone) chip.dataset.tone = tone;
          if (def.placeholder) chip.style.borderStyle = 'dashed';
          modRow.appendChild(chip);
        }
      }
    }

    // ---- Signal Exchange next-offer countdown -----------------------------
    // §9.8: an island hosting a Signal Exchange surfaces a barter offer when
    // its persisted online-time cooldown (`tradeCooldownMs`) burns to zero.
    // Show that countdown so the player knows when to check back. The cooldown
    // sits at 0 both while an offer is live and the instant before one spawns,
    // so 0 reads as "available now". Rendered only for islands that have the
    // building (no Signal Exchange → no trade machinery → no row). Presence
    // is structural (slot: before abKv); the countdown text is value-gated.
    const hasOffer = islandHasSignalExchange(state);
    if (hasOffer !== offerShown) {
      offerShown = hasOffer;
      if (hasOffer) body.insertBefore(offerKv, abKv);
      else body.removeChild(offerKv);
    }
    if (hasOffer) {
      setOfferV(state.tradeCooldownMs <= 0 ? 'available now' : formatCountdown(state.tradeCooldownMs));
    }

    // ---- §9.9 active-play bonus -------------------------------------------
    // World-level: every focused minute adds +0.1% to every recipe on every
    // island; decays at 3× while away (including closed). Always rendered so
    // the mechanic is discoverable; "—" reads as "no bonus right now".
    const abPct = (activeBonusMul(world) - 1) * 100;
    setAbV(abPct >= 0.05 ? `+${abPct.toFixed(1)}%` : '—');

    // ---- Output rates section ---------------------------------------------
    // Sample every resource's current net rate for the active island so
    // sparklines build full history even for resources that drop out of
    // the top-5 list briefly.
    for (const r of ALL_RESOURCES) {
      pushSparkSample(state.id, r, net[r] ?? 0);
    }

    // Output-rate values use the shared 60s realized-delta average — the same
    // figure the inventory panel shows — not the jumpy instantaneous `net`.
    // Sampled at most every 250ms; a stale buffer (island revisited after a
    // long gap) is dropped so the average warms up fresh.
    let rateBuf = rateBuffers.get(state.id);
    if (!rateBuf) { rateBuf = []; rateBuffers.set(state.id, rateBuf); }
    const rateNow = performance.now();
    const lastSample = rateBuf[rateBuf.length - 1];
    if (lastSample && rateNow - lastSample.t > RATE_WINDOW_MS) rateBuf.length = 0;
    if (!lastSample || rateNow - lastSample.t >= 250) {
      rateBuf.push({ t: rateNow, inv: snapshotInventory(state) });
      pruneRateBuffer(rateBuf, rateNow);
    }
    const avgRate = averageRate(rateBuf);

    const topRates = ALL_RESOURCES
      // Quantize to 2-decimal display precision so visually-identical rows
      // share a sort key and don't churn the top-5 on sub-precision jitter.
      .map((r) => ({ r, rate: Math.round((avgRate[r] ?? 0) * 100) / 100 }))
      .filter((e) => e.rate !== 0)
      .sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate))
      .slice(0, 5);

    // Row-set signature: the ordered resource ids. Order is structural here —
    // rows are sorted by |rate| — so a reorder rebuilds the region (cached
    // rows are re-inserted, not recreated). Identical signature → value
    // writes only.
    const ratesSig = topRates.map((e) => e.r).join(',');
    if (ratesSig !== lastRatesSig) {
      lastRatesSig = ratesSig;
      for (const el of ratesRegion) body.removeChild(el);
      ratesRegion = [];
      if (topRates.length === 0) {
        body.insertBefore(emptyRates, invBtn);
        ratesRegion.push(emptyRates);
      } else {
        for (const { r } of topRates) {
          let entry = rateRowCache.get(r);
          if (!entry) {
            entry = makeRateRow(r);
            rateRowCache.set(r, entry);
          }
          body.insertBefore(entry.row, invBtn);
          ratesRegion.push(entry.row);
        }
      }
    }

    // Per-frame value writes on the visible rate rows (all change-gated).
    for (const { r, rate } of topRates) {
      const entry = rateRowCache.get(r);
      if (!entry) continue;
      entry.setDotTone(rate > 0 ? 'ok' : 'danger');
      const tone: 'success' | 'danger' = rate > 0 ? 'success' : 'danger';
      entry.setVTone(tone);
      const sign = rate > 0 ? '+' : '−';
      const absRate = Math.abs(rate);
      let vText = `${sign}${absRate.toFixed(2)}/s`;
      if (rate < 0) {
        const have = inv(state, r);
        if (have > 0) {
          const sec = Math.floor(have / absRate);
          vText += ` · ${sec}s`;
        }
      }
      entry.setVText(vText);
      updateSparkline(entry.spark, sparkHistory.get(sparkKey(state.id, r)) ?? [], tone);
    }

    // Inventory hint (invBtn) is part of the static skeleton — always last.

    // Objective display lives in the bottom-center tutorial banner
    // (tutorial-ui.ts). The HUD's previous "Next objective" row was a
    // redundant second render of the same string and has been removed.
  }

  return { el: panel, update };
}
