// Settlement Ops side dock — §12 vehicle dispatch UI.
//
// Sibling station to drones-ui (DRONE OPS / DSP-01) and routes-ui (FREIGHT
// GRID / LCS-01): same monospace + cyan console-chrome vocabulary, stamped
// `SETTLE OPS / SCV-01`.
//
// Dispatch flow:
//   1. Player selects origin (must have Shipyard/Helipad), target
//      (discovered, unpopulated), kind, kit count. Fuel is auto-sized to
//      the exact one-way trip cost — no player input.
//   2. Player clicks ARM SETTLE → reticle armed.
//   3. Player clicks on the map within the target island's footprint.
//   4. On click, the nearest discovered+unpopulated island within click
//      distance is resolved and dispatchVehicle runs. Reject reasons
//      surface in the panel's status row.

import { Container, Graphics } from 'pixi.js';

import type { IslandState } from './economy.js';
import { mountPanel, Zone } from './ui-zones.js';
import { inv } from './economy.js';
import { TILE_PX } from './island.js';
import { fuelForTier } from './recipes.js';
import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { findOperationalBuilding, hasOperationalBuilding } from './buildings.js';
import { shapeHeight, shapeWidth } from './shape-mask.js';
import {
  dispatchVehicle,
  hasLaunchBuildingFor,
  HELICOPTER_STATS,
  originCanAnchorSettle,
  settleViaSpacetimeAnchor,
  SHIP_STATS,
  tuningFor,
  vehicleCurrentPosition,
  type SettlementVehicle,
  type VehicleKind,
  type VehicleTier,
} from './settlement.js';
import { tierForLevel } from './skilltree.js';
import { VISION_BLUE, type IslandSpec, type WorldState } from './world.js';

function styled(el: HTMLElement, css: string): void {
  el.style.cssText = css;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export interface SettlementUiHandle {
  refresh(nowMs: number): void;
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
  isLaunchMode(): boolean;
  setLaunchMode(on: boolean): void;
  setReticleScreenPos(x: number, y: number): void;
  hideReticle(): void;
  /** Try to dispatch a settlement vehicle toward a world-tile target. The
   *  caller (main.ts) resolves the click into world-tile coords and passes
   *  them here; we find the matching discovered+unpopulated island within
   *  click tolerance and run dispatchVehicle. */
  attemptLaunch(targetWorldTileX: number, targetWorldTileY: number, nowMs: number): {
    ok: boolean;
    reason?: string;
  };
  /** Container for in-flight settlement-vehicle dots. Add to world. */
  readonly vehicleLayer: Container;
  /** Container for the arm-settle reticle. Add directly to the stage,
   *  not the world container — screen-space, fixed pixel size. */
  readonly reticleLayer: Container;
  /** Container for the max-range ring drawn around the active origin when
   *  launch mode is armed. Add to world (world-tile space so the ring's
   *  distance reading is correct at any zoom). */
  readonly rangeRingLayer: Container;
}

export interface SettlementUiDeps {
  readonly world: WorldState;
  readonly islandStates: Map<string, IslandState>;
  readonly islandSpecs: ReadonlyMap<string, IslandSpec>;
  /** Optional: current active-island id. The FROM selector prefers this
   *  when it appears in the populated list, so the panel opens with the
   *  active island as the dispatch origin by default. */
  getActiveIslandId?(): string;
  screenToWorldTile(screenX: number, screenY: number): { x: number; y: number };
  /** Called when launch mode toggles. main.ts uses this for mutual-exclusion
   *  with drone-launch + placement modes.
   *
   *  Note: arrival side-effects (populating, render-layer rebuild, modifier
   *  cache registration) are NOT funnelled through this callback. They're
   *  driven by `tickVehicles` in the main ticker, which has direct access
   *  to the island-state map + modifier cache. The settlement UI just
   *  refreshes its own ledger each frame; it never originates an arrival. */
  onLaunchModeChanged?(armed: boolean): void;
  /** Called after a successful Spacetime Anchor instant-settle so the host
   *  can rebuild world render layers (a vehicle arrival rebuilds via the
   *  ticker; an instant-settle happens on a click and has no ticker hook). */
  onInstantSettled?: () => void;
}

// Click tolerance (world tiles) when resolving a map click to a target
// island. Generous: any click within ~one ellipse radius commits.
const CLICK_TOLERANCE_TILES = 16;

/** Exact one-way fuel cost to send a vehicle from `origin` to `target`.
 *  Settlement fuel is auto-sized to the trip (mirroring the drone UI) — there
 *  is no upside to over-loading, so the player never picks an amount. */
function computeFuel(
  origin: IslandSpec,
  target: IslandSpec,
  tilesPerFuel: number,
): number {
  if (tilesPerFuel <= 0) return 0;
  const dx = origin.cx - target.cx;
  const dy = origin.cy - target.cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return Math.max(1, Math.ceil(dist / tilesPerFuel));
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------
export function mountSettlementUi(parentEl: HTMLElement, deps: SettlementUiDeps): SettlementUiHandle {
  let visible = false;
  let launchMode = false;
  type DispatchKind = VehicleKind | 'anchor';
  let kind: DispatchKind = 'ship';
  let selectedTier: VehicleTier = 1;
  let fuelLoaded = 0; // auto-computed from origin→target distance in refresh()
  let kitCount = 1;
  let originId: string | null = null;
  let targetId: string | null = null;

  // ---- Panel chrome --------------------------------------------------------
  const panel = document.createElement('div');
  panel.id = 'settlement-panel';
  panel.classList.add('ri-panel');
  styled(
    panel,
    [
      'width: 280px',
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

  // ---- Header --------------------------------------------------------------
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
  stamp.textContent = '▲';
  styled(stamp, `color: ${'var(--ri-accent)'}; font-size: 10px`);
  const headTitle = document.createElement('span');
  headTitle.textContent = 'SETTLE OPS';
  styled(
    headTitle,
    [`color: ${'var(--ri-accent)'}`, 'font-size: 11px', 'font-weight: 600', 'letter-spacing: 0.22em'].join(';'),
  );
  const headSub = document.createElement('span');
  headSub.textContent = 'SCV-01';
  styled(headSub, [`color: ${'var(--ri-fg-3)'}`, 'font-size: 9.5px', 'letter-spacing: 0.16em'].join(';'));
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

  // ---- Body ---------------------------------------------------------------
  const body = document.createElement('div');
  styled(
    body,
    [
      'display: flex',
      'flex-direction: column',
      'gap: 12px',
      'padding: 12px 12px 14px',
      'overflow-y: auto',
      'flex: 1 1 auto',
    ].join(';'),
  );

  // ---- Kind toggle (SHIP / HELI) ------------------------------------------
  const kindRow = document.createElement('div');
  styled(
    kindRow,
    ['display: grid', 'grid-template-columns: 1fr 1fr', 'gap: 6px'].join(';'),
  );
  function kindBtn(label: string, k: DispatchKind): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    styled(
      b,
      [
        'background: var(--ri-elev)',
        `color: ${'var(--ri-fg-1)'}`,
        `border: 1px solid ${'var(--ri-border-strong)'}`,
        'padding: 6px 4px',
        'cursor: pointer',
        'font-family: ui-monospace, monospace',
        'font-size: 10.5px',
        'letter-spacing: 0.18em',
        'font-weight: 600',
        'text-transform: uppercase',
        'transition: background 100ms ease, border-color 100ms ease, color 100ms ease',
      ].join(';'),
    );
    b.addEventListener('click', () => {
      kind = k;
      // Re-clamp tier to valid range for the new kind.
      const originState = originId ? deps.islandStates.get(originId) ?? null : null;
      const maxTier = originState ? tierForLevel(originState.level) : 1;
      const minTier = 1;
      selectedTier = Math.max(minTier, Math.min(selectedTier, maxTier)) as VehicleTier;
      paintKindButtons();
      refresh(performance.now());
      b.blur();
    });
    return b;
  }
  const shipBtn = kindBtn('◗ SHIP', 'ship');
  const heliBtn = kindBtn('✈ HELI', 'helicopter');
  const anchorBtn = kindBtn('⧗ ANCHOR', 'anchor');
  function paintKindButtons(): void {
    const entries: ReadonlyArray<readonly [HTMLButtonElement, DispatchKind]> = [
      [shipBtn, 'ship'],
      [heliBtn, 'helicopter'],
      [anchorBtn, 'anchor'],
    ];
    for (const [btn, k] of entries) {
      if (kind === k) {
        btn.style.color = 'var(--ri-accent)';
        btn.style.borderColor = 'var(--ri-accent-dim)';
        btn.style.background = 'rgba(125, 211, 232, 0.08)';
      } else {
        btn.style.color = 'var(--ri-fg-3)';
        btn.style.borderColor = 'var(--ri-border-strong)';
        btn.style.background = 'var(--ri-elev)';
      }
    }
  }
  paintKindButtons();
  kindRow.appendChild(shipBtn);
  kindRow.appendChild(heliBtn);
  kindRow.appendChild(anchorBtn);
  body.appendChild(kindRow);

  // ---- Origin / target selectors ------------------------------------------
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
  fromSel.addEventListener('change', () => {
    originId = fromSel.value || null;
    refresh(performance.now());
  });
  body.appendChild(fromRow);

  // Prompt shown when no target has been picked via reticle click yet.
  const targetPrompt = document.createElement('div');
  styled(
    targetPrompt,
    [
      `color: ${'var(--ri-fg-3)'}`,
      'font-size: 10px',
      'letter-spacing: 0.06em',
      'font-style: italic',
      'padding: 4px 2px',
    ].join(';'),
  );
  targetPrompt.textContent = 'Arm settle, then click a target island';
  body.appendChild(targetPrompt);

  // ---- Stat block (TIER / RANGE / FUEL / ETA) -----------------------------
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
  const tierStat = statRow('TIER');
  const tierSelect = document.createElement('select');
  tierSelect.style.cssText = [
    'background: var(--ri-elev)',
    'color: var(--ri-accent)',
    'border: 1px solid var(--ri-border)',
    'font: inherit',
    'font-size: 11px',
    'padding: 1px 4px',
    'cursor: pointer',
    'border-radius: 3px',
  ].join(';');
  for (let t = 1; t <= 6; t++) {
    const opt = document.createElement('option');
    opt.value = String(t);
    opt.textContent = `T${t}`;
    tierSelect.appendChild(opt);
  }
  tierSelect.addEventListener('change', () => {
    selectedTier = Number(tierSelect.value) as VehicleTier;
    refresh(performance.now());
  });
  tierStat.valueEl.appendChild(tierSelect);

  const distStat = statRow('DIST');
  const fuelStat = statRow('FUEL');
  const fuelStatLabelEl = fuelStat.row.firstChild as HTMLSpanElement;
  const etaStat = statRow('ETA');
  fuelStat.valueEl.style.color = 'var(--ri-warn)';
  statBlock.appendChild(tierStat.row);
  statBlock.appendChild(distStat.row);
  statBlock.appendChild(fuelStat.row);
  statBlock.appendChild(etaStat.row);
  body.appendChild(statBlock);

  // ---- Fuel — auto-computed, no slider ------------------------------------
  // Fuel load is the exact one-way trip cost (see `computeFuel` / refresh),
  // surfaced read-only in the FUEL stat above.

  // ---- Kit count slider ---------------------------------------------------
  const kitWrap = document.createElement('div');
  styled(kitWrap, 'display: flex; flex-direction: column; gap: 4px');
  const kitHead = document.createElement('div');
  styled(kitHead, 'display: flex; justify-content: space-between; align-items: baseline');
  const kitHeadL = document.createElement('span');
  kitHeadL.textContent = 'FOUNDATION KITS';
  styled(
    kitHeadL,
    [`color: ${'var(--ri-fg-3)'}`, 'font-size: 9.5px', 'letter-spacing: 0.12em'].join(';'),
  );
  const kitHeadR = document.createElement('span');
  styled(kitHeadR, `color: ${'var(--ri-accent)'}; font-size: 11px; font-weight: 600`);
  kitHead.appendChild(kitHeadL);
  kitHead.appendChild(kitHeadR);
  const kitSlider = document.createElement('input');
  kitSlider.type = 'range';
  kitSlider.min = '1';
  kitSlider.max = '3';
  kitSlider.step = '1';
  kitSlider.value = String(kitCount);
  styled(
    kitSlider,
    [
      'width: 100%',
      'height: 18px',
      'background: transparent',
      'cursor: pointer',
      'accent-color: var(--ri-accent)',
    ].join(';'),
  );
  kitSlider.addEventListener('input', () => {
    kitCount = Number(kitSlider.value);
    refresh(performance.now());
  });
  kitWrap.appendChild(kitHead);
  kitWrap.appendChild(kitSlider);
  body.appendChild(kitWrap);

  // ---- Status row (validation feedback) -----------------------------------
  const statusEl = document.createElement('div');
  styled(
    statusEl,
    [
      `color: ${'var(--ri-fg-3)'}`,
      'font-size: 10px',
      'letter-spacing: 0.06em',
      'min-height: 14px',
      'padding: 0 2px',
    ].join(';'),
  );
  body.appendChild(statusEl);

  // ---- Arm-settle button --------------------------------------------------
  const armBtn = document.createElement('button');
  styled(
    armBtn,
    [
      'background: var(--ri-elev)',
      `color: ${'var(--ri-fg-1)'}`,
      `border: 1px solid ${'var(--ri-border-strong)'}`,
      'padding: 8px 12px',
      'cursor: pointer',
      'font-family: ui-monospace, monospace',
      'font-size: 11px',
      'letter-spacing: 0.2em',
      'text-transform: uppercase',
      'font-weight: 600',
      'transition: background 100ms ease, border-color 100ms ease, color 100ms ease',
    ].join(';'),
  );
  armBtn.textContent = '◇ ARM SETTLE';
  armBtn.addEventListener('click', () => {
    setLaunchMode(!launchMode);
    armBtn.blur();
  });
  body.appendChild(armBtn);

  function setLaunchMode(on: boolean): void {
    if (launchMode === on) return;
    launchMode = on;
    if (on) {
      armBtn.textContent = '◆ DISARM';
      armBtn.style.color = 'var(--ri-warn)';
      armBtn.style.borderColor = 'var(--ri-warn)';
      armBtn.style.background = 'rgba(245, 167, 66, 0.08)';
      reticleLayer.visible = true;
      repaintRangeRing();
      rangeRingLayer.visible = true;
    } else {
      armBtn.textContent = '◇ ARM SETTLE';
      armBtn.style.color = 'var(--ri-fg-1)';
      armBtn.style.borderColor = 'var(--ri-border-strong)';
      armBtn.style.background = 'var(--ri-elev)';
      reticleLayer.visible = false;
      rangeRingLayer.visible = false;
    }
    deps.onLaunchModeChanged?.(on);
  }

  // ---- Active vehicles ledger ---------------------------------------------
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
  ledgerL.textContent = 'EN ROUTE';
  styled(
    ledgerL,
    [`color: ${'var(--ri-accent)'}`, 'font-size: 10px', 'font-weight: 600', 'letter-spacing: 0.18em'].join(';'),
  );
  const ledgerR = document.createElement('span');
  styled(ledgerR, `color: ${'var(--ri-fg-3)'}; font-size: 9.5px; letter-spacing: 0.08em`);
  ledgerHead.appendChild(ledgerL);
  ledgerHead.appendChild(ledgerR);
  const ledgerList = document.createElement('div');
  styled(ledgerList, 'display: flex; flex-direction: column; gap: 4px; min-height: 24px');
  const ledgerEmpty = document.createElement('div');
  ledgerEmpty.textContent = 'no vehicles en route';
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
  ledgerWrap.appendChild(ledgerList);
  body.appendChild(ledgerWrap);

  // ---- Footer -------------------------------------------------------------
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
  footer.textContent = 'arm, then click target island';

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);
  parentEl.appendChild(panel);

  const panelHandle = mountPanel(panel, {
    id: 'settlement-panel',
    zone: Zone.R,
    order: 2,
  });
  panelHandle.setVisible(false);

  // ---- Range ring (world space, around launch origin) ---------------------
  const rangeRingLayer = new Container();
  rangeRingLayer.label = 'settle-range-ring';
  rangeRingLayer.visible = false;
  const rangeRingGfx = new Graphics();
  rangeRingLayer.addChild(rangeRingGfx);

  function launchBuildingCentre(
    spec: IslandSpec,
    kind: VehicleKind,
  ): { x: number; y: number } | null {
    const defId = kind === 'ship' ? 'shipyard' : 'helipad';
    const b = findOperationalBuilding(spec.buildings, defId);
    if (!b) return null;
    const def = BUILDING_DEFS[defId as BuildingDefId];
    return {
      x: spec.cx + b.x + shapeWidth(def.footprint) / 2,
      y: spec.cy + b.y + shapeHeight(def.footprint) / 2,
    };
  }

  function repaintRangeRing(): void {
    rangeRingGfx.clear();
    if (kind === 'anchor') return;
    const originSpec = originId ? deps.islandSpecs.get(originId) ?? null : null;
    if (!originSpec) return;
    const originState = deps.islandStates.get(originSpec.id);
    if (!originState) return;
    const t = tuningFor(kind, selectedTier);
    const fuelResource = fuelForTier(selectedTier);
    const onhand = inv(originState, fuelResource);
    if (onhand <= 0) return;
    const maxRangeTiles = onhand * t.tilesPerFuel;
    if (maxRangeTiles <= 0) return;
    const radiusPx = maxRangeTiles * TILE_PX;
    const centre = launchBuildingCentre(originSpec, kind);
    const cx = (centre?.x ?? originSpec.cx) * TILE_PX;
    const cy = (centre?.y ?? originSpec.cy) * TILE_PX;
    rangeRingGfx.circle(cx, cy, radiusPx).fill({ color: VISION_BLUE, alpha: 0.05 });
    rangeRingGfx.circle(cx, cy, radiusPx).stroke({ width: 2, color: VISION_BLUE, alpha: 0.55 });
    const cross = TILE_PX;
    rangeRingGfx.moveTo(cx - cross, cy).lineTo(cx + cross, cy)
      .stroke({ width: 1, color: VISION_BLUE, alpha: 0.5 });
    rangeRingGfx.moveTo(cx, cy - cross).lineTo(cx, cy + cross)
      .stroke({ width: 1, color: VISION_BLUE, alpha: 0.5 });
  }

  // ---- In-flight vehicle dots (world space) -------------------------------
  const vehicleLayer = new Container();
  vehicleLayer.label = 'vehicles';

  function renderVehicleDot(v: SettlementVehicle, nowMs: number): Container {
    const c = new Container();
    c.label = `vehicle:${v.id}`;
    const pos = vehicleCurrentPosition(v, deps.world, nowMs);
    if (!pos) return c;
    const wpx = pos.x * TILE_PX;
    const wpy = pos.y * TILE_PX;
    // Heading: vehicles fly straight-line from origin to target, so the
    // heading is constant per vehicle and computable from the spec
    // endpoints. (Vehicle storage doesn't carry dirX/dirY like Drone.)
    const from = deps.world.islands.find((s) => s.id === v.from);
    const to = deps.world.islands.find((s) => s.id === v.target);
    const dx = to && from ? to.cx - from.cx : 1;
    const dy = to && from ? to.cy - from.cy : 0;
    const ang = Math.atan2(dy, dx);
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const rot = (lx: number, ly: number): [number, number] => [
      wpx + lx * cos - ly * sin,
      wpy + lx * sin + ly * cos,
    ];
    const g = new Graphics();

    // Halo behind every vehicle marker — sells the "I am a unit" affordance
    // even when the body is small relative to a zoomed-out view. Slightly
    // bigger than the drone halo since vehicles carry weight.
    g.circle(wpx, wpy, 11).fill({ color: VISION_BLUE, alpha: 0.18 });

    if (v.kind === 'ship') {
      // Ship: chevron pointing along heading. Two angled lines forming a
      // wedge + a center pip for the bow.
      const L = 14;
      const w = 8;
      const tip = rot(L * 0.55, 0);
      const stern = rot(-L * 0.45, 0);
      const left = rot(-L * 0.1, -w / 2);
      const right = rot(-L * 0.1, w / 2);
      // Body — filled wedge (tip, left flare, stern, right flare).
      g.poly([tip[0], tip[1], left[0], left[1], stern[0], stern[1], right[0], right[1]])
        .fill({ color: VISION_BLUE, alpha: 0.9 })
        .stroke({ width: 1, color: 0xffffff, alpha: 0.7 });
    } else {
      // Helicopter: rotor-disk (circle) + a small chevron showing heading.
      // The disk reads as "spinning rotor" which is visually distinct from
      // the ship's tapered wedge.
      g.circle(wpx, wpy, 6).fill({ color: VISION_BLUE, alpha: 0.55 });
      g.circle(wpx, wpy, 6).stroke({ width: 1, color: 0xffffff, alpha: 0.7 });
      // Small heading wedge on top of the disk so direction is readable.
      const tip = rot(7, 0);
      const baseL = rot(-2, -3);
      const baseR = rot(-2, 3);
      g.poly([tip[0], tip[1], baseL[0], baseL[1], baseR[0], baseR[1]])
        .fill({ color: 0xffffff, alpha: 0.9 });
    }
    c.addChild(g);
    return c;
  }
  function repaintVehicleLayer(nowMs: number): void {
    for (const c of vehicleLayer.removeChildren()) c.destroy(true);
    for (const v of deps.world.vehicles) {
      if (v.status === 'lost' || v.status === 'arrived') continue;
      vehicleLayer.addChild(renderVehicleDot(v, nowMs));
    }
  }

  // ---- Arm-settle reticle (screen space) ----------------------------------
  const reticleLayer = new Container();
  reticleLayer.label = 'settle-reticle';
  reticleLayer.visible = false;
  const reticleGfx = new Graphics();
  function paintReticle(color: number): void {
    reticleGfx.clear();
    // Hexagon-style settle reticle to differentiate from drone-launch crosshair.
    const sides = 6;
    const r1 = 14;
    const r2 = 6;
    const pts1: number[] = [];
    const pts2: number[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 - Math.PI / 2;
      pts1.push(Math.cos(a) * r1, Math.sin(a) * r1);
      pts2.push(Math.cos(a) * r2, Math.sin(a) * r2);
    }
    reticleGfx.poly(pts1).stroke({ width: 2, color, alpha: 0.85 });
    reticleGfx.poly(pts2).stroke({ width: 1, color, alpha: 0.7 });
    reticleGfx.rect(-1, -1, 2, 2).fill({ color, alpha: 0.9 });
  }
  const RETICLE_OK = VISION_BLUE;
  const RETICLE_WARN = 0xf5a742;
  let reticlePainted = -1;
  function ensurePainted(color: number): void {
    if (reticlePainted === color) return;
    reticlePainted = color;
    paintReticle(color);
  }
  ensurePainted(RETICLE_OK);
  reticleLayer.addChild(reticleGfx);

  function setReticleScreenPos(x: number, y: number): void {
    if (!launchMode) return;
    reticleGfx.position.set(x, y);
    // Colour cue: cyan when the cursor is within range of a discovered+
    // unpopulated target, amber otherwise. Cheap nearest-discovered lookup.
    const wp = deps.screenToWorldTile(x, y);
    const near = nearestDiscoveredUnpopulated(wp.x, wp.y);
    const okColor = near !== null ? RETICLE_OK : RETICLE_WARN;
    ensurePainted(okColor);
  }
  function hideReticleFn(): void {
    reticleGfx.position.set(-9999, -9999);
  }

  function nearestDiscoveredUnpopulated(wx: number, wy: number): IslandSpec | null {
    let best: IslandSpec | null = null;
    let bestSq = CLICK_TOLERANCE_TILES * CLICK_TOLERANCE_TILES;
    for (const s of deps.world.islands) {
      if (!s.discovered) continue;
      if (s.populated) continue;
      const dx = wx - s.cx;
      const dy = wy - s.cy;
      const dSq = dx * dx + dy * dy;
      if (dSq <= bestSq) {
        bestSq = dSq;
        best = s;
      }
    }
    return best;
  }

  /** Show only the dispatch kinds the current origin can launch:
   *  SHIP needs a Shipyard, HELI a Helipad, ANCHOR a Spacetime Anchor.
   *  If the current `kind` is no longer available, fall back to the first
   *  available kind. */
  function refreshKindButtons(): void {
    const originSpec = originId ? deps.islandSpecs.get(originId) ?? null : null;
    const canShip = originSpec ? hasLaunchBuildingFor(originSpec, 'ship') : false;
    const canHeli = originSpec ? hasLaunchBuildingFor(originSpec, 'helicopter') : false;
    const canAnchor = originSpec ? originCanAnchorSettle(originSpec) : false;
    shipBtn.style.display = canShip ? '' : 'none';
    heliBtn.style.display = canHeli ? '' : 'none';
    anchorBtn.style.display = canAnchor ? '' : 'none';
    const available: DispatchKind[] = [
      ...(canShip ? ['ship' as const] : []),
      ...(canHeli ? ['helicopter' as const] : []),
      ...(canAnchor ? ['anchor' as const] : []),
    ];
    if (!available.includes(kind)) {
      kind = available[0] ?? 'ship';
    }
    // Repaint the selected-kind highlight — the kind may have just flipped
    // (or its button hidden) and paintKindButtons doesn't otherwise re-run.
    paintKindButtons();
  }

  // ---- Origin selector option building ------------------------------------
  function rebuildSelectors(): void {
    const populated: IslandSpec[] = [];
    for (const s of deps.world.islands) {
      if (s.populated) populated.push(s);
    }
    // Origin: only populated islands (which have IslandState + can hold
    // foundation_kit + fuel inventory).
    const prevFrom = fromSel.value;
    fromSel.replaceChildren();
    for (const isl of populated) {
      const o = document.createElement('option');
      o.value = isl.id;
      o.textContent = isl.name;
      fromSel.appendChild(o);
    }
    const activeId = deps.getActiveIslandId?.();
    const activeIsPopulated =
      activeId !== undefined && populated.some((s) => s.id === activeId);
    if (prevFrom && populated.some((s) => s.id === prevFrom)) {
      fromSel.value = prevFrom;
    } else if (activeIsPopulated && activeId !== undefined) {
      fromSel.value = activeId;
    } else if (populated.length > 0) {
      fromSel.value = populated[0]!.id;
    }
    originId = fromSel.value || null;
  }
  rebuildSelectors();
  refreshKindButtons();

  // ---- Stat / status / button refresh -------------------------------------
  let lastSelectorSig = '';
  function selectorSig(): string {
    let k = '';
    for (const s of deps.world.islands) {
      if (s.populated) k += s.id + '=' + s.name + '|';
    }
    return k;
  }

  function refresh(_nowMs: number): void {
    const sig = selectorSig();
    if (sig !== lastSelectorSig) {
      lastSelectorSig = sig;
      rebuildSelectors();
    }
    refreshKindButtons();
    const isAnchor = kind === 'anchor';

    const originSpec = originId ? deps.islandSpecs.get(originId) ?? null : null;
    const originState = originSpec ? deps.islandStates.get(originSpec.id) ?? null : null;
    const targetSpec = targetId ? deps.islandSpecs.get(targetId) ?? null : null;

    // Clamp selectedTier to the valid range for current origin + kind.
    const originTier = originState ? tierForLevel(originState.level) : 1;
    const minTier: VehicleTier = 1;
    if (selectedTier > originTier) selectedTier = originTier as VehicleTier;
    if (selectedTier < minTier) selectedTier = minTier;

    // Sync tier select options: disable out-of-range, sync current value.
    for (let i = 0; i < tierSelect.options.length; i++) {
      const opt = tierSelect.options[i];
      if (!opt) continue;
      const tierNum = Number(opt.value);
      opt.disabled = tierNum < minTier || tierNum > originTier;
    }
    if (Number(tierSelect.value) !== selectedTier) {
      tierSelect.value = String(selectedTier);
    }

    // Dynamic fuel label follows the player-selected tier (mirrors drone UI).
    const fuelResource = fuelForTier(selectedTier);
    fuelStatLabelEl.textContent = fuelResource.toUpperCase().replace(/_/g, ' ');

    fuelStat.row.style.display = isAnchor ? 'none' : '';
    rangeRingLayer.visible = launchMode && !isAnchor;
    // Anchor settles consume exactly one Refined kit — the 1..N kit slider
    // is meaningless (and labels the wrong resource) in anchor mode.
    kitWrap.style.display = isAnchor ? 'none' : '';

    let dist = 0;
    if (originSpec && targetSpec) {
      const dx = originSpec.cx - targetSpec.cx;
      const dy = originSpec.cy - targetSpec.cy;
      dist = Math.sqrt(dx * dx + dy * dy);
    }
    if (kind !== 'anchor') {
      const t = tuningFor(kind, selectedTier);
      // Auto-compute fuel: the exact one-way cost to reach the selected target.
      fuelLoaded = originSpec && targetSpec ? computeFuel(originSpec, targetSpec, t.tilesPerFuel) : 0;
      const eta = t.speed > 0 ? dist / t.speed : 0;
      distStat.valueEl.textContent = targetSpec ? `${dist.toFixed(0)} t` : '— t';
      fuelStat.valueEl.textContent = targetSpec ? `${fuelLoaded} u` : '— u';
      etaStat.valueEl.textContent = targetSpec ? `${eta.toFixed(0)}s` : '—';
    } else {
      fuelLoaded = 0;
      distStat.valueEl.textContent = targetSpec ? `${dist.toFixed(0)} t` : '— t';
      fuelStat.valueEl.textContent = '— u';
      etaStat.valueEl.textContent = targetSpec ? 'instant' : '—';
    }

    // Show/hide the target prompt and the stat block detail rows.
    targetPrompt.style.display = targetSpec ? 'none' : 'block';
    statBlock.style.opacity = targetSpec ? '1' : '0.5';

    // Cap kit count to the selected tier's maxKits and update slider.
    const maxKits = kind === 'ship'
      ? SHIP_STATS[selectedTier].maxKits
      : HELICOPTER_STATS[selectedTier].maxKits;
    if (kitCount > maxKits) kitCount = maxKits;
    kitSlider.max = String(maxKits);
    if (Number(kitSlider.value) !== kitCount) kitSlider.value = String(kitCount);
    kitHeadR.textContent = `${kitCount}`;

    // ARM gating depends ONLY on origin validity — see `armBlockReason`.
    // Dispatch-time checks (target, fuel, kits, in-flight) run when the
    // player clicks a target and are surfaced by `attemptLaunch`.
    const reason = armBlockReason(originSpec, originState);
    if (reason) {
      statusEl.textContent = reason;
      statusEl.style.color = 'var(--ri-danger)';
      armBtn.disabled = true;
      armBtn.style.opacity = '0.5';
      armBtn.style.cursor = 'not-allowed';
      if (launchMode) setLaunchMode(false);
    } else {
      statusEl.textContent = launchMode
        ? 'click a target island on the map'
        : 'ready · arm settle, then click a target';
      statusEl.style.color = 'var(--ri-fg-3)';
      armBtn.disabled = false;
      armBtn.style.opacity = '1';
      armBtn.style.cursor = 'pointer';
    }
    repaintLedger();
    repaintVehicleLayer(performance.now());
  }

  /** Reason the ARM SETTLE button must stay disabled. Gates on ORIGIN
   *  validity ONLY. The target is chosen by arming and then clicking the
   *  map, so requiring a target here would deadlock the panel (can't arm
   *  without a target, can't pick a target without arming). Target / fuel /
   *  kit / in-flight validation runs at click time inside `dispatchVehicle`
   *  and is surfaced through `attemptLaunch`. */
  function armBlockReason(
    originSpec: IslandSpec | null,
    originState: IslandState | null,
  ): string | null {
    if (!originSpec) return 'no populated origin';
    const required = kind === 'ship' ? 'shipyard' : kind === 'helicopter' ? 'helipad' : 'spacetime_anchor';
    if (!hasOperationalBuilding(originSpec.buildings, required)) {
      return `origin missing ${required}`;
    }
    if (!originState) return 'origin state missing';

    return null;
  }

  function repaintLedger(): void {
    ledgerList.replaceChildren();
    const active = deps.world.vehicles.filter(
      (v) => v.status !== 'lost' && v.status !== 'arrived',
    );
    if (active.length === 0) {
      ledgerList.appendChild(ledgerEmpty);
      ledgerR.textContent = '0';
      return;
    }
    ledgerR.textContent = `${active.length}`;
    for (const v of active) {
      ledgerList.appendChild(renderLedgerRow(v));
    }
  }
  function renderLedgerRow(v: SettlementVehicle): HTMLDivElement {
    const row = document.createElement('div');
    styled(
      row,
      [
        'display: flex',
        'flex-direction: column',
        'gap: 2px',
        'padding: 4px 6px',
        `border-left: 2px solid ${'var(--ri-accent-dim)'}`,
        `background: rgba(125, 211, 232, 0.04)`,
      ].join(';'),
    );
    const top = document.createElement('div');
    styled(top, 'display: flex; justify-content: space-between; align-items: baseline');
    const idEl = document.createElement('span');
    idEl.textContent = `${v.kind === 'ship' ? '◗' : '✈'} ${v.id.toUpperCase()}`;
    styled(idEl, `color: ${'var(--ri-accent)'}; font-size: 10px; letter-spacing: 0.08em; font-weight: 600`);
    const etaEl = document.createElement('span');
    etaEl.classList.add('ri-mono');
    const remainSec = Math.max(0, (v.expectedArrivalTime - performance.now()) / 1000);
    etaEl.textContent = `T-${remainSec.toFixed(1)}s`;
    styled(etaEl, `color: ${'var(--ri-warn)'}; font-size: 10px; font-weight: 600`);
    top.appendChild(idEl);
    top.appendChild(etaEl);
    const totalMs = v.expectedArrivalTime - v.launchTime;
    const elapsedMs = Math.max(0, Math.min(totalMs, performance.now() - v.launchTime));
    const pct = totalMs > 0 ? elapsedMs / totalMs : 0;
    const ruleWrap = document.createElement('div');
    styled(ruleWrap, ['height: 2px', `background: ${'var(--ri-border)'}`, 'position: relative'].join(';'));
    const ruleFill = document.createElement('div');
    styled(
      ruleFill,
      [
        'position: absolute',
        'top: 0',
        'left: 0',
        'height: 100%',
        `background: ${'var(--ri-warn)'}`,
        `width: ${(pct * 100).toFixed(2)}%`,
      ].join(';'),
    );
    ruleWrap.appendChild(ruleFill);
    const meta = document.createElement('div');
    styled(meta, 'display: flex; justify-content: space-between');
    const metaL = document.createElement('span');
    metaL.textContent = `${v.from} → ${v.target}`;
    styled(metaL, `color: ${'var(--ri-fg-3)'}; font-size: 9.5px`);
    const metaR = document.createElement('span');
    metaR.textContent = `${v.fuelLoaded} fuel · ${v.foundationKitCount} kit${
      v.foundationKitCount > 1 ? 's' : ''
    } · T${v.tier}`;
    styled(metaR, `color: ${'var(--ri-fg-3)'}; font-size: 9.5px`);
    meta.appendChild(metaL);
    meta.appendChild(metaR);
    row.appendChild(top);
    row.appendChild(ruleWrap);
    row.appendChild(meta);
    return row;
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
    if (launchMode) setLaunchMode(false);
  }
  function toggle(): boolean {
    if (visible) hide();
    else show();
    return visible;
  }

  function attemptLaunch(
    worldTileX: number,
    worldTileY: number,
    nowMs: number,
  ): { ok: boolean; reason?: string } {
    const originSpec = originId ? deps.islandSpecs.get(originId) ?? null : null;
    if (!originSpec) return { ok: false, reason: 'no origin' };
    const originState = deps.islandStates.get(originSpec.id);
    if (!originState) return { ok: false, reason: 'origin state missing' };
    // Click resolution: prefer the explicitly-selected target if the click
    // is anywhere near it; otherwise pick the nearest discovered+unpopulated
    // island within tolerance.
    let targetSpec: IslandSpec | null = null;
    if (targetId) {
      const sel = deps.islandSpecs.get(targetId) ?? null;
      if (sel) {
        const dx = worldTileX - sel.cx;
        const dy = worldTileY - sel.cy;
        if (dx * dx + dy * dy <= CLICK_TOLERANCE_TILES * CLICK_TOLERANCE_TILES) {
          targetSpec = sel;
        }
      }
    }
    if (!targetSpec) targetSpec = nearestDiscoveredUnpopulated(worldTileX, worldTileY);
    if (!targetSpec) return { ok: false, reason: 'no target near click' };
    targetId = targetSpec.id;
    if (kind === 'anchor') {
      if (!originId) return { ok: false, reason: 'no origin' };
      const res = settleViaSpacetimeAnchor(deps.world, deps.islandStates, originId, targetId, nowMs);
      if (res.ok) {
        deps.onInstantSettled?.();
        setLaunchMode(false);
        refresh(nowMs);
        return { ok: true };
      } else {
        statusEl.textContent = `rejected: ${res.reason}`;
        statusEl.style.color = 'var(--ri-danger)';
        return { ok: false, reason: res.reason };
      }
    }
    // Fuel for the ACTUALLY-resolved target — the click may land on a
    // different island than the dropdown selection, so compute it here at
    // click time rather than trusting the refresh()-time preview.
    const launchFuel = computeFuel(originSpec, targetSpec, tuningFor(kind, selectedTier).tilesPerFuel);
    const r = dispatchVehicle(
      deps.world,
      originSpec,
      originState,
      targetSpec,
      kind,
      selectedTier,
      launchFuel,
      kitCount,
      nowMs,
    );
    if (r.ok) {
      setLaunchMode(false);
      refresh(nowMs);
      return { ok: true };
    }
    statusEl.textContent = `rejected: ${r.reason}`;
    statusEl.style.color = 'var(--ri-danger)';
    return { ok: false, reason: r.reason };
  }

  return {
    refresh,
    show,
    hide,
    toggle,
    isVisible: () => visible,
    isLaunchMode: () => launchMode,
    setLaunchMode,
    setReticleScreenPos,
    hideReticle: hideReticleFn,
    attemptLaunch,
    vehicleLayer,
    reticleLayer,
    rangeRingLayer,
  };
}
