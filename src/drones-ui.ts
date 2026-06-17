// Drone-ops side dock + canvas reticle + in-flight visuals.
//
// Aesthetic — narrow anchored sidebar reading as a console plate alongside the
// HUD and skill-tree panels; same monospace + cyan accent palette so the two
// feel like stations on one console. All DOM is plain inline-styled elements,
// no framework.

import { Container, Graphics } from 'pixi.js';

import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { hasOperationalBuilding, isOperationalBuilding, type PlacedBuilding } from './buildings.js';
import type { IslandState } from './economy.js';
import { mountPanel, Zone } from './ui-zones.js';
import { inv } from './economy.js';
import {
  DRONE_SPEED_TILES_PER_SEC,
  DRONE_T5_EFFICIENCY,
  DRONE_T5_SPEED_TILES_PER_SEC,
  DRONE_TIER_EFFICIENCY,
  MAX_FUEL_PER_DRONE,
  T4_PULSE_FUEL_COST,
  dispatchDrone,
  droneCurrentPosition,
  firePulse,
  type Drone,
  type DroneTier,
} from './drones.js';
import {
  totalPathTiles,
  wouldExceedRange,
  fuelForPath,
  popTrailingDuplicate,
} from './drones-ui-helpers.js';
import { TILE_PX } from './island.js';
import { fuelForTier } from './recipes.js';
import { activeFloors } from './floor-levels.js';
import { shapeHeight, shapeWidth } from './shape-mask.js';
import { effectiveSkillMultipliers, tierForLevel } from './skilltree.js';
import { tileToWorldPx, VISION_BLUE, type IslandSpec, type WorldState } from './world.js';
import { type MutationGateway } from './mutation-gateway.js';

/** Filter a buildings array to operational Drone Pads only.
 *  Extracted to DRY the repeated `b.defId === 'dronepad' && isOperationalBuilding(b)` predicate. */
function operationalDronepads(buildings: ReadonlyArray<PlacedBuilding>): PlacedBuilding[] {
  return buildings.filter((b) => b.defId === 'dronepad' && isOperationalBuilding(b));
}

/** Resolve the Drone Pad's footprint centre on the launching island.
 *  §11.1: drone launches originate from the Drone Pad's footprint centre,
 *  NOT the island geometric centre. Returns null when no Drone Pad is
 *  placed (callers fall back to the island centre). When multiple Drone
 *  Pads exist on one island the first in placement order is used — same
 *  deterministic policy `dispatchDrone` applies for its fallback spawn. */
export function selectedPadCentre(
  spec: IslandSpec,
  state: IslandState,
  padId: string | null,
): { x: number; y: number } | null {
  const ops = operationalDronepads(state.buildings);
  if (ops.length === 0) return null;
  const pad = ops.find((b) => b.id === padId) ?? ops[0]!;
  const def = BUILDING_DEFS[pad.defId as BuildingDefId];
  return {
    x: spec.cx + pad.x + shapeWidth(def.footprint) / 2,
    y: spec.cy + pad.y + shapeHeight(def.footprint) / 2,
  };
}

// Legacy entry point — keeps drones.test.ts:472-488 green.
export function dronePadCentre(
  spec: IslandSpec, state: IslandState,
): { x: number; y: number } | null {
  return selectedPadCentre(spec, state, null);
}

function styled(el: HTMLElement, css: string): void {
  el.style.cssText = css;
}

export interface DroneUiHandle {
  /** Refresh the panel + the reticle/dot layers. Called every frame from
   *  the main ticker while drones may be in flight (cheap when launch mode
   *  is off — just updates ledger countdowns). */
  refresh(nowMs: number): void;
  show(): void;
  hide(): void;
  toggle(): boolean;
  isVisible(): boolean;
  /** Whether launch mode is currently armed. The canvas mousedown handler
   *  reads this to disambiguate launch-clicks from pan-clicks. */
  isLaunchMode(): boolean;
  /** Force launch mode on/off externally. Used by main.ts to enforce
   *  mode mutual-exclusion when placement mode is entered. */
  setLaunchMode(on: boolean): void;
  /** Update the reticle's screen position (canvas mousemove). No-op when
   *  not in launch mode. */
  setReticleScreenPos(x: number, y: number): void;
  /** Hide the reticle (canvas mouseleave). */
  hideReticle(): void;
  /** Try to launch a drone toward a world-tile target. Called by the canvas
   *  click-disambiguation logic in main.ts on a small click in launch mode.
   *  Returns the dispatch result so main.ts can show a brief on-screen
   *  feedback if rejected. */
  attemptLaunch(targetWorldTileX: number, targetWorldTileY: number, nowMs: number): {
    ok: boolean;
    reason?: string;
  };
  /** Pop the last waypoint in path mode (no-op otherwise). Called from
   *  main.ts on canvas contextmenu when launch mode is armed + tier is path. */
  popWaypoint(): void;
  /** Finalize the path and dispatch (no-op outside path mode). Called from
   *  main.ts on canvas dblclick when launch mode is armed. */
  finalizePath(nowMs: number): { ok: boolean; reason?: string };
  /** Cancel an in-progress path and disarm (Esc binding). */
  cancelPath(): void;
  /** Container for in-flight drone dots + breadcrumb trails. Add to world. */
  readonly droneLayer: Container;
  /** Container for the launch reticle (lives in screen space, not world).
   *  Add directly to the stage, not the world container — it shouldn't
   *  pan/zoom with the camera. */
  readonly reticleLayer: Container;
  /** Container for the max-range ring drawn around the active origin when
   *  launch mode is armed. Add to world (it's in world-tile space so the
   *  ring's distance reading is correct at any zoom). Visibility is
   *  managed internally by setLaunchMode and the fuel slider. */
  readonly rangeRingLayer: Container;
  /** Container for the launch-preview line/polyline. Add to world (it's
   *  in world-tile space so the green/red trajectory hint stays correct
   *  at any zoom). Visibility managed internally by setLaunchMode. */
  readonly launchPreviewLayer: Container;
  /** Container for the selected-pad highlight outline. Add to world (world-tile
   *  space so it pans/zooms with the camera). Visibility managed internally by
   *  refresh(). */
  readonly selectedPadHighlightLayer: Container;
}

/** All the bits the UI needs handed in. The main module wires this once at
 *  bootstrap; the dock doesn't otherwise know about cameras or screens. */
export interface DroneUiDeps {
  /** Mutation gateway — optional so tests can keep wiring only the fields
   *  they already have. */
  gateway?: MutationGateway;
  /** The world state — drones list and islands. */
  readonly world: WorldState;
  /** Active-island state getter. Drone-launch origin is the currently
   *  active island; switching active retargets the panel without re-mount. */
  getOrigin(): IslandState;
  /** Active-island spec getter (origin coords + dronepad presence). */
  getOriginSpec(): IslandSpec;
  /** Convert a screen-pixel point to a world-tile point (fed by main.ts
   *  using the camera). */
  screenToWorldTile(screenX: number, screenY: number): { x: number; y: number };
  /** Call when discovery or fleet state changed enough that the ocean +
   *  island layers should be rebuilt. main.ts owns the rebuild logic; we
   *  just nudge it. */
  onDiscoveryChanged(): void;
  /** Optional: called whenever launch-mode toggles on/off. Used by main.ts
   *  to disarm placement mode when launch is armed (mutual exclusion). */
  onLaunchModeChanged?(armed: boolean): void;
  /** §15.1 wall-clock anchor for drone weather sampling. The client passes
   *  `Date.now() - performance.now()` so perf-domain `nowMs` is shifted to
   *  wall time; tests may leave it undefined (defaults to 0). */
  weatherWallOffsetMs?: number;
}

export function mountDronesUi(parentEl: HTMLElement, deps: DroneUiDeps): DroneUiHandle {
  let visible = false;
  let launchMode = false;
  // Player-selected drone tier, capped at island tier at refresh time. Defaults
  // to 1 (cheapest / biofuel) so a fresh L5 player can experience T1 drones
  // without having to first build the T2 diesel chain.
  let selectedTier: DroneTier | '5-path' = 1;
  let selectedPadId: string | null = null;
  let prevOriginId: string | null = null;
  // Cached at refresh() so attemptLaunch + range-ring see the same numbers.
  // maxLaunchFuel = min(MAX_FUEL_PER_DRONE, on-hand fuel of the selected tier).
  let maxLaunchFuel = 0;
  let currentEfficiency = DRONE_TIER_EFFICIENCY[selectedTier];
  // §Fix 6.6: the Transport-skill droneFuelEfficiency multiplier for the
  // current origin island. Cached here so wouldExceedRange / fuelForPath
  // calls outside `refresh` (e.g. paintLaunchPreview, addWaypoint,
  // finalizePath) see the up-to-date multiplier without re-calling
  // effectiveSkillMultipliers on every frame.
  let currentFuelEffMul = 1;
  // Last known cursor tile from setReticleScreenPos. Null when hovering
  // off-canvas (matches reticle visibility). Drives the launch-preview line.
  let cursorTile: { x: number; y: number } | null = null;
  // T5 path-mode buffer: committed waypoints accumulated while in path-mode
  // ARM. Cleared on disarm, Esc, finalize. See drones-ui-helpers.ts for
  // pure math (totalPathTiles, wouldExceedRange, fuelForPath).
  let waypointBuffer: Array<{ x: number; y: number }> = [];

  // Side dock panel
  const panel = document.createElement('div');
  panel.id = 'drones-panel';
  panel.classList.add('ri-panel');
  styled(
    panel,
    [
      'width: 248px',
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

  // Header — stamp-style: "DRONE OPS / DSP-01" with a small flight-ops dot.
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
  headTitle.textContent = 'DRONE OPS';
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
  headSub.textContent = 'DSP-01';
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
    hide();
  });

  header.appendChild(headLeft);
  header.appendChild(closeBtn);

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

  // Stat block — BIOFUEL / RANGE / ETA / TIER
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

  function statRow(labelText: string): { row: HTMLDivElement; labelEl: HTMLSpanElement; valueEl: HTMLSpanElement } {
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
    return { row, labelEl: l, valueEl: v };
  }

  /** SPEC §11.6 gate: path mode requires L≥5, AI core crafted, foundry built. */
  function canUsePathMode(): boolean {
    const origin = deps.getOrigin();
    if (tierForLevel(origin.level) < 5) return false;
    if (!origin.aiCoreCrafted) return false;
    if (!hasOperationalBuilding(origin.buildings, 'path_drone_foundry')) return false;
    return true;
  }

  const padStat = statRow('PAD');
  const padSelect = document.createElement('select');
  padSelect.style.cssText = [
    'background: var(--ri-elev)',
    'color: var(--ri-accent)',
    'border: 1px solid var(--ri-border)',
    'font: inherit',
    'font-size: 11px',
    'padding: 1px 4px',
    'cursor: pointer',
    'border-radius: 3px',
  ].join(';');
  padSelect.addEventListener('change', () => {
    selectedPadId = padSelect.value || null;
    refresh(performance.now());
    if (launchMode) repaintRangeRing();
  });
  padStat.valueEl.appendChild(padSelect);

  const tierStat = statRow('TIER');
  // Tier picker — a compact `<select>` rather than a chip row. With 6
  // possible tiers a chip row overflowed the narrow dock; the dropdown
  // stays the same width regardless of how many tiers the island has
  // unlocked. Options are built once; refresh toggles `disabled` on
  // out-of-range entries and syncs `.value` to `selectedTier`.
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
  // Always mount the T5 path option; refresh() toggles disabled so it
  // surfaces automatically when path mode is unlocked mid-session.
  const pathOpt = document.createElement('option');
  pathOpt.value = '5-path';
  pathOpt.textContent = 'T5 Path';
  tierSelect.appendChild(pathOpt);
  tierSelect.addEventListener('change', () => {
    const v = tierSelect.value;
    if (v === '5-path') {
      selectedTier = '5-path';
    } else {
      selectedTier = Number(v) as DroneTier;
    }
    waypointBuffer = []; // reset buffer on any tier switch
    refresh(performance.now());
    if (launchMode) repaintRangeRing();
  });
  tierStat.valueEl.appendChild(tierSelect);
  // Fuel label is dynamic — §11.7 tier-matched grade per the launching
  // island's tier. The row's left-hand label is overwritten in refresh()
  // (e.g. BIOFUEL on a T1 island, AVIATION KEROSENE on a T3 island).
  const fuelStat = statRow('FUEL');
  const fuelStatLabelEl = fuelStat.row.firstChild as HTMLSpanElement;
  const rangeStat = statRow('OUTBND');
  const etaStat = statRow('FLIGHT');

  statBlock.appendChild(padStat.row);
  statBlock.appendChild(tierStat.row);
  statBlock.appendChild(fuelStat.row);
  statBlock.appendChild(rangeStat.row);
  statBlock.appendChild(etaStat.row);

  // DIST row — updated live in refresh() when cursorTile is set
  const distStat = statRow('DIST');
  distStat.valueEl.textContent = '—';
  statBlock.appendChild(distStat.row);

  body.appendChild(statBlock);

  // No fuel slider — fuel is auto-computed at click time as the exact amount
  // needed for the round-trip (round up to integer units, cap at
  // MAX_FUEL_PER_DRONE). The OUTBND + FLIGHT readouts show the max-affordable
  // range = min(MAX_FUEL_PER_DRONE, current fuel-resource inventory).

  // Arm-launch button — toggles canvas reticle mode
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
  armBtn.textContent = '◇ ARM LAUNCH';
  armBtn.addEventListener('click', () => {
    setLaunchMode(!launchMode);
    armBtn.blur();
  });
  body.appendChild(armBtn);

  // Fire Pulse button — T4 Launch Tower omnidirectional pulse (§11.5)
  const pulseBtn = document.createElement('button');
  styled(
    pulseBtn,
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
  pulseBtn.textContent = '◉ FIRE PULSE';
  pulseBtn.addEventListener('click', async () => {
    const origin = deps.getOrigin();
    const nowMs = performance.now();
    const r = deps.gateway
      ? await deps.gateway.firePulse(origin.id, nowMs)
      : firePulse(deps.world, origin, nowMs);
    if (r.ok) {
      deps.onDiscoveryChanged();
    }
    refresh(performance.now());
    pulseBtn.blur();
  });
  body.appendChild(pulseBtn);

  function setLaunchMode(on: boolean): void {
    if (launchMode === on) return;  // no-op + don't re-fire callback
    launchMode = on;
    if (on) {
      armBtn.textContent = '◆ DISARM';
      armBtn.style.color = 'var(--ri-warn)';
      armBtn.style.borderColor = 'var(--ri-warn)';
      armBtn.style.background = 'rgba(245, 167, 66, 0.08)';
      reticleLayer.visible = true;
      launchPreviewLayer.visible = true;
      repaintRangeRing();
      rangeRingLayer.visible = true;
    } else {
      armBtn.textContent = '◇ ARM LAUNCH';
      armBtn.style.color = 'var(--ri-fg-1)';
      armBtn.style.borderColor = 'var(--ri-border-strong)';
      armBtn.style.background = 'var(--ri-elev)';
      reticleLayer.visible = false;
      launchPreviewLayer.visible = false;
      rangeRingLayer.visible = false;
    }
    deps.onLaunchModeChanged?.(on);
  }

  // Active flights ledger
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
  ledgerL.textContent = 'FLIGHTS';
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
  ledgerEmpty.textContent = 'no active flights';
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

  // Footer hint strip
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
  footer.textContent = 'ARM, then click a target tile';

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);
  parentEl.appendChild(panel);

  const panelHandle = mountPanel(panel, {
    id: 'drones-panel',
    zone: Zone.R,
    order: 0,
  });
  panelHandle.setVisible(false);

  // Pixi layer: in-flight drone dots + breadcrumb trail
  const droneLayer = new Container();
  droneLayer.label = 'drones';

  // Per-drone trail buffers (fading dots behind the drone). Trails are
  // drawn from a small ring buffer that we update each refresh.
  const trails = new Map<string, { points: Array<{ x: number; y: number; t: number }> }>();
  const TRAIL_SAMPLE_MS = 250; // sample one breadcrumb every 250 ms
  const TRAIL_MAX_POINTS = 6;

  function ensureTrail(d: Drone): { points: Array<{ x: number; y: number; t: number }> } {
    let t = trails.get(d.id);
    if (!t) {
      t = { points: [] };
      trails.set(d.id, t);
    }
    return t;
  }

  // Pixi layer: range ring (WORLD space, inside world container).
  // Drawn around the active origin when launch mode is armed. Radius is
  // mode-conditional: numeric tiers use round-trip outbound
  // (min(MAX_FUEL, on-hand) × efficiency) / 2; T5 path-drawn drones are
  // one-way (#117) so radius = min(MAX_FUEL, on-hand) × efficiency.
  const rangeRingLayer = new Container();
  rangeRingLayer.label = 'launch-range-ring';
  rangeRingLayer.visible = false;
  const rangeRingGfx = new Graphics();
  rangeRingLayer.addChild(rangeRingGfx);

  // Pixi layer: selected-pad highlight (WORLD space)
  const selectedPadHighlightLayer = new Container();
  selectedPadHighlightLayer.label = 'selected-pad-highlight';
  selectedPadHighlightLayer.visible = false;
  const selectedPadHighlightGfx = new Graphics();
  selectedPadHighlightLayer.addChild(selectedPadHighlightGfx);

  function repaintSelectedPadHighlight(): void {
    selectedPadHighlightGfx.clear();
    if (!visible || !selectedPadId) {
      selectedPadHighlightLayer.visible = false;
      return;
    }
    const spec = deps.getOriginSpec();
    const state = deps.getOrigin();
    const pad = state.buildings.find((b) => b.id === selectedPadId);
    if (!pad || !isOperationalBuilding(pad)) {
      selectedPadHighlightLayer.visible = false;
      return;
    }
    const def = BUILDING_DEFS[pad.defId as BuildingDefId];
    const w = shapeWidth(def.footprint) * TILE_PX;
    const h = shapeHeight(def.footprint) * TILE_PX;
    const px = (spec.cx + pad.x) * TILE_PX - TILE_PX / 2 + 1;
    const py = (spec.cy + pad.y) * TILE_PX - TILE_PX / 2 + 1;
    selectedPadHighlightGfx.roundRect(px, py, w - 2, h - 2, 3)
      .stroke({ width: 2, color: VISION_BLUE, alpha: 0.85 });
    selectedPadHighlightLayer.visible = true;
  }

  function repaintRangeRing(): void {
    rangeRingGfx.clear();
    const originSpec = deps.getOriginSpec();
    const origin = deps.getOrigin();
    const outboundTiles = selectedTier === '5-path'
      ? maxLaunchFuel * currentEfficiency
      : (maxLaunchFuel * currentEfficiency) / 2;
    if (outboundTiles <= 0) return;
    const radiusPx = outboundTiles * TILE_PX;
    // §11.1: range ring centres on the Drone Pad footprint centre (the actual
    // drone launch origin) — falling back to island centre only when no pad
    // is placed, matching the pre-fix behaviour for that null-safe edge.
    const padCentre = selectedPadCentre(originSpec, origin, selectedPadId);
    const originX = padCentre?.x ?? originSpec.cx;
    const originY = padCentre?.y ?? originSpec.cy;
    const cx = originX * TILE_PX;
    const cy = originY * TILE_PX;
    // Two concentric strokes: a soft filled disc to suggest the reachable
    // area, then a crisper rim line so the boundary reads precisely.
    rangeRingGfx.circle(cx, cy, radiusPx).fill({ color: VISION_BLUE, alpha: 0.05 });
    rangeRingGfx.circle(cx, cy, radiusPx).stroke({ width: 2, color: VISION_BLUE, alpha: 0.55 });
    // Centre crosshair so the origin tile is unambiguous at any zoom.
    const cross = TILE_PX;
    rangeRingGfx.moveTo(cx - cross, cy).lineTo(cx + cross, cy)
      .stroke({ width: 1, color: VISION_BLUE, alpha: 0.5 });
    rangeRingGfx.moveTo(cx, cy - cross).lineTo(cx, cy + cross)
      .stroke({ width: 1, color: VISION_BLUE, alpha: 0.5 });
  }

  // Pixi layer: launch reticle (screen space, NOT inside world container).
  // Drawn at fixed screen-pixel size irrespective of zoom — it lives outside
  // the camera's transform so 1px lines stay 1px.
  const reticleLayer = new Container();
  reticleLayer.label = 'launch-reticle';
  reticleLayer.visible = false;
  // The reticle sprite (built once; positioned by `setReticleScreenPos`).
  const reticleGfx = new Graphics();
  // Draw a crosshair: outer ring 14px radius (3px stroke), inner ring 6px
  // (1px stroke), four spokes through the centre.
  function paintReticle(color: number): void {
    reticleGfx.clear();
    reticleGfx.circle(0, 0, 14).stroke({ width: 2, color, alpha: 0.85 });
    reticleGfx.circle(0, 0, 6).stroke({ width: 1, color, alpha: 0.7 });
    // Spokes: skip the innermost few pixels so the centre stays open.
    const inner = 3;
    const outer = 18;
    reticleGfx.moveTo(-outer, 0).lineTo(-inner, 0).stroke({ width: 1, color, alpha: 0.6 });
    reticleGfx.moveTo(inner, 0).lineTo(outer, 0).stroke({ width: 1, color, alpha: 0.6 });
    reticleGfx.moveTo(0, -outer).lineTo(0, -inner).stroke({ width: 1, color, alpha: 0.6 });
    reticleGfx.moveTo(0, inner).lineTo(0, outer).stroke({ width: 1, color, alpha: 0.6 });
    // Tiny centre pip.
    reticleGfx.rect(-1, -1, 2, 2).fill({ color, alpha: 0.9 });
  }
  // Two pre-built colours: cyan = reachable, amber = out of fuel range. We
  // repaint the graphics on each cursor move only when the colour bucket
  // changes, not every mousemove (Graphics.clear + restroke is cheap but
  // not free at full mousemove rate).
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

  // Pixi layer: launch-preview line/polyline. World-space (panned/zoomed
  // with camera), unlike the screen-space reticle. Color rule:
  //   green when distance ≤ maxLaunchRange (numeric)
  //   red otherwise
  const launchPreviewLayer = new Container();
  launchPreviewLayer.label = 'launch-preview';
  launchPreviewLayer.visible = false;
  const launchPreviewGfx = new Graphics();
  launchPreviewLayer.addChild(launchPreviewGfx);

  const PREVIEW_COLOR_OK = 0x8FA56E;   // olive
  const PREVIEW_COLOR_BAD = 0xE08B7F;  // rust
  const PREVIEW_LINE_WIDTH = 2;

  function paintLaunchPreview(): void {
    launchPreviewGfx.clear();
    if (!launchMode) return;
    const spec = deps.getOriginSpec();
    // §11.1: preview line origin = Drone Pad footprint centre, same as the
    // range ring and the actual flight geometry. Pre-fix used `spec.cx/cy`
    // (island centre), so the drawn flight path didn't match the path the
    // drone actually flies.
    const padCentre = selectedPadCentre(spec, deps.getOrigin(), selectedPadId);
    const ox = padCentre?.x ?? spec.cx;
    const oy = padCentre?.y ?? spec.cy;
    const originTile = { x: ox, y: oy };
    const originPx = tileToWorldPx(ox, oy);

    if (selectedTier === '5-path') {
      // Solid polyline through committed waypoints.
      let prevPx = originPx;
      for (const wp of waypointBuffer) {
        const wpPx = tileToWorldPx(wp.x, wp.y);
        launchPreviewGfx.moveTo(prevPx.x, prevPx.y)
          .lineTo(wpPx.x, wpPx.y)
          .stroke({ width: PREVIEW_LINE_WIDTH, color: PREVIEW_COLOR_OK, alpha: 0.85 });
        prevPx = wpPx;
      }
      // Dashed segment from last anchor to cursor.
      if (cursorTile) {
        const wouldExceed = wouldExceedRange(originTile, waypointBuffer, cursorTile, currentFuelEffMul);
        const color = wouldExceed ? PREVIEW_COLOR_BAD : PREVIEW_COLOR_OK;
        const cursorPx = tileToWorldPx(cursorTile.x, cursorTile.y);
        drawDashedSegment(launchPreviewGfx, prevPx, cursorPx, color);
      }
      return;
    }

    // Numeric tier: single line origin → cursor.
    if (!cursorTile) return;
    const dxTiles = cursorTile.x - ox;
    const dyTiles = cursorTile.y - oy;
    const distTiles = Math.sqrt(dxTiles * dxTiles + dyTiles * dyTiles);
    const maxRangeTiles = maxLaunchFuel * currentEfficiency / 2;
    const color = distTiles <= maxRangeTiles ? PREVIEW_COLOR_OK : PREVIEW_COLOR_BAD;
    const cursorPx = tileToWorldPx(cursorTile.x, cursorTile.y);
    launchPreviewGfx.moveTo(originPx.x, originPx.y)
      .lineTo(cursorPx.x, cursorPx.y)
      .stroke({ width: PREVIEW_LINE_WIDTH, color, alpha: 0.85 });
  }

  /** Stroke a dashed line from `a` to `b` on the supplied Graphics.
   *  Pattern: 8px on, 4px off (world pixels — same units as the line). */
  function drawDashedSegment(
    gfx: Graphics,
    a: { x: number; y: number },
    b: { x: number; y: number },
    color: number,
  ): void {
    const DASH = 8;
    const GAP = 4;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;
    const ux = dx / len;
    const uy = dy / len;
    let t = 0;
    while (t < len) {
      const segEnd = Math.min(t + DASH, len);
      gfx.moveTo(a.x + ux * t, a.y + uy * t)
         .lineTo(a.x + ux * segEnd, a.y + uy * segEnd);
      t = segEnd + GAP;
    }
    gfx.stroke({ width: PREVIEW_LINE_WIDTH, color, alpha: 0.85 });
  }

  function setReticleScreenPos(x: number, y: number): void {
    if (!launchMode) return;
    reticleGfx.position.set(x, y);
    // Update colour: amber when the cursor's world-tile distance from the
    // active origin exceeds the configured outbound range, cyan otherwise.
    // §11.1: distance is measured from the Drone Pad footprint centre — the
    // actual launch origin — not the island geometric centre. Pre-fix used
    // `spec.cx/cy`, which mispredicted reach by `(padCentre − islandCentre)`
    // for any off-centre pad. Falls back to island centre when no pad is
    // placed (UI gates arm-launch on pad presence, so this branch is
    // null-safe scaffolding only).
    const originSpec = deps.getOriginSpec();
    const origin = deps.getOrigin();
    const padCentre = selectedPadCentre(originSpec, origin, selectedPadId);
    const originX = padCentre?.x ?? originSpec.cx;
    const originY = padCentre?.y ?? originSpec.cy;
    const wp = deps.screenToWorldTile(x, y);
    cursorTile = { x: wp.x, y: wp.y };
    const dx = wp.x - originX;
    const dy = wp.y - originY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const isPathMode = selectedTier === '5-path';
    const outbound = isPathMode
      ? maxLaunchFuel * currentEfficiency
      : (maxLaunchFuel * currentEfficiency) / 2;
    ensurePainted(dist > outbound ? RETICLE_WARN : RETICLE_OK);
    // ETA prediction — one-way for T5 path mode (#117), round-trip for
    // numeric tiers. Updates the FLIGHT readout live as the cursor moves.
    const etaSec = isPathMode
      ? dist / DRONE_T5_SPEED_TILES_PER_SEC
      : (2 * dist) / DRONE_SPEED_TILES_PER_SEC;
    if (dist > outbound) {
      etaStat.valueEl.textContent = `${etaSec.toFixed(0)}s · out of range`;
      etaStat.valueEl.style.color = 'var(--ri-warn)';
    } else {
      etaStat.valueEl.textContent = `${etaSec.toFixed(0)}s to target`;
      etaStat.valueEl.style.color = 'var(--ri-accent)';
    }
  }
  function hideReticleFn(): void {
    reticleGfx.position.set(-9999, -9999);
    cursorTile = null;
  }

  function renderDroneDot(d: Drone, nowMs: number): Container {
    const c = new Container();
    c.label = `drone:${d.id}`;
    const pos = droneCurrentPosition(d, nowMs);
    const wpx = pos.x * TILE_PX;
    const wpy = pos.y * TILE_PX;

    // Trail (drawn under the marker). Reduced alpha + tighter footprint so
    // the triangle reads as primary; the trail is supporting context, not
    // a competing element.
    const tr = ensureTrail(d);
    if (tr.points.length === 0 || nowMs - (tr.points[tr.points.length - 1]?.t ?? 0) >= TRAIL_SAMPLE_MS) {
      tr.points.push({ x: wpx, y: wpy, t: nowMs });
      if (tr.points.length > TRAIL_MAX_POINTS) tr.points.shift();
    }
    const trailG = new Graphics();
    const n = tr.points.length;
    for (let i = 0; i < n; i++) {
      const p = tr.points[i]!;
      // Older points more transparent — alpha ramps from ~0.05 (oldest)
      // to ~0.30 (most recent). Half the previous footprint to keep the
      // trail subordinate to the marker.
      const alpha = 0.05 + (0.25 * (i + 1)) / n;
      trailG.circle(p.x, p.y, 1).fill({ color: VISION_BLUE, alpha });
    }
    c.addChild(trailG);

    // Drone marker — a small heading-aligned triangle. 12px world-pixel
    // long-axis (≈ half a tile). The triangle points along (dirX, dirY),
    // which the dispatch layer normalised at launch time.
    //
    // Geometry: tip at (+L, 0) along the heading, base at (−L/2, ±L/2).
    // We build the polygon in local (heading-aligned) coords, rotate by
    // the heading angle, and translate to (wpx, wpy).
    const L = 12; // long-axis length in world pixels
    const w = 8;  // base width
    const ang = Math.atan2(d.dirY, d.dirX);
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    // Rotated, translated polygon points.
    const rot = (lx: number, ly: number): [number, number] => [
      wpx + lx * cos - ly * sin,
      wpy + lx * sin + ly * cos,
    ];
    const tip = rot(L * 0.6, 0);
    const baseL = rot(-L * 0.4, -w / 2);
    const baseR = rot(-L * 0.4, w / 2);
    const dotG = new Graphics();
    // Soft halo behind the triangle so it pops on any ocean tier.
    dotG.circle(wpx, wpy, 8).fill({ color: VISION_BLUE, alpha: 0.18 });
    // Filled body + stroked outline for definition.
    dotG.poly([tip[0], tip[1], baseL[0], baseL[1], baseR[0], baseR[1]])
      .fill({ color: VISION_BLUE, alpha: 0.9 })
      .stroke({ width: 1, color: 0xffffff, alpha: 0.7 });
    c.addChild(dotG);

    return c;
  }

  /** Rebuild the drone dot layer from scratch each frame. Cheap because
   *  there are at most O(small) drones in flight; redrawing avoids any
   *  diffing logic and matches how the per-frame ticker repaints the world
   *  container in main.ts. */
  function repaintDroneLayer(nowMs: number): void {
    for (const c of droneLayer.removeChildren()) c.destroy(true);
    for (const d of deps.world.drones) {
      if (d.status === 'lost' || d.status === 'returned') continue;
      droneLayer.addChild(renderDroneDot(d, nowMs));
    }
    // Drop trail buffers for drones that no longer exist.
    for (const id of trails.keys()) {
      if (!deps.world.drones.some((d) => d.id === id)) trails.delete(id);
    }
  }

  function repaintLedger(nowMs: number): void {
    ledgerList.replaceChildren();
    const active = deps.world.drones.filter(
      (d) => d.status !== 'lost' && d.status !== 'returned',
    );
    const originSpec = deps.getOriginSpec();
    const operationalPads = operationalDronepads(originSpec.buildings);
    const padCount = operationalPads.length;
    if (active.length === 0) {
      ledgerList.appendChild(ledgerEmpty);
      ledgerR.textContent = `0 / ${padCount}`;
      return;
    }
    ledgerR.textContent = `${active.length} / ${padCount}`;
    for (const d of active) {
      ledgerList.appendChild(renderLedgerRow(d, nowMs));
    }
  }

  function renderLedgerRow(d: Drone, nowMs: number): HTMLDivElement {
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
    idEl.textContent = d.id.toUpperCase();
    styled(idEl, `color: ${'var(--ri-accent)'}; font-size: 10px; letter-spacing: 0.08em; font-weight: 600`);
    const etaEl = document.createElement('span');
    etaEl.classList.add('ri-mono');
    const remainSec = Math.max(0, (d.expectedReturnTime - nowMs) / 1000);
    etaEl.textContent = `T-${remainSec.toFixed(1)}s`;
    styled(etaEl, `color: ${'var(--ri-warn)'}; font-size: 10px; font-weight: 600`);
    top.appendChild(idEl);
    top.appendChild(etaEl);

    // Progress rule — thin amber bar that fills left-to-right.
    const totalMs = d.expectedReturnTime - d.launchTime;
    const elapsedMs = Math.max(0, Math.min(totalMs, nowMs - d.launchTime));
    const pct = totalMs > 0 ? elapsedMs / totalMs : 0;
    const ruleWrap = document.createElement('div');
    styled(
      ruleWrap,
      [
        'height: 2px',
        `background: ${'var(--ri-border)'}`,
        'position: relative',
      ].join(';'),
    );
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
    const fuelEl = document.createElement('span');
    fuelEl.classList.add('ri-mono');
    fuelEl.textContent = `${d.fuelLoaded} fuel · ${d.outboundTiles.toFixed(0)} tiles`;
    styled(fuelEl, `color: ${'var(--ri-fg-3)'}; font-size: 9.5px`);
    const tierEl = document.createElement('span');
    tierEl.classList.add('ri-mono');
    tierEl.textContent = `T${d.tier}`;
    styled(tierEl, `color: ${'var(--ri-fg-3)'}; font-size: 9.5px; letter-spacing: 0.06em`);
    meta.appendChild(fuelEl);
    meta.appendChild(tierEl);

    row.appendChild(top);
    row.appendChild(ruleWrap);
    row.appendChild(meta);
    return row;
  }

  function refresh(nowMs: number): void {
    const origin = deps.getOrigin();
    const originSpec = deps.getOriginSpec();

    // 1. Operational-pad list (filtered, in placement order).
    const operationalPads = operationalDronepads(originSpec.buildings);

    // 2. Active-island switch → reset to first pad.
    if (origin.id !== prevOriginId) {
      selectedPadId = operationalPads[0]?.id ?? null;
      prevOriginId = origin.id;
    }

    // 3. Selected pad no longer operational → fall back.
    if (selectedPadId && !operationalPads.some((p) => p.id === selectedPadId)) {
      selectedPadId = operationalPads[0]?.id ?? null;
    }

    // 4. First-show default.
    if (!selectedPadId && operationalPads.length > 0) {
      selectedPadId = operationalPads[0]!.id;
    }

    // 5. Rebuild <option> list whenever the set of operational pads changes.
    //    Cheap signature: ids joined. Avoids per-frame DOM rebuild.
    const padSig = operationalPads.map((p) => p.id).join(',');
    if (padSelect.dataset.sig !== padSig) {
      padSelect.replaceChildren();
      operationalPads.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `Pad #${i + 1}`;
        padSelect.appendChild(opt);
      });
      padSelect.dataset.sig = padSig;
    }
    if (selectedPadId && padSelect.value !== selectedPadId) {
      padSelect.value = selectedPadId;
    }

    // Clamp the selectedTier to the island's current max-tier so a high-tier
    // island that downgrades (tier reset) doesn't keep launching invalid
    // tiers. Default to the island's tier on first arming if selectedTier
    // was never explicitly chosen via the picker.
    const islandTier = tierForLevel(origin.level);
    if (typeof selectedTier === 'number' && selectedTier > islandTier) {
      selectedTier = islandTier as DroneTier;
    } else if (selectedTier === '5-path' && !canUsePathMode()) {
      selectedTier = islandTier as DroneTier;
      waypointBuffer = [];
    }
    // Disable out-of-range tier options + sync the select's current value.
    // Options were built once at mount; only attribute changes here, so
    // real clicks aren't disrupted by per-frame DOM rebuild (the bug we
    // tripped on with the chip-row variant).
    for (let i = 0; i < tierSelect.options.length; i++) {
      const opt = tierSelect.options[i];
      if (!opt) continue;
      if (opt.value === '5-path') {
        opt.disabled = !canUsePathMode();
      } else {
        const tierNum = Number(opt.value);
        opt.disabled = tierNum > islandTier;
      }
    }
    if (tierSelect.value !== String(selectedTier)) {
      tierSelect.value = String(selectedTier);
    }
    // §11.7 tier-matched fuel — label + on-hand inventory follow the
    // PLAYER-SELECTED drone tier (T1 → BIOFUEL, T2 → DIESEL, …) not the
    // island tier, so a T5 island launching a T2 drone shows DIESEL here.
    const fuelResource = selectedTier === '5-path' ? 'plasma_charge' : fuelForTier(selectedTier);
    fuelStatLabelEl.textContent = fuelResource.toUpperCase().replace(/_/g, ' ');
    const onhand = inv(origin, fuelResource);
    // Fuel auto-computed at click time. The OUTBND + FLIGHT readouts show
    // the MAX-affordable range for this island right now. Numeric tiers are
    // round-trip: min(MAX_FUEL, available) × current efficiency / 2. T5 path
    // mode (#117) is one-way: min(MAX_FUEL, available) × current efficiency.
    // Cached on the closure so attemptLaunch + the range ring agree.
    const eff = selectedTier === '5-path'
      ? DRONE_T5_EFFICIENCY
      : DRONE_TIER_EFFICIENCY[selectedTier];
    currentFuelEffMul = effectiveSkillMultipliers(origin).droneFuelEfficiency;
    currentEfficiency = eff * currentFuelEffMul;
    maxLaunchFuel = Math.floor(Math.min(MAX_FUEL_PER_DRONE, onhand));
    const isPathModeStats = selectedTier === '5-path';
    const maxOutbound = isPathModeStats
      ? maxLaunchFuel * currentEfficiency
      : (maxLaunchFuel * currentEfficiency) / 2;
    fuelStat.valueEl.style.color = maxLaunchFuel > 0 ? 'var(--ri-fg-1)' : 'var(--ri-warn)';
    rangeStat.valueEl.textContent = `${maxOutbound.toFixed(0)} t max`;
    const maxFlightSec = isPathModeStats
      ? (maxLaunchFuel * currentEfficiency) / DRONE_T5_SPEED_TILES_PER_SEC
      : (maxLaunchFuel * currentEfficiency) / DRONE_SPEED_TILES_PER_SEC;
    etaStat.valueEl.textContent = `${maxFlightSec.toFixed(0)}s max`;

    // DIST / PATH row update. §11.1: distance + path length measured from the
    // Drone Pad footprint centre — the actual launch origin — not the island
    // centre, so the readouts match the preview line and the actual flight.
    if (selectedTier === '5-path') {
      const s = deps.getOriginSpec();
      const pc = selectedPadCentre(s, origin, selectedPadId);
      const originPt = { x: pc?.x ?? s.cx, y: pc?.y ?? s.cy };
      const pathLen = totalPathTiles(originPt, waypointBuffer);
      const fuel = fuelForPath(originPt, waypointBuffer, currentFuelEffMul);
      distStat.labelEl.textContent = 'PATH';
      distStat.valueEl.textContent = `${pathLen.toFixed(0)} tiles`;
      fuelStat.valueEl.textContent = `${fuel} / ${MAX_FUEL_PER_DRONE} plasma_charge`;
    } else {
      fuelStat.valueEl.textContent = `${onhand.toFixed(0)} u`;
      if (cursorTile) {
        const s = deps.getOriginSpec();
        const pc = selectedPadCentre(s, origin, selectedPadId);
        const ox = pc?.x ?? s.cx;
        const oy = pc?.y ?? s.cy;
        const dx = cursorTile.x - ox;
        const dy = cursorTile.y - oy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        distStat.labelEl.textContent = 'DIST';
        distStat.valueEl.textContent = `${dist.toFixed(0)} tiles`;
      } else {
        distStat.labelEl.textContent = 'DIST';
        distStat.valueEl.textContent = '—';
      }
    }

    // Per-pad arm gating.
    function padBusyState(): 'no-pad' | 'free' | 'selected-busy' | 'all-busy' {
      if (operationalPads.length === 0) return 'no-pad';
      const active = deps.world.drones.filter(
        (d) => d.fromIslandId === origin.id &&
               (d.status === 'active' || d.status === undefined),
      );
      const busyPadIds = new Set<string>();
      for (const p of operationalPads) {
        const def = BUILDING_DEFS[p.defId as BuildingDefId];
        const px = originSpec.cx + p.x + shapeWidth(def.footprint) / 2;
        const py = originSpec.cy + p.y + shapeHeight(def.footprint) / 2;
        // §4.9: a pad sustains up to its active-floor count of concurrent
        // drones, so it's only "busy" once its in-flight count reaches that cap.
        const inFlight = active.filter((d) => Math.abs(d.originX - px) < 0.5
                                && Math.abs(d.originY - py) < 0.5).length;
        if (inFlight >= Math.max(1, activeFloors(p))) {
          busyPadIds.add(p.id);
        }
      }
      if (busyPadIds.size === operationalPads.length) return 'all-busy';
      if (selectedPadId && busyPadIds.has(selectedPadId)) return 'selected-busy';
      return 'free';
    }

    const padBusy = padBusyState();
    const canLaunch = padBusy === 'free' && maxLaunchFuel > 0;
    armBtn.disabled = !canLaunch;
    armBtn.style.opacity = canLaunch ? '1' : '0.5';
    armBtn.style.cursor = canLaunch ? 'pointer' : 'not-allowed';
    if (!canLaunch && launchMode) setLaunchMode(false);
    if (padBusy === 'no-pad') {
      armBtn.textContent = '◇ NO DRONE PAD';
      armBtn.title = 'Active island has no Drone Pad';
    } else if (padBusy === 'selected-busy') {
      armBtn.textContent = '◇ PAD BUSY';
      armBtn.title = 'This pad is launching a drone; pick another pad';
    } else if (padBusy === 'all-busy') {
      armBtn.textContent = '◇ ALL PADS BUSY';
      armBtn.title = 'Every Drone Pad on this island is busy';
    } else if (!launchMode) {
      armBtn.textContent = '◇ ARM LAUNCH';
      armBtn.title = '';
    }

    // Pulse gating — Launch Tower + T4 + cryogenic_hydrogen
    const hasLaunchTower = hasOperationalBuilding(originSpec.buildings, 'launch_tower');
    const tier = tierForLevel(origin.level);
    const t4Fuel = fuelForTier(4);
    const pulseFuel = inv(origin, t4Fuel);
    const canFirePulse = hasLaunchTower && tier >= 4 && pulseFuel >= T4_PULSE_FUEL_COST;
    pulseBtn.disabled = !canFirePulse;
    pulseBtn.style.opacity = canFirePulse ? '1' : '0.5';
    pulseBtn.style.cursor = canFirePulse ? 'pointer' : 'not-allowed';
    if (!hasLaunchTower) {
      pulseBtn.title = 'Active island has no Launch Tower';
    } else if (tier < 4) {
      pulseBtn.title = 'Active island is below T4';
    } else if (pulseFuel < T4_PULSE_FUEL_COST) {
      pulseBtn.title = `Insufficient ${t4Fuel.replace(/_/g, ' ')}`;
    } else {
      pulseBtn.title = '';
    }

    repaintLedger(nowMs);
    repaintDroneLayer(nowMs);
    paintLaunchPreview();
    repaintSelectedPadHighlight();
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
    targetWorldTileX: number,
    targetWorldTileY: number,
    nowMs: number,
  ): { ok: boolean; reason?: string } {
    if (selectedTier === '5-path') {
      // Add waypoint; reject if would exceed fuel cap. §11.1: range check
      // anchors on the Drone Pad footprint centre, not the island centre.
      const spec = deps.getOriginSpec();
      const pc = selectedPadCentre(spec, deps.getOrigin(), selectedPadId);
      const origin = { x: pc?.x ?? spec.cx, y: pc?.y ?? spec.cy };
      const next = { x: targetWorldTileX, y: targetWorldTileY };
      if (wouldExceedRange(origin, waypointBuffer, next, currentFuelEffMul)) {
        return { ok: false, reason: 'over-range' };
      }
      waypointBuffer.push(next);
      return { ok: true };
    }
    const originSpec = deps.getOriginSpec();
    const origin = deps.getOrigin();
    // §11.1: launch geometry — origin AND direction vector — both anchor on
    // the Drone Pad footprint centre. Pre-fix this used `spec.cx/cy`, so a
    // drone launched from an off-centre pad arced to a point offset from the
    // player's clicked target by `(padCentre − islandCentre)`. The
    // `dispatchDrone` call's `originX/originY` params also receive the pad
    // centre so the UI agrees with `drones.ts`'s internal pad lookup (the
    // params are kept on the API as defence against future UI drift —
    // `drones.ts` independently resolves the pad centre for the spawn).
    const padCentre = selectedPadCentre(originSpec, origin, selectedPadId);
    const ox = padCentre?.x ?? originSpec.cx;
    const oy = padCentre?.y ?? originSpec.cy;
    const dx = targetWorldTileX - ox;
    const dy = targetWorldTileY - oy;
    // Auto-compute exact fuel for the round-trip. Range = fuel × efficiency,
    // outbound = range / 2 → fuel = (2 × outboundDist) / efficiency. Round
    // up to integer units (dispatchDrone expects an integer-ish fuel value)
    // and cap at MAX_FUEL_PER_DRONE; if even max-fuel can't reach the target
    // dispatchDrone will reject with 'insufficient-fuel' (or the click was
    // outside the ring and the reticle already warned the player).
    const dist = Math.sqrt(dx * dx + dy * dy);
    const fuelNeeded = Math.min(
      MAX_FUEL_PER_DRONE,
      Math.max(1, Math.ceil((2 * dist) / currentEfficiency)),
    );
    const gatewayResult = deps.gateway
      ? deps.gateway.dispatchDrone(origin.id, ox, oy, dx, dy, fuelNeeded, nowMs, undefined, selectedTier, deps.weatherWallOffsetMs ?? 0)
      : undefined;
    if (gatewayResult instanceof Promise) {
      void (async () => {
        const result = await gatewayResult;
        if (!result.ok) return;
        setLaunchMode(false);
        refresh(nowMs);
      })();
      return { ok: false };
    }
    const r = gatewayResult ?? dispatchDrone(deps.world, origin, ox, oy, dx, dy, fuelNeeded, nowMs, undefined, selectedTier, deps.weatherWallOffsetMs ?? 0);
    if (r.ok) {
      setLaunchMode(false);
      refresh(nowMs);
      return { ok: true };
    }
    return { ok: false, reason: r.reason };
  }

  /** Pop the last committed waypoint (right-click in path mode). No-op
   *  if buffer is empty or path mode isn't selected. */
  function popWaypoint(): void {
    if (selectedTier !== '5-path') return;
    waypointBuffer.pop();
  }

  /** Finalize the path: drop trailing-duplicate (browser click+dblclick
   *  artifact), then dispatch with the waypoints. No-op if no waypoints.
   *  The engine requires waypoints.length≥2 to enter the isPathDrawn branch;
   *  we prepend origin to deduped, so deduped.length≥1 is the minimum. */
  function finalizePath(nowMs: number): { ok: boolean; reason?: string } {
    if (selectedTier !== '5-path') return { ok: false, reason: 'not-path-mode' };
    const deduped = popTrailingDuplicate(waypointBuffer);
    if (deduped.length < 1) return { ok: false, reason: 'no-waypoints' };
    const spec = deps.getOriginSpec();
    const originState = deps.getOrigin();
    // §11.1: path origin anchors on the Drone Pad footprint centre. Pre-fix
    // this used `spec.cx/cy` (island centre); the waypoint list prepended an
    // island-centre point, so the drone's actual path differed from the
    // preview by `(padCentre − islandCentre)` on the first leg.
    const pc = selectedPadCentre(spec, originState, selectedPadId);
    const ox = pc?.x ?? spec.cx;
    const oy = pc?.y ?? spec.cy;
    const originTile = { x: ox, y: oy };
    const fuel = fuelForPath(originTile, deduped, currentFuelEffMul);
    // Engine signature (drones.ts:330-346): dispatchDrone(world, origin,
    // originX, originY, dirX, dirY, fuelLoaded, nowMs, waypoints?, selectedTier?).
    // Direction must have magnitude > 0 (line 350 validation); the path-drawn
    // branch at line 361-369 overrides direction internally from the waypoint
    // array. Tests at drones.test.ts:1045-1086 pass (originX=0, originY=0,
    // dirX=1, dirY=0) — match that convention. selectedTier omitted: line 369
    // forces resolvedTier=5 when isPathDrawn (waypoints.length≥2).
    const waypointsForDispatch = [originTile, ...deduped];
    const gatewayResult = deps.gateway
      ? deps.gateway.dispatchDrone(originState.id, ox, oy, 1, 0, fuel, nowMs, waypointsForDispatch)
      : undefined;
    if (gatewayResult instanceof Promise) {
      void (async () => {
        const result = await gatewayResult;
        if (!result.ok) return;
        waypointBuffer = [];
        setLaunchMode(false);
      })();
      return { ok: false };
    }
    const result = gatewayResult ?? dispatchDrone(
      deps.world,
      originState,
      ox, oy,
      1, 0,
      fuel,
      nowMs,
      waypointsForDispatch,
      undefined,
      deps.weatherWallOffsetMs ?? 0,
    );
    if (result.ok) {
      waypointBuffer = [];
      setLaunchMode(false);
      return { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  /** Cancel an in-progress path (Esc). Clears buffer + disarms. */
  function cancelPath(): void {
    waypointBuffer = [];
    if (selectedTier === '5-path') {
      setLaunchMode(false);
    }
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
    popWaypoint,
    finalizePath,
    cancelPath,
    droneLayer,
    reticleLayer,
    rangeRingLayer,
    launchPreviewLayer,
    selectedPadHighlightLayer,
  };
}

