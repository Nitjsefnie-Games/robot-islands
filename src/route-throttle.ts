// Pure route-throttle diagnosis (NO pixi). Names the dominant reason an active
// route is or isn't moving cargo, reusing the SAME viability gates as
// `planRouteCargo` so the ledger badge can never disagree with the engine.
//
// Note on a deliberately-absent reason: a source building at 0 active floors
// has its routes DRAINED (§4.9 / drainRoutesForBuilding), so that state always
// surfaces as `draining`; `routeFloorMultiplier` clamps L ≥ 0 and never returns
// 0, so there is no separate "floors-disabled" reason to report.
import { cap, inv, type IslandState } from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { effectiveSkillMultipliers } from './skilltree.js';
import { destinationHeadroom, routeFloorMultiplier, type Route } from './routes.js';
import type { WorldState } from './world.js';

export type ThrottleReason =
  | 'draining' | 'idle' | 'flowing' | 'dest-full' | 'source-empty';

/** Resources this route actually tries to carry: explicit cargo entries, plus
 *  every other resource when a wildcard ('all') entry is present. */
function targetedResources(route: Route): ResourceId[] {
  const explicit = new Set<ResourceId>();
  let wildcard = false;
  for (const e of route.cargo) {
    if (e.resourceId === 'all') wildcard = true;
    else explicit.add(e.resourceId);
  }
  if (!wildcard) return [...explicit];
  return ALL_RESOURCES.filter((r) => !explicit.has(r)).concat([...explicit]);
}

/** Diagnose why a route is or isn't moving cargo right now. Precedence:
 *  draining → idle (no cargo) → flowing (something viable) → dest-full (stock
 *  exists but nowhere to put it) → source-empty (nothing to send). */
export function routeThrottleReason(
  world: WorldState,
  states: Map<string, IslandState>,
  route: Route,
): ThrottleReason {
  if (route.draining === true) return 'draining';
  const src = states.get(route.from);
  const dest = states.get(route.to);
  if (!src || !dest) return 'idle';
  // A fully floor-disabled source would already be draining; this is a defensive
  // guard for any future 0-multiplier path.
  if (routeFloorMultiplier(route, world) === 0) return 'draining';
  const targets = targetedResources(route);
  if (targets.length === 0) return 'idle';
  const srcMul = effectiveSkillMultipliers(src);
  const destMul = effectiveSkillMultipliers(dest);
  let anyStockNoRoom = false;
  for (const r of targets) {
    const stock = inv(src, r);
    if (stock <= 0) continue;
    // Source-floor gate (only blocks; absence of an entry = no floor gate).
    const entry = route.cargo.find((e) => e.resourceId === r);
    if (entry?.sourceFloorPct !== undefined) {
      const srcCap = cap(src, r, undefined, undefined, srcMul);
      if (srcCap <= 0 || stock / srcCap < entry.sourceFloorPct / 100) continue;
    }
    const headroom = destinationHeadroom(world, states, route.to, r, destMul);
    if (headroom > 0) return 'flowing';
    anyStockNoRoom = true;
  }
  return anyStockNoRoom ? 'dest-full' : 'source-empty';
}
