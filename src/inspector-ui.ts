// Building Inspector — side dock that opens when a placed building is
// selected on the map. Sister to drones-ui / routes-ui / settlement-ui:
// same industrial-readout vocabulary (var(--ri-accent) cyan title, var(--ri-fg-3) secondary
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
  type GateRequirement,
} from './building-defs.js';
import { gateSatisfied } from './adjacency.js';
import { shapeHeight, shapeWidth } from './shape-mask.js';
import { affordabilityShortfall, placementCostFor } from './placement.js';
import { convertToServitor, type PlacedBuilding } from './buildings.js';
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
  refreshCostFor,
  tryRefreshMaintenance,
} from './maintenance.js';
import { ALL_RESOURCES, resolveRecipe, type Recipe, type ResourceId } from './recipes.js';
import { effectiveSkillMultipliers, type SkillMultipliers } from './skilltree.js';
import { RESOURCE_STORAGE_CATEGORY, type StorageCategory } from './storage-categories.js';
import {
  BIOME_MAX_RADII,
  ISLAND_NAME_MAX_LEN,
  renameIsland,
  type IslandSpec,
  type WorldState,
} from './world.js';
import { editIslandBiome, UNIVERSE_EDITOR_COST } from './universe-editor.js';
import { mountPanel, Zone } from './ui-zones.js';



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

function gateLabel(gate: GateRequirement): string {
  const suffix = (gate.minCount ?? 1) > 1 ? ` ×${gate.minCount}` : '';
  switch (gate.matchType) {
    case 'heat_source': return `Heat Source${suffix}`;
    case 'same_def': return `Same Type${suffix}`;
    case 'same_category': return `${gate.category ?? 'unknown category'}${suffix}`;
    case 'def_id': return `${BUILDING_DEFS[gate.defId!]?.displayName ?? gate.defId!}${suffix}`;
  }
}

function styled(el: HTMLElement, css: string): void {
  el.style.cssText = css;
}

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
  /** Live world reference — needed by the §13.3 Universe Editor flow which
   *  mutates the active island's spec biome and re-rolls modifiers in
   *  place. The inspector only reads `deps.world.seed` + walks
   *  `deps.world.islandStates`; mutations stay scoped to the active
   *  island. */
  readonly world: WorldState;
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
  /** §13.3 Universe Editor — called after `editIslandBiome` mutates the
   *  active island's biome + terrain + modifiers. main.ts rebuilds world
   *  layers (new terrain colors), invalidates modifier-multiplier caches,
   *  and refreshes the inspector against the same selected building. */
  onIslandBiomeReassigned?(islandId: string): void;
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
  const sign = direction === 'out' ? '+' : '−';
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
  // Panel shell — mounted via zone manager on the left edge so it doesn't
  // fight the side docks for the right edge.
  // -------------------------------------------------------------------------
  const panel = document.createElement('div');
  panel.id = 'inspector-panel';
  panel.classList.add('ri-panel');
  panel.dataset.screenLabel = 'Inspector';
  styled(
    panel,
    [
      'width: 268px',
      'max-height: calc(100vh - 248px)',
      'font-family: ui-monospace, monospace',
      'font-size: 12px',
      'line-height: 1.45',
      'font-variant-numeric: tabular-nums',
      'display: flex',
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
      `border-bottom: 1px solid ${'var(--ri-border-strong)'}`,
      `background: ${'rgba(24, 29, 39, 0.6)'}`,
    ].join(';'),
  );
  const headLeft = document.createElement('div');
  styled(headLeft, 'display: flex; align-items: baseline; gap: 7px');
  const dot = document.createElement('span');
  dot.textContent = '◉';
  styled(dot, `color: ${'var(--ri-accent)'}; font-size: 10px`);
  const headTitle = document.createElement('span');
  headTitle.textContent = 'INSPECT';
  styled(
    headTitle,
    [
      `color: ${'var(--ri-accent)'}`,
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
      `color: ${'var(--ri-fg-3)'}`,
      'font-size: 9.5px',
      'letter-spacing: 0.16em',
    ].join(';'),
  );
  headLeft.appendChild(dot);
  headLeft.appendChild(headTitle);
  headLeft.appendChild(headSub);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.classList.add('ri-modal__close');
  styled(
    closeBtn,
    [
      'width: 18px',
      'height: 18px',
      'line-height: 0',
      'border-radius: 2px',
      'font-size: 14px',
    ].join(';'),
  );
  closeBtn.addEventListener('click', () => {
    close();
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
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 9.5px', 'letter-spacing: 0.14em', 'flex: 0 0 auto'].join(';'),
  );
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = ISLAND_NAME_MAX_LEN;
  styled(
    nameInput,
    [
      'flex: 1 1 auto',
      `color: ${'var(--ri-fg-1)'}`,
      `background: ${'rgba(24, 29, 39, 0.6)'}`,
      `border: 1px solid ${'var(--ri-border-strong)'}`,
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
    [`color: ${'var(--ri-fg-1)'}`, 'font-size: 13px', 'font-weight: 600', 'letter-spacing: 0.02em'].join(';'),
  );
  const tierBadge = document.createElement('span');
  styled(
    tierBadge,
    [
      `color: ${'var(--ri-accent)'}`,
      `border: 1px solid ${'var(--ri-accent-dim)'}`,
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
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 10px', 'letter-spacing: 0.14em', 'text-transform: uppercase'].join(';'),
  );
  const footprintEl = document.createElement('span');
  styled(
    footprintEl,
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 10px', 'letter-spacing: 0.05em'].join(';'),
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
        `border-top: 1px solid ${'var(--ri-border-strong)'}`,
      ].join(';'),
    );
    const hdr = document.createElement('span');
    hdr.textContent = label;
    styled(
      hdr,
      [
        `color: ${'var(--ri-fg-3)'}`,
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

  // Construction section — visible only while constructionRemainingMs > 0.
  // Sits above Recipe so the "X.Xs remaining (NN%)" readout is the first
  // thing a player sees on a fresh placement.
  const constructionSection = makeSection('Construction');
  const constructionStatus = document.createElement('span');
  constructionStatus.classList.add('ri-mono');
  styled(
    constructionStatus,
    [`color: ${'var(--ri-accent)'}`, 'font-size: 11px', 'letter-spacing: 0.04em', 'font-weight: 600'].join(';'),
  );
  constructionSection.body.appendChild(constructionStatus);

  // §4 ocean-layer (Task 10): pause-reason chip — surfaced only when an
  // ocean platform's anchor / terrain check has failed. Mirrors the
  // construction section's display-by-state pattern (hidden when not
  // applicable). Warn-colored to telegraph "this building isn't producing
  // and needs attention" without requiring the player to read the (empty)
  // rate row to deduce the same.
  const pausedSection = makeSection('Status');
  const pausedStatus = document.createElement('span');
  pausedStatus.classList.add('ri-mono');
  styled(
    pausedStatus,
    [`color: ${'var(--ri-warn)'}`, 'font-size: 11px', 'letter-spacing: 0.04em', 'font-weight: 600'].join(';'),
  );
  pausedSection.body.appendChild(pausedStatus);

  // Recipe section
  const recipeSection = makeSection('Recipe');
  const recipeStatus = document.createElement('span');
  styled(
    recipeStatus,
    [`color: ${'var(--ri-fg-4)'}`, 'font-size: 10.5px', 'letter-spacing: 0.04em'].join(';'),
  );
  recipeSection.body.appendChild(recipeStatus);
  // The list of input/output rate lines is rebuilt every refresh — clear &
  // rebuild on each paint rather than maintain a stable child set.

  // Skill / modifier / specialization bonus annotation. Shown only when the
  // composite recipe-rate multiplier exceeds 1.0 (or yield bonus for
  // mine/logger drops above identity). Helps players see why a Smelter is
  // running 1.15× vs nominal — the ×N skills are otherwise invisible since
  // `effective` already bakes them in.
  const bonusesRow = document.createElement('div');
  styled(
    bonusesRow,
    ['display: flex', 'justify-content: space-between', 'gap: 6px'].join(';'),
  );
  const bonusesLabel = document.createElement('span');
  bonusesLabel.textContent = 'BONUSES';
  styled(
    bonusesLabel,
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 9.5px', 'letter-spacing: 0.1em'].join(';'),
  );
  const bonusesValue = document.createElement('span');
  bonusesValue.classList.add('ri-mono');
  styled(
    bonusesValue,
    [`color: ${'var(--ri-accent)'}`, 'font-size: 11px', 'font-weight: 600'].join(';'),
  );
  bonusesRow.appendChild(bonusesLabel);
  bonusesRow.appendChild(bonusesValue);

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
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 9.5px', 'letter-spacing: 0.1em'].join(';'),
  );
  const effectiveValue = document.createElement('span');
  effectiveValue.classList.add('ri-mono');
  styled(
    effectiveValue,
    [`color: ${'var(--ri-fg-1)'}`, 'font-size: 11px', 'font-weight: 600'].join(';'),
  );
  effectiveRow.appendChild(effectiveLabel);
  effectiveRow.appendChild(effectiveValue);

  // Power section
  const powerSection = makeSection('Power');
  const powerLine = document.createElement('span');
  styled(
    powerLine,
    [`color: ${'var(--ri-fg-1)'}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(';'),
  );
  powerSection.body.appendChild(powerLine);

  // Gate section (only shown when def.gates exists)
  const gateSection = makeSection('Gates');

  // Storage section (only shown when def.storage exists)
  const storageSection = makeSection('Storage');
  const storageLine = document.createElement('span');
  styled(
    storageLine,
    [`color: ${'var(--ri-fg-1)'}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(';'),
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
      [`color: ${'var(--ri-fg-3)'}`, 'font-size: 9.5px', 'letter-spacing: 0.14em'].join(';'),
    );
    const select = document.createElement('select');
    styled(
      select,
      [
        'flex: 1 1 auto',
        `color: ${'var(--ri-fg-1)'}`,
        `background: ${'rgba(24, 29, 39, 0.6)'}`,
        `border: 1px solid ${'var(--ri-border-strong)'}`,
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
      [`color: ${'var(--ri-warn)'}`, 'font-size: 10px', 'letter-spacing: 0.02em'].join(';'),
    );
    const forceClearBtn = document.createElement('button');
    styled(
      forceClearBtn,
      [
        'background: transparent',
        `color: ${'var(--ri-warn)'}`,
        `border: 1px solid ${'rgba(245, 167, 66, 0.4)'}`,
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
    b.cargoLabel = newLabel;
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
      storageLine.style.color = 'var(--ri-fg-3)';
    } else {
      storageLine.textContent = `+${capacity} cap on ${current}`;
      storageLine.style.color = 'var(--ri-fg-1)';
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
    [`color: ${'var(--ri-fg-1)'}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(';'),
  );
  heatSection.body.appendChild(heatLine);

  // §4.7 maintenance section — operating-time / threshold readout, plus the
  // tier's maintenance bill of materials. For an Eternal Servitor the
  // section displays the exemption stamp and the recipe is hidden.
  const maintenanceSection = makeSection('Maintenance');
  const maintenanceStatus = document.createElement('span');
  styled(
    maintenanceStatus,
    [`color: ${'var(--ri-fg-1)'}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(';'),
  );
  const maintenanceRecipeLine = document.createElement('span');
  styled(
    maintenanceRecipeLine,
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 10.5px', 'letter-spacing: 0.02em'].join(';'),
  );
  maintenanceSection.body.appendChild(maintenanceStatus);
  maintenanceSection.body.appendChild(maintenanceRecipeLine);

  // §13.3 Convert to Eternal Servitor button — shown only when the island
  // has a Reality Forge and the selected building is not already a Servitor.
  const convertBtn = document.createElement('button');
  styled(
    convertBtn,
    [
      'background: transparent',
      `color: ${'var(--ri-accent)'}`,
      `border: 1px solid ${'var(--ri-accent-dim)'}`,
      'padding: 4px 8px',
      'cursor: pointer',
      'font-family: ui-monospace, monospace',
      'font-size: 10.5px',
      'letter-spacing: 0.08em',
      'text-transform: uppercase',
      'border-radius: 2px',
      'transition: background 80ms ease, border-color 80ms ease',
      'text-align: left',
      'margin-top: 4px',
    ].join(';'),
  );
  convertBtn.addEventListener('mouseenter', () => {
    if (convertBtn.disabled) return;
    convertBtn.style.background = 'rgba(125, 211, 232, 0.08)';
    convertBtn.style.borderColor = 'var(--ri-accent)';
  });
  convertBtn.addEventListener('mouseleave', () => {
    convertBtn.style.background = 'transparent';
    convertBtn.style.borderColor = convertBtn.disabled ? 'var(--ri-fg-4)' : 'var(--ri-accent-dim)';
  });
  convertBtn.addEventListener('click', () => {
    if (!target) return;
    const res = convertToServitor(target.state, target.building.id, BUILDING_DEFS);
    if (res.ok) {
      paint();
    }
  });
  maintenanceSection.body.appendChild(convertBtn);

  // §13.3 Universe Editor — biome-reassign action. Shown only when the
  // selected building is a `universe_editor`. Cost preview + confirm
  // dialog with the spec's "real cost" wording.
  const universeEditorSection = makeSection('Universe Editor (§13.3)');
  const ueCaption = document.createElement('span');
  styled(
    ueCaption,
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 10.5px', 'letter-spacing: 0.02em'].join(';'),
  );
  universeEditorSection.body.appendChild(ueCaption);
  const ueBiomeRow = document.createElement('div');
  styled(ueBiomeRow, 'display: flex; gap: 4px; flex-wrap: wrap; padding-top: 4px');
  universeEditorSection.body.appendChild(ueBiomeRow);
  universeEditorSection.wrap.style.display = 'none';

  // §3.4 Land Reclamation section — shown only when the selected building
  // is a `land_reclamation_hub`. Two buttons (+1 major / +1 minor) wired
  // to deps.onExpandIsland; each shows its current-radius cost or the
  // gate-failure reason inline.
  const reclamationSection = makeSection('Reclamation (§3.4)');
  const reclamationCaption = document.createElement('span');
  styled(
    reclamationCaption,
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 10.5px', 'letter-spacing: 0.02em'].join(';'),
  );
  reclamationSection.body.appendChild(reclamationCaption);
  function makeExpandButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    styled(
      btn,
      [
        'background: transparent',
        `color: ${'var(--ri-accent)'}`,
        `border: 1px solid ${'var(--ri-accent-dim)'}`,
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
      btn.style.borderColor = 'var(--ri-accent)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'transparent';
      btn.style.borderColor = btn.disabled ? 'var(--ri-fg-4)' : 'var(--ri-accent-dim)';
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
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(';'),
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
      `border-top: 1px solid ${'var(--ri-border-strong)'}`,
      `background: ${'rgba(24, 29, 39, 0.6)'}`,
    ].join(';'),
  );
  const refreshBtn = document.createElement('button');
  styled(
    refreshBtn,
    [
      'background: transparent',
      `color: ${'var(--ri-accent)'}`,
      `border: 1px solid ${'var(--ri-accent-dim)'}`,
      'padding: 4px 8px',
      'cursor: pointer',
      'font-family: ui-monospace, monospace',
      'font-size: 10.5px',
      'letter-spacing: 0.08em',
      'text-transform: uppercase',
      'border-radius: 2px',
      'transition: background 80ms ease, border-color 80ms ease',
      'text-align: left',
      'margin-bottom: 4px',
    ].join(';'),
  );
  refreshBtn.style.display = 'none';
  refreshBtn.addEventListener('mouseenter', () => {
    if (refreshBtn.disabled) return;
    refreshBtn.style.background = 'rgba(125, 211, 232, 0.08)';
    refreshBtn.style.borderColor = 'var(--ri-accent)';
  });
  refreshBtn.addEventListener('mouseleave', () => {
    refreshBtn.style.background = 'transparent';
    refreshBtn.style.borderColor = refreshBtn.disabled ? 'var(--ri-fg-4)' : 'var(--ri-accent-dim)';
  });
  refreshBtn.addEventListener('click', () => {
    if (!target) return;
    const def = BUILDING_DEFS[target.building.defId];
    const ok = tryRefreshMaintenance(
      target.building,
      def,
      target.state.inventory,
      Date.now(),
      effectiveSkillMultipliers(target.state).maintenanceThreshold,
    );
    if (ok) paint();
  });
  footerSection.appendChild(refreshBtn);

  const demolishBtn = document.createElement('button');
  styled(
    demolishBtn,
    [
      `color: ${'var(--ri-warn)'}`,
      'padding: 5px 10px',
      'font-family: ui-monospace, monospace',
      'font-size: 11px',
      'letter-spacing: 0.14em',
      'text-transform: uppercase',
    ].join(';'),
  );
  demolishBtn.classList.add('ri-warnbtn');
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
  body.appendChild(constructionSection.wrap);
  body.appendChild(pausedSection.wrap);
  body.appendChild(recipeSection.wrap);
  // Effective rate row sits below the recipe lines but inside the recipe
  // section visually — append a thin spacer + row to the recipe section body.
  // Bonuses sits between recipe lines and effective rate so the skill stack
  // is visible before the cycles/s readout it produces.
  recipeSection.body.appendChild(bonusesRow);
  recipeSection.body.appendChild(effectiveRow);
  body.appendChild(powerSection.wrap);
  body.appendChild(gateSection.wrap);
  body.appendChild(storageSection.wrap);
  body.appendChild(heatSection.wrap);
  body.appendChild(maintenanceSection.wrap);
  body.appendChild(universeEditorSection.wrap);
  body.appendChild(reclamationSection.wrap);
  body.appendChild(constraintsSection.wrap);

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footerSection);
  parentEl.appendChild(panel);

  const panelHandle = mountPanel(panel, {
    id: 'inspector-panel',
    zone: Zone.L,
    order: 0,
  });
  panelHandle.setVisible(false);

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
        [`color: ${'var(--ri-fg-1)'}`, 'font-size: 11px', 'letter-spacing: 0.02em'].join(';'),
      );
      const right = document.createElement('span');
      right.classList.add('ri-mono');
      styled(
        right,
        [`color: ${'var(--ri-fg-1)'}`, 'font-size: 11px', 'font-weight: 600'].join(';'),
      );
      row.appendChild(left);
      row.appendChild(right);
      // Insert BEFORE the bonuses row (which itself sits above effective)
      // so the per-resource rate lines stay above the bonuses + effective
      // summary rows.
      recipeSection.body.insertBefore(row, bonusesRow);
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
      btn.style.color = 'var(--ri-accent)';
      btn.style.borderColor = 'var(--ri-accent-dim)';
      btn.style.cursor = 'pointer';
      btn.style.opacity = '1';
    } else {
      btn.style.color = 'var(--ri-fg-4)';
      btn.style.borderColor = 'var(--ri-fg-4)';
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
    footprintEl.textContent = `${shapeWidth(def.footprint)}×${shapeHeight(def.footprint)}  ·  rot ${(building.rotation ?? 0) * 90}°`;

    // §9.3 Construction status — show "X.Xs remaining" while
    // constructionRemainingMs > 0. The cyan arc overlay on the building tile
    // (drawn by building-alerts-overlay) tells the player something is in
    // progress; this readout puts a number on it. Total construction time
    // isn't stored on the building (only remaining), so we don't compute
    // percent — the visible arc carries that information.
    const remainingMs = building.constructionRemainingMs ?? 0;
    if (remainingMs > 0) {
      constructionStatus.textContent = `${(remainingMs / 1000).toFixed(1)}s remaining`;
      constructionSection.wrap.style.display = '';
    } else {
      constructionSection.wrap.style.display = 'none';
    }
    // §4 ocean-layer (Task 10): surface the paused reason on the chip.
    // Mirrors the construction-section visible-by-state pattern; hidden
    // for any building whose `paused` is undefined (the common case).
    if (building.paused === 'anchor-depopulated') {
      pausedStatus.textContent = 'PAUSED — anchor island unpopulated';
      pausedSection.wrap.style.display = '';
    } else if (building.paused === 'terrain-lost') {
      pausedStatus.textContent = 'PAUSED — terrain lost (cell no longer ocean)';
      pausedSection.wrap.style.display = '';
    } else {
      pausedSection.wrap.style.display = 'none';
    }

    // Recipe (resolveRecipe for Mine tile-aware variant — see §8.1).
    const recipe = resolveRecipe(BUILDING_DEFS[building.defId], building, spec.terrainAt);
    if (!recipe) {
      recipeStatus.textContent = '— no recipe';
      recipeStatus.style.color = 'var(--ri-fg-4)';
      recipeStatus.style.display = '';
      ensureRecipeLineCount(0);
      effectiveValue.textContent = '—';
      effectiveValue.style.color = 'var(--ri-fg-3)';
      bonusesRow.style.display = 'none';
    } else {
      // Find the per-building effective rate from a fresh computeRates pass.
      // The HUD also calls computeRates each frame, so the second call here
      // is a minor cost; it's the simplest way to read THIS building's
      // current effectiveRate without threading it through the inspector deps.
      // §2.7 wall-clock anchor for solar — same domain as main.ts's
      // per-frame computeRates so the inspector's per-building rate agrees
      // with the HUD's island-wide rate during night-time brownouts.
      const rates = computeRates(state, { terrainAt: spec.terrainAt }, undefined, Date.now());
      const br = rates.byBuilding.find((r) => r.building.id === building.id);
      const effective = br?.effectiveRate ?? 0;
      // Header status line — show cycle time + base rate (= 1 / cycleSec).
      recipeStatus.textContent = `cycle ${recipe.cycleSec}s · base ${(1 / recipe.cycleSec).toFixed(3)}/s`;
      recipeStatus.style.color = 'var(--ri-fg-3)';
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
          left.style.color = ln.direction === 'out' ? 'var(--ri-fg-1)' : 'var(--ri-fg-3)';
        }
        if (right) {
          right.textContent = formatRate(ln.direction, ln.rate);
          right.style.color = ln.direction === 'out' ? 'var(--ri-accent)' : 'var(--ri-warn)';
        }
      }

      effectiveValue.textContent = effective.toFixed(3);
      effectiveValue.style.color = effective > 0 ? 'var(--ri-accent)' : 'var(--ri-fg-4)';

      // Bonuses readout: surface the per-category skill multiplier so
      // players see why a Smelter is running 1.15× vs nominal. Mine /
      // Logger get their tier-specific yield bonus folded in too.
      const skillMul: SkillMultipliers = effectiveSkillMultipliers(state);
      const catMul = skillMul.recipeRate[recipe.category] ?? 1;
      let mineLogBonus = 1;
      if (def.category === 'extraction') {
        if (building.defId.includes('mine')) mineLogBonus *= skillMul.mineYieldBonus;
        if (building.defId.includes('logger')) mineLogBonus *= skillMul.loggerYieldBonus;
      }
      const compositeMul = catMul * mineLogBonus;
      if (compositeMul > 1.0001) {
        const parts: string[] = [];
        if (catMul > 1.0001) parts.push(`${recipe.category} ×${catMul.toFixed(2)}`);
        if (mineLogBonus > 1.0001) parts.push(`yield ×${mineLogBonus.toFixed(2)}`);
        bonusesValue.textContent = parts.join(' · ') + ` = ×${compositeMul.toFixed(2)}`;
        bonusesRow.style.display = '';
      } else {
        bonusesRow.style.display = 'none';
      }
    }

    // Power section
    const prod = def.power?.produces ?? 0;
    const cons = def.power?.consumes ?? 0;
    if (prod === 0 && cons === 0) {
      powerLine.textContent = '— no power';
      powerLine.style.color = 'var(--ri-fg-4)';
      powerSection.wrap.style.display = '';
    } else {
      const parts: string[] = [];
      if (prod > 0) parts.push(`+${prod}W produced`);
      if (cons > 0) parts.push(`-${cons}W consumed`);
      powerLine.textContent = parts.join('  ·  ');
      powerLine.style.color = 'var(--ri-fg-1)';
      powerSection.wrap.style.display = '';
    }

    // Gate status section
    if (def.gates && def.gates.length > 0) {
      while (gateSection.body.firstChild) {
        gateSection.body.removeChild(gateSection.body.firstChild);
      }
      for (const gate of def.gates) {
        const satisfied = gateSatisfied(building, gate, state.buildings.filter((b) => !b.invalid), BUILDING_DEFS);
        const pill = document.createElement('span');
        pill.textContent = gateLabel(gate);
        styled(pill, [
          'display: inline-block',
          'padding: 2px 6px',
          'border-radius: 4px',
          'font-size: 11px',
          'margin-right: 4px',
          'margin-bottom: 4px',
          satisfied ? 'background: rgba(125,211,160,0.12); color: var(--ri-success)' : 'background: rgba(232,93,74,0.12); color: var(--ri-danger)',
        ].join(';'));
        gateSection.body.appendChild(pill);
      }
      gateSection.wrap.style.display = '';
    } else {
      gateSection.wrap.style.display = 'none';
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
        storageLine.style.color = 'var(--ri-fg-1)';
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
      const heat = computeRates(state, { terrainAt: spec.terrainAt }, undefined, Date.now()).heat;
      if (def.requiresHeat) {
        const has = heat.hasHeat.get(building.id) === true;
        if (has) {
          const src = heat.assignedSource.get(building.id) ?? '?';
          heatLine.textContent = `✓ heat OK  ·  source: ${src}`;
          heatLine.style.color = 'var(--ri-accent)';
        } else {
          heatLine.textContent = 'NO HEAT SOURCE ADJACENT';
          heatLine.style.color = 'var(--ri-warn)';
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
        heatLine.style.color = 'var(--ri-fg-1)';
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
      maintenanceStatus.style.color = 'var(--ri-accent)';
      maintenanceRecipeLine.textContent = '';
      maintenanceRecipeLine.style.display = 'none';
      refreshBtn.style.display = 'none';
    } else {
      const operating = building.operatingMs ?? 0;
      const threshold = MAINTENANCE_THRESHOLD_MS_BY_TIER[def.tier];
      const factor = maintenanceFactor(building, def);
      if (operating < threshold) {
        maintenanceStatus.textContent = `${formatHM(operating)} / ${formatHM(threshold)}`;
        maintenanceStatus.style.color = 'var(--ri-fg-1)';
      } else {
        const pct = Math.round(factor * 100);
        maintenanceStatus.textContent = `OVERDUE — degraded to ${pct}%`;
        maintenanceStatus.style.color = 'var(--ri-warn)';
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

      const refreshCost = refreshCostFor(def);
      const refreshFactor = maintenanceFactor(building, def, effectiveSkillMultipliers(state).maintenanceThreshold);
      if (Object.keys(refreshCost).length === 0 || refreshFactor >= 1.0) {
        refreshBtn.style.display = 'none';
      } else {
        const missing = affordabilityShortfall(state.inventory, refreshCost);
        const parts: string[] = [];
        for (const [r, need] of Object.entries(refreshCost)) {
          const have = state.inventory[r as ResourceId] ?? 0;
          parts.push(`${need} ${r} (${have})`);
        }
        refreshBtn.textContent = `REFRESH · ${parts.join(', ')}`;
        refreshBtn.disabled = Object.keys(missing).length > 0;
        refreshBtn.style.display = '';
        if (refreshBtn.disabled) {
          refreshBtn.style.color = 'var(--ri-fg-4)';
          refreshBtn.style.borderColor = 'var(--ri-fg-4)';
          refreshBtn.style.cursor = 'not-allowed';
          refreshBtn.style.opacity = '0.6';
        } else {
          refreshBtn.style.color = 'var(--ri-accent)';
          refreshBtn.style.borderColor = 'var(--ri-accent-dim)';
          refreshBtn.style.cursor = 'pointer';
          refreshBtn.style.opacity = '1';
        }
      }
    }
    maintenanceSection.wrap.style.display = '';

    // §13.3 Convert to Eternal Servitor button paint.
    const hasRealityForge = state.buildings.some((b) => b.defId === 'reality_forge');
    if (building.eternalServitor !== true && hasRealityForge) {
      const recipe = MAINTENANCE_RECIPES[def.tier];
      const cost: Partial<Record<ResourceId, number>> = {};
      for (const [r, qty] of Object.entries(recipe)) {
        if ((qty ?? 0) === 0) continue;
        cost[r as ResourceId] = (cost[r as ResourceId] ?? 0) + (qty ?? 0);
      }
      cost.eldritch_processor = (cost.eldritch_processor ?? 0) + 1;
      cost.phase_converter = (cost.phase_converter ?? 0) + 1;

      const canAfford = Object.entries(cost).every(
        ([r, need]) => (state.inventory[r as ResourceId] ?? 0) >= (need ?? 0),
      );

      const costParts: string[] = [];
      for (const [r, need] of Object.entries(cost)) {
        if ((need ?? 0) === 0) continue;
        const have = state.inventory[r as ResourceId] ?? 0;
        costParts.push(`${need} ${r} (${have})`);
      }

      convertBtn.textContent = `CONVERT · ${costParts.join(', ')}`;
      convertBtn.disabled = !canAfford;
      convertBtn.style.display = '';
      if (!canAfford) {
        convertBtn.style.color = 'var(--ri-fg-4)';
        convertBtn.style.borderColor = 'var(--ri-fg-4)';
        convertBtn.style.cursor = 'not-allowed';
        convertBtn.style.opacity = '0.6';
      } else {
        convertBtn.style.color = 'var(--ri-accent)';
        convertBtn.style.borderColor = 'var(--ri-accent-dim)';
        convertBtn.style.cursor = 'pointer';
        convertBtn.style.opacity = '1';
      }
    } else {
      convertBtn.style.display = 'none';
    }

    // §3.4 Land Reclamation section — only for the Hub itself. Renders
    // two expansion buttons; each is enabled when canExpandIsland
    // returns ok, otherwise disabled with the rejection reason inline.
    if (def.id === 'land_reclamation_hub') {
      paintReclamation(spec, state);
      reclamationSection.wrap.style.display = '';
    } else {
      reclamationSection.wrap.style.display = 'none';
    }

    // §13.3 Universe Editor section — biome-reassign buttons for each
    // §3.2 biome other than the current one. Each fires `editIslandBiome`
    // through a confirm dialog so the player can't trigger it accidentally.
    if (def.id === 'universe_editor') {
      const costParts: string[] = [];
      for (const [r, need] of Object.entries(UNIVERSE_EDITOR_COST)) {
        const have = state.inventory[r as ResourceId] ?? 0;
        costParts.push(`${need} ${r} (${have})`);
      }
      const canAfford = Object.entries(UNIVERSE_EDITOR_COST).every(
        ([r, need]) => (state.inventory[r as ResourceId] ?? 0) >= (need ?? 0),
      );
      ueCaption.textContent =
        `Reassign biome — wipes modifiers (excl. natural-only), re-rolls terrain. Cost: ${costParts.join(', ')}`;
      // Rebuild biome buttons each refresh (cheap).
      while (ueBiomeRow.firstChild) ueBiomeRow.removeChild(ueBiomeRow.firstChild);
      const biomes: ReadonlyArray<{ id: 'plains' | 'forest' | 'desert' | 'volcanic' | 'arctic' | 'coast'; label: string }> = [
        { id: 'plains', label: 'Plains' },
        { id: 'forest', label: 'Forest' },
        { id: 'desert', label: 'Desert' },
        { id: 'volcanic', label: 'Volcanic' },
        { id: 'arctic', label: 'Arctic' },
        { id: 'coast', label: 'Coast' },
      ];
      for (const b of biomes) {
        const isCurrent = spec.biome === b.id;
        const btn = document.createElement('button');
        btn.textContent = b.label + (isCurrent ? ' ★' : '');
        styled(
          btn,
          [
            'background: transparent',
            `color: ${isCurrent ? 'var(--ri-accent)' : canAfford ? 'var(--ri-fg-1)' : 'var(--ri-fg-4)'}`,
            `border: 1px solid ${isCurrent ? 'var(--ri-accent)' : canAfford ? 'var(--ri-accent-dim)' : 'var(--ri-fg-4)'}`,
            'padding: 4px 8px',
            'cursor: ' + (isCurrent || !canAfford ? 'not-allowed' : 'pointer'),
            'font-family: ui-monospace, monospace',
            'font-size: 10.5px',
            'border-radius: 2px',
          ].join(';'),
        );
        btn.disabled = isCurrent || !canAfford;
        btn.addEventListener('click', () => {
          if (!target) return;
          const proceed = window.confirm(
            `Reassign ${spec.name ?? spec.id} to ${b.label}?\n\n` +
              'Terrain will re-roll, modifiers will wipe (natural-only excluded). ' +
              'Buildings on now-wrong tiles will go invalid until you demolish them.',
          );
          if (!proceed) return;
          const r = editIslandBiome(deps.world, spec.id, b.id);
          if (r.ok) {
            deps.onIslandBiomeReassigned?.(spec.id);
            paint();
          }
        });
        ueBiomeRow.appendChild(btn);
      }
      universeEditorSection.wrap.style.display = '';
    } else {
      universeEditorSection.wrap.style.display = 'none';
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
    panelHandle.setVisible(true);
    paint();
  }
  function close(): void {
    if (!target) return;
    target = null;
    pendingRelabel = null;
    panelHandle.setVisible(false);
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
