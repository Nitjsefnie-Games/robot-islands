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
import { advanceIsland, computeRates } from './economy.js';
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
import { mountSkillTreeUi } from './skilltree-ui.js';
import { mountUi } from './ui.js';
import {
  DEMO_ISLANDS,
  islandRenderState,
  makeInitialIslandState,
  renderIsland,
  VISION_RADIUS_TILES,
} from './world.js';

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

  // Ocean layer (BOTTOM). Three-tier coloured field: unknown rect → discovered
  // circles → vision circles. Added first so islands draw on top.
  const oceanLayer = renderOcean(
    DEMO_ISLANDS.map((s) => ({
      cx: s.cx,
      cy: s.cy,
      discovered: s.discovered,
      populated: s.populated,
    })),
    WORLD_HALF_SIZE_TILES,
  );
  world.addChild(oceanLayer);

  // Island layer (terrain + buildings for each visible island).
  const islandLayer = new Container();
  islandLayer.label = 'islands';
  world.addChild(islandLayer);

  // Populated islands are vision sources. Each island is classified into
  // visible/discovered/unknown and rendered accordingly. Unknown islands are
  // skipped entirely (renderIsland returns null) so the dark page background
  // shows through.
  const populated = DEMO_ISLANDS.filter((s) => s.populated);
  const populatedCentres = populated.map((s) => ({ cx: s.cx, cy: s.cy }));
  const counts = { visible: 0, discovered: 0, unknown: 0 };
  for (const spec of DEMO_ISLANDS) {
    const state = islandRenderState(spec, populatedCentres, VISION_RADIUS_TILES);
    counts[state] += 1;
    const c = renderIsland(spec, state);
    if (c) islandLayer.addChild(c);
  }
  if (import.meta.env.DEV) {
    console.log(
      `[robot-islands] islands: ${counts.visible} visible, ${counts.discovered} discovered, ${counts.unknown} unknown`,
    );
  }

  // Cell grid (debug). Top of the world container so lines are always visible
  // when toggled on.
  const gridLayer = renderCellGrid(WORLD_HALF_SIZE_TILES);
  world.addChild(gridLayer);

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
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  app.canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    panCam(cam, dx, dy);
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
  ]);

  // -----------------------------------------------------------------------
  // Economy state — step 3
  // -----------------------------------------------------------------------
  //
  // Only the home island carries a tick-loop state for now. Multi-island
  // economies land when other islands become populated (deferred to a
  // later step). `lastTick` is seeded with the current performance.now()
  // so the first frame's `advanceIsland` call sees a zero-length interval.
  const homeSpec = DEMO_ISLANDS.find((s) => s.id === 'home');
  if (!homeSpec) throw new Error('main: home island missing from DEMO_ISLANDS');
  const homeState = makeInitialIslandState(homeSpec, performance.now());

  // HUD: bottom-right panel showing inventory, rates, and level. Updated
  // once per frame inside the ticker after the economy advance.
  const hud = mountHud(document.body);

  // Skill tree panel — modal-ish DOM overlay, dismissed via KeyK, Escape,
  // or its close button. Hooks the previously-stubbed `toggle-skill-tree`
  // action. `dismiss-skill-tree` is hide-only (idempotent on closed) so
  // Escape doesn't reopen a closed panel — standard modal etiquette.
  const skillTree = mountSkillTreeUi(document.body, homeState);
  defineAction(reg, 'toggle-skill-tree', () => {
    skillTree.toggle();
  });
  defineAction(reg, 'dismiss-skill-tree', () => {
    skillTree.hide();
  });

  // Update tick: apply held pan flags + sync camera state to the world
  // container, advance the home island's economy, and update the HUD.
  // One pass per frame keeps the camera->container assignment cheap and
  // predictable; `advanceIsland`'s piecewise integration handles whatever
  // elapsed interval the frame brings (matters on tab-blur catch-up).
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

    advanceIsland(homeState, performance.now());
    // Recompute rates AFTER the tick so the HUD shows the current
    // post-advance state (e.g., a freshly-stalled building reads as
    // 0 rate, not the rate it was running at one event ago).
    const { net, power } = computeRates(homeState);
    hud.update(homeState, net, power);
    // Skill tree only repaints while visible — DOM writes are wasted
    // otherwise. show() also forces a paint on transition so we don't
    // strictly need a per-frame call, but level-up while the panel is open
    // should be reflected in the points / xp counters live.
    skillTree.refresh();
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
