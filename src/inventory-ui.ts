// Inventory modal — full per-resource readout, toggled via KeyI.
//
// Step-19: the HUD's per-ResourceId Inventory block was retired (the
// catalog at ~50 resources made it unreadable). The full table moves
// here, where the player can filter by category and search by id.
//
// Visual idiom matches buildings-ui.ts and skilltree-ui.ts: centered
// modal shell, letter-spaced ACCENT caps header, FG_DIM secondary text,
// filter-chip strip, scrollable body. Density beats whitespace.

import type { IslandState } from './economy.js';
import { cap, inv } from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import type { IslandSpec } from './world.js';

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests / docs
// ---------------------------------------------------------------------------

/**
 * Resource filter categories surfaced in the panel. These are PRIMARILY for
 * UI grouping — they aren't strictly the §6.x catalog tiers (Raw=T0,
 * Refined=T1, …). For resources that belong in multiple buckets (e.g.,
 * biofuel is both a Refined T1 product AND a Fuel), the brief mandates
 * Fuel/Liquid take precedence over Raw/Refined for filter purposes.
 */
export type ResourceCategory =
  | 'raw'
  | 'refined'
  | 'components'
  | 'fuel'
  | 'liquid'
  | 'rare'
  | 'misc';

/**
 * Primary filter category per resource. Categorisation is best-effort —
 * a future spec pass may carve cleaner lines, but the buckets here match
 * the brief verbatim. Fuels and Liquids take precedence over Raw/Refined
 * (a single resource lands in exactly one bucket here).
 */
export const RESOURCE_CATEGORY: Readonly<Record<ResourceId, ResourceCategory>> = {
  // T0 raws (§6.1 / §6.2)
  wood: 'raw',
  iron_ore: 'raw',
  coal: 'raw',
  stone: 'raw',
  sand: 'raw',
  salt: 'raw',
  quartz: 'raw',
  // §6.4 T3 mineral raws (for slag reprocessing + nuclear fuel)
  gold_ore: 'raw',
  silver_ore: 'raw',
  rare_earth: 'raw',
  uranium_ore: 'raw',
  // Liquids (Fuel/Liquid takes precedence over Raw)
  fresh_water: 'liquid',
  saltwater: 'liquid',
  crude_oil: 'liquid',
  natural_gas: 'liquid',
  hydrogen: 'liquid',
  oxygen: 'liquid',
  argon: 'liquid',
  // T1 refined
  iron_ingot: 'refined',
  coke: 'refined',
  pig_iron: 'refined',
  lumber: 'refined',
  glass: 'refined',
  // T2 components
  bolt: 'components',
  steel: 'components',
  gear: 'components',
  wire: 'components',
  microchip: 'components',
  pcb: 'components',
  circuit_board: 'components',
  processor: 'components',
  computing_module: 'components',
  quantum_chip: 'components',
  ai_core: 'components',
  exotic_alloy: 'components',
  carbon_fiber: 'components',
  foundation_kit: 'components',
  // Fuels
  biofuel: 'fuel',
  diesel: 'fuel',
  aviation_kerosene: 'fuel',
  cryogenic_hydrogen: 'fuel',
  plasma_charge: 'fuel',
  // T2/T3 liquids (chemistry intermediates)
  naphtha: 'liquid',
  chlorine: 'liquid',
  lubricant: 'liquid',
  nitrogen: 'liquid',
  cryo_coolant: 'liquid',
  // T3 refined intermediate
  silicon: 'refined',
  // T4/T5 raws + components — Rare bucket
  helium_3: 'rare',
  casimir_energy: 'rare',
  reality_anchor: 'rare',
  eldritch_processor: 'rare',
  phase_converter: 'rare',
  // §6.6 T5 component (memetic core)
  memetic_core: 'rare',
  aetheric_current: 'rare',
  tachyon_stream: 'rare',
  dark_matter: 'rare',
  strange_matter: 'rare',
  quantum_foam: 'rare',
  spacetime_fragment: 'rare',
  higgs_flux: 'rare',
  // T5→T6 transition artifact + T6 Orbital (step 20, §13.4 / §14)
  ascendant_core: 'rare',
  antimatter_propellant: 'fuel',     // §11.7 T6 launch fuel
  scanner_sat: 'components',          // §14.3 satellite payload
  comm_sat: 'components',             // §14.3 satellite payload
  orbital_insertion_package: 'components', // §14.7 T6 Foundation-Kit equivalent
  sweeper_sat: 'components',          // §14.8 debris sweeper payload
  repair_drone: 'rare',               // §14.12 orbital repair unit
  repair_pack: 'components',          // §14.12 repair consumable
  // Misc
  scrap: 'misc',
  slag: 'misc',
  // §13.4 T5 endgame artifact
  genesis_cell: 'rare',
};

/** Filter chips shown above the resource list. `'all'` is the default. */
export type ResourceFilter = ResourceCategory | 'all';

/** Display label for each filter chip. */
export const RESOURCE_FILTER_LABEL: Readonly<Record<ResourceFilter, string>> = {
  all: 'All',
  raw: 'Raw',
  refined: 'Refined',
  components: 'Components',
  fuel: 'Fuel',
  liquid: 'Liquid',
  rare: 'Rare',
  misc: 'Misc',
};

/** Order chips appear in the filter strip. */
export const RESOURCE_FILTER_ORDER: ReadonlyArray<ResourceFilter> = [
  'all',
  'raw',
  'refined',
  'components',
  'fuel',
  'liquid',
  'rare',
  'misc',
];

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const PANEL_BG = 'rgba(14, 18, 26, 0.92)';
const PANEL_BORDER = '#3a4452';
const PANEL_HEADER_BORDER = '#4a5a72';
const FG = '#cdd6f4';
const FG_DIM = '#6c7791';
const FG_MUTED = '#4a5365';
const ACCENT = '#7dd3e8';
const ACCENT_DIM = '#3d6f7c';
const WARN = '#f5a742';
const STRIP_BG = 'rgba(20, 24, 32, 0.6)';
const ROW_BG_HOVER = 'rgba(125, 211, 232, 0.06)';

function styled(el: HTMLElement, css: string): void {
  el.style.cssText = css;
}

function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  styled(
    b,
    [
      'background: #1a1f2a',
      `color: ${FG}`,
      `border: 1px solid ${PANEL_BORDER}`,
      'padding: 3px 9px',
      'cursor: pointer',
      'font-family: ui-monospace, monospace',
      'font-size: 11px',
      'letter-spacing: 0.04em',
      'text-transform: uppercase',
      'transition: background 80ms ease, border-color 80ms ease',
    ].join(';'),
  );
  b.addEventListener('mouseenter', () => {
    b.style.background = '#252b38';
    b.style.borderColor = ACCENT_DIM;
  });
  b.addEventListener('mouseleave', () => {
    b.style.background = '#1a1f2a';
    b.style.borderColor = PANEL_BORDER;
  });
  b.addEventListener('click', () => {
    onClick();
    b.blur();
  });
  return b;
}

export interface InventoryUi {
  readonly el: HTMLDivElement;
  /** Apply the current state to all visible rows. Cheap when hidden. */
  refresh(state: IslandState, net: Record<ResourceId, number>): void;
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
}

export interface InventoryUiDeps {
  /** Active island state getter — invoked each `refresh`. */
  getState(): IslandState;
  /** Active island spec getter — only used for the header label. */
  getSpec(): IslandSpec;
}

interface RowRef {
  readonly row: HTMLDivElement;
  readonly idEl: HTMLSpanElement;
  readonly amountEl: HTMLSpanElement;
  readonly rateEl: HTMLSpanElement;
}

/** Format a number for display. Integers no decimal; otherwise 1 dp. */
function fmt(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(1);
}

/** Format a rate with sign and two decimals. Zero rate rendered as dim
 *  placeholder. */
function fmtRate(n: number): string {
  if (n === 0) return '·';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}/s`;
}

export function mountInventoryUi(
  parentEl: HTMLElement,
  deps: InventoryUiDeps,
): InventoryUi {
  const getState = (): IslandState => deps.getState();
  const getSpec = (): IslandSpec => deps.getSpec();

  let visible = false;
  let activeFilter: ResourceFilter = 'all';
  let searchQuery = '';
  /** Show resources with inv=0 / cap=0 / net=0. The default is to hide
   *  them so the list stays scannable; the chip toggles it. */
  let showEmpty = false;

  const rowRefs = new Map<ResourceId, RowRef>();
  const filterChipRefs = new Map<ResourceFilter, HTMLButtonElement>();

  // ---- Scrim + panel shell ----------------------------------------------
  const scrim = document.createElement('div');
  scrim.id = 'inventory-scrim';
  styled(
    scrim,
    [
      'position: fixed',
      'inset: 0',
      'background: rgba(10, 14, 20, 0.55)',
      'z-index: 200',
      'display: none',
      'pointer-events: none',
      'backdrop-filter: blur(1.5px)',
    ].join(';'),
  );

  const panel = document.createElement('div');
  panel.id = 'inventory-panel';
  styled(
    panel,
    [
      'position: fixed',
      'top: 50%',
      'left: 50%',
      'transform: translate(-50%, -50%)',
      'width: min(720px, calc(100vw - 32px))',
      'max-height: calc(100vh - 32px)',
      `background: ${PANEL_BG}`,
      `border: 1px solid ${PANEL_BORDER}`,
      'border-radius: 2px',
      'box-shadow: 0 24px 48px -12px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(125, 211, 232, 0.05)',
      'z-index: 201',
      'pointer-events: auto',
      `color: ${FG}`,
      'font-family: ui-monospace, monospace',
      'font-size: 12px',
      'line-height: 1.45',
      'font-variant-numeric: tabular-nums',
      'display: flex',
      'flex-direction: column',
      'overflow: hidden',
    ].join(';'),
  );

  // ---- Header ----------------------------------------------------------
  const header = document.createElement('div');
  styled(
    header,
    [
      'display: flex',
      'align-items: center',
      'justify-content: space-between',
      'padding: 10px 16px 9px',
      `border-bottom: 1px solid ${PANEL_HEADER_BORDER}`,
      `background: ${STRIP_BG}`,
      'gap: 14px',
    ].join(';'),
  );

  const headerTitleWrap = document.createElement('div');
  styled(headerTitleWrap, 'display: flex; align-items: baseline; gap: 10px; flex: 0 0 auto');
  const titleEl = document.createElement('span');
  titleEl.textContent = 'INVENTORY';
  styled(
    titleEl,
    [
      `color: ${ACCENT}`,
      'font-size: 12px',
      'font-weight: 600',
      'letter-spacing: 0.22em',
    ].join(';'),
  );
  const subtitleEl = document.createElement('span');
  styled(
    subtitleEl,
    [
      `color: ${FG_DIM}`,
      'font-size: 10px',
      'letter-spacing: 0.12em',
      'text-transform: uppercase',
    ].join(';'),
  );
  headerTitleWrap.appendChild(titleEl);
  headerTitleWrap.appendChild(subtitleEl);

  const closeBtn = makeButton('Close (I)', () => hide());

  header.appendChild(headerTitleWrap);
  header.appendChild(closeBtn);

  // ---- Filter + search strip -------------------------------------------
  const controlStrip = document.createElement('div');
  styled(
    controlStrip,
    [
      'display: flex',
      'align-items: center',
      'gap: 8px',
      'flex-wrap: wrap',
      'padding: 8px 16px',
      `border-bottom: 1px solid ${PANEL_BORDER}`,
      'background: rgba(20, 24, 32, 0.4)',
    ].join(';'),
  );

  const filterLabel = document.createElement('span');
  filterLabel.textContent = 'FILTER';
  styled(
    filterLabel,
    [
      `color: ${FG_DIM}`,
      'font-size: 10px',
      'letter-spacing: 0.14em',
      'margin-right: 4px',
    ].join(';'),
  );
  controlStrip.appendChild(filterLabel);

  function filterChip(category: ResourceFilter): HTMLButtonElement {
    const chip = document.createElement('button');
    chip.textContent = RESOURCE_FILTER_LABEL[category];
    styled(
      chip,
      [
        'background: transparent',
        `color: ${FG_DIM}`,
        `border: 1px solid ${FG_MUTED}`,
        'padding: 2px 9px',
        'cursor: pointer',
        'font-family: ui-monospace, monospace',
        'font-size: 10px',
        'letter-spacing: 0.08em',
        'text-transform: uppercase',
        'border-radius: 2px',
        'transition: background 80ms ease, border-color 80ms ease, color 80ms ease',
      ].join(';'),
    );
    chip.addEventListener('click', () => {
      activeFilter = category;
      paintFilterChips();
      paintRows();
      chip.blur();
    });
    filterChipRefs.set(category, chip);
    return chip;
  }
  for (const c of RESOURCE_FILTER_ORDER) controlStrip.appendChild(filterChip(c));

  // "show empty" toggle — same chip styling, separate from category filter.
  const showEmptyChip = document.createElement('button');
  showEmptyChip.textContent = 'Show Empty';
  styled(
    showEmptyChip,
    [
      'background: transparent',
      `color: ${FG_DIM}`,
      `border: 1px solid ${FG_MUTED}`,
      'padding: 2px 9px',
      'cursor: pointer',
      'font-family: ui-monospace, monospace',
      'font-size: 10px',
      'letter-spacing: 0.08em',
      'text-transform: uppercase',
      'border-radius: 2px',
      'margin-left: 12px',
      'transition: background 80ms ease, border-color 80ms ease, color 80ms ease',
    ].join(';'),
  );
  showEmptyChip.addEventListener('click', () => {
    showEmpty = !showEmpty;
    paintShowEmptyChip();
    paintRows();
    showEmptyChip.blur();
  });
  controlStrip.appendChild(showEmptyChip);

  // Search box — substring match against the resource id.
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'search…';
  styled(
    searchInput,
    [
      'flex: 1 1 140px',
      'min-width: 100px',
      'max-width: 240px',
      'background: rgba(10, 14, 20, 0.6)',
      `color: ${FG}`,
      `border: 1px solid ${PANEL_BORDER}`,
      'padding: 3px 8px',
      'font-family: ui-monospace, monospace',
      'font-size: 11px',
      'letter-spacing: 0.04em',
      'border-radius: 2px',
      'outline: none',
      'margin-left: auto',
    ].join(';'),
  );
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    paintRows();
  });
  // Don't let typed text dispatch as keybindings (KeyI etc.) while the user
  // is typing in the search box.
  searchInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
  });
  controlStrip.appendChild(searchInput);

  function paintFilterChips(): void {
    for (const [key, chip] of filterChipRefs) {
      if (key === activeFilter) {
        chip.style.background = 'rgba(125, 211, 232, 0.10)';
        chip.style.borderColor = ACCENT;
        chip.style.color = ACCENT;
      } else {
        chip.style.background = 'transparent';
        chip.style.borderColor = FG_MUTED;
        chip.style.color = FG_DIM;
      }
    }
  }

  function paintShowEmptyChip(): void {
    if (showEmpty) {
      showEmptyChip.style.background = 'rgba(125, 211, 232, 0.10)';
      showEmptyChip.style.borderColor = ACCENT;
      showEmptyChip.style.color = ACCENT;
    } else {
      showEmptyChip.style.background = 'transparent';
      showEmptyChip.style.borderColor = FG_MUTED;
      showEmptyChip.style.color = FG_DIM;
    }
  }

  // ---- Body — resource rows --------------------------------------------
  const body = document.createElement('div');
  styled(
    body,
    [
      'display: flex',
      'flex-direction: column',
      'gap: 1px',
      'overflow-y: auto',
      'flex: 1 1 auto',
      'padding: 4px 8px 8px',
    ].join(';'),
  );

  // Empty-state node (shown when the list is filtered to nothing).
  const emptyState = document.createElement('div');
  emptyState.textContent = 'no inventory yet — place an Extractor or Workshop.';
  styled(
    emptyState,
    [
      `color: ${FG_MUTED}`,
      'font-size: 11px',
      'letter-spacing: 0.04em',
      'font-style: italic',
      'padding: 12px 16px',
      'display: none',
    ].join(';'),
  );
  body.appendChild(emptyState);

  // Build one row per ResourceId. Visibility is toggled per-paint.
  function makeRow(r: ResourceId): HTMLDivElement {
    const row = document.createElement('div');
    styled(
      row,
      [
        'display: grid',
        'grid-template-columns: 1fr 1fr 110px',
        'align-items: baseline',
        'gap: 12px',
        'padding: 3px 10px',
        'border-radius: 2px',
        'transition: background 80ms ease',
      ].join(';'),
    );
    row.addEventListener('mouseenter', () => {
      row.style.background = ROW_BG_HOVER;
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = '';
    });
    const idEl = document.createElement('span');
    idEl.textContent = r;
    styled(idEl, [`color: ${FG}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(';'));
    const amountEl = document.createElement('span');
    styled(
      amountEl,
      [
        `color: ${FG_DIM}`,
        'font-size: 11px',
        'font-variant-numeric: tabular-nums',
        'text-align: right',
      ].join(';'),
    );
    const rateEl = document.createElement('span');
    styled(
      rateEl,
      [
        'font-size: 11px',
        'font-variant-numeric: tabular-nums',
        'text-align: right',
      ].join(';'),
    );
    row.appendChild(idEl);
    row.appendChild(amountEl);
    row.appendChild(rateEl);
    rowRefs.set(r, { row, idEl, amountEl, rateEl });
    return row;
  }
  for (const r of ALL_RESOURCES) body.appendChild(makeRow(r));

  function rowVisible(
    r: ResourceId,
    have: number,
    capVal: number,
    rate: number,
  ): boolean {
    // Filter chip.
    if (activeFilter !== 'all') {
      const cat = RESOURCE_CATEGORY[r];
      if (cat !== activeFilter) return false;
    }
    // Search.
    if (searchQuery && !r.includes(searchQuery)) return false;
    // Hide empty unless toggled.
    if (!showEmpty && have === 0 && capVal === 0 && rate === 0) return false;
    return true;
  }

  /** Apply current state to every row, sort by net rate desc, then by id. */
  function paintRows(): void {
    const state = getState();
    const net = lastNet;
    // Compute per-resource values once, decide visibility, then re-order
    // visible rows by (rate desc, id asc).
    const visibleRows: Array<{
      r: ResourceId;
      have: number;
      capVal: number;
      rate: number;
      el: HTMLDivElement;
    }> = [];
    for (const r of ALL_RESOURCES) {
      const ref = rowRefs.get(r);
      if (!ref) continue;
      const have = inv(state, r);
      const capVal = cap(state, r);
      const rate = net[r] ?? 0;
      if (!rowVisible(r, have, capVal, rate)) {
        ref.row.style.display = 'none';
        continue;
      }
      ref.row.style.display = '';
      ref.amountEl.textContent = `${fmt(have)} / ${capVal === 0 ? '—' : fmt(capVal)}`;
      ref.rateEl.textContent = fmtRate(rate);
      ref.rateEl.style.color =
        rate > 0 ? '#7dd3a0' : rate < 0 ? WARN : FG_MUTED;
      visibleRows.push({ r, have, capVal, rate, el: ref.row });
    }
    visibleRows.sort((a, b) => {
      if (b.rate !== a.rate) return b.rate - a.rate;
      return a.r < b.r ? -1 : a.r > b.r ? 1 : 0;
    });
    // Re-attach in sorted order. DOM order = visual order. Empty-state
    // node stays at the top (re-attached first if visible).
    while (body.firstChild) body.removeChild(body.firstChild);
    body.appendChild(emptyState);
    if (visibleRows.length === 0) {
      emptyState.style.display = 'block';
    } else {
      emptyState.style.display = 'none';
      for (const v of visibleRows) body.appendChild(v.el);
    }
    // Reattach hidden rows so the next paint can find them via rowRefs
    // without re-creating elements.
    for (const r of ALL_RESOURCES) {
      const ref = rowRefs.get(r);
      if (!ref) continue;
      if (ref.row.parentNode !== body) {
        body.appendChild(ref.row);
        if (ref.row.style.display !== 'none') ref.row.style.display = 'none';
      }
    }
  }

  /** Cached net rates so paint passes triggered by filter/search clicks
   *  use the most recent economy snapshot without forcing the caller to
   *  re-pass net. The ticker calls `refresh(state, net)` every frame. */
  let lastNet: Record<ResourceId, number> = {} as Record<ResourceId, number>;

  function refresh(state: IslandState, net: Record<ResourceId, number>): void {
    if (!visible) return;
    void state;
    lastNet = net;
    subtitleEl.textContent = `/ ${getSpec().name}`;
    paintRows();
  }

  // ---- Footer hint -----------------------------------------------------
  const footer = document.createElement('div');
  styled(
    footer,
    [
      'padding: 7px 16px',
      `border-top: 1px solid ${PANEL_HEADER_BORDER}`,
      `background: ${STRIP_BG}`,
      `color: ${FG_DIM}`,
      'font-size: 10px',
      'letter-spacing: 0.06em',
      'display: flex',
      'justify-content: space-between',
      'text-transform: uppercase',
    ].join(';'),
  );
  const footerL = document.createElement('span');
  footerL.textContent = 'I or esc to close · click a chip to filter';
  const footerR = document.createElement('span');
  footerR.textContent = 'sorted by net rate · §6';
  footer.appendChild(footerL);
  footer.appendChild(footerR);

  panel.appendChild(header);
  panel.appendChild(controlStrip);
  panel.appendChild(body);
  panel.appendChild(footer);

  parentEl.appendChild(scrim);
  parentEl.appendChild(panel);
  panel.style.display = 'none';

  function show(): void {
    if (visible) return;
    visible = true;
    panel.style.display = 'flex';
    scrim.style.display = 'block';
    paintFilterChips();
    paintShowEmptyChip();
    // The first paint runs against whatever was the last cached net; the
    // ticker's next refresh overwrites it on the same frame, so this is
    // really just a "don't show stale layout flash" priming step.
    paintRows();
  }
  function hide(): void {
    if (!visible) return;
    visible = false;
    panel.style.display = 'none';
    scrim.style.display = 'none';
  }
  function toggle(): boolean {
    if (visible) hide();
    else show();
    return visible;
  }

  return {
    el: panel,
    refresh,
    show,
    hide,
    toggle,
    isVisible: () => visible,
  };
}
