// src/mutation-gateway.ts — client-side mutation seam (slice 4, step A).
//
// LOCAL default: every method maps directly to the same pure functions the
// client already calls, so behavior is byte-identical to the pre-gateway inline
// calls. REMOTE forwards intents via `GameServerClient` and is wired but not
// connected to boot in this step.
//
// This module is logic-only: no PixiJS imports.

import { BUILDING_DEFS, type BuildingDefId } from './building-defs.js';
import { displayedFloorLevel } from './floor-levels.js';
import type { PlacedBuilding } from './buildings.js';
import type { IslandState } from './economy.js';
import { dispatchDrone, firePulse, type DroneTier } from './drones.js';
import type { TerrainKind } from './island.js';
import { canExpandIsland, expandIsland, type Axis } from './land-reclamation.js';
import {
  constructIsland,
  makeArtificialIdGenerator,
  validateConstruction,
  type ConstructResult,
} from './artificial-island.js';
import {
  applyUpgrade,
  applyRelabelStorageCap,
  cancelConstruction,
  demolishBuilding,
  placeBuilding,
  relocateBuilding,
  setBuildingActiveFloors,
} from './placement.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { CARGO_WILDCARD, type CargoEntry, type CargoMode } from './route-cargo.js';
import {
  createRouteFromBuilding,
  islandHasTeleporterPad,
  reorderPriorityList,
  routeProfileForBuilding,
  type Route,
} from './routes.js';
import type { Rotation } from './shape-mask.js';
import type { GameServerClient } from './server-client.js';
import {
  dispatchRepairDrone,
  launchSatellite,
  requestSatMove,
  upgradeSpaceport,
  type SatelliteVariant,
} from './orbital.js';
import type { NodeId, CrystalId } from './skilltree-graph.js';
import {
  bindCrystal,
  buyKeystone,
  buyNode,
  canBuyKeystone,
  effectiveGraph,
  effectiveSkillMultipliers,
  keystonePrereqFor,
  unbindCrystal,
} from './skilltree.js';
import { dispatchVehicle, settleViaSpacetimeAnchor } from './settlement.js';
import type { VehicleKind, VehicleTier } from './settlement.js';
import { canTierReset, executeTierReset } from './tier-reset.js';
import { convertToServitor as pureConvertToServitor } from './servitor.js';
import { tryRefreshMaintenance } from './maintenance.js';
import { applyOffer, type TradeOffer } from './trade.js';
import { editIslandBiome } from './universe-editor.js';
import { renameIsland } from './world.js';
import type { Biome, IslandSpec, WorldState } from './world.js';

// ── Result shape ─────────────────────────────────────────────────────────────

export interface GatewayOk<T = void> {
  readonly ok: true;
  readonly value?: T;
}

export interface GatewayErr {
  readonly ok: false;
  readonly error: string;
  /** The machine-readable reason from the underlying pure function, when one
   *  exists (e.g. a `PlacementReason` or `OceanPlacementReason`). */
  readonly reason?: string;
}

export type GatewayResult<T = void> = GatewayOk<T> | GatewayErr;

/** Value returned by a gateway method may be resolved synchronously (LOCAL) or
 *  asynchronously (REMOTE). `await` handles both; synchronous callers that must
 *  inspect the result immediately can use `unwrapGatewayResult`. */
export type GatewayReturn<T = void> = GatewayResult<T> | Promise<GatewayResult<T>>;

/** Synchronously unwrap a gateway return. LOCAL methods return plain result
 *  objects, so this is safe for the default production path. REMOTE returns a
 *  Promise; this helper intentionally throws in that case so the synchronous
 *  contract fails loudly instead of silently returning stale data. */
export function unwrapGatewayResult<T>(value: GatewayReturn<T>): GatewayResult<T> {
  if (value instanceof Promise) {
    throw new Error('Cannot synchronously unwrap a remote gateway result');
  }
  return value;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export interface LocalGatewayHooks {
  /** Optional wall-clock source. Methods that accept an explicit `nowMs`
   *  ignore this. When absent, `performance.now()` is used as a last resort. */
  readonly getNowMs?: () => number;
}

// ── Interface ────────────────────────────────────────────────────────────────

export interface MutationGateway {
  // §4 buildings
  placeBuilding(
    islandId: string,
    defId: BuildingDefId,
    x: number,
    y: number,
    rotation: Rotation,
    options?: {
      cargoLabel?: ResourceId;
      anchorIslandId?: string;
      terrainTarget?: TerrainKind;
      terrainShotMs?: number;
      nowMs?: number;
      idGenerator?: () => string;
    },
  ): GatewayReturn<PlacedBuilding>;
  demolishBuilding(islandId: string, buildingId: string): GatewayReturn;
  relocateBuilding(
    islandId: string,
    buildingId: string,
    x: number,
    y: number,
    rotation?: Rotation,
  ): GatewayReturn;
  applyUpgrade(islandId: string, buildingId: string): GatewayReturn;
  cancelConstruction(islandId: string, buildingId: string): GatewayReturn;
  setBuildingActiveFloors(islandId: string, buildingId: string, disabledFloors: number): GatewayReturn;
  setForceRun(islandId: string, buildingId: string, value: boolean): GatewayReturn;
  refreshMaintenance(islandId: string, buildingId: string): GatewayReturn;
  convertToServitor(islandId: string, buildingId: string): GatewayReturn;
  relabelCargo(islandId: string, buildingId: string, newLabel: ResourceId): GatewayReturn;
  expandIsland(islandId: string, axis: Axis): GatewayReturn;
  renameIsland(islandId: string, name: string): GatewayReturn;
  editBiome(islandId: string, biomeId: string): GatewayReturn;
  setLocation(lat: number, lon: number): GatewayReturn;
  constructIsland(
    args: {
      founderIslandId: string;
      biome: Biome;
      majorRadius: number;
      minorRadius: number;
      cx: number;
      cy: number;
      displayName?: string;
      nowMs?: number;
    },
  ): GatewayReturn<ConstructResult>;

  // §11 drones
  dispatchDrone(
    islandId: string,
    originX: number,
    originY: number,
    dirX: number,
    dirY: number,
    fuelLoaded: number,
    nowMs: number,
    waypoints?: ReadonlyArray<{ x: number; y: number }>,
    selectedTier?: DroneTier | '5-path',
  ): GatewayReturn;
  firePulse(islandId: string, nowMs: number): GatewayReturn;

  // §12 settlement
  dispatchSettler(
    originIslandId: string,
    targetIslandId: string,
    kind: VehicleKind,
    tier: VehicleTier,
    fuelLoaded: number,
    foundationKitCount: number,
    nowMs: number,
  ): GatewayReturn;
  settleViaSpacetime(originIslandId: string, targetIslandId: string, nowMs: number): GatewayReturn;

  // §14 orbital
  launchSatellite(
    islandId: string,
    variant: SatelliteVariant,
    targetX: number,
    targetY: number,
    nowMs: number,
  ): GatewayReturn;
  upgradeSpaceport(islandId: string): GatewayReturn;
  moveSatellite(satId: string, targetX: number, targetY: number, nowMs: number): GatewayReturn;
  dispatchRepairDrone(islandId: string, satId: string, nowMs: number): GatewayReturn;

  // §9 skill tree
  unlockSkillNode(islandId: string, nodeId: NodeId): GatewayReturn;
  buyKeystone(islandId: string, nodeId: NodeId): GatewayReturn;
  bindCrystal(islandId: string, socketId: string, crystalId: CrystalId): GatewayReturn;
  unbindCrystal(islandId: string, socketId: string): GatewayReturn;
  tierReset(islandId: string, nowMs: number): GatewayReturn;

  // §6 routes
  createRoute(
    fromIslandId: string,
    toIslandId: string,
    buildingId: string,
    filterResource?: ResourceId | null,
  ): GatewayReturn;
  deleteRoute(routeId: string): GatewayReturn;
  setRouteMode(routeId: string, mode: CargoMode): GatewayReturn;
  setCargoWeight(routeId: string, cargoIndex: number, weight: number): GatewayReturn;
  setCargoFloorPct(routeId: string, cargoIndex: number, sourceFloorPct?: number): GatewayReturn;
  reorderRouteCargo(routeId: string, srcIndex: number, dstIndex: number): GatewayReturn;
  setRouteCargo(routeId: string, cargo: CargoEntry[]): GatewayReturn;

  // §? trade
  acceptTrade(offer: TradeOffer): GatewayReturn<{ give: number; get: number }>;

  // §9.9 active-play bonus heartbeat (REMOTE only; LOCAL accrues per-frame)
  activeHeartbeat(focusedMs: number, unfocusedMs: number): GatewayReturn;
}

// ── LOCAL factory ────────────────────────────────────────────────────────────

export function makeLocalGateway(
  world: WorldState,
  islandStates: Map<string, IslandState>,
  hooks: LocalGatewayHooks = {},
): MutationGateway {
  function nowMsOr(fallback: number, explicit?: number): number {
    return explicit ?? hooks.getNowMs?.() ?? fallback;
  }

  function resolveIsland(islandId: string): { spec: IslandSpec; state: IslandState } | null {
    const state = islandStates.get(islandId);
    const spec = world.islands.find((s) => s.id === islandId);
    if (!state || !spec) return null;
    return { spec, state };
  }

  function err(error: string, reason?: string): GatewayErr {
    return { ok: false, error, reason };
  }

  function isValidResourceId(v: unknown): v is ResourceId {
    return typeof v === 'string' && (ALL_RESOURCES as ReadonlyArray<string>).includes(v);
  }

  function isValidCargoMode(v: unknown): v is CargoMode {
    return v === 'priority' || v === 'waterfall' || v === 'split' || v === 'balanced';
  }

  function isValidVehicleKind(v: unknown): v is VehicleKind {
    return v === 'ship' || v === 'helicopter';
  }

  function isValidVehicleTier(v: unknown): v is VehicleTier {
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 4;
  }

  /** LOCAL mirror of the server's validateCargoList in server/src/game/intents.ts. */
  function validateCargoList(cargo: unknown): { ok: true; list: CargoEntry[] } | { ok: false; error: string } {
    if (!Array.isArray(cargo)) return { ok: false, error: 'cargo must be an array' };
    const list: CargoEntry[] = [];
    const seen = new Set<string>();
    let seenAll = false;
    for (const entry of cargo) {
      if (entry === null || typeof entry !== 'object') return { ok: false, error: 'cargo entry must be an object' };
      const { resourceId, weight, sourceFloorPct } = entry as Record<string, unknown>;
      if (typeof resourceId !== 'string') return { ok: false, error: 'cargo entry resourceId must be a string' };
      if (resourceId !== CARGO_WILDCARD && !isValidResourceId(resourceId)) {
        return { ok: false, error: `unknown cargo resourceId ${resourceId}` };
      }
      if (resourceId === CARGO_WILDCARD) {
        if (seenAll) return { ok: false, error: 'only one all wildcard allowed' };
        seenAll = true;
      } else {
        if (seen.has(resourceId)) return { ok: false, error: `duplicate cargo resourceId ${resourceId}` };
        seen.add(resourceId);
      }
      if (weight !== undefined) {
        if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
          return { ok: false, error: 'cargo weight must be positive' };
        }
      }
      if (sourceFloorPct !== undefined) {
        if (
          typeof sourceFloorPct !== 'number' ||
          !Number.isFinite(sourceFloorPct) ||
          sourceFloorPct < 0 ||
          sourceFloorPct > 100
        ) {
          return { ok: false, error: 'cargo sourceFloorPct must be 0..100' };
        }
      }
      list.push({
        resourceId,
        ...(weight !== undefined ? { weight } : {}),
        ...(sourceFloorPct !== undefined ? { sourceFloorPct } : {}),
      } as CargoEntry);
    }
    return { ok: true, list };
  }

  function ok<T = void>(value?: T): GatewayOk<T> {
    return { ok: true, value };
  }

  function fromOutcome(
    outcome: { readonly ok: true } | { readonly ok: false; readonly reason?: string },
  ): GatewayResult {
    return outcome.ok ? ok() : err(outcome.reason ?? 'failed', outcome.reason);
  }

  function findRoute(routeId: string): Route | undefined {
    return world.routes.find((r) => r.id === routeId);
  }

  return {
    placeBuilding(islandId, defId, x, y, rotation, options = {}) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      if (options.cargoLabel !== undefined && !isValidResourceId(options.cargoLabel)) {
        return err('cargoLabel must be a valid resource id');
      }
      const idGenerator = options.idGenerator ?? (() => `placed-${islandId}-${x},${y}`);
      const result = placeBuilding(
        island.spec,
        island.state,
        defId,
        x,
        y,
        rotation,
        idGenerator,
        nowMsOr(island.state.lastTick, options.nowMs),
        options.cargoLabel,
        options.anchorIslandId,
        options.terrainTarget,
        options.terrainShotMs,
      );
      if (!result.ok) return err(result.reason, result.reason);
      return ok(result.placed);
    },

    demolishBuilding(islandId, buildingId) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      return fromOutcome(demolishBuilding(island.spec, island.state, buildingId));
    },

    relocateBuilding(islandId, buildingId, x, y, rotation) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      return fromOutcome(relocateBuilding(island.spec, island.state, buildingId, x, y, rotation));
    },

    applyUpgrade(islandId, buildingId) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      return fromOutcome(applyUpgrade(island.spec, island.state, buildingId));
    },

    cancelConstruction(islandId, buildingId) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      return fromOutcome(cancelConstruction(island.spec, island.state, buildingId));
    },

    setBuildingActiveFloors(islandId, buildingId, disabledFloors) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      if (typeof disabledFloors !== 'number' || !Number.isInteger(disabledFloors) || disabledFloors < 0) {
        return err('disabledFloors must be a non-negative integer');
      }
      const b = island.spec.buildings.find((bb) => bb.id === buildingId);
      if (!b) return err('not-found');
      if (disabledFloors > displayedFloorLevel(b)) return err('disabledFloors out of range');
      return fromOutcome(setBuildingActiveFloors(island.spec, island.state, buildingId, disabledFloors));
    },

    setForceRun(islandId, buildingId, value) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      const b = island.spec.buildings.find((bb) => bb.id === buildingId);
      if (!b) return err('not-found');
      b.forceRun = value ? true : undefined;
      return ok();
    },

    refreshMaintenance(islandId, buildingId) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      const b = island.spec.buildings.find((bb) => bb.id === buildingId);
      if (!b) return err('not-found');
      const def = BUILDING_DEFS[b.defId as BuildingDefId];
      const fired = tryRefreshMaintenance(
        b,
        def,
        island.state.inventory,
        Date.now(),
        effectiveSkillMultipliers(island.state).maintenanceThreshold,
      );
      return fired ? ok() : err('maintenance not due or unaffordable');
    },

    convertToServitor(islandId, buildingId) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      const result = pureConvertToServitor(island.state, buildingId, BUILDING_DEFS);
      if (!result.ok) return err(result.reason, result.reason);
      return ok();
    },

    relabelCargo(islandId, buildingId, newLabel) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      if (typeof newLabel !== 'string' || !isValidResourceId(newLabel)) {
        return err('newLabel must be a valid resource id');
      }
      const b = island.spec.buildings.find((bb) => bb.id === buildingId);
      if (!b) return err('not-found');
      const def = BUILDING_DEFS[b.defId as BuildingDefId];
      if (!def) return err('unknown def');
      if (!def.storage || def.storage.category !== 'generic') {
        return err('building is not generic storage');
      }
      applyRelabelStorageCap(island.state, b, def, b.cargoLabel, newLabel);
      b.cargoLabel = newLabel;
      return ok();
    },

    expandIsland(islandId, axis) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      const can = canExpandIsland(island.spec, island.state, axis);
      if (!can.ok) return err(can.reason ?? 'expand failed', can.reason);
      expandIsland(island.spec, island.state, axis);
      return ok();
    },

    renameIsland(islandId, name) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      const result = renameIsland(island.spec, name);
      if (!result.ok) return err(result.reason ?? 'rename failed', result.reason);
      return ok();
    },

    editBiome(islandId, biomeId) {
      const result = editIslandBiome(world, islandId, biomeId as Biome);
      if (!result.ok) return err(result.reason ?? 'edit biome failed', result.reason);
      return ok();
    },

    setLocation(lat, lon) {
      if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
        return err('lat must be a finite number in [-90,90]');
      }
      if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
        return err('lon must be a finite number in [-180,180]');
      }
      world.playerLat = lat;
      world.playerLon = lon;
      return ok();
    },

    constructIsland({ founderIslandId, biome, majorRadius, minorRadius, cx, cy, displayName, nowMs }) {
      const founder = resolveIsland(founderIslandId);
      if (!founder) return err('unknown founder island');
      const req = { biome, majorRadius, minorRadius };
      const can = validateConstruction(founder.state, founder.spec, req);
      if (!can.ok) return err(can.reason ?? 'construction invalid', can.reason);
      const idGenerator = makeArtificialIdGenerator(world);
      const now = nowMsOr(performance.now(), nowMs);
      try {
        const result = constructIsland(
          world.seed,
          founder.state,
          founder.spec,
          req,
          { cx, cy },
          idGenerator(),
          now,
          displayName,
        );
        return ok(result);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    dispatchDrone(islandId, originX, originY, dirX, dirY, fuelLoaded, nowMs, waypoints, selectedTier) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      if (selectedTier !== undefined) {
        if (typeof selectedTier !== 'number' || !Number.isInteger(selectedTier) || selectedTier < 1 || selectedTier > 6) {
          return err('selectedTier must be an integer 1..6');
        }
      }
      return fromOutcome(
        dispatchDrone(
          world,
          island.state,
          originX,
          originY,
          dirX,
          dirY,
          fuelLoaded,
          nowMs,
          waypoints as { x: number; y: number }[] | undefined,
          selectedTier as DroneTier | undefined,
        ),
      );
    },

    firePulse(islandId, nowMs) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      return fromOutcome(firePulse(world, island.state, nowMs));
    },

    dispatchSettler(originIslandId, targetIslandId, kind, tier, fuelLoaded, foundationKitCount, nowMs) {
      const origin = resolveIsland(originIslandId);
      if (!origin) return err('unknown origin island');
      const targetSpec = world.islands.find((s) => s.id === targetIslandId);
      if (!targetSpec) return err('unknown target island');
      if (originIslandId === targetIslandId) return err('origin and target must differ');
      if (!isValidVehicleKind(kind)) return err('kind must be ship or helicopter');
      if (!isValidVehicleTier(tier)) return err('tier must be 1..4');
      if (typeof fuelLoaded !== 'number' || !Number.isFinite(fuelLoaded) || fuelLoaded <= 0) {
        return err('fuelLoaded must be positive');
      }
      if (typeof foundationKitCount !== 'number' || !Number.isInteger(foundationKitCount) || foundationKitCount < 1) {
        return err('foundationKitCount must be a positive integer');
      }
      if (!targetSpec.discovered) return err('target not discovered');
      if (targetSpec.populated) return err('target already populated');
      try {
        return fromOutcome(
          dispatchVehicle(
            world,
            origin.spec,
            origin.state,
            targetSpec,
            kind,
            tier,
            fuelLoaded,
            foundationKitCount,
            nowMs,
          ),
        );
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    settleViaSpacetime(originIslandId, targetIslandId, nowMs) {
      const origin = resolveIsland(originIslandId);
      if (!origin) return err('unknown origin island');
      const targetSpec = world.islands.find((s) => s.id === targetIslandId);
      if (!targetSpec) return err('unknown target island');
      return fromOutcome(settleViaSpacetimeAnchor(world, islandStates, originIslandId, targetIslandId, nowMs));
    },

    launchSatellite(islandId, variant, targetX, targetY, nowMs) {
      return fromOutcome(launchSatellite(world, islandId, variant, targetX, targetY, nowMs));
    },

    upgradeSpaceport(islandId) {
      return fromOutcome(upgradeSpaceport(world, islandId));
    },

    moveSatellite(satId, targetX, targetY, nowMs) {
      return fromOutcome(requestSatMove(world, satId, targetX, targetY, nowMs));
    },

    dispatchRepairDrone(islandId, satId, nowMs) {
      return fromOutcome(dispatchRepairDrone(world, islandId, satId, nowMs));
    },

    unlockSkillNode(islandId, nodeId) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      const graph = effectiveGraph(island.state);
      try {
        buyNode(graph, island.state, nodeId);
        return ok();
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    buyKeystone(islandId, nodeId) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      const ks = keystonePrereqFor(nodeId);
      if (!ks) return err('not a keystone');
      if (!canBuyKeystone(ks, island.state)) return err('prereqs or sp not met');
      try {
        buyKeystone(ks, island.state);
        return ok();
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    bindCrystal(islandId, socketId, crystalId) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      try {
        bindCrystal(island.state, socketId, crystalId);
        return ok();
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    unbindCrystal(islandId, socketId) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      unbindCrystal(island.state, socketId);
      return ok();
    },

    tierReset(islandId, nowMs) {
      const island = resolveIsland(islandId);
      if (!island) return err('unknown island');
      const can = canTierReset(island.state, nowMs);
      if (!can.ok) return err(can.reason ?? 'tier reset failed', can.reason);
      executeTierReset(island.state, nowMs);
      return ok();
    },

    createRoute(fromIslandId, toIslandId, buildingId, filterResource) {
      const fromSpec = world.islands.find((s) => s.id === fromIslandId);
      const toSpec = world.islands.find((s) => s.id === toIslandId);
      if (!fromSpec) return err('unknown from island');
      if (!toSpec) return err('unknown to island');
      if (fromIslandId === toIslandId) return err('from and to must differ');
      if (typeof filterResource === 'string' && !isValidResourceId(filterResource)) {
        return err('unknown filterResource');
      }
      if (!fromSpec.populated) return err('island not populated');
      if (!toSpec.populated) return err('island not populated');
      const building = fromSpec.buildings.find((b) => b.id === buildingId);
      if (!building) return err('building not on from island');
      const profile = routeProfileForBuilding(building.defId);
      if (profile === null) return err('building is not a transport building');
      if (profile.type === 'teleporter' && !islandHasTeleporterPad(toSpec)) {
        return err('destination has no teleporter pad');
      }
      const dx = fromSpec.cx - toSpec.cx;
      const dy = fromSpec.cy - toSpec.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const route = createRouteFromBuilding(
        building,
        fromIslandId,
        toIslandId,
        filterResource ?? null,
        dist,
      );
      if (!route) return err('route could not be created');
      world.routes.push(route);
      return ok();
    },

    deleteRoute(routeId) {
      const route = findRoute(routeId);
      if (!route) return err('route not found');
      // Mirror the existing routes-UI behavior: immediately remove when nothing
      // is in flight, otherwise drain.
      if (route.inFlight.length === 0) {
        const idx = world.routes.indexOf(route);
        if (idx >= 0) world.routes.splice(idx, 1);
      } else {
        route.draining = true;
      }
      return ok();
    },

    setRouteMode(routeId, mode) {
      if (!isValidCargoMode(mode)) return err('invalid cargo mode');
      const route = findRoute(routeId);
      if (!route) return err('route not found');
      if (route.draining) return err('route is draining');
      route.mode = mode;
      return ok();
    },

    setCargoWeight(routeId, cargoIndex, weight) {
      if (typeof cargoIndex !== 'number' || !Number.isInteger(cargoIndex) || cargoIndex < 0) {
        return err('cargoIndex must be a non-negative integer');
      }
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        return err('weight must be positive');
      }
      const route = findRoute(routeId);
      if (!route) return err('route not found');
      if (route.draining) return err('route is draining');
      const entry = route.cargo[cargoIndex];
      if (!entry) return err('cargoIndex out of range');
      route.cargo[cargoIndex] = { ...entry, weight };
      return ok();
    },

    setCargoFloorPct(routeId, cargoIndex, sourceFloorPct) {
      if (typeof cargoIndex !== 'number' || !Number.isInteger(cargoIndex) || cargoIndex < 0) {
        return err('cargoIndex must be a non-negative integer');
      }
      const hasFloor = sourceFloorPct !== undefined;
      if (
        hasFloor &&
        (typeof sourceFloorPct !== 'number' || !Number.isFinite(sourceFloorPct) || sourceFloorPct < 0 || sourceFloorPct > 100)
      ) {
        return err('sourceFloorPct must be 0..100');
      }
      const route = findRoute(routeId);
      if (!route) return err('route not found');
      if (route.draining) return err('route is draining');
      const entry = route.cargo[cargoIndex];
      if (!entry) return err('cargoIndex out of range');
      route.cargo[cargoIndex] = hasFloor
        ? { resourceId: entry.resourceId, weight: entry.weight, sourceFloorPct }
        : { resourceId: entry.resourceId, weight: entry.weight };
      return ok();
    },

    reorderRouteCargo(routeId, srcIndex, dstIndex) {
      if (typeof srcIndex !== 'number' || !Number.isInteger(srcIndex) || srcIndex < 0) {
        return err('srcIndex must be a non-negative integer');
      }
      if (typeof dstIndex !== 'number' || !Number.isInteger(dstIndex) || dstIndex < 0) {
        return err('dstIndex must be a non-negative integer');
      }
      const route = findRoute(routeId);
      if (!route) return err('route not found');
      if (route.draining) return err('route is draining');
      if (srcIndex >= route.cargo.length || dstIndex >= route.cargo.length) {
        return err('index out of range');
      }
      route.cargo = reorderPriorityList(route.cargo, srcIndex, dstIndex) as CargoEntry[];
      return ok();
    },

    setRouteCargo(routeId, cargo) {
      const route = findRoute(routeId);
      if (!route) return err('route not found');
      if (route.draining) return err('route is draining');
      const v = validateCargoList(cargo);
      if (!v.ok) return err(v.error);
      route.cargo = v.list;
      return ok();
    },

    acceptTrade(offer) {
      const state = islandStates.get(offer.islandId);
      if (!state) return err('unknown island');
      const amounts = applyOffer(state, offer);
      return ok(amounts);
    },

    activeHeartbeat() {
      // LOCAL accrues/decays per-frame via tickActiveBonus in main.ts.
      return ok();
    },
  };
}

// ── REMOTE factory ───────────────────────────────────────────────────────────

export function makeRemoteGateway(client: GameServerClient): MutationGateway {
  async function send<T = void>(type: string, payload: unknown): Promise<GatewayResult<T>> {
    // sendIntent REJECTS (not resolves {ok:false}) on intent timeout, a
    // not-open socket, or a socket close before ack. Catch those here so the
    // gateway contract is ALWAYS a resolved GatewayResult — panel callsites'
    // `if (!result.ok) return` guards then cover transport failures uniformly
    // instead of throwing an unhandled rejection inside their void async IIFEs.
    let ack: Awaited<ReturnType<typeof client.sendIntent>>;
    try {
      ack = await client.sendIntent(type, payload);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (ack.ok) return { ok: true } as GatewayResult<T>;
    return { ok: false, error: ack.error };
  }

  return {
    placeBuilding(islandId, defId, x, y, rotation, options = {}) {
      return send('place-building', {
        islandId,
        defId,
        x,
        y,
        rotation,
        cargoLabel: options.cargoLabel,
        anchorIslandId: options.anchorIslandId,
        terrainTarget: options.terrainTarget,
        terrainShotMs: options.terrainShotMs,
      });
    },
    demolishBuilding(islandId, buildingId) {
      return send('demolish-building', { islandId, buildingId });
    },
    relocateBuilding(islandId, buildingId, x, y, rotation) {
      return send('relocate-building', { islandId, buildingId, x, y, rotation });
    },
    applyUpgrade(islandId, buildingId) {
      return send('upgrade-building', { islandId, buildingId });
    },
    cancelConstruction(islandId, buildingId) {
      return send('cancel-construction', { islandId, buildingId });
    },
    setBuildingActiveFloors(islandId, buildingId, disabledFloors) {
      return send('set-active-floors', { islandId, buildingId, disabledFloors });
    },
    setForceRun(islandId, buildingId, forceRun) {
      return send('set-force-run', { islandId, buildingId, forceRun });
    },
    refreshMaintenance(islandId, buildingId) {
      return send('refresh-maintenance', { islandId, buildingId });
    },
    convertToServitor(islandId, buildingId) {
      return send('convert-to-servitor', { islandId, buildingId });
    },
    relabelCargo(islandId, buildingId, newLabel) {
      return send('relabel-cargo', { islandId, buildingId, newLabel });
    },
    expandIsland(islandId, axis) {
      return send('expand-island', { islandId, axis });
    },
    renameIsland(islandId, name) {
      return send('rename-island', { islandId, name });
    },
    editBiome(islandId, biomeId) {
      return send('edit-biome', { islandId, biomeId });
    },
    setLocation(lat, lon) {
      return send('set-location', { lat, lon });
    },
    constructIsland({ founderIslandId, biome, majorRadius, minorRadius, cx, cy, displayName, nowMs }) {
      return send('construct-island', {
        founderIslandId,
        biome,
        majorRadius,
        minorRadius,
        cx,
        cy,
        displayName,
        nowMs,
      });
    },

    dispatchDrone(islandId, originX, originY, dirX, dirY, fuelLoaded, nowMs, waypoints, selectedTier) {
      return send('dispatch-drone', {
        islandId,
        originX,
        originY,
        dirX,
        dirY,
        fuelLoaded,
        nowMs,
        waypoints,
        selectedTier,
      });
    },
    firePulse(islandId, nowMs) {
      return send('fire-t4-pulse', { islandId, nowMs });
    },

    dispatchSettler(originIslandId, targetIslandId, kind, tier, fuelLoaded, foundationKitCount, nowMs) {
      return send('dispatch-settler', {
        originIslandId,
        targetIslandId,
        kind,
        tier,
        fuelLoaded,
        foundationKitCount,
        nowMs,
      });
    },
    settleViaSpacetime(originIslandId, targetIslandId, nowMs) {
      return send('settle-via-spacetime', { originIslandId, targetIslandId, nowMs });
    },

    launchSatellite(islandId, variant, targetX, targetY, nowMs) {
      return send('launch-satellite', { islandId, variant, targetX, targetY, nowMs });
    },
    upgradeSpaceport(islandId) {
      return send('upgrade-spaceport', { islandId });
    },
    moveSatellite(satId, targetX, targetY, nowMs) {
      return send('move-satellite', { satId, targetX, targetY, nowMs });
    },
    dispatchRepairDrone(islandId, satId, nowMs) {
      return send('dispatch-repair-drone', { islandId, satId, nowMs });
    },

    unlockSkillNode(islandId, nodeId) {
      return send('unlock-skill-node', { islandId, nodeId });
    },
    buyKeystone(islandId, nodeId) {
      return send('buy-keystone', { islandId, nodeId });
    },
    bindCrystal(islandId, socketId, crystalId) {
      return send('bind-crystal', { islandId, socketId, crystalId });
    },
    unbindCrystal(islandId, socketId) {
      return send('unbind-crystal', { islandId, socketId });
    },
    tierReset(islandId, nowMs) {
      return send('tier-reset', { islandId, nowMs });
    },

    createRoute(fromIslandId, toIslandId, buildingId, filterResource) {
      return send('create-route', { fromIslandId, toIslandId, buildingId, filterResource });
    },
    deleteRoute(routeId) {
      return send('delete-route', { routeId });
    },
    setRouteMode(routeId, mode) {
      return send('set-route-mode', { routeId, mode });
    },
    setCargoWeight(routeId, cargoIndex, weight) {
      return send('set-cargo-weight', { routeId, cargoIndex, weight });
    },
    setCargoFloorPct(routeId, cargoIndex, sourceFloorPct) {
      return send('set-cargo-floor-pct', { routeId, cargoIndex, sourceFloorPct });
    },
    reorderRouteCargo(routeId, srcIndex, dstIndex) {
      return send('reorder-route-cargo', { routeId, srcIndex, dstIndex });
    },
    setRouteCargo(routeId, cargo) {
      return send('set-route-cargo', { routeId, cargo });
    },

    acceptTrade() {
      return Promise.resolve({ ok: false, error: 'not supported yet' } as GatewayResult<{ give: number; get: number }>);
    },

    activeHeartbeat(focusedMs, unfocusedMs) {
      return send('active-heartbeat', { focusedMs, unfocusedMs });
    },
  };
}
