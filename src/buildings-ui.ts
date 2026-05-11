// Building Catalog modal — DOM overlay listing every BuildingDef in
// BUILDING_DEFS, grouped by tier band. Reads as the sister panel to the
// skill tree: same centered modal shell, same letter-spaced ACCENT caps in
// the header, same FG_DIM secondary text, same engineering-readout
// vocabulary. The body grid differs: skill tree groups by branch
// (3 columns), Buildings groups by tier (rows of tier bands), with a
// category-filter chip row across the top of the body.
//
// Step-9 surface: catalog listing + tier-lock display + recipe/power
// inline. Placement isn't built (step 2.5); the "click a row" path logs
// `would-place(defId)` and is otherwise a no-op. The Catalog is the
// canonical place to read the unlocked-defs state, so even without
// placement it earns its keyboard slot.
//
// Aesthetic decision (frontend-design pass): rather than a card grid of
// buildings, render as compact "datasheet rows" — left status rail,
// name + category subtitle, right cluster of metadata badges (footprint /
// power / storage) and a compact recipe snippet. Density beats whitespace
// for a reference panel; the skill-tree panel established the same vibe.

import {
  ALL_BUILDING_DEF_IDS,
  BUILDING_DEFS,
  buildingUnlocked,
  canPlaceOnIsland,
  type BuildingCategory,
  type BuildingDefId,
} from './building-defs.js';
import { BIOME_DEFS } from './biomes.js';
import type { IslandState } from './economy.js';
import { RECIPES, type Recipe } from './recipes.js';
import { tierForLevel, type Tier } from './skilltree.js';
import type { IslandSpec } from './world.js';

export interface BuildingsUi {
  readonly el: HTMLDivElement;
  refresh(): void;
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
}

// ---------------------------------------------------------------------------
// Palette — shared vocabulary with skilltree-ui.ts
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
const WARN_DIM = '#7a5530';
const STRIP_BG = 'rgba(20, 24, 32, 0.6)';
const ROW_BG_HOVER = 'rgba(125, 211, 232, 0.06)';

const CATEGORY_LABEL: Readonly<Record<BuildingCategory, string>> = {
  extraction: 'Extraction',
  smelting: 'Smelting',
  chemistry: 'Chemistry',
  manufacturing: 'Manufacturing',
  electronics: 'Electronics',
  power: 'Power',
  storage: 'Storage',
  logistics: 'Logistics',
  cooling: 'Cooling',
  special: 'Special',
};

// Tier breakpoint reverse-lookup: the level at which each tier becomes
// available. Mirrors the constants in tierForLevel/skilltree.ts.
const TIER_BREAKPOINT: Readonly<Record<Tier, number>> = {
  1: 1,
  2: 5,
  3: 15,
  4: 30,
  5: 50,
  // T6 needs Ascendant Core + Spaceport per §9.2, not a level threshold.
  // Infinity keeps the proximity-warn math correct (always far-locked).
  6: Number.POSITIVE_INFINITY,
};

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

/** Render an inputs+outputs recipe summary into a compact text snippet:
 *  `iron_ore + coal → iron_ingot (8s)`. Empty inputs render as `· → out`;
 *  empty outputs (e.g. Coal Gen) render as `in → power (5s)`. */
function recipeSnippet(recipe: Recipe): string {
  const inParts: string[] = [];
  for (const [r, n] of Object.entries(recipe.inputs)) {
    if ((n ?? 0) === 0) continue;
    inParts.push((n ?? 0) === 1 ? r : `${n}× ${r}`);
  }
  const outParts: string[] = [];
  for (const [r, n] of Object.entries(recipe.outputs)) {
    if ((n ?? 0) === 0) continue;
    outParts.push((n ?? 0) === 1 ? r : `${n}× ${r}`);
  }
  const inStr = inParts.length === 0 ? '·' : inParts.join(' + ');
  const outStr = outParts.length === 0 ? 'power' : outParts.join(' + ');
  return `${inStr} → ${outStr} (${recipe.cycleSec}s)`;
}

interface RowRef {
  readonly row: HTMLDivElement;
  readonly statusDot: HTMLSpanElement;
  readonly titleEl: HTMLSpanElement;
  readonly subtitleEl: HTMLSpanElement;
  readonly metaRail: HTMLDivElement;
  readonly recipeEl: HTMLDivElement;
}

interface TierBandRef {
  readonly section: HTMLDivElement;
  readonly headingLabel: HTMLSpanElement;
  readonly headingStatus: HTMLSpanElement;
  readonly heading: HTMLDivElement;
  readonly grid: HTMLDivElement;
  readonly tier: Tier;
}

export function mountBuildingsUi(
  parentEl: HTMLElement,
  state: IslandState,
  spec: IslandSpec,
): BuildingsUi {
  const rowRefs = new Map<BuildingDefId, RowRef>();
  const tierBandRefs: TierBandRef[] = [];

  let visible = false;
  /** Active category filter; null = show all. */
  let activeFilter: BuildingCategory | null = null;
  const categoryChipRefs = new Map<BuildingCategory | 'all', HTMLButtonElement>();

  // -------------------------------------------------------------------------
  // Scrim + panel shell
  // -------------------------------------------------------------------------
  const scrim = document.createElement('div');
  scrim.id = 'buildings-scrim';
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
  panel.id = 'buildings-panel';
  styled(
    panel,
    [
      'position: fixed',
      'top: 50%',
      'left: 50%',
      'transform: translate(-50%, -50%)',
      'width: min(960px, calc(100vw - 32px))',
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

  // -------------------------------------------------------------------------
  // Header strip — mirrors skill-tree panel for cross-modal continuity
  // -------------------------------------------------------------------------
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

  const headerTitle = document.createElement('div');
  styled(headerTitle, 'display: flex; align-items: baseline; gap: 10px; flex: 0 0 auto');
  const title = document.createElement('span');
  title.textContent = 'BUILDINGS';
  styled(
    title,
    [
      `color: ${ACCENT}`,
      'font-size: 12px',
      'font-weight: 600',
      'letter-spacing: 0.22em',
    ].join(';'),
  );
  const subtitle = document.createElement('span');
  subtitle.textContent = '§8 / catalog';
  styled(
    subtitle,
    [
      `color: ${FG_DIM}`,
      'font-size: 10px',
      'letter-spacing: 0.12em',
      'text-transform: uppercase',
    ].join(';'),
  );
  headerTitle.appendChild(title);
  headerTitle.appendChild(subtitle);

  const headerStats = document.createElement('div');
  styled(
    headerStats,
    [
      'flex: 1 1 auto',
      'display: flex',
      'justify-content: center',
      'gap: 22px',
      'font-size: 11px',
      'letter-spacing: 0.08em',
      'text-transform: uppercase',
    ].join(';'),
  );
  function statBlock(label: string, valueEl: HTMLElement): HTMLDivElement {
    const wrap = document.createElement('div');
    styled(wrap, 'display: flex; align-items: baseline; gap: 6px');
    const l = document.createElement('span');
    l.textContent = label;
    styled(l, `color: ${FG_DIM}; font-size: 10px`);
    wrap.appendChild(l);
    wrap.appendChild(valueEl);
    return wrap;
  }
  const islandLevelVal = document.createElement('span');
  styled(islandLevelVal, `color: ${FG}; font-weight: 600`);
  const islandTierVal = document.createElement('span');
  styled(islandTierVal, `color: ${ACCENT}; font-weight: 600`);
  const unlockedCountVal = document.createElement('span');
  styled(unlockedCountVal, `color: ${FG}; font-weight: 600`);

  headerStats.appendChild(statBlock('LEVEL', islandLevelVal));
  headerStats.appendChild(statBlock('TIER', islandTierVal));
  headerStats.appendChild(statBlock('UNLOCKED', unlockedCountVal));

  const closeBtn = makeButton('Close (B)', () => hide());

  header.appendChild(headerTitle);
  header.appendChild(headerStats);
  header.appendChild(closeBtn);

  // -------------------------------------------------------------------------
  // Category filter strip
  // -------------------------------------------------------------------------
  const filterStrip = document.createElement('div');
  styled(
    filterStrip,
    [
      'display: flex',
      'align-items: center',
      'gap: 6px',
      'flex-wrap: wrap',
      'padding: 8px 16px',
      `border-bottom: 1px solid ${PANEL_BORDER}`,
      `background: rgba(20, 24, 32, 0.4)`,
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
      'margin-right: 6px',
    ].join(';'),
  );
  filterStrip.appendChild(filterLabel);

  function categoryChip(category: BuildingCategory | 'all', label: string): HTMLButtonElement {
    const chip = document.createElement('button');
    chip.textContent = label;
    styled(
      chip,
      [
        `background: transparent`,
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
      activeFilter = category === 'all' ? null : category;
      paintFilterChips();
      paintRows();
      chip.blur();
    });
    categoryChipRefs.set(category, chip);
    return chip;
  }

  filterStrip.appendChild(categoryChip('all', 'All'));
  // Only show categories that appear in the catalog at least once.
  const presentCategories = new Set<BuildingCategory>();
  for (const id of ALL_BUILDING_DEF_IDS) presentCategories.add(BUILDING_DEFS[id].category);
  for (const cat of Object.keys(CATEGORY_LABEL) as BuildingCategory[]) {
    if (!presentCategories.has(cat)) continue;
    filterStrip.appendChild(categoryChip(cat, CATEGORY_LABEL[cat]));
  }

  function paintFilterChips(): void {
    for (const [key, chip] of categoryChipRefs) {
      const active = (key === 'all' && activeFilter === null) || key === activeFilter;
      if (active) {
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

  // -------------------------------------------------------------------------
  // Body — tier-band scroll list
  // -------------------------------------------------------------------------
  const body = document.createElement('div');
  styled(
    body,
    [
      'display: flex',
      'flex-direction: column',
      'gap: 0',
      'overflow-y: auto',
      'flex: 1 1 auto',
      'padding: 4px 0',
    ].join(';'),
  );

  function makeMetaBadge(text: string, fg: string, border: string): HTMLSpanElement {
    const s = document.createElement('span');
    s.textContent = text;
    styled(
      s,
      [
        'display: inline-block',
        `color: ${fg}`,
        `border: 1px solid ${border}`,
        'padding: 0 6px',
        'font-size: 10px',
        'letter-spacing: 0.05em',
        'border-radius: 2px',
        'white-space: nowrap',
      ].join(';'),
    );
    return s;
  }

  function defRow(defId: BuildingDefId): HTMLDivElement {
    const def = BUILDING_DEFS[defId];
    const row = document.createElement('div');
    styled(
      row,
      [
        'display: grid',
        'grid-template-columns: 14px 1fr',
        'align-items: start',
        'gap: 10px',
        'padding: 6px 16px 6px 14px',
        `border-left: 2px solid ${FG_MUTED}`,
        'margin-left: 10px',
        'transition: background 100ms ease, border-color 100ms ease, opacity 100ms ease',
        'cursor: default',
      ].join(';'),
    );

    const statusDot = document.createElement('span');
    statusDot.textContent = '○';
    styled(statusDot, `color: ${FG_MUTED}; font-size: 11px; line-height: 1.4`);

    const main = document.createElement('div');
    styled(main, 'display: flex; flex-direction: column; gap: 3px; min-width: 0');

    const titleRow = document.createElement('div');
    styled(
      titleRow,
      [
        'display: flex',
        'align-items: baseline',
        'justify-content: space-between',
        'gap: 12px',
        'flex-wrap: wrap',
      ].join(';'),
    );

    const titleCluster = document.createElement('div');
    styled(titleCluster, 'display: flex; align-items: baseline; gap: 8px; min-width: 0');
    const titleEl = document.createElement('span');
    titleEl.textContent = def.displayName;
    styled(titleEl, `color: ${FG}; font-size: 12px; font-weight: 600; letter-spacing: 0.02em`);
    const subtitleEl = document.createElement('span');
    subtitleEl.textContent = CATEGORY_LABEL[def.category].toUpperCase();
    styled(
      subtitleEl,
      [
        `color: ${FG_DIM}`,
        'font-size: 9.5px',
        'letter-spacing: 0.14em',
      ].join(';'),
    );
    titleCluster.appendChild(titleEl);
    titleCluster.appendChild(subtitleEl);

    // Meta-badge rail — footprint, power, storage. Built once and
    // populated/repopulated by paintRow.
    const metaRail = document.createElement('div');
    styled(metaRail, 'display: flex; gap: 4px; flex-wrap: wrap; align-items: center');

    titleRow.appendChild(titleCluster);
    titleRow.appendChild(metaRail);
    main.appendChild(titleRow);

    // Recipe snippet (optional — not every def has a recipe).
    const recipeEl = document.createElement('div');
    styled(
      recipeEl,
      [
        `color: ${FG_DIM}`,
        'font-size: 10.5px',
        'letter-spacing: 0.02em',
        'word-break: break-word',
      ].join(';'),
    );
    main.appendChild(recipeEl);

    row.appendChild(statusDot);
    row.appendChild(main);

    // Stub click handler — step 2.5 wires placement. Until then, dispatching
    // logs so the interaction-loop closes back to the developer console.
    row.addEventListener('click', () => {
      if (!buildingUnlocked(state.level, defId)) return;
      // eslint-disable-next-line no-console
      console.log(`[buildings] would-place(${defId}) — placement deferred to step 2.5`);
    });
    row.addEventListener('mouseenter', () => {
      if (!buildingUnlocked(state.level, defId)) return;
      row.style.background = ROW_BG_HOVER;
      row.style.borderLeftColor = ACCENT;
      row.style.cursor = 'pointer';
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = '';
      row.style.cursor = 'default';
      const ref = rowRefs.get(defId);
      if (ref) paintRow(defId, ref);
    });

    rowRefs.set(defId, { row, statusDot, titleEl, subtitleEl, metaRail, recipeEl });
    return row;
  }

  function paintRow(defId: BuildingDefId, ref: RowRef): void {
    const def = BUILDING_DEFS[defId];
    const unlocked = buildingUnlocked(state.level, defId);
    // §9.5: biome-locked uniques (those with `requiredBiomes`) are tier-
    // unlocked but cannot be placed on this island unless biome matches and
    // the island is not artificial. `canPlaceOnIsland` is the canonical
    // pure helper — the UI just surfaces its result.
    const biomeOk = canPlaceOnIsland(def, spec);
    // "placement-locked" reads as a softer state than tier-locked: the tier
    // is unlocked but the player needs a different island to actually
    // place it. Tier-locked overrides — if the tier isn't there, no point
    // saying "wrong biome".
    const placementLocked = unlocked && !biomeOk;

    // Status dot + colours
    if (unlocked && !placementLocked) {
      ref.statusDot.textContent = '●';
      ref.statusDot.style.color = ACCENT;
      ref.titleEl.style.color = FG;
      ref.subtitleEl.style.color = FG_DIM;
      ref.row.style.borderLeftColor = ACCENT_DIM;
      ref.row.style.opacity = '1';
    } else if (placementLocked) {
      // Biome-locked unique: tier-unlocked but wrong biome / artificial.
      // Half-bright — visually distinct from a tier-locked row but not as
      // loud as an available one. WARN-coloured rail to flag "you can't
      // place this here" without making it look broken.
      ref.statusDot.textContent = '◐';
      ref.statusDot.style.color = WARN;
      ref.titleEl.style.color = FG_DIM;
      ref.subtitleEl.style.color = WARN_DIM;
      ref.row.style.borderLeftColor = WARN_DIM;
      ref.row.style.opacity = '0.78';
    } else {
      ref.statusDot.textContent = '○';
      ref.statusDot.style.color = FG_MUTED;
      ref.titleEl.style.color = FG_DIM;
      ref.subtitleEl.style.color = FG_MUTED;
      ref.row.style.borderLeftColor = FG_MUTED;
      // Within-2-of-unlock buildings get a softer dim — same urgency cue
      // the HUD tier badge uses (WARN amber). Far-locked gets the harder dim.
      const breakpoint = TIER_BREAKPOINT[def.tier];
      const proximityWarn = breakpoint - state.level <= 2;
      ref.row.style.opacity = proximityWarn ? '0.78' : '0.55';
    }

    // Meta badges — footprint, power, storage, biome-restriction. Rebuilt
    // each paint so a build with skill-tree-modified power could (future)
    // update live. For step 9 the values are static; cost of full rebuild
    // here is trivial (3-5 spans per row).
    while (ref.metaRail.firstChild) ref.metaRail.removeChild(ref.metaRail.firstChild);
    const metaFg = unlocked ? FG : FG_DIM;
    const metaBorder = unlocked ? PANEL_BORDER : FG_MUTED;
    // §9.5: biome-restriction badge for biome-locked uniques. Renders
    // FIRST so the player sees the constraint before the dimensions.
    // E.g. "VOLCANIC" or "ARCTIC" — the §9.5 single-biome restrictions are
    // the only shape that ships in step 12, but the badge concatenates if
    // a future def lists multiple biomes.
    if (def.requiredBiomes && def.requiredBiomes.length > 0) {
      const biomeLabel = def.requiredBiomes
        .map((b) => BIOME_DEFS[b].displayName.toUpperCase())
        .join(' / ');
      // WARN colour when player's current island doesn't match (the row
      // is placement-locked); ACCENT colour when it does (placement is
      // valid on the current island).
      const badgeFg = placementLocked ? WARN : ACCENT;
      const badgeBorder = placementLocked ? WARN_DIM : ACCENT_DIM;
      ref.metaRail.appendChild(makeMetaBadge(biomeLabel, badgeFg, badgeBorder));
    }
    ref.metaRail.appendChild(
      makeMetaBadge(`${def.width}×${def.height}`, metaFg, metaBorder),
    );
    if (def.power?.produces) {
      ref.metaRail.appendChild(
        makeMetaBadge(`+${def.power.produces}W`, unlocked ? ACCENT : FG_MUTED, metaBorder),
      );
    }
    if (def.power?.consumes) {
      ref.metaRail.appendChild(
        makeMetaBadge(`-${def.power.consumes}W`, unlocked ? WARN : WARN_DIM, metaBorder),
      );
    }
    if (def.storageCap !== undefined && def.storageCap > 0) {
      ref.metaRail.appendChild(
        makeMetaBadge(`+${def.storageCap} cap`, metaFg, metaBorder),
      );
    }

    // Recipe snippet (or "no recipe" for Solar, Dock, etc.).
    const recipe = RECIPES[defId];
    if (recipe) {
      ref.recipeEl.textContent = recipeSnippet(recipe);
      ref.recipeEl.style.color = unlocked ? FG_DIM : FG_MUTED;
    } else {
      ref.recipeEl.textContent = '— no recipe';
      ref.recipeEl.style.color = FG_MUTED;
    }
  }

  // Group ids by tier in declaration order (preserves catalog readability:
  // mine appears before logger inside T1, etc.).
  const idsByTier = new Map<Tier, BuildingDefId[]>();
  for (const id of ALL_BUILDING_DEF_IDS) {
    const tier = BUILDING_DEFS[id].tier;
    const list = idsByTier.get(tier) ?? [];
    list.push(id);
    idsByTier.set(tier, list);
  }
  // Render tier bands in ascending tier order. Empty tiers (T4-T6 right
  // now) are skipped — the catalog grows into them in later steps.
  for (const tier of [1, 2, 3, 4, 5, 6] as Tier[]) {
    const ids = idsByTier.get(tier);
    if (!ids || ids.length === 0) continue;
    const section = document.createElement('div');
    styled(section, 'display: flex; flex-direction: column; gap: 2px; padding: 4px 0 10px');

    const heading = document.createElement('div');
    styled(
      heading,
      [
        'display: flex',
        'align-items: baseline',
        'justify-content: space-between',
        'padding: 8px 16px 4px',
        `border-bottom: 1px solid ${PANEL_BORDER}`,
        'margin: 0 4px 6px',
      ].join(';'),
    );
    const headingLabel = document.createElement('span');
    headingLabel.textContent = `TIER ${tier}`;
    styled(
      headingLabel,
      [
        `color: ${ACCENT}`,
        'font-size: 11px',
        'font-weight: 600',
        'letter-spacing: 0.22em',
      ].join(';'),
    );
    const headingStatus = document.createElement('span');
    styled(
      headingStatus,
      [
        `color: ${FG_DIM}`,
        'font-size: 9.5px',
        'letter-spacing: 0.12em',
        'text-transform: uppercase',
      ].join(';'),
    );
    heading.appendChild(headingLabel);
    heading.appendChild(headingStatus);
    section.appendChild(heading);

    const grid = document.createElement('div');
    styled(grid, 'display: flex; flex-direction: column; gap: 1px');
    for (const id of ids) grid.appendChild(defRow(id));
    section.appendChild(grid);

    body.appendChild(section);
    tierBandRefs.push({ section, headingLabel, headingStatus, heading, grid, tier });
  }

  function paintTierBand(ref: TierBandRef): void {
    const playerTier = tierForLevel(state.level);
    if (ref.tier <= playerTier) {
      ref.headingLabel.style.color = ACCENT;
      ref.heading.style.borderBottomColor = ACCENT_DIM;
      ref.headingStatus.textContent = 'available';
      ref.headingStatus.style.color = FG_DIM;
    } else {
      const breakpoint = TIER_BREAKPOINT[ref.tier];
      const gap = breakpoint - state.level;
      const proximityWarn = gap <= 2;
      ref.headingLabel.style.color = proximityWarn ? WARN : FG_MUTED;
      ref.heading.style.borderBottomColor = proximityWarn ? WARN_DIM : PANEL_BORDER;
      ref.headingStatus.textContent = `${gap} LV TO UNLOCK`;
      ref.headingStatus.style.color = proximityWarn ? WARN : FG_MUTED;
    }
  }

  function paintRows(): void {
    for (const defId of ALL_BUILDING_DEF_IDS) {
      const ref = rowRefs.get(defId);
      if (!ref) continue;
      // Apply filter
      const def = BUILDING_DEFS[defId];
      const matchesFilter = activeFilter === null || def.category === activeFilter;
      ref.row.style.display = matchesFilter ? '' : 'none';
      paintRow(defId, ref);
    }
    // Tier-band visibility: hide the whole band if every row in it is
    // filtered out.
    for (const band of tierBandRefs) {
      const ids = idsByTier.get(band.tier) ?? [];
      const anyVisible = ids.some((id) => {
        const def = BUILDING_DEFS[id];
        return activeFilter === null || def.category === activeFilter;
      });
      band.section.style.display = anyVisible ? '' : 'none';
    }
  }

  // -------------------------------------------------------------------------
  // Footer hint strip
  // -------------------------------------------------------------------------
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
  footerL.textContent = 'catalog only · placement system pending (step 2.5)';
  const footerR = document.createElement('span');
  footerR.textContent = 'tiers gate by island level · §9.2';
  footer.appendChild(footerL);
  footer.appendChild(footerR);

  panel.appendChild(header);
  panel.appendChild(filterStrip);
  panel.appendChild(body);
  panel.appendChild(footer);

  parentEl.appendChild(scrim);
  parentEl.appendChild(panel);
  panel.style.display = 'none';

  function refresh(): void {
    if (!visible) return;
    islandLevelVal.textContent = String(state.level);
    const playerTier = tierForLevel(state.level);
    islandTierVal.textContent = `T${playerTier}`;
    const unlocked = ALL_BUILDING_DEF_IDS.filter((id) => buildingUnlocked(state.level, id)).length;
    unlockedCountVal.textContent = `${unlocked} / ${ALL_BUILDING_DEF_IDS.length}`;
    for (const band of tierBandRefs) paintTierBand(band);
    paintRows();
    paintFilterChips();
  }

  function show(): void {
    if (visible) return;
    visible = true;
    panel.style.display = 'flex';
    scrim.style.display = 'block';
    refresh();
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
