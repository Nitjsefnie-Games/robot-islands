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
import { clusterBonusMul, gateSatisfied } from './adjacency.js';
import { shapeHeight, shapeWidth } from './shape-mask.js';
import { affordabilityShortfall, applyRelabelStorageCap, countQueuedUpgrades, formatShortfall, inProgressBuildCount, parallelBuildSlots, queuedBuildCount, queuedBuildSlots, relocateFee, topUpgradeLevel, totalInvestedCost, upgradeCost } from './placement.js';
import { upgradeConstructionMs } from './construction.js';
import { activeFloors, displayedFloorLevel, floorEffectMul, floorLevel, floorScaledCapacity, hasOperationalBuilding, isOperationalBuilding, participatesInCluster, rawFloorLevel, ratedBuildingPower, type PlacedBuilding } from './buildings.js';
import { convertToServitor as pureConvertToServitor } from './servitor.js';
import { defineAction, dispatchAction, type InputRegistry } from './input.js';
import type { IslandState } from './economy.js';
import { tierForResource } from './economy.js';
import { activeBonusMul } from './active-bonus.js';
import { computeRates, fledglingRecipeMul, type RatesContext } from './economy.js';
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
} from './maintenance.js';
import { ALL_RESOURCES, resolveRecipe, type Recipe, type ResourceId } from './recipes.js';
import { effectiveSkillMultipliers, type SkillMultipliers } from './skilltree.js';
import { RESOURCE_STORAGE_CATEGORY, storageBaseFor, type StorageCategory } from './storage-categories.js';
import {
  BIOME_MAX_RADII,
  ISLAND_NAME_MAX_LEN,
  renameIsland,
  type IslandSpec,
  type WorldState,
} from './world.js';
import { editIslandBiome, UNIVERSE_EDITOR_COST } from './universe-editor.js';
import { type MutationGateway } from './mutation-gateway.js';
import { mountPanel, Zone } from './ui-zones.js';
import { fmtPower } from './format.js';



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
  production: 'Production',
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

/** Preview the §6.7 scrap credit for a building. Mirrors the
 *  `floor(sum(totalInvestedCost) * 0.3)` computation `demolishBuilding` applies. */
function previewScrapForBuilding(b: PlacedBuilding): number {
  const def = BUILDING_DEFS[b.defId];
  const cost = totalInvestedCost(b, def);
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
  const cost = totalInvestedCost(b, def);
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
  /** The current target island id, or null when hidden.  Paired with
   *  getSelectedBuildingId so main.ts can scope building-id lookups to
   *  the owning island (§15.4 island-qualified ids). */
  getSelectedIslandId(): string | null;
}

export interface InspectorDeps {
  /** Mutation gateway — optional so tests can keep wiring only the fields
   *  they already have. When present, storage-label relabel routes through
   *  the gateway; otherwise the pure helper is called directly. */
  gateway?: MutationGateway;
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
  onMove(target: InspectorTarget): void;
  /** Set the building's active-floor count via `setBuildingActiveFloors`.
   *  Called from the floor-disable steppers (−/+/Off/Max). main.ts owns the
   *  mutation: it computes active-floor counts before/after, drains routes
   *  ONLY when active floors cross to 0 (per
   *  p_routes_disabled_source=route_drains_and_removes — drained routes are
   *  NOT restored on re-enable), and triggers a world-layer rebuild so the
   *  alerts-overlay re-paints the partial/full-disable cue. `newDisabledFloors`
   *  is the desired count of OFF floors (clamped to [0, built] by the mutator). */
  onSetActiveFloors(target: InspectorTarget, newDisabledFloors: number): void;
  /** §4.6 Set the building's Force Run flag. main.ts owns the mutation
   *  (`target.building.forceRun = value || undefined`) and bumps autosave.
   *  Force Run keeps the building producing for XP at a full output bin;
   *  overflow is voided, inputs / power / wear stay real costs. */
  onSetForceRun(target: InspectorTarget, value: boolean): void;
  /** §4.7 Trigger a manual maintenance refresh. main.ts owns the mutation
   *  (gateway.refreshMaintenance), invalidates alerts, and refreshes the
   *  inspector. */
  onRefreshMaintenance(target: InspectorTarget): void;
  /** Floor-upgrade callback. main.ts owns the mutation (applyUpgrade),
   *  rebuilds world layers, and refreshes the inspector so the new floor
   *  count and effect are visible. */
  onUpgradeFloor(target: InspectorTarget): void;
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
  /** §13.3 Time Lock — toggle offline banking on the inspected island. */
  onSetBankingEnabled(target: InspectorTarget, enabled: boolean): void;
  /** §13.3 Time Lock — spend `minutes` from the source island's bank onto
   *  `targetIslandId`. main.ts routes through the gateway and refreshes. */
  onSpendTimeLock(target: InspectorTarget, targetIslandId: string, minutes: number): void;
  /** §13.3 Genesis Chamber — set the synthetic output resource (T1-T4 only). */
  onSetGenesisTarget(target: InspectorTarget, resourceId: ResourceId | null): void;
  /** §15.1 Full RatesContext for the given island — returns the same context
   *  that the most-recent advanceIsland/computeRates tick used, so per-
   *  building rate lines in the inspector agree with the HUD.  Optional:
   *  when absent (e.g. headless tests that don't tick) falls back to the
   *  terrain-only context, matching pre-§15.1 behaviour. */
  getRatesContext?(islandId: string): RatesContext | undefined;
}

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

export function mountInspectorUi(
  reg: InputRegistry,
  parentEl: HTMLElement,
  deps: InspectorDeps,
): InspectorUi {
  // Store only ids, not the live objects. REMOTE snapshot reconciliation
  // re-mints IslandState / PlacedBuilding instances, so caching the objects
  // would render frozen data until the player re-clicks. paint()/refresh()
  // re-resolve from deps.world at the top; handlers resolve at click time.
  let selection: { islandId: string; buildingId: string } | null = null;

  function resolveTarget(): InspectorTarget | null {
    if (!selection) return null;
    const state = deps.world.islandStates?.get(selection.islandId);
    const spec = deps.world.islands.find((s) => s.id === selection!.islandId);
    const building = spec?.buildings.find((b) => b.id === selection!.buildingId);
    if (!state || !spec || !building) return null;
    return { spec, state, building };
  }

  // ── Floor-disable pending ref ───────────────────────────────────────────
  // The floor steppers (−/+/Off/Max) set the desired off-floor count just
  // before dispatching the registry action, which has no payload. Pattern
  // mirrors build-queue-ui's _pendingCancelBuildingId. Single-instance:
  // one inspector is mounted, so the module-scoped action + this ref are fine.
  let pendingDisabledFloors: number | null = null;
  defineAction(reg, 'set-building-active-floors', () => {
    const n = pendingDisabledFloors;
    pendingDisabledFloors = null;
    if (n === null) return;
    const target = resolveTarget();
    if (!target) { close(); return; }
    if ((target.building.constructionRemainingMs ?? 0) > 0) return; // guard: no-op while constructing
    deps.onSetActiveFloors(target, n);
    paint();
  });

  // ── Force Run pending ref (§4.6) ────────────────────────────────────────
  // Mirrors the floor-disable pattern: set the desired value, dispatch the
  // payload-less registry action, which reads + nulls the ref and calls the dep.
  let pendingForceRun: boolean | null = null;
  defineAction(reg, 'set-building-force-run', () => {
    const v = pendingForceRun;
    pendingForceRun = null;
    if (v === null) return;
    const target = resolveTarget();
    if (!target) { close(); return; }
    if ((target.building.constructionRemainingMs ?? 0) > 0) return; // guard: no-op while constructing
    deps.onSetForceRun(target, v);
    paint();
  });

  // Panel shell — mounted via zone manager on the left edge so it doesn't
  // fight the side docks for the right edge.
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

  // Header — `BUILDING / INSPECT` stamp + close (×)
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

  // Body — vertical stack of small sections (name/tier/category/footprint/
  // recipe/power/storage/constraints) separated by hairline rules.
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

  // Island-name rename row — sits ABOVE the building title so it's clear the
  // field renames the island, not the building. Pure callback dispatch: the
  // mutation lives in `renameIsland` (pure helper in `world.ts`); on success
  // we notify main.ts via `deps.onRenameIsland` so the HUD title repaints. On
  // failure (empty / >32 chars / control char), the input reverts to the
  // current spec name in `paint()`.
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
    const target = resolveTarget();
    if (!target) { close(); return; }
    const trimmed = nameInput.value.trim();
    if (trimmed.length === 0) {
      // Empty: revert input to current spec name (which is at least `id` —
      // never empty itself), per the task brief "reject empty (revert to
      // id if empty)". We don't write through to spec.
      nameInput.value = target.spec.name;
      return;
    }
    // Route the mutation through the gateway. LOCAL applies synchronously;
    // REMOTE fires the intent and we keep the existing optimistic local update
    // so the UI stays responsive until the next authoritative snapshot.
    if (deps.gateway) {
      const gatewayResult = deps.gateway.renameIsland(target.spec.id, trimmed);
      if (gatewayResult instanceof Promise) {
        void gatewayResult;
      } else if (!gatewayResult.ok) {
        nameInput.value = target.spec.name;
        return;
      }
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
      e.stopPropagation();
      const t = resolveTarget();
      if (t) nameInput.value = t.spec.name;
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
    forceClearBtn.textContent = '▼ DESTROY EXCESS';
    wrap.appendChild(row);
    wrap.appendChild(blockedNote);
    wrap.appendChild(forceClearBtn);
    return { wrap, select, blockedNote, forceClearBtn };
  })();
  storageSection.body.appendChild(cargoLabelControls.wrap);

  // Cargo-label relabel logic. The dropdown's change event proposes a new
  // label; the relabel succeeds when current-label inventory is empty,
  // otherwise the force-clear button must be pressed first to destroy
  // contents (§4.6: "or accepts a force-clear that destroys current
  // contents").
  /** Latest proposed-but-not-yet-applied label (when blocked on non-empty
   *  inventory). Cleared on every paint() so a stale selection doesn't
   *  bleed across building switches. */
  let pendingRelabel: ResourceId | null = null;

  function applyRelabel(b: PlacedBuilding, newLabel: ResourceId): void {
    const target = resolveTarget();
    if (!target) { close(); return; }
    const def = BUILDING_DEFS[b.defId];
    if (!def.storage || def.storage.category !== 'generic') return;
    const oldLabel = b.cargoLabel;
    if (oldLabel === newLabel) return;
    // §storage-timing: only move caps when the building is complete.
    // Under construction / queued, the cap has not yet been credited —
    // creditStorageCaps in economy.ts will credit the current cargoLabel
    // at completion. Skipping cap arithmetic here prevents both the
    // phantom-strip (old label) and the double-credit (new label) bug.
    const gatewayResult = deps.gateway
      ? deps.gateway.relabelCargo(target.spec.id, b.id, newLabel)
      : undefined;
    if (gatewayResult instanceof Promise) {
      void (async () => {
        const res = await gatewayResult;
        if (!res.ok) return;
        pendingRelabel = null;
      })();
      return;
    }
    if (gatewayResult) {
      if (!gatewayResult.ok) return;
    } else {
      applyRelabelStorageCap(target.state, b, def, oldLabel, newLabel);
      b.cargoLabel = newLabel;
    }
    pendingRelabel = null;
  }

  cargoLabelControls.select.addEventListener('change', () => {
    const target = resolveTarget();
    if (!target) { close(); return; }
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
    const target = resolveTarget();
    if (!target || pendingRelabel === null) { close(); return; }
    const b = target.building;
    // §4.6 force-clear: destroy only the excess that would exceed the reduced
    // cap after the crate's contribution moves to the new label. The normal
    // relabel path already clamps inventory down to the new cap, so we skip
    // the old zero-all behaviour here.
    applyRelabel(b, pendingRelabel);
    paint();
  });

  /** Render the cargo-label UI for the currently-targeted generic-storage
   *  building. Encapsulates the dropdown's selected value, the contribution
   *  text, and the force-clear visibility. Called from `paint()` only. */
  function renderCargoLabelUi(
    b: PlacedBuilding,
    state: IslandState,
    mult: number,
  ): void {
    cargoLabelControls.wrap.style.display = '';
    const current = b.cargoLabel;
    const proposed = pendingRelabel ?? current;
    cargoLabelControls.select.value = (proposed ?? 'iron_ore') as string;
    if (current === undefined) {
      // §4.6 percentage model: contribution = mult × the chosen resource's
      // base cap, so it isn't known until a resource is picked.
      storageLine.textContent = `+${mult}× base cap (unlabeled — pick a resource)`;
      storageLine.style.color = 'var(--ri-fg-3)';
    } else {
      storageLine.textContent = `+${mult * storageBaseFor(current)} cap on ${current}`;
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
      cargoLabelControls.blockedNote.textContent = `${Math.floor(held)} units of ${current} — excess above cap will be destroyed`;
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

  // Floor-upgrade section
  const floorSection = makeSection('Floors');
  const floorLine = document.createElement('span');
  styled(
    floorLine,
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 10.5px', 'letter-spacing: 0.02em'].join(';'),
  );
  floorSection.body.appendChild(floorLine);
  const floorUpgradeBtn = makeExpandButton();
  floorUpgradeBtn.addEventListener('click', () => {
    const target = resolveTarget();
    if (!target) { close(); return; }
    deps.onUpgradeFloor(target);
    paint();
  });
  floorSection.body.appendChild(floorUpgradeBtn);

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
    const target = resolveTarget();
    if (!target) { close(); return; }
    if (deps.gateway) {
      const result = deps.gateway.convertToServitor(target.spec.id, target.building.id);
      if (result instanceof Promise) {
        void (async () => {
          const res = await result;
          if (res.ok) paint();
        })();
        return;
      }
      if (!result.ok) return;
    } else {
      const res = pureConvertToServitor(target.state, target.building.id, BUILDING_DEFS);
      if (!res.ok) return;
    }
    paint();
  });
  maintenanceSection.body.appendChild(convertBtn);

  // §NEW floor-disable steppers (replaces the old binary Disable toggle).
  // Free, reversible active-floor controls: −/+ step one floor off/on, Off
  // disables every built floor, Max re-enables all. All clicks dispatch the
  // 'set-building-active-floors' registry action (set pendingDisabledFloors,
  // then dispatchAction) so keyboard + mouse share one path. The whole row
  // is hidden while the building is under construction (the old Disable
  // button was DOM-disabled then; p_constructed_disable=no_finish_first).
  const floorDisableRow = document.createElement('div');
  styled(
    floorDisableRow,
    ['display: flex', 'align-items: center', 'gap: 4px', 'flex-wrap: wrap', 'margin-top: 4px'].join(';'),
  );
  const floorDisableLabel = document.createElement('span');
  styled(
    floorDisableLabel,
    [`color: ${'var(--ri-fg-2)'}`, 'font-size: 10.5px', 'letter-spacing: 0.04em', 'margin-right: 2px'].join(';'),
  );
  floorDisableRow.appendChild(floorDisableLabel);

  function makeFloorDisableBtn(label: string, computeNext: (target: InspectorTarget) => number): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    styled(
      btn,
      [
        'background: transparent',
        `color: ${'var(--ri-fg-1)'}`,
        `border: 1px solid ${'var(--ri-accent-dim)'}`,
        'padding: 2px 7px',
        'cursor: pointer',
        'font-family: ui-monospace, monospace',
        'font-size: 11px',
        'border-radius: 2px',
        'transition: background 80ms ease, border-color 80ms ease',
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
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const target = resolveTarget();
      if (!target) { close(); return; }
      if ((target.building.constructionRemainingMs ?? 0) > 0) return; // guard: no-op while constructing
      pendingDisabledFloors = computeNext(target);
      dispatchAction(reg, 'set-building-active-floors');
    });
    floorDisableRow.appendChild(btn);
    return btn;
  }

  // − disables one more floor; + enables one; Off all off; Max all on.
  const floorOffBtn = makeFloorDisableBtn('−', (target) => (target.building.disabledFloors ?? 0) + 1);
  const floorOnBtn = makeFloorDisableBtn('+', (target) => (target.building.disabledFloors ?? 0) - 1);
  const floorAllOffBtn = makeFloorDisableBtn('Off', (target) => displayedFloorLevel(target.building));
  const floorAllOnBtn = makeFloorDisableBtn('Max', () => 0);
  maintenanceSection.body.appendChild(floorDisableRow);

  // §4.6 Force Run toggle — keep producing for XP at a full output bin.
  // Shown only for resource-producing buildings (the only ones a cap can
  // throttle); hidden under construction. Reuses the accent action-button look.
  const forceRunBtn = document.createElement('button');
  styled(
    forceRunBtn,
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
  forceRunBtn.addEventListener('mouseenter', () => {
    if (forceRunBtn.disabled) return;
    forceRunBtn.style.background = 'rgba(125, 211, 232, 0.08)';
    forceRunBtn.style.borderColor = 'var(--ri-accent)';
  });
  forceRunBtn.addEventListener('mouseleave', () => {
    forceRunBtn.style.background = forceRunBtn.dataset.on === '1' ? 'rgba(125, 211, 232, 0.12)' : 'transparent';
    forceRunBtn.style.borderColor = 'var(--ri-accent-dim)';
  });
  forceRunBtn.addEventListener('click', () => {
    if (forceRunBtn.disabled) return;
    const target = resolveTarget();
    if (!target) { close(); return; }
    if ((target.building.constructionRemainingMs ?? 0) > 0) return;
    pendingForceRun = !(target.building.forceRun === true);
    dispatchAction(reg, 'set-building-force-run');
  });
  maintenanceSection.body.appendChild(forceRunBtn);

  // §13.3 Universe Editor — biome-reassign action. Shown only when the
  // selected building is a `universe_editor`. Cost preview + confirm
  // dialog with the spec's "real cost" wording.
  const universeEditorSection = makeSection('Universe Editor');
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

  // Lazy-built biome buttons — created once on first paint of a
  // universe_editor selection, then updated in-place each frame so click
  // targets stay stable.
  const biomeButtons: Array<{
    btn: HTMLButtonElement;
    id: 'plains' | 'forest' | 'desert' | 'volcanic' | 'arctic' | 'coast';
    label: string;
  }> = [];
  let biomeButtonsBuilt = false;

  // §13.3 Time Lock section — shown only when the selected building is a
  // `time_lock`. Displays banked minutes, an offline-banking toggle, and a
  // spend control that transfers banked minutes to another island.
  const timeLockSection = makeSection('Time Lock');
  const tlCaption = document.createElement('span');
  styled(
    tlCaption,
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 10.5px', 'letter-spacing: 0.02em'].join(';'),
  );
  timeLockSection.body.appendChild(tlCaption);
  const tlBankToggleBtn = makeExpandButton();
  tlBankToggleBtn.addEventListener('click', () => {
    const target = resolveTarget();
    if (!target) { close(); return; }
    deps.onSetBankingEnabled(target, !target.state.bankingEnabled);
    paint();
  });
  timeLockSection.body.appendChild(tlBankToggleBtn);
  const tlSpendRow = document.createElement('div');
  styled(tlSpendRow, 'display: flex; gap: 4px; flex-wrap: wrap; padding-top: 4px; align-items: center');
  const tlSpendInput = document.createElement('input');
  tlSpendInput.type = 'number';
  tlSpendInput.min = '1';
  tlSpendInput.step = '1';
  tlSpendInput.placeholder = 'min';
  styled(
    tlSpendInput,
    [
      'width: 60px',
      `color: ${'var(--ri-fg-1)'}`,
      `background: ${'rgba(24, 29, 39, 0.6)'}`,
      `border: 1px solid ${'var(--ri-border-strong)'}`,
      'border-radius: 2px',
      'padding: 2px 4px',
      'font-family: ui-monospace, monospace',
      'font-size: 10.5px',
    ].join(';'),
  );
  const tlTargetSelect = document.createElement('select');
  styled(
    tlTargetSelect,
    [
      'flex: 1 1 auto',
      `color: ${'var(--ri-fg-1)'}`,
      `background: ${'rgba(24, 29, 39, 0.6)'}`,
      `border: 1px solid ${'var(--ri-border-strong)'}`,
      'border-radius: 2px',
      'padding: 2px 4px',
      'font-family: ui-monospace, monospace',
      'font-size: 10.5px',
    ].join(';'),
  );
  const tlSpendBtn = makeExpandButton();
  tlSpendBtn.textContent = 'SPEND';
  tlSpendBtn.addEventListener('click', () => {
    const target = resolveTarget();
    if (!target) { close(); return; }
    const minutes = Number(tlSpendInput.value);
    const targetIslandId = tlTargetSelect.value;
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    deps.onSpendTimeLock(target, targetIslandId, minutes);
    paint();
  });
  tlSpendRow.appendChild(tlSpendInput);
  tlSpendRow.appendChild(tlTargetSelect);
  tlSpendRow.appendChild(tlSpendBtn);
  timeLockSection.body.appendChild(tlSpendRow);
  timeLockSection.wrap.style.display = 'none';

  // §13.3 Genesis Chamber section — shown only when the selected building is a
  // `genesis_chamber`. Dropdown of T1-T4 resources drives the synthetic recipe.
  const genesisSection = makeSection('Genesis Chamber');
  const genesisCaption = document.createElement('span');
  styled(
    genesisCaption,
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 10.5px', 'letter-spacing: 0.02em'].join(';'),
  );
  genesisSection.body.appendChild(genesisCaption);
  const genesisSelect = document.createElement('select');
  styled(
    genesisSelect,
    [
      'width: 100%',
      `color: ${'var(--ri-fg-1)'}`,
      `background: ${'rgba(24, 29, 39, 0.6)'}`,
      `border: 1px solid ${'var(--ri-border-strong)'}`,
      'border-radius: 2px',
      'padding: 2px 4px',
      'font-family: ui-monospace, monospace',
      'font-size: 10.5px',
    ].join(';'),
  );
  // Build the T1-T4 resource list once.
  const GENESIS_TIER_RESOURCES = ALL_RESOURCES.filter((r) => {
    const tier = tierForResource(r);
    return tier >= 1 && tier <= 4;
  });
  for (const r of GENESIS_TIER_RESOURCES) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    genesisSelect.appendChild(opt);
  }
  genesisSelect.addEventListener('change', () => {
    const target = resolveTarget();
    if (!target) { close(); return; }
    const value = genesisSelect.value as ResourceId;
    deps.onSetGenesisTarget(target, value);
    paint();
  });
  genesisSection.body.appendChild(genesisSelect);
  genesisSection.wrap.style.display = 'none';

  // §3.4 Land Reclamation section — shown only when the selected building
  // is a `land_reclamation_hub`. Two buttons (+1 major / +1 minor) wired
  // to deps.onExpandIsland; each shows its current-radius cost or the
  // gate-failure reason inline.
  const reclamationSection = makeSection('Reclamation');
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
    const target = resolveTarget();
    if (!target) { close(); return; }
    deps.onExpandIsland(target, 'major');
  });
  expandMinorBtn.addEventListener('click', () => {
    const target = resolveTarget();
    if (!target) { close(); return; }
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
    const target = resolveTarget();
    if (!target) { close(); return; }
    deps.onRefreshMaintenance(target);
    paint();
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
    const target = resolveTarget();
    if (!target) { close(); return; }
    const credit = previewScrapForBuilding(target.building);
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
    deps.onDemolish(target);
  });
  footerSection.appendChild(demolishBtn);

  const moveBtn = document.createElement('button');
  styled(
    moveBtn,
    [
      'color: var(--ri-accent)',
      'padding: 5px 10px',
      'font-family: ui-monospace, monospace',
      'font-size: 11px',
      'letter-spacing: 0.14em',
      'text-transform: uppercase',
    ].join(';'),
  );
  moveBtn.classList.add('ri-accentbtn');
  moveBtn.addEventListener('click', () => {
    if (moveBtn.disabled) return;
    const target = resolveTarget();
    if (!target) { close(); return; }
    deps.onMove(target);
  });
  footerSection.appendChild(moveBtn);

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
  body.appendChild(floorSection.wrap);
  body.appendChild(maintenanceSection.wrap);
  body.appendChild(universeEditorSection.wrap);
  body.appendChild(timeLockSection.wrap);
  body.appendChild(genesisSection.wrap);
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

  // Recipe-line management — variable count, so we lazy-track existing rows
  // and recycle them by index rather than create/destroy on every refresh.
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

  // §3.4 Reclamation paint helper — renders the two expand buttons + caption
  // for the currently-targeted Land Reclamation Hub. Encapsulates the per-
  // axis gate / cost / labelling so `paint()` stays readable.
  function reclamationButtonText(spec: IslandSpec, axis: Axis, gate: ExpandResult): string {
    const label = axis === 'major' ? '+1 MAJOR' : '+1 MINOR';
    const current = axis === 'major' ? spec.majorRadius : spec.minorRadius;
    if (gate.ok) {
      const cost = landReclamationCost(spec.majorRadius, spec.minorRadius, axis);
      return `${label} · ${formatShortfall(cost)} (r ${current} → ${current + 1})`;
    }
    if (gate.reason === 'axis-at-max') return `${label} · AT CAP`;
    if (gate.reason === 'insufficient-resources') {
      const cost = landReclamationCost(spec.majorRadius, spec.minorRadius, axis);
      return `${label} · NEED ${formatShortfall(cost)}`;
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
    expandMajorBtn.textContent = reclamationButtonText(spec, 'major', majorGate);
    expandMinorBtn.textContent = reclamationButtonText(spec, 'minor', minorGate);
    setExpandButtonState(expandMajorBtn, majorGate);
    setExpandButtonState(expandMinorBtn, minorGate);
  }

  function paint(): void {
    const target = resolveTarget();
    if (!target) { close(); return; }
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

    // §15.1 Full RatesContext for this island — used by both the recipe
    // computeRates pass and the heat-section pass so both see the same
    // modifierMul / ncBuff / activeBonusMul / cableComponent / solarBoost.
    // Falls back to terrain-only context when getRatesContext is absent
    // (e.g. headless tests that don't tick).
    const ratesCtx: RatesContext = deps.getRatesContext?.(spec.id) ?? { terrainAt: spec.terrainAt };

    // Recipe (resolveRecipe for Mine tile-aware variant — see §8.1).
    const recipe = resolveRecipe(BUILDING_DEFS[building.defId], building, spec.terrainAt);
    const skillMul: SkillMultipliers = effectiveSkillMultipliers(state);
    // §4.5/#35: include under-construction buildings (they bridge the cluster
    // and contribute their completed-floor capacity); exclude only invalid/disabled.
    const clusterMul = clusterBonusMul(
      building,
      state.buildings.filter(participatesInCluster),
      BUILDING_DEFS,
    );
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
      // §15.1: use ratesCtx (built above) so this pass uses the same full
      // context (modifierMul, ncBuff, activeBonusMul, cableComponent,
      // solarBoost) that the engine's last tick used — displayed rates then
      // agree with the HUD.
      const rates = computeRates(state, ratesCtx, undefined, Date.now());
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
      const catMul = skillMul.recipeRate[recipe.category] ?? 1;
      let mineLogBonus = 1;
      if (def.category === 'extraction') {
        if (building.defId.includes('mine')) mineLogBonus *= skillMul.mineYieldBonus;
        if (building.defId.includes('logger')) mineLogBonus *= skillMul.loggerYieldBonus;
      }
      // §9 fledgling boost: a fresh island (<L10) runs every recipe faster; show
      // it here so the player sees why the rate is high and that it tapers.
      const fledgMul = fledglingRecipeMul(state.level);
      // §9.9 active-play bonus — world-level, applies to every recipe.
      const activeMul = activeBonusMul(deps.world);
      const compositeMul = catMul * mineLogBonus * fledgMul * clusterMul * activeMul;
      if (compositeMul > 1.0001) {
        const parts: string[] = [];
        if (fledgMul > 1.0001) parts.push(`fledgling ×${fledgMul.toFixed(2)}`);
        if (catMul > 1.0001) parts.push(`${recipe.category} ×${catMul.toFixed(2)}`);
        if (mineLogBonus > 1.0001) parts.push(`yield ×${mineLogBonus.toFixed(2)}`);
        if (clusterMul > 1.0001) parts.push(`cluster ×${clusterMul.toFixed(2)}`);
        if (activeMul > 1.0001) parts.push(`active ×${activeMul.toFixed(2)}`);
        bonusesValue.textContent = parts.join(' · ') + ` = ×${compositeMul.toFixed(2)}`;
        bonusesRow.style.display = '';
      } else {
        bonusesRow.style.display = 'none';
      }
    }

    // Power section
    const producesBase = def.power?.produces ?? 0;
    const consumesBase = def.power?.consumes ?? 0;
    if (producesBase === 0 && consumesBase === 0) {
      powerLine.textContent = '— no power';
      powerLine.style.color = 'var(--ri-fg-4)';
      powerSection.wrap.style.display = '';
    } else {
      const { produced: prod, consumed: cons } = ratedBuildingPower(
        producesBase, consumesBase, floorLevel(building),
        skillMul.powerProduction, skillMul.powerConsumption,
      );
      const parts: string[] = [];
      if (prod > 0) {
        const prodAdj = prod * clusterMul;
        parts.push(clusterMul > 1.0001
          ? `+${fmtPower(prodAdj)} produced (cluster ×${clusterMul.toFixed(2)})`
          : `+${fmtPower(prodAdj)} produced`);
      }
      if (cons > 0) parts.push(`-${fmtPower(cons)} consumed`);
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
        const satisfied = gateSatisfied(building, gate, state.buildings.filter(isOperationalBuilding), BUILDING_DEFS);
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
      // §4.6 percentage model: `storage.capacity` is a multiplier; the actual
      // per-resource contribution is `mult × storageBaseFor(r)`.
      const mult = floorScaledCapacity(building, def.storage.capacity);
      if (def.storage.category === 'generic') {
        // Generic: show "+cap on <label>" plus the dropdown.
        renderCargoLabelUi(building, state, mult);
      } else {
        // Specialized: contribution varies per resource, so show the multiplier.
        cargoLabelControls.wrap.style.display = 'none';
        const catLabel = STORAGE_CATEGORY_LABEL[def.storage.category];
        storageLine.textContent = `+${mult}× base cap on ${catLabel}`;
        storageLine.style.color = 'var(--ri-fg-1)';
      }
      storageSection.wrap.style.display = '';
    } else {
      storageSection.wrap.style.display = 'none';
      cargoLabelControls.wrap.style.display = 'none';
    }

    // Heat section (§5.2). Shown only for heat consumers / heat sources.
    // §15.1: use the same ratesCtx (built above) so heat resolution reflects
    // the same context the engine used last tick.
    if (def.requiresHeat || def.heatSource) {
      const heat = computeRates(state, ratesCtx, undefined, Date.now()).heat;
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

    // Floor-upgrade section paint
    const rawFl = rawFloorLevel(building);
    const currentLevel = displayedFloorLevel(building);
    const nextEffectLevel = rawFl + 1;
    // §2.4 logistics buildings have no recipe/storage/power; their floors
    // scale the route they host (capacity & speed) instead.
    const floorEffectDesc = def.category === 'logistics'
      ? 'route capacity & speed'
      : 'throughput / capacity / power-out';
    floorLine.textContent = `${currentLevel} floors · next: ×${floorEffectMul(nextEffectLevel)} ${floorEffectDesc}`;
    // The preview reflects the NEXT queued upgrade's target: top queued raw
    // level + 1 (displayed = raw + 2).
    const topLevel = topUpgradeLevel(state, building);
    const targetDisplayedLevel = topLevel + 2;
    const targetRawLevel = topLevel + 1;
    const upgradeCostBasket = upgradeCost(def, targetDisplayedLevel);
    const upgradeShortfall = affordabilityShortfall(state.inventory, upgradeCostBasket);
    const canAffordUpgrade = Object.keys(upgradeShortfall).length === 0;
    const upgradeMs = upgradeConstructionMs(def, targetRawLevel);
    const upgradeCostParts: string[] = [];
    for (const [r, n] of Object.entries(upgradeCostBasket) as Array<[ResourceId, number]>) {
      if (n <= 0) continue;
      const have = Math.floor(state.inventory[r] ?? 0);
      upgradeCostParts.push(`${n} ${r.toUpperCase().replace(/_/g, ' ')} (${have})`);
    }
    const upgradeDurationStr = `${(upgradeMs / 1000).toFixed(1)}s`;
    // An upgrade is a construction job: mirrors applyUpgrade's gates so the
    // button can't offer a click it will reject.
    // - selfBuilding: this building is already under construction/upgrade.
    //   It now queues another upgrade instead of rejecting, so it only blocks
    //   when the shared queue is full.
    // - runningFull: all parallel build slots are occupied.
    // - hardFull: running slots AND queue are both at capacity — hard block.
    // - willQueue: building busy or running full, but queue has room.
    const selfBuilding = (building.constructionRemainingMs ?? 0) > 0;
    const runSlots = parallelBuildSlots(state);
    const runCount = inProgressBuildCount(state);
    const runningFull = runCount >= runSlots;
    const qCount = queuedBuildCount(state);
    const qSlots = queuedBuildSlots(state);
    const hardFull = (selfBuilding || runningFull) && qCount >= qSlots;
    const willQueue = (selfBuilding || runningFull) && qCount < qSlots;
    const queuedUpgrades = countQueuedUpgrades(state, building.id);
    const queuedSuffix = queuedUpgrades > 0 ? ` (${queuedUpgrades} queued)` : '';
    if (hardFull) {
      floorUpgradeBtn.textContent = `QUEUE FULL (${runCount}/${runSlots} run · ${qCount}/${qSlots} queue)`;
      floorUpgradeBtn.disabled = true;
    } else if (!canAffordUpgrade) {
      floorUpgradeBtn.textContent = `NEED ${formatShortfall(upgradeShortfall)}`;
      floorUpgradeBtn.disabled = true;
    } else if (willQueue) {
      floorUpgradeBtn.textContent = `QUEUE UPGRADE${queuedSuffix} · ${upgradeCostParts.join(', ')} · ${upgradeDurationStr}`;
      floorUpgradeBtn.disabled = false;
    } else {
      floorUpgradeBtn.textContent = `UPGRADE${queuedSuffix} · ${upgradeCostParts.join(', ')} · ${upgradeDurationStr}`;
      floorUpgradeBtn.disabled = false;
    }
    if (floorUpgradeBtn.disabled) {
      floorUpgradeBtn.style.color = 'var(--ri-fg-4)';
      floorUpgradeBtn.style.borderColor = 'var(--ri-fg-4)';
      floorUpgradeBtn.style.cursor = 'not-allowed';
      floorUpgradeBtn.style.opacity = '0.6';
    } else {
      floorUpgradeBtn.style.color = 'var(--ri-accent)';
      floorUpgradeBtn.style.borderColor = 'var(--ri-accent-dim)';
      floorUpgradeBtn.style.cursor = 'pointer';
      floorUpgradeBtn.style.opacity = '1';
    }
    floorSection.wrap.style.display = '';

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
      const thresholdMul = effectiveSkillMultipliers(state).maintenanceThreshold;
      const operating = building.operatingMs ?? 0;
      const threshold = MAINTENANCE_THRESHOLD_MS_BY_TIER[def.tier] * thresholdMul;
      const factor = maintenanceFactor(building, def, thresholdMul);
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
      const refreshFactor = maintenanceFactor(building, def, thresholdMul);
      if (Object.keys(refreshCost).length === 0 || refreshFactor >= 1.0) {
        refreshBtn.style.display = 'none';
      } else {
        const missing = affordabilityShortfall(state.inventory, refreshCost);
        const parts: string[] = [];
        for (const [r, need] of Object.entries(refreshCost)) {
          // Inventory can carry fractional amounts (continuous-yield trickles)
          // but you can only spend whole units, so floor for display.
          const have = Math.floor(state.inventory[r as ResourceId] ?? 0);
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
    const hasRealityForge = hasOperationalBuilding(state.buildings, 'reality_forge');
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

    // §NEW floor-disable steppers paint. The whole row is hidden while the
    // building is under construction (the old Disable button was gated the
    // same way; p_constructed_disable=no_finish_first).
    const isUnderConstruction = (building.constructionRemainingMs ?? 0) > 0;
    if (isUnderConstruction) {
      floorDisableRow.style.display = 'none';
    } else {
      floorDisableRow.style.display = 'flex';
      const built = displayedFloorLevel(building);
      const active = activeFloors(building);
      floorDisableLabel.textContent = `Floors: ${active}/${built}`;
      const atMin = active === 0; // all floors off
      const atMax = active === built; // all floors on
      const setBtn = (btn: HTMLButtonElement, disabled: boolean): void => {
        btn.disabled = disabled;
        btn.style.opacity = disabled ? '0.45' : '1';
        btn.style.cursor = disabled ? 'default' : 'pointer';
        btn.style.borderColor = disabled ? 'var(--ri-fg-4)' : 'var(--ri-accent-dim)';
      };
      setBtn(floorOffBtn, atMin);
      setBtn(floorAllOffBtn, atMin);
      setBtn(floorOnBtn, atMax);
      setBtn(floorAllOnBtn, atMax);
    }

    // §4.6 Force Run toggle paint. Only meaningful for buildings that PRODUCE
    // a resource (the only ones a storage cap can throttle); hidden otherwise
    // and while under construction.
    const producesResource = !!recipe && Object.keys(recipe.outputs).length > 0;
    if (!producesResource || isUnderConstruction) {
      forceRunBtn.style.display = 'none';
    } else {
      forceRunBtn.style.display = '';
      const on = building.forceRun === true;
      forceRunBtn.dataset.on = on ? '1' : '0';
      forceRunBtn.textContent = on ? 'FORCE RUN: ON' : 'FORCE RUN: OFF';
      forceRunBtn.style.background = on ? 'rgba(125, 211, 232, 0.12)' : 'transparent';
      forceRunBtn.style.color = on ? 'var(--ri-accent)' : 'var(--ri-fg-2)';
      forceRunBtn.style.borderColor = 'var(--ri-accent-dim)';
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

      // Build the six biome buttons once; per-frame only update styling.
      if (!biomeButtonsBuilt) {
        biomeButtonsBuilt = true;
        const biomes: ReadonlyArray<{ id: 'plains' | 'forest' | 'desert' | 'volcanic' | 'arctic' | 'coast'; label: string }> = [
          { id: 'plains', label: 'Plains' },
          { id: 'forest', label: 'Forest' },
          { id: 'desert', label: 'Desert' },
          { id: 'volcanic', label: 'Volcanic' },
          { id: 'arctic', label: 'Arctic' },
          { id: 'coast', label: 'Coast' },
        ];
        for (const b of biomes) {
          const btn = document.createElement('button');
          styled(
            btn,
            [
              'background: transparent',
              'padding: 4px 8px',
              'font-family: ui-monospace, monospace',
              'font-size: 10.5px',
              'border-radius: 2px',
            ].join(';'),
          );
          btn.addEventListener('click', async () => {
            const t = resolveTarget();
            if (!t) { close(); return; }
            const tspec = t.spec;
            const proceed = window.confirm(
              `Reassign ${tspec.name ?? tspec.id} to ${b.label}?\n\n` +
                'Terrain will re-roll, modifiers will wipe (natural-only excluded). ' +
                'Buildings on now-wrong tiles will go invalid until you demolish them.',
            );
            if (!proceed) return;
            let r: { ok: boolean; reason?: string };
            if (deps.gateway) {
              const gatewayResult = await deps.gateway.editBiome(tspec.id, b.id);
              if (gatewayResult.ok) {
                r = { ok: true };
              } else {
                r = { ok: false, reason: gatewayResult.error };
              }
            } else {
              r = editIslandBiome(deps.world, tspec.id, b.id);
            }
            if (r.ok) {
              deps.onIslandBiomeReassigned?.(tspec.id);
              paint();
            }
          });
          ueBiomeRow.appendChild(btn);
          biomeButtons.push({ btn, id: b.id, label: b.label });
        }
      }

      for (const { btn, id, label } of biomeButtons) {
        const isCurrent = spec.biome === id;
        btn.textContent = label + (isCurrent ? ' ★' : '');
        btn.style.color = isCurrent ? 'var(--ri-accent)' : canAfford ? 'var(--ri-fg-1)' : 'var(--ri-fg-4)';
        btn.style.borderColor = isCurrent ? 'var(--ri-accent)' : canAfford ? 'var(--ri-accent-dim)' : 'var(--ri-fg-4)';
        btn.style.cursor = isCurrent || !canAfford ? 'not-allowed' : 'pointer';
        btn.disabled = isCurrent || !canAfford;
      }

      universeEditorSection.wrap.style.display = '';
    } else {
      universeEditorSection.wrap.style.display = 'none';
    }

    // §13.3 Time Lock section paint. Only for a `time_lock` building.
    if (def.id === 'time_lock') {
      const timeLockCount = state.buildings.filter((b) => b.defId === 'time_lock').length;
      const maxBank = timeLockCount * 24 * 60;
      const banked = state.timeLockBankedMin ?? 0;
      const banking = state.bankingEnabled === true;
      tlCaption.textContent = `Banked ${Math.floor(banked)} / ${maxBank} min · 1 min = 1 min 3× acceleration`;
      tlBankToggleBtn.textContent = banking ? 'BANK OFFLINE: ON' : 'BANK OFFLINE: OFF';
      tlBankToggleBtn.style.color = banking ? 'var(--ri-accent)' : 'var(--ri-fg-2)';
      tlBankToggleBtn.style.background = banking ? 'rgba(125, 211, 232, 0.12)' : 'transparent';

      // Refresh target dropdown: every populated island (including self).
      const currentTarget = tlTargetSelect.value;
      tlTargetSelect.innerHTML = '';
      const populated = deps.world.islands.filter((s) => s.populated);
      for (const s of populated) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name ?? s.id;
        tlTargetSelect.appendChild(opt);
      }
      // Preserve selection if still valid; otherwise default to active/home.
      if (populated.some((s) => s.id === currentTarget)) {
        tlTargetSelect.value = currentTarget;
      } else {
        const home = populated.find((s) => s.id === 'home') ?? populated[0];
        if (home) tlTargetSelect.value = home.id;
      }
      const canSpend = banked >= 1 && tlTargetSelect.value !== '';
      tlSpendBtn.disabled = !canSpend;
      tlSpendBtn.style.color = canSpend ? 'var(--ri-accent)' : 'var(--ri-fg-4)';
      tlSpendBtn.style.borderColor = canSpend ? 'var(--ri-accent-dim)' : 'var(--ri-fg-4)';
      tlSpendBtn.style.cursor = canSpend ? 'pointer' : 'not-allowed';
      tlSpendBtn.style.opacity = canSpend ? '1' : '0.6';
      timeLockSection.wrap.style.display = '';
    } else {
      timeLockSection.wrap.style.display = 'none';
    }

    // §13.3 Genesis Chamber section paint. Only for a `genesis_chamber`.
    if (def.id === 'genesis_chamber') {
      const target = state.genesisTarget;
      const targetTier = target ? tierForResource(target) : 0;
      const targetLabel = target && targetTier >= 1 && targetTier <= 4 ? target : 'none';
      genesisCaption.textContent = `Target resource: ${targetLabel}`;
      genesisSelect.value = (target && GENESIS_TIER_RESOURCES.includes(target) ? target : GENESIS_TIER_RESOURCES[0]) as string;
      genesisSection.wrap.style.display = '';
    } else {
      genesisSection.wrap.style.display = 'none';
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
    const credit = previewScrapForBuilding(building);
    demolishBtn.textContent = `▼ DEMOLISH · +${credit} SCRAP`;

    // Move button — relocate fee preview, ocean defs can't relocate, greyed
    // when the fee is unaffordable.
    if (def.oceanPlacement === true) {
      moveBtn.style.display = 'none';
    } else {
      moveBtn.style.display = '';
      const fee = relocateFee(building, def);
      const feeStr = Object.entries(fee)
        .map(([r, n]) => `${n} ${r.toUpperCase().replace(/_/g, ' ')}`)
        .join(', ');
      const cantAfford = Object.keys(affordabilityShortfall(state.inventory, fee)).length > 0;
      moveBtn.textContent = feeStr ? `✥ MOVE · −${feeStr}` : '✥ MOVE';
      moveBtn.disabled = cantAfford;
      moveBtn.style.opacity = cantAfford ? '0.5' : '1';
    }
  }

  function open(t: InspectorTarget): void {
    selection = { islandId: t.spec.id, buildingId: t.building.id };
    // Reset any staged relabel from a previous inspection — pendingRelabel
    // is per-selection state, not per-panel.
    pendingRelabel = null;
    panelHandle.setVisible(true);
    paint();
  }
  function close(): void {
    if (!selection) return;
    selection = null;
    pendingRelabel = null;
    panelHandle.setVisible(false);
  }
  function refresh(): void {
    if (!selection) return;
    paint();
  }
  function isVisible(): boolean {
    return selection !== null;
  }
  function getSelectedBuildingId(): string | null {
    return selection?.buildingId ?? null;
  }
  function getSelectedIslandId(): string | null {
    return selection?.islandId ?? null;
  }

  return {
    el: panel,
    open,
    close,
    isVisible,
    refresh,
    getSelectedBuildingId,
    getSelectedIslandId,
  };
}
