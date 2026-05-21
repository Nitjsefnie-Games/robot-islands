// Inventory modal — full per-resource readout, toggled via KeyI.
//
// Phase 4b.4: migrated to the shared ri-modal shell (mountModal from
// ui-modal.ts). Body is now a .ri-table with six columns: Resource | Stock |
// Cap | Fill | Net/s | Time to ⤓/⤒. Filter chips, search input, and sort
// buttons live in the modal filter/footer strips. Inline styles replaced with
// .ri-* classes where possible.

import type { IslandState } from './economy.js';
import { cap, inv } from './economy.js';
import { averageRate, pruneRateBuffer, snapshotInventory, type RateSample } from './rate-history.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import type { IslandSpec } from './world.js';
import { mountModal } from './ui-modal.js';

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
  // §6.1 T0 mineral raw: limestone (Task 1.2)
  limestone: 'raw',
  clay: 'raw',
  sulfur: 'raw',
  phosphate: 'raw',
  graphite: 'raw',
  copper_ore: 'raw',
  tin_ore: 'raw',
  lead_ore: 'raw',
  bauxite: 'raw',
  // Phase 2 — T1 refined chains (§6.2 / §7.5)
  quicklime: 'refined',
  slaked_lime: 'refined',
  brick: 'refined',
  mortar: 'refined',
  cement: 'refined',
  concrete: 'refined',
  charcoal: 'refined',
  plank: 'refined',
  copper_ingot: 'refined',
  tin_ingot: 'refined',
  lead_ingot: 'refined',
  solder: 'refined',
  // Phase 7 — Bronze + Brass (§7.2)
  bronze: 'refined',
  brass: 'refined',
  // Phase 8 — Aluminum chain (§7.3)
  alumina: 'refined',
  aluminum: 'refined',
  // Phase 3 — T2-T3 steel alloy chains
  manganese_ore: 'raw',
  manganese_ingot: 'refined',
  carbon_steel: 'components',
  zinc_ore: 'raw',
  zinc_ingot: 'refined',
  galvanized_steel: 'components',
  chromium_ore: 'raw',
  chromium_ingot: 'refined',
  nickel_ore: 'raw',
  nickel_ingot: 'refined',
  stainless_steel: 'components',
  tungsten_ore: 'raw',
  tungsten_ingot: 'refined',
  tool_steel: 'components',
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
  foundation_kit_enriched: 'refined',
  foundation_kit_refined: 'refined',
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
  // Phase 4 — T2 petrochemical byproducts (§7.4)
  heavy_oil: 'liquid',
  tar: 'liquid',
  asphalt: 'liquid',
  plastic_precursor: 'liquid',
  rigid_plastic: 'components',
  flexible_plastic: 'components',
  synthetic_rubber: 'components',
  // Phase 6 — T2 mechanical components (§6.3 / §7.1)
  sheet_metal: 'components',
  pipe: 'components',
  steel_beam: 'components',
  // Phase 6 — T2 mechanical fasteners (§6.3)
  bearing: 'components',
  spring: 'components',
  // Phase 6 — T2 mechanical components (§6.3)
  heavy_cable: 'components',
  // Phase 6 — T3 battery (§6.3 / §7.9)
  battery: 'components',
  // Phase 6 — T2 glass_panel (§6.3)
  glass_panel: 'components',
  // Phase 6 — T2 coolant + ceramic_insulator (§6.3)
  coolant: 'liquid',
  ceramic_insulator: 'components',
  // Phase 5 — T2 chemistry chain (§7.5)
  sulfuric_acid: 'liquid',
  hydrochloric_acid: 'liquid',
  sodium_hydroxide: 'liquid',
  // Phase 5 — T3 chemistry chain (§7.5)
  phosphor: 'rare',
  liquid_nitrogen: 'liquid',
  // T3 refined intermediate
  silicon: 'refined',
  silicon_wafer: 'components',
  transistor: 'components',
  capacitor: 'components',
  resistor: 'components',
  memory_module: 'components',
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
  // Phase 12 — T5 transcendent raws (Task 12.1)
  zero_point_flux: 'rare',
  neutronium: 'rare',
  // Phase 12 — T5 components (Task 12.2)
  probability_calculator: 'rare',
  dimensional_fold: 'rare',
  causal_regulator: 'rare',
  // Phase 12 — T5 components (Task 12.3)
  tachyonic_transmitter: 'rare',
  aether_beacon: 'rare',
  reality_engine: 'rare',
  singularity_battery_unit: 'rare',
  // T5→T6 transition artifact + T6 Orbital (step 20, §13.4 / §14)
  ascendant_core: 'rare',
  antimatter_propellant: 'fuel',     // §11.7 T6 launch fuel
  scanner_sat: 'components',          // §14.3 satellite payload
  relay_sat: 'components',            // §14.3 satellite payload
  orbital_insertion_package: 'components', // §14.7 T6 Foundation-Kit equivalent
  sweeper_sat: 'components',          // §14.8 debris sweeper payload
  mirror_sat: 'components',           // §14.3 Mirror Sat payload (solar reflector)
  repair_drone: 'rare',               // §14.12 orbital repair unit
  repair_pack: 'components',          // §14.12 repair consumable
  // Misc
  scrap: 'misc',
  slag: 'misc',
  // §13.4 T5 endgame artifact
  genesis_cell: 'rare',
  // Phase 10 — T3 minerals + alloy (Task 10.1)
  mercury: 'liquid',
  // Phase 10 — T3 minerals + alloy (Task 10.2)
  diamond_ore: 'rare',
  // Phase 10 — T3 minerals + alloy (Task 10.3)
  cryogenic_compound: 'liquid',
  // Phase 10 — T3 minerals + alloy (Task 10.4)
  magnetic_alloy: 'refined',
  // Phase 10b — T3 minerals + alloy (Task 10.4.5)
  lithium: 'rare',
  // Phase 10b — T3 power components (Task 10.5)
  magnet: 'components',
  // Phase 10b — T3 power components (Task 10.6)
  electric_motor: 'components',
  // Phase 10b — T3 power components (Task 10.7)
  generator: 'components',
  // Phase 10c — T3 mechanical assemblies (Task 10.8)
  pump: 'components',
  hydraulic_actuator: 'components',
  pneumatic_actuator: 'components',
  // Phase 10c — T3 power components (Task 10.9)
  solar_cell: 'components',
  // Phase 10c — T3 power components (Task 10.10)
  fuel_cell: 'components',
  // Phase 10c — T3 glass/ceramics (Task 10.11)
  optical_glass: 'components',
  // Phase 10c — T3 fiber spinners (Task 10.12)
  glass_fiber: 'components',
  optical_fiber: 'components',
  // Phase 11 — T4 endgame (Task 11.1)
  time_crystal: 'rare',
  // Phase 11 — T4 endgame (Task 11.2)
  antimatter_capsule: 'rare',
  // Phase 11 — T4 endgame (Task 11.3)
  nuclear_fuel_rod: 'rare',
  // Phase 11 — T4 endgame (Task 11.4)
  plasma_containment_vessel: 'rare',
  singularity_sensor: 'rare',
  cryo_containment_unit: 'rare',
  particle_accelerator_core: 'rare',
  self_replication_module: 'rare',
  // Ocean-layer §3 — Task 8 extractor outputs. Filter-chip categorisation
  // mirrors storage-categories with the inventory-ui's "fuel/liquid take
  // precedence" rule applied — the brines + methane_hydrate land in
  // 'liquid' (matching their storage liquid_gas category); the nodules +
  // vent_sulfide land in 'raw' (ore-family naturals); the rare isotope
  // concentrates + vent_exotic land in 'rare'.
  dilute_brine: 'liquid',
  concentrated_brine: 'liquid',
  he3_dilute: 'rare',
  mn_nodule: 'raw',
  re_nodule: 'raw',
  co_nodule: 'raw',
  methane_hydrate: 'liquid',
  heavy_isotope_slurry: 'rare',
  vent_sulfide: 'raw',
  vent_exotic: 'rare',
  // Ocean-layer §3 — Task 9 processor outputs.
  //   lithium_brine / bromine / heavy_water → 'liquid' (matches storage
  //     liquid_gas category).
  //   rare_earth_concentrate / refined_cobalt → 'raw' (processed mineral
  //     powders sit in the ore-family chip).
  //   exotic_alloy_seed / tritium_seed → 'rare' (T5 exotic finals).
  lithium_brine: 'liquid',
  bromine: 'liquid',
  rare_earth_concentrate: 'raw',
  refined_cobalt: 'raw',
  exotic_alloy_seed: 'rare',
  tritium_seed: 'rare',
  heavy_water: 'liquid',
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

/**
 * Pure visibility predicate for a single resource row. Exported for tests.
 *
 * "Show empty" semantics: when `showEmpty === false` (default) a row is hidden
 * if the player has zero of the resource on hand. When `showEmpty === true`,
 * the row is shown regardless of stock. The `activeFilter` / `searchQuery`
 * predicates still apply on top.
 */
export function inventoryRowVisible(
  r: ResourceId,
  have: number,
  activeFilter: ResourceFilter,
  searchQuery: string,
  showEmpty: boolean,
): boolean {
  if (activeFilter !== 'all') {
    const cat = RESOURCE_CATEGORY[r];
    if (cat !== activeFilter) return false;
  }
  if (searchQuery && !r.includes(searchQuery)) return false;
  if (!showEmpty && have <= 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const toDisplayName = (id: string): string =>
  id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export interface InventoryUi {
  readonly el: HTMLDivElement;
  /** Sample the active island's inventory and repaint visible rows.
   *  Cheap when hidden (early-returns). */
  refresh(): void;
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

type SortMode = 'net' | 'fill' | 'name';

export function mountInventoryUi(
  parentEl: HTMLElement,
  deps: InventoryUiDeps,
): InventoryUi {
  const getState = (): IslandState => deps.getState();
  const getSpec = (): IslandSpec => deps.getSpec();

  let activeFilter: ResourceFilter = 'all';
  let searchQuery = '';
  let showEmpty = false;
  let sortMode: SortMode = 'net';

  const filterChipRefs = new Map<ResourceFilter, HTMLButtonElement>();
  const sortChipRefs = new Map<SortMode, HTMLButtonElement>();

  const rateBuffer: RateSample[] = [];
  let lastIslandId: string | null = null;
  let tbody: HTMLTableSectionElement | null = null;

  const handle = mountModal(parentEl, {
    title: 'INVENTORY',
    onClose: () => handle.hide(),
    buildFilters(filters) {
      const filterLabel = document.createElement('span');
      filterLabel.textContent = 'FILTER';
      filterLabel.className = 'ri-muted';
      filterLabel.style.fontSize = '10px';
      filterLabel.style.letterSpacing = '0.14em';
      filterLabel.style.marginRight = '6px';
      filterLabel.style.alignSelf = 'center';
      filters.appendChild(filterLabel);

      function makeChip(category: ResourceFilter): HTMLButtonElement {
        const chip = document.createElement('button');
        chip.className = 'ri-chip';
        chip.textContent = RESOURCE_FILTER_LABEL[category];
        chip.addEventListener('click', () => {
          activeFilter = category;
          paintFilterChips();
          paintRows();
          chip.blur();
        });
        filterChipRefs.set(category, chip);
        return chip;
      }

      // Render the 7 chips named in the redesign brief (skip 'misc' in UI).
      for (const c of RESOURCE_FILTER_ORDER) {
        if (c === 'misc') continue;
        filters.appendChild(makeChip(c));
      }

      // "show empty" toggle
      const showEmptyChip = document.createElement('button');
      showEmptyChip.className = 'ri-chip';
      showEmptyChip.textContent = 'Show Empty';
      showEmptyChip.style.marginLeft = '8px';
      showEmptyChip.addEventListener('click', () => {
        showEmpty = !showEmpty;
        paintShowEmptyChip();
        paintRows();
        showEmptyChip.blur();
      });
      filterChipRefs.set('showEmpty' as ResourceFilter, showEmptyChip);
      filters.appendChild(showEmptyChip);

      // Search input
      const searchInput = document.createElement('input');
      searchInput.className = 'ri-search';
      searchInput.placeholder = 'Filter…';
      searchInput.type = 'text';
      searchInput.style.flex = '1 1 140px';
      searchInput.style.minWidth = '100px';
      searchInput.style.maxWidth = '240px';
      searchInput.style.background = 'rgba(10, 14, 20, 0.6)';
      searchInput.style.color = 'var(--ri-fg-1)';
      searchInput.style.border = '1px solid var(--ri-border-strong)';
      searchInput.style.padding = '3px 8px';
      searchInput.style.fontFamily = 'var(--ri-font-mono)';
      searchInput.style.fontSize = '11px';
      searchInput.style.letterSpacing = '0.04em';
      searchInput.style.borderRadius = '4px';
      searchInput.style.outline = 'none';
      searchInput.style.marginLeft = 'auto';
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value.trim().toLowerCase();
        paintRows();
      });
      searchInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
      });
      filters.appendChild(searchInput);

      paintFilterChips();
      paintShowEmptyChip();
    },
    buildBody(body) {
      const table = document.createElement('table');
      table.className = 'ri-table';

      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      const headers = ['Resource', 'Stock', 'Cap', 'Fill', 'Net /s (60s avg)', 'Time to ⤓/⤒'];
      for (const h of headers) {
        const th = document.createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      tbody = document.createElement('tbody');
      table.appendChild(tbody);
      body.appendChild(table);
    },
    buildFooter(footer) {
      const sortLabel = document.createElement('span');
      sortLabel.textContent = 'SORT';
      sortLabel.className = 'ri-muted';
      sortLabel.style.fontSize = '10px';
      sortLabel.style.letterSpacing = '0.14em';
      sortLabel.style.marginRight = '6px';
      sortLabel.style.alignSelf = 'center';
      footer.appendChild(sortLabel);

      function makeSortChip(key: SortMode, label: string): HTMLButtonElement {
        const chip = document.createElement('button');
        chip.className = 'ri-chip';
        chip.textContent = label;
        chip.addEventListener('click', () => {
          sortMode = key;
          paintSortChips();
          paintRows();
          chip.blur();
        });
        sortChipRefs.set(key, chip);
        return chip;
      }

      footer.appendChild(makeSortChip('net', 'Net /s'));
      footer.appendChild(makeSortChip('fill', 'Fill %'));
      footer.appendChild(makeSortChip('name', 'Name'));

      paintSortChips();
    },
  });

  function updateSubtitle(): void {
    const header = handle.el.querySelector('.ri-modal__header');
    if (!header) return;
    let sub = header.querySelector('.ri-modal__sub') as HTMLSpanElement | null;
    if (!sub) {
      sub = document.createElement('span');
      sub.className = 'ri-modal__sub';
      const closeBtn = header.querySelector('.ri-modal__close');
      if (closeBtn) header.insertBefore(sub, closeBtn);
      else header.appendChild(sub);
    }
    sub.textContent = `/ ${getSpec().name}`;
  }

  function paintFilterChips(): void {
    for (const [key, chip] of filterChipRefs) {
      if (key === 'showEmpty' as ResourceFilter) continue;
      chip.dataset.active = (key === activeFilter) ? 'true' : 'false';
    }
  }

  function paintShowEmptyChip(): void {
    const chip = filterChipRefs.get('showEmpty' as ResourceFilter);
    if (chip) chip.dataset.active = showEmpty ? 'true' : 'false';
  }

  function paintSortChips(): void {
    for (const [key, chip] of sortChipRefs) {
      chip.dataset.active = (key === sortMode) ? 'true' : 'false';
    }
  }

  function rowVisible(r: ResourceId, have: number): boolean {
    return inventoryRowVisible(r, have, activeFilter, searchQuery, showEmpty);
  }

  function makeMeter(pct: number, tone: string | undefined): HTMLDivElement {
    const meter = document.createElement('div');
    meter.className = 'ri-meter';
    meter.style.setProperty('--ri-meter-pct', `${pct}%`);
    if (tone) meter.dataset.tone = tone;
    const fill = document.createElement('div');
    fill.className = 'ri-meter__fill';
    meter.appendChild(fill);
    return meter;
  }

  function paintRows(): void {
    const state = getState();
    const avgRate = averageRate(rateBuffer);
    if (!tbody) return;

    const rows: Array<{
      r: ResourceId;
      have: number;
      capVal: number;
      rate: number;
      pct: number;
    }> = [];

    for (const r of ALL_RESOURCES) {
      // Round to whole units — the Stock column displays an integer, and the
      // Fill % derives from it. Without this, sub-integer drift in a near-full
      // or near-empty resource churns the Fill-sorted row order every frame.
      const have = Math.round(inv(state, r));
      if (!rowVisible(r, have)) continue;
      const capVal = cap(state, r);
      // Quantize to the 2-decimal display precision: rows showing the same
      // text get the same sort key, so sub-precision jitter near zero can't
      // flip a row's sign and teleport it across the sorted table.
      const rate = Math.round((avgRate[r] ?? 0) * 100) / 100;
      const pct = capVal > 0 ? (have / capVal) * 100 : 0;
      rows.push({ r, have, capVal, rate, pct });
    }

    rows.sort((a, b) => {
      switch (sortMode) {
        case 'net':
          return b.rate - a.rate;
        case 'fill':
          return b.pct - a.pct;
        case 'name':
          return a.r.localeCompare(b.r);
      }
    });

    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = 'no inventory yet — place an Extractor or Workshop.';
      td.className = 'ri-muted';
      td.style.fontStyle = 'italic';
      td.style.padding = '16px';
      td.style.textAlign = 'center';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const row of rows) {
      const tr = document.createElement('tr');

      // Resource
      const nameTd = document.createElement('td');
      nameTd.className = 'ri-table__name';
      nameTd.textContent = toDisplayName(row.r);
      tr.appendChild(nameTd);

      // Stock
      const stockTd = document.createElement('td');
      stockTd.className = 'ri-table__num';
      stockTd.textContent = row.have.toFixed(0);
      tr.appendChild(stockTd);

      // Cap
      const capTd = document.createElement('td');
      capTd.className = 'ri-table__num';
      capTd.textContent = row.capVal.toFixed(0);
      tr.appendChild(capTd);

      // Fill
      const fillTd = document.createElement('td');
      const pct = row.capVal > 0 ? (row.have / row.capVal) * 100 : 0;
      const tone = pct < 10 ? 'danger' : pct < 30 ? 'warn' : undefined;
      fillTd.appendChild(makeMeter(pct, tone));
      tr.appendChild(fillTd);

      // Net /s
      const netTd = document.createElement('td');
      netTd.className = 'ri-table__num';
      if (row.rate > 0 && row.have >= row.capVal) {
        netTd.classList.add('ri-table__num--full');
      } else if (row.rate > 0) {
        netTd.classList.add('ri-table__num--pos');
      } else if (row.rate < 0) {
        netTd.classList.add('ri-table__num--neg');
      }
      if (row.rate === 0) {
        netTd.textContent = '·';
      } else {
        const sign = row.rate > 0 ? '+' : '\u2212';
        const abs = Math.abs(row.rate);
        netTd.textContent = `${sign}${abs.toFixed(2)}/s`;
      }
      tr.appendChild(netTd);

      // Time to ⤓/⤒
      const timeTd = document.createElement('td');
      timeTd.className = 'ri-table__num';
      if (row.rate < 0 && row.have > 0) {
        const seconds = (row.have / -row.rate).toFixed(0);
        timeTd.textContent = `${seconds}s to EMPTY`;
        timeTd.style.color = 'var(--ri-danger)';
      } else if (row.rate > 0 && row.have < row.capVal) {
        const seconds = ((row.capVal - row.have) / row.rate).toFixed(0);
        timeTd.textContent = `${seconds}s to FULL`;
        timeTd.style.color = 'var(--ri-warn)';
      } else {
        timeTd.textContent = '\u2014';
      }
      tr.appendChild(timeTd);

      tbody.appendChild(tr);
    }
  }

  function refresh(): void {
    if (!handle.isVisible()) return;
    const state = getState();
    if (state.id !== lastIslandId) {
      rateBuffer.length = 0;
      lastIslandId = state.id;
    }
    const now = performance.now();
    rateBuffer.push({ t: now, inv: snapshotInventory(state) });
    pruneRateBuffer(rateBuffer, now);
    updateSubtitle();
    paintRows();
  }

  function show(): void {
    if (handle.isVisible()) return;
    rateBuffer.length = 0;
    handle.show();
    updateSubtitle();
    paintFilterChips();
    paintShowEmptyChip();
    paintSortChips();
    paintRows();
  }

  function hide(): void {
    if (!handle.isVisible()) return;
    handle.hide();
  }

  function toggle(): boolean {
    if (handle.isVisible()) hide();
    else show();
    return handle.isVisible();
  }

  return {
    el: handle.el,
    refresh,
    show,
    hide,
    toggle,
    isVisible: handle.isVisible,
  };
}
