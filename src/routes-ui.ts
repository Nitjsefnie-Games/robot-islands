// Freight-grid side dock + in-world route line visuals.
//
// Aesthetic: sibling of DRONE OPS (sub-identity `▰ FREIGHT GRID / LCS-01`).
// Where DRONE OPS is amber-dominant (arming/dispatching), FREIGHT GRID is
// cyan-dominant (scheduled flow); active routes use a thin cyan rule for
// "continuous" vs. the drone ledger's amber countdown rule.
//
// In-world route lines + chevron glyphs are owned by RouteRenderer
// (world-space, under the `world` Container; see routes-renderer.ts).

import type { IslandState } from './economy.js';
import { mountPanel, Zone } from './ui-zones.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import type { CargoEntry } from './route-cargo.js';
import {
  reorderPriorityList,
  transitTimeForDistance,
  routeProfileForBuilding,
  routeFloorMultiplier,
  createRouteFromBuilding,
  eligibleTransportBuildings,
  islandHasTeleporterPad,
  retargetRoute as retargetRoutePure,
  type Route,
} from './routes.js';
import { type IslandSpec, type WorldState } from './world.js';
import { BUILDING_DEFS } from './building-defs.js';
import { type MutationGateway } from './mutation-gateway.js';
import { activeFloorLevel, floorEffectMul } from './buildings.js';
import type { RouteRenderer } from './routes-renderer.js';

/** Exported pure helper for tests: signature of the FROM island's building
 *  set that should gate VIA BUILDING dropdown rebuilds. Includes every
 *  building's id, defId, and active floor level so placement, demolition,
 *  upgrade, or floor-disabling all invalidate the cache. */
export function viaBuildingKeyForIsland(island: IslandSpec | undefined): string {
  if (!island) return '';
  let k = island.id + ';';
  for (const b of island.buildings) {
    k += b.id + ':' + b.defId + ':' + activeFloorLevel(b) + '|';
  }
  return k;
}

function styled(el: HTMLElement, css: string): void {
  el.style.cssText = css;
}

// §6 cable-tint discriminator: power-link routes (no cargo) get distinct
// tints from cargo routes so power-only routes read at a glance; within the
// power-link family, the §4 ocean-layer `submarine_cable` variant is darker
// than the land `cable` so undersea links are distinguishable.

export interface RouteUiHandle {
  refresh(nowMs: number): void;
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
}

export interface RouteUiDeps {
  readonly world: WorldState;
  readonly islandStates: Map<string, IslandState>;
  /** Island specs keyed by id (so we can resolve world-tile centres for
   *  distance/transit-time calculations in the create form). */
  readonly islandSpecs: ReadonlyMap<string, IslandSpec>;
  readonly routeRenderer: RouteRenderer;
  /** Mutation gateway — optional so tests can keep wiring only the fields
   *  they already have. When present, all route mutations route through the
   *  gateway; otherwise the pure helpers are called directly. */
  gateway?: MutationGateway;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------
export function mountRoutesUi(parentEl: HTMLElement, deps: RouteUiDeps): RouteUiHandle {
  let visible = false;

  // ---- Panel chrome ----------------------------------------------------------
  const panel = document.createElement('div');
  panel.id = 'routes-panel';
  panel.classList.add('ri-panel');
  styled(
    panel,
    [
      'width: 268px',
      'max-height: calc(100vh - 32px)',
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

  // Header
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
  const stamp = document.createElement('span');
  stamp.textContent = '▰';
  styled(stamp, `color: ${'var(--ri-accent)'}; font-size: 10px`);
  const headTitle = document.createElement('span');
  headTitle.textContent = 'FREIGHT GRID';
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
  headSub.textContent = 'LCS-01';
  styled(
    headSub,
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 9.5px', 'letter-spacing: 0.16em'].join(';'),
  );
  headLeft.appendChild(stamp);
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
  closeBtn.addEventListener('click', () => hide());

  header.appendChild(headLeft);
  header.appendChild(closeBtn);

  // ---- Body ------------------------------------------------------------------
  const body = document.createElement('div');
  styled(
    body,
    [
      'display: flex',
      'flex-direction: column',
      'gap: 14px',
      'padding: 12px 12px 14px',
      'overflow-y: auto',
      'flex: 1 1 auto',
    ].join(';'),
  );

  // ---- Stat block ------------------------------------------------------------
  const statBlock = document.createElement('div');
  styled(
    statBlock,
    [
      'display: grid',
      'grid-template-columns: 1fr 1fr',
      'gap: 4px 12px',
      'padding: 6px 8px',
      `border: 1px solid ${'var(--ri-border-strong)'}`,
      `background: ${'rgba(24, 29, 39, 0.6)'}`,
    ].join(';'),
  );

  function statRow(labelText: string): { row: HTMLDivElement; valueEl: HTMLSpanElement } {
    const row = document.createElement('div');
    styled(row, 'display: flex; align-items: baseline; justify-content: space-between; gap: 6px');
    const l = document.createElement('span');
    l.textContent = labelText;
    styled(
      l,
      [
        `color: ${'var(--ri-fg-3)'}`,
        'font-size: 9.5px',
        'letter-spacing: 0.1em',
        'text-transform: uppercase',
      ].join(';'),
    );
    const v = document.createElement('span');
    v.classList.add('ri-mono');
    styled(v, `color: ${'var(--ri-fg-1)'}; font-size: 11.5px; font-weight: 600`);
    row.appendChild(l);
    row.appendChild(v);
    return { row, valueEl: v };
  }

  const routesStat = statRow('ROUTES');
  const capStat = statRow('CAP/S');
  const flightStat = statRow('IN-FLIGHT');
  const funnelStat = statRow('FUNNEL');
  routesStat.valueEl.style.color = 'var(--ri-accent)';
  statBlock.appendChild(routesStat.row);
  statBlock.appendChild(capStat.row);
  statBlock.appendChild(flightStat.row);
  statBlock.appendChild(funnelStat.row);
  body.appendChild(statBlock);

  // ---- Create-route form -----------------------------------------------------
  const formWrap = document.createElement('div');
  styled(
    formWrap,
    [
      'display: flex',
      'flex-direction: column',
      'gap: 6px',
      'padding: 6px 6px 8px 10px',
      `border-left: 2px solid ${'var(--ri-accent-dim)'}`,
      `background: rgba(125, 211, 232, 0.03)`,
    ].join(';'),
  );

  const formHeader = document.createElement('div');
  formHeader.textContent = 'NEW ROUTE';
  styled(
    formHeader,
    [
      `color: ${'var(--ri-accent)'}`,
      'font-size: 10px',
      'letter-spacing: 0.18em',
      'font-weight: 600',
      'padding-bottom: 2px',
    ].join(';'),
  );
  formWrap.appendChild(formHeader);

  function labelEl(t: string): HTMLLabelElement {
    const l = document.createElement('label');
    l.textContent = t;
    styled(
      l,
      [
        `color: ${'var(--ri-fg-3)'}`,
        'font-size: 9.5px',
        'letter-spacing: 0.1em',
        'text-transform: uppercase',
      ].join(';'),
    );
    return l;
  }
  function selectStyled(): HTMLSelectElement {
    const s = document.createElement('select');
    styled(
      s,
      [
        `background: var(--ri-elev)`,
        `color: ${'var(--ri-fg-1)'}`,
        `border: 1px solid ${'var(--ri-border-strong)'}`,
        'font-family: ui-monospace, monospace',
        'font-size: 11px',
        'padding: 3px 6px',
        'border-radius: 2px',
        'width: 100%',
        'box-sizing: border-box',
        'cursor: pointer',
      ].join(';'),
    );
    return s;
  }

  const fromRow = document.createElement('div');
  styled(fromRow, 'display: flex; flex-direction: column; gap: 2px');
  const fromSel = selectStyled();
  fromRow.appendChild(labelEl('FROM'));
  fromRow.appendChild(fromSel);

  const buildingRow = document.createElement('div');
  styled(buildingRow, 'display: flex; flex-direction: column; gap: 2px');
  const buildingSel = selectStyled();
  buildingRow.appendChild(labelEl('VIA BUILDING'));
  buildingRow.appendChild(buildingSel);

  const toRow = document.createElement('div');
  styled(toRow, 'display: flex; flex-direction: column; gap: 2px');
  const toSel = selectStyled();
  toRow.appendChild(labelEl('TO'));
  toRow.appendChild(toSel);

  const cargoRow = document.createElement('div');
  styled(cargoRow, 'display: flex; flex-direction: column; gap: 2px');
  const cargoSel = selectStyled();
  cargoRow.appendChild(labelEl('CARGO'));
  cargoRow.appendChild(cargoSel);

  formWrap.appendChild(fromRow);
  formWrap.appendChild(buildingRow);
  formWrap.appendChild(toRow);
  formWrap.appendChild(cargoRow);

  // Distance / ETA / capacity readout
  const formReadout = document.createElement('div');
  formReadout.classList.add('ri-mono');
  styled(
    formReadout,
    [
      `color: ${'var(--ri-fg-3)'}`,
      'font-size: 9.5px',
      'letter-spacing: 0.08em',
      'padding: 2px 0',
      'min-height: 14px',
    ].join(';'),
  );
  formWrap.appendChild(formReadout);

  const commitBtn = document.createElement('button');
  commitBtn.textContent = '◆ COMMISSION ROUTE';
  styled(
    commitBtn,
    [
      'background: var(--ri-elev)',
      `color: ${'var(--ri-fg-1)'}`,
      `border: 1px solid ${'var(--ri-border-strong)'}`,
      'padding: 6px 10px',
      'cursor: pointer',
      'font-family: ui-monospace, monospace',
      'font-size: 10.5px',
      'letter-spacing: 0.18em',
      'text-transform: uppercase',
      'font-weight: 600',
      'transition: background 100ms ease, border-color 100ms ease, color 100ms ease',
    ].join(';'),
  );
  commitBtn.addEventListener('mouseenter', () => {
    if (commitBtn.disabled) return;
    commitBtn.style.color = 'var(--ri-accent)';
    commitBtn.style.borderColor = 'var(--ri-accent-dim)';
  });
  commitBtn.addEventListener('mouseleave', () => {
    if (commitBtn.disabled) return;
    commitBtn.style.color = 'var(--ri-fg-1)';
    commitBtn.style.borderColor = 'var(--ri-border-strong)';
  });
  commitBtn.addEventListener('click', () => commissionRoute());
  formWrap.appendChild(commitBtn);

  body.appendChild(formWrap);

  // ---- Active routes ledger --------------------------------------------------
  const ledgerWrap = document.createElement('div');
  styled(ledgerWrap, 'display: flex; flex-direction: column; gap: 4px');

  const ledgerHead = document.createElement('div');
  styled(
    ledgerHead,
    [
      'display: flex',
      'justify-content: space-between',
      'align-items: baseline',
      `border-bottom: 1px solid ${'var(--ri-border-strong)'}`,
      'padding-bottom: 3px',
    ].join(';'),
  );
  const ledgerL = document.createElement('span');
  ledgerL.textContent = 'ACTIVE';
  styled(
    ledgerL,
    [
      `color: ${'var(--ri-accent)'}`,
      'font-size: 10px',
      'font-weight: 600',
      'letter-spacing: 0.18em',
    ].join(';'),
  );
  const ledgerR = document.createElement('span');
  styled(ledgerR, `color: ${'var(--ri-fg-3)'}; font-size: 9.5px; letter-spacing: 0.08em`);
  ledgerHead.appendChild(ledgerL);
  ledgerHead.appendChild(ledgerR);

  const ledgerList = document.createElement('div');
  styled(ledgerList, 'display: flex; flex-direction: column; gap: 4px; min-height: 24px');

  const ledgerEmpty = document.createElement('div');
  ledgerEmpty.textContent = 'no active routes';
  styled(
    ledgerEmpty,
    [
      `color: ${'var(--ri-fg-4)'}`,
      'font-size: 10px',
      'letter-spacing: 0.06em',
      'font-style: italic',
      'padding: 8px 4px',
    ].join(';'),
  );

  ledgerWrap.appendChild(ledgerHead);

  const ledgerFilterSel = selectStyled();
  // Compact overrides — set individual props so the selectStyled() base
  // (dark bg, border, colour) survives. `styled()` replaces cssText, so a
  // second styled() call here would wipe the select chrome.
  ledgerFilterSel.style.fontSize = '10px';
  ledgerFilterSel.style.padding = '2px 5px';
  ledgerFilterSel.style.margin = '2px 0 4px';
  ledgerWrap.appendChild(ledgerFilterSel);
  ledgerFilterSel.addEventListener('change', () => repaintLedger(performance.now()));

  ledgerWrap.appendChild(ledgerList);
  body.appendChild(ledgerWrap);

  // ---- Footer ----------------------------------------------------------------
  const footer = document.createElement('div');
  styled(
    footer,
    [
      'padding: 6px 12px',
      `border-top: 1px solid ${'var(--ri-border-strong)'}`,
      `background: ${'rgba(24, 29, 39, 0.6)'}`,
      `color: ${'var(--ri-fg-3)'}`,
      'font-size: 9.5px',
      'letter-spacing: 0.06em',
      'text-transform: uppercase',
    ].join(';'),
  );
  footer.textContent = 'T1 cargo · 0.5 u/s · §2.4';

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);
  parentEl.appendChild(panel);

  const panelHandle = mountPanel(panel, {
    id: 'routes-panel',
    zone: Zone.R,
    order: 1,
  });
  panelHandle.setVisible(false);

  // ---- Form helpers ----------------------------------------------------------
  function populatedIslands(): IslandSpec[] {
    const out: IslandSpec[] = [];
    for (const s of deps.world.islands) {
      if (s.populated) out.push(s);
    }
    return out;
  }

  function buildOptions(): void {
    const islands = populatedIslands();
    const prevFrom = fromSel.value;
    const prevTo = toSel.value;
    const prevCargo = cargoSel.value;
    fromSel.replaceChildren();
    toSel.replaceChildren();
    for (const isl of islands) {
      const o1 = document.createElement('option');
      o1.value = isl.id;
      o1.textContent = isl.name;
      fromSel.appendChild(o1);
      const o2 = document.createElement('option');
      o2.value = isl.id;
      o2.textContent = isl.name;
      toSel.appendChild(o2);
    }
    if (prevFrom && islands.some((s) => s.id === prevFrom)) fromSel.value = prevFrom;
    if (prevTo && islands.some((s) => s.id === prevTo)) toSel.value = prevTo;
    else if (islands.length >= 2) toSel.value = islands[1]!.id;

    cargoSel.replaceChildren();
    // "any" — priority list defaults to [] per §2.4; the player adds entries
    // via the ledger's cargo editor (drag-to-reorder once populated).
    const oAny = document.createElement('option');
    oAny.value = '__any__';
    oAny.textContent = 'any (priority)';
    cargoSel.appendChild(oAny);
    for (const r of ALL_RESOURCES) {
      const o = document.createElement('option');
      o.value = r;
      o.textContent = r;
      cargoSel.appendChild(o);
    }
    if (prevCargo) cargoSel.value = prevCargo;
    buildBuildingOptions();
    buildLedgerFilterOptions();
    lastRoutesKey = routesKey();
    lastViaBuildingsKey = viaBuildingsKey();
  }

  /** Rebuild the VIA BUILDING select for the currently-selected FROM
   *  island — transport buildings that don't already own a route. */
  function buildBuildingOptions(): void {
    const island = deps.islandSpecs.get(fromSel.value);
    buildingSel.replaceChildren();
    const eligible = island
      ? eligibleTransportBuildings(island, deps.world.routes)
      : [];
    if (eligible.length === 0) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '(no transport building free)';
      buildingSel.appendChild(o);
      buildingSel.disabled = true;
      return;
    }
    buildingSel.disabled = false;
    for (const b of eligible) {
      const profile = routeProfileForBuilding(b.defId)!;
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent =
        `${BUILDING_DEFS[b.defId].displayName} · ${profile.type} · ${profile.capacityPerSec} u/s`;
      buildingSel.appendChild(o);
    }
  }

  /** Rebuild the ledger island-filter select: "All islands" + each
   *  populated island by name. Preserves the current selection. */
  function buildLedgerFilterOptions(): void {
    const prev = ledgerFilterSel.value;
    ledgerFilterSel.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All islands';
    ledgerFilterSel.appendChild(all);
    for (const isl of populatedIslands()) {
      const o = document.createElement('option');
      o.value = isl.id;
      o.textContent = isl.name;
      ledgerFilterSel.appendChild(o);
    }
    if (prev && populatedIslands().some((s) => s.id === prev)) {
      ledgerFilterSel.value = prev;
    }
  }

  // Dropdown-rebuild cache keys. Declared here — before the eager
  // buildOptions() below — because buildOptions() seeds lastRoutesKey /
  // lastViaBuildingsKey during mount; the `let`s must already be initialized
  // when it runs or the assignment hits the temporal dead zone. Their
  // companion key-functions (populatedKey/routesKey/viaBuildingsKey) are
  // hoisted, so they stay defined further down next to their docs.
  let lastPopulatedKey = '';
  let lastRoutesKey = '';
  let lastViaBuildingsKey = '';

  buildOptions();
  fromSel.addEventListener('change', () => {
    buildBuildingOptions();
    refreshFormReadout();
  });
  buildingSel.addEventListener('change', () => refreshFormReadout());
  toSel.addEventListener('change', () => refreshFormReadout());
  cargoSel.addEventListener('change', () => refreshFormReadout());

  function refreshFormReadout(): void {
    const fromId = fromSel.value;
    const toId = toSel.value;
    const spec1 = deps.islandSpecs.get(fromId);
    const spec2 = deps.islandSpecs.get(toId);
    const building = spec1?.buildings.find((b) => b.id === buildingSel.value) ?? null;
    const profile = building ? routeProfileForBuilding(building.defId) : null;
    const reject = (msg: string): void => {
      formReadout.textContent = msg;
      commitBtn.disabled = true;
      commitBtn.style.opacity = '0.5';
      commitBtn.style.cursor = 'not-allowed';
    };
    if (!spec1 || !spec2) return reject('');
    if (fromId === toId) return reject('pick distinct endpoints');
    if (!building || !profile) return reject('no transport building available');
    if (profile.type === 'teleporter' && !islandHasTeleporterPad(spec2)) {
      return reject('teleporter needs a pad on the destination');
    }
    const dx = spec1.cx - spec2.cx;
    const dy = spec1.cy - spec2.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const transit = transitTimeForDistance(dist, profile.speedTilesPerSec);
    // §2.4 route-floor scaling: preview the EFFECTIVE cap/ETA the new route gets
    // from this building's current active floors (capacity ×(1+L), ETA ÷(1+L)).
    const fmul = floorEffectMul(Math.max(0, activeFloorLevel(building)));
    formReadout.textContent =
      `${dist.toFixed(0)} t · ETA ${(transit / fmul).toFixed(1)}s · ${(profile.capacityPerSec * fmul).toFixed(2)} u/s`;
    commitBtn.disabled = false;
    commitBtn.style.opacity = '1';
    commitBtn.style.cursor = 'pointer';
  }
  refreshFormReadout();

  async function commissionRoute(): Promise<void> {
    const fromId = fromSel.value;
    const toId = toSel.value;
    const cargoChoice = cargoSel.value;
    const spec1 = deps.islandSpecs.get(fromId);
    const spec2 = deps.islandSpecs.get(toId);
    if (!spec1 || !spec2 || fromId === toId) return;
    const building = spec1.buildings.find((b) => b.id === buildingSel.value);
    if (!building) return;
    const profile = routeProfileForBuilding(building.defId);
    if (!profile) return;
    if (profile.type === 'teleporter' && !islandHasTeleporterPad(spec2)) return;
    const dx = spec1.cx - spec2.cx;
    const dy = spec1.cy - spec2.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const isAny = cargoChoice === '__any__';
    if (deps.gateway) {
      const res = await deps.gateway.createRoute(
        fromId,
        toId,
        building.id,
        isAny ? null : (cargoChoice as ResourceId),
      );
      if (!res.ok) return;
    } else {
      const route = createRouteFromBuilding(
        building, fromId, toId, isAny ? null : (cargoChoice as ResourceId), dist,
      );
      if (!route) return;
      deps.world.routes.push(route);
    }
    refresh(performance.now());
  }

  // ---- Ledger renderer -------------------------------------------------------
  let isDraggingPriority = false;

  /** A built ledger row + a closure that refreshes only its per-frame
   *  dynamic fields (in-flight count, ETA, util bar). Rows are cached by
   *  `route.id` and reused across repaints — rebuilding the DOM every frame
   *  destroys the click target between mousedown and mouseup, so physical
   *  clicks on the delete button never synthesize a `click` event. */
  interface LedgerRowEntry {
    structKey: string;
    row: HTMLDivElement;
    update: (nowMs: number) => void;
  }
  const rowCache = new Map<string, LedgerRowEntry>();
  // Sentinel distinct from any real signature (which is '' for zero routes).
  let lastLedgerSig = 'init';

  /** Player-facing island name per §IslandSpec.name; falls back to the id. */
  function islandLabel(id: string): string {
    return deps.islandSpecs.get(id)?.name ?? id;
  }

  /** Everything about a route that, when changed, requires a DOM rebuild of
   *  its row (vs. a cheap per-frame text update). */
  function routeStructKey(route: Route): string {
    return [
      route.id,
      islandLabel(route.from),
      islandLabel(route.to),
      route.mode,
      route.cargo.map((e) => `${e.resourceId}:${e.weight ?? 1}:${e.sourceFloorPct ?? ''}`).join(','),
      route.draining ? 'D' : '',
      // §2.6: bend count drives whether the "Unbend all" button is rendered,
      // so a row must rebuild when waypoints appear/disappear.
      `b${route.waypoints?.length ?? 0}`,
    ].join('\u001f');
  }

  function repaintLedger(nowMs: number): void {
    if (isDraggingPriority) return;
    const filterId = ledgerFilterSel.value;
    const routes = filterId === ''
      ? deps.world.routes
      : deps.world.routes.filter((r) => r.from === filterId);
    ledgerR.textContent = `${routes.length}`;

    // Only touch the DOM tree when the route SET or any row's structure
    // changes. Steady-state (just ETA/in-flight ticking) skips straight to
    // the in-place `update` pass below.
    const sig = filterId + '\u001e' + routes.map(routeStructKey).join('\u001e');
    if (sig !== lastLedgerSig) {
      lastLedgerSig = sig;
      const seen = new Set<string>();
      const children: HTMLElement[] = [];
      for (const route of routes) {
        const structKey = routeStructKey(route);
        let entry = rowCache.get(route.id);
        if (!entry || entry.structKey !== structKey) {
          entry = renderLedgerRow(route, structKey, nowMs);
          rowCache.set(route.id, entry);
        }
        seen.add(route.id);
        children.push(entry.row);
      }
      for (const id of [...rowCache.keys()]) {
        if (!seen.has(id)) rowCache.delete(id);
      }
      ledgerList.replaceChildren(...(children.length === 0 ? [ledgerEmpty] : children));
    }

    for (const route of routes) {
      rowCache.get(route.id)?.update(nowMs);
    }
  }

  function renderLedgerRow(route: Route, structKey: string, nowMs: number): LedgerRowEntry {
    const row = document.createElement('div');
    styled(
      row,
      [
        'display: flex',
        'flex-direction: column',
        'gap: 2px',
        'padding: 4px 6px',
        `border-left: 2px solid ${route.draining ? 'var(--ri-warn)' : 'var(--ri-accent-dim)'}`,
        `background: rgba(125, 211, 232, 0.04)`,
      ].join(';'),
    );

    const top = document.createElement('div');
    styled(top, 'display: flex; justify-content: space-between; align-items: baseline; gap: 6px');
    const idEl = document.createElement('span');
    idEl.textContent = route.id.toUpperCase();
    styled(idEl, `color: ${'var(--ri-accent)'}; font-size: 10px; letter-spacing: 0.08em; font-weight: 600`);
    top.appendChild(idEl);

    if (route.draining) {
      // Soft-delete in progress: no button. The route stops dispatching and
      // is removed once its in-flight cargo lands (see `Route.draining`).
      const drain = document.createElement('span');
      drain.textContent = 'DRAINING';
      styled(
        drain,
        `color: ${'var(--ri-warn)'}; font-size: 8.5px; letter-spacing: 0.1em; font-weight: 600`,
      );
      top.appendChild(drain);
    } else {
      const delBtn = document.createElement('button');
      delBtn.textContent = '✕';
      delBtn.title = 'delete route — finishes in-flight cargo, then removes';
      delBtn.classList.add('ri-delbtn');
      styled(delBtn, ['width: 16px', 'height: 16px', 'line-height: 0', 'font-size: 10px'].join(';'));
      delBtn.addEventListener('click', async () => {
        if (deps.gateway) {
          await deps.gateway.deleteRoute(route.id);
        } else if (route.inFlight.length === 0) {
          // Nothing to drain — remove immediately (covers never-dispatched,
          // instant-transit, and power-link routes).
          const idx = deps.world.routes.indexOf(route);
          if (idx >= 0) deps.world.routes.splice(idx, 1);
        } else {
          // Stop new dispatch; `tickRoutes` prunes once in-flight drains.
          route.draining = true;
        }
        refresh(performance.now());
      });
      const right = document.createElement('div');
      styled(right, 'display: flex; align-items: baseline; gap: 6px');
      right.appendChild(delBtn);

      // §2.4 retarget — drain to the current target, then re-route to a new
      // island. Candidates: every OTHER populated island (not the source, not
      // the current destination). Picking one fires the retarget mutation.
      const reSel = document.createElement('select');
      reSel.title = 'retarget — drains in-flight cargo to the current target, then re-routes to a new island';
      styled(reSel, ['font-size: 9px', 'max-width: 96px', 'background: transparent', `color: ${'var(--ri-accent)'}`].join(';'));
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = '↪ retarget…';
      reSel.appendChild(ph);
      for (const isl of deps.world.islands) {
        if (!isl.populated) continue;
        if (isl.id === route.from || isl.id === route.to) continue;
        const opt = document.createElement('option');
        opt.value = isl.id;
        opt.textContent = islandLabel(isl.id);
        reSel.appendChild(opt);
      }
      reSel.addEventListener('change', async () => {
        const target = reSel.value;
        if (!target) return;
        if (deps.gateway) await deps.gateway.retargetRoute(route.id, target);
        else retargetRoutePure(deps.world, route.id, target);
        refresh(performance.now());
      });
      right.appendChild(reSel);

      // §2.6 "Unbend all" — clears every bend point in one action. Only shown
      // when the route actually carries bends; map gestures handle per-point
      // editing. Mirrors the delete/retarget gateway-call pattern above.
      if (route.waypoints && route.waypoints.length > 0) {
        const unbendBtn = document.createElement('button');
        unbendBtn.textContent = 'Unbend all';
        unbendBtn.title = 'clear all bend points — straightens the route';
        styled(
          unbendBtn,
          ['font-size: 8.5px', 'padding: 1px 4px', 'background: transparent', `color: ${'var(--ri-accent)'}`].join(';'),
        );
        unbendBtn.addEventListener('click', async () => {
          if (deps.gateway) await deps.gateway.setRouteWaypoints(route.id, []);
          refresh(performance.now());
        });
        right.appendChild(unbendBtn);
      }

      top.appendChild(right);
    }

    const mid = document.createElement('div');
    styled(mid, `color: ${'var(--ri-fg-1)'}; font-size: 10.5px; letter-spacing: 0.04em`);
    const cargo = route.cargo.length === 0
      ? '(empty)'
      : route.cargo.length === 1 && route.mode === 'priority'
        ? route.cargo[0]!.resourceId
        : `${route.mode} · ${route.cargo.length} resources`;
    mid.textContent = `${islandLabel(route.from)} → ${islandLabel(route.to)}  ${cargo}`;

    // Thin cyan rule (continuous flow indicator). Solid bar at the route's
    // utilization (in-flight count vs an arbitrary 10-batch ceiling for the
    // visual scale).
    const ruleWrap = document.createElement('div');
    styled(ruleWrap, [`height: 2px`, `background: ${'var(--ri-border-strong)'}`, 'position: relative'].join(';'));
    const ruleFill = document.createElement('div');
    styled(
      ruleFill,
      [
        'position: absolute',
        'top: 0',
        'left: 0',
        'height: 100%',
        `background: ${'var(--ri-accent)'}`,
        'width: 0%',
      ].join(';'),
    );
    ruleWrap.appendChild(ruleFill);

    const meta = document.createElement('div');
    styled(meta, 'display: flex; justify-content: space-between');
    const left = document.createElement('span');
    left.classList.add('ri-mono');
    // §2.4 route-floor scaling: show the EFFECTIVE cap/transit the route runs
    // at given its source building's active floors, not the stored tier base.
    const fmul = routeFloorMultiplier(route, deps.world);
    left.textContent = `${(route.capacityPerSec * fmul).toFixed(2)} u/s · ${(route.transitTimeSec / fmul).toFixed(1)}s`;
    styled(left, `color: ${'var(--ri-fg-3)'}; font-size: 9.5px`);
    const right = document.createElement('span');
    right.classList.add('ri-mono');
    styled(right, `color: ${'var(--ri-fg-4)'}; font-size: 9.5px`);
    meta.appendChild(left);
    meta.appendChild(right);

    row.appendChild(top);
    row.appendChild(mid);
    row.appendChild(ruleWrap);
    row.appendChild(meta);
    renderCargoEditor(route, row, () => refresh(performance.now()));

    const routeId = route.id;
    // Per-frame dynamic fields — recomputed in place so the row DOM (and its
    // click handlers) survives across repaints. Re-resolve the live Route by
    // id each refresh because applyRemoteSnapshot re-mints world.routes.
    function update(now: number): void {
      const route = deps.world.routes.find((r) => r.id === routeId);
      if (!route) return;
      const inFlightCount = route.inFlight.length;
      const utilPct = Math.min(1, inFlightCount / 10);
      ruleFill.style.width = `${(utilPct * 100).toFixed(2)}%`;
      if (inFlightCount === 0) {
        right.textContent = 'idle';
        right.style.color = 'var(--ri-fg-4)';
        right.style.fontWeight = '400';
      } else {
        const nextArrival = route.inFlight
          .map((b) => b.arrivalTime)
          .reduce((a, b) => Math.min(a, b), Infinity);
        const eta = Math.max(0, (nextArrival - now) / 1000);
        right.textContent = `${inFlightCount} pkg · ETA ${eta.toFixed(1)}s`;
        right.style.color = 'var(--ri-warn)';
        right.style.fontWeight = '600';
      }
    }
    update(nowMs);

    return { structKey, row, update };
  }

  function renderCargoEditor(route: Route, container: HTMLElement, rerender: () => void): void {
    // --- mode selector ---
    const modeRow = document.createElement('div');
    modeRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin:4px 0 0 16px;';
    const modeLbl = document.createElement('span');
    modeLbl.textContent = 'mode';
    modeLbl.style.cssText = 'font-size:11px;color:var(--ri-accent-dim);';
    const modeSel = document.createElement('select');
    modeSel.style.cssText = 'background:var(--ri-panel-solid);color:var(--ri-accent);'
      + 'border:1px solid var(--ri-accent-dim);font-size:11px;padding:2px 4px;';
    for (const m of ['priority', 'waterfall', 'split', 'balanced'] as const) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      if (route.mode === m) o.selected = true;
      modeSel.appendChild(o);
    }
    modeSel.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    modeSel.addEventListener('change', async (e) => {
      e.stopPropagation();
      const mode = modeSel.value as Route['mode'];
      if (deps.gateway) {
        await deps.gateway.setRouteMode(route.id, mode);
      } else {
        route.mode = mode;
      }
      rerender();
    });
    modeRow.appendChild(modeLbl);
    modeRow.appendChild(modeSel);
    container.appendChild(modeRow);

    const orderable = route.mode === 'priority' || route.mode === 'waterfall';

    // --- cargo rows ---
    const ul = document.createElement('ul');
    ul.style.cssText = 'list-style:none;margin:4px 0 0 16px;padding:0;';
    route.cargo.forEach((entry, index) => {
      const li = document.createElement('li');
      li.draggable = orderable;
      li.dataset.index = String(index);
      li.style.cssText = [
        orderable ? 'cursor: grab' : 'cursor: default',
        'padding: 2px 6px', 'border: 1px solid var(--ri-accent-dim)',
        'margin-bottom: 2px', 'background: var(--ri-panel-solid)',
        'color: var(--ri-accent)', 'font-size: 11px', 'border-radius: 2px',
        'display: flex', 'align-items: center', 'gap: 6px',
      ].join(';');

      const label = document.createElement('span');
      label.textContent = entry.resourceId === 'all' ? '(all other resources)' : entry.resourceId;
      label.style.cssText = 'flex:1 1 auto;';
      li.appendChild(label);

      if (route.mode === 'split') {
        const w = document.createElement('input');
        w.type = 'number'; w.min = '1'; w.step = '1';
        w.value = String(entry.weight ?? 1);
        w.title = 'split weight';
        w.style.cssText = 'width:42px;background:var(--ri-panel-solid);'
          + 'color:var(--ri-accent);border:1px solid var(--ri-accent-dim);font-size:11px;';
        w.addEventListener('mousedown', (e) => { e.stopPropagation(); });
        w.addEventListener('change', async (e) => {
          e.stopPropagation();
          const v = Math.max(1, Math.floor(Number(w.value) || 1));
          if (deps.gateway) {
            await deps.gateway.setCargoWeight(route.id, index, v);
          } else {
            route.cargo[index] = { ...entry, weight: v };
          }
          rerender();
        });
        li.appendChild(w);
      }

      const floor = document.createElement('input');
      floor.type = 'number'; floor.min = '0'; floor.max = '100'; floor.step = '5';
      floor.value = entry.sourceFloorPct === undefined ? '' : String(entry.sourceFloorPct);
      floor.placeholder = 'floor%';
      floor.title = 'source-floor gate — only ship while source ≥ this % full';
      floor.style.cssText = 'width:54px;background:var(--ri-panel-solid);'
        + 'color:var(--ri-accent);border:1px solid var(--ri-accent-dim);font-size:11px;';
      floor.addEventListener('mousedown', (e) => { e.stopPropagation(); });
      floor.addEventListener('change', async (e) => {
        e.stopPropagation();
        const raw = floor.value.trim();
        const pct = raw === '' ? undefined : Math.min(100, Math.max(0, Number(raw) || 0));
        if (deps.gateway) {
          await deps.gateway.setCargoFloorPct(route.id, index, pct);
        } else {
          const next: typeof entry = { ...entry };
          if (pct === undefined) delete (next as { sourceFloorPct?: number }).sourceFloorPct;
          else (next as { sourceFloorPct?: number }).sourceFloorPct = pct;
          route.cargo[index] = next;
        }
        rerender();
      });
      li.appendChild(floor);

      const del = document.createElement('button');
      del.type = 'button'; del.textContent = '×'; del.title = 'remove from cargo';
      del.style.cssText = 'cursor:pointer;background:transparent;color:var(--ri-warn);'
        + 'border:1px solid var(--ri-accent-dim);border-radius:2px;padding:0 6px;'
        + 'font-size:11px;line-height:14px;';
      del.addEventListener('mousedown', (e) => { e.stopPropagation(); });
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (deps.gateway) {
          await deps.gateway.setRouteCargo(route.id, route.cargo.filter((_, i) => i !== index));
        } else {
          route.cargo = route.cargo.filter((_, i) => i !== index);
        }
        rerender();
      });
      li.appendChild(del);

      if (orderable) {
        li.addEventListener('dragstart', (e) => handleDragStart(e));
        li.addEventListener('dragend', (e) => handleDragEnd(e));
        li.addEventListener('dragover', (e) => handleDragOver(e));
        li.addEventListener('drop', (e) => handleCargoDrop(e, route, rerender));
        li.addEventListener('dragenter', (e) => { e.preventDefault(); li.style.borderColor = 'var(--ri-accent)'; });
        li.addEventListener('dragleave', () => { li.style.borderColor = 'var(--ri-accent-dim)'; });
      }
      ul.appendChild(li);
    });
    container.appendChild(ul);

    // --- add-resource control ---
    const have = new Set(route.cargo.map((e) => e.resourceId));
    const haveAll = route.cargo.some((e) => e.resourceId === 'all');
    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:4px;margin:4px 0 0 16px;align-items:center';
    const addSel = document.createElement('select');
    addSel.style.cssText = 'flex:1 1 auto;background:var(--ri-panel-solid);'
      + 'color:var(--ri-accent);border:1px solid var(--ri-accent-dim);font-size:11px;padding:2px 4px;';
    if (!haveAll) {
      const o = document.createElement('option');
      o.value = 'all';
      o.textContent = '(all other resources)';
      addSel.appendChild(o);
    }
    const remaining = ALL_RESOURCES.filter((r) => !have.has(r));
    if (remaining.length === 0 && haveAll) {
      const o = document.createElement('option');
      o.textContent = '(all resources added)';
      addSel.appendChild(o);
      addSel.disabled = true;
    } else {
      for (const r of remaining) {
        const o = document.createElement('option');
        o.value = r; o.textContent = r;
        addSel.appendChild(o);
      }
    }
    const addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.textContent = '+ add';
    addBtn.style.cssText = 'cursor:pointer;background:var(--ri-panel-solid);'
      + 'color:var(--ri-accent);border:1px solid var(--ri-accent-dim);font-size:11px;'
      + 'padding:2px 8px;border-radius:2px;';
    addBtn.disabled = remaining.length === 0 && haveAll;
    if (addBtn.disabled) addBtn.style.opacity = '0.5';
    addBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const chosen = addSel.value as ResourceId | 'all';
      if (!chosen || (chosen !== 'all' && have.has(chosen))) return;
      if (deps.gateway) {
        await deps.gateway.setRouteCargo(route.id, [...route.cargo, { resourceId: chosen }]);
      } else {
        route.cargo = [...route.cargo, { resourceId: chosen }];
      }
      rerender();
    });
    addRow.appendChild(addSel);
    addRow.appendChild(addBtn);
    container.appendChild(addRow);
  }

  async function handleCargoDrop(e: DragEvent, route: Route, rerender: () => void) {
    e.preventDefault();
    const src = Number(e.dataTransfer?.getData('text/plain'));
    const dstLi = e.currentTarget as HTMLElement;
    const dst = Number(dstLi.dataset.index);
    if (src === dst || Number.isNaN(src) || Number.isNaN(dst)) return;
    if (deps.gateway) {
      await deps.gateway.reorderRouteCargo(route.id, src, dst);
    } else {
      route.cargo = reorderPriorityList(route.cargo, src, dst) as CargoEntry[];
    }
    rerender();
  }

  function handleDragStart(e: DragEvent) {
    isDraggingPriority = true;
    const li = e.currentTarget as HTMLElement;
    li.style.opacity = '0.5';
    e.dataTransfer?.setData('text/plain', li.dataset.index!);
  }

  function handleDragEnd(e: DragEvent) {
    isDraggingPriority = false;
    const li = e.currentTarget as HTMLElement;
    li.style.opacity = '1';
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
  }

  // ---- Stat refresh ----------------------------------------------------------
  function refreshStats(): void {
    routesStat.valueEl.textContent = String(deps.world.routes.length);
    let totalCap = 0;
    let totalFlight = 0;
    for (const r of deps.world.routes) {
      // §2.4 route-floor scaling: aggregate EFFECTIVE capacity (tier base ×
      // the source building's active-floor multiplier), matching the ledger.
      totalCap += r.capacityPerSec * routeFloorMultiplier(r, deps.world);
      totalFlight += r.inFlight.length;
    }
    capStat.valueEl.textContent = `${totalCap.toFixed(2)} u`;
    flightStat.valueEl.textContent = `${totalFlight}`;
    // Funnel: sum funnelPending across all island states (XP-units).
    let totalFunnel = 0;
    for (const s of deps.islandStates.values()) {
      for (const r of ALL_RESOURCES) totalFunnel += s.funnelPending[r] ?? 0;
    }
    funnelStat.valueEl.textContent = `${totalFunnel.toFixed(1)}`;
    funnelStat.valueEl.style.color = totalFunnel > 0 ? 'var(--ri-accent)' : 'var(--ri-fg-1)';
  }

  function paintLayer(nowMs: number): void {
    const draftKey = visible && fromSel.value && toSel.value
      ? `${fromSel.value}|${toSel.value}`
      : '';
    deps.routeRenderer.update(deps.world.routes, nowMs, draftKey, visible);
  }

  // Cache the populated-island id set so buildOptions() only re-runs when the
  // set actually changes. Rebuilding <option> children every frame closes any
  // dropdown the player is mid-interaction with. Today the set is static
  // post-init, but the change-detection guard keeps this honest once
  // settlement (§12) starts mutating populated mid-game.
  // (lastPopulatedKey is declared above the mount-time buildOptions() call.)
  function populatedKey(): string {
    let k = '';
    for (const s of deps.world.islands) if (s.populated) k += s.id + '|';
    return k;
  }

  /** Identity key over the route set — changes when a route is added or
   *  removed (or its source building changes). Used to rebuild the VIA
   *  BUILDING select so a consumed building leaves the list and a freed
   *  one returns. */
  function routesKey(): string {
    let k = '';
    for (const r of deps.world.routes) k += r.id + ':' + (r.sourceBuildingId ?? '') + '|';
    return k;
  }

  /** Signature of the currently-selected FROM island's entire building set.
   *  The VIA BUILDING dropdown must rebuild when a transport building is
   *  placed, demolished, upgraded, or has its active floors changed, even if
   *  the route set itself is unchanged. */
  function viaBuildingsKey(): string {
    return viaBuildingKeyForIsland(deps.islandSpecs.get(fromSel.value));
  }

  // ---- API impl --------------------------------------------------------------
  function refresh(nowMs: number): void {
    const key = populatedKey();
    if (key !== lastPopulatedKey) {
      buildOptions();
      lastPopulatedKey = key;
    }
    const rKey = routesKey();
    const viaKey = viaBuildingsKey();
    if (rKey !== lastRoutesKey || viaKey !== lastViaBuildingsKey) {
      buildBuildingOptions();
      lastRoutesKey = rKey;
      lastViaBuildingsKey = viaKey;
    }
    refreshFormReadout();
    refreshStats();
    repaintLedger(nowMs);
    paintLayer(nowMs);
  }

  function show(): void {
    if (visible) return;
    visible = true;
    panelHandle.setVisible(true);
    refresh(performance.now());
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

  return {
    refresh,
    show,
    hide,
    toggle,
    isVisible: () => visible,
  };
}


