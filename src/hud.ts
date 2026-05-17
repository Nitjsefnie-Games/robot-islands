// DOM HUD overlay for the live island economy state.
//
// Phase 3 rebuild: all chrome uses `.ri-*` classes from `ui.css`. Only runtime
// values (meter `--ri-meter-pct`, `data-tone` attributes) are set inline.
// The panel mounts in zone BR via `ui-zones.ts`; the multi-island bar is
// extracted to `mountIslandBar` in zone TC.

import { BIOME_DEFS, MODIFIER_DEFS } from './biomes.js';
import { BUILDING_DEFS, type BuildingCategory, type BuildingDefId } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import { dayPhase, dayPhaseName, solarMultiplier, type DayPhase } from './daynight.js';
import { cap, inv, type IslandState, type PowerBalance, xpForLevel } from './economy.js';
import { dispatchAction, type InputRegistry } from './input.js';
import type { NetworkConsciousnessState } from './network-consciousness.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { tierForLevel, type Tier } from './skilltree.js';
import { canTierReset } from './tier-reset.js';
import { toDisplayName } from './ui-tokens.js';
import { mountPanel, Zone } from './ui-zones.js';
import type { IslandSpec, WorldState } from './world.js';


/**
 * Mounts a fixed-position panel and returns an `update` function. Calling
 * `update(state, net, power, …)` rewrites the panel's contents to match the
 * given state. The `net` argument carries per-resource net production rate
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
  const chipMap = new Map<string, HTMLButtonElement>();

  const phaseEl = document.createElement('div');
  phaseEl.classList.add('phase');

  const savedEl = document.createElement('div');
  savedEl.classList.add('saved-indicator');

  function buildChip(spec: IslandSpec, state: IslandState): HTMLButtonElement {
    const chip = document.createElement('button');
    chip.classList.add('ri-chip');
    const dot = document.createElement('span');
    dot.classList.add('ri-dot');
    const name = document.createElement('span');
    name.textContent = spec.name ?? spec.id;
    const level = document.createElement('span');
    level.classList.add('ri-mono', 'ri-muted');
    level.textContent = `L${state.level}`;
    chip.appendChild(dot);
    chip.appendChild(name);
    chip.appendChild(level);
    chip.addEventListener('click', () => onSelect(spec.id));
    return chip;
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
      while (bar.firstChild) bar.removeChild(bar.firstChild);
      chipMap.clear();
      for (const spec of populated) {
        const state = world.islandStates?.get(spec.id);
        if (!state) continue;
        const chip = buildChip(spec, state);
        chipMap.set(spec.id, chip);
        bar.appendChild(chip);
      }
      bar.appendChild(phaseEl);
      bar.appendChild(savedEl);
    }

    // Update chip states
    for (const spec of populated) {
      const chip = chipMap.get(spec.id);
      if (!chip) continue;
      const p = islandPower.get(spec.id);
      const factor = p?.factor ?? 1;
      const tone = powerTone(factor);
      chip.dataset.active = spec.id === activeId ? 'true' : 'false';
      chip.dataset.tone = tone;
      const dot = chip.querySelector('.ri-dot') as HTMLElement;
      if (dot) {
        dot.dataset.tone = factor >= 1 ? 'ok' : factor >= 0.5 ? 'warn' : 'danger';
      }
      const state = world.islandStates?.get(spec.id);
      if (state) {
        const level = chip.querySelector('.ri-mono') as HTMLElement;
        if (level) level.textContent = `L${state.level}`;
      }
    }

    // Phase
    const nowMs = Date.now();
    const phaseName = dayPhaseName(nowMs);
    const phaseFrac = (dayPhase(nowMs) * 4) % 1;
    const mul = solarMultiplier(nowMs);
    phaseEl.textContent = `${PHASE_LABEL[phaseName]} ${Math.floor(phaseFrac * 100)}% · solar ${mul.toFixed(1)}×`;

    // Saved
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
// renderMultiIslandBar — deprecated, kept as no-op stub
// ---------------------------------------------------------------------------

export function renderMultiIslandBar(
  _world: WorldState,
  _onSelect: (id: string) => void,
): HTMLElement {
  return document.createElement('div');
}

// ---------------------------------------------------------------------------
// Mount HUD
// ---------------------------------------------------------------------------

export function mountHud(
  parentEl: HTMLElement,
  _world: WorldState,
  _onSelect: (id: string) => void,
  reg: InputRegistry,
): HudHandle {
  const panel = document.createElement('div');
  panel.classList.add('ri-panel');
  panel.id = 'hud-economy';
  parentEl.appendChild(panel);
  mountPanel(panel, { id: 'hud-economy', zone: Zone.BR, order: 0, minWidth: 260, maxWidth: 360 });

  // Head
  const head = document.createElement('div');
  head.classList.add('ri-panel__head');
  const titleEl = document.createElement('span');
  titleEl.classList.add('ri-panel__title');
  const subEl = document.createElement('span');
  subEl.classList.add('ri-panel__sub');
  head.appendChild(titleEl);
  head.appendChild(subEl);
  panel.appendChild(head);

  // Body
  const body = document.createElement('div');
  body.classList.add('ri-panel__body');
  panel.appendChild(body);

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
    // Update head
    titleEl.textContent = spec.name;
    const tier = tierForLevel(state.level);
    const biomeName = BIOME_DEFS[spec.biome].displayName;
    subEl.textContent = `T${tier} · ${biomeName}`;

    // Rebuild body
    while (body.firstChild) body.removeChild(body.firstChild);

    // ---- XP block ---------------------------------------------------------
    const need = xpForLevel(state.level + 1);
    const xpPct = need > 0 ? Math.min(100, Math.round((state.xp / need) * 100)) : 100;
    const xpKv = document.createElement('div');
    xpKv.classList.add('ri-kv');
    const xpK = document.createElement('span');
    xpK.classList.add('ri-kv__k');
    if (tier >= 5) {
      xpK.textContent = `Level ${state.level} · MAX TIER`;
    } else {
      const gap = NEXT_TIER_LEVEL[tier] - state.level;
      xpK.textContent = `Level ${state.level} · ${gap} to T${tier + 1}`;
    }
    const xpV = document.createElement('span');
    xpV.classList.add('ri-kv__v');
    xpV.textContent = `XP ${fmt(state.xp)} / ${fmt(need)}`;
    xpKv.appendChild(xpK);
    xpKv.appendChild(xpV);
    body.appendChild(xpKv);

    // §9.7 tier reset surface — when the active island can fire a reset right
    // now (T3+, off cooldown, materials available) flash a clickable hint
    // that opens the Skill Tree where the reset row lives. Silent otherwise.
    if (canTierReset(state, Date.now()).ok) {
      const trKv = document.createElement('div');
      trKv.classList.add('ri-kv');
      const trK = document.createElement('span');
      trK.classList.add('ri-kv__k');
      trK.textContent = '↺ TIER RESET';
      const trV = document.createElement('button');
      trV.classList.add('ri-kv__v');
      trV.textContent = 'available → K';
      trV.style.cssText = 'background: transparent; border: 1px solid var(--ri-accent); color: var(--ri-accent); cursor: pointer; padding: 1px 8px; font: inherit; border-radius: 3px;';
      trV.addEventListener('click', () => dispatchAction(reg, 'toggle-skill-tree'));
      trKv.appendChild(trK);
      trKv.appendChild(trV);
      body.appendChild(trKv);
    }

    const xpMeter = document.createElement('div');
    xpMeter.classList.add('ri-meter');
    const xpFill = document.createElement('div');
    xpFill.classList.add('ri-meter__fill');
    xpFill.style.setProperty('--ri-meter-pct', `${xpPct}%`);
    xpMeter.appendChild(xpFill);
    body.appendChild(xpMeter);

    // ---- Power row --------------------------------------------------------
    const pTone = powerTone(power.factor);
    const powerKv = document.createElement('div');
    powerKv.classList.add('ri-kv');
    const powerK = document.createElement('span');
    powerK.classList.add('ri-kv__k');
    powerK.textContent = '⚡ POWER';
    const powerV = document.createElement('span');
    powerV.classList.add('ri-kv__v');
    powerV.dataset.tone = pTone;
    powerV.textContent = `${fmt(power.produced)}W / ${fmt(power.consumed)}W · ${power.factor.toFixed(2)}×`;
    powerKv.appendChild(powerK);
    powerKv.appendChild(powerV);
    body.appendChild(powerKv);

    const powerMeter = document.createElement('div');
    powerMeter.classList.add('ri-meter');
    powerMeter.dataset.tone = pTone;
    const powerFill = document.createElement('div');
    powerFill.classList.add('ri-meter__fill');
    const powerPct = power.produced > 0 ? Math.min(100, Math.round((power.consumed / power.produced) * 100)) : 0;
    powerFill.style.setProperty('--ri-meter-pct', `${powerPct}%`);
    powerMeter.appendChild(powerFill);
    body.appendChild(powerMeter);

    // ---- Network row ------------------------------------------------------
    const netKv = document.createElement('div');
    netKv.classList.add('ri-kv');
    const netK = document.createElement('span');
    netK.classList.add('ri-kv__k');
    netK.textContent = '⌬ NETWORK';
    const netV = document.createElement('span');
    netV.classList.add('ri-kv__v');
    const enRouteSuffix = vehiclesEnRoute > 0 ? ` · +${vehiclesEnRoute} en route` : '';
    if (ncState.tier3PlusCount === 0) {
      netV.textContent = enRouteSuffix === '' ? '—' : `—${enRouteSuffix}`;
      netV.dataset.tone = vehiclesEnRoute > 0 ? 'success' : 'dim';
    } else {
      const buffPct = Math.round((ncState.globalProductionBuff - 1) * 100);
      netV.textContent = `${ncState.tier3PlusCount} at T3+ · NC tier ${ncState.milestone} · +${buffPct}%${enRouteSuffix}`;
      netV.dataset.tone = 'success';
    }
    netKv.appendChild(netK);
    netKv.appendChild(netV);
    body.appendChild(netKv);

    // ---- Site section -----------------------------------------------------
    const siteHead = document.createElement('div');
    siteHead.classList.add('ri-sectionhead');
    siteHead.textContent = 'Site';
    body.appendChild(siteHead);

    const modRow = document.createElement('div');
    modRow.classList.add('modifiers');
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
    body.appendChild(modRow);

    // ---- Output rates section ---------------------------------------------
    const ratesHead = document.createElement('div');
    ratesHead.classList.add('ri-sectionhead');
    ratesHead.textContent = 'Output rates';
    body.appendChild(ratesHead);

    const topRates = ALL_RESOURCES
      .map((r) => ({ r, rate: net[r] ?? 0 }))
      .filter((e) => e.rate !== 0)
      .sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate))
      .slice(0, 5);

    if (topRates.length === 0) {
      const empty = document.createElement('div');
      empty.classList.add('ri-kv__k');
      empty.textContent = 'no production';
      body.appendChild(empty);
    } else {
      for (const { r, rate } of topRates) {
        const row = document.createElement('div');
        row.classList.add('ri-kv');
        const k = document.createElement('span');
        k.classList.add('ri-kv__k');
        const dot = document.createElement('span');
        dot.classList.add('ri-dot');
        dot.dataset.tone = rate > 0 ? 'ok' : 'danger';
        k.appendChild(dot);
        k.appendChild(document.createTextNode(' ' + toDisplayName(r)));
        const v = document.createElement('span');
        v.classList.add('ri-kv__v');
        v.dataset.tone = rate > 0 ? 'success' : 'danger';
        const sign = rate > 0 ? '+' : '−';
        const absRate = Math.abs(rate);
        let vText = `${sign}${fmt(absRate)}/s`;
        if (rate < 0) {
          const have = inv(state, r);
          if (have > 0) {
            const sec = Math.floor(have / absRate);
            vText += ` · ${sec}s`;
          }
        }
        v.textContent = vText;
        row.appendChild(k);
        row.appendChild(v);
        body.appendChild(row);
      }
    }

    // ---- Inventory hint ---------------------------------------------------
    const invBtn = document.createElement('button');
    invBtn.classList.add('ri-btn', 'ri-btn--ghost');
    invBtn.textContent = 'Inventory (I)';
    invBtn.addEventListener('click', () => dispatchAction(reg, 'toggle-inventory'));
    body.appendChild(invBtn);

    // Objective display lives in the bottom-center tutorial banner
    // (tutorial-ui.ts). The HUD's previous "Next objective" row was a
    // redundant second render of the same string and has been removed.
  }

  return { el: panel, update };
}
