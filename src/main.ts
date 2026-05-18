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

import './ui.css';

import { Application, Container, Graphics } from 'pixi.js';

import { COLOR } from './ui-tokens.js';

import {
  centerOn,
  clampZoom,
  makeCamera,
  pan as panCam,
  zoomAt,
  type Camera,
} from './camera.js';
import { effectiveModifierMultipliers, type ModifierMultipliers } from './biomes.js';
import { advanceIsland, computeRates, type IslandState, type PowerBalance, type RatesContext } from './economy.js';
import type { ResourceId } from './recipes.js';
import { computeNcState } from './network-consciousness.js';
import {
  effectiveSpecializationMultipliers,
  IDENTITY_SPECIALIZATION,
  type SpecializationMultipliers,
} from './specialization.js';
import { tierForLevel } from './skilltree.js';
import { renderCellGrid } from './grid.js';
import { mountHud, mountIslandBar } from './hud.js';
import {
  bind,
  defineAction,
  dispatchKey,
  installDefaultBindings,
  makeRegistry,
} from './input.js';
import { TILE_PX } from './island.js';
import { computeVisionSources } from './lighthouse.js';
import { renderOcean, renderOceanFogOverlay } from './ocean.js';
import { loadPrefs, loadWorld, savePrefs, saveWorld } from './persistence.js';
import { mountSettingsUi } from './settings-ui.js';
import { BUILDING_DEFS } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import { mountBuildingsUi } from './buildings-ui.js';
import { mountConstructionUi } from './construction-ui.js';
import { mountInspectorUi, type InspectorTarget } from './inspector-ui.js';
import { expandIsland, type Axis } from './land-reclamation.js';
import { mountInventoryUi } from './inventory-ui.js';
import { buildingAtTile, demolishBuilding } from './placement.js';
import { footprintTiles, type Rotation } from './shape-mask.js';
import { mountPlacementUi } from './placement-ui.js';
import { mountSkillTreeUi } from './skilltree-ui.js';
import { mountGraphUi } from './graph-ui.js';
import { mountUi } from './ui.js';
import {
  findPopulatedIslandAt,
  islandRenderState,
  makeInitialIslandState,
  makeInitialWorld,
  renderIsland,
  tileToWorldPx,
  VISION_BLUE,
  type IslandSpec,
  type WorldState,
} from './world.js';
import { mountDronesUi } from './drones-ui.js';
import { tickDrones } from './drones.js';
import {
  effectiveSolarBoostFor,
  tickCommPackets,
  tickDebris,
  tickRepairDrones,
  tickSatMovement,
  tickScannerDiscovery,
  tickSweeperCleanup,
} from './orbital.js';
import { findNextMerge, performMerge } from './island-merge.js';
import { makeIslandScreenPosResolver, mountRoutesUi } from './routes-ui.js';
import { computeCableNetworkBalance, tickRoutes } from './routes.js';
import { computeLatticeActive, crossIslandNeighbors, latticeInventory, latticeStorageCaps } from './lattice.js';
import { mountSettlementUi } from './settlement-ui.js';
import { mountOrbitalUi } from './orbital-ui.js';
import { mountWeatherOverlay } from './weather-overlay.js';
import { mountAntennaOverlay } from './antenna-overlay.js';
import { mountTerrainTooltip } from './terrain-tooltip.js';
import { mountToastSurface } from './toast.js';
import { mountSatelliteOverlay } from './satellite-overlay.js';
import { mountBuildingAlertsOverlay } from './building-alerts-overlay.js';
import { mountDayNightTint } from './daynight-tint.js';
import { tickVehicles } from './settlement.js';
import { checkObjectives, type ObjectiveId } from './tutorial.js';
import { renderTutorialBanner } from './tutorial-ui.js';

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
    background: COLOR.void,
    resizeTo: window,
    // Visual polish: AA on for softer tile/building edges. Antialiased
    // PixiJS Graphics also smooths the small triangle markers used for
    // drones/vehicles and the building drop-shadow alphas.
    antialias: true,
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
  //
  // Step 14 (§15.6 persistence): try loadWorld() first. If a saved snapshot
  // exists and is the current schema version, restore both worldState and
  // islandStates from it; otherwise fall back to the existing demo-seed
  // path (makeInitialWorld + per-spec makeInitialIslandState + the
  // forest-ne T5/level-50 demo bumps). Either way, both bindings end up
  // populated before the renderer hooks up.
  const restored = await loadWorld();
  const worldState: WorldState = restored ? restored.world : makeInitialWorld(performance.now());
  // Load UI prefs (camera + active-island + open-panel) in parallel with
  // world; applied below after the camera is constructed.
  const restoredPrefs = await loadPrefs();

  // Ocean + island + fog-overlay layers are baked from the current world
  // state. They get rebuilt when discovery changes (drone-tick reveals new
  // cells, drone returns flip an island's `discovered` flag, etc.). `let`
  // so the rebuild closure can reassign the references; we keep them at
  // fixed Z by removing the old child + adding the new at the same index.
  //
  // §11 telemetry: the post-island fog overlay masks unrevealed cells of
  // partially-revealed islands so a drone that's only swept half of an
  // island still renders the swept half but leaves the rest dark.
  let oceanLayer = renderOceanFromState(worldState, WORLD_HALF_SIZE_TILES);
  world.addChild(oceanLayer);
  let islandLayer = renderIslandLayer(worldState);
  world.addChild(islandLayer);
  let fogOverlayLayer = renderFogOverlayFromState(worldState);
  world.addChild(fogOverlayLayer);
  // §2.6 weather overlay — translucent tint per cell within any populated
  // island's weather visibility range. Built once; refreshed via its own
  // throttle inside the ticker. Slot 3 — entity layers (drones/vehicles)
  // ride above so they remain visible through storms.
  const weatherOverlay = mountWeatherOverlay(worldState);
  world.addChild(weatherOverlay.layer);
  // §14 satellite + debris overlay — coloured dots at sat positions plus
  // coverage / comm rings. Appended after weather so sat markers stay
  // visible through storm tints.
  const satelliteOverlay = mountSatelliteOverlay(worldState);
  world.addChild(satelliteOverlay.layer);
  // §11 Antenna signal-range overlay — faint cyan rings around every
  // antenna so the player can see where drone scans actually transmit.
  // Sits between satellite-overlay and the satellite dots so signal rings
  // read cleanly without occluding sats.
  const antennaOverlay = mountAntennaOverlay(worldState);
  world.addChild(antennaOverlay.layer);
  // §2.7 day/night tint — full-viewport DOM overlay above the canvas,
  // pointer-events: none. Cheap diff-and-skip refresh per tick.
  const dayNightTint = mountDayNightTint(document.body);
  // Terrain hover tooltip — surfaces the terrain id and consumer-building
  // list when the cursor hovers a non-default tile.
  const terrainTooltip = mountTerrainTooltip(document.body);
  // Toast surface (top-center transient banners) — singleton, used by the
  // §14 launch flow and any future "global event" notifier.
  mountToastSurface(document.body);

  // Cell grid (debug). Above ocean+islands so lines stay visible when toggled.
  const gridLayer = renderCellGrid(WORLD_HALF_SIZE_TILES);
  world.addChild(gridLayer);

  /** Helpers — bake an ocean layer from current world state. The vision
   *  layer reads the world's `VisionSource[]` (baseline padded ellipses +
   *  Lighthouse circles), pre-computed from the same populated set the
   *  island classifier uses. The discovered cells tier reads
   *  `worldState.revealedCells` (the §11 per-cell discovery set). */
  function renderOceanFromState(ws: WorldState, halfSize: number): Container {
    const populated = ws.islands.filter((s) => s.populated);
    const visionSources = computeVisionSources(populated);
    return renderOcean(ws.revealedCells, visionSources, halfSize);
  }
  /** Bake the post-island fog overlay. One UNKNOWN_BLUE square per cell
   *  in a discovered island's footprint that isn't in `revealedCells`
   *  AND isn't currently lit by a vision source — without the vision
   *  exclusion, a freshly-discovered neighbour island's unrevealed
   *  footprint cells would paint over home's vision halo, producing the
   *  drone-discovery dark-grey-square bug. */
  function renderFogOverlayFromState(ws: WorldState): Container {
    const populated = ws.islands.filter((s) => s.populated);
    const visionSources = computeVisionSources(populated);
    return renderOceanFogOverlay(ws.islands, ws.revealedCells, visionSources);
  }
  function renderIslandLayer(ws: WorldState): Container {
    const layer = new Container();
    layer.label = 'islands';
    const populated = ws.islands.filter((s) => s.populated);
    const visionSources = computeVisionSources(populated);
    for (const spec of ws.islands) {
      const state = islandRenderState(spec, visionSources);
      const c = renderIsland(spec, state);
      if (c) layer.addChild(c);
    }
    return layer;
  }
  /** Rebuild ocean + island + fog-overlay layers in place. Called when
   *  drones reveal new cells or return / flip island discovery. The PixiJS
   *  Texture cache for gradient sprites isn't freed here —
   *  `oldOcean.destroy({ children: true, texture: true })` is the explicit
   *  GPU-cleanup hook so the textures from the previous bake don't leak
   *  across many discovery events. */
  function rebuildWorldLayers(): void {
    const oldOcean = oceanLayer;
    const oldIslands = islandLayer;
    const oldFog = fogOverlayLayer;
    oceanLayer = renderOceanFromState(worldState, WORLD_HALF_SIZE_TILES);
    islandLayer = renderIslandLayer(worldState);
    fogOverlayLayer = renderFogOverlayFromState(worldState);
    // Insert at the same Z slots: ocean 0, islands 1, fog 2, weather 3.
    world.removeChild(oldOcean);
    world.removeChild(oldIslands);
    world.removeChild(oldFog);
    world.addChildAt(oceanLayer, 0);
    world.addChildAt(islandLayer, 1);
    world.addChildAt(fogOverlayLayer, 2);
    // Visibility-radius depends on populated islands + weather stations;
    // both can change across a rebuild, so invalidate the throttle.
    weatherOverlay.invalidate();
    oldOcean.destroy({ children: true, texture: true });
    oldIslands.destroy({ children: true });
    oldFog.destroy({ children: true });
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
  // Restore saved camera if prefs exist; otherwise centre on home (world
  // origin). The prefs blob is clamped + validated by loadPrefs(), so zoom
  // out of [MIN_ZOOM..MAX_ZOOM] won't sneak through — but re-clamp here
  // defensively in case a future MIN/MAX change leaves an old save out of
  // range, rather than booting with a zoom we can't reach with the keys.
  if (restoredPrefs) {
    cam.tx = restoredPrefs.cam.tx;
    cam.ty = restoredPrefs.cam.ty;
    cam.zoom = clampZoom(restoredPrefs.cam.zoom);
  } else {
    centerOn(cam, { x: 0, y: 0 }, viewportCentre());
  }

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
    // §3: re-centre on the active island. Pre-active-selection this
    // always centred on world origin (where the home demo island sits);
    // post-active-selection the action follows the player's focus.
    const spec = activeSpec();
    const wpx = tileToWorldPx(spec.cx, spec.cy);
    centerOn(cam, { x: wpx.x, y: wpx.y }, viewportCentre());
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
  // after the UI is mounted (which needs the active-island getters).
  defineAction(reg, 'toggle-drones', () => undefined);
  defineAction(reg, 'toggle-graph', () => undefined);
  defineAction(reg, 'toggle-routes', () => undefined);
  defineAction(reg, 'toggle-settlement', () => undefined);
  // §14 T6 orbital launch modal — bound below after the UI is mounted.
  defineAction(reg, 'toggle-orbital', () => undefined);
  // Step-11 modal — bound below after the UI is mounted.
  defineAction(reg, 'toggle-construction', () => undefined);
  // Step-19 inventory modal — bound below after the UI is mounted.
  defineAction(reg, 'toggle-inventory', () => undefined);
  // Settings modal — bound below after the UI is mounted (needs the
  // lastSaveAt closure variable and the world/state map).
  defineAction(reg, 'toggle-settings', () => undefined);
  // Step-2.5 placement rotation — bound below after the placement UI is
  // mounted (it needs the home spec/state, which are constructed further
  // down). Stub here so KeyT presses don't silently drop while the UI is
  // still booting.
  defineAction(reg, 'rotate-placement', () => undefined);

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
  //
  // Focus suppression: when a text-accepting element is focused (graph-panel
  // search, future inventory rename, save-import textarea, etc.) we must NOT
  // fire game keybinds — otherwise typing "W" pans the camera mid-query and
  // pressing "O" opens the orbital modal. Escape is the universal "dismiss
  // modal" key and players expect it to work even while typing, so it passes
  // through unconditionally. The keyup release path needs the same gate or a
  // held-pan flag set before focus moved into the input could get stuck when
  // the corresponding keyup fires while focused.
  const isTextInputFocused = (): boolean => {
    const a = document.activeElement;
    if (!a) return false;
    if (a instanceof HTMLInputElement) {
      // Allow non-text inputs (checkboxes, radios, buttons) to pass through —
      // they don't consume printable keystrokes the way text fields do.
      const t = a.type;
      return (
        t === 'text' ||
        t === 'search' ||
        t === 'number' ||
        t === 'tel' ||
        t === 'url' ||
        t === 'email' ||
        t === 'password' ||
        t === ''
      );
    }
    if (a instanceof HTMLTextAreaElement) return true;
    if (a instanceof HTMLSelectElement) return true; // captures arrow keys
    if (a instanceof HTMLElement && a.isContentEditable) return true;
    return false;
  };
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return; // pan flags are level-triggered; no need to spam.
    if (e.code === 'Escape') {
      if (dispatchKey(reg, e.code)) e.preventDefault();
      return;
    }
    if (isTextInputFocused()) return;
    if (dispatchKey(reg, e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Escape' && isTextInputFocused()) return;
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
    // Right-click while in placement mode cancels — same exit as Escape.
    // Right-click in launch mode is intentionally not cancelled here (the
    // drone UI doesn't define a right-click semantic).
    if (e.button === 2 && placementUi.isActive()) {
      placementUi.cancel();
      return;
    }
    // §14 orbital launch: right-click disarms the satellite launch reticle
    // without committing. Re-opens the orbital modal so the player lands
    // back where the arm was triggered.
    if (e.button === 2 && orbitalUi.isLaunchMode()) {
      orbitalUi.setLaunchMode(false);
      orbitalUi.show();
      return;
    }
    if (e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    accumDrag = 0;
  });
  // Suppress the browser context menu over the canvas so right-click can
  // be the placement-cancel gesture without a system menu appearing.
  app.canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
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
      return;
    }
    // Same disambiguation for settlement-launch mode: a small click on the
    // canvas commits a settlement attempt against the nearest discovered,
    // unpopulated island within tolerance. Mutual-exclusion with drone-
    // launch is enforced by the onLaunchModeChanged callbacks above —
    // entering one mode disarms the other.
    if (accumDrag < CLICK_DRAG_PX_MAX && settlementUi.isLaunchMode()) {
      const rect = app.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (sx < 0 || sx > rect.width || sy < 0 || sy > rect.height) return;
      const wp = screenToWorldTile(sx, sy);
      settlementUi.attemptLaunch(wp.x, wp.y, performance.now());
      return;
    }
    // §14 orbital launch: same disambiguation as drone / settlement launch.
    // Modal armed a satellite + variant; the canvas click picks the target
    // tile. Mutual-exclusion with sister panels is enforced by their
    // onLaunchModeChanged callbacks.
    if (accumDrag < CLICK_DRAG_PX_MAX && orbitalUi.isLaunchMode()) {
      const rect = app.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (sx < 0 || sx > rect.width || sy < 0 || sy > rect.height) return;
      const wp = screenToWorldTile(sx, sy);
      orbitalUi.attemptLaunch(wp.x, wp.y, performance.now());
      return;
    }
    // Step-2.5: small click in placement mode commits a placement.
    // Mutual-exclusion with launch mode is symmetric: entering placement
    // calls dronesUi.setLaunchMode(false); entering launch calls
    // placementUi.cancel(). Both entry sites wire this — see the
    // onPlaceRequested callback below and the toggle-drones action above.
    if (accumDrag < CLICK_DRAG_PX_MAX && placementUi.isActive()) {
      const rect = app.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (sx < 0 || sx > rect.width || sy < 0 || sy > rect.height) return;
      // The placementUi already tracks cursor pos via mousemove (below),
      // so we just call attemptCommit — it'll read the current cursor
      // and validate before pushing.
      placementUi.attemptCommit();
      return;
    }
    // §4 building-select. Runs AFTER drone-launch / settlement / placement-
    // commit (each early-returns above) but BEFORE the active-island
    // switch — clicking a building on a NON-active island opens the
    // inspector without forcing an active-island context switch. The
    // hit-test only runs when the click lands inside a populated island
    // (the only place buildings exist in step 2.5).
    if (accumDrag < CLICK_DRAG_PX_MAX) {
      const rect = app.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (sx < 0 || sx > rect.width || sy < 0 || sy > rect.height) return;
      const wt = screenToWorldTile(sx, sy);
      const island = findPopulatedIslandAt(wt.x, wt.y, worldState.islands);
      if (island) {
        const localX = wt.x - island.cx;
        const localY = wt.y - island.cy;
        const hitBuilding = buildingAtTile(island, localX, localY);
        if (hitBuilding) {
          const targetState = islandStates.get(island.id);
          if (targetState) {
            inspector.open({ spec: island, state: targetState, building: hitBuilding });
            selectedSpec = island;
            // Align hover state to the clicked building. The mousemove
            // handler normally keeps `hoveredBuilding` in sync with the
            // cursor, but if the click lands at a position the cursor
            // hasn't visited yet (fast click, programmatic dispatch, or
            // any race where the click handler fires before the latest
            // mousemove processes), the hover layer would still draw the
            // previously-hovered building's outline. That stale outline
            // is the user-visible "click marks a different building"
            // symptom — the selection outline correctly highlights the
            // clicked building, but the leftover hover outline draws on
            // the previously-hovered one. By syncing hoveredBuilding to
            // the hit, the hover-suppression check inside repaintHover
            // (hover.id === selection.id → hoverLayer.visible = false)
            // takes effect on the next repaintHover call.
            hoveredBuilding = { spec: island, building: hitBuilding };
            repaintSelection();
            repaintHover();
            // Don't switch active-island on a building click — the player is
            // inspecting, not focusing. Active-island stays where it was so
            // the HUD doesn't jump.
            return;
          }
        }
      }
      // §3 active-island fallback. Only reached when the click misses every
      // building on the populated island it lands on (or hits open ocean /
      // a discovered-only island). The hit-test ignores discovered-but-not-
      // populated islands and open ocean (returns null → no switch).
      const hit = island;
      if (hit && hit.id !== activeIslandId) {
        activeIslandId = hit.id;
        // Centre the camera on the new active island so the player sees
        // the context switch confirmed. Halo redraw + panel re-targets
        // happen on the next ticker pass.
        const wpx = tileToWorldPx(hit.cx, hit.cy);
        centerOn(cam, { x: wpx.x, y: wpx.y }, viewportCentre());
      }
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
  // Step-2.5: same mousemove also feeds the placement preview when placement
  // is armed. Both consumers no-op silently if their mode is off.
  app.canvas.addEventListener('mousemove', (e) => {
    const rect = app.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (dronesUi.isLaunchMode()) {
      dronesUi.setReticleScreenPos(sx, sy);
    }
    if (settlementUi.isLaunchMode()) {
      settlementUi.setReticleScreenPos(sx, sy);
    }
    if (orbitalUi.isLaunchMode()) {
      orbitalUi.setReticleScreenPos(sx, sy);
    }
    if (placementUi.isActive()) {
      placementUi.setCursorScreenPos(sx, sy);
    }
    // §4 hover affordance — only when no mode is armed (the placement
    // preview / launch reticle owns the cursor in those modes). Stale
    // hovered state from before mode-arm is cleared in the mode-changed
    // callbacks; the suppression here keeps re-entry from re-painting.
    if (anyModeArmed()) {
      if (hoveredBuilding) {
        hoveredBuilding = null;
        repaintHover();
      }
      terrainTooltip.hide();
      return;
    }
    const wt = screenToWorldTile(sx, sy);
    const island = findPopulatedIslandAt(wt.x, wt.y, worldState.islands);
    let next: { spec: IslandSpec; building: PlacedBuilding } | null = null;
    if (island) {
      const localX = wt.x - island.cx;
      const localY = wt.y - island.cy;
      const b = buildingAtTile(island, localX, localY);
      if (b) next = { spec: island, building: b };
      // Terrain hover tooltip — show only on populated islands. If the
      // cursor is on a building we still surface the underlying terrain
      // for context.
      // Tile (n) is rendered centred on world pixel (n * TILE_PX), so its
      // visual extent spans [n - 0.5, n + 0.5) in fractional-tile space —
      // island.cx is the CENTRE of tile (0, 0), not its top-left. Math.round
      // maps the fractional local coord to the tile whose visual centre is
      // nearest the cursor (same convention as buildingAtTile / placement-ui).
      const localTileX = Math.round(localX);
      const localTileY = Math.round(localY);
      const terrainFn = island.terrainAt;
      if (terrainFn) {
        const terrain = terrainFn(localTileX, localTileY);
        terrainTooltip.setHover(e.clientX, e.clientY, terrain);
      } else {
        terrainTooltip.hide();
      }
    } else {
      terrainTooltip.hide();
    }
    const prevId = hoveredBuilding?.building.id ?? null;
    const nextId = next?.building.id ?? null;
    if (prevId !== nextId) {
      hoveredBuilding = next;
      repaintHover();
    }
  });
  app.canvas.addEventListener('mouseleave', () => {
    dronesUi.hideReticle();
    settlementUi.hideReticle();
    orbitalUi.hideReticle();
    placementUi.hidePreview();
    terrainTooltip.hide();
    // Clear hover outline so it doesn't ghost at the last cursor position
    // when the user leaves the canvas.
    if (hoveredBuilding) {
      hoveredBuilding = null;
      repaintHover();
    }
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

  // UI overlay — vertical icon strip in TR zone (managed by ui-zones).
  mountUi(reg, [
    { icon: 'building',  action: 'toggle-buildings',    label: 'Buildings',   kbd: 'B' },
    { icon: 'inventory', action: 'toggle-inventory',    label: 'Inventory',   kbd: 'I' },
    { icon: 'drone',     action: 'toggle-drones',       label: 'Drones',      kbd: 'J' },
    { icon: 'route',     action: 'toggle-routes',       label: 'Routes',      kbd: 'R' },
    { icon: 'settle',    action: 'toggle-settlement',   label: 'Settlement',  kbd: 'V' },
    { icon: 'construct', action: 'toggle-construction', label: 'Construct',   kbd: 'C' },
    { icon: 'skills',    action: 'toggle-skill-tree',   label: 'Skill Tree',  kbd: 'K' },
    { icon: 'graph',     action: 'toggle-graph',        label: 'Recipe Graph', kbd: 'Y' },
    { icon: 'rocket',    action: 'toggle-orbital',      label: 'T6 Orbital',  kbd: 'O' },
    { icon: 'grid',      action: 'toggle-grid',         label: 'Toggle Grid', kbd: 'G' },
    { icon: 'crosshair', action: 'center-home',         label: 'Center View', kbd: 'H' },
    { icon: 'settings',  action: 'toggle-settings',     label: 'Settings',    kbd: 'S' },
  ]);

  // §13.3 Omniscient Lattice banner — shown globally when latticeActive.
  const latticeBanner = document.createElement('div');
  latticeBanner.id = 'lattice-banner';
  latticeBanner.textContent = 'OMNISCIENT LATTICE ACTIVE';
  latticeBanner.style.cssText = `
    position: fixed;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    background: rgba(128, 240, 192, 0.15);
    color: var(--ri-success);
    border: 1px solid var(--ri-success);
    border-radius: 4px;
    padding: 4px 12px;
    font-family: monospace;
    font-size: 12px;
    letter-spacing: 1px;
    pointer-events: none;
    display: none;
  `;
  document.body.appendChild(latticeBanner);

  // -----------------------------------------------------------------------
  // Economy state — multi-island
  // -----------------------------------------------------------------------
  //
  // Step 7 promoted the single home state to a Map keyed by island id, so
  // routes can dispatch between any two populated islands. The HUD still
  // tracks the home island only — multi-island HUD is a STILL-DEFERRED step-14
  // polish concern. `forest-ne` is hardcoded populated for the step-7 demo
  // (see `world.ts`); settlement vehicles per §12 shipped in step 12.
  const islandStates: Map<string, IslandState> = restored
    ? restored.islandStates
    : new Map<string, IslandState>();
  const homeSpec = worldState.islands.find((s) => s.id === 'home');
  if (!homeSpec) throw new Error('main: home island missing from worldState');
  // Fresh-game path: build per-island state from each populated spec. The
  // forest-ne T5 demo seed below is now a no-op in production (forest-ne
  // is no longer auto-populated per §3.7) but kept guarded by
  // `if (forestNe)` so it can still apply if a test or dev path manually
  // populates forest-ne via DEMO_ISLANDS_TEST_FIXTURE. Restored saves
  // skip this entirely — whatever the player had at last save is the
  // source of truth, and the demo seed must NOT re-fire on every load
  // (would erase progress).
  if (!restored) {
    const homeState = makeInitialIslandState(homeSpec, performance.now());
    islandStates.set('home', homeState);
    // §3.7 starter contract: home starts with EMPTY inventory. The pre-
    // §3.7-cleanup path overrode `foundation_kit = 3` / `biofuel = 100`
    // here on every fresh game — that's now removed so the production
    // start matches §3.7 ("no starter resources, no Foundation Kit").
    // New colonies arriving via settlement vehicles likewise START EMPTY
    // (no kit/biofuel seed).
    for (const spec of worldState.islands) {
      if (spec.id === 'home') continue;
      if (!spec.populated) continue;
      islandStates.set(spec.id, makeInitialIslandState(spec, performance.now()));
    }
    // Step-11/12/13 demo seed: bump forest-ne to level 50 (T5) and pre-load
    // enough construction materials so the player can fire off a 4×4
    // artificial island construction without first grinding the smelting
    // chain. The values exceed the 4×4 Plains cost (~252 steel / 151
    // iron_ingot / 503 wood) with comfortable headroom for one construct +
    // a second attempt.
    // Step 13 bumps the level 30 → 50 and sets aiCoreCrafted = true so the
    // §13.1 T5 access gate (level ≥ 50 AND AI core crafted) is satisfied —
    // the catalog UI then displays the T5 band unlocked. Seeds T4/T5
    // resources so the Reality Forge demo recipe could run if placed.
    // Forest-ne stays Forest biome, so Volcanic/Arctic biome-locked uniques
    // (Pyroforge, Cryogenic Compute Center) remain locked from the catalog —
    // that's the intended §9.5 demo behaviour. T5 defs are biome-agnostic
    // (no requiredBiomes), so the full T5 band shows up.
    // Once a save exists this seed never re-runs — the saved IslandState
    // for forest-ne carries level/aiCoreCrafted/inventory forward.
    const forestNe = islandStates.get('forest-ne');
    if (forestNe) {
      forestNe.level = 50;
      forestNe.aiCoreCrafted = true; // §13.1 T5 access — manual demo seed
      // §14.1 T6 access (first half) — manual demo seed. Auto-flip on
      // first ascendant_core production STILL-DEFERRED. With this flag plus a
      // placed Spaceport, forest-ne crosses the §14.1 T6 gate and the
      // Catalog UI surfaces the T6 band as available.
      forestNe.ascendantCoreCrafted = true;
      // Rebalanced for idle-game scale, step #19: bumped proportionally to
      // new BASELINE_STORAGE_CAP (2000) so the demo island has meaningful
      // pre-seeded stock relative to the larger caps.
      forestNe.inventory.steel = 1000; // rebalanced step #19 (was 300)
      forestNe.inventory.iron_ingot = 600; // rebalanced step #19 (was 200)
      forestNe.inventory.wood = 2000; // rebalanced step #19 (was 600)
      forestNe.inventory.helium_3 = 100; // rebalanced step #19 (was 50)
      // T4 / T5 seeds. Reality Forge inputs per §7.12 (4 ai_core + 1
      // antimatter_capsule + 1 time_crystal + 1 exotic_alloy / 24h cycle)
      // are all stocked so the demo island can fire a Reality Forge run
      // end-to-end. casimir_energy and quantum_chip are general T4/T5
      // plant stock — not Reality Forge inputs, retained for other T4/T5
      // recipes.
      forestNe.inventory.exotic_alloy = 50; // rebalanced step #19 (was 20)
      forestNe.inventory.ai_core = 30; // rebalanced step #19 (was 10)
      forestNe.inventory.antimatter_capsule = 5; // Reality Forge §7.12
      forestNe.inventory.time_crystal = 5; // Reality Forge §7.12
      forestNe.inventory.casimir_energy = 30; // rebalanced step #19 (was 10)
      forestNe.inventory.quantum_chip = 30; // rebalanced step #19 (added)
    }
  }
  // Sanity gate: home state must exist after init. The `homeState`/`homeSpec`
  // locals served as the per-panel anchor before active-island selection
  // landed; today every panel reads through the active getter pair below.
  if (!islandStates.get('home')) {
    throw new Error('main: home island state missing after init');
  }
  worldState.islandStates = islandStates;
  // Spec lookup by id — also needed by routes UI later. Built once; spec
  // identity is stable across the session (drones flip discovered, but
  // spec objects themselves aren't replaced).
  const islandSpecsById = new Map<string, IslandSpec>();
  for (const s of worldState.islands) islandSpecsById.set(s.id, s);

  // -----------------------------------------------------------------------
  // Active island selection — §3 (no island privileged in code)
  // -----------------------------------------------------------------------
  //
  // `activeIslandId` is the single source of truth for which populated
  // colony every panel currently targets. Always boots to 'home' — the
  // active island is transient UI state and isn't restored across reloads
  // (only the camera transform is persisted; see savePrefs).
  // The two getters resolve to the live spec/state on every call so
  // panels see fresh values after a click-to-switch without re-mounting.
  let activeIslandId: string = 'home';
  function activeSpec(): IslandSpec {
    const s = islandSpecsById.get(activeIslandId);
    if (!s) throw new Error(`main: active spec missing for ${activeIslandId}`);
    return s;
  }
  function activeState(): IslandState {
    const s = islandStates.get(activeIslandId);
    if (!s) throw new Error(`main: active state missing for ${activeIslandId}`);
    return s;
  }
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

  // §4.7 maintenance badges — amber/red dot on each degrading building so
  // status reads at a glance from the world map. Cheap throttled rebuild
  // (REBUILD_MS = 2s) — degradation rates are hourly so 2s is overkill but
  // costs nothing.
  const buildingAlertsOverlay = mountBuildingAlertsOverlay(worldState, islandStates);
  world.addChild(buildingAlertsOverlay.layer);

  // HUD: bottom-right panel showing inventory, rates, and level. Updated
  // once per frame inside the ticker after the economy advance.
  const hud = mountHud(document.body, worldState, (id) => {
    activeIslandId = id;
    const spec = islandSpecsById.get(id);
    if (spec) {
      const wpx = tileToWorldPx(spec.cx, spec.cy);
      centerOn(cam, { x: wpx.x, y: wpx.y }, viewportCentre());
    }
  }, reg);

  // Multi-island bar: top-center strip with per-island chips + phase/saved.
  const islandBar = mountIslandBar(worldState, (id) => {
    activeIslandId = id;
    const spec = islandSpecsById.get(id);
    if (spec) {
      const wpx = tileToWorldPx(spec.cx, spec.cy);
      centerOn(cam, { x: wpx.x, y: wpx.y }, viewportCentre());
    }
  });

  // Skill tree panel — modal-ish DOM overlay, dismissed via KeyK, Escape,
  // or its close button. Reads the active island's state through the
  // getter on every refresh, so click-to-switch retargets without remount.
  const skillTree = mountSkillTreeUi(document.body, { getState: activeState });
  defineAction(reg, 'toggle-skill-tree', () => {
    skillTree.toggle();
  });

  const graphUi = mountGraphUi(document.body);
  defineAction(reg, 'toggle-graph', () => {
    graphUi.toggle();
  });

  // Buildings catalog — sister modal panel to the skill tree. KeyB toggles;
  // Escape routes to whichever modal is visible (`dismiss-modal` below).
  // §9.5: reads the active spec through the getter so biome-locked uniques
  // (Pyroforge / Cryogenic Compute Center) re-evaluate against whichever
  // island the player has selected.
  // §4 (step 2.5): the `onPlaceRequested` callback hides the modal and
  // arms placement mode on the active island.
  const buildingsUi = mountBuildingsUi(
    document.body,
    { getState: activeState, getSpec: activeSpec },
    {
      onPlaceRequested: (defId) => {
        buildingsUi.hide();
        // Mutual-exclusion: disarm drone launch + settlement launch before
        // entering placement so a mouseup-commit reaches the placement branch
        // instead of firing a drone OR a settlement vehicle. The reverse arrows
        // (entering drone/settlement mode → placementUi.cancel()) are wired in
        // their respective onLaunchModeChanged callbacks.
        dronesUi.setLaunchMode(false);
        disarmSettlementLaunch();
        placementUi.begin(defId);
      },
    },
  );
  defineAction(reg, 'toggle-buildings', () => {
    buildingsUi.toggle();
  });

  // Step-2.5 placement UI — sister to drones-ui (armed-mode + canvas
  // preview). Two layers: `previewLayer` lives in world space so the
  // footprint outline scales with zoom and overlays the target tiles;
  // `statusLayer` lives in screen space so the small label stays a fixed
  // pixel size. Target follows the active island via the getters.
  const placementUi = mountPlacementUi({
    getTargetSpec: activeSpec,
    getTargetState: activeState,
    screenToWorldTile,
    onPlaced: () => {
      rebuildWorldLayers();
    },
  });
  world.addChild(placementUi.previewLayer);
  app.stage.addChild(placementUi.statusLayer);
  defineAction(reg, 'rotate-placement', () => {
    placementUi.rotate();
  });

  // -----------------------------------------------------------------------
  // §4 building interaction — hover outline + selection outline + inspector
  // -----------------------------------------------------------------------
  //
  // Two world-space outline layers ride above the placement preview:
  //   - `hoverLayer`: 2px ACCENT outline under the cursor when a building
  //     is hovered AND no mode is armed (drone-launch / settlement-launch /
  //     placement all suppress hover so the existing mode-specific overlay
  //     stays primary).
  //   - `selectionLayer`: 3px ACCENT solid outline around the currently
  //     selected building. Persists until the inspector closes or another
  //     building is selected.
  //
  // Both layers paint from the active island's coordinate system; main.ts
  // owns the paint helpers so the inspector module can stay pure-DOM. The
  // selection layer reads `inspector.getSelectedBuildingId()` each frame
  // to keep the outline in sync with the panel.
  const hoverLayer = new Container();
  hoverLayer.label = 'hover-building';
  const hoverGfx = new Graphics();
  hoverLayer.addChild(hoverGfx);
  world.addChild(hoverLayer);

  const selectionLayer = new Container();
  selectionLayer.label = 'selected-building';
  const selectionGfx = new Graphics();
  selectionLayer.addChild(selectionGfx);
  world.addChild(selectionLayer);

  /** Track the spec the currently-hovered/selected building belongs to,
   *  since `inspector.getSelectedBuildingId()` only gives us the id. Both
   *  pieces are needed to compute the world-space footprint rectangle —
   *  the building's island-local coords need its spec's centre. */
  let hoveredBuilding: { spec: IslandSpec; building: PlacedBuilding } | null = null;
  let selectedSpec: IslandSpec | null = null;

  /** Paint a footprint outline for `building` on `spec` into `gfx` with the
   *  given style. Mirrors the math in placement-ui.ts's preview painter:
   *  building tiles are in island-local coords; the world-pixel offset
   *  combines the per-island centre with the per-tile centre convention. */
  function paintBuildingOutline(
    gfx: Graphics,
    spec: IslandSpec,
    building: PlacedBuilding,
    color: number,
    strokeWidth: number,
    fillAlpha: number,
  ): void {
    const def = BUILDING_DEFS[building.defId];
    const tiles = footprintTiles(
      def.footprint,
      building.x,
      building.y,
      (building.rotation ?? 0) as Rotation,
    );
    const islandWorldPx = tileToWorldPx(spec.cx, spec.cy);
    const half = TILE_PX / 2;
    for (const t of tiles) {
      const wpx = t.x * TILE_PX + islandWorldPx.x - half;
      const wpy = t.y * TILE_PX + islandWorldPx.y - half;
      gfx
        .rect(wpx, wpy, TILE_PX, TILE_PX)
        .fill({ color, alpha: fillAlpha })
        .stroke({ width: strokeWidth, color, alpha: 0.95, alignment: 1 });
    }
  }

  function repaintHover(): void {
    hoverGfx.clear();
    if (!hoveredBuilding) {
      hoverLayer.visible = false;
      return;
    }
    // Suppress the selected building's hover outline — the selection outline
    // is more prominent and a duplicate at the same site reads as a flicker.
    const selectedId = inspector.getSelectedBuildingId();
    if (selectedId && selectedId === hoveredBuilding.building.id) {
      hoverLayer.visible = false;
      return;
    }
    // ACCENT cyan = VISION_BLUE — same hue used by the placement
    // preview's `ok` state, so two cyan readouts at once read as "things
    // you can act on" rather than two different signals.
    paintBuildingOutline(
      hoverGfx,
      hoveredBuilding.spec,
      hoveredBuilding.building,
      VISION_BLUE,
      2,
      0.05,
    );
    hoverLayer.visible = true;
  }

  function repaintSelection(): void {
    selectionGfx.clear();
    const selectedId = inspector.getSelectedBuildingId();
    if (!selectedId || !selectedSpec) {
      selectionLayer.visible = false;
      return;
    }
    const building = selectedSpec.buildings.find((b) => b.id === selectedId);
    if (!building) {
      // Stale selection (e.g. demolish removed it). Defensive close.
      selectionLayer.visible = false;
      inspector.close();
      selectedSpec = null;
      return;
    }
    // ACCENT solid 3px outline + slightly stronger fill alpha than the
    // hover variant so selection reads as "committed" vs hover's "pending."
    paintBuildingOutline(selectionGfx, selectedSpec, building, VISION_BLUE, 3, 0.12);
    selectionLayer.visible = true;
  }

  /** Whether any input mode is armed (drone-launch / settlement-launch /
   *  placement). The hover outline suppresses while armed so the mode's
   *  own overlay stays primary. */
  function anyModeArmed(): boolean {
    return (
      dronesUi.isLaunchMode() ||
      settlementUi.isLaunchMode() ||
      orbitalUi.isLaunchMode() ||
      placementUi.isActive()
    );
  }

  const inspector = mountInspectorUi(document.body, {
    world: worldState,
    onDemolish: (target: InspectorTarget) => {
      const result = demolishBuilding(target.spec, target.state, target.building.id);
      if (!result.ok) return;
      // Close the inspector + clear selection BEFORE the layer rebuild so
      // the stale-selection guard in repaintSelection doesn't fire.
      inspector.close();
      selectedSpec = null;
      hoveredBuilding = null;
      repaintHover();
      repaintSelection();
      rebuildWorldLayers();
    },
    // §3.4 Land Reclamation: mutate spec/state via the pure helper, then
    // rebuild the world layer so the new ellipse mask propagates to
    // `renderIsland` (which recomputes `computeIslandTiles` from the
    // current radii on every rebuild). Selection / hover are kept since
    // the Hub itself doesn't move — the inspector stays open on the
    // same building with refreshed numbers.
    onExpandIsland: (target: InspectorTarget, axis: Axis) => {
      expandIsland(target.spec, target.state, axis);
      rebuildWorldLayers();
      inspector.refresh();
    },
    // Island display-name rename. The inspector already mutated
    // `target.spec.name` via the pure `renameIsland` helper; this callback
    // exists so main.ts can refresh any DOM surface that caches the name
    // outside the regular ticker (HUD title repaints on its own tick, but
    // an explicit refresh keeps the on-screen text in lockstep with the
    // commit). `_name` is unused — present for API symmetry with the
    // callback signature and to surface the intended value in tooling.
    onRenameIsland: (_target: InspectorTarget, _name: string) => {
      inspector.refresh();
    },
    // §13.3 Universe Editor — biome / modifiers / terrain mutated for one
    // island. Refresh the modifier-multiplier cache for that island and
    // rebuild render layers so the new terrain colors appear immediately.
    onIslandBiomeReassigned: (islandId: string) => {
      const spec = islandSpecsById.get(islandId);
      if (spec) {
        modifierMulsById.set(spec.id, effectiveModifierMultipliers(spec.modifiers));
      }
      rebuildWorldLayers();
      inspector.refresh();
    },
  });

  // Step-11 Construction modal — sister to skill tree + buildings catalog.
  // Inserts the new island into worldState/islandStates, registers its
  // caches, and rebuilds render layers in the onConstruct callback.
  // Cache strategy (per advisor): "append on construction" rather than
  // "rebuild caches every frame" — artificial islands ship with empty
  // modifiers, so the modifier cache entry is one line.
  const constructionUi = mountConstructionUi(document.body, {
    world: worldState,
    islandStates,
    getActiveIslandId: () => activeIslandId,
    onConstruct: ({ newSpec, newState }) => {
      worldState.islands.push(newSpec);
      islandStates.set(newSpec.id, newState);
      islandSpecsById.set(newSpec.id, newSpec);
      // Artificial islands carry empty modifiers, so the bundle is identity —
      // but call effectiveModifierMultipliers([]) for symmetry with the
      // demo-island init loop above (and so adding a non-empty modifier set
      // later doesn't accidentally skip the fold).
      modifierMulsById.set(newSpec.id, effectiveModifierMultipliers([]));
      rebuildWorldLayers();
    },
  });
  defineAction(reg, 'toggle-construction', () => {
    constructionUi.toggle();
  });

  // Step-19 inventory modal — sister to buildings catalog + skill tree.
  // Toggled via KeyI. Reads through the active getters so click-to-switch
  // retargets the panel without remount. Refresh() is called from the
  // ticker after the post-tick computeRates so the visible net rates are
  // for the current frame.
  const inventoryUi = mountInventoryUi(document.body, {
    getState: activeState,
    getSpec: activeSpec,
  });
  defineAction(reg, 'toggle-inventory', () => {
    inventoryUi.toggle();
  });

  // Settings panel — rebind UI + save management. Toggled via KeyS;
  // Escape routes through the shared `dismiss-modal` action below.
  // `lastSaveAt` is forward-declared on the autosave block further down;
  // the getter reads it lazily so the closure stays valid even though the
  // binding currently holds `null` at mount time.
  let lastSaveAt: number | null = null;
  const settingsUi = mountSettingsUi(document.body, {
    reg,
    world: worldState,
    islandStates,
    getLastSavedAt: () => lastSaveAt,
  });
  defineAction(reg, 'toggle-settings', () => {
    settingsUi.toggle();
  });

  // Forward declaration for cross-panel disarms used by the orbital UI.
  // orbitalUi mounts before dronesUi/settlementUi, so its
  // onLaunchModeChanged callback can't capture them directly — we wire
  // these setters once those panels are constructed below. No-op until
  // then (the player can't arm a launch during bootstrap).
  let disarmDronesLaunch: () => void = () => undefined;
  let disarmSettlementLaunchFromOrbital: () => void = () => undefined;

  // §14 orbital modal — mounted here (before dismiss-modal action wiring)
  // so its hide() can join the Escape cascade. Reads live world.satellites
  // + per-island spaceport state on each open / per-frame refresh while
  // visible. Launch flow: armed via the modal's "Arm Launch" button →
  // modal hides → canvas reticle follows the cursor → click commits.
  // Mutual-exclusion with drone/settlement/placement modes is enforced via
  // onLaunchModeChanged (the sister-panel disarms below mirror this).
  const orbitalUi = mountOrbitalUi(document.body, {
    world: worldState,
    islandStates,
    screenToWorldTile,
    onLaunchModeChanged: (armed) => {
      if (armed) {
        placementUi.cancel();
        // Sister panel disarms — both panels are constructed by the time the
        // player can click "Arm Launch" in the modal; the forward-declared
        // setters above are wired once those panels mount.
        disarmDronesLaunch();
        disarmSettlementLaunchFromOrbital();
        if (hoveredBuilding) {
          hoveredBuilding = null;
          repaintHover();
        }
      }
    },
  });
  defineAction(reg, 'toggle-orbital', () => {
    orbitalUi.toggle();
  });

  // Generic modal dismissal: hide whichever modal is open. All modal hide()
  // calls are idempotent, so the no-modal-open case is a free no-op.
  // Mutual-exclusion isn't enforced — if multiple modals happen to be open
  // Escape closes them all at once.
  // Step-2.5: Escape also cancels an in-progress placement. `cancel()` is
  // idempotent too.
  defineAction(reg, 'dismiss-modal', () => {
    skillTree.hide();
    buildingsUi.hide();
    constructionUi.hide();
    inventoryUi.hide();
    // settingsUi is mounted later; the closure captures the binding which
    // gets assigned before this action ever fires (panel-toggle happens
    // through user input, not synchronously during bootstrap).
    settingsUi.hide();
    graphUi.hide();
    orbitalUi.hide();
    placementUi.cancel();
    // §4 inspector: Escape also closes the inspector + clears the
    // selection outline. Idempotent; closing while already hidden is a
    // no-op.
    if (inspector.isVisible()) {
      inspector.close();
      selectedSpec = null;
      repaintSelection();
    }
  });

  // Forward declaration for the cross-panel disarm callback. Drone-ops
  // launches before settlement-ops is constructed (function ordering),
  // so we use a setter function that the settlement bootstrap below
  // populates once the panel exists. No-op until that runs.
  let disarmSettlementLaunch: () => void = () => undefined;

  // Drone-ops side dock + canvas reticle + drone-dot layer. Origin =
  // active island. The arm-launch button greys out when the active
  // island lacks a Drone Pad (gating handled inside drones-ui refresh).
  const dronesUi = mountDronesUi(document.body, {
    world: worldState,
    getOrigin: activeState,
    getOriginSpec: activeSpec,
    screenToWorldTile,
    onDiscoveryChanged: rebuildWorldLayers,
    // Mutual-exclusion: when launch mode arms, cancel any in-progress
    // placement / settlement-arm / orbital-launch so a mouseup-commit can't
    // ambiguously route to multiple consumers.
    onLaunchModeChanged: (armed) => {
      if (armed) {
        placementUi.cancel();
        disarmSettlementLaunch();
        orbitalUi.setLaunchMode(false);
        // Clear hover affordance when entering an armed mode — the mode's
        // own overlay takes over, and a stale hover outline beneath would
        // read as conflicting affordance.
        if (hoveredBuilding) {
          hoveredBuilding = null;
          repaintHover();
        }
      }
    },
  });
  // Drone dots live in world space (above ocean + islands + fog overlay,
  // below the cell grid).
  world.addChildAt(dronesUi.droneLayer, 4);
  // §14 orbital launch reticle + range ring — mounted alongside the drone
  // reticle. Reticle in screen space (fixed pixel size); range ring in
  // world space (radius reads in tiles regardless of zoom).
  app.stage.addChild(orbitalUi.reticleLayer);
  // The handle exposes `rangeRingLayer` as an implementation detail beyond
  // the formal interface; cast to access it. Same pattern dronesUi uses.
  const orbitalRangeRing = (orbitalUi as unknown as { rangeRingLayer: import('pixi.js').Container }).rangeRingLayer;
  world.addChild(orbitalRangeRing);
  // Reticle lives in screen space (NOT world container) so it stays a
  // fixed-pixel crosshair regardless of zoom.
  app.stage.addChild(dronesUi.reticleLayer);
  // Range ring lives in WORLD space so the radius reads correctly in
  // tiles at any zoom. Appended (not addChildAt) so it sits above the
  // ocean/island/drone layers but below the screen-space reticle stack.
  world.addChild(dronesUi.rangeRingLayer);
  // Wire the orbital-side forward-decl so an orbital arm-launch can disarm
  // the dronesUi panel.
  disarmDronesLaunch = () => dronesUi.setLaunchMode(false);
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

  // Step-12 / §12: Settlement-Ops side dock. Sister to drones + routes
  // panels. Mutual-exclusion with drone-launch + placement modes flows
  // through the same callback discipline (see drones-ui wiring above).
  // Vehicle dots live in world space (between islands and cell grid);
  // reticle lives in screen space (same as drone reticle).
  const settlementUi = mountSettlementUi(document.body, {
    world: worldState,
    islandStates,
    islandSpecs: islandSpecsById,
    getActiveIslandId: () => activeIslandId,
    screenToWorldTile,
    onLaunchModeChanged: (armed) => {
      if (armed) {
        // Disarm sister modes so a click can't ambiguously route to two.
        dronesUi.setLaunchMode(false);
        orbitalUi.setLaunchMode(false);
        placementUi.cancel();
      }
    },
  });
  world.addChildAt(settlementUi.vehicleLayer, 5);
  app.stage.addChild(settlementUi.reticleLayer);
  // Hook the forward-declared cross-panel disarm callback to the now-
  // constructed settlement panel. Called by drones-ui when it arms launch.
  disarmSettlementLaunch = () => settlementUi.setLaunchMode(false);
  // Same for the orbital-side disarm: orbital arming disarms settlement.
  disarmSettlementLaunchFromOrbital = () => settlementUi.setLaunchMode(false);
  defineAction(reg, 'toggle-settlement', () => {
    settlementUi.toggle();
  });

  // §15.6 persistence: schedule autosaves and a visibility-change save. The
  // HUD shows a "Saved · Ns ago" indicator driven by `lastSaveAt`; null until
  // the first save lands. `performance.now()` is fine here because we only
  // ever subtract it from itself (current frame time) to compute the age —
  // the same domain as the ticker's `now`. The save itself is fire-and-
  // forget (`void`) so the timer / event handler doesn't await — failures
  // are swallowed by `saveWorld`'s try/catch.
  const SAVE_INTERVAL_MS = 30_000;
  // Debounced prefs save: cam pan/zoom needs a tighter cadence than the
  // 30s world autosave — a player who pans then refreshes 3 seconds later
  // expects their view to come back. We compare the live cam values
  // against the last-saved snapshot once per frame inside the ticker
  // (cheap — three numbers) and re-arm a 500ms debounce timer on any
  // change. The timer batches multiple frames of fast panning into a
  // single IDB write. Open panel and active-island id are intentionally
  // NOT persisted: restoring transient UI state across reload (e.g. the
  // Construct window auto-reopening on every refresh) was undesirable.
  let lastSavedCam = { tx: cam.tx, ty: cam.ty, zoom: cam.zoom };
  let prefsSaveTimer: number | null = null;
  const PREFS_SAVE_DEBOUNCE_MS = 500;
  function flushPrefsSave(): void {
    if (prefsSaveTimer !== null) {
      clearTimeout(prefsSaveTimer);
      prefsSaveTimer = null;
    }
    void savePrefs({
      cam: { tx: cam.tx, ty: cam.ty, zoom: cam.zoom },
    });
    lastSavedCam = { tx: cam.tx, ty: cam.ty, zoom: cam.zoom };
  }
  function schedulePrefsSave(): void {
    if (prefsSaveTimer !== null) clearTimeout(prefsSaveTimer);
    prefsSaveTimer = window.setTimeout(flushPrefsSave, PREFS_SAVE_DEBOUNCE_MS);
  }
  /** Called once per frame: detect dirty cam and arm the debounce. */
  function maybeSchedulePrefsSave(): void {
    if (
      cam.tx !== lastSavedCam.tx ||
      cam.ty !== lastSavedCam.ty ||
      cam.zoom !== lastSavedCam.zoom
    ) {
      schedulePrefsSave();
    }
  }

  // `lastSaveAt` is declared earlier alongside the settings UI mount so the
  // panel's getLastSavedAt closure can read the live value; this block
  // owns the writes via triggerSave.
  const triggerSave = (): void => {
    void saveWorld(worldState, islandStates);
    // Flush any pending prefs save synchronously alongside the world save —
    // ensures the 30s autosave and the visibility-change save always land
    // a fresh prefs blob even if the debounce timer was mid-flight.
    flushPrefsSave();
    lastSaveAt = performance.now();
  };
  // setInterval fires the autosave timer; the closure captures the live
  // worldState/islandStates bindings (which are themselves stable references
  // even though their contents mutate). The interval id is intentionally
  // unstored — the page lives until the tab closes, no need to clear.
  setInterval(triggerSave, SAVE_INTERVAL_MS);
  // visibilitychange = tab switch / minimize / close. Saving on `hidden`
  // catches the case where the player closes the tab mid-session before
  // the next 30s tick — the spec calls this out as the primary "don't
  // lose 30s of progress" guarantee on top of the timer.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') triggerSave();
  });


  // Update tick: apply held pan flags + sync camera state to the world
  // container, advance every populated island's economy, advance drone fleet,
  // advance inter-island routes, and update the HUD + side panels. One pass
  // per frame keeps the camera→container assignment cheap and predictable;
  // `advanceIsland`'s piecewise integration handles whatever elapsed interval
  // the frame brings (matters on tab-blur catch-up).
  let lastFrameMs = performance.now();
  let lastRenderedObjective: ObjectiveId | null = null;
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
    // Per-frame dirty-check for camera / active-island / open-panel prefs.
    // Arms the 500ms debounce timer if anything changed; the timer batches
    // bursts of pan/zoom frames into a single IDB write.
    maybeSchedulePrefsSave();

    const now = performance.now();
    // §2.7 wall-clock anchor for the day-night cycle. Captured once per
    // frame and threaded to advanceIsland + computeRates so the solar
    // multiplier samples Date.now() instead of `performance.now()` (which
    // resets to ~0 on every page refresh, snapping the cycle back to
    // mid-Day and breaking the spec's "purely time-driven, does not
    // depend on the player's session" guarantee).
    const nowWall = Date.now();
    // Capture the previous frame's timestamp BEFORE we overwrite
    // `lastFrameMs` — §11 telemetry's `tickDrones` needs the prev-tick
    // time to compute the per-tick capsule corridor (drone position at
    // prev → drone position at now).
    const prevFrameMs = lastFrameMs;
    const elapsedSec = Math.max(0, (now - lastFrameMs) / 1000);
    lastFrameMs = now;
    // Compute Network Consciousness state once per frame from the current
    // island set. §9.6 buff applies only to T3+ islands; per-island gating
    // happens at the call site below (not inside advanceIsland) so the
    // pure economy doesn't take a dependency on `tierForLevel`.
    const ncState = computeNcState(worldState);
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
    // §13.3 evaluate Omniscient Lattice activation after all economy advances
    // so newly placed nodes on this frame are counted.
    computeLatticeActive(worldState);
    // §13.3 unified inventory — computed once per tick and threaded to every
    // Lattice island's rate computation so consumers see stockpile on siblings.
    const unifiedInv = latticeInventory(worldState);
    const unifiedCaps = latticeStorageCaps(worldState);
    // §13.3 cross-island adjacency — precompute once per tick for each
    // lattice island so computeRates can treat remote buildings as neighbors.
    const crossIslandById = new Map<string, PlacedBuilding[]>();
    if (worldState.latticeActive) {
      for (const id of worldState.latticeNodeIslands) {
        const neighbors = crossIslandNeighbors(worldState, id);
        if (neighbors) crossIslandById.set(id, neighbors);
      }
    }

    // §5.3 cable network: compute the per-component binary-gated balance
    // ONCE per tick, then thread the matching CableComponentBalance into
    // every per-island `computeRates` / `advanceIsland` call. The local
    // power helper inside `computeCableNetworkBalance` re-uses the same
    // per-island ctx the advance loop will use, so the gate decision is
    // taken against the same modifiers / specMul / NC buff the integrator
    // will see this frame.
    // §14.3 Mirror Sat: precompute per-island solar boost ONCE per tick.
    // Each populated island gets the aggregate of every locked mirror sat's
    // Lorentzian contribution to that island's centre. Cheap (O(sats ×
    // islands)) and avoids re-summing inside the cable helper and the per-
    // island advance loop.
    const solarBoostByIsland = new Map<string, number>();
    for (const spec of worldState.islands) {
      if (!spec.populated) continue;
      solarBoostByIsland.set(
        spec.id,
        effectiveSolarBoostFor(worldState, { x: spec.cx, y: spec.cy }),
      );
    }
    const cableLocalCtxFor = (id: string): RatesContext => {
      const spec = islandSpecsById.get(id);
      const isLatticeIsland = unifiedInv !== undefined && worldState.latticeNodeIslands.includes(id);
      const stForCtx = islandStates.get(id);
      return {
        modifierMul: modifierMulFor(id),
        specMul: stForCtx ? specMulFor(stForCtx) : undefined,
        ncBuff: stForCtx ? ncBuffFor(stForCtx) : undefined,
        terrainAt: spec?.terrainAt,
        inventory: isLatticeIsland ? unifiedInv : undefined,
        crossIsland: crossIslandById.get(id),
        caps: isLatticeIsland ? unifiedCaps : undefined,
        geothermalActive: spec?.modifiers.includes('geothermal_active') === true,
        solarBoost: solarBoostByIsland.get(id),
      };
    };
    const cableBalances = computeCableNetworkBalance(worldState, islandStates, cableLocalCtxFor);

    const islandPower = new Map<string, PowerBalance>();
    const islandNets = new Map<string, Record<ResourceId, number>>();
    for (const s of islandStates.values()) {
      // Thread the spec's `terrainAt` closure so `resolveRecipe` (recipes.ts)
      // can branch Mine output on the tile under each footprint (§8.1).
      // Spec lookup is cheap (Map.get); the closure itself is reused across
      // every recomputeRates call within the tick.
      const spec = islandSpecsById.get(s.id);
      const isLatticeIsland = unifiedInv !== undefined && worldState.latticeNodeIslands.includes(s.id);
      const crossIsland = crossIslandById.get(s.id);
      const cableComponent = cableBalances.get(s.id);
      const geothermalActive = spec?.modifiers.includes('geothermal_active') === true;
      advanceIsland(s, now, {
        modifierMul: modifierMulFor(s.id),
        specMul: specMulFor(s),
        ncBuff: ncBuffFor(s),
        terrainAt: spec?.terrainAt,
        inventory: isLatticeIsland ? unifiedInv : undefined,
        crossIsland,
        caps: isLatticeIsland ? unifiedCaps : undefined,
        cableComponent,
        worldSeed: worldState.seed,
        geothermalActive,
        solarBoost: solarBoostByIsland.get(s.id),
      }, nowWall);
      const { net, power } = computeRates(s, {
        modifierMul: modifierMulFor(s.id),
        specMul: specMulFor(s),
        ncBuff: ncBuffFor(s),
        terrainAt: spec?.terrainAt,
        inventory: isLatticeIsland ? unifiedInv : undefined,
        crossIsland,
        caps: isLatticeIsland ? unifiedCaps : undefined,
        cableComponent,
        geothermalActive,
        solarBoost: solarBoostByIsland.get(s.id),
      }, undefined, nowWall);
      islandNets.set(s.id, net);
      islandPower.set(s.id, power);
    }
    // Task 3: tutorial objective banner — check completion after every
    // economy advance so placement / level-up events are reflected immediately.
    if (worldState.tutorialState) {
      const newlyCompleted = checkObjectives(worldState.tutorialState, worldState);
      const current = worldState.tutorialState.current;
      const needsUpdate = newlyCompleted.length > 0 || lastRenderedObjective !== current;

      if (needsUpdate) {
        const banner = renderTutorialBanner(worldState.tutorialState);
        const old = document.getElementById('tutorial-banner');
        if (old) {
          if (banner) old.replaceWith(banner);
          else old.remove();
        } else if (banner) {
          document.body.appendChild(banner);
        }
        lastRenderedObjective = current;
      }
    }
    // §3.6 Island Joining: AFTER economy advances, walk pairs of populated
    // islands for ellipse overlaps. At most ONE merge runs per tick — the
    // pair with the largest combined tile count wins; remaining overlaps
    // re-evaluate on the next tick once the merged identity has new geometry.
    // Triggered most often by Land Reclamation Hub expanding an island into
    // a neighbor; cheap when no overlaps exist (O(N²) per tick, N is small).
    const merge = findNextMerge(worldState, islandStates);
    if (merge) {
      // Snapshot the active-island id BEFORE merge: if the active island is
      // being absorbed, the UI needs to redirect to the absorber so the HUD
      // doesn't read a deleted state on this very frame.
      const absorbedId = merge.absorbed.id;
      performMerge(worldState, islandStates, merge.absorber, merge.absorbed);
      // Update the lookup tables: absorbed spec is gone, absorber's modifiers
      // are unchanged (per §3.6, absorbed's modifiers are voided). Drop the
      // absorbed entries.
      islandSpecsById.delete(absorbedId);
      modifierMulsById.delete(absorbedId);
      if (activeIslandId === absorbedId) {
        activeIslandId = merge.absorber.id;
      }
      rebuildWorldLayers();
    }
    // Drones tick AFTER economy so any biofuel changes from this frame
    // are visible to the dispatch UI on the same frame; drone returns
    // are processed independent of economy state.
    //
    // §11 telemetry: pass `lastFrameMs` so the tick can compute the
    // per-tick capsule corridor from the drone's prev-tick position.
    // Rebuild render layers when either an island flips `discovered` OR
    // new cells got revealed (so the fog overlay / DISCOVERED_BLUE
    // squares update mid-flight, not just on return).
    const droneResult = tickDrones(worldState, now, prevFrameMs);
    if (
      droneResult.newlyDiscoveredIslandIds.length > 0 ||
      droneResult.revealedCellsAdded > 0
    ) {
      rebuildWorldLayers();
    }
    if (droneResult.lost.length > 0) {
      for (const d of droneResult.lost) {
        console.log(`Drone lost: ${d.id}`);
      }
    }
    tickRoutes(worldState, islandStates, now, elapsedSec);

    // §14 orbital tick chores. Order matters:
    //   1. Movement first (sats arrive / are lost in transit; cell occupancy
    //      changes for subsequent debris/cleanup).
    //   2. Sweeper cleanup before debris ticks so sat-cleared cells don't
    //      generate hits this same tick.
    //   3. Debris ticks (lodge / destruction / Kessler cascade).
    //   4. Scanner discovery using the post-movement sat positions.
    //   5. Comm packet propagation.
    //   6. Repair drone arrivals (existing — keep last so a successful arrival
    //      sees the freshly-cleaned/destroyed satellite state).
    const orbitalDeltaMs = now - prevFrameMs;
    tickSatMovement(worldState, now);
    tickSweeperCleanup(worldState, orbitalDeltaMs);
    tickDebris(worldState, now);
    tickScannerDiscovery(worldState, orbitalDeltaMs, now);
    tickCommPackets(worldState);
    tickRepairDrones(worldState, now);

    // Step-12 / §12: settlement vehicles tick after drones so a frame can
    // see new discoveries AND a brand-new arrival in the same pass. On
    // arrival, `tickVehicles` flips `target.populated`, places a Cargo
    // Dock / Helipad, and inserts a fresh IslandState into the map. We
    // register the new modifier-multiplier cache entry and rebuild render
    // layers so the colony becomes visible immediately.
    const vehicleResult = tickVehicles(worldState, islandStates, now);
    if (vehicleResult.arrivals.length > 0) {
      for (const arr of vehicleResult.arrivals) {
        const newSpec = islandSpecsById.get(arr.targetIslandId);
        if (newSpec) {
          modifierMulsById.set(
            arr.targetIslandId,
            effectiveModifierMultipliers(newSpec.modifiers),
          );
        }
      }
      rebuildWorldLayers();
    }
    if (vehicleResult.lost.length > 0) {
      for (const f of vehicleResult.lost) {
        console.log(`Settlement vehicle lost to weather: ${f.kind} → ${f.targetIslandId}`);
      }
    }
    if (vehicleResult.failures.length > 0) {
      // Minimal first-step: log to console. Future step can add UI toast.
      for (const f of vehicleResult.failures) {
        console.log(`Settlement vehicle mechanical failure: ${f.kind} → ${f.targetIslandId}`);
      }
    }

    // Recompute active island rates post-routes/vehicles so both the main HUD
    // and the multi-island bar show current data. Cable network balance is
    // re-used from the per-tick computation above — the route/vehicle ticks
    // don't add or remove power routes, so the connectivity is unchanged.
    const postTickActiveS = activeState();
    const postTickActiveP = activeSpec();
    const postTickLattice = unifiedInv !== undefined && worldState.latticeNodeIslands.includes(postTickActiveS.id);
    const postTickCableComponent = cableBalances.get(postTickActiveS.id);
    const postTickGeothermal = postTickActiveP?.modifiers.includes('geothermal_active') === true;
    const { net: postNet, power: postPower } = computeRates(postTickActiveS, {
      modifierMul: modifierMulFor(postTickActiveS.id),
      specMul: specMulFor(postTickActiveS),
      ncBuff: ncBuffFor(postTickActiveS),
      terrainAt: postTickActiveP?.terrainAt,
      inventory: postTickLattice ? unifiedInv : undefined,
      crossIsland: crossIslandById.get(postTickActiveS.id),
      caps: postTickLattice ? unifiedCaps : undefined,
      cableComponent: postTickCableComponent,
      geothermalActive: postTickGeothermal,
      accelerationMul: postTickActiveS.accelerationRemainingMin > 0 ? 3 : 1,
      solarBoost: solarBoostByIsland.get(postTickActiveS.id),
    }, undefined, nowWall);
    islandNets.set(activeIslandId, postNet);
    islandPower.set(activeIslandId, postPower);

    // Recompute rates AFTER the tick so the HUD shows the current
    // post-advance state (e.g., a freshly-stalled building reads as
    // 0 rate, not the rate it was running at one event ago).
    // Read through the active getters so a click-to-switch updates the
    // HUD on the next frame.
    const activeS = activeState();
    const activeP = activeSpec();
    const activeLattice = unifiedInv !== undefined && worldState.latticeNodeIslands.includes(activeS.id);
    const activeGeothermal = activeP?.modifiers.includes('geothermal_active') === true;
    if (activeLattice) {
      // Refresh the active island's net/power with unified inventory so the HUD
      // reads the same cross-island state that advanceIsland used.
      const activeCableComponent = cableBalances.get(activeS.id);
      const { net: activeNet, power: activePower } = computeRates(activeS, {
        modifierMul: modifierMulFor(activeS.id),
        specMul: specMulFor(activeS),
        ncBuff: ncBuffFor(activeS),
        terrainAt: activeP?.terrainAt,
        inventory: unifiedInv,
        crossIsland: crossIslandById.get(activeS.id),
        caps: unifiedCaps,
        cableComponent: activeCableComponent,
        geothermalActive: activeGeothermal,
        accelerationMul: activeS.accelerationRemainingMin > 0 ? 3 : 1,
        solarBoost: solarBoostByIsland.get(activeS.id),
      }, undefined, nowWall);
      islandNets.set(activeS.id, activeNet);
      islandPower.set(activeS.id, activePower);
    }
    const net = islandNets.get(activeS.id)!;
    const power = islandPower.get(activeS.id)!;
    const saveAgeSec =
      lastSaveAt === null ? null : Math.max(0, Math.floor((now - lastSaveAt) / 1000));
    // Objective display lives in the bottom-center tutorial banner only
    // (`tutorial-ui.ts`). The HUD's previous "Next objective" line + the
    // separate objectives.ts system were removed in the consolidation.
    hud.update(
      activeS,
      net,
      power,
      activeP,
      ncState,
      saveAgeSec,
      worldState.vehicles.length,
      activeIslandId,
      islandPower,
    );
    islandBar.update(activeIslandId, islandPower, saveAgeSec);
    // §13.3 Omniscient Lattice banner visibility.
    latticeBanner.style.display = worldState.latticeActive ? 'block' : 'none';
    // Skill tree only repaints while visible — DOM writes are wasted
    // otherwise. show() also forces a paint on transition so we don't
    // strictly need a per-frame call, but level-up while the panel is open
    // should be reflected in the points / xp counters live.
    skillTree.refresh();
    buildingsUi.refresh();
    // Inventory panel — cheap when hidden (early-returns in refresh()).
    // Reads the active state through deps + the live `net` snapshot.
    inventoryUi.refresh(activeS, net);
    dronesUi.refresh(now);
    routesUi.refresh(now);
    settlementUi.refresh(now);
    orbitalUi.refresh();
    weatherOverlay.refresh(now, () =>
      computeVisionSources(worldState.islands.filter((s) => s.populated)),
    );
    satelliteOverlay.refresh();
    antennaOverlay.refresh();
    buildingAlertsOverlay.refresh(now);
    // §2.7 visual tint shares the same wall-clock anchor as the economy's
    // solar gate (Date.now), so the overlay agrees with the power balance
    // and the HUD phase label (which also reads Date.now in hud.ts).
    dayNightTint.refresh(nowWall);
    // Settings panel — cheap when hidden (early-returns in refresh()).
    settingsUi.refresh();
    // §4 inspector: refresh while open so the live rate / power / inventory
    // numbers track the per-frame economy. Cheap when closed (one branch).
    inspector.refresh();
    // Selection outline stays in sync with the inspector target — if the
    // selected building was demolished externally (won't happen in step 2.5
    // but defensive for future tooling) the repaint clears the outline.
    repaintSelection();
    // Hover outline also re-evaluates each frame so the hover-suppression
    // check (hide hover when hover.id === selection.id) reconciles after a
    // click. Without this, the hover layer keeps the previously-drawn
    // outline visible until the next mousemove — which produces the
    // "click marks a different building" symptom when the user clicks
    // without moving the cursor afterward. repaintHover is cheap when
    // hoveredBuilding is unchanged (one Graphics.clear + redraw at most).
    repaintHover();
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
    // Active-island getters replace the old `__home` binding — `homeState`
    // is no longer the privileged anchor, so a console binding tied to it
    // would lie once the player clicks another island.
    (window as unknown as { __active: () => IslandState }).__active = activeState;
    (window as unknown as { __activeId: () => string }).__activeId = () => activeIslandId;
    (window as unknown as { __dbgHover: () => unknown }).__dbgHover = () => ({
      hoveredBuilding: hoveredBuilding
        ? { id: hoveredBuilding.building.id, defId: hoveredBuilding.building.defId, specId: hoveredBuilding.spec.id }
        : null,
      hoverLayerVisible: hoverLayer.visible,
      selectedSpecId: selectedSpec?.id ?? null,
      inspectorSelectedId: inspector.getSelectedBuildingId(),
      selectionLayerVisible: selectionLayer.visible,
    });
    void bind; // referenced for rebind-from-console workflows
    void TILE_PX;
  }
}

main().catch((err: unknown) => {
  console.error('[robot-islands] fatal:', err);
});
