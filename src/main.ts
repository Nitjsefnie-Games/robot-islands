// Robot Islands — step 2 bootstrap. Camera + multi-island map + vision states
// + config-driven input. The world container's position/scale is driven by the
// camera state every frame.
//
// Vision boundary: rendered as a three-tier ocean colour field (see
// `ocean.ts`). The colour step between tiers IS the boundary indicator —
// no outline ring. The ocean layer sits below islands so islands always
// render on top of it. Discovered islands stay full-opacity (no alpha/tint
// dimming); the ocean colour tier is the sole indicator of vision state.

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
import { computeRates, type IslandState, type PowerBalance, type RatesContext } from './economy.js';
import { advanceWorldEconomy } from './economy-advance.js';
import type { ResourceId } from './recipes.js';
import { computeNcState } from './network-consciousness.js';
import { createNewGame } from './new-game.js';
import { shouldTick } from './economy-clock.js';
import { computeSharedNetworkState } from './network.js';

import { tierForLevel, effectiveSkillMultipliers } from './skilltree.js';
import { renderCellGrid } from './grid.js';
import { mountHud, mountIslandBar } from './hud.js';
import { mountBuildQueuePanel } from './build-queue-ui.js';
import {
  bind,
  defineAction,
  dispatchKey,
  installDefaultBindings,
  makeRegistry,
} from './input.js';
import { resetUiLayout } from './window-manager.js';
import { TILE_PX } from './island.js';
import { computeVisionSources } from './lighthouse.js';
import { discoverIslandsInVision } from './vision-discovery.js';
import { visionSourcesSignature } from './vision-source.js';
import { discoverySignature } from './discovery-signature.js';
import { mountFeatureGlyphs, renderOcean, renderOceanFogOverlay } from './ocean.js';
import {
  clampSaveIntervalSec,
  DEFAULT_SAVE_INTERVAL_SEC,
  loadPrefs,
  loadWorld,
  savePrefs,
  saveWorld,
  serializeWorld,
} from './persistence.js';
import { mountSettingsUi } from './settings-ui.js';
import { BUILDING_DEFS } from './building-defs.js';
import { activeFloors, type PlacedBuilding } from './buildings.js';
import { mountBuildingsUi } from './buildings-ui.js';
import { mountConstructionUi } from './construction-ui.js';
import { mountInspectorUi, type InspectorTarget } from './inspector-ui.js';
import { type Axis } from './land-reclamation.js';
import { mountInventoryUi } from './inventory-ui.js';
import { buildingAtTile, findOceanBuildingAt } from './placement.js';
import { footprintTiles, shapeHeight, shapeWidth, type Rotation } from './shape-mask.js';
import { mountPlacementUi } from './placement-ui.js';
import { mountCargoLabelPicker } from './cargo-label-picker.js';
import { mountTerrainModifierTargetPicker } from './terrain-modifier-target-picker.js';
import { mountAnchorPicker } from './anchor-picker.js';
import { mountSkillTreeUi } from './skilltree-ui.js';
import { mountGraphUi } from './graph-ui.js';
import { mountSkillGraphView } from './skilltree-graphview.js';
import { mountUi } from './ui.js';
import {
  findPopulatedIslandAt,
  islandRenderState,
  renderIsland,
  tileToWorldPx,
  VISION_BLUE,
  type IslandSpec,
  type WorldState,
} from './world.js';
import { mountDronesUi } from './drones-ui.js';
import { tickDrones } from './drones.js';
import { WS_SYSTEMS_STEP_MS, advanceWorldSystems } from './world-systems-advance.js';
import {
  tickTradeOffers,
  tuningFor,
  effectiveCadenceMs,
  ONLINE_DT_CAP_MS,
  type TradeRuntime,
} from './trade.js';
import { mountTradeUi } from './trade-ui.js';
import { activeBonusMul, tickActiveBonus } from './active-bonus.js';
import { CELL_SIZE_TILES } from './constants.js';
import { SONAR_BUOY_DEF_ID, SONAR_BUOY_RADIUS_TILES, tickSonarBuoys } from './sonar-buoy.js';
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
import { mountRoutesUi } from './routes-ui.js';
import { RouteRenderer } from './routes-renderer.js';
import { computeCableNetworkBalance, drainRoutesForBuilding, routeSourceTile, tickRoutes, MAX_ROUTE_BENDS, type Route } from './routes.js';
import { insertBendOnSegment, pickRouteAt, pickWaypointAt } from './route-bend.js';
import { RouteBendOverlay } from './route-bend-overlay.js';
import { crossIslandNeighbors, latticeInventory, latticeStorageCaps } from './lattice.js';
import { mountSettlementUi } from './settlement-ui.js';
import { mountOrbitalUi } from './orbital-ui.js';
import { mountWeatherOverlay } from './weather-overlay.js';
import { computeWeatherVisionSources, weatherClockMs } from './weather.js';
import { mountAntennaOverlay } from './antenna-overlay.js';
import { mountHoverTooltip } from './hover-tooltip.js';
import { mountToastSurface } from './toast.js';
import { mountSatelliteOverlay } from './satellite-overlay.js';
import { mountBuildingAlertsOverlay } from './building-alerts-overlay.js';
import { createLobeBadgeOverlay } from './lobe-badge-overlay.js';
import { mountDayNightTint } from './daynight-tint.js';
import { showMapPicker } from './map-picker.js';
import { tickVehicles } from './settlement.js';
import { makeLocalGateway, makeRemoteGateway } from './mutation-gateway.js';
import { mountAuthScreen } from './auth-ui.js';
import { mountOfflineModal } from './offline-ui.js';
import type { ModalHandle } from './ui-modal.js';
import { connectGameServer, gameSocketUrl, type GameServerClient } from './server-client.js';
import { deserializeWorld, type SaveSnapshot } from './persistence.js';
import {
  isRemoteBootEnabled,
  loadStoredPlayerLatLon,
  storePlayerLatLon,
} from './remote-boot.js';
import { checkDismissals, currentStep, markShown } from './tutorial.js';
import { refreshTutorialHint } from './tutorial-ui.js';

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

  // Load UI prefs (camera + active-island + open-panel) in parallel with
  // world; applied below after the camera is constructed.
  const restoredPrefs = await loadPrefs();

  // Slice 4 REMOTE boot branch. REMOTE is the default; LOCAL is the opt-out
  // debug fallback, gated by `ri_server=0` in localStorage or `?server=0` in
  // the URL. In REMOTE mode the authoritative server owns the sim and pushes
  // full snapshots over WS; the client only renders. The LOCAL path is unchanged.
  const isRemote = isRemoteBootEnabled();

  type RemoteBootResult = {
    client: GameServerClient;
    snapshot: SaveSnapshot;
    setOnState(handler: (snapshot: SaveSnapshot) => void): void;
    setOnOfflinePending(handler: (gapMs: number) => void): void;
  };

  /** Authenticate (if necessary), open the game WebSocket, and wait for the
   *  first server-pushed snapshot. If the account has no game yet, try to
   *  migrate any existing local IndexedDB save; otherwise POST `/api/game/new`
   *  and wait for the state that follows. The returned `setOnState` lets main
   *  wire the subsequent-state handler after the render machinery is live. */
  async function bootRemoteClient(): Promise<RemoteBootResult> {
    // If the browser already has a valid session cookie, skip the auth screen.
    try {
      const me = await fetch('/api/auth/me', { credentials: 'include' });
      if (!me.ok) {
        await showAuthScreen();
      }
    } catch {
      await showAuthScreen();
    }

    /** One-time local-save migration. Reads the existing IDB save (if any),
     *  serializes it, and posts it to the server. On failure we fall through
     *  to a fresh game so a stale/corrupt local save doesn't brick boot. */
    async function importLocalSaveOrCreate(): Promise<void> {
      try {
        const local = await loadWorld();
        if (local) {
          const snapshot = serializeWorld(local.world, local.islandStates);
          const r = await fetch('/api/game/import', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ snapshot }),
          });
          if (r.ok) {
            // Server accepted the import; the next state push will carry the
            // imported game. Stop here and keep waiting.
            return;
          }
          console.warn('[robot-islands] local save import failed:', r.status, await r.text());
        }
      } catch (err) {
        console.warn('[robot-islands] local save import error:', err);
      }
      // No local save or import failed — ask the server to mint a fresh game.
      const r = await fetch('/api/game/new', { method: 'POST', credentials: 'include' });
      // A 409 means a game already exists (e.g. a concurrent import already
      // created it). Treat that as success-equivalent rather than a fatal
      // throw — the next state push carries the existing game.
      if (!r.ok && r.status !== 409) {
        throw new Error(`POST /api/game/new failed: ${r.status} ${await r.text()}`);
      }
    }

    return new Promise<RemoteBootResult>((resolve, reject) => {
      let client: GameServerClient | null = null;
      let gotFirst = false;
      // One-shot guard: the server re-pushes a null snapshot every 1s until a
      // game exists. If importLocalSaveOrCreate takes longer than that interval,
      // a second null push would re-fire the import (which then 409s and bricks
      // boot). Latch on first entry so subsequent null pushes are ignored while
      // the import is in flight.
      let importStarted = false;
      let onStateHandler: ((snapshot: SaveSnapshot) => void) | null = null;
      // The `offline-pending` frame arrives after the first `state` frame, by
      // which point main has wired the real handler via `setOnOfflinePending`.
      let onOfflinePendingHandler: ((gapMs: number) => void) | null = null;

      const onState = (snapshot: unknown | null) => {
        if (!gotFirst) {
          if (snapshot) {
            gotFirst = true;
            resolve({
              client: client!,
              snapshot: snapshot as SaveSnapshot,
              setOnState(handler) {
                onStateHandler = handler;
              },
              setOnOfflinePending(handler) {
                onOfflinePendingHandler = handler;
              },
            });
          } else if (!importStarted) {
            // Account has no saved game yet — migrate local save if possible,
            // then keep waiting for the next `state` frame.
            importStarted = true;
            importLocalSaveOrCreate().catch(reject);
          }
        } else {
          onStateHandler?.(snapshot as SaveSnapshot);
        }
      };

      client = connectGameServer({
        url: gameSocketUrl(),
        onState,
        onOfflinePending: (gapMs) => onOfflinePendingHandler?.(gapMs),
      });
    });
  }

  async function showAuthScreen(): Promise<void> {
    return new Promise<void>((resolve) => {
      const screen = mountAuthScreen({
        onAuthed: () => {
          screen.remove();
          resolve();
        },
      });
      document.body.appendChild(screen);
    });
  }

  // World state — mutable wrapper around the seed island data + the in-flight
  // drone fleet. `discovered` flags flip when drones return; `drones` mutates
  // on dispatch and tick. Renderer reads from here.
  //
  // §15.6 persistence: LOCAL path tries loadWorld() first; on a valid
  // current-version snapshot restore both worldState and islandStates, else
  // fall back to the demo-seed path (makeInitialWorld + per-spec
  // makeInitialIslandState). REMOTE path receives the initial snapshot from
  // the server over WS and never touches IDB.
  let worldState: WorldState;
  let islandStates: Map<string, IslandState>;
  let restored: Awaited<ReturnType<typeof loadWorld>> | null = null;
  let fresh: ReturnType<typeof createNewGame> | null = null;
  let remoteClient: GameServerClient | null = null;
  let setRemoteOnState: ((handler: (snapshot: SaveSnapshot) => void) => void) | null = null;
  // §9.9: the server now owns the closed-game active-bonus decay — on
  // `offline/accept` it decays the bonus 3×gap as part of catch-up, and on
  // `offline/reject` it preserves the bonus. The client no longer seeds the
  // heartbeat with the boot away-gap (that double-charged the gap).
  let setRemoteOnOfflinePending: ((handler: (gapMs: number) => void) => void) | null = null;

  if (isRemote) {
    const remote = await bootRemoteClient();
    remoteClient = remote.client;
    setRemoteOnState = remote.setOnState;
    setRemoteOnOfflinePending = remote.setOnOfflinePending;
    const d = deserializeWorld(remote.snapshot, Date.now(), performance.now());
    worldState = d.world;
    islandStates = d.islandStates;
    // The server snapshot does not own the player's real-world location; restore
    // any client-local lat/lon preference so the map picker doesn't reappear.
    const storedLatLon = loadStoredPlayerLatLon();
    if (
      storedLatLon &&
      (worldState.playerLat == null || worldState.playerLon == null)
    ) {
      worldState.playerLat = storedLatLon.lat;
      worldState.playerLon = storedLatLon.lon;
    }
  } else {
    restored = await loadWorld();
    // Fresh-game path is the pure `createNewGame` module (shared with the
    // authoritative server). Build it ONCE so the world + per-island states are
    // the same objects (createNewGame already wires world.islandStates).
    // LOCAL fresh game: seed the procedural world from the wall-clock creation
    // time so a Clear Save → reboot mints a NEW world (mirrors the server's
    // reset-timestamp seed); REMOTE doesn't reach here.
    fresh = restored ? null : createNewGame(performance.now(), String(Date.now()));
    worldState = restored ? restored.world : fresh!.world;
    islandStates = restored ? restored.islandStates : fresh!.islandStates;
  }

  worldState.islandStates = islandStates;

  // §15.1 wall-clock anchor for WEATHER sampling. Captured once per session
  // and threaded explicitly to every weather consumer so the value is never
  // stored in a process-global module variable (multi-tenant safety).
  const weatherWallOffsetMs = Date.now() - performance.now();

  // Slice 4 mutation gateway — LOCAL default. REMOTE receives the WS client
  // and forwards intents to the authoritative server.
  const gateway = isRemote && remoteClient
    ? makeRemoteGateway(remoteClient)
    : makeLocalGateway(worldState, islandStates, {}, weatherWallOffsetMs);

  if (worldState.playerLat == null || worldState.playerLon == null) {
    await new Promise<void>((resolve) => {
      showMapPicker({
        onPick: (lat, lon) => {
          worldState.playerLat = lat;
          worldState.playerLon = lon;
          if (isRemote) {
            storePlayerLatLon(lat, lon);
            void gateway.setLocation(lat, lon);
          } else {
            void saveWorld(worldState, islandStates);
          }
          resolve();
        },
      });
    });
  }

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
  // §6 feature glyph pass — ∿ (vent) / ⋮ (nodule) / ▭ (trench) at each
  // discovered + depth-revealed rare-feature cluster. Sits ABOVE the fog
  // overlay (so glyphs aren't masked by the player's unrevealed sweep) and
  // BELOW the weather overlay (so storms visually obscure glyphs per §6).
  // The glyphs are pixel-size invariant — `setZoom` is called per frame
  // from the ticker so they don't grow with camera zoom.
  const featureGlyphs = mountFeatureGlyphs();
  featureGlyphs.refresh(
    worldState.oceanCells,
    worldState.revealedCells,
    worldState.depthRevealedCells,
  );
  world.addChild(featureGlyphs.layer);
  // §2.6 weather overlay — translucent tint per cell within any populated
  // island's weather visibility range. Built once; refreshed via its own
  // throttle inside the ticker. Slot 4 — entity layers (drones/vehicles)
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
  // §6 sonar-buoy range ring — inspector-active overlay. Shown only when
  // the inspector is open on a Sonar Buoy, drawn at the buoy's per-tick
  // reveal radius so the player can see "this buoy covers THIS area" at a
  // glance. Drawn in world coords (camera-scaled) so the ring grows /
  // shrinks with the map — same as the drone / orbital launch reticles.
  // Distinct cyan-teal tint from the antenna overlay (cyan signal) and
  // satellite scanner (also cyan); see SONAR_RING_COLOR comment below.
  const sonarRingLayer = new Container();
  sonarRingLayer.label = 'sonar-buoy-range-ring';
  sonarRingLayer.visible = false;
  const sonarRingGfx = new Graphics();
  sonarRingLayer.addChild(sonarRingGfx);
  world.addChild(sonarRingLayer);
  // Sonar cyan-teal — close enough to VISION_BLUE that "this is a vision /
  // discovery building" still reads, but distinctly more teal so it doesn't
  // collide visually with the Antenna signal ring or Scanner Sat coverage
  // disk when several overlays happen to overlap.
  const SONAR_RING_COLOR = 0x40e0d0;
  function repaintSonarRing(): void {
    sonarRingGfx.clear();
    const selectedId = inspector.getSelectedBuildingId();
    if (!selectedId || !selectedSpec) {
      sonarRingLayer.visible = false;
      return;
    }
    const building = selectedSpec.buildings.find((b) => b.id === selectedId);
    if (!building || building.defId !== SONAR_BUOY_DEF_ID) {
      sonarRingLayer.visible = false;
      return;
    }
    // Buoy footprint centre in world tiles. Ocean def coords: `building.x =
    // cellX * CELL_SIZE_TILES - anchor.cx` (set by placement-ui), so
    // `anchor.cx + building.x = cellX * CELL_SIZE_TILES` — the NW corner
    // tile of the footprint. The 1×1-cell buoy footprint spans 16×16 tiles,
    // so the centre is + CELL_SIZE_TILES / 2 (= 8 tiles, NOT + 0.5 — that
    // would land 7.5 tiles off-axis and the ring would be visibly
    // asymmetric around the buoy). `tickSonarBuoys` uses + 0.5 for a
    // different reason: there it's disambiguating which CELL contains the
    // buoy point, then operating in cell-space (a half-tile nudge resolves
    // the boundary case). The display ring needs the actual visual centre.
    const footprintHalfTiles = CELL_SIZE_TILES / 2;
    const cxTile = selectedSpec.cx + building.x + footprintHalfTiles;
    const cyTile = selectedSpec.cy + building.y + footprintHalfTiles;
    const cxPx = cxTile * TILE_PX;
    const cyPx = cyTile * TILE_PX;
    // Reveal radius is in CELLS — translate to tiles via CELL_SIZE_TILES,
    // then to world pixels via TILE_PX. (`SONAR_BUOY_RADIUS_TILES = 4`
    // cells in current spec — the const name is historical.)
    const radiusPx = SONAR_BUOY_RADIUS_TILES * CELL_SIZE_TILES * TILE_PX;
    sonarRingGfx.circle(cxPx, cyPx, radiusPx).fill({
      color: SONAR_RING_COLOR,
      alpha: 0.05,
    });
    sonarRingGfx.circle(cxPx, cyPx, radiusPx).stroke({
      color: SONAR_RING_COLOR,
      width: 1.5,
      alpha: 0.45,
    });
    sonarRingLayer.visible = true;
  }
  // §2.7 day/night tint — full-viewport DOM overlay above the canvas,
  // pointer-events: none. Cheap diff-and-skip refresh per tick.
  const dayNightTint = mountDayNightTint(document.body);
  // §6 universal hover tooltip — tile-level info on land (terrain +
  // building + consumers + weather) and cell-level info on ocean (rare
  // cluster / unscouted depths / open ocean + weather). Load-bearing
  // because the weather overlay obscures feature glyphs during storms.
  // Sits below the modal scrim (z-index 50 < 60) so anchor / cargo
  // pickers overlay it without occluding the hover.
  const hoverTooltip = mountHoverTooltip(document.body);
  // Toast surface (top-center transient banners) — singleton, used by the
  // §14 launch flow and any future "global event" notifier.
  const toast = mountToastSurface(document.body);

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
    // Insert at the same Z slots: ocean 0, islands 1, fog 2.
    // Slot 3 (and the higher slots) are populated by appended children at
    // startup (glyphs, weather, satellite/antenna overlays, sonar ring,
    // grid) AND by post-startup `addChildAt` inserts for the routes layers
    // (static 4 / animated 5 / overlay 6) and the drone + settlement layers
    // (drones 7-8, settlement 9). This rebuild only re-anchors slots 0/1/2;
    // every other child rides along under Pixi's auto-reindex.
    world.removeChild(oldOcean);
    world.removeChild(oldIslands);
    world.removeChild(oldFog);
    world.addChildAt(oceanLayer, 0);
    world.addChildAt(islandLayer, 1);
    world.addChildAt(fogOverlayLayer, 2);
    // §6 feature glyphs — rebuild contents (cells revealed by drones / sat
    // / sonar buoy change with every discovery event). The layer instance
    // is reused; refresh swaps the child sprites. No re-add to `world`.
    featureGlyphs.refresh(
      worldState.oceanCells,
      worldState.revealedCells,
      worldState.depthRevealedCells,
    );
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
  // reset-ui-layout: clears persisted layout, restores zone-stack defaults.
  // No bind() — pick was reset_surface: settings_only. The settings-ui
  // button dispatches this action via dispatchAction(reg, 'reset-ui-layout').
  defineAction(reg, 'reset-ui-layout', () => { resetUiLayout(); });

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
    // Release handlers are side-effect-free (they just clear held flags),
    // so they run unconditionally even when a text input is focused.
    // This prevents a pan key from sticking when the user presses it,
    // moves focus into an input, and releases it there.
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

  // -----------------------------------------------------------------------
  // §2.6 route-bend gestures (placed routes only — NOT during placement)
  // -----------------------------------------------------------------------
  //
  // Click a bendable route → select it (handles + faint highlight appear,
  // weather overlay auto-shows). Drag the line → insert a bend and drag it.
  // Drag a handle → move that bend. Click a handle (no drag) → remove it.
  // Click empty ocean → deselect. All geometry/decisions live in the pure
  // `route-bend.ts` hit-testers; this glue only routes events → pure calls →
  // `gateway.setRouteWaypoints`. Mutual-exclusion with placement / launch
  // modes mirrors the existing pattern (the launch callbacks below clear the
  // selection on arm; the mousedown branch no-ops while a mode is armed).
  //
  // The overlay instance is constructed later (alongside the route renderer)
  // and assigned to this binding; the gesture helpers below reference it via
  // closure and only run after bootstrap completes, so the forward use is safe.
  let routeBendOverlay: RouteBendOverlay;
  let selectedBendRouteId: string | null = null;
  // Live drag state. `kind` distinguishes moving an existing handle from
  // inserting+dragging a new bend on a clicked segment. `index` is the
  // waypoint index being moved/inserted. `preview` is the full working
  // waypoints array (tile coords) the overlay renders mid-drag, committed on
  // mouseup. `null` = no bend drag in progress (camera pan owns the gesture).
  let bendDrag: {
    kind: 'waypoint' | 'segment';
    index: number;
    preview: Array<{ x: number; y: number }>;
  } | null = null;
  // Prior weather-overlay layer visibility, captured when a route is selected
  // so deselect restores it (the overlay has no toggle action — its layer is
  // simply forced visible while editing and restored after).
  let bendPrevWeatherVisible: boolean | null = null;

  /** Hit-test tolerance in TILE coords for a fixed screen-pixel budget — so
   *  handles/lines stay grabbable at any zoom (pure hit-testers work in tiles,
   *  the cursor budget is in screen px). */
  function bendTolTiles(): number {
    const HIT_PX = 10;
    return HIT_PX / Math.max(1e-6, cam.zoom * TILE_PX);
  }

  /** Live route currently selected for bending (re-resolved each use because
   *  applyRemoteSnapshot re-mints world.routes). */
  function selectedBendRoute(): Route | null {
    if (selectedBendRouteId === null) return null;
    return worldState.routes.find((r) => r.id === selectedBendRouteId) ?? null;
  }

  /** Push the current selection (and any live drag preview) into the overlay.
   *  Called on selection change and every drag mousemove. */
  function refreshBendOverlay(): void {
    const route = selectedBendRoute();
    if (route && bendDrag) {
      // Render the in-progress preview without committing: hand the overlay a
      // shallow clone of the route carrying the preview waypoints.
      routeBendOverlay.setSelected(
        { ...route, waypoints: bendDrag.preview } as Route,
        islandSpecsById,
      );
    } else {
      routeBendOverlay.setSelected(route, islandSpecsById);
    }
  }

  /** Force the weather overlay visible while a route is selected; restore the
   *  prior visibility when nothing is selected. */
  function syncBendWeatherOverlay(): void {
    if (selectedBendRouteId !== null) {
      if (bendPrevWeatherVisible === null) {
        bendPrevWeatherVisible = weatherOverlay.layer.visible;
      }
      weatherOverlay.layer.visible = true;
    } else if (bendPrevWeatherVisible !== null) {
      weatherOverlay.layer.visible = bendPrevWeatherVisible;
      bendPrevWeatherVisible = null;
    }
  }

  /** Clear the bend selection + drag and restore the weather overlay. Called
   *  on deselect and when another mode arms (mutual exclusion). */
  function clearBendSelection(): void {
    selectedBendRouteId = null;
    bendDrag = null;
    syncBendWeatherOverlay();
    refreshBendOverlay();
  }

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
    bendDrag = null;
    // §2.6 bend grab. Only when no placement / launch mode owns the cursor.
    // We START a bend drag (or change selection) here; the camera pan in the
    // mousemove handler is suppressed whenever `bendDrag` is active. A click
    // that grabs nothing falls through to normal pan / building-select.
    if (!anyModeArmed()) {
      const rect = app.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (sx >= 0 && sx <= rect.width && sy >= 0 && sy <= rect.height) {
        const wt = screenToWorldTile(sx, sy);
        const tol = bendTolTiles();
        const selRoute = selectedBendRoute();
        if (selRoute) {
          // Already selected: grabbing a handle moves it; grabbing the line
          // (this same route) inserts a new bend and drags it.
          const wpIdx = pickWaypointAt(selRoute, wt.x, wt.y, tol);
          if (wpIdx !== null) {
            const preview = (selRoute.waypoints ?? []).map((w) => ({ x: w.x, y: w.y }));
            bendDrag = { kind: 'waypoint', index: wpIdx, preview };
            refreshBendOverlay();
          } else if (pickRouteAt(worldState.routes, islandSpecsById, wt.x, wt.y, tol) === selRoute) {
            const existing = selRoute.waypoints ?? [];
            if (existing.length < MAX_ROUTE_BENDS) {
              const preview = insertBendOnSegment(selRoute, islandSpecsById, wt.x, wt.y);
              // The new bend's index is where `preview` first diverges from
              // `existing` (a single point was spliced in); fall back to the
              // tail if the splice landed at the end.
              let idx = preview.length - 1;
              for (let i = 0; i < existing.length; i++) {
                const a = existing[i]!;
                const b = preview[i];
                if (!b || b.x !== a.x || b.y !== a.y) { idx = i; break; }
              }
              bendDrag = { kind: 'segment', index: idx, preview };
              refreshBendOverlay();
            }
          }
        }
        if (!bendDrag) {
          // No grab on the current selection — (re)pick a route under the
          // cursor. Hit → select it + auto-show the weather overlay. A miss
          // does NOT deselect here: a pan that starts over empty ocean keeps
          // the current selection; deselection on an empty-ocean CLICK happens
          // in the mouseup handler.
          const hit = pickRouteAt(worldState.routes, islandSpecsById, wt.x, wt.y, tol);
          if (hit && hit.id !== selectedBendRouteId) {
            selectedBendRouteId = hit.id;
            syncBendWeatherOverlay();
            refreshBendOverlay();
          }
        }
      }
    }
  });
  // Right-click on the canvas: cancels placement OR pops the last
  // path-mode waypoint (popWaypoint is a no-op outside path mode).
  app.canvas.addEventListener('contextmenu', (e) => {
    if (dronesUi.isLaunchMode()) {
      dronesUi.popWaypoint();
    }
    e.preventDefault();
  });
  app.canvas.addEventListener('dblclick', (e) => {
    if (!dronesUi.isLaunchMode()) return;
    const result = dronesUi.finalizePath(performance.now());
    if (!result.ok && result.reason !== 'not-path-mode') {
      console.warn('[path-drone] dispatch rejected:', result.reason);
    }
    e.preventDefault();
  });
  window.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    // §2.6 bend gesture commit — runs FIRST (before the launch/placement/
    // building-select branches) and consumes the gesture when a bend was
    // grabbed or a selected route was clicked.
    {
      const wasClick = accumDrag < CLICK_DRAG_PX_MAX;
      if (bendDrag) {
        const drag = bendDrag;
        bendDrag = null;
        if (wasClick && drag.kind === 'waypoint') {
          // Click (no drag) on an existing handle → remove that bend.
          const final = drag.preview.filter((_, i) => i !== drag.index);
          if (selectedBendRouteId !== null) {
            void gateway.setRouteWaypoints(selectedBendRouteId, final);
          }
        } else if (selectedBendRouteId !== null) {
          // Drag (move handle / insert+drag a bend) — commit the preview. A
          // segment-click with no drag still commits the inserted bend at the
          // click point.
          void gateway.setRouteWaypoints(selectedBendRouteId, drag.preview);
        }
        refreshBendOverlay();
        return;
      }
      if (wasClick && selectedBendRouteId !== null && !anyModeArmed()) {
        // Click that grabbed nothing while a route was selected: deselect iff
        // it landed on empty ocean (no bendable route under the cursor).
        const rect = app.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        if (sx >= 0 && sx <= rect.width && sy >= 0 && sy <= rect.height) {
          const wt = screenToWorldTile(sx, sy);
          const hit = pickRouteAt(worldState.routes, islandSpecsById, wt.x, wt.y, bendTolTiles());
          if (!hit) {
            clearBendSelection();
            return;
          }
        }
      }
    }
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
      // §6 ocean-platform click-to-inspect — `findPopulatedIslandAt` only
      // reaches buildings inside an island's ellipse, so ocean platforms
      // (which sit OUTSIDE any ellipse on their anchor's `buildings[]`
      // array per Task 10) need a separate hit-test. Walks every populated
      // island's `buildings[]` looking for an `oceanPlacement: true` def
      // whose world-tile bbox contains the click — bbox extent uses
      // `shape × CELL_SIZE_TILES` because ocean footprint dims are in
      // cell units (a 1×1-cell sonar buoy spans a 16×16-tile target).
      const oceanHit = findOceanBuildingAt(worldState.islands, wt.x, wt.y);
      if (oceanHit) {
        const targetState = islandStates.get(oceanHit.spec.id);
        if (targetState) {
          inspector.open({
            spec: oceanHit.spec,
            state: targetState,
            building: oceanHit.building,
          });
          selectedSpec = oceanHit.spec;
          hoveredBuilding = { spec: oceanHit.spec, building: oceanHit.building };
          repaintSelection();
          repaintHover();
          // Same active-island discipline as the land-click branch — the
          // ocean inspector is a non-focusing inspection, no jump.
          return;
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
    // §2.6 bend drag owns the cursor — move the grabbed/inserted bend point to
    // the cursor (live preview) instead of panning the camera.
    if (bendDrag) {
      const rect = app.canvas.getBoundingClientRect();
      const wt = screenToWorldTile(e.clientX - rect.left, e.clientY - rect.top);
      const p = bendDrag.preview[bendDrag.index];
      if (p) { p.x = wt.x; p.y = wt.y; }
      refreshBendOverlay();
      return;
    }
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

  // §6 hover tooltip — throttled to one paint per animation frame so
  // mousemove (~60Hz) doesn't repaint twice per frame. The latest cursor
  // intent is stashed in `pendingHover`; a rAF loop drains it. When the
  // cursor leaves the canvas the pending payload is null and the tooltip
  // hides. Operates at tile granularity — `hoverTooltip` internally
  // dispatches per-tile for land and per-cell for ocean.
  let pendingHover: { sx: number; sy: number; clientX: number; clientY: number } | null = null;
  let hoverRafScheduled = false;
  const drainHover = (): void => {
    hoverRafScheduled = false;
    const p = pendingHover;
    pendingHover = null;
    if (!p) {
      hoverTooltip.hide();
      return;
    }
    // Suppress while any mode is armed — the placement preview / launch
    // reticle owns the cursor in those modes, and the universal tooltip
    // would clash with the placement-cell preview ring.
    if (anyModeArmed()) {
      hoverTooltip.hide();
      return;
    }
    const wt = screenToWorldTile(p.sx, p.sy);
    // Snap to the tile whose visual centre is nearest — same convention
    // as `buildingAtTile` / `placement-ui`. Tile (n) is rendered centred
    // on world pixel (n * TILE_PX).
    const tileX = Math.round(wt.x);
    const tileY = Math.round(wt.y);
    // §15.1: the tooltip's `nowMs` feeds weather sampling only — pass the
    // wall-anchored clock so the readout matches the overlay + simulation.
    hoverTooltip.setHover(
      worldState,
      tileX,
      tileY,
      p.clientX,
      p.clientY,
      weatherClockMs(performance.now(), weatherWallOffsetMs),
    );
  };
  const scheduleHoverDrain = (): void => {
    if (hoverRafScheduled) return;
    hoverRafScheduled = true;
    requestAnimationFrame(drainHover);
  };

  app.canvas.addEventListener('mousemove', (e) => {
    const rect = app.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    // Stash latest cursor intent for the hover-tooltip rAF drain. The
    // drain handler reads `anyModeArmed()` so we don't have to gate here.
    pendingHover = { sx, sy, clientX: e.clientX, clientY: e.clientY };
    scheduleHoverDrain();
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
    pendingHover = null;
    scheduleHoverDrain();
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
  // Per-island state is a Map keyed by island id so routes can dispatch
  // between any two populated islands; `hud.ts` paints every populated one.
  // Fresh-game path: per-island state from `createNewGame` (§3.7 starter
  // contract — home + new colonies start EMPTY). Restored saves use whatever
  // the player had at last save. REMOTE already received the map from the
  // server snapshot during boot.
  if (!isRemote) {
    islandStates = restored
      ? restored.islandStates
      : fresh!.islandStates;
  }
  // Sanity gate: home state must exist after init.
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

  // §15.1 per-island RatesContext snapshot — updated in the ticker after
  // cableBalances / solarBoosts are computed so the inspector can call
  // computeRates with the same context that advanceIsland/computeRates used
  // for the most recent tick.  Keyed by island id; read via getRatesContext().
  const lastIslandCtx = new Map<string, RatesContext>();

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
  const skillGraph = mountSkillGraphView(document.body, { getState: activeState, gateway });
  defineAction(reg, 'toggle-skill-graph', () => {
    skillGraph.toggle();
  });

  const skillTree = mountSkillTreeUi(document.body, { getState: activeState, gateway, openSkillGraph: () => skillGraph.show() });
  defineAction(reg, 'toggle-skill-tree', () => {
    skillTree.toggle();
  });

  const graphUi = mountGraphUi(document.body, {
    getState: activeState,
    getSpec: activeSpec,
  });
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
        clearBendSelection();
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
  // §4.6 placement-time cargo-label picker — mounted as a sibling to the
  // placement UI so the modal sits on document.body and floats above the
  // PixiJS canvas like every other ri-modal. Wired into placement-ui via
  // the `pickCargoLabel` dep below; only fires for generic-storage defs
  // (Crate today), bypassed entirely for specialized storage and non-
  // storage defs.
  const cargoLabelPicker = mountCargoLabelPicker(document.body, () => activeState());
  // §03 terrain_modifier v5: target-biome picker — same modal-shell pattern.
  const terrainTargetPicker = mountTerrainModifierTargetPicker(document.body);
  // §4 ocean-layer (Task 10): anchor picker — same modal-shell pattern as
  // the cargo-label picker. Mounted at body level so the modal floats
  // above the PixiJS canvas; wired into placement-ui via the `pickAnchor`
  // dep below. Only fires when the player commits an ocean-def placement
  // (def.oceanPlacement === true); land defs route past it untouched.
  const anchorPicker = mountAnchorPicker(document.body);
  const placementUi = mountPlacementUi({
    getTargetSpec: activeSpec,
    getTargetState: activeState,
    screenToWorldTile,
    gateway,
    onPlaced: () => {
      rebuildWorldLayers();
    },
    onRelocated: () => {
      rebuildWorldLayers();
    },
    pickCargoLabel: () => cargoLabelPicker.pick(),
    pickTerrainTarget: () => terrainTargetPicker.pick(),
    getWorld: () => worldState,
    getStateById: (id) => islandStates.get(id),
    pickAnchor: (cands) => anchorPicker.pick(cands),
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
    const islandWorldPx = tileToWorldPx(spec.cx, spec.cy);
    // §6 ocean-platform footprints are in CELL units, NOT tile units. A
    // 1×1-cell sonar_buoy spans 16×16 tiles; a 2×2-cell rig spans 32×32.
    // The shape-mask tiles[] holds cell-unit dx/dy (e.g. SHAPES.square2 =
    // {(0,0),(1,0),(0,1),(1,1)} — those are 4 adjacent CELLS, not 4
    // adjacent tiles). Treating each shape-mask entry as one tile (the
    // land convention) draws four nearly-overlapping 16-tile boxes in the
    // NW corner instead of the actual 32×32-tile footprint.
    //
    // Easiest correct behaviour: skip the shape-mask iteration for ocean
    // defs and draw ONE rectangle that spans the full cell-unit bbox.
    // (Ocean defs are always rectangular today; the SHAPES.single +
    // SHAPES.square2 footprint catalog at building-defs.ts only mints
    // rectangles, so the bbox = the visible footprint exactly.)
    const half = TILE_PX / 2;
    if (def.oceanPlacement === true) {
      const widthTiles = shapeWidth(def.footprint) * CELL_SIZE_TILES;
      const heightTiles = shapeHeight(def.footprint) * CELL_SIZE_TILES;
      const wpx = building.x * TILE_PX + islandWorldPx.x - half;
      const wpy = building.y * TILE_PX + islandWorldPx.y - half;
      gfx
        .rect(wpx, wpy, widthTiles * TILE_PX, heightTiles * TILE_PX)
        .fill({ color, alpha: fillAlpha })
        .stroke({ width: strokeWidth, color, alpha: 0.95, alignment: 1 });
      return;
    }
    const tiles = footprintTiles(
      def.footprint,
      building.x,
      building.y,
      (building.rotation ?? 0) as Rotation,
    );
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
    // §15.4: compare (islandId, buildingId) pairs so same-local-coord
    // buildings on different islands don't incorrectly suppress each other.
    const selectedId = inspector.getSelectedBuildingId();
    const selectedIslandId = inspector.getSelectedIslandId();
    if (
      selectedId &&
      selectedId === hoveredBuilding.building.id &&
      selectedIslandId === hoveredBuilding.spec.id
    ) {
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

  const inspector = mountInspectorUi(reg, document.body, {
    world: worldState,
    gateway,
    getRatesContext: (islandId: string) => lastIslandCtx.get(islandId),
    onDemolish: (target: InspectorTarget) => {
      const gatewayResult = gateway.demolishBuilding(target.spec.id, target.building.id);
      if (gatewayResult instanceof Promise) {
        void (async () => {
          const result = await gatewayResult;
          if (!result.ok) return;
          drainRoutesForBuilding(worldState, target.building.id);
          inspector.close();
          selectedSpec = null;
          hoveredBuilding = null;
          repaintHover();
          repaintSelection();
          rebuildWorldLayers();
        })();
        return;
      }
      if (!gatewayResult.ok) return;
      // A transport building's route drains when the building is removed —
      // in-flight cargo finishes, then tickRoutes prunes it.
      drainRoutesForBuilding(worldState, target.building.id);
      // Close the inspector + clear selection BEFORE the layer rebuild so
      // the stale-selection guard in repaintSelection doesn't fire.
      inspector.close();
      selectedSpec = null;
      hoveredBuilding = null;
      repaintHover();
      repaintSelection();
      rebuildWorldLayers();
    },
    onMove: (target: InspectorTarget) => {
      inspector.close();
      selectedSpec = null;
      hoveredBuilding = null;
      repaintHover();
      repaintSelection();
      placementUi.beginRelocate(target.building);
    },
    onSetActiveFloors: (target: InspectorTarget, newDisabledFloors: number) => {
      const b = target.building;
      const before = activeFloors(b);
      const gatewayResult = gateway.setBuildingActiveFloors(target.spec.id, b.id, newDisabledFloors);
      function finish(): void {
        const after = activeFloors(b);
        if (before > 0 && after === 0) {
          drainRoutesForBuilding(worldState, b.id);
        }
        rebuildWorldLayers();
        buildingAlertsOverlay.invalidate();
        inspector.refresh();
      }
      if (gatewayResult instanceof Promise) {
        void (async () => {
          const result = await gatewayResult;
          if (!result.ok) return;
          finish();
        })();
        return;
      }
      if (!gatewayResult.ok) return;
      finish();
    },
    onSetForceRun: (target: InspectorTarget, value: boolean) => {
      // §4.6 Force Run: keep producing for XP at a full output bin. Pure
      // per-building flag — no geometry/route/cap change, so no world-layer
      // rebuild is needed. Store `undefined` when off to keep saves clean
      // (absent ≡ off). The periodic autosave + visibilitychange save read
      // live `worldState`, so mutating the building object is enough to persist.
      const gatewayResult = gateway.setForceRun(target.spec.id, target.building.id, value);
      function finish(): void {
        buildingAlertsOverlay.invalidate(); // repaint the green level badge now
        inspector.refresh();
      }
      if (gatewayResult instanceof Promise) {
        void (async () => {
          const result = await gatewayResult;
          if (!result.ok) return;
          finish();
        })();
        return;
      }
      if (!gatewayResult.ok) return;
      finish();
    },
    onRefreshMaintenance: (target: InspectorTarget) => {
      // §4.7 Manual maintenance refresh: route through the gateway so REMOTE
      // authoritatively debits the 50%-placement-cost basket.
      const gatewayResult = gateway.refreshMaintenance(target.spec.id, target.building.id);
      function finish(): void {
        buildingAlertsOverlay.invalidate();
        inspector.refresh();
      }
      if (gatewayResult instanceof Promise) {
        void (async () => {
          const result = await gatewayResult;
          if (!result.ok) return;
          finish();
        })();
        return;
      }
      if (!gatewayResult.ok) return;
      finish();
    },
    onUpgradeFloor: (target: InspectorTarget, spendToken: boolean) => {
      const gatewayResult = gateway.applyUpgrade(target.spec.id, target.building.id, spendToken);
      function finish(): void {
        rebuildWorldLayers();
        buildingAlertsOverlay.invalidate();
        inspector.refresh();
      }
      if (gatewayResult instanceof Promise) {
        void (async () => {
          const result = await gatewayResult;
          if (!result.ok) return;
          finish();
        })();
        return;
      }
      if (!gatewayResult.ok) return;
      finish();
    },
    // §3.4 Land Reclamation: mutate spec/state via the pure helper, then
    // rebuild the world layer so the new ellipse mask propagates to
    // `renderIsland` (which recomputes `computeIslandTiles` from the
    // current radii on every rebuild). Selection / hover are kept since
    // the Hub itself doesn't move — the inspector stays open on the
    // same building with refreshed numbers.
    onExpandIsland: (target: InspectorTarget, index: number, axis: Axis) => {
      const gatewayResult = gateway.expandIsland(target.spec.id, index, axis);
      function finish(): void {
        rebuildWorldLayers();
        inspector.refresh();
      }
      if (gatewayResult instanceof Promise) {
        void (async () => {
          const result = await gatewayResult;
          if (!result.ok) return;
          finish();
        })();
        return;
      }
      if (!gatewayResult.ok) return;
      finish();
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
    // §13.3 Time Lock — toggle offline banking on the inspected island.
    onSetBankingEnabled: (target: InspectorTarget, enabled: boolean) => {
      const gatewayResult = gateway.setBankingEnabled(target.spec.id, enabled);
      function finish(): void {
        inspector.refresh();
      }
      if (gatewayResult instanceof Promise) {
        void (async () => {
          const result = await gatewayResult;
          if (!result.ok) return;
          finish();
        })();
        return;
      }
      if (!gatewayResult.ok) return;
      finish();
    },
    // §13.3 Time Lock — spend banked minutes from the source island onto the
    // chosen target island. No render rebuild needed; refresh rates/inspector.
    onSpendTimeLock: (target: InspectorTarget, targetIslandId: string, minutes: number) => {
      const gatewayResult = gateway.spendTimeLock(target.spec.id, targetIslandId, minutes);
      function finish(): void {
        inspector.refresh();
      }
      if (gatewayResult instanceof Promise) {
        void (async () => {
          const result = await gatewayResult;
          if (!result.ok) return;
          finish();
        })();
        return;
      }
      if (!gatewayResult.ok) return;
      finish();
    },
    // §13.3 Genesis Chamber — set the synthetic output resource (T1-T4 only).
    onSetGenesisTarget: (target: InspectorTarget, resourceId: ResourceId | null) => {
      const gatewayResult = gateway.setGenesisTarget(target.spec.id, resourceId);
      function finish(): void {
        inspector.refresh();
      }
      if (gatewayResult instanceof Promise) {
        void (async () => {
          const result = await gatewayResult;
          if (!result.ok) return;
          finish();
        })();
        return;
      }
      if (!gatewayResult.ok) return;
      finish();
    },
  });

  // §3.4 Land Reclamation Hub lobe badges — numbered "#1…#N" overlays at each
  // constituent centre, visible only while the inspector targets a Hub. Lives in
  // screen space so labels stay readable at any zoom; updated each frame below.
  const lobeBadges = createLobeBadgeOverlay(app.stage);

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
    gateway,
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
  // Autosave cadence (seconds), restored from prefs or defaulted. The timer
  // is (re)armed by `armSaveTimer` declared in the persistence block below;
  // `setSaveIntervalSec` here only fires on user interaction, by which point
  // that hoisted function and its `let` deps are live.
  let saveIntervalSec = restoredPrefs?.saveIntervalSec ?? DEFAULT_SAVE_INTERVAL_SEC;
  const settingsUi = mountSettingsUi(document.body, {
    reg,
    world: worldState,
    islandStates,
    getLastSavedAt: () => lastSaveAt,
    getSaveIntervalSec: () => saveIntervalSec,
    setSaveIntervalSec: (sec) => {
      saveIntervalSec = clampSaveIntervalSec(sec);
      armSaveTimer();
      // Persist immediately so the new cadence survives a refresh even before
      // the next world autosave lands.
      flushPrefsSave();
    },
    onChangeLocation: (lat, lon) => {
      worldState.playerLat = lat;
      worldState.playerLon = lon;
      storePlayerLatLon(lat, lon);
      void gateway.setLocation(lat, lon);
      if (!isRemote) triggerSave();
    },
    onSkipTutorial: () => {
      void gateway.skipTutorial();
    },
    onRestartTutorial: () => {
      void gateway.restartTutorial();
    },
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
    gateway,
    onLaunchModeChanged: (armed) => {
      if (armed) {
        placementUi.cancel();
        clearBendSelection();
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
    skillGraph.hide();
    buildingsUi.hide();
    constructionUi.hide();
    inventoryUi.hide();
    // settingsUi is mounted later; the closure captures the binding which
    // gets assigned before this action ever fires (panel-toggle happens
    // through user input, not synchronously during bootstrap).
    settingsUi.hide();
    orbitalUi.hide();
    placementUi.cancel();
    dronesUi.cancelPath();
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
    gateway,
    weatherWallOffsetMs,
    onDiscoveryChanged: rebuildWorldLayers,
    // Mutual-exclusion: when launch mode arms, cancel any in-progress
    // placement / settlement-arm / orbital-launch so a mouseup-commit can't
    // ambiguously route to multiple consumers.
    onLaunchModeChanged: (armed) => {
      if (armed) {
        placementUi.cancel();
        clearBendSelection();
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
  world.addChildAt(dronesUi.selectedPadHighlightLayer, 7);
  world.addChildAt(dronesUi.droneLayer, 8);
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
  world.addChild(dronesUi.scanPreviewLayer);
  world.addChild(dronesUi.launchPreviewLayer);
  // Wire the orbital-side forward-decl so an orbital arm-launch can disarm
  // the dronesUi panel.
  disarmDronesLaunch = () => dronesUi.setLaunchMode(false);
  defineAction(reg, 'toggle-drones', () => {
    dronesUi.toggle();
  });

  // Routes (freight-grid) side dock + world-space route renderer. Route
  // geometry lives in WORLD space (not screen space) so the cache survives
  // camera pan/zoom — the Pixi stage transform on `world` handles the camera
  // mapping. Three containers parented under `world` between the buildings +
  // drones layers (see z-order in spec §08).
  const routeRenderer = new RouteRenderer((islandId) => {
    const spec = islandSpecsById.get(islandId);
    if (!spec) return null;
    return tileToWorldPx(spec.cx, spec.cy);
  }, (route) => {
    // Draw the route FROM its source building (matches the §2.6 weather path).
    const tile = routeSourceTile(route, islandSpecsById);
    return tile ? tileToWorldPx(tile.x, tile.y) : null;
  });
  world.addChildAt(routeRenderer.staticLayer, 4);
  world.addChildAt(routeRenderer.animatedLayer, 5);
  world.addChildAt(routeRenderer.overlayLayer, 6);

  // §2.6 route-bend overlay — draws bend handles + a faint polyline highlight
  // for the route currently selected for bending. Lives in WORLD space (like
  // the route geometry) so handle positions read correctly at any zoom; sits
  // above the route overlay layer. Hidden until a route is selected. TILE_PX
  // is passed so handle geometry uses the real tile-size constant (not the
  // overlay's hardcoded default).
  routeBendOverlay = new RouteBendOverlay(TILE_PX);
  world.addChild(routeBendOverlay.layer);

  const routesUi = mountRoutesUi(document.body, {
    world: worldState,
    islandStates,
    islandSpecs: islandSpecsById,
    routeRenderer,
    gateway,
    weatherWallOffsetMs,
  });
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
    gateway,
    onLaunchModeChanged: (armed) => {
      if (armed) {
        // Disarm sister modes so a click can't ambiguously route to two.
        dronesUi.setLaunchMode(false);
        orbitalUi.setLaunchMode(false);
        placementUi.cancel();
        clearBendSelection();
      }
    },
    onInstantSettled: () => { rebuildWorldLayers(); },
  });
  world.addChildAt(settlementUi.vehicleLayer, 9);
  app.stage.addChild(settlementUi.reticleLayer);
  world.addChild(settlementUi.rangeRingLayer);
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
  // Debounced prefs save: cam pan/zoom needs a tighter cadence than the
  // world autosave — a player who pans then refreshes 3 seconds later
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
      saveIntervalSec,
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
    if (!isRemote) {
      void saveWorld(worldState, islandStates);
    }
    // Flush any pending prefs save synchronously alongside the world save —
    // ensures the 30s autosave and the visibility-change save always land
    // a fresh prefs blob even if the debounce timer was mid-flight.
    flushPrefsSave();
    if (!isRemote) {
      lastSaveAt = performance.now();
    }
  };
  // The autosave timer fires triggerSave; the closure captures the live
  // worldState/islandStates bindings (which are themselves stable references
  // even though their contents mutate). The cadence is user-configurable
  // (Settings → SAVE), so the interval id is stored and `armSaveTimer`
  // clears + re-creates it whenever `saveIntervalSec` changes.
  let saveTimerId: number | null = null;
  function armSaveTimer(): void {
    if (saveTimerId !== null) clearInterval(saveTimerId);
    if (isRemote) return; // server owns persistence in REMOTE mode
    saveTimerId = window.setInterval(triggerSave, saveIntervalSec * 1000);
  }
  armSaveTimer();
  // visibilitychange = tab switch / minimize / close. Saving on `hidden`
  // catches the case where the player closes the tab mid-session before
  // the next autosave tick — the spec calls this out as the primary "don't
  // lose progress since the last save" guarantee on top of the timer.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') triggerSave();
  });

  // Build-queue panel — draggable top-left window listing running/queued
  // construction jobs for the active island, each with a cancel button.
  // Mounted after triggerSave so the onCancel callback can call it.
  const buildQueueUi = mountBuildQueuePanel(reg, {
    getSpec: activeSpec,
    getState: activeState,
    gateway,
    onCancel: (_islandId: string) => {
      rebuildWorldLayers();
      buildingAlertsOverlay.invalidate();
      triggerSave();
    },
  });

  // Trade offer runtime — ephemeral, not persisted. Spawn cadence is gated by
  // each island's persisted tradeCooldownMs, burned down on visible online-dt
  // in the ticker (visibilityState === 'visible'); offers themselves never persist.
  const tradeRuntime: TradeRuntime = { offers: [] };

  // Trade offer overlay — card shown on the active island when a signal_exchange
  // is present and an offer has spawned. Acceptance mutates the island's inventory
  // via applyOffer and removes the offer from the runtime list.
  const tradeUi = mountTradeUi(
    async (offer) => {
      const result = await gateway.acceptTrade(offer);
      if (!result.ok) {
        // REMOTE rejections (offer expired / already taken) surface a toast;
        // LOCAL accept never fails (applyOffer re-clamps).
        if (isRemote) toast.show('Trade could not be completed.', 'info');
        return;
      }
      // REMOTE (§9.8 server-authoritative): the server applied the exchange,
      // compounded the cadence, and removed the offer; the next snapshot
      // reflects it. Mutating locally here would be reverted on the next push.
      if (isRemote) return;
      const st = islandStates.get(offer.islandId);
      if (!st) return;
      // LOCAL: each accepted trade compounds this island's next offer 1% sooner;
      // the cooldown is reset HERE (on resolution) so the increment lands on the
      // very next offer. tuningFor folds in the Logistics-Network frequency node.
      st.tradeAcceptCount += 1;
      st.tradeCooldownMs = effectiveCadenceMs(
        st.tradeAcceptCount,
        tuningFor(effectiveSkillMultipliers(st)).cadenceMs,
      );
      tradeRuntime.offers = tradeRuntime.offers.filter((o) => o.id !== offer.id);
    },
    async (offer) => {
      // REMOTE: compound cadence + remove offer authoritatively server-side.
      if (isRemote) {
        await gateway.rejectTrade(offer);
        return;
      }
      const st = islandStates.get(offer.islandId);
      if (!st) return;
      // LOCAL: manual reject counts as a timely reaction — compounds cadence but
      // exchanges no goods.
      st.tradeAcceptCount += 1;
      st.tradeCooldownMs = effectiveCadenceMs(
        st.tradeAcceptCount,
        tuningFor(effectiveSkillMultipliers(st)).cadenceMs,
      );
      tradeRuntime.offers = tradeRuntime.offers.filter((o) => o.id !== offer.id);
    },
  );

  // Update tick: apply held pan flags + sync camera state to the world
  // container, advance every populated island's economy, advance drone fleet,
  // advance inter-island routes, and update the HUD + side panels. One pass
  // per frame keeps the camera→container assignment cheap and predictable;
  // `advanceIsland`'s piecewise integration handles whatever elapsed interval
  // the frame brings (matters on tab-blur catch-up).

  // §Fix 6.1 offline drone catch-up: run ONE tickDrones covering the offline
  // window before the ticker's first frame. Without this, `lastFrameMs` starts
  // at `performance.now()` (≈ 0 on fresh load), and the first ticker frame
  // passes prevFrameMs ≈ nowMs so segStartMs ≈ nowMs >> drones' already-past
  // expectedReturnTime — the entire offline flight window is silently skipped.
  //
  // prevMs is the save time rebased to the new perf-clock domain: every island's
  // `lastTick` was set to `nowPerfMs - deltaMs` in deserializeWorld, so the min
  // over ALL islandStates' lastTick values is an accurate "offline window start"
  // (states minted fresh this session are stamped at load time and never win).
  // A fresh world (no restore) has no in-flight drones, so we skip the catch-up.
  if (restored) {
    const catchUpNowMs = performance.now();
    let prevMs = catchUpNowMs;
    for (const s of islandStates.values()) {
      if (s.lastTick < prevMs) prevMs = s.lastTick;
    }
    // §84 LOCAL offline catch-up: run the shared world-systems advance over the
    // offline window so routes, orbital chores, sonar, merge, and vehicles catch
    // up exactly as REMOTE does via the server. advanceWorldSystems already owns
    // drone ticking, so the previous standalone tickDrones call is removed here
    // to avoid double-counting drone flights/wear.
    const catchUp = advanceWorldSystems(
      worldState,
      islandStates,
      prevMs,
      catchUpNowMs,
      weatherWallOffsetMs,
    );
    // The initial ocean/island/fog layers were baked before this catch-up;
    // re-bake if it revealed anything so the offline scan is visible on the
    // very first frame (mirrors the per-frame rebuild trigger in the ticker).
    if (
      catchUp.newlyDiscoveredIslandIds.length > 0 ||
      catchUp.revealedCellsAdded > 0
    ) {
      rebuildWorldLayers();
    }
  }
  let lastFrameMs = performance.now();
  // §15.2 economy cadence — the ECONOMY_TICK_MS seam (economy-clock.ts;
  // TODO.md "Current TODO" item 3). The economy advances at 5 Hz, not per
  // render frame: `shouldTick` gates the advance block below, and these
  // retained outputs (last advance's nets / power balances / NC state) keep
  // every per-frame consumer (HUD, island bar, inspector via lastIslandCtx)
  // rendering between ticks with data at most ECONOMY_TICK_MS (~200 ms)
  // stale. `forceEconomyTick` lets structural events that mint or re-mint
  // islands (merge, settlement arrival) pull the next tick forward so the
  // retained maps never miss an island a consumer can select.
  let lastEconomyTickMs: number | null = null;
  let forceEconomyTick = false;
  // §2.2 vision-layer change detection: fingerprint of the current vision
  // sources. When it shifts (Lighthouse online / upgraded / relocated, island
  // populated) the cached ocean/fog layers are stale and must repaint, even
  // with no new discovery. Seeded from the initial state so the first tick
  // doesn't rebuild spuriously.
  let lastVisionSig = visionSourcesSignature(
    computeVisionSources(worldState.islands.filter((s) => s.populated)),
  );
  // §2.2 LOCAL depth-reveal gate: sonar buoys and scanner satellites add to
  // `depthRevealedCells` every frame. Track the size so a new depth-scout
  // triggers the same world-layer rebuild that `discoverySignature` gates in
  // REMOTE mode (#83).
  let lastDepthRevealedSig = worldState.depthRevealedCells.size;
  let lastNcState = computeNcState(worldState);
  const islandPower = new Map<string, PowerBalance>();
  const islandNets = new Map<string, Record<ResourceId, number>>();

  /** Cheap fingerprint of the world-layer-relevant state for REMOTE rebuild
   *  gating: discovered-island count + revealed-cell count PLUS a structural
   *  fingerprint of every island's rendered geometry (buildings + terrain
   *  modifiers + populated/discovered flags + ellipse radii + tile overrides).
   *  `renderIsland` draws building sprites and terrain tiles, so a building
   *  placed / demolished / moved / upgraded, an island expanded/merged, or a
   *  terrain-modifier/tile-override change must repaint. Non-visual fields such
   *  as forceRun, paused, cargoLabel, anchorIslandId and the construction
   *  boolean are intentionally excluded — they affect overlays/economy, not the
   *  baked world-layer texture. Paired with the vision-source signature below —
   *  the same diff discipline the LOCAL ticker uses to avoid re-baking GPU
   *  textures on every idle push. */
  let lastDiscoverySig = discoverySignature(worldState);

  /** Apply a server-pushed snapshot in REMOTE mode: mutate the live world/state
   *  objects IN PLACE (so every overlay/inspector/panel that captured them by
   *  reference at mount observes the update), rebuild derived lookup tables,
   *  recompute retained rates for the HUD/inspector, and repaint the world
   *  layers only when vision/discovery actually changed. */
  function applyRemoteSnapshot(snapshot: SaveSnapshot): void {
    const nowWall = Date.now();
    const d = deserializeWorld(snapshot, nowWall, performance.now());

    // Mutate the EXISTING worldState in place rather than reassigning the
    // binding. Subsystems (weather/satellite/antenna overlays, inspector,
    // orbital/drones/routes/settlement panels) captured the boot-time
    // worldState object by reference and never re-bind; reassigning would
    // orphan them on permanently-frozen data. Object.assign copies every
    // enumerable field the deserialized world carries (islands, drones,
    // routes, vehicles, satellites, repairDrones, debrisFields, revealedCells,
    // tutorialState, latticeActive, latticeNodeIslands,
    // activeBonusMs, commPackets, oceanCells, depthRevealedCells, totalCo2Kg,
    // playerLat/Lon, generatedCells, recentBuildAttempts*, seed) onto the live
    // object. `recentBuildAttempts`/`recentBuildAttemptTs` come back fresh-empty
    // from deserialize (NOT-persisted client-local sets) — overwriting them is
    // fine (the server snapshot has no opinion on them).
    Object.assign(worldState, d.world);
    // Keep the islandStates back-link pointing at the live Map (below).
    worldState.islandStates = islandStates;

    // Reconcile the EXISTING islandStates Map in place (don't replace the Map
    // object — panels captured this exact Map reference). Delete keys the
    // server no longer reports, set/update the ones it does.
    for (const id of [...islandStates.keys()]) {
      if (!d.islandStates.has(id)) islandStates.delete(id);
    }
    for (const [id, st] of d.islandStates) {
      islandStates.set(id, st);
    }

    // The server snapshot does not own the player's real-world location; restore
    // any client-local lat/lon preference so the map picker doesn't reappear.
    const storedLatLon = loadStoredPlayerLatLon();
    if (
      storedLatLon &&
      (worldState.playerLat == null || worldState.playerLon == null)
    ) {
      worldState.playerLat = storedLatLon.lat;
      worldState.playerLon = storedLatLon.lon;
    }

    islandSpecsById.clear();
    modifierMulsById.clear();
    for (const spec of worldState.islands) {
      islandSpecsById.set(spec.id, spec);
      modifierMulsById.set(spec.id, effectiveModifierMultipliers(spec.modifiers));
    }

    if (!islandStates.has(activeIslandId)) {
      activeIslandId = 'home';
    }
    if (!islandStates.has(activeIslandId)) {
      for (const id of islandStates.keys()) {
        activeIslandId = id;
        break;
      }
    }

    refreshRetainedRates(nowWall);

    // Re-sync client-cached object references that were orphaned by the
    // server snapshot re-minting worldState.islands. Panels that read live
    // getters (inspector, HUD) are unaffected; modules that held direct
    // references to IslandSpec / PlacedBuilding objects need to be
    // re-resolved by id so they don't render stale geometry/state.
    if (selectedSpec) {
      selectedSpec = islandSpecsById.get(selectedSpec.id) ?? null;
    }
    if (hoveredBuilding) {
      const spec = islandSpecsById.get(hoveredBuilding.spec.id);
      if (spec) {
        const building = spec.buildings.find((b) => b.id === hoveredBuilding!.building.id);
        hoveredBuilding = building ? { spec, building } : null;
      } else {
        hoveredBuilding = null;
      }
    }
    repaintSelection();
    repaintHover();

    // Panels that only repaint on open or that cache object references must
    // refresh against the authoritative snapshot while they are visible.
    if (skillGraph.isVisible()) skillGraph.refresh();
    if (constructionUi.isVisible()) constructionUi.refresh();
    if (routesUi.isVisible()) routesUi.refresh(performance.now());
    if (graphUi.isVisible()) graphUi.refresh();

    // §2.2 rebuild discipline: only re-bake the ocean/island/fog GPU textures
    // when the vision-source set OR the discovery/revealed-cell state actually
    // changed. The server pushes a full snapshot every 1s plus per-intent;
    // unconditionally rebuilding churned the GPU at a steady 1 Hz at idle.
    const visionSig = visionSourcesSignature(
      computeVisionSources(worldState.islands.filter((s) => s.populated)),
    );
    const discoverySig = discoverySignature(worldState);
    const changed = visionSig !== lastVisionSig || discoverySig !== lastDiscoverySig;
    lastVisionSig = visionSig;
    lastDiscoverySig = discoverySig;

    if (changed) {
      rebuildWorldLayers();
    }
  }

  if (isRemote) {
    // Prime retained HUD/inspector outputs from the initial server snapshot;
    // subsequent snapshots are handled by the WS callback wired below.
    refreshRetainedRates(Date.now());
    setRemoteOnState!(applyRemoteSnapshot);

    // §9.9 / Appendix C: on an `offline-pending` frame the server is serving
    // the PRE-gap snapshot and BLOCKING normal intents until we send
    // `offline/accept` or `offline/reject`. Force the choice with a
    // non-dismissible modal; the server pushes the resolved state via the
    // normal `applyRemoteSnapshot` path after acking the resolving intent.
    let offlineModal: ModalHandle | null = null;
    setRemoteOnOfflinePending!((gapMs) => {
      // Guard against a second prompt (e.g. a multi-socket re-fire) stacking
      // another modal on top of the live one.
      if (offlineModal) return;
      const dismiss = () => {
        offlineModal?.hide();
        offlineModal?.el.remove();
        offlineModal = null;
      };
      offlineModal = mountOfflineModal(
        document.body,
        gapMs,
        () => {
          void remoteClient!.sendIntent('offline/accept', {}).finally(dismiss);
        },
        () => {
          void remoteClient!.sendIntent('offline/reject', {}).finally(dismiss);
        },
      );
    });
  }

  /** The economy advance (5 Hz, gated by `shouldTick` in the ticker below).
   *  Everything in here runs at ECONOMY_TICK_MS cadence: NC/lattice/cable/
   *  solar precomputes, the per-island advanceIsland + computeRates loop,
   *  the retained islandNets/islandPower/lastIslandCtx outputs, and the
   *  active-island rate refresh the HUD reads. `now`/`nowWall` are the
   *  gating frame's clocks; advanceIsland integrates the full interval
   *  since each island's lastTick, so a long gap is one big-dt advance. */
  const advanceEconomy = (now: number, nowWall: number): void => {
    // §15.6: the full economy advance lives in the PURE `advanceWorldEconomy`
    // (economy-advance.ts) so the authoritative server runs the IDENTICAL
    // orchestration (NC buff / lattice + shared-network pooling / cross-island
    // adjacency / cable brownout / Mirror-Sat solar / active-play bonus /
    // geothermal / per-island modifiers) — no client/server drift. The only
    // render-side effect (terrain-shot → rebuildWorldLayers) is threaded back
    // through the `onTerrainShotFire` hook; `resolveShot` itself runs inside
    // the pure module on both sides. The returned per-island ctx + NC state
    // feed the HUD/inspector bookkeeping below (lastNcState, lastIslandCtx,
    // islandNets, islandPower) WITHOUT recomputing the per-tick precompute.
    let needRebuild = false;
    const { ncState, islandCtx: builtIslandCtx } = advanceWorldEconomy(
      worldState,
      islandStates,
      now,
      nowWall,
      {
        onTerrainShotFire: () => {
          needRebuild = true;
        },
      },
    );
    lastNcState = ncState;
    for (const s of islandStates.values()) {
      const islandCtx = builtIslandCtx.get(s.id);
      if (!islandCtx) continue;
      lastIslandCtx.set(s.id, islandCtx);
      const { net, power } = computeRates(s, islandCtx, undefined, nowWall);
      islandNets.set(s.id, net);
      islandPower.set(s.id, power);
    }
    if (needRebuild) rebuildWorldLayers();
    // The post-tick active-island HUD recompute below still needs the per-tick
    // precompute outputs (lattice inventory/caps, cross-island adjacency, cable
    // balances, solar boost). Recompute them here cheaply — these are the same
    // pure helpers `advanceWorldEconomy` used internally, so the HUD reads the
    // identical environment the integrator saw this tick.
    const ncBuffFor = (s: IslandState): number =>
      tierForLevel(s.level) >= 3 ? ncState.globalProductionBuff : 1;
    const unifiedInv = latticeInventory(worldState);
    const unifiedCaps = latticeStorageCaps(worldState);
    const crossIslandById = new Map<string, PlacedBuilding[]>();
    if (worldState.latticeActive) {
      for (const id of worldState.latticeNodeIslands) {
        const neighbors = crossIslandNeighbors(worldState, id);
        if (neighbors) crossIslandById.set(id, neighbors);
      }
    }
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
        ncBuff: stForCtx ? ncBuffFor(stForCtx) : undefined,
        activeBonusMul: activeBonusMul(worldState),
        terrainAt: spec?.terrainAt,
        inventory: isLatticeIsland ? unifiedInv : undefined,
        crossIsland: crossIslandById.get(id),
        caps: isLatticeIsland ? unifiedCaps : undefined,
        geothermalActive: spec?.modifiers.includes('geothermal_active') === true,
        solarBoost: solarBoostByIsland.get(id),
      };
    };
    const cableBalances = computeCableNetworkBalance(worldState, islandStates, cableLocalCtxFor, now, nowWall);
    // Recompute the active island's rates so the HUD and multi-island bar
    // show post-advance data. (Before the 5 Hz gate this ran after the
    // per-frame route/vehicle ticks; their inventory effects now surface at
    // the next economy tick, <= ECONOMY_TICK_MS later.) Cable balance is
    // re-used from the per-tick computation above — the route/vehicle ticks
    // don't add or remove power routes, so the connectivity is unchanged.
    const postTickActiveS = activeState();
    const postTickActiveP = activeSpec();
    const postTickLattice = unifiedInv !== undefined && worldState.latticeNodeIslands.includes(postTickActiveS.id);
    const postTickCableComponent = cableBalances.get(postTickActiveS.id);
    const postTickGeothermal = postTickActiveP?.modifiers.includes('geothermal_active') === true;
    const { net: postNet, power: postPower } = computeRates(postTickActiveS, {
      modifierMul: modifierMulFor(postTickActiveS.id),
      ncBuff: ncBuffFor(postTickActiveS),
      activeBonusMul: activeBonusMul(worldState),
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
        ncBuff: ncBuffFor(activeS),
        activeBonusMul: activeBonusMul(worldState),
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
  };

  /** REMOTE-mode rate refresh. The server owns the simulation and pushes full
   *  snapshots; the client recomputes the derived HUD/inspector rates from the
   *  snapshot so panels repaint without running the economy advance locally. */
  function refreshRetainedRates(nowWall: number): void {
    const ncState = computeNcState(worldState);
    lastNcState = ncState;
    const ncBuffFor = (s: IslandState): number =>
      tierForLevel(s.level) >= 3 ? ncState.globalProductionBuff : 1;

    const unifiedInv = latticeInventory(worldState);
    const unifiedCaps = latticeStorageCaps(worldState);
    const crossIslandById = new Map<string, PlacedBuilding[]>();
    if (worldState.latticeActive) {
      for (const id of worldState.latticeNodeIslands) {
        const neighbors = crossIslandNeighbors(worldState, id);
        if (neighbors) crossIslandById.set(id, neighbors);
      }
    }

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
      const stForCtx = islandStates.get(id);
      return {
        modifierMul: modifierMulFor(id),
        ncBuff: stForCtx ? ncBuffFor(stForCtx) : undefined,
        activeBonusMul: activeBonusMul(worldState),
        terrainAt: spec?.terrainAt,
        solarBoost: solarBoostByIsland.get(id),
      };
    };
    const cableBalances = computeCableNetworkBalance(
      worldState,
      islandStates,
      cableLocalCtxFor,
      performance.now(),
      nowWall,
    );
    const sharedNetwork = computeSharedNetworkState(worldState);

    for (const s of islandStates.values()) {
      const spec = islandSpecsById.get(s.id);
      const isLatticeIsland = unifiedInv !== undefined && worldState.latticeNodeIslands.includes(s.id);
      const isNetParticipant = sharedNetwork.participantIds.has(s.id);
      const crossIsland = crossIslandById.get(s.id);
      const cableComponent = cableBalances.get(s.id);
      const geothermalActive = spec?.modifiers.includes('geothermal_active') === true;
      const sharedInventory = isNetParticipant && !isLatticeIsland
        ? Object.fromEntries(sharedNetwork.sharedInventory) as Record<ResourceId, number>
        : undefined;
      const sharedCaps = isNetParticipant && !isLatticeIsland
        ? Object.fromEntries(sharedNetwork.sharedStorageCap) as Record<ResourceId, number>
        : undefined;

      const ctx: RatesContext = {
        modifierMul: modifierMulFor(s.id),
        ncBuff: ncBuffFor(s),
        activeBonusMul: activeBonusMul(worldState),
        terrainAt: spec?.terrainAt,
        inventory: isLatticeIsland ? unifiedInv : sharedInventory,
        crossIsland,
        caps: isLatticeIsland ? unifiedCaps : sharedCaps,
        cableComponent,
        geothermalActive,
        solarBoost: solarBoostByIsland.get(s.id),
        accelerationMul: s.accelerationRemainingMin > 0 ? 3 : 1,
        world: worldState,
      };
      lastIslandCtx.set(s.id, ctx);
      const { net, power } = computeRates(s, ctx, undefined, nowWall);
      islandNets.set(s.id, net);
      islandPower.set(s.id, power);
    }
  }

  // §9.9 REMOTE activity-heartbeat accumulators. Focused/unfocused ms are
  // accumulated per frame and flushed to the server every 5s so the server
  // owns the authoritative active-bonus balance.
  let hbFocusedMs = 0;
  // No boot away-gap seed: the server owns closed-game §9.9 decay (applied on
  // `offline/accept`, skipped on `offline/reject`), so seeding the first
  // heartbeat with the gap would double-charge it.
  let hbUnfocusedMs = 0;
  let hbLastSentMs = 0;
  const HEARTBEAT_INTERVAL_MS = 5000;

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
    // §6 keep feature-glyph sprites at fixed pixel size as the camera zooms
    // by counter-scaling each sprite's width/height by 1/zoom. Cheap when
    // zoom is unchanged (early-returns inside `setZoom`).
    featureGlyphs.setZoom(cam.zoom);
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
    // §15.2 economy cadence: gate the advance block to 5 Hz. Camera/input/
    // UI/overlay code in this ticker stays per-frame; the economy advance
    // and the precomputes that exist solely to feed it run only when the
    // cadence elapses (or a structural event forces a tick). See
    // economy-clock.ts (ECONOMY_TICK_MS — the server-migration seam).
    if (!isRemote) {
      // World-system tick block (merge/drones/routes/orbital/sonar/vehicles).
      // The authoritative server runs the same sequence via
      // src/world-systems-advance.ts during catch-up; keep the two in sync.
      if (forceEconomyTick || shouldTick(now, lastEconomyTickMs)) {
        lastEconomyTickMs = now;
        forceEconomyTick = false;
        advanceEconomy(now, nowWall);
        // §2.2 vision discovers islands live (vision-discovery.ts), AND the
        // cached ocean/fog layers must repaint whenever the vision-source set
        // changes — a Lighthouse finishing construction / upgrading / relocating
        // extends the halo over already-known territory with no new discovery,
        // which the discovery signal alone misses. Rebuild on either signal.
        const newlyDiscovered = discoverIslandsInVision(worldState);
        const visionSig = visionSourcesSignature(
          computeVisionSources(worldState.islands.filter((s) => s.populated)),
        );
        const visionChanged = visionSig !== lastVisionSig;
        lastVisionSig = visionSig;
        if (newlyDiscovered.length > 0 || visionChanged) {
          rebuildWorldLayers();
        }
      }
      // Trade offer lifecycle. Online = tab visible (visibilityState === 'visible').
      // hasFocus() was previously also required but dropped on owner request 2026-06-10
      // — visibility alone is the activity signal. onlineDtMs is the capped online
      // time elapsed this frame and is 0 when not online, so the persisted cooldown
      // only burns down on visible time. Called every frame so expiry pruning stays current.
      const tradeOnline = document.visibilityState === 'visible';
      const onlineDtMs = tradeOnline ? Math.min(elapsedSec * 1000, ONLINE_DT_CAP_MS) : 0;
      // §9.9 active-play bonus: same online condition as trades; the module
      // internally clamps accrual and decays the unfocused remainder, so the
      // RAW frame dt goes in (NOT onlineDtMs — decay needs the full interval).
      tickActiveBonus(worldState, tradeOnline, elapsedSec * 1000);
      // Stamp last-active so a closed-game reload decays only true away time.
      worldState.lastActiveMs = nowWall;
      // §9.8: offer spawnedAt/expiresAt are WALL-clock (persisted, server-
      // authoritative in REMOTE), so the LOCAL tick stamps them with nowWall —
      // the same clock the trade-UI countdown reads.
      tickTradeOffers(
        tradeRuntime,
        islandStates,
        worldState.seed,
        (state) => tuningFor(effectiveSkillMultipliers(state)),
        nowWall,
        onlineDtMs,
      );
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
        lastIslandCtx.delete(absorbedId);
        islandNets.delete(absorbedId);
        islandPower.delete(absorbedId);
        // Re-minted buildings change the absorber's rates — pull the next
        // economy tick forward so the retained HUD data doesn't lag the merge.
        forceEconomyTick = true;
        if (activeIslandId === absorbedId) {
          activeIslandId = merge.absorber.id;
        }
        // §15.4 / §3.6 merge: after performMerge the absorbed island's buildings
        // are re-minted with shifted ids into the absorber. If the inspector or
        // hover state points at a building id that no longer resolves (was
        // re-minted during the merge), clear both so repaintSelection's
        // stale-selection guard fires cleanly rather than leaving a ghost outline.
        const selectedIslandIdNow = inspector.getSelectedIslandId();
        const selectedBuildingIdNow = inspector.getSelectedBuildingId();
        if (selectedIslandIdNow !== null && selectedBuildingIdNow !== null) {
          const owningSpec = islandSpecsById.get(selectedIslandIdNow);
          const stillExists = owningSpec?.buildings.some((b) => b.id === selectedBuildingIdNow) ?? false;
          if (!stillExists) {
            inspector.close();
            selectedSpec = null;
          }
        }
        if (hoveredBuilding) {
          const hovSpec = islandSpecsById.get(hoveredBuilding.spec.id);
          const stillHovered = hovSpec?.buildings.some((b) => b.id === hoveredBuilding!.building.id) ?? false;
          if (!stillHovered) {
            hoveredBuilding = null;
            repaintHover();
          }
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
      const droneResult = tickDrones(worldState, now, prevFrameMs, weatherWallOffsetMs);
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
      tickRoutes(worldState, islandStates, now, elapsedSec, weatherWallOffsetMs);

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
      const orbitalStepIndex = Math.floor(now / WS_SYSTEMS_STEP_MS);
      tickSatMovement(worldState, now);
      tickSweeperCleanup(worldState, orbitalDeltaMs);
      tickDebris(worldState, now, orbitalDeltaMs, orbitalStepIndex);
      tickScannerDiscovery(worldState, orbitalDeltaMs, now, orbitalStepIndex);
      tickCommPackets(worldState);
      tickRepairDrones(worldState, now);

      // Ocean-layer §5 — Sonar Buoy depth-discovery. Idempotent (Set writes),
      // cheap (per-buoy disk is ≤81 cells at the placeholder radius of 4).
      // Order: after the scanner-sat tick so both depth-revealing systems run
      // in the same frame and any cell newly covered by either is visible to
      // the fog/glyph overlay rebuilt below.
      tickSonarBuoys(worldState);

      // §2.2 LOCAL rebuild gate for depth reveals. Scanner sats and sonar buoys
      // mutate `depthRevealedCells` per-frame; unlike surface reveals from
      // drones, there is no `revealedCellsAdded` counter, so compare the size
      // signature and repaint the ocean/glyph layers when it grows (#83).
      const depthRevealedSig = worldState.depthRevealedCells.size;
      if (depthRevealedSig !== lastDepthRevealedSig) {
        lastDepthRevealedSig = depthRevealedSig;
        rebuildWorldLayers();
      }

      // Step-12 / §12: settlement vehicles tick after drones so a frame can
      // see new discoveries AND a brand-new arrival in the same pass. On
      // arrival, `tickVehicles` flips `target.populated`, places a Cargo
      // Dock / Helipad, and inserts a fresh IslandState into the map. We
      // register the new modifier-multiplier cache entry and rebuild render
      // layers so the colony becomes visible immediately.
      // §12 discovery: pass `prevFrameMs` so the vehicle's per-tick single-cell
      // scan trail is computed from its prev-tick position (same as drones).
      const vehicleResult = tickVehicles(worldState, islandStates, now, weatherWallOffsetMs, prevFrameMs);
      if (
        vehicleResult.newlyDiscoveredIslandIds.length > 0 ||
        vehicleResult.revealedCellsAdded > 0
      ) {
        rebuildWorldLayers();
      }
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
        // The freshly-populated island isn't in the retained islandNets /
        // islandPower maps yet — force the next economy tick so it's selectable
        // with live data immediately instead of up to ECONOMY_TICK_MS later.
        forceEconomyTick = true;
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

    }
    const activeS = activeState();
    const activeP = activeSpec();
    // Last-tick rates/power for the active island (retained across frames —
    // up to ECONOMY_TICK_MS stale by design). Undefined only in the sliver
    // between a structural event minting a new island and the forced tick
    // that follows it; skip the HUD repaint for that frame rather than crash.
    const net = islandNets.get(activeS.id);
    const power = islandPower.get(activeS.id);
    const saveAgeSec =
      lastSaveAt === null ? null : Math.max(0, Math.floor((now - lastSaveAt) / 1000));
    // Objective display lives in the bottom-center tutorial banner only
    // (`tutorial-ui.ts`). The HUD's previous "Next objective" line + the
    // separate objectives.ts system were removed in the consolidation.
    if (net && power) {
      hud.update(
        activeS,
        net,
        power,
        activeP,
        lastNcState,
        saveAgeSec,
        worldState.vehicles.length,
        activeIslandId,
        islandPower,
      );
      islandBar.update(activeIslandId, islandPower, saveAgeSec);
    }
    // §9.8: in REMOTE the authoritative offers live in worldState.tradeOffers
    // (server-owned, refreshed by each snapshot push). Mirror them into the
    // display runtime so the trade card shows server offers; LOCAL keeps its
    // own tradeRuntime.offers. Countdown reads wall-clock (offers are wall-timed).
    if (isRemote) tradeRuntime.offers = worldState.tradeOffers ?? [];
    tradeUi.update(tradeRuntime, activeIslandId, nowWall);
    // §13.3 Omniscient Lattice banner visibility.
    latticeBanner.style.display = worldState.latticeActive ? 'block' : 'none';

    // §9.9 REMOTE activity heartbeat. The client accumulates capped focused
    // and unfocused ms per frame and flushes them to the server periodically.
    // The server applies the accrual/decay authoritatively and stamps
    // lastActiveMs so load-time decay only charges true away time.
    if (isRemote) {
      const frameMs = elapsedSec * 1000;
      const online = document.visibilityState === 'visible';
      hbFocusedMs += online ? Math.min(frameMs, ONLINE_DT_CAP_MS) : 0;
      hbUnfocusedMs += online ? 0 : frameMs;
      if (now - hbLastSentMs >= HEARTBEAT_INTERVAL_MS) {
        if (hbFocusedMs > 0 || hbUnfocusedMs > 0) void gateway.activeHeartbeat(hbFocusedMs, hbUnfocusedMs);
        hbFocusedMs = 0;
        hbUnfocusedMs = 0;
        hbLastSentMs = now;
      }
    }

    // Skill tree only repaints while visible — DOM writes are wasted
    // otherwise. show() also forces a paint on transition so we don't
    // strictly need a per-frame call, but level-up while the panel is open
    // should be reflected in the points / xp counters live.
    skillTree.refresh();
    skillGraph.refreshHud();
    buildingsUi.refresh();
    // Inventory panel — cheap when hidden (early-returns in refresh()).
    // Samples the active island's inventory through deps for its rolling
    // 5s-average rate display.
    inventoryUi.refresh();
    dronesUi.refresh(now);
    routesUi.refresh(now);
    // §2.6 bend overlay — re-sync from the live selected route each frame so a
    // committed bend / unbend (LOCAL or via a REMOTE snapshot that re-mints
    // world.routes) is reflected, then advance any per-frame draw. A no-op when
    // nothing is selected. During a drag `refreshBendOverlay` keeps showing the
    // preview (bendDrag is set), so this doesn't clobber an in-progress edit.
    if (selectedBendRouteId !== null && selectedBendRoute() === null) {
      // The selected route vanished (deleted / drained / snapshot dropped it).
      clearBendSelection();
    } else {
      refreshBendOverlay();
    }
    routeBendOverlay.update();
    settlementUi.refresh(now);
    orbitalUi.refresh();
    weatherOverlay.refresh(
      now,
      () => computeWeatherVisionSources(worldState.islands.filter((s) => s.populated)),
      weatherWallOffsetMs,
    );
    satelliteOverlay.refresh();
    antennaOverlay.refresh();
    buildingAlertsOverlay.refresh(now);
    // §2.7 visual tint shares the same wall-clock anchor as the economy's
    // solar gate (Date.now), so the overlay agrees with the power balance
    // and the HUD phase label (which also reads Date.now in hud.ts).
    dayNightTint.refresh(nowWall, worldState.playerLat, worldState.playerLon);
    // Settings panel — cheap when hidden (early-returns in refresh()).
    settingsUi.refresh();
    // §4 inspector: refresh while open so the live rate / power / inventory
    // numbers track the per-frame economy. Cheap when closed (one branch).
    inspector.refresh();
    // Build-queue panel — refreshes every frame so progress % stays live.
    buildQueueUi.refresh();
    // Selection outline stays in sync with the inspector target — if the
    // selected building was demolished externally (won't happen in step 2.5
    // but defensive for future tooling) the repaint clears the outline.
    repaintSelection();
    // §6 sonar-buoy range ring tracks the same selection state. Cheap
    // when nothing is selected (one early return) and even when a non-
    // buoy building is selected (single defId compare).
    repaintSonarRing();
    // §3.4 lobe badges: show "#1…#N" at each constituent centre only while the
    // inspector is open on a Land Reclamation Hub. Reuses `selectedSpec` and the
    // inspector's selected-building id (same source the selection outline uses).
    const selectedBuildingId = inspector.getSelectedBuildingId();
    const selectedHubBuilding = selectedSpec && selectedBuildingId
      ? selectedSpec.buildings.find((b) => b.id === selectedBuildingId)
      : null;
    lobeBadges.update(
      selectedHubBuilding?.defId === 'land_reclamation_hub' ? selectedSpec : null,
      cam,
    );
    // Hover outline also re-evaluates each frame so the hover-suppression
    // check (hide hover when hover.id === selection.id) reconciles after a
    // click. Without this, the hover layer keeps the previously-drawn
    // outline visible until the next mousemove — which produces the
    // "click marks a different building" symptom when the user clicks
    // without moving the cursor afterward. repaintHover is cheap when
    // hoveredBuilding is unchanged (one Graphics.clear + redraw at most).
    repaintHover();

    // Phase 7 §05 — tutorial polling. Runs once per frame in BOTH LOCAL and
    // REMOTE modes. Detection (currentStep/markShown/checkDismissals) is
    // client-local: `shownAt` is transient and never serialized. Completion
    // and the onboarding XP bump are authoritative, so each dismissed step is
    // routed through the mutation gateway (LOCAL applies immediately; REMOTE
    // sends a `mark-tutorial-completed` intent and reflects on the next
    // snapshot).
    const shownStep = currentStep(worldState);
    if (shownStep) markShown(worldState, shownStep.id);
    const dismissedSteps = checkDismissals(worldState);
    if (dismissedSteps.length > 0) {
      for (const id of dismissedSteps) {
        void gateway.markTutorialCompleted(id);
      }
    }
    refreshTutorialHint(worldState, {
      onCompleteStep: (stepId) => {
        void gateway.markTutorialCompleted(stepId);
      },
    });

    if (!isRemote) {
      // recentBuildAttempts TTL — 5 s window
      if (worldState.recentBuildAttempts.size > 0) {
        const now = performance.now();
        for (const [defId, ts] of worldState.recentBuildAttemptTs) {
          if (now - ts > 5000) {
            worldState.recentBuildAttempts.delete(defId);
            worldState.recentBuildAttemptTs.delete(defId);
          }
        }
      }
    }
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
