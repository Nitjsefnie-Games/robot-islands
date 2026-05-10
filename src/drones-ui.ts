// Drone-ops side dock + canvas reticle + in-flight visuals.
//
// Aesthetic — see frontend-design notes (mission-control flight-ops console):
// a narrow vertical sidebar that reads as a console plate alongside the HUD
// and skill-tree panels. The skill tree is centered-modal/dense; this dock
// is anchored, narrow, ledger-paper density. Same monospace + cyan accent
// palette so the two panels feel like different stations on the same console
// rather than two different apps.
//
// Structure of this module (roughly bottom-up):
//   - Palette + small DOM helpers reused from skill-tree-ui
//   - Stamp-style header with `DRONE OPS / DSP-01`
//   - Stat block (BIOFUEL / RANGE / ETA / TIER) with tabular numerics
//   - Fuel slider with stenciled rail
//   - Launch / Arm-launch button (toggles canvas reticle mode)
//   - Active flights ledger (per-drone row with animated thin amber rule)
//   - Renderable `Container` for in-flight drone dots (cyan 4×4 px in world
//     space + breadcrumb trail)
//   - Renderable `Container` for the launch reticle (follows cursor while in
//     launch mode)
//
// All DOM is plain elements with inline styles; no framework.

import { Container, Graphics } from 'pixi.js';

import type { IslandState } from './economy.js';
import { inv } from './economy.js';
import {
  DRONE_SPEED_TILES_PER_SEC,
  DRONE_TIER_EFFICIENCY,
  MAX_FUEL_PER_DRONE,
  MIN_FUEL_PER_DRONE,
  dispatchDrone,
  droneCurrentPosition,
  type Drone,
} from './drones.js';
import { TILE_PX } from './island.js';
import { VISION_BLUE, type IslandSpec, type WorldState } from './world.js';

// ---------------------------------------------------------------------------
// Palette — derived from skill-tree-ui for visual continuity
// ---------------------------------------------------------------------------
const PANEL_BG = 'rgba(14, 18, 26, 0.92)';
const PANEL_BORDER = '#3a4452';
const FG = '#cdd6f4';
const FG_DIM = '#6c7791';
const FG_MUTED = '#4a5365';
const ACCENT = '#7dd3e8';
const ACCENT_DIM = '#3d6f7c';
const WARN = '#f5a742';
const STRIP_BG = 'rgba(20, 24, 32, 0.6)';
const RAIL = '#2a3240';

function styled(el: HTMLElement, css: string): void {
  el.style.cssText = css;
}

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------
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
  /** Container for in-flight drone dots + breadcrumb trails. Add to world. */
  readonly droneLayer: Container;
  /** Container for the launch reticle (lives in screen space, not world).
   *  Add directly to the stage, not the world container — it shouldn't
   *  pan/zoom with the camera. */
  readonly reticleLayer: Container;
}

/** All the bits the UI needs handed in. The main module wires this once at
 *  bootstrap; the dock doesn't otherwise know about cameras or screens. */
export interface DroneUiDeps {
  /** The world state — drones list and islands. */
  readonly world: WorldState;
  /** The home island state (only origin we support in step 6). */
  readonly home: IslandState;
  /** The home island's spec (read for origin coordinates in tiles). */
  readonly homeSpec: IslandSpec;
  /** Convert a screen-pixel point to a world-tile point (fed by main.ts
   *  using the camera). */
  screenToWorldTile(screenX: number, screenY: number): { x: number; y: number };
  /** Call when discovery or fleet state changed enough that the ocean +
   *  island layers should be rebuilt. main.ts owns the rebuild logic; we
   *  just nudge it. */
  onDiscoveryChanged(): void;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------
export function mountDronesUi(parentEl: HTMLElement, deps: DroneUiDeps): DroneUiHandle {
  let visible = false;
  let launchMode = false;
  let fuelLoaded = 20; // sane default — 80 tiles round-trip, 40 tiles outbound

  // -------------------------------------------------------------------------
  // Side dock panel
  // -------------------------------------------------------------------------
  const panel = document.createElement('div');
  panel.id = 'drones-panel';
  styled(
    panel,
    [
      'position: fixed',
      'top: 50%',
      'left: 8px',
      'transform: translateY(-50%)',
      'width: 248px',
      'max-height: calc(100vh - 32px)',
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
  headTitle.textContent = 'DRONE OPS';
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
  headSub.textContent = 'DSP-01';
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
    hide();
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

  // Body
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

  // -------------------------------------------------------------------------
  // Stat block — BIOFUEL / RANGE / ETA / TIER
  // -------------------------------------------------------------------------
  const statBlock = document.createElement('div');
  styled(
    statBlock,
    [
      'display: grid',
      'grid-template-columns: 1fr 1fr',
      'gap: 4px 12px',
      'padding: 6px 8px',
      `border: 1px solid ${PANEL_BORDER}`,
      `background: ${STRIP_BG}`,
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
        `color: ${FG_DIM}`,
        'font-size: 9.5px',
        'letter-spacing: 0.1em',
        'text-transform: uppercase',
      ].join(';'),
    );
    const v = document.createElement('span');
    styled(v, `color: ${FG}; font-size: 11.5px; font-weight: 600`);
    row.appendChild(l);
    row.appendChild(v);
    return { row, valueEl: v };
  }

  const tierStat = statRow('TIER');
  tierStat.valueEl.textContent = 'T2';
  tierStat.valueEl.style.color = ACCENT;
  const fuelStat = statRow('BIOFUEL');
  const rangeStat = statRow('OUTBND');
  const etaStat = statRow('FLIGHT');

  statBlock.appendChild(tierStat.row);
  statBlock.appendChild(fuelStat.row);
  statBlock.appendChild(rangeStat.row);
  statBlock.appendChild(etaStat.row);

  body.appendChild(statBlock);

  // -------------------------------------------------------------------------
  // Fuel slider — stenciled tick rail
  // -------------------------------------------------------------------------
  const sliderWrap = document.createElement('div');
  styled(sliderWrap, 'display: flex; flex-direction: column; gap: 4px');

  const sliderHead = document.createElement('div');
  styled(sliderHead, 'display: flex; justify-content: space-between; align-items: baseline');
  const sliderHeadL = document.createElement('span');
  sliderHeadL.textContent = 'FUEL LOAD';
  styled(
    sliderHeadL,
    [
      `color: ${FG_DIM}`,
      'font-size: 9.5px',
      'letter-spacing: 0.12em',
    ].join(';'),
  );
  const sliderHeadR = document.createElement('span');
  styled(sliderHeadR, `color: ${WARN}; font-size: 11px; font-weight: 600`);
  sliderHead.appendChild(sliderHeadL);
  sliderHead.appendChild(sliderHeadR);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(MIN_FUEL_PER_DRONE);
  slider.max = String(MAX_FUEL_PER_DRONE);
  slider.step = '5';
  slider.value = String(fuelLoaded);
  styled(
    slider,
    [
      'width: 100%',
      'height: 18px',
      'background: transparent',
      'cursor: pointer',
      'accent-color: #7dd3e8',
    ].join(';'),
  );
  slider.addEventListener('input', () => {
    fuelLoaded = Number(slider.value);
    refresh(performance.now());
  });

  // Tick rail underneath the slider — stencil/printed feel.
  const tickRail = document.createElement('div');
  styled(
    tickRail,
    [
      'display: flex',
      'justify-content: space-between',
      `color: ${FG_MUTED}`,
      'font-size: 9px',
      'letter-spacing: 0.08em',
      'padding: 0 2px',
    ].join(';'),
  );
  for (const v of [10, 20, 30, 40, 50]) {
    const t = document.createElement('span');
    t.textContent = String(v);
    tickRail.appendChild(t);
  }

  sliderWrap.appendChild(sliderHead);
  sliderWrap.appendChild(slider);
  sliderWrap.appendChild(tickRail);
  body.appendChild(sliderWrap);

  // -------------------------------------------------------------------------
  // Arm-launch button — toggles canvas reticle mode
  // -------------------------------------------------------------------------
  const armBtn = document.createElement('button');
  styled(
    armBtn,
    [
      'background: #1a1f2a',
      `color: ${FG}`,
      `border: 1px solid ${PANEL_BORDER}`,
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

  function setLaunchMode(on: boolean): void {
    launchMode = on;
    if (on) {
      armBtn.textContent = '◆ DISARM';
      armBtn.style.color = WARN;
      armBtn.style.borderColor = WARN;
      armBtn.style.background = 'rgba(245, 167, 66, 0.08)';
      reticleLayer.visible = true;
    } else {
      armBtn.textContent = '◇ ARM LAUNCH';
      armBtn.style.color = FG;
      armBtn.style.borderColor = PANEL_BORDER;
      armBtn.style.background = '#1a1f2a';
      reticleLayer.visible = false;
    }
  }

  // -------------------------------------------------------------------------
  // Active flights ledger
  // -------------------------------------------------------------------------
  const ledgerWrap = document.createElement('div');
  styled(ledgerWrap, 'display: flex; flex-direction: column; gap: 4px');

  const ledgerHead = document.createElement('div');
  styled(
    ledgerHead,
    [
      'display: flex',
      'justify-content: space-between',
      'align-items: baseline',
      `border-bottom: 1px solid ${PANEL_BORDER}`,
      'padding-bottom: 3px',
    ].join(';'),
  );
  const ledgerL = document.createElement('span');
  ledgerL.textContent = 'FLIGHTS';
  styled(
    ledgerL,
    [
      `color: ${ACCENT}`,
      'font-size: 10px',
      'font-weight: 600',
      'letter-spacing: 0.18em',
    ].join(';'),
  );
  const ledgerR = document.createElement('span');
  styled(ledgerR, `color: ${FG_DIM}; font-size: 9.5px; letter-spacing: 0.08em`);
  ledgerHead.appendChild(ledgerL);
  ledgerHead.appendChild(ledgerR);

  const ledgerList = document.createElement('div');
  styled(ledgerList, 'display: flex; flex-direction: column; gap: 4px; min-height: 24px');

  const ledgerEmpty = document.createElement('div');
  ledgerEmpty.textContent = 'no active flights';
  styled(
    ledgerEmpty,
    [
      `color: ${FG_MUTED}`,
      'font-size: 10px',
      'letter-spacing: 0.06em',
      'font-style: italic',
      'padding: 8px 4px',
    ].join(';'),
  );

  ledgerWrap.appendChild(ledgerHead);
  ledgerWrap.appendChild(ledgerList);
  body.appendChild(ledgerWrap);

  // -------------------------------------------------------------------------
  // Footer hint strip
  // -------------------------------------------------------------------------
  const footer = document.createElement('div');
  styled(
    footer,
    [
      'padding: 6px 12px',
      `border-top: 1px solid ${PANEL_BORDER}`,
      `background: ${STRIP_BG}`,
      `color: ${FG_DIM}`,
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

  // -------------------------------------------------------------------------
  // Pixi layer: in-flight drone dots + breadcrumb trail
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Pixi layer: launch reticle (screen space, NOT inside world container)
  // -------------------------------------------------------------------------
  // The reticle is drawn at fixed screen-pixel size irrespective of zoom.
  // It lives outside the camera's transform so 1px lines stay 1px.
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

  function setReticleScreenPos(x: number, y: number): void {
    if (!launchMode) return;
    reticleGfx.position.set(x, y);
    // Update colour: amber when the cursor's world-tile distance from the
    // home origin exceeds the configured outbound range, cyan otherwise.
    const wp = deps.screenToWorldTile(x, y);
    const dx = wp.x - deps.homeSpec.cx;
    const dy = wp.y - deps.homeSpec.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const outbound = (fuelLoaded * DRONE_TIER_EFFICIENCY) / 2;
    ensurePainted(dist > outbound ? RETICLE_WARN : RETICLE_OK);
  }
  function hideReticleFn(): void {
    reticleGfx.position.set(-9999, -9999);
  }

  // -------------------------------------------------------------------------
  // Drone dot rendering
  // -------------------------------------------------------------------------
  function renderDroneDot(d: Drone, nowMs: number): Container {
    const c = new Container();
    c.label = `drone:${d.id}`;
    const pos = droneCurrentPosition(d, nowMs);
    const wpx = pos.x * TILE_PX;
    const wpy = pos.y * TILE_PX;

    // Trail (drawn under the dot)
    const tr = ensureTrail(d);
    if (tr.points.length === 0 || nowMs - (tr.points[tr.points.length - 1]?.t ?? 0) >= TRAIL_SAMPLE_MS) {
      tr.points.push({ x: wpx, y: wpy, t: nowMs });
      if (tr.points.length > TRAIL_MAX_POINTS) tr.points.shift();
    }
    const trailG = new Graphics();
    const n = tr.points.length;
    for (let i = 0; i < n; i++) {
      const p = tr.points[i]!;
      // Older points more transparent — alpha ramps from ~0.1 (oldest) to
      // ~0.55 (most recent), each dot 2×2 px in world space.
      const alpha = 0.1 + (0.45 * (i + 1)) / n;
      trailG.rect(p.x - 1, p.y - 1, 2, 2).fill({ color: VISION_BLUE, alpha });
    }
    c.addChild(trailG);

    // Drone dot — 4×4 cyan pixel with a 2×2 white-cyan core.
    const dotG = new Graphics();
    dotG.rect(wpx - 2, wpy - 2, 4, 4).fill({ color: VISION_BLUE, alpha: 1 });
    dotG.rect(wpx - 1, wpy - 1, 2, 2).fill({ color: 0xffffff, alpha: 0.9 });
    c.addChild(dotG);

    return c;
  }

  /** Rebuild the drone dot layer from scratch each frame. Cheap because
   *  there are at most O(small) drones in flight; redrawing avoids any
   *  diffing logic and matches how the per-frame ticker repaints the world
   *  container in main.ts. */
  function repaintDroneLayer(nowMs: number): void {
    droneLayer.removeChildren();
    for (const d of deps.world.drones) {
      droneLayer.addChild(renderDroneDot(d, nowMs));
    }
    // Drop trail buffers for drones that no longer exist.
    for (const id of trails.keys()) {
      if (!deps.world.drones.some((d) => d.id === id)) trails.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Active flights ledger renderer
  // -------------------------------------------------------------------------
  function repaintLedger(nowMs: number): void {
    ledgerList.replaceChildren();
    if (deps.world.drones.length === 0) {
      ledgerList.appendChild(ledgerEmpty);
      ledgerR.textContent = '0 / 1';
      return;
    }
    ledgerR.textContent = `${deps.world.drones.length} / 1`;
    for (const d of deps.world.drones) {
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
        `border-left: 2px solid ${ACCENT_DIM}`,
        `background: rgba(125, 211, 232, 0.04)`,
      ].join(';'),
    );

    const top = document.createElement('div');
    styled(top, 'display: flex; justify-content: space-between; align-items: baseline');
    const idEl = document.createElement('span');
    idEl.textContent = d.id.toUpperCase();
    styled(idEl, `color: ${ACCENT}; font-size: 10px; letter-spacing: 0.08em; font-weight: 600`);
    const etaEl = document.createElement('span');
    const remainSec = Math.max(0, (d.expectedReturnTime - nowMs) / 1000);
    etaEl.textContent = `T-${remainSec.toFixed(1)}s`;
    styled(etaEl, `color: ${WARN}; font-size: 10px; font-weight: 600`);
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
        `background: ${RAIL}`,
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
        `background: ${WARN}`,
        `width: ${(pct * 100).toFixed(2)}%`,
      ].join(';'),
    );
    ruleWrap.appendChild(ruleFill);

    const meta = document.createElement('div');
    styled(meta, 'display: flex; justify-content: space-between');
    const fuelEl = document.createElement('span');
    fuelEl.textContent = `${d.fuelLoaded} fuel · ${d.outboundTiles.toFixed(0)} tiles`;
    styled(fuelEl, `color: ${FG_DIM}; font-size: 9.5px`);
    const tierEl = document.createElement('span');
    tierEl.textContent = `T${d.tier}`;
    styled(tierEl, `color: ${FG_DIM}; font-size: 9.5px; letter-spacing: 0.06em`);
    meta.appendChild(fuelEl);
    meta.appendChild(tierEl);

    row.appendChild(top);
    row.appendChild(ruleWrap);
    row.appendChild(meta);
    return row;
  }

  // -------------------------------------------------------------------------
  // refresh()
  // -------------------------------------------------------------------------
  function refresh(nowMs: number): void {
    // Stat block always tracks the current slider.
    const onhand = inv(deps.home, 'biofuel');
    fuelStat.valueEl.textContent = `${onhand.toFixed(0)} u`;
    fuelStat.valueEl.style.color = onhand >= fuelLoaded ? FG : WARN;
    sliderHeadR.textContent = `${fuelLoaded} u`;
    rangeStat.valueEl.textContent = `${(fuelLoaded * DRONE_TIER_EFFICIENCY) / 2} t`;
    const flightSec = (fuelLoaded * DRONE_TIER_EFFICIENCY) / DRONE_SPEED_TILES_PER_SEC;
    etaStat.valueEl.textContent = `${flightSec.toFixed(0)}s`;

    // Disable the arm button if not enough fuel or already in flight.
    const inFlight = deps.world.drones.some((d) => d.fromIslandId === deps.home.id);
    const canLaunch = onhand >= fuelLoaded && !inFlight;
    armBtn.disabled = !canLaunch;
    armBtn.style.opacity = canLaunch ? '1' : '0.5';
    armBtn.style.cursor = canLaunch ? 'pointer' : 'not-allowed';
    if (!canLaunch && launchMode) setLaunchMode(false);

    repaintLedger(nowMs);
    repaintDroneLayer(nowMs);
  }

  function show(): void {
    if (visible) return;
    visible = true;
    panel.style.display = 'flex';
    refresh(performance.now());
  }
  function hide(): void {
    if (!visible) return;
    visible = false;
    panel.style.display = 'none';
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
    const ox = deps.homeSpec.cx;
    const oy = deps.homeSpec.cy;
    const dx = targetWorldTileX - ox;
    const dy = targetWorldTileY - oy;
    const r = dispatchDrone(deps.world, deps.home, ox, oy, dx, dy, fuelLoaded, nowMs);
    if (r.ok) {
      setLaunchMode(false);
      refresh(nowMs);
      return { ok: true };
    }
    return { ok: false, reason: r.reason };
  }

  return {
    refresh,
    show,
    hide,
    toggle,
    isVisible: () => visible,
    isLaunchMode: () => launchMode,
    setReticleScreenPos,
    hideReticle: hideReticleFn,
    attemptLaunch,
    droneLayer,
    reticleLayer,
  };
}

