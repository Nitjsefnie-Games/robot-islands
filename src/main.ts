// Robot Islands — step 2 bootstrap.
//
// Camera + multi-island map + vision states + config-driven input. The world
// container's position/scale is now driven by the camera state every frame;
// no more "recenter on resize" call.
//
// Vision model: each island is classified into one of three render states
// (visible / discovered / unknown) and rendered accordingly:
//   - visible    → full color/alpha
//   - discovered → dimmed + cool tint (player knows it exists, no current info)
//   - unknown    → not rendered (dark page background shows through)
//
// Vision boundary: rendered as a three-tier ocean colour field (see
// `ocean.ts`). The colour step between tiers IS the boundary indicator —
// no outline ring. The ocean layer sits below islands so islands always
// render on top of it. Per-island alpha/tint dimming on 'discovered'
// islands stays as a complementary indicator: ocean colour shows the
// world's vision state at that point, island dimming shows that island's
// known state.

import { Application, Container } from 'pixi.js';

import {
  centerOn,
  clampZoom,
  makeCamera,
  pan as panCam,
  zoomAt,
  type Camera,
} from './camera.js';
import { effectiveModifierMultipliers, type ModifierMultipliers } from './biomes.js';
import { advanceIsland, computeRates, type IslandState } from './economy.js';
import { computeNcState } from './network-consciousness.js';
import {
  effectiveSpecializationMultipliers,
  IDENTITY_SPECIALIZATION,
  type SpecializationMultipliers,
} from './specialization.js';
import { tierForLevel } from './skilltree.js';
import { renderCellGrid } from './grid.js';
import { mountHud } from './hud.js';
import {
  bind,
  defineAction,
  dispatchKey,
  installDefaultBindings,
  makeRegistry,
} from './input.js';
import { TILE_PX } from './island.js';
import { renderOcean } from './ocean.js';
import { mountBuildingsUi } from './buildings-ui.js';
import { mountSkillTreeUi } from './skilltree-ui.js';
import { mountUi } from './ui.js';
import {
  islandRenderState,
  makeInitialIslandState,
  makeInitialWorld,
  renderIsland,
  VISION_RADIUS_TILES,
  type IslandSpec,
  type WorldState,
} from './world.js';
import { mountDronesUi } from './drones-ui.js';
import { tickDrones } from './drones.js';
import { makeIslandScreenPosResolver, mountRoutesUi } from './routes-ui.js';
import { tickRoutes } from './routes.js';

/** Pan speed for keyboard input, in screen-pixels-per-frame. */
const PAN_PX_PER_TICK = 8;
/** Zoom step for keyboard +/-. Multiplicative. */
const KEY_ZOOM_STEP = 1.1;
/** Zoom step for wheel events. Multiplicative per wheel delta unit. */
const WHEEL_ZOOM_STEP = 1.0015;
/** World half-extent (tiles) for the cell-grid overlay. Covers the demo area
 *  plus margin; with R=16 the cell grid still spans many cells. */
const WORLD_HALF_SIZE_TILES = 250;

async function main(): Promise<void> {
  const mountEl = document.getElementById('app');
  if (!mountEl) throw new Error('main: missing #app mount element');

  const app = new Application();
  await app.init({
    background: '#0a0e14',
    resizeTo: window,
    antialias: false,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  mountEl.appendChild(app.canvas);

  // World container — everything in world space lives under here. The camera
  // controls its position and scale; we re-sync once per frame in the ticker.
  const world = new Container();
  world.label = 'world';
  app.stage.addChild(world);

  // World state — mutable wrapper around the seed island data + the in-flight
  // drone fleet. `discovered` flags flip when drones return; `drones` mutates
  // on dispatch and tick. Renderer reads from here.
  const worldState: WorldState = makeInitialWorld(performance.now());

  // Ocean + island layers are baked from the current world state. They get
  // rebuilt when discovery changes (drone return reveals new islands → new
  // gradient sprites + new island terrain). `let` so the rebuild closure
  // can reassign the references; we keep them at fixed Z by removing the
  // old child + adding the new at the same index.
  let oceanLayer = renderOceanFromState(worldState, WORLD_HALF_SIZE_TILES);
  world.addChild(oceanLayer);
  let islandLayer = renderIslandLayer(worldState);
  world.addChild(islandLayer);

  // Cell grid (debug). Above ocean+islands so lines stay visible when toggled.
  const gridLayer = renderCellGrid(WORLD_HALF_SIZE_TILES);
  world.addChild(gridLayer);

  /** Helpers — bake an ocean layer from current world state. */
  function renderOceanFromState(ws: WorldState, halfSize: number): Container {
    return renderOcean(
      ws.islands.map((s) => ({
        cx: s.cx,
        cy: s.cy,
        discovered: s.discovered,
        populated: s.populated,
      })),
      halfSize,
    );
  }
  function renderIslandLayer(ws: WorldState): Container {
    const layer = new Container();
    layer.label = 'islands';
    const populated = ws.islands.filter((s) => s.populated);
    const populatedCentres = populated.map((s) => ({ cx: s.cx, cy: s.cy }));
    for (const spec of ws.islands) {
      const state = islandRenderState(spec, populatedCentres, VISION_RADIUS_TILES);
      const c = renderIsland(spec, state);
      if (c) layer.addChild(c);
    }
    return layer;
  }
  /** Rebuild ocean + island layers in place. Called when drones return and
   *  reveal new islands. The PixiJS Texture cache for gradient sprites isn't
   *  freed here — `oldOcean.destroy({ children: true, texture: true })` is
   *  the explicit GPU-cleanup hook so the textures from the previous bake
   *  don't leak across many discovery events. */
  function rebuildWorldLayers(): void {
    const oldOcean = oceanLayer;
    const oldIslands = islandLayer;
    oceanLayer = renderOceanFromState(worldState, WORLD_HALF_SIZE_TILES);
    islandLayer = renderIslandLayer(worldState);
    // Insert at the same Z slots: ocean at 0, islands at 1.
    world.removeChild(oldOcean);
    world.removeChild(oldIslands);
    world.addChildAt(oceanLayer, 0);
    world.addChildAt(islandLayer, 1);
    oldOcean.destroy({ children: true, texture: true });
    oldIslands.destroy({ children: true });
  }

  // -----------------------------------------------------------------------
  // Camera + input
  // -----------------------------------------------------------------------
  const cam: Camera = makeCamera(0, 0, 1);
  // app.renderer.screen is in CSS pixels (it tracks the resize callback's
  // screenWidth/screenHeight). app.renderer.width is in *device* pixels with
  // autoDensity + DPR scaling, so don't use that for camera math — DOM mouse
  // events and Pixi's world transform are both in CSS pixels.
  const viewportCentre = (): { x: number; y: number } => ({
    x: app.renderer.screen.width / 2,
    y: app.renderer.screen.height / 2,
  });
  // Initial centring on home (world origin).
  centerOn(cam, { x: 0, y: 0 }, viewportCentre());

  const reg = makeRegistry();
  installDefaultBindings(reg);

  // Keyboard pan state: track which pan actions are "held". The keyup handler
  // resets these. WASD/Arrow keys flip flags, ticker applies movement.
  const held = {
    up: false,
    down: false,
    left: false,
    right: false,
  };
  defineAction(reg, 'pan-up', () => (held.up = true));
  defineAction(reg, 'pan-down', () => (held.down = true));
  defineAction(reg, 'pan-left', () => (held.left = true));
  defineAction(reg, 'pan-right', () => (held.right = true));
  defineAction(reg, 'zoom-in', () => {
    zoomAt(cam, viewportCentre(), clampZoom(cam.zoom * KEY_ZOOM_STEP));
  });
  defineAction(reg, 'zoom-out', () => {
    zoomAt(cam, viewportCentre(), clampZoom(cam.zoom / KEY_ZOOM_STEP));
  });
  defineAction(reg, 'center-home', () => {
    centerOn(cam, { x: 0, y: 0 }, viewportCentre());
  });
  defineAction(reg, 'toggle-grid', () => {
    gridLayer.visible = !gridLayer.visible;
  });
  // toggle-skill-tree handler is wired below once the home state exists; the
  // action name is reserved here as a no-op stub so the binding never points
  // at an undefined action (dispatch would silently fail otherwise).
  defineAction(reg, 'toggle-skill-tree', () => undefined);
  defineAction(reg, 'toggle-buildings', () => undefined);
  defineAction(reg, 'dismiss-modal', () => undefined);
  // Same pattern for drone ops: stub registered here, real handler bound
  // after the UI is mounted (which needs `homeState`).
  defineAction(reg, 'toggle-drones', () => undefined);
  defineAction(reg, 'toggle-routes', () => undefined);

  // Map of "release" actions used to clear the held flag on keyup. The
  // action table itself is press-only; on keyup we resolve the binding and
  // clear the corresponding flag manually.
  const releaseHandlers: Record<string, () => void> = {
    'pan-up': () => (held.up = false),
    'pan-down': () => (held.down = false),
    'pan-left': () => (held.left = false),
    'pan-right': () => (held.right = false),
  };

  // Keyboard event hookup. The handler is config-driven: it never inspects
  // `e.code` against hardcoded strings — it just hands off to the registry.
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return; // pan flags are level-triggered; no need to spam.
    if (dispatchKey(reg, e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    const action = reg.bindings.get(e.code);
    if (action && releaseHandlers[action]) {
      releaseHandlers[action]();
      e.preventDefault();
    }
  });

  // Mouse drag pan. Distinguish "drag" from "click" via a small movement
  // threshold so a stray click doesn't reset state.
  //
  // Step 6: launch-mode click disambiguation. While drone-ops launch mode is
  // armed, a small click (total drag distance < CLICK_DRAG_PX_MAX) commits
  // a launch target; a larger drag still pans. We track total drag distance
  // (not displacement) so a circular gesture returning to the start still
  // counts as a drag. The launch dispatch happens on mouseup, after we know
  // the gesture wasn't a drag.
  const CLICK_DRAG_PX_MAX = 5;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let accumDrag = 0;
  app.canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    accumDrag = 0;
  });
  window.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    // Launch-click commit: only fire if the gesture was a click (total drag
    // distance < threshold, NOT just net displacement — a circular gesture
    // returning to start is still a drag) AND launch mode is armed AND the
    // mousedown originated on the canvas (we only set `dragging = true` from
    // the canvas mousedown, so a `dragging` mouseup IS a canvas-originated
    // gesture).
    if (accumDrag < CLICK_DRAG_PX_MAX && dronesUi.isLaunchMode()) {
      const rect = app.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      // Reject mouseups outside the canvas — releasing on a side dock or off
      // the window shouldn't commit a launch even if the drag was tiny.
      if (sx < 0 || sx > rect.width || sy < 0 || sy > rect.height) return;
      const wp = screenToWorldTile(sx, sy);
      dronesUi.attemptLaunch(wp.x, wp.y, performance.now());
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    accumDrag += Math.abs(dx) + Math.abs(dy);
    panCam(cam, dx, dy);
  });

  /** Convert screen pixels (canvas-local) to world tile coordinates. The
   *  camera maps world pixels → screen; world pixels → tiles is `/ TILE_PX`. */
  function screenToWorldTile(screenX: number, screenY: number): { x: number; y: number } {
    // Inverse of the camera transform.
    const wpx = (screenX - cam.tx) / cam.zoom;
    const wpy = (screenY - cam.ty) / cam.zoom;
    return { x: wpx / TILE_PX, y: wpy / TILE_PX };
  }
  // Reticle follows the cursor while in launch mode. Mousemove on the canvas
  // updates its screen position; mouseleave hides it.
  app.canvas.addEventListener('mousemove', (e) => {
    if (!dronesUi.isLaunchMode()) return;
    const rect = app.canvas.getBoundingClientRect();
    dronesUi.setReticleScreenPos(e.clientX - rect.left, e.clientY - rect.top);
  });
  app.canvas.addEventListener('mouseleave', () => {
    dronesUi.hideReticle();
  });

  // Wheel zoom toward cursor. preventDefault keeps the page from scrolling.
  app.canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // Cursor position relative to canvas (the canvas itself is at 0,0 of
      // the document layout in our setup, but we use bounding rect to be
      // safe against future style changes).
      const rect = app.canvas.getBoundingClientRect();
      const pivot = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      // Negative deltaY = wheel up = zoom in (intuitive).
      const factor = Math.pow(WHEEL_ZOOM_STEP, -e.deltaY);
      zoomAt(cam, pivot, cam.zoom * factor);
    },
    { passive: false },
  );

  // UI overlay
  mountUi(document.body, reg, [
    { label: 'Toggle Grid (G)', action: 'toggle-grid' },
    { label: 'Center on Home (H)', action: 'center-home' },
    { label: 'Skill Tree (K)', action: 'toggle-skill-tree' },
    { label: 'Buildings (B)', action: 'toggle-buildings' },
    { label: 'Drones (J)', action: 'toggle-drones' },
    { label: 'Routes (R)', action: 'toggle-routes' },
  ]);

  // -----------------------------------------------------------------------
  // Economy state — multi-island
  // -----------------------------------------------------------------------
  //
  // Step 7 promotes the single `homeState` to a Map keyed by island id, so
  // routes can dispatch between any two populated islands. The HUD still
  // tracks the home island only — multi-island HUD is a deferred step-14
  // polish concern. `forest-ne` is hardcoded populated for the step-7 demo
  // (see `world.ts`); settlement vehicles per §12 are deferred.
  const islandStates = new Map<string, IslandState>();
  const homeSpec = worldState.islands.find((s) => s.id === 'home');
  if (!homeSpec) throw new Error('main: home island missing from worldState');
  const homeState = makeInitialIslandState(homeSpec, performance.now());
  islandStates.set('home', homeState);
  for (const spec of worldState.islands) {
    if (spec.id === 'home') continue;
    if (!spec.populated) continue;
    islandStates.set(spec.id, makeInitialIslandState(spec, performance.now()));
  }
  // Spec lookup by id — also needed by routes UI later. Built once; spec
  // identity is stable across the session (drones flip discovered, but
  // spec objects themselves aren't replaced).
  const islandSpecsById = new Map<string, IslandSpec>();
  for (const s of worldState.islands) islandSpecsById.set(s.id, s);
  // Precomputed modifier multipliers keyed by island id. Modifier sets are
  // immutable in step 8 (no rerolls, no random events firing yet), so we
  // bake them once and reuse every frame instead of re-folding every tick.
  const modifierMulsById = new Map<string, ModifierMultipliers>();
  for (const spec of worldState.islands) {
    modifierMulsById.set(spec.id, effectiveModifierMultipliers(spec.modifiers));
  }
  /** Helper: look up modifier multipliers for an island state, falling back
   *  to identity if the spec is missing (shouldn't happen — every state has
   *  a corresponding spec — but keeps the type safe). */
  const modifierMulFor = (id: string): ModifierMultipliers =>
    modifierMulsById.get(id) ?? effectiveModifierMultipliers([]);

  // HUD: bottom-right panel showing inventory, rates, and level. Updated
  // once per frame inside the ticker after the economy advance.
  const hud = mountHud(document.body);

  // Skill tree panel — modal-ish DOM overlay, dismissed via KeyK, Escape,
  // or its close button. Hooks the previously-stubbed `toggle-skill-tree`
  // action.
  const skillTree = mountSkillTreeUi(document.body, homeState);
  defineAction(reg, 'toggle-skill-tree', () => {
    skillTree.toggle();
  });

  // Buildings catalog — sister modal panel to the skill tree. KeyB toggles;
  // Escape routes to whichever modal is visible (`dismiss-modal` below).
  const buildingsUi = mountBuildingsUi(document.body, homeState);
  defineAction(reg, 'toggle-buildings', () => {
    buildingsUi.toggle();
  });

  // Generic modal dismissal: hide whichever modal is open. Both modals'
  // hide() are idempotent, so the no-modal-open case is a free no-op.
  // Mutual-exclusion isn't enforced — if both happen to be open Escape
  // closes both at once.
  defineAction(reg, 'dismiss-modal', () => {
    skillTree.hide();
    buildingsUi.hide();
  });

  // Drone-ops side dock + canvas reticle + drone-dot layer.
  const dronesUi = mountDronesUi(document.body, {
    world: worldState,
    home: homeState,
    homeSpec,
    screenToWorldTile,
    onDiscoveryChanged: rebuildWorldLayers,
  });
  // Drone dots live in world space (between islands and the cell grid so
  // they sit above land, below debug overlay).
  world.addChildAt(dronesUi.droneLayer, 2);
  // Reticle lives in screen space (NOT world container) so it stays a
  // fixed-pixel crosshair regardless of zoom.
  app.stage.addChild(dronesUi.reticleLayer);
  defineAction(reg, 'toggle-drones', () => {
    dronesUi.toggle();
  });

  // Routes (freight-grid) side dock + screen-space route line + chevron layer.
  // Lives in screen space (same discipline as the drone reticle): stroke
  // widths stay 1.5px / chevrons stay ~10px regardless of zoom. Endpoint
  // screen positions are computed each frame via the camera transform.
  // (`islandSpecsById` is built earlier — same Map shared with the modifier-
  // multiplier cache.)
  const routesUi = mountRoutesUi(document.body, {
    world: worldState,
    islandStates,
    islandSpecs: islandSpecsById,
  });
  routesUi.setIslandScreenPosResolver(
    makeIslandScreenPosResolver(islandSpecsById, cam),
  );
  app.stage.addChild(routesUi.routeLayer);
  defineAction(reg, 'toggle-routes', () => {
    routesUi.toggle();
  });

  // Update tick: apply held pan flags + sync camera state to the world
  // container, advance every populated island's economy, advance drone fleet,
  // advance inter-island routes, and update the HUD + side panels. One pass
  // per frame keeps the camera→container assignment cheap and predictable;
  // `advanceIsland`'s piecewise integration handles whatever elapsed interval
  // the frame brings (matters on tab-blur catch-up).
  let lastFrameMs = performance.now();
  app.ticker.add(() => {
    let dx = 0;
    let dy = 0;
    if (held.up) dy += PAN_PX_PER_TICK;
    if (held.down) dy -= PAN_PX_PER_TICK;
    if (held.left) dx += PAN_PX_PER_TICK;
    if (held.right) dx -= PAN_PX_PER_TICK;
    if (dx !== 0 || dy !== 0) panCam(cam, dx, dy);
    world.position.set(cam.tx, cam.ty);
    world.scale.set(cam.zoom);

    const now = performance.now();
    const elapsedSec = Math.max(0, (now - lastFrameMs) / 1000);
    lastFrameMs = now;
    // Compute Network Consciousness state once per frame from the current
    // island set. §9.6 buff applies only to T3+ islands; per-island gating
    // happens at the call site below (not inside advanceIsland) so the
    // pure economy doesn't take a dependency on `tierForLevel`.
    const ncState = computeNcState(islandStates);
    // Specialization multipliers depend only on `state.specializationRole`,
    // which is mutable from the UI. Recompute per-island per-frame; the
    // fold is constant-cost and pre-baking it would require invalidation
    // plumbing on the declare-role callback.
    const specMulFor = (s: IslandState): SpecializationMultipliers =>
      s.specializationRole === null
        ? IDENTITY_SPECIALIZATION
        : effectiveSpecializationMultipliers(s.specializationRole);
    const ncBuffFor = (s: IslandState): number =>
      tierForLevel(s.level) >= 3 ? ncState.globalProductionBuff : 1;
    // Advance every populated island in turn. Routes are dispatched AFTER
    // advance so the per-island production from this frame is visible to
    // route dispatch; deliveries handed back to the next frame's advance
    // get consumed (and the funnel-pending credit drained) on that frame.
    // Each island's modifier set composes its own recipe-rate multipliers,
    // so we look up the precomputed bundle by id and pass it through.
    for (const s of islandStates.values()) {
      advanceIsland(s, now, { modifierMul: modifierMulFor(s.id), specMul: specMulFor(s), ncBuff: ncBuffFor(s) });
    }
    // Drones tick AFTER economy so any biofuel changes from this frame
    // are visible to the dispatch UI on the same frame; drone returns
    // are processed independent of economy state.
    const droneResult = tickDrones(worldState, now);
    if (droneResult.newlyDiscoveredIslandIds.length > 0) {
      rebuildWorldLayers();
    }
    tickRoutes(worldState, islandStates, now, elapsedSec);

    // Recompute rates AFTER the tick so the HUD shows the current
    // post-advance state (e.g., a freshly-stalled building reads as
    // 0 rate, not the rate it was running at one event ago).
    const { net, power } = computeRates(homeState, {
      modifierMul: modifierMulFor(homeState.id),
      specMul: specMulFor(homeState),
      ncBuff: ncBuffFor(homeState),
    });
    hud.update(homeState, net, power, homeSpec, ncState);
    // Skill tree only repaints while visible — DOM writes are wasted
    // otherwise. show() also forces a paint on transition so we don't
    // strictly need a per-frame call, but level-up while the panel is open
    // should be reflected in the points / xp counters live.
    skillTree.refresh();
    buildingsUi.refresh();
    dronesUi.refresh(now);
    routesUi.refresh(now);
  });

  // Recenter the camera's reference point on resize so the world doesn't
  // jump unexpectedly: keep the world point currently at the old centre
  // visually at the new centre. screen.width/.height are CSS pixels (same
  // units as the camera's tx/ty), unlike renderer.width which is device px.
  let prevW = app.renderer.screen.width;
  let prevH = app.renderer.screen.height;
  app.renderer.on('resize', () => {
    const w = app.renderer.screen.width;
    const h = app.renderer.screen.height;
    cam.tx += (w - prevW) / 2;
    cam.ty += (h - prevH) / 2;
    prevW = w;
    prevH = h;
  });

  // expose for ad-hoc debugging in dev tools
  if (import.meta.env.DEV) {
    (window as unknown as { __cam: Camera }).__cam = cam;
    (window as unknown as { __reg: typeof reg }).__reg = reg;
    (window as unknown as { __home: typeof homeState }).__home = homeState;
    void bind; // referenced for rebind-from-console workflows
    void TILE_PX;
  }
}

main().catch((err: unknown) => {
  console.error('[robot-islands] fatal:', err);
});
