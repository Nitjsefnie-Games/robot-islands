// DOM HUD overlay for the live island economy state.
//
// Plain DOM, no framework — matches the styling vocabulary of the existing
// `#info` strip (top-left) and `#ui-overlay` button panel (top-right). The
// HUD sits bottom-right so it doesn't fight either of those for screen
// real estate.
//
// `mountHud` creates and returns the panel + an `update` callback. The
// PixiJS ticker calls `update(state, net, power, …)` once per frame after
// `advanceIsland`. To keep the per-frame update cheap, the panel holds a
// stable DOM tree and writes only textContents + a handful of inline styles.
// Sections that depend on infrequently-changing inputs (the modifier chip
// row, the buildings enumeration) gate their rebuilds behind cached
// signature keys — the chip row uses `lastModifiersKey`; the buildings
// section uses `lastBuildingsKey`.
//
// Step-19 refactor: the per-resource Inventory block (one row per
// ResourceId) was retired. The full inventory moved to a dedicated
// KeyI-toggled panel (`inventory-ui.ts`). The HUD now surfaces:
//
//   1. Header (active-island title)
//   2. Level + tier badge + skill points
//   3. Site profile (biome name + modifier chips)
//   4. Network Consciousness line (above Power per the refactor brief)
//   5. Power line (produced / consumed / factor)
//   6. Saved indicator
//   7. Objective — current short-term goal from the objectives ladder
//   8. Buildings — compact per-category enumeration of placed defs
//   9. Alarms — surfaces resources at cap or trending to empty
//  10. Inventory hint (KeyI)
//
// Why DOM rather than PixiJS Text: the HUD updates every frame with
// changing strings, and the surrounding game UI is already DOM. DOM text
// rendering is also crisper at any zoom level than PixiJS Text.

import { BIOME_DEFS, MODIFIER_DEFS, type ModifierId } from './biomes.js';
import { BUILDING_DEFS, type BuildingCategory, type BuildingDefId } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import { dayPhase, dayPhaseName, solarMultiplier, type DayPhase } from './daynight.js';
import { cap, inv, type IslandState, type PowerBalance, xpForLevel } from './economy.js';
import type { NetworkConsciousnessState } from './network-consciousness.js';
import type { Objective } from './objectives.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { tierForLevel, type Tier } from './skilltree.js';
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
    objective: Objective | null,
    activeIslandId: string,
    islandPower: Map<string, PowerBalance>,
  ): void;
}

// Brownout severity palette. Ramp from neutral text colour through warm
// amber to alert orange-red. Three tiers map to a glanceable engineering
// readout: nominal / marginal / critical.
const POWER_COLOR_NOMINAL = '#cdd6f4'; // factor === 1, matches default text
const POWER_COLOR_MARGINAL = '#f5a742'; // 0.5 ≤ factor < 1, warm amber
const POWER_COLOR_CRITICAL = '#e85d4a'; // factor < 0.5, alert orange-red

function powerColor(factor: number): string {
  if (factor >= 1) return POWER_COLOR_NOMINAL;
  if (factor >= 0.5) return POWER_COLOR_MARGINAL;
  return POWER_COLOR_CRITICAL;
}

// Day-phase display palette — Day full daylight, Dusk/Dawn warm amber,
// Night cool dim. Tied to `DayPhase` from daynight.ts.
const PHASE_COLOR: Readonly<Record<DayPhase, string>> = {
  dawn: '#f5a742', // warm amber
  day: '#f2c84b', // sunlight gold
  dusk: '#e07b3a', // dusk orange
  night: '#6c7791', // muted cool
};

const PHASE_LABEL: Readonly<Record<DayPhase, string>> = {
  dawn: 'Dawn',
  day: 'Day',
  dusk: 'Dusk',
  night: 'Night',
};

// Tier-breakpoint thresholds, mirroring `tierForLevel` in skilltree.ts.
const NEXT_TIER_LEVEL: Readonly<Record<Tier, number>> = {
  1: 5,
  2: 15,
  3: 30,
  4: 50,
  5: Number.POSITIVE_INFINITY,
  6: Number.POSITIVE_INFINITY,
};

const TIER_BADGE_ACCENT = '#7dd3e8';
const TIER_BADGE_WARN = '#f5a742';
const TIER_BADGE_MUTED = '#6c7791';

function tierBadgeColor(level: number, tier: Tier): string {
  if (tier >= 5) return TIER_BADGE_MUTED;
  const next = NEXT_TIER_LEVEL[tier];
  if (next - level <= 2) return TIER_BADGE_WARN;
  return TIER_BADGE_ACCENT;
}

// Modifier chip palette. Tied to ModifierDef.category in `biomes.ts`.
const CHIP_PALETTE: Readonly<Record<
  'positive' | 'warning' | 'exotic' | 'neutral',
  { readonly fg: string; readonly bg: string; readonly border: string }
>> = {
  positive: {
    fg: '#7dd3a0',
    bg: 'rgba(125, 211, 160, 0.10)',
    border: 'rgba(125, 211, 160, 0.40)',
  },
  warning: {
    fg: '#f5a742',
    bg: 'rgba(245, 167, 66, 0.10)',
    border: 'rgba(245, 167, 66, 0.40)',
  },
  exotic: {
    fg: '#b48cd8',
    bg: 'rgba(180, 140, 216, 0.10)',
    border: 'rgba(180, 140, 216, 0.40)',
  },
  neutral: {
    fg: '#7a8294',
    bg: 'transparent',
    border: 'rgba(122, 130, 148, 0.30)',
  },
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
// Mount
// ---------------------------------------------------------------------------

export function renderMultiIslandBar(
  world: WorldState,
  activeIslandId: string,
  onSelect: (id: string) => void,
  islandPower: Map<string, PowerBalance>,
): HTMLElement {
  const bar = document.createElement('div');
  bar.id = 'multi-island-bar';
  bar.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 32px;
    background: #0a0e14;
    border-bottom: 1px solid #2d5878;
    display: flex;
    gap: 8px;
    padding: 0 8px;
    align-items: center;
    overflow-x: auto;
    z-index: 100;
  `;

  for (const spec of world.islands) {
    if (!spec.populated) continue;
    const state = world.islandStates?.get(spec.id);
    if (!state) continue;

    const item = document.createElement('div');
    const isActive = spec.id === activeIslandId;
    item.dataset.islandId = spec.id;
    item.style.cssText = `
      display: flex;
      gap: 4px;
      align-items: center;
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
      font-size: 12px;
      color: #eee;
      background: ${isActive ? '#2d5878' : 'transparent'};
    `;
    item.onclick = () => onSelect(spec.id);

    const name = document.createElement('span');
    name.textContent = spec.name ?? spec.id;
    item.appendChild(name);

    const level = document.createElement('span');
    level.style.cssText = 'color:#7dd3e8;font-size:10px;';
    level.textContent = `L${state.level}`;
    item.appendChild(level);

    // Brownout indicator
    const power = islandPower.get(spec.id);
    const isBrownout = power ? power.rawConsumed > power.rawProduced : false;
    if (isBrownout) {
      item.style.color = '#ff4444';
    }

    // Storage cap hit indicator
    const capHit = Object.entries(state.inventory).some(([r, amount]) => {
      return amount >= cap(state, r as ResourceId) && amount > 0;
    });
    if (capHit) {
      const alert = document.createElement('span');
      alert.style.cssText = 'color:#ffaa00;font-weight:bold;margin-left:2px;';
      alert.textContent = '!';
      item.appendChild(alert);
    }

    bar.appendChild(item);
  }

  return bar;
}

export function mountHud(parentEl: HTMLElement, world: WorldState, onSelect: (id: string) => void): HudHandle {
  const panel = document.createElement('div');
  panel.id = 'hud-economy';
  panel.style.cssText = [
    'position: fixed',
    'bottom: 8px',
    'right: 8px',
    'min-width: 260px',
    'max-width: 360px',
    'padding: 8px 10px',
    'background: rgba(20, 24, 32, 0.78)',
    'border: 1px solid #3a4452',
    'border-radius: 4px',
    'color: #cdd6f4',
    'font-family: ui-monospace, monospace',
    'font-size: 12px',
    'line-height: 1.5',
    'z-index: 100',
    'pointer-events: none',
    // Tabular numerals so digits line up in counts.
    'font-variant-numeric: tabular-nums',
  ].join(';');
  parentEl.appendChild(panel);

  // ---- Header block: title + level/tier + skill points -------------------
  const headerBlock = document.createElement('div');
  headerBlock.style.cssText = [
    'display: flex',
    'flex-direction: column',
    'gap: 1px',
  ].join(';');
  const titleNode = document.createTextNode('');
  const titleLine = document.createElement('div');
  titleLine.appendChild(titleNode);
  headerBlock.appendChild(titleLine);

  const levelLine = document.createElement('div');
  levelLine.style.cssText = [
    'display: flex',
    'align-items: baseline',
    'flex-wrap: wrap',
    'gap: 6px',
  ].join(';');
  const levelText = document.createElement('span');
  const tierBadge = document.createElement('span');
  tierBadge.style.cssText = [
    'display: inline-block',
    'padding: 1px 5px',
    'font-size: 10px',
    'letter-spacing: 0.10em',
    'font-weight: 600',
    'border-radius: 2px',
    'border: 1px solid currentColor',
    'line-height: 1.3',
  ].join(';');
  const tierRemainder = document.createElement('span');
  tierRemainder.style.cssText = [
    'color: #7a8294',
    'font-size: 10.5px',
    'letter-spacing: 0.04em',
    'text-transform: uppercase',
  ].join(';');
  levelLine.appendChild(levelText);
  levelLine.appendChild(tierBadge);
  levelLine.appendChild(tierRemainder);
  headerBlock.appendChild(levelLine);

  const pointsNode = document.createTextNode('');
  const pointsLine = document.createElement('div');
  pointsLine.appendChild(pointsNode);
  headerBlock.appendChild(pointsLine);

  panel.appendChild(headerBlock);

  // ---- Site profile: biome + modifier chips ------------------------------
  const siteProfile = document.createElement('div');
  siteProfile.style.cssText = [
    'margin: 4px 0',
    'padding: 4px 0',
    'border-top: 1px solid rgba(58, 68, 82, 0.6)',
    'border-bottom: 1px solid rgba(58, 68, 82, 0.6)',
    'display: flex',
    'flex-direction: column',
    'gap: 3px',
  ].join(';');

  const biomeLine = document.createElement('div');
  biomeLine.style.cssText = [
    'display: flex',
    'justify-content: space-between',
    'align-items: baseline',
    'gap: 8px',
  ].join(';');
  const biomeLabel = document.createElement('span');
  biomeLabel.textContent = 'Site';
  biomeLabel.style.cssText = [
    'color: #7a8294',
    'letter-spacing: 0.06em',
    'text-transform: uppercase',
    'font-size: 10px',
  ].join(';');
  const biomeValue = document.createElement('span');
  biomeValue.style.cssText = ['color: #cdd6f4', 'font-weight: 600'].join(';');
  biomeLine.appendChild(biomeLabel);
  biomeLine.appendChild(biomeValue);
  siteProfile.appendChild(biomeLine);

  const chipRow = document.createElement('div');
  chipRow.style.cssText = [
    'display: flex',
    'flex-wrap: wrap',
    'gap: 4px',
    'align-items: center',
    'min-height: 16px',
  ].join(';');
  siteProfile.appendChild(chipRow);
  panel.appendChild(siteProfile);

  // ---- Network line (refactor moves this ABOVE Power) --------------------
  const networkLine = document.createElement('div');
  networkLine.style.cssText = [
    'display: flex',
    'justify-content: space-between',
    'align-items: baseline',
    'gap: 8px',
    'padding-top: 1px',
  ].join(';');
  const networkLabel = document.createElement('span');
  networkLabel.textContent = 'Network';
  networkLabel.style.cssText = [
    'color: #7a8294',
    'letter-spacing: 0.06em',
    'text-transform: uppercase',
    'font-size: 10px',
  ].join(';');
  const networkValue = document.createElement('span');
  networkValue.style.cssText = [
    'font-size: 11px',
    'font-weight: 600',
    'font-variant-numeric: tabular-nums',
  ].join(';');
  networkLine.appendChild(networkLabel);
  networkLine.appendChild(networkValue);
  panel.appendChild(networkLine);

  // ---- Power line --------------------------------------------------------
  // Format: `Power  <prod>W / <con>W  factor X.XX`. Stays a fixed three-
  // textNode + colored span so the per-frame update is cheap.
  const powerLine = document.createElement('div');
  powerLine.style.cssText = ['white-space: pre'].join(';');
  const powerNode = document.createTextNode('');
  const factorSpan = document.createElement('span');
  factorSpan.style.fontWeight = '600';
  powerLine.appendChild(powerNode);
  powerLine.appendChild(factorSpan);
  panel.appendChild(powerLine);

  // ---- Day-night phase line ----------------------------------------------
  // §2.7 day-night cycle. The world has a global 24h cycle that modulates
  // solar producers. One read-only line: "Phase  Day · solar 1.0×".
  const phaseLine = document.createElement('div');
  phaseLine.style.cssText = [
    'display: flex',
    'justify-content: space-between',
    'align-items: baseline',
    'gap: 8px',
    'padding-top: 1px',
  ].join(';');
  const phaseLabel = document.createElement('span');
  phaseLabel.textContent = 'Phase';
  phaseLabel.style.cssText = [
    'color: #7a8294',
    'letter-spacing: 0.06em',
    'text-transform: uppercase',
    'font-size: 10px',
  ].join(';');
  const phaseValue = document.createElement('span');
  phaseValue.style.cssText = [
    'font-size: 11px',
    'font-weight: 600',
    'font-variant-numeric: tabular-nums',
  ].join(';');
  phaseLine.appendChild(phaseLabel);
  phaseLine.appendChild(phaseValue);
  panel.appendChild(phaseLine);

  // Cached phase signature so the DOM only rewrites when the quadrant flips
  // (avoids per-frame text churn — the value changes 4× per real-world day).
  let lastPhaseKey = '';

  // ---- Saved indicator ---------------------------------------------------
  const savedLine = document.createElement('div');
  savedLine.style.cssText = [
    'display: flex',
    'justify-content: space-between',
    'align-items: baseline',
    'gap: 8px',
    'padding-top: 1px',
    'color: #6c7791', // FG_DIM
    'font-size: 10.5px',
    'letter-spacing: 0.04em',
    'text-transform: uppercase',
  ].join(';');
  const savedLabel = document.createElement('span');
  savedLabel.textContent = 'Saved';
  const savedValue = document.createElement('span');
  savedValue.style.cssText = ['font-variant-numeric: tabular-nums'].join(';');
  savedLine.appendChild(savedLabel);
  savedLine.appendChild(savedValue);
  panel.appendChild(savedLine);

  // ---- Objective line ----------------------------------------------------
  // Current short-term goal from the objectives ladder. Same FG_DIM label /
  // ACCENT cyan value vocabulary as the Site/Network/Saved rows. Cached on
  // `lastObjectiveLabel` so the DOM only rewrites when the label changes.
  const objectiveLine = document.createElement('div');
  objectiveLine.style.cssText = [
    'display: flex',
    'justify-content: space-between',
    'align-items: baseline',
    'gap: 8px',
    'padding-top: 1px',
    'margin-top: 3px',
    'border-top: 1px solid rgba(58, 68, 82, 0.4)',
  ].join(';');
  const objectiveLabel = document.createElement('span');
  objectiveLabel.textContent = 'Objective';
  objectiveLabel.style.cssText = [
    'color: #7a8294', // FG_DIM
    'letter-spacing: 0.06em',
    'text-transform: uppercase',
    'font-size: 10px',
  ].join(';');
  const objectiveValue = document.createElement('span');
  objectiveValue.style.cssText = [
    'color: #7dd3e8', // ACCENT cyan
    'font-size: 11px',
    'font-weight: 600',
    // Long labels wrap rather than overflow the panel's max-width.
    'word-break: break-word',
    'text-align: right',
  ].join(';');
  objectiveLine.appendChild(objectiveLabel);
  objectiveLine.appendChild(objectiveValue);
  panel.appendChild(objectiveLine);

  // ---- Buildings enumeration section -------------------------------------
  // A thin divider rule + a flex column. The row layout per category is a
  // grid: [label][entries]. The whole section's DOM is rebuilt only when
  // the buildings signature changes (see `lastBuildingsKey`); otherwise the
  // per-frame branch is a single string-compare.
  const buildingsSection = document.createElement('div');
  buildingsSection.style.cssText = [
    'margin: 4px 0 0',
    'padding-top: 4px',
    'border-top: 1px solid rgba(58, 68, 82, 0.6)',
    'display: flex',
    'flex-direction: column',
    'gap: 2px',
  ].join(';');
  panel.appendChild(buildingsSection);

  // ---- Alarms row --------------------------------------------------------
  // Conditional — only present in the DOM when an alarm fires. We keep the
  // container around (and toggle display:none) so layout doesn't shift.
  const alarmsRow = document.createElement('div');
  alarmsRow.style.cssText = [
    'margin-top: 3px',
    'padding: 2px 0',
    'color: #f5a742', // WARN amber
    'font-size: 11px',
    'letter-spacing: 0.02em',
    'display: none',
    // Long resource lists wrap rather than overflow.
    'word-break: break-word',
  ].join(';');
  panel.appendChild(alarmsRow);

  // ---- Inventory hint ---------------------------------------------------
  const inventoryHint = document.createElement('div');
  inventoryHint.textContent = 'Inventory (I)';
  inventoryHint.style.cssText = [
    'margin-top: 3px',
    'padding-top: 3px',
    'border-top: 1px solid rgba(58, 68, 82, 0.4)',
    'color: #4a5365', // FG_MUTED
    'font-size: 10px',
    'letter-spacing: 0.08em',
    'text-transform: uppercase',
  ].join(';');
  panel.appendChild(inventoryHint);

  // Cached signatures — skip DOM writes when input is unchanged.
  let lastModifiersKey = '';
  let lastBiome = '';
  /** Last-rendered buildings signature. Walked from `enumerateBuildings`:
   *  category|defId:count joined. The buildings section rebuilds only when
   *  this string changes. */
  let lastBuildingsKey = '';
  /** Last-rendered alarms signature so the alarm DOM stays stable when the
   *  fires don't change frame-to-frame. */
  let lastAlarmsKey = '';
  /** Last-rendered objective label (or '' for the "all complete / none"
   *  state). Gates the DOM write so the cyan value isn't repainted on every
   *  frame. */
  let lastObjectiveLabel = '\0'; // sentinel that no real label can equal

  function buildChip(id: ModifierId): HTMLSpanElement {
    const def = MODIFIER_DEFS[id];
    const palette = CHIP_PALETTE[def.category];
    const chip = document.createElement('span');
    chip.textContent = def.displayName;
    chip.title = def.description + (def.placeholder ? ' (placeholder — system pending)' : '');
    chip.style.cssText = [
      'display: inline-block',
      'padding: 1px 6px',
      `color: ${palette.fg}`,
      `background: ${palette.bg}`,
      `border: 1px solid ${palette.border}`,
      'border-radius: 3px',
      'font-size: 10px',
      'letter-spacing: 0.05em',
      'text-transform: uppercase',
      'line-height: 1.4',
      def.placeholder ? 'border-style: dashed' : '',
    ].filter(Boolean).join(';');
    return chip;
  }

  function renderChipRow(modifiers: ReadonlyArray<ModifierId>): void {
    while (chipRow.firstChild) chipRow.removeChild(chipRow.firstChild);
    if (modifiers.length === 0) {
      const empty = document.createElement('span');
      empty.textContent = '—';
      empty.style.cssText = [
        'color: #4d5566',
        'font-size: 11px',
        'letter-spacing: 0.1em',
      ].join(';');
      chipRow.appendChild(empty);
      return;
    }
    for (const id of modifiers) chipRow.appendChild(buildChip(id));
  }

  /** Render the per-category buildings rows. Called only when the signature
   *  changes. Empty buildings → a single muted "no buildings placed" line. */
  function renderBuildingsSection(rows: ReadonlyArray<BuildingsEnumerationRow>): void {
    while (buildingsSection.firstChild) {
      buildingsSection.removeChild(buildingsSection.firstChild);
    }
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'no buildings placed';
      empty.style.cssText = [
        'color: #4d5566',
        'font-size: 11px',
        'letter-spacing: 0.04em',
        'font-style: italic',
      ].join(';');
      buildingsSection.appendChild(empty);
      return;
    }
    for (const row of rows) {
      const rowEl = document.createElement('div');
      rowEl.style.cssText = [
        'display: grid',
        'grid-template-columns: 70px 1fr',
        'align-items: baseline',
        'gap: 6px',
        'padding: 1px 0',
      ].join(';');

      const labelEl = document.createElement('span');
      labelEl.textContent = row.label;
      labelEl.style.cssText = [
        'color: #7a8294', // FG_DIM
        'font-size: 10px',
        'letter-spacing: 0.08em',
        'text-transform: uppercase',
      ].join(';');

      const entriesEl = document.createElement('span');
      entriesEl.textContent = row.entries
        .map((e) => `${e.displayName} ×${e.count}`)
        .join(' · ');
      entriesEl.style.cssText = [
        'color: #cdd6f4', // FG
        'font-size: 11px',
        'word-break: break-word',
      ].join(';');

      rowEl.appendChild(labelEl);
      rowEl.appendChild(entriesEl);
      buildingsSection.appendChild(rowEl);
    }
  }

  /** Build a deterministic signature string for a buildings enumeration so
   *  the section's DOM can be cached frame-to-frame. */
  function buildingsKey(rows: ReadonlyArray<BuildingsEnumerationRow>): string {
    return rows
      .map((r) => r.category + '|' + r.entries.map((e) => `${e.defId}:${e.count}`).join(','))
      .join(';');
  }

  /** Build a signature for the alarms state — order-insensitive within each
   *  bucket (the helper returns them in ALL_RESOURCES order anyway). */
  function alarmsKey(rep: AlarmsReport): string {
    return 'F:' + rep.full.join(',') + '|L:' + rep.low.join(',');
  }

  function renderAlarms(rep: AlarmsReport): void {
    if (rep.full.length === 0 && rep.low.length === 0) {
      alarmsRow.style.display = 'none';
      alarmsRow.textContent = '';
      return;
    }
    while (alarmsRow.firstChild) alarmsRow.removeChild(alarmsRow.firstChild);
    if (rep.full.length > 0) {
      const fullEl = document.createElement('div');
      fullEl.textContent = `FULL: ${rep.full.join(', ')}`;
      alarmsRow.appendChild(fullEl);
    }
    if (rep.low.length > 0) {
      const lowEl = document.createElement('div');
      lowEl.textContent = `LOW: ${rep.low.join(', ')}`;
      alarmsRow.appendChild(lowEl);
    }
    alarmsRow.style.display = 'block';
  }

  /** Format a number for display. Integers shown without decimal; otherwise
   *  one decimal place. The economy uses fractional inventories internally
   *  (rate × dt) so we round for display. */
  const fmt = (n: number): string => {
    if (Number.isInteger(n)) return n.toString();
    return n.toFixed(1);
  };

  let bar = renderMultiIslandBar(world, '', onSelect, new Map());
  parentEl.appendChild(bar);
  let lastBarSignature = '';

  function update(
    state: IslandState,
    net: Record<ResourceId, number>,
    power: PowerBalance,
    spec: IslandSpec,
    ncState: NetworkConsciousnessState,
    saveAgeSec: number | null,
    vehiclesEnRoute: number,
    objective: Objective | null,
    activeIslandId: string,
    islandPower: Map<string, PowerBalance>,
  ): void {
    const need = xpForLevel(state.level + 1);
    titleNode.textContent = spec.name;
    levelText.textContent = `Level ${state.level}   XP ${fmt(state.xp)} / ${fmt(need)}`;
    levelText.style.color = '#cdd6f4';

    // Tier indicator chip + "N levels to TX" remainder.
    const tier = tierForLevel(state.level);
    tierBadge.textContent = `T${tier}`;
    const palette = tierBadgeColor(state.level, tier);
    tierBadge.style.color = palette;
    if (tier >= 5) {
      tierRemainder.textContent = '· MAX TIER';
    } else {
      const nextTierLevel = NEXT_TIER_LEVEL[tier];
      const gap = nextTierLevel - state.level;
      tierRemainder.textContent = `· ${gap} to T${tier + 1}`;
    }
    pointsNode.textContent = `Skill points: ${state.unspentSkillPoints}`;

    // Site profile — biome name + chip row.
    if (spec.biome !== lastBiome) {
      biomeValue.textContent = BIOME_DEFS[spec.biome].displayName;
      lastBiome = spec.biome;
    }
    const modifiersKey = spec.modifiers.join(',');
    if (modifiersKey !== lastModifiersKey) {
      renderChipRow(spec.modifiers);
      lastModifiersKey = modifiersKey;
    }

    // Network Consciousness line.
    const enRouteSuffix = vehiclesEnRoute > 0 ? ` · +${vehiclesEnRoute} en route` : '';
    if (ncState.tier3PlusCount === 0) {
      networkValue.textContent = enRouteSuffix === '' ? '—' : `—${enRouteSuffix}`;
      networkValue.style.color = vehiclesEnRoute > 0 ? '#7dd3e8' : '#4d5566';
    } else {
      const buffPct = Math.round((ncState.globalProductionBuff - 1) * 100);
      networkValue.textContent =
        `${ncState.tier3PlusCount} at T3+ · NC tier ${ncState.milestone} · +${buffPct}%${enRouteSuffix}`;
      networkValue.style.color = '#7dd3e8';
    }

    // Power line.
    const prodStr = fmt(power.produced).padStart(4, ' ');
    const conStr = fmt(power.consumed).padStart(4, ' ');
    const factorStr = power.factor.toFixed(2);
    powerNode.textContent = `Power      ${prodStr}W / ${conStr}W  factor `;
    factorSpan.textContent = factorStr;
    factorSpan.style.color = powerColor(power.factor);

    // Day-night phase line (§2.7). The value updates every frame for the
    // progress sub-readout; the colour-coded quadrant name is cached on the
    // last-rendered key so we don't repaint identical text.
    const nowMs = Date.now();
    const phaseName = dayPhaseName(nowMs);
    // Sub-quadrant progress: phase ∈ [0,1) → quadrant-local progress ∈ [0,1).
    const phaseFrac = (dayPhase(nowMs) * 4) % 1;
    const mul = solarMultiplier(nowMs);
    const phaseKey = `${phaseName}|${Math.floor(phaseFrac * 100)}|${mul}`;
    if (phaseKey !== lastPhaseKey) {
      phaseValue.textContent =
        `${PHASE_LABEL[phaseName]} ${Math.floor(phaseFrac * 100)}% · solar ${mul.toFixed(1)}×`;
      phaseValue.style.color = PHASE_COLOR[phaseName];
      lastPhaseKey = phaseKey;
    }

    // Save-age indicator.
    if (saveAgeSec === null) {
      savedValue.textContent = '—';
    } else if (saveAgeSec < 2) {
      savedValue.textContent = 'just now';
    } else {
      savedValue.textContent = `${saveAgeSec}s ago`;
    }

    // Objective — gated on label so the DOM doesn't repaint each frame.
    // Null (all ladder entries complete) is unreachable today (the §13.4
    // stubs have `check: () => false`) but the empty path is shown as an
    // em dash for forward-compat.
    const objLabel = objective?.label ?? '—';
    if (objLabel !== lastObjectiveLabel) {
      objectiveValue.textContent = objLabel;
      objectiveValue.style.color = objective === null ? '#4d5566' : '#7dd3e8';
      lastObjectiveLabel = objLabel;
    }

    // Buildings enumeration — gated on signature.
    const rows = enumerateBuildings(spec.buildings);
    const bkey = buildingsKey(rows);
    if (bkey !== lastBuildingsKey) {
      renderBuildingsSection(rows);
      lastBuildingsKey = bkey;
    }

    // Alarms — gated on signature so the WARN amber row doesn't redraw
    // every frame when nothing changed.
    const alarms = computeAlarms(state, net);
    const akey = alarmsKey(alarms);
    if (akey !== lastAlarmsKey) {
      renderAlarms(alarms);
      lastAlarmsKey = akey;
    }

    // Multi-island bar — cache rebuild, update highlight every frame.
    const sig = world.islands.filter(i => i.populated).map(i => i.id).join(',');
    if (sig !== lastBarSignature) {
      lastBarSignature = sig;
      const newBar = renderMultiIslandBar(world, activeIslandId, onSelect, islandPower);
      bar.replaceWith(newBar);
      bar = newBar;
    }
    // Always update active highlight (cheaper than rebuild)
    for (const child of bar.children) {
      const el = child as HTMLElement;
      const id = el.dataset.islandId;
      if (!id) continue;
      el.style.background = id === activeIslandId ? '#2d5878' : 'transparent';
    }
  }

  return { el: panel, update };
}
