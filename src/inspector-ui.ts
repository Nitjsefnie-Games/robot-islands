// Building Inspector — side dock that opens when a placed building is
// selected on the map. Sister to drones-ui / routes-ui / settlement-ui:
// same industrial-readout vocabulary (ACCENT cyan title, FG_DIM secondary
// labels, monospace tabular numerics), same dock idiom.
//
// Position: top-right, anchored beneath the existing UI button strip (which
// sits at top: 8px). The inspector dock takes top: ~72px to clear the
// button strip on a Skill Tree / Buildings / Drones / Routes / Settle /
// Construct row.
//
// Reads:
//   - active selection (set by `setTarget(spec, state, building)`).
//   - live data on every `refresh()` — recipe rates from `computeRates`,
//     building def from BUILDING_DEFS, terrain via spec.terrainAt for
//     resolveRecipe on Mine.
//
// Side effects: a §4 demolish button calls back into main.ts via the
// supplied `onDemolish(buildingId)` callback. The DOM panel doesn't itself
// mutate state — main.ts owns the demolition + the post-demolish layer
// rebuild + selection-clear flow.
//
// Visual cue ownership: this module owns the inspector PANEL only. The
// selected-building outline is drawn in main.ts's selection-layer Container
// (per the task brief — selection lives next to hover, both world-space
// outlines). The inspector tells main.ts WHICH building is selected; main.ts
// paints the outline.

import {
  BUILDING_DEFS,
  type BuildingCategory,
  type BuildingDefId,
} from './building-defs.js';
import { placementCostFor } from './placement.js';
import type { PlacedBuilding } from './buildings.js';
import type { IslandState } from './economy.js';
import { computeRates } from './economy.js';
import {
  type Axis,
  type ExpandResult,
  canExpandIsland,
  landReclamationCost,
} from './land-reclamation.js';
import {
  MAINTENANCE_RECIPES,
  MAINTENANCE_THRESHOLD_MS_BY_TIER,
  maintenanceFactor,
} from './maintenance.js';
import { ALL_RESOURCES, resolveRecipe, type Recipe, type ResourceId } from './recipes.js';
import { RESOURCE_STORAGE_CATEGORY, type StorageCategory } from './storage-categories.js';
import {
  BIOME_MAX_RADII,
  ISLAND_NAME_MAX_LEN,
  renameIsland,
  type IslandSpec,
} from './world.js';

// ---------------------------------------------------------------------------
// Palette — shared vocabulary with drones-ui / buildings-ui / skilltree-ui
// ---------------------------------------------------------------------------
const PANEL_BG = 'rgba(14, 18, 26, 0.92)';
const PANEL_BORDER = '#3a4452';
const FG = '#cdd6f4';
const FG_DIM = '#6c7791';
const FG_MUTED = '#4a5365';
const ACCENT = '#7dd3e8';
const ACCENT_DIM = '#3d6f7c';
const WARN = '#f5a742';
const WARN_DIM = '#7a5530';
const STRIP_BG = 'rgba(20, 24, 32, 0.6)';

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

/** Display label for each §4.6 storage category. Used by the inspector's
 *  storage section to render the specialized-building bucket name. */
const STORAGE_CATEGORY_LABEL: Readonly<Record<StorageCategory, string>> = {
  dry_goods: 'Dry Goods',
  liquid_gas: 'Liquids / Gases',
  temp_sensitive: 'Temp-Sensitive',
  components: 'Components',
  rare: 'Rare / Valuable',
};

function styled(el: HTMLElement, css: string): void {
  el.style.cssText = css;
}

/** Strip `readonly` from every field. The §4.6 relabel path mutates
 *  `PlacedBuilding.cargoLabel`; the readonly modifier on PlacedBuilding is
 *  a documentation convention (the economy and persistence layers already
 *  mutate `populated` / `discovered` on IslandSpec), but TypeScript still
 *  rejects writes through the readonly type. `Mutable<T>` is the standard
 *  cast we use at the relabel site to avoid `as any`. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// ---------------------------------------------------------------------------
// Demolition-credit formula (mirrors `demolishBuilding` in placement.ts)
// ---------------------------------------------------------------------------
/** Preview the §6.7 scrap credit for a building def. Mirrors the
 *  `floor(sum(placementCost) * 0.3)` computation `demolishBuilding` applies. */
function previewScrapForBuilding(defId: BuildingDefId): number {
  const def = BUILDING_DEFS[defId];
  const cost = placementCostFor(def);
  const costSum = Object.values(cost).reduce((sum, n) => sum + n, 0);
  return Math.floor(costSum * 0.3);
}

/** §14: preview the 50% placement-cost refund for the confirm dialog.
 *  Mirrors the `floor(n / 2)` per-resource computation `demolishBuilding`
 *  applies (the inventory-cap clamp is deferred to the actual mutation —
 *  showing the raw refund here matches what the player earns ASSUMING
 *  storage headroom). Empty record when the def has no placementCost. */
function previewRefundForBuilding(b: PlacedBuilding): Partial<Record<ResourceId, number>> {
  const def = BUILDING_DEFS[b.defId];
  const cost = def.placementCost ?? {};
  const out: Partial<Record<ResourceId, number>> = {};
  for (const [r, n] of Object.entries(cost) as Array<[ResourceId, number]>) {
    if (n <= 0) continue;
    const half = Math.floor(n / 2);
    if (half > 0) out[r as ResourceId] = half;
  }
  return out;
}

/** Format a refund preview as "+15 STONE, +7 WOOD" for the demolish
 *  confirmation dialog and the inline button label. Empty record →
 *  empty string. */
function formatRefund(refund: Partial<Record<ResourceId, number>>): string {
  const parts: string[] = [];
  for (const [r, n] of Object.entries(refund) as Array<[ResourceId, number]>) {
    if (n <= 0) continue;
    parts.push(`+${n} ${r.toUpperCase().replace(/_/g, ' ')}`);
  }
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface InspectorTarget {
  readonly spec: IslandSpec;
  readonly state: IslandState;
  readonly building: PlacedBuilding;
}

export interface InspectorUi {
  readonly el: HTMLDivElement;
  /** Open the inspector with a target building. Replaces any current target. */
  open(target: InspectorTarget): void;
  /** Close the inspector. Idempotent. */
  close(): void;
  /** Whether the inspector is currently visible. */
  isVisible(): boolean;
  /** Repaint the body with fresh rate / inventory numbers. Called every
   *  frame from the main ticker while visible. Cheap when hidden. */
  refresh(): void;
  /** The current target building id, or null when hidden. main.ts reads
   *  this to drive the selection outline. */
  getSelectedBuildingId(): string | null;
}

export interface InspectorDeps {
  /** Called when the player confirms a demolish action. main.ts removes the
   *  building, credits scrap, rebuilds world layers, and closes the
   *  inspector. Returning false here keeps the inspector open (e.g. if the
   *  caller wants to refuse with no state change), but the step-2.5 path
   *  always succeeds. */
  onDemolish(target: InspectorTarget): void;
  /** §3.4 Land Reclamation: called when the player clicks one of the
   *  +1 major / +1 minor expand buttons. main.ts owns the actual
   *  `expandIsland` call (so the inspector stays DOM-pure) and is
   *  responsible for rebuilding world layers + refreshing the
   *  inspector after a successful mutation. The inspector pre-checks
   *  via `canExpandIsland` before surfacing the button, so the
   *  callback can assume the action is valid at click time. */
  onExpandIsland(target: InspectorTarget, axis: Axis): void;
  /** Called after a successful rename. The inspector has already mutated
   *  `target.spec.name` via the pure `renameIsland` helper before invoking
   *  this. main.ts is responsible for repainting any UI surfaces that
   *  cache the name (HUD title, inventory subtitle) — those panels re-read
   *  on their own ticker pass, so the callback typically just bumps the
   *  autosave dirty flag. */
  onRenameIsland(target: InspectorTarget, name: string): void;
}

// ---------------------------------------------------------------------------
// Rate row helper — renders one resource line with sign and rate
// ---------------------------------------------------------------------------
interface RateLine {
  readonly resource: ResourceId;
  readonly direction: 'in' | 'out';
  readonly rate: number;
}

/** Recipe summary as a list of "+r/s wood" / "-r/s coal" lines. `rate` is
 *  pre-multiplied by the building's `effectiveRate` so paused/output-stalled
 *  buildings show zero rates rather than nominal-recipe rates. */
function recipeToLines(recipe: Recipe, effectiveRate: number): RateLine[] {
  const lines: RateLine[] = [];
  for (const [r, n] of Object.entries(recipe.inputs)) {
    if ((n ?? 0) === 0) continue;
    lines.push({
      resource: r as ResourceId,
      direction: 'in',
      rate: (n ?? 0) * effectiveRate,
    });
  }
  for (const [r, n] of Object.entries(recipe.outputs)) {
    if ((n ?? 0) === 0) continue;
    lines.push({
      resource: r as ResourceId,
      direction: 'out',
      rate: (n ?? 0) * effectiveRate,
    });
  }
  return lines;
}

/** Format a per-second rate to 2-3 significant digits with a sign prefix. */
function formatRate(direction: 'in' | 'out', rate: number): string {
  const sign = direction === 'out' ? '+' : '-';
  // Sub-0.01 rates are reported as zero — visual signal that the building is
  // stalled / power-throttled. The recipe lines still appear so the player
  // knows which resources are involved.
  if (rate < 0.001) return `${sign}0/s`;
  if (rate < 0.1) return `${sign}${rate.toFixed(3)}/s`;
  if (rate < 10) return `${sign}${rate.toFixed(2)}/s`;
  return `${sign}${rate.toFixed(1)}/s`;
}

/** Format a duration in milliseconds as `Hh MMm` (24h+) or `Hh MMm` (24h-)
 *  to a compact readable form used by the §4.7 maintenance readout. Negative
 *  inputs clamp to zero. */
function formatHM(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const totalMin = Math.floor(clamped / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------
export function mountInspectorUi(
  parentEl: HTMLElement,
  deps: InspectorDeps,
): InspectorUi {
  let target: InspectorTarget | null = null;

  // -------------------------------------------------------------------------
  // Panel shell — top-right, beneath the UI button strip (top: 8 + 6 buttons
  // × ~26px ≈ 168px). We pick top: 184px to clear comfortably and keep the
  // bottom anchored so a tall building (lots of meta) scrolls inside the
  // dock rather than overflowing the viewport.
  // -------------------------------------------------------------------------
  const panel = document.createElement('div');
  panel.id = 'inspector-panel';
  styled(
    panel,
    [
      'position: fixed',
      'top: 232px',
      'right: 8px',
      'width: 268px',
      'max-height: calc(100vh - 248px)',
      `background: ${PANEL_BG}`,
      `border: 1px solid ${PANEL_BORDER}`,
      'border-radius: 2px',
      'box-shadow: 0 18px 36px -12px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(125, 211, 232, 0.04)',
      'z-index: 110',
      `color: ${FG}`,
      'font-family: ui-monospace, monospace',
      'font-size: 12px',
      'line-height: 1.45',
      'font-variant-numeric: tabular-nums',
      'display: none',
      'flex-direction: column',
      'overflow: hidden',
      'pointer-events: auto',
    ].join(';'),
  );

  // -------------------------------------------------------------------------
  // Header — `BUILDING / INSPECT` stamp + close (×)
  // -------------------------------------------------------------------------
  const header = document.createElement('div');
  styled(
    header,
    [
      'display: flex',
      'align-items: baseline',
      'justify-content: space-between',
      'gap: 8px',
      'padding: 9px 12px 8px',
      `border-bottom: 1px solid ${PANEL_BORDER}`,
      `background: ${STRIP_BG}`,
    ].join(';'),
  );
  const headLeft = document.createElement('div');
  styled(headLeft, 'display: flex; align-items: baseline; gap: 7px');
  const dot = document.createElement('span');
  dot.textContent = '◉';
  styled(dot, `color: ${ACCENT}; font-size: 10px`);
  const headTitle = document.createElement('span');
  headTitle.textContent = 'INSPECT';
  styled(
    headTitle,
    [
      `color: ${ACCENT}`,
      'font-size: 11px',
      'font-weight: 600',
      'letter-spacing: 0.22em',
    ].join(';'),
  );
  const headSub = document.createElement('span');
  headSub.textContent = 'BLD-01';
  styled(
    headSub,
    [
      `color: ${FG_DIM}`,
      'font-size: 9.5px',
      'letter-spacing: 0.16em',
    ].join(';'),
  );
  headLeft.appendChild(dot);
  headLeft.appendChild(headTitle);
  headLeft.appendChild(headSub);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  styled(
    closeBtn,
    [
      `color: ${FG_DIM}`,
      'background: transparent',
      `border: 1px solid ${PANEL_BORDER}`,
      'width: 18px',
      'height: 18px',
      'line-height: 0',
      'border-radius: 2px',
      'cursor: pointer',
      'font-size: 14px',
      'display: flex',
      'align-items: center',
      'justify-content: center',
    ].join(';'),
  );
  closeBtn.addEventListener('click', () => {
    close();
  });
  closeBtn.addEventListener('mouseenter', () => {
    closeBtn.style.color = FG;
    closeBtn.style.borderColor = ACCENT_DIM;
  });
  closeBtn.addEventListener('mouseleave', () => {
    closeBtn.style.color = FG_DIM;
    closeBtn.style.borderColor = PANEL_BORDER;
  });
  header.appendChild(headLeft);
  header.appendChild(closeBtn);

  // -------------------------------------------------------------------------
  // Body — building name + tier + category + footprint + recipe + power +
  // storage + biome / tile constraints. Layout is a vertical stack of small
  // sections separated by hairline rules.
  // -------------------------------------------------------------------------
  const body = document.createElement('div');
  styled(
    body,
    [
      'display: flex',
      'flex-direction: column',
      'gap: 0',
      'padding: 0',
      'overflow-y: auto',
      'flex: 1 1 auto',
    ].join(';'),
  );

  // -------------------------------------------------------------------------
  // Island-name rename row — text input bound to `target.spec.name`. Sits
  // ABOVE the building title so it's clear the field renames the island,
  // not the building. Pure callback dispatch — the actual mutation lives in
  // `renameIsland` (pure helper in `world.ts`); on success we notify main.ts
  // via `deps.onRenameIsland(target, name)` so the HUD title repaints. On
  // failure (empty / >32 chars / control char), the input value reverts to
  // the current spec name in `paint()`.
  // -------------------------------------------------------------------------
  const nameRow = document.createElement('div');
  styled(
    nameRow,
    [
      'display: flex',
      'align-items: center',
      'gap: 6px',
      'padding: 8px 12px 4px',
    ].join(';'),
  );
  const nameLabel = document.createElement('span');
  nameLabel.textContent = 'NAME';
  styled(
    nameLabel,
    [`color: ${FG_DIM}`, 'font-size: 9.5px', 'letter-spacing: 0.14em', 'flex: 0 0 auto'].join(';'),
  );
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = ISLAND_NAME_MAX_LEN;
  styled(
    nameInput,
    [
      'flex: 1 1 auto',
      `color: ${FG}`,
      `background: ${STRIP_BG}`,
      `border: 1px solid ${PANEL_BORDER}`,
      'border-radius: 2px',
      'padding: 2px 6px',
      'font-family: ui-monospace, monospace',
      'font-size: 11px',
      'letter-spacing: 0.02em',
      'min-width: 0',
    ].join(';'),
  );
  function commitRename(): void {
    if (!target) return;
    const trimmed = nameInput.value.trim();
    if (trimmed.length === 0) {
      // Empty: revert input to current spec name (which is at least `id` —
      // never empty itself), per the task brief "reject empty (revert to
      // id if empty)". We don't write through to spec.
      nameInput.value = target.spec.name;
      return;
    }
    const res = renameIsland(target.spec, trimmed);
    if (res.ok) {
      deps.onRenameIsland(target, trimmed);
    }
    // On failure (too-long, control-char) we revert the input to the
    // current spec name. maxLength guards too-long at typing time, but a
    // paste of >32 chars could slip through, and control chars are not
    // physically blocked by the input.
    nameInput.value = target.spec.name;
  }
  nameInput.addEventListener('blur', commitRename);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
      nameInput.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (target) nameInput.value = target.spec.name;
      nameInput.blur();
    }
  });
  nameRow.appendChild(nameLabel);
  nameRow.appendChild(nameInput);

  // Title row — name + tier badge
  const titleRow = document.createElement('div');
  styled(
    titleRow,
    [
      'display: flex',
      'align-items: baseline',
      'justify-content: space-between',
      'gap: 8px',
      'padding: 10px 12px 6px',
    ].join(';'),
  );
  const nameEl = document.createElement('span');
  styled(
    nameEl,
    [`color: ${FG}`, 'font-size: 13px', 'font-weight: 600', 'letter-spacing: 0.02em'].join(';'),
  );
  const tierBadge = document.createElement('span');
  styled(
    tierBadge,
    [
      `color: ${ACCENT}`,
      `border: 1px solid ${ACCENT_DIM}`,
      'padding: 0 6px',
      'font-size: 10px',
      'letter-spacing: 0.08em',
      'border-radius: 2px',
    ].join(';'),
  );
  titleRow.appendChild(nameEl);
  titleRow.appendChild(tierBadge);

  // Subtitle row — category + footprint badge
  const subtitleRow = document.createElement('div');
  styled(
    subtitleRow,
    [
      'display: flex',
      'align-items: baseline',
      'gap: 10px',
      'padding: 0 12px 10px',
    ].join(';'),
  );
  const categoryEl = document.createElement('span');
  styled(
    categoryEl,
    [`color: ${FG_DIM}`, 'font-size: 10px', 'letter-spacing: 0.14em', 'text-transform: uppercase'].join(';'),
  );
  const footprintEl = document.createElement('span');
  styled(
    footprintEl,
    [`color: ${FG_DIM}`, 'font-size: 10px', 'letter-spacing: 0.05em'].join(';'),
  );
  subtitleRow.appendChild(categoryEl);
  subtitleRow.appendChild(footprintEl);

  function makeSection(label: string): { wrap: HTMLDivElement; body: HTMLDivElement } {
    const wrap = document.createElement('div');
    styled(
      wrap,
      [
        'display: flex',
        'flex-direction: column',
        'gap: 4px',
        'padding: 8px 12px 10px',
        `border-top: 1px solid ${PANEL_BORDER}`,
      ].join(';'),
    );
    const hdr = document.createElement('span');
    hdr.textContent = label;
    styled(
      hdr,
      [
        `color: ${FG_DIM}`,
        'font-size: 9.5px',
        'letter-spacing: 0.14em',
        'text-transform: uppercase',
      ].join(';'),
    );
    const inner = document.createElement('div');
    styled(inner, 'display: flex; flex-direction: column; gap: 3px');
    wrap.appendChild(hdr);
    wrap.appendChild(inner);
    return { wrap, body: inner };
  }

  // Recipe section
  const recipeSection = makeSection('Recipe');
  const recipeStatus = document.createElement('span');
  styled(
    recipeStatus,
    [`color: ${FG_MUTED}`, 'font-size: 10.5px', 'letter-spacing: 0.04em'].join(';'),
  );
  recipeSection.body.appendChild(recipeStatus);
  // The list of input/output rate lines is rebuilt every refresh — clear &
  // rebuild on each paint rather than maintain a stable child set.

  // Effective rate readout
  const effectiveRow = document.createElement('div');
  styled(
    effectiveRow,
    ['display: flex', 'justify-content: space-between', 'gap: 6px'].join(';'),
  );
  const effectiveLabel = document.createElement('span');
  effectiveLabel.textContent = 'CYCLES/S';
  styled(
    effectiveLabel,
    [`color: ${FG_DIM}`, 'font-size: 9.5px', 'letter-spacing: 0.1em'].join(';'),
  );
  const effectiveValue = document.createElement('span');
  styled(
    effectiveValue,
    [`color: ${FG}`, 'font-size: 11px', 'font-weight: 600'].join(';'),
  );
  effectiveRow.appendChild(effectiveLabel);
  effectiveRow.appendChild(effectiveValue);

  // Power section
  const powerSection = makeSection('Power');
  const powerLine = document.createElement('span');
  styled(
    powerLine,
    [`color: ${FG}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(';'),
  );
  powerSection.body.appendChild(powerLine);

  // Storage section (only shown when def.storage exists)
  const storageSection = makeSection('Storage');
  const storageLine = document.createElement('span');
  styled(
    storageLine,
    [`color: ${FG}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(';'),
  );
  storageSection.body.appendChild(storageLine);

  // §4.6 generic-storage controls — cargo-label dropdown + force-clear button.
  // Shown only when the selected building's def is generic-category storage
  // (Crate, Warehouse). The dropdown lists every ResourceId; selecting a new
  // value relabels the building IF the current label's inventory is empty,
  // otherwise the force-clear button is offered (destroys the held stock to
  // free up the relabel).
  const cargoLabelControls = (() => {
    const wrap = document.createElement('div');
    styled(
      wrap,
      ['display: flex', 'flex-direction: column', 'gap: 4px', 'padding-top: 4px'].join(';'),
    );
    const row = document.createElement('div');
    styled(
      row,
      ['display: flex', 'gap: 6px', 'align-items: center'].join(';'),
    );
    const labelTxt = document.createElement('span');
    labelTxt.textContent = 'LABEL';
    styled(
      labelTxt,
      [`color: ${FG_DIM}`, 'font-size: 9.5px', 'letter-spacing: 0.14em'].join(';'),
    );
    const select = document.createElement('select');
    styled(
      select,
      [
        'flex: 1 1 auto',
        `color: ${FG}`,
        `background: ${STRIP_BG}`,
        `border: 1px solid ${PANEL_BORDER}`,
        'border-radius: 2px',
        'padding: 2px 4px',
        'font-family: ui-monospace, monospace',
        'font-size: 10.5px',
        'letter-spacing: 0.02em',
      ].join(';'),
    );
    for (const r of ALL_RESOURCES) {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = `${r}  (${STORAGE_CATEGORY_LABEL[RESOURCE_STORAGE_CATEGORY[r]]})`;
      select.appendChild(opt);
    }
    row.appendChild(labelTxt);
    row.appendChild(select);
    // Force-clear path — shown only when the current cargo has non-zero
    // inventory and the player picks a different label.
    const blockedNote = document.createElement('span');
    styled(
      blockedNote,
      [`color: ${WARN}`, 'font-size: 10px', 'letter-spacing: 0.02em'].join(';'),
    );
    const forceClearBtn = document.createElement('button');
    styled(
      forceClearBtn,
      [
        'background: transparent',
        `color: ${WARN}`,
        `border: 1px solid ${WARN_DIM}`,
        'padding: 3px 8px',
        'cursor: pointer',
        'font-family: ui-monospace, monospace',
        'font-size: 10px',
        'letter-spacing: 0.1em',
        'text-transform: uppercase',
        'border-radius: 2px',
      ].join(';'),
    );
    forceClearBtn.textContent = '▼ DESTROY CONTENTS';
    wrap.appendChild(row);
    wrap.appendChild(blockedNote);
    wrap.appendChild(forceClearBtn);
    return { wrap, select, blockedNote, forceClearBtn };
  })();
  storageSection.body.appendChild(cargoLabelControls.wrap);

  // -------------------------------------------------------------------------
  // Cargo-label relabel logic. The dropdown's change event proposes a new
  // label; the relabel succeeds when current-label inventory is empty,
  // otherwise the force-clear button must be pressed first to destroy
  // contents (§4.6: "or accepts a force-clear that destroys current
  // contents"). After a successful relabel:
  //   - subtract the building's capacity from oldLabel's cap
  //   - add to newLabel's cap
  //   - update b.cargoLabel
  // -------------------------------------------------------------------------
  /** Latest proposed-but-not-yet-applied label (when blocked on non-empty
   *  inventory). Cleared on every paint() so a stale selection doesn't
   *  bleed across building switches. */
  let pendingRelabel: ResourceId | null = null;

  function applyRelabel(b: PlacedBuilding, newLabel: ResourceId): void {
    if (!target) return;
    const def = BUILDING_DEFS[b.defId];
    if (!def.storage || def.storage.category !== 'generic') return;
    const oldLabel = b.cargoLabel;
    if (oldLabel === newLabel) return;
    const cap = def.storage.capacity;
    if (oldLabel !== undefined) {
      const next = (target.state.storageCaps[oldLabel] ?? 0) - cap;
      target.state.storageCaps[oldLabel] = next < 0 ? 0 : next;
      const have = target.state.inventory[oldLabel] ?? 0;
      const newCap = target.state.storageCaps[oldLabel] ?? 0;
      if (have > newCap) target.state.inventory[oldLabel] = newCap;
    }
    target.state.storageCaps[newLabel] =
      (target.state.storageCaps[newLabel] ?? 0) + cap;
    // PlacedBuilding fields are `readonly` at the type level, but the
    // economy loop already mutates `populated` / `discovered` on IslandSpec;
    // the readonly modifier is a doc convention, not a runtime guard. Cast
    // through `Mutable<>` so we don't sprinkle `as any` at the call site.
    (b as Mutable<PlacedBuilding>).cargoLabel = newLabel;
    pendingRelabel = null;
  }

  cargoLabelControls.select.addEventListener('change', () => {
    if (!target) return;
    const newLabel = cargoLabelControls.select.value as ResourceId;
    const b = target.building;
    const oldLabel = b.cargoLabel;
    const heldOld = oldLabel !== undefined
      ? (target.state.inventory[oldLabel] ?? 0)
      : 0;
    if (heldOld <= 0) {
      applyRelabel(b, newLabel);
      paint();
      return;
    }
    // Non-empty: stage the relabel and surface the force-clear path.
    pendingRelabel = newLabel;
    paint();
  });
  cargoLabelControls.forceClearBtn.addEventListener('click', () => {
    if (!target || pendingRelabel === null) return;
    const b = target.building;
    const oldLabel = b.cargoLabel;
    if (oldLabel !== undefined) {
      // §4.6 force-clear: destroy contents.
      target.state.inventory[oldLabel] = 0;
    }
    applyRelabel(b, pendingRelabel);
    paint();
  });

  /** Render the cargo-label UI for the currently-targeted generic-storage
   *  building. Encapsulates the dropdown's selected value, the contribution
   *  text, and the force-clear visibility. Called from `paint()` only. */
  function renderCargoLabelUi(
    b: PlacedBuilding,
    state: IslandState,
    capacity: number,
  ): void {
    cargoLabelControls.wrap.style.display = '';
    const current = b.cargoLabel;
    const proposed = pendingRelabel ?? current;
    cargoLabelControls.select.value = (proposed ?? 'iron_ore') as string;
    if (current === undefined) {
      storageLine.textContent = `+${capacity} cap (unlabeled — pick a resource)`;
      storageLine.style.color = FG_DIM;
    } else {
      storageLine.textContent = `+${capacity} cap on ${current}`;
      storageLine.style.color = FG;
    }
    const held = current !== undefined ? (state.inventory[current] ?? 0) : 0;
    // Force-clear path: visible only when player has staged a new label AND
    // the current label still holds inventory.
    if (
      pendingRelabel !== null &&
      pendingRelabel !== current &&
      current !== undefined &&
      held > 0
    ) {
      cargoLabelControls.blockedNote.style.display = '';
      cargoLabelControls.blockedNote.textContent = `${Math.floor(held)} units of ${current} — destroy to relabel`;
      cargoLabelControls.forceClearBtn.style.display = '';
    } else {
      cargoLabelControls.blockedNote.style.display = 'none';
      cargoLabelControls.forceClearBtn.style.display = 'none';
    }
  }

  // Heat section (§5.2) — only shown when the def is a heat consumer
  // (`requiresHeat`) OR a heat source (`heatSource`). For a consumer, shows
  // whether an adjacent source is currently assigned. For a source, shows
  // how many consumers it serves this tick.
  const heatSection = makeSection('Heat');
  const heatLine = document.createElement('span');
  styled(
    heatLine,
    [`color: ${FG}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(';'),
  );
  heatSection.body.appendChild(heatLine);

  // §4.7 maintenance section — operating-time / threshold readout, plus the
  // tier's maintenance bill of materials. For an Eternal Servitor the
  // section displays the exemption stamp and the recipe is hidden.
  const maintenanceSection = makeSection('Maintenance');
  const maintenanceStatus = document.createElement('span');
  styled(
    maintenanceStatus,
    [`color: ${FG}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(';'),
  );
  const maintenanceRecipeLine = document.createElement('span');
  styled(
    maintenanceRecipeLine,
    [`color: ${FG_DIM}`, 'font-size: 10.5px', 'letter-spacing: 0.02em'].join(';'),
  );
  maintenanceSection.body.appendChild(maintenanceStatus);
  maintenanceSection.body.appendChild(maintenanceRecipeLine);

  // §3.4 Land Reclamation section — shown only when the selected building
  // is a `land_reclamation_hub`. Two buttons (+1 major / +1 minor) wired
  // to deps.onExpandIsland; each shows its current-radius cost or the
  // gate-failure reason inline.
  const reclamationSection = makeSection('Reclamation (§3.4)');
  const reclamationCaption = document.createElement('span');
  styled(
    reclamationCaption,
    [`color: ${FG_DIM}`, 'font-size: 10.5px', 'letter-spacing: 0.02em'].join(';'),
  );
  reclamationSection.body.appendChild(reclamationCaption);
  function makeExpandButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    styled(
      btn,
      [
        'background: transparent',
        `color: ${ACCENT}`,
        `border: 1px solid ${ACCENT_DIM}`,
        'padding: 4px 8px',
        'cursor: pointer',
        'font-family: ui-monospace, monospace',
        'font-size: 10.5px',
        'letter-spacing: 0.08em',
        'text-transform: uppercase',
        'border-radius: 2px',
        'transition: background 80ms ease, border-color 80ms ease',
        'text-align: left',
      ].join(';'),
    );
    btn.addEventListener('mouseenter', () => {
      if (btn.disabled) return;
      btn.style.background = 'rgba(125, 211, 232, 0.08)';
      btn.style.borderColor = ACCENT;
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'transparent';
      btn.style.borderColor = btn.disabled ? FG_MUTED : ACCENT_DIM;
    });
    return btn;
  }
  const expandMajorBtn = makeExpandButton();
  const expandMinorBtn = makeExpandButton();
  expandMajorBtn.addEventListener('click', () => {
    if (!target) return;
    deps.onExpandIsland(target, 'major');
  });
  expandMinorBtn.addEventListener('click', () => {
    if (!target) return;
    deps.onExpandIsland(target, 'minor');
  });
  reclamationSection.body.appendChild(expandMajorBtn);
  reclamationSection.body.appendChild(expandMinorBtn);

  // Constraints (requiredTile / requiredBiomes) — shown only when relevant.
  const constraintsSection = makeSection('Constraints');
  const constraintsLine = document.createElement('span');
  styled(
    constraintsLine,
    [`color: ${FG_DIM}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(';'),
  );
  constraintsSection.body.appendChild(constraintsLine);

  // Demolish footer
  const footerSection = document.createElement('div');
  styled(
    footerSection,
    [
      'display: flex',
      'flex-direction: column',
      'gap: 4px',
      'padding: 10px 12px 12px',
      `border-top: 1px solid ${PANEL_BORDER}`,
      `background: ${STRIP_BG}`,
    ].join(';'),
  );
  const demolishBtn = document.createElement('button');
  styled(
    demolishBtn,
    [
      'background: transparent',
      `color: ${WARN}`,
      `border: 1px solid ${WARN_DIM}`,
      'padding: 5px 10px',
      'cursor: pointer',
      'font-family: ui-monospace, monospace',
      'font-size: 11px',
      'letter-spacing: 0.14em',
      'text-transform: uppercase',
      'border-radius: 2px',
      'transition: background 80ms ease, border-color 80ms ease',
    ].join(';'),
  );
  demolishBtn.addEventListener('mouseenter', () => {
    demolishBtn.style.background = 'rgba(245, 167, 66, 0.10)';
    demolishBtn.style.borderColor = WARN;
  });
  demolishBtn.addEventListener('mouseleave', () => {
    demolishBtn.style.background = 'transparent';
    demolishBtn.style.borderColor = WARN_DIM;
  });
  demolishBtn.addEventListener('click', () => {
    if (!target) return;
    const credit = previewScrapForBuilding(target.building.defId);
    const refund = previewRefundForBuilding(target.building);
    const refundStr = formatRefund(refund);
    const def = BUILDING_DEFS[target.building.defId];
    // §14: surface both the scrap credit and the 50%-cost refund in the
    // confirm prompt so the player sees the full reversal value before
    // committing. Refunds clip to storage caps at execute-time; the
    // dialog shows the raw refund.
    const msg = refundStr
      ? `Demolish ${def.displayName}? Returns ${credit} scrap and ${refundStr}. This is irreversible.`
      : `Demolish ${def.displayName}? Returns ${credit} scrap. This is irreversible.`;
    // `window.confirm` is the simplest portable confirmation modal — see
    // task brief ("confirmation modal via `window.confirm()`"). Production
    // UX could replace this with an inline confirm step inside the panel.
    if (!window.confirm(msg)) {
      demolishBtn.blur();
      return;
    }
    // The callback owns the demolition + post-mutation cleanup
    // (rebuildWorldLayers, inspector close). We do NOT close here so the
    // callback's `close()` is the single exit point; if the callback
    // forgets, the dock stays open with stale data — surfaced as an obvious
    // UX bug rather than a silent corruption.
    const handoff = target;
    deps.onDemolish(handoff);
  });
  footerSection.appendChild(demolishBtn);

  body.appendChild(nameRow);
  body.appendChild(titleRow);
  body.appendChild(subtitleRow);
  body.appendChild(recipeSection.wrap);
  // Effective rate row sits below the recipe lines but inside the recipe
  // section visually — append a thin spacer + row to the recipe section body.
  recipeSection.body.appendChild(effectiveRow);
  body.appendChild(powerSection.wrap);
  body.appendChild(storageSection.wrap);
  body.appendChild(heatSection.wrap);
  body.appendChild(maintenanceSection.wrap);
  body.appendChild(reclamationSection.wrap);
  body.appendChild(constraintsSection.wrap);

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footerSection);
  parentEl.appendChild(panel);

  // -------------------------------------------------------------------------
  // Recipe-line management — variable count, so we lazy-track existing rows
  // and recycle them by index rather than create/destroy on every refresh.
  // -------------------------------------------------------------------------
  const recipeLineEls: HTMLDivElement[] = [];
  function ensureRecipeLineCount(n: number): void {
    while (recipeLineEls.length < n) {
      const row = document.createElement('div');
      styled(
        row,
        ['display: flex', 'justify-content: space-between', 'gap: 6px', 'align-items: baseline'].join(';'),
      );
      const left = document.createElement('span');
      styled(
        left,
        [`color: ${FG}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(';'),
      );
      const right = document.createElement('span');
      styled(
        right,
        [`color: ${FG}`, 'font-size: 11px', 'font-weight: 600'].join(';'),
      );
      row.appendChild(left);
      row.appendChild(right);
      // Insert BEFORE the effective-rate row so the cycle line stays last.
      recipeSection.body.insertBefore(row, effectiveRow);
      recipeLineEls.push(row);
    }
    for (let i = 0; i < recipeLineEls.length; i++) {
      const el = recipeLineEls[i];
      if (el) el.style.display = i < n ? '' : 'none';
    }
  }

  // -------------------------------------------------------------------------
  // §3.4 Reclamation paint helper — renders the two expand buttons + caption
  // for the currently-targeted Land Reclamation Hub. Encapsulates the per-
  // axis gate / cost / labelling so `paint()` stays readable.
  // -------------------------------------------------------------------------
  function reclamationButtonText(axis: Axis, current: number, gate: ExpandResult): string {
    const label = axis === 'major' ? '+1 MAJOR' : '+1 MINOR';
    if (gate.ok) {
      const cost = landReclamationCost(current);
      return `${label} · ${cost.stone} STONE (r ${current} → ${current + 1})`;
    }
    if (gate.reason === 'axis-at-max') return `${label} · AT CAP`;
    if (gate.reason === 'insufficient-resources') {
      const cost = landReclamationCost(current);
      return `${label} · NEED ${cost.stone} STONE`;
    }
    // no-hub shouldn't reach here (section is only shown for the Hub
    // itself, so `hasLandReclamationHub` is always true), but treat
    // defensively.
    return `${label} · NO HUB`;
  }
  function setExpandButtonState(btn: HTMLButtonElement, gate: ExpandResult): void {
    btn.disabled = !gate.ok;
    if (gate.ok) {
      btn.style.color = ACCENT;
      btn.style.borderColor = ACCENT_DIM;
      btn.style.cursor = 'pointer';
      btn.style.opacity = '1';
    } else {
      btn.style.color = FG_MUTED;
      btn.style.borderColor = FG_MUTED;
      btn.style.cursor = 'not-allowed';
      btn.style.opacity = '0.6';
    }
  }
  function paintReclamation(spec: IslandSpec, state: IslandState): void {
    const caps = BIOME_MAX_RADII[spec.biome];
    reclamationCaption.textContent =
      `${spec.biome} · ${spec.majorRadius}/${caps.major} maj · ${spec.minorRadius}/${caps.minor} min`;
    const majorGate = canExpandIsland(spec, state, 'major');
    const minorGate = canExpandIsland(spec, state, 'minor');
    expandMajorBtn.textContent = reclamationButtonText('major', spec.majorRadius, majorGate);
    expandMinorBtn.textContent = reclamationButtonText('minor', spec.minorRadius, minorGate);
    setExpandButtonState(expandMajorBtn, majorGate);
    setExpandButtonState(expandMinorBtn, minorGate);
  }

  // -------------------------------------------------------------------------
  // Paint
  // -------------------------------------------------------------------------
  function paint(): void {
    if (!target) return;
    const { spec, state, building } = target;
    const def = BUILDING_DEFS[building.defId as BuildingDefId];

    // Repopulate the rename input UNLESS the player is currently editing
    // (input has focus). Repainting through `value=` while focused
    // resets the caret mid-typing, which is hostile UX. The blur/Enter
    // handler covers the commit path; until then we leave the field alone.
    if (document.activeElement !== nameInput) {
      nameInput.value = spec.name;
    }

    nameEl.textContent = def.displayName;
    tierBadge.textContent = `T${def.tier}`;
    categoryEl.textContent = CATEGORY_LABEL[def.category].toUpperCase();
    footprintEl.textContent = `${def.width}×${def.height}  ·  rot ${(building.rotation ?? 0) * 90}°`;

    // Recipe (resolveRecipe for Mine tile-aware variant — see §8.1).
    const recipe = resolveRecipe(BUILDING_DEFS[building.defId], building, spec.terrainAt);
    if (!recipe) {
      recipeStatus.textContent = '— no recipe';
      recipeStatus.style.color = FG_MUTED;
      recipeStatus.style.display = '';
      ensureRecipeLineCount(0);
      effectiveValue.textContent = '—';
      effectiveValue.style.color = FG_DIM;
    } else {
      // Find the per-building effective rate from a fresh computeRates pass.
      // The HUD also calls computeRates each frame, so the second call here
      // is a minor cost; it's the simplest way to read THIS building's
      // current effectiveRate without threading it through the inspector deps.
      const rates = computeRates(state, { terrainAt: spec.terrainAt });
      const br = rates.byBuilding.find((r) => r.building.id === building.id);
      const effective = br?.effectiveRate ?? 0;
      // Header status line — show cycle time + base rate (= 1 / cycleSec).
      recipeStatus.textContent = `cycle ${recipe.cycleSec}s · base ${(1 / recipe.cycleSec).toFixed(3)}/s`;
      recipeStatus.style.color = FG_DIM;
      recipeStatus.style.display = '';

      const lines = recipeToLines(recipe, effective);
      ensureRecipeLineCount(lines.length);
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const row = recipeLineEls[i];
        if (!ln || !row) continue;
        const left = row.firstChild as HTMLSpanElement;
        const right = row.lastChild as HTMLSpanElement;
        if (left) {
          left.textContent = ln.resource;
          left.style.color = ln.direction === 'out' ? FG : FG_DIM;
        }
        if (right) {
          right.textContent = formatRate(ln.direction, ln.rate);
          right.style.color = ln.direction === 'out' ? ACCENT : WARN;
        }
      }

      effectiveValue.textContent = effective.toFixed(3);
      effectiveValue.style.color = effective > 0 ? ACCENT : FG_MUTED;
    }

    // Power section
    const prod = def.power?.produces ?? 0;
    const cons = def.power?.consumes ?? 0;
    if (prod === 0 && cons === 0) {
      powerLine.textContent = '— no power';
      powerLine.style.color = FG_MUTED;
      powerSection.wrap.style.display = '';
    } else {
      const parts: string[] = [];
      if (prod > 0) parts.push(`+${prod}W produced`);
      if (cons > 0) parts.push(`-${cons}W consumed`);
      powerLine.textContent = parts.join('  ·  ');
      powerLine.style.color = FG;
      powerSection.wrap.style.display = '';
    }

    // Storage section — §4.6 categorized routing. Specialized buildings
    // report their category and capacity; generic buildings additionally
    // expose the cargo-label dropdown for relabeling.
    if (def.storage) {
      const cap = def.storage.capacity;
      if (def.storage.category === 'generic') {
        // Generic: show "+cap on <label>" plus the dropdown.
        renderCargoLabelUi(building, state, cap);
      } else {
        // Specialized: show "+cap to <category>" with the matching count.
        cargoLabelControls.wrap.style.display = 'none';
        const catLabel = STORAGE_CATEGORY_LABEL[def.storage.category];
        storageLine.textContent = `+${cap} cap on ${catLabel}`;
        storageLine.style.color = FG;
      }
      storageSection.wrap.style.display = '';
    } else {
      storageSection.wrap.style.display = 'none';
      cargoLabelControls.wrap.style.display = 'none';
    }

    // Heat section (§5.2). Shown only for heat consumers / heat sources.
    // One additional computeRates pass per paint — cheap; matches the
    // existing inspector pattern of re-deriving rates per refresh rather
    // than threading the snapshot in via deps.
    if (def.requiresHeat || def.heatSource) {
      const heat = computeRates(state, { terrainAt: spec.terrainAt }).heat;
      if (def.requiresHeat) {
        const has = heat.hasHeat.get(building.id) === true;
        if (has) {
          const src = heat.assignedSource.get(building.id) ?? '?';
          heatLine.textContent = `✓ heat OK  ·  source: ${src}`;
          heatLine.style.color = ACCENT;
        } else {
          heatLine.textContent = 'NO HEAT SOURCE ADJACENT';
          heatLine.style.color = WARN;
        }
      } else if (def.heatSource) {
        // Source: report served consumers. Free sources show their tag, coal
        // sources also show the count (which drives fuel burn).
        const served =
          def.heatSource.freeOrCoal === 'coal'
            ? (heat.coalConsumersByFurnace.get(building.id) ?? 0)
            : // Free sources don't aggregate in coalConsumersByFurnace; count
              // by scanning assignments. Cheap (≤ ~30 consumers per island).
              Array.from(heat.assignedSource.values()).filter(
                (sid) => sid === building.id,
              ).length;
        const tag = def.heatSource.freeOrCoal === 'free' ? 'free' : 'coal';
        heatLine.textContent = `${tag} source  ·  serving ${served} consumer${served === 1 ? '' : 's'}`;
        heatLine.style.color = FG;
      }
      heatSection.wrap.style.display = '';
    } else {
      heatSection.wrap.style.display = 'none';
    }

    // §4.7 maintenance section. Three display modes:
    //   - Eternal Servitor exempt → single bold line, recipe hidden.
    //   - Under threshold → "12h 30m / 24h" + recipe (preview).
    //   - Over threshold → "OVERDUE — degraded to 67%" + recipe + warning color.
    if (building.eternalServitor === true) {
      maintenanceStatus.textContent = 'ETERNAL SERVITOR — exempt';
      maintenanceStatus.style.color = ACCENT;
      maintenanceRecipeLine.textContent = '';
      maintenanceRecipeLine.style.display = 'none';
    } else {
      const operating = building.operatingMs ?? 0;
      const threshold = MAINTENANCE_THRESHOLD_MS_BY_TIER[def.tier];
      const factor = maintenanceFactor(building, def);
      if (operating < threshold) {
        maintenanceStatus.textContent = `${formatHM(operating)} / ${formatHM(threshold)}`;
        maintenanceStatus.style.color = FG;
      } else {
        const pct = Math.round(factor * 100);
        maintenanceStatus.textContent = `OVERDUE — degraded to ${pct}%`;
        maintenanceStatus.style.color = WARN;
      }
      const recipe = MAINTENANCE_RECIPES[def.tier];
      const recipeParts: string[] = [];
      for (const [r, need] of Object.entries(recipe)) {
        if ((need ?? 0) === 0) continue;
        recipeParts.push(`${need} ${r}`);
      }
      maintenanceRecipeLine.textContent =
        recipeParts.length > 0 ? `needs: ${recipeParts.join(' + ')}` : '';
      maintenanceRecipeLine.style.display = '';
    }
    maintenanceSection.wrap.style.display = '';

    // §3.4 Land Reclamation section — only for the Hub itself. Renders
    // two expansion buttons; each is enabled when canExpandIsland
    // returns ok, otherwise disabled with the rejection reason inline.
    if (def.id === 'land_reclamation_hub') {
      paintReclamation(spec, state);
      reclamationSection.wrap.style.display = '';
    } else {
      reclamationSection.wrap.style.display = 'none';
    }

    // Constraints section — shown when requiredTile or requiredBiomes apply.
    const parts: string[] = [];
    if (def.requiredTile && def.requiredTile.length > 0) {
      parts.push(`tile: ${def.requiredTile.join(' / ')}`);
    }
    if (def.requiredBiomes && def.requiredBiomes.length > 0) {
      parts.push(`biome: ${def.requiredBiomes.join(' / ')}`);
    }
    if (parts.length === 0) {
      constraintsSection.wrap.style.display = 'none';
    } else {
      constraintsLine.textContent = parts.join('  ·  ');
      constraintsSection.wrap.style.display = '';
    }

    // Demolish button — credit preview baked into the label so the player
    // doesn't have to click before learning the cost.
    const credit = previewScrapForBuilding(building.defId);
    demolishBtn.textContent = `▼ DEMOLISH · +${credit} SCRAP`;
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  function open(t: InspectorTarget): void {
    target = t;
    // Reset any staged relabel from a previous inspection — pendingRelabel
    // is per-selection state, not per-panel.
    pendingRelabel = null;
    panel.style.display = 'flex';
    paint();
  }
  function close(): void {
    if (!target) return;
    target = null;
    pendingRelabel = null;
    panel.style.display = 'none';
  }
  function refresh(): void {
    if (!target) return;
    paint();
  }
  function isVisible(): boolean {
    return target !== null;
  }
  function getSelectedBuildingId(): string | null {
    return target ? target.building.id : null;
  }

  return {
    el: panel,
    open,
    close,
    isVisible,
    refresh,
    getSelectedBuildingId,
  };
}
