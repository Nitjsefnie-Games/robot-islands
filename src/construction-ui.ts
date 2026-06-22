// Artificial-island Construction HUD panel — DOM overlay per SPEC §2.5.
//
// Form body: founder picker → biome picker → size sliders → position inputs →
// live cost readout; "Construct" CTA in the panel footer.
//
// Wire-up notes:
//   - Toggle via KeyC (`'toggle-construction'`, see input.ts).
//   - On a successful construct, the panel calls back into `options.onConstruct`
//     which is responsible for inserting the new spec/state into the live
//     world + rebuilding render layers. The pure construct logic lives in
//     `artificial-island.ts`; this module owns input collection only.

import {
  computeConstructionCost,
  constructIsland,
  artificialIslandId,
  maxRadiiForConstruction,
  type ConstructionRequirements,
} from './artificial-island.js';
import {
  computePlacementValidity,
  type ConstructionCandidate,
  type ConstructPlacementReason,
} from './construction-placement.js';
import { BIOME_DEFS } from './biomes.js';
import type { IslandState } from './economy.js';
import { hasOperationalBuilding } from './buildings.js';
import { tierForLevel } from './skilltree.js';
import { mountPanel, Zone } from './ui-zones.js';
import type { MutationGateway } from './mutation-gateway.js';
import type { ResourceId } from './recipes.js';
import {
  ISLAND_NAME_MAX_LEN,
  validateIslandName,
  type Biome,
  type IslandSpec,
  type WorldState,
} from './world.js';

export interface ConstructionUi {
  readonly el: HTMLElement;
  refresh(): void;
  refreshFromCandidate(): void;
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
}

export interface ConstructionUiOptions {
  /** Live world data. The picker rebuilds its eligible-founder list from
   *  this each open. The reference is captured; mutations flow through. */
  readonly world: WorldState;
  readonly islandStates: Map<string, IslandState>;
  /** Optional: current active-island id. The founder picker prefers this
   *  when it appears in the eligible-founders list, so opening the panel
   *  after clicking a T3+ island defaults to that island. */
  getActiveIslandId?(): string;
  /** Mutation gateway — optional so tests can keep wiring only the fields
   *  they already have. When present, construction is routed through the
   *  gateway (LOCAL direct, REMOTE intent); otherwise the pure helper is
   *  called directly. */
  gateway?: MutationGateway;
  /** Optional shared candidate state. When supplied, the caller owns the
   *  object and edits are written back by reference. */
  candidate?: ConstructionCandidate;
  /** Optional callback fired after any user edit mutates `candidate`. */
  onCandidateChange?(): void;
  /** Called after a successful construct. The result is the new spec + state,
   *  the founder id (in case the caller wants to render an attribution), and
   *  the now-ms for any animation hooks. Callers are responsible for:
   *    - inserting spec into worldState.islands
   *    - inserting state into islandStates
   *    - rebuilding render layers (rebuildWorldLayers())
   *    - registering the new island in any per-id caches (modifier muls,
   *      specs-by-id map). */
  readonly onConstruct: (
    args: {
      newSpec: IslandSpec;
      newState: IslandState;
      founderId: string;
      nowMs: number;
    },
  ) => void;
}

const BIOME_ORDER: ReadonlyArray<Biome> = [
  'plains',
  'forest',
  'coast',
  'volcanic',
  'desert',
  'arctic',
];

/** Placement-reason → human-readable string for tooltip + footer. */
const REASON_LABEL: Readonly<Record<ConstructPlacementReason, string>> = {
  'tier-too-low': 'Founder is below T3 (level 15)',
  'no-platform-constructor': 'Founder has no Platform Constructor',
  'radius-too-large': 'Radius exceeds founder tier cap',
  'insufficient-materials': 'Not enough materials in founder inventory',
  'invalid-biome': 'Unknown biome selection',
  'position-occupied': 'Position overlaps an existing island',
  'in-unknown-space': 'Extends into unknown space',
  'unknown-founder': 'Select a founder island',
};

/** Tiny stable id generator so multiple constructs in one session get
 *  unique ids without colliding with the demo set. */
let constructionCounter = 0;
/** Next allocated `art-N` id. Exported so persistence tests can verify the
 *  seeder raised the counter past the saved max — mirrors `nextDroneId` /
 *  `nextRouteId` / `nextVehicleId`. The construction UI itself still calls
 *  this directly. */
export function nextArtificialId(): string {
  constructionCounter += 1;
  // `art-N` ids stay distinct from the demo ids (home, forest-ne, desert-far, …).
  return `art-${constructionCounter}`;
}

/** Seed the construction id counter so the next id is `art-${value + 1}`.
 *  Used by the persistence loader after restoring a save: the loader walks
 *  `world.islands`, finds the highest existing `art-N` suffix, and calls
 *  this with that max. Idempotent: passing a smaller value than the current
 *  counter is a no-op (we only raise). Mirrors the `_seedDroneIdCounter` /
 *  `_seedRouteIdCounter` / `_seedVehicleIdCounter` pattern. */
export function _seedConstructionCounter(value: number): void {
  if (value > constructionCounter) constructionCounter = value;
}

/** Reset the construction id counter. Test-only. */
export function _resetConstructionCounter(): void {
  constructionCounter = 0;
}

export function mountConstructionUi(
  parentEl: HTMLElement,
  options: ConstructionUiOptions,
): ConstructionUi {
  let visible = false;
  /** Shared construction candidate. If the caller supplied `options.candidate`,
   *  mutations flow back to that object by reference. */
  const candidate: ConstructionCandidate = options.candidate ?? {
    founderId: '',
    biome: 'plains',
    major: 4,
    minor: 4,
    cx: 0,
    cy: 0,
  };
  /** Player-supplied display name for the new island, or empty string to
   *  let the allocated `art-N` id stand in. Trimmed at submit time. */
  let customName = '';

  // ── Panel shell ───────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'construction-panel';
  panel.classList.add('ri-panel');
  panel.style.width = '280px';
  panel.style.maxHeight = 'calc(100vh - 248px)';
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.overflow = 'hidden';
  panel.style.pointerEvents = 'auto';

  const header = document.createElement('div');
  header.classList.add('ri-panel__head');
  const headTitle = document.createElement('span');
  headTitle.classList.add('ri-panel__title');
  headTitle.textContent = 'CONSTRUCT';
  const headSub = document.createElement('span');
  headSub.classList.add('ri-panel__sub');
  headSub.textContent = 'platform constructor';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.classList.add('ri-modal__close');
  closeBtn.style.width = '18px';
  closeBtn.style.height = '18px';
  closeBtn.style.lineHeight = '0';
  closeBtn.style.borderRadius = '2px';
  closeBtn.style.fontSize = '14px';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', () => hide());
  header.appendChild(headTitle);
  header.appendChild(headSub);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.classList.add('ri-panel__body');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '10px';

  const footer = document.createElement('div');
  footer.style.display = 'flex';
  footer.style.justifyContent = 'space-between';
  footer.style.alignItems = 'center';
  footer.style.gap = '10px';
  footer.style.padding = '10px 12px';
  footer.style.borderTop = '1px solid var(--ri-rule)';

  // ── Controls ──────────────────────────────────────────────────────────────
  const founderSelect = document.createElement('select');
  founderSelect.style.background = 'var(--ri-elev)';
  founderSelect.style.color = 'var(--ri-fg-1)';
  founderSelect.style.border = '1px solid var(--ri-border-strong)';
  founderSelect.style.padding = '4px 6px';
  founderSelect.style.fontFamily = 'var(--ri-font-mono)';
  founderSelect.style.fontSize = '12px';
  founderSelect.style.width = '100%';
  founderSelect.addEventListener('change', () => {
    candidate.founderId = founderSelect.value === '' ? '' : founderSelect.value;
    options.onCandidateChange?.();
    refresh();
  });

  const biomeChips = new Map<Biome, HTMLButtonElement>();

  const majorSlider = document.createElement('input');
  majorSlider.type = 'range';
  majorSlider.min = '4';
  majorSlider.max = '8';
  majorSlider.step = '1';
  majorSlider.value = String(candidate.major);
  majorSlider.style.width = '100%';
  majorSlider.style.accentColor = 'var(--ri-accent)';

  const majorValue = document.createElement('span');
  majorValue.textContent = String(candidate.major);
  majorValue.style.color = 'var(--ri-fg-1)';
  majorValue.style.fontSize = '11px';
  majorValue.style.fontWeight = '600';
  majorValue.style.textAlign = 'right';

  majorSlider.addEventListener('input', () => {
    const cap = radiusCap().major;
    let v = parseInt(majorSlider.value, 10);
    if (!Number.isFinite(v)) return;
    v = Math.max(4, Math.min(v, cap));
    candidate.major = v;
    majorSlider.value = String(v);
    majorValue.textContent = String(v);
    options.onCandidateChange?.();
    refresh();
  });

  const minorSlider = document.createElement('input');
  minorSlider.type = 'range';
  minorSlider.min = '4';
  minorSlider.max = '8';
  minorSlider.step = '1';
  minorSlider.value = String(candidate.minor);
  minorSlider.style.width = '100%';
  minorSlider.style.accentColor = 'var(--ri-accent)';

  const minorValue = document.createElement('span');
  minorValue.textContent = String(candidate.minor);
  minorValue.style.color = 'var(--ri-fg-1)';
  minorValue.style.fontSize = '11px';
  minorValue.style.fontWeight = '600';
  minorValue.style.textAlign = 'right';

  minorSlider.addEventListener('input', () => {
    const cap = radiusCap().minor;
    let v = parseInt(minorSlider.value, 10);
    if (!Number.isFinite(v)) return;
    v = Math.max(4, Math.min(v, cap));
    candidate.minor = v;
    minorSlider.value = String(v);
    minorValue.textContent = String(v);
    options.onCandidateChange?.();
    refresh();
  });

  const posXInput = document.createElement('input');
  posXInput.type = 'number';
  posXInput.value = String(candidate.cx);
  posXInput.step = '1';
  posXInput.style.background = 'var(--ri-elev)';
  posXInput.style.color = 'var(--ri-fg-1)';
  posXInput.style.border = '1px solid var(--ri-border-strong)';
  posXInput.style.padding = '3px 5px';
  posXInput.style.fontFamily = 'var(--ri-font-mono)';
  posXInput.style.fontSize = '12px';
  posXInput.style.width = '100%';
  posXInput.addEventListener('input', () => {
    const v = parseInt(posXInput.value, 10);
    if (Number.isFinite(v)) {
      candidate.cx = v;
      options.onCandidateChange?.();
      refresh();
    }
  });

  const posYInput = document.createElement('input');
  posYInput.type = 'number';
  posYInput.value = String(candidate.cy);
  posYInput.step = '1';
  posYInput.style.background = 'var(--ri-elev)';
  posYInput.style.color = 'var(--ri-fg-1)';
  posYInput.style.border = '1px solid var(--ri-border-strong)';
  posYInput.style.padding = '3px 5px';
  posYInput.style.fontFamily = 'var(--ri-font-mono)';
  posYInput.style.fontSize = '12px';
  posYInput.style.width = '100%';
  posYInput.addEventListener('input', () => {
    const v = parseInt(posYInput.value, 10);
    if (Number.isFinite(v)) {
      candidate.cy = v;
      options.onCandidateChange?.();
      refresh();
    }
  });

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = ISLAND_NAME_MAX_LEN;
  nameInput.style.background = 'var(--ri-elev)';
  nameInput.style.color = 'var(--ri-fg-1)';
  nameInput.style.border = '1px solid var(--ri-border-strong)';
  nameInput.style.padding = '4px 6px';
  nameInput.style.fontFamily = 'var(--ri-font-mono)';
  nameInput.style.fontSize = '12px';
  nameInput.style.width = '100%';
  nameInput.addEventListener('input', () => {
    customName = nameInput.value;
  });

  let costGrid: HTMLDivElement | undefined;

  const statusEl = document.createElement('span');
  statusEl.className = 'ri-muted';
  statusEl.style.fontSize = '10.5px';
  statusEl.style.letterSpacing = '0.06em';
  statusEl.style.textTransform = 'uppercase';

  const constructBtn = document.createElement('button');
  constructBtn.textContent = '▶ CONSTRUCT';
  constructBtn.className = 'ri-btn';
  constructBtn.style.fontWeight = '700';
  constructBtn.style.letterSpacing = '0.10em';
  constructBtn.addEventListener('click', () => {
    tryConstruct();
    constructBtn.blur();
  });

  function makeCostBox(label: string, valueEl: HTMLSpanElement): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.style.border = '1px solid var(--ri-border-strong)';
    wrap.style.padding = '6px 8px';
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '2px';
    wrap.style.background = 'rgba(20, 24, 32, 0.4)';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.color = 'var(--ri-fg-3)';
    l.style.fontSize = '10px';
    l.style.letterSpacing = '0.10em';
    l.style.textTransform = 'uppercase';
    wrap.appendChild(l);
    wrap.appendChild(valueEl);
    return wrap;
  }

  // ── Body content ──────────────────────────────────────────────────────────
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '10px';

  // --- Founder picker ------------------------------------------------------
  const founderSection = document.createElement('div');
  const founderLabel = document.createElement('div');
  founderLabel.textContent = 'Founder Island';
  founderLabel.className = 'ri-sectionhead';
  founderSection.appendChild(founderLabel);
  founderSection.appendChild(founderSelect);
  body.appendChild(founderSection);

  // --- Biome picker (chip strip) -------------------------------------------
  const biomeSection = document.createElement('div');
  const biomeLabel = document.createElement('div');
  biomeLabel.textContent = 'Biome';
  biomeLabel.className = 'ri-sectionhead';
  biomeSection.appendChild(biomeLabel);

  const biomeStrip = document.createElement('div');
  biomeStrip.style.display = 'flex';
  biomeStrip.style.gap = '6px';
  biomeStrip.style.flexWrap = 'wrap';
  for (const b of BIOME_ORDER) {
    const chip = document.createElement('button');
    chip.textContent = BIOME_DEFS[b].displayName;
    chip.className = 'ri-chip';
    chip.addEventListener('click', () => {
      candidate.biome = b;
      options.onCandidateChange?.();
      refresh();
      chip.blur();
    });
    biomeChips.set(b, chip);
    biomeStrip.appendChild(chip);
  }
  biomeSection.appendChild(biomeStrip);
  body.appendChild(biomeSection);

  // --- Size sliders --------------------------------------------------------
  const sizeSection = document.createElement('div');
  const sizeLabel = document.createElement('div');
  sizeLabel.textContent = 'Size (ellipse radii in tiles)';
  sizeLabel.className = 'ri-sectionhead';
  sizeSection.appendChild(sizeLabel);

  const sizeGrid = document.createElement('div');
  sizeGrid.style.display = 'grid';
  sizeGrid.style.gridTemplateColumns = '90px 1fr 40px';
  sizeGrid.style.gap = '8px';
  sizeGrid.style.alignItems = 'center';

  function makeSliderLabel(text: string): HTMLSpanElement {
    const label = document.createElement('span');
    label.textContent = text;
    label.style.color = 'var(--ri-fg-3)';
    label.style.fontSize = '11px';
    label.style.letterSpacing = '0.08em';
    label.style.textTransform = 'uppercase';
    return label;
  }

  sizeGrid.appendChild(makeSliderLabel('Major Radius'));
  sizeGrid.appendChild(majorSlider);
  sizeGrid.appendChild(majorValue);
  sizeGrid.appendChild(makeSliderLabel('Minor Radius'));
  sizeGrid.appendChild(minorSlider);
  sizeGrid.appendChild(minorValue);
  sizeSection.appendChild(sizeGrid);
  body.appendChild(sizeSection);

  // --- Position inputs -----------------------------------------------------
  const posSection = document.createElement('div');
  const posLabel = document.createElement('div');
  posLabel.textContent = 'Position (world-tile coords)';
  posLabel.className = 'ri-sectionhead';
  posSection.appendChild(posLabel);

  const posGrid = document.createElement('div');
  posGrid.style.display = 'grid';
  posGrid.style.gridTemplateColumns = '90px 1fr 90px 1fr';
  posGrid.style.gap = '8px';
  posGrid.style.alignItems = 'center';

  function makePosLabel(text: string): HTMLSpanElement {
    const label = document.createElement('span');
    label.textContent = text;
    label.style.color = 'var(--ri-fg-3)';
    label.style.fontSize = '11px';
    label.style.letterSpacing = '0.08em';
    label.style.textTransform = 'uppercase';
    return label;
  }

  posGrid.appendChild(makePosLabel('Target X'));
  posGrid.appendChild(posXInput);
  posGrid.appendChild(makePosLabel('Target Y'));
  posGrid.appendChild(posYInput);
  posSection.appendChild(posGrid);
  body.appendChild(posSection);

  // --- Name input ----------------------------------------------------------
  const nameSection = document.createElement('div');
  const nameLabel = document.createElement('div');
  nameLabel.textContent = 'Name (optional)';
  nameLabel.className = 'ri-sectionhead';
  nameSection.appendChild(nameLabel);
  nameSection.appendChild(nameInput);
  body.appendChild(nameSection);

  // --- Cost readout --------------------------------------------------------
  const costSection = document.createElement('div');
  const costLabel = document.createElement('div');
  costLabel.textContent = 'Materials Required';
  costLabel.className = 'ri-sectionhead';
  costSection.appendChild(costLabel);

  costGrid = document.createElement('div');
  costGrid.style.display = 'grid';
  costGrid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(100px, 1fr))';
  costGrid.style.gap = '8px';
  costSection.appendChild(costGrid);
  body.appendChild(costSection);

  // ── Footer content ────────────────────────────────────────────────────────
  footer.appendChild(statusEl);
  footer.appendChild(constructBtn);

  // ── Assemble panel ────────────────────────────────────────────────────────
  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);
  parentEl.appendChild(panel);

  const panelHandle = mountPanel(panel, {
    id: 'construction-panel',
    zone: Zone.R,
    order: 1,
  });
  panelHandle.setVisible(false);

  // ── Helpers ───────────────────────────────────────────────────────────────
  /** Maximum radius allowed for the currently resolved founder. Falls back
   *  to 8 when no founder is selected. */
  function radiusCap(): { major: number; minor: number } {
    const founder = candidate.founderId
      ? options.world.islands.find((s) => s.id === candidate.founderId)
      : undefined;
    const state = founder ? options.islandStates.get(founder.id) : undefined;
    // Per-axis cap = min(tier, biome reclamation cap) for the CURRENT biome
    // selection, so switching to a smaller biome re-clamps the sliders.
    return state ? maxRadiiForConstruction(state.level, candidate.biome) : { major: 8, minor: 8 };
  }

  /** Collect every island state that satisfies "populated + T3+ + has
   *  platform_constructor". Pure read of `options.world` / `options.islandStates`. */
  function eligibleFounders(): Array<{ spec: IslandSpec; state: IslandState }> {
    const out: Array<{ spec: IslandSpec; state: IslandState }> = [];
    for (const spec of options.world.islands) {
      if (!spec.populated) continue;
      const state = options.islandStates.get(spec.id);
      if (!state) continue;
      if (tierForLevel(state.level) < 3) continue;
      if (!hasOperationalBuilding(spec.buildings, 'platform_constructor')) continue;
      out.push({ spec, state });
    }
    return out;
  }

  /** Write `candidate` back into the visible control values and chip states. */
  function readCandidateIntoControls(): void {
    founderSelect.value = candidate.founderId;
    for (const [b, chip] of biomeChips) {
      chip.dataset.active = b === candidate.biome ? 'true' : 'false';
    }
    majorSlider.value = String(candidate.major);
    majorValue.textContent = String(candidate.major);
    minorSlider.value = String(candidate.minor);
    minorValue.textContent = String(candidate.minor);
    posXInput.value = String(candidate.cx);
    posYInput.value = String(candidate.cy);
  }

  function refresh(): void {
    if (!visible) return;

    // Rebuild founder options — `world.islands` may have grown since last open.
    const eligible = eligibleFounders();
    while (founderSelect.firstChild) founderSelect.removeChild(founderSelect.firstChild);
    if (eligible.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '— no eligible founder (need T3 island with Platform Constructor) —';
      founderSelect.appendChild(opt);
      candidate.founderId = '';
    } else {
      for (const { spec, state } of eligible) {
        const opt = document.createElement('option');
        opt.value = spec.id;
        opt.textContent = `${spec.name} (${spec.biome}, L${state.level})`;
        founderSelect.appendChild(opt);
      }
      // Reselect previous if still valid; otherwise prefer the currently
      // active island (if eligible); fall back to the first eligible.
      const stillValid = eligible.find((e) => e.spec.id === candidate.founderId);
      const activeId = options.getActiveIslandId?.();
      const activeEligible = activeId
        ? eligible.find((e) => e.spec.id === activeId)
        : undefined;
      const target =
        stillValid?.spec.id ??
        activeEligible?.spec.id ??
        eligible[0]?.spec.id ??
        null;
      candidate.founderId = target ?? '';
      if (target) founderSelect.value = target;
    }

    // Clamp radii to min(tier cap, biome reclamation cap) and update slider
    // ranges — per axis, for the currently selected biome.
    const founder = candidate.founderId
      ? eligible.find((e) => e.spec.id === candidate.founderId)
      : null;
    const cap = founder
      ? maxRadiiForConstruction(founder.state.level, candidate.biome)
      : { major: 8, minor: 8 };
    majorSlider.max = String(cap.major);
    minorSlider.max = String(cap.minor);
    candidate.major = Math.max(4, Math.min(candidate.major, cap.major));
    candidate.minor = Math.max(4, Math.min(candidate.minor, cap.minor));

    readCandidateIntoControls();

    const req: ConstructionRequirements = {
      biome: candidate.biome,
      majorRadius: candidate.major,
      minorRadius: candidate.minor,
    };
    const cost = computeConstructionCost(req);

    // Rebuild cost rows dynamically from basket
    if (costGrid) {
      costGrid.innerHTML = '';
      for (const [resource, amount] of Object.entries(cost)) {
        const valueSpan = document.createElement('span');
        valueSpan.classList.add('ri-mono');
        valueSpan.textContent = '—';
        valueSpan.style.color = 'var(--ri-fg-1)';
        valueSpan.style.fontSize = '13px';
        valueSpan.style.fontWeight = '600';
        const label = resource.toUpperCase().replace(/_/g, ' ');
        costGrid.appendChild(makeCostBox(label, valueSpan));
        const have = founder?.state.inventory[resource as ResourceId] ?? 0;
        paintCostRow(valueSpan, amount, have);
      }
    }

    const v = computePlacementValidity(options.world, options.islandStates, candidate);

    if (v.ok) {
      statusEl.textContent = `READY — ${candidate.biome} ${candidate.major}x${candidate.minor} AT (${candidate.cx}, ${candidate.cy})`;
      statusEl.style.color = 'var(--ri-accent)';
      constructBtn.style.background = 'var(--ri-accent)';
      constructBtn.style.color = 'var(--ri-void)';
      constructBtn.style.borderColor = 'var(--ri-accent-dim)';
      constructBtn.style.cursor = 'pointer';
      constructBtn.title = '';
      constructBtn.disabled = false;
    } else {
      const reason = v.reason ?? 'invalid-biome';
      const label = REASON_LABEL[reason];
      statusEl.textContent = label.toUpperCase();
      statusEl.style.color = 'var(--ri-warn)';
      constructBtn.style.background = 'var(--ri-fg-4)';
      constructBtn.style.color = 'var(--ri-fg-3)';
      constructBtn.style.borderColor = 'var(--ri-fg-4)';
      constructBtn.style.cursor = 'not-allowed';
      constructBtn.title = label;
      constructBtn.disabled = true;
    }

    // Name placeholder previews the to-be-allocated position id `art-<cx>-<cy>`
    // (see `artificialIslandId`), so the player sees the default before deciding
    // to type a custom name. Position-derived → no counter readback needed.
    nameInput.placeholder = artificialIslandId(candidate.cx, candidate.cy);
  }

  function paintCostRow(el: HTMLSpanElement, need: number, have: number): void {
    el.textContent = `${have.toFixed(0)} / ${need}`;
    if (have >= need) {
      el.style.color = 'var(--ri-fg-1)';
    } else {
      el.style.color = 'var(--ri-warn)';
      el.title = `Short by ${(need - have).toFixed(0)}`;
    }
    // Reset warn-dim fallback when have meets need.
    if (have >= need) el.title = '';
  }

  async function tryConstruct(): Promise<void> {
    const v = computePlacementValidity(options.world, options.islandStates, candidate);
    if (!v.ok) return;
    const spec = options.world.islands.find((s) => s.id === candidate.founderId);
    const state = spec ? options.islandStates.get(spec.id) : undefined;
    if (!spec || !state) return;

    const req: ConstructionRequirements = {
      biome: candidate.biome,
      majorRadius: candidate.major,
      minorRadius: candidate.minor,
    };
    const nowMs = performance.now();
    // Validate via the shared `validateIslandName` predicate so the rules
    // can't drift from `renameIsland`. Failure (empty/too-long/control-char)
    // falls back to `undefined`, which makes `constructIsland` default to
    // the auto-generated id rather than landing a malformed display name.
    const nameCheck = validateIslandName(customName);
    const displayName = nameCheck.ok ? nameCheck.name : undefined;

    if (options.gateway) {
      const gatewayResult = await options.gateway.constructIsland({
        founderIslandId: candidate.founderId,
        biome: candidate.biome,
        majorRadius: candidate.major,
        minorRadius: candidate.minor,
        cx: candidate.cx,
        cy: candidate.cy,
        displayName,
        nowMs,
      });
      if (!gatewayResult.ok) return;
      // REMOTE: the authoritative snapshot push will append the new island and
      // rebuild render layers; the UI just needs to reset and close.
      customName = '';
      nameInput.value = '';
      hide();
      return;
    }

    const id = artificialIslandId(candidate.cx, candidate.cy);
    const result = constructIsland(
      options.world.seed,
      state,
      spec,
      req,
      { cx: candidate.cx, cy: candidate.cy },
      id,
      nowMs,
      displayName,
    );
    options.onConstruct({
      newSpec: result.newSpec,
      newState: result.newState,
      founderId: candidate.founderId,
      nowMs,
    });
    // Reset the name field so the next construct starts empty rather than
    // carrying the previous session's name forward.
    customName = '';
    nameInput.value = '';
    // Hide on success so the player sees the new island land on the map.
    hide();
  }

  function show(): void {
    if (visible) return;
    visible = true;
    panelHandle.setVisible(true);

    // Seed the shared candidate on every open so the panel reflects the
    // current active island / world state.
    const eligible = eligibleFounders();
    const activeId = options.getActiveIslandId?.();
    const activeEligible = activeId
      ? eligible.find((e) => e.spec.id === activeId)
      : undefined;
    const founderSpec = activeEligible?.spec ?? eligible[0]?.spec;
    if (founderSpec) {
      candidate.founderId = founderSpec.id;
      if (!candidate.biome) candidate.biome = 'plains';
      if (!candidate.major) candidate.major = 4;
      if (!candidate.minor) candidate.minor = 4;
      candidate.cx = founderSpec.cx + founderSpec.majorRadius + candidate.major + 6;
      candidate.cy = founderSpec.cy;
    }

    readCandidateIntoControls();
    refresh();
  }

  function hide(): void {
    if (!visible) return;
    visible = false;
    panelHandle.setVisible(false);
  }

  function toggle(): boolean {
    if (visible) hide();
    else show();
    return visible;
  }

  function refreshFromCandidate(): void {
    readCandidateIntoControls();
    refresh();
  }

  return {
    el: panel,
    refresh,
    refreshFromCandidate,
    show,
    hide,
    toggle,
    isVisible: () => visible,
  };
}
