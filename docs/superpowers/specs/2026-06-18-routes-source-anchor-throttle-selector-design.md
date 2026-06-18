# Routes: source-anchored rendering, live speed/throttle readout, floor-scaled selector

Date: 2026-06-18
Status: design (approved to proceed to plan → implement)

## Goals

Three independent route-system improvements:

1. **Routes start at their source building** — the drawn route line begins at the
   route's owning transport building, not the island centre.
2. **Ledger shows the actual route speed AND what is throttling an active route** —
   the floor-scaled effective speed plus a badge naming the live bottleneck.
3. **Building selector shows each candidate's max throughput including floor scaling**
   when creating a route.

All three are additive; none change persisted save shape.

## 1. Source-anchored route path (weather + rendering)

**Scope decision (revised per user):** the source anchor is NOT cosmetic. The reason
to start a route at its building is **weather**: a different start point crosses
different §2.6 stratification cells, so the building a route launches from changes the
storms it flies through. Therefore the route's PATH geometry — `routePolylinePoints`,
which feeds `routeCrossedCells` (the §2.6 dispatch capacity throttle + in-flight loss),
`routeBentLengthTiles`, the bend overlay/hit-testing, and the renderer — anchors its
START at the source-building tile (`routeSourceTile`), falling back to the island
centre for legacy routes. The destination stays the island centre. The stored
`capacityPerSec`/`transitTimeSec` base values are unchanged; `effectiveTransitTimeSec`'s
straight baseline anchors at the same building start so an UNBENT route keeps its stored
transit (no drift) and only bends add time.

- New pure resolver in `routes.ts`:
  `routeSourceTile(route, islandIndex): { x, y } | null` — returns the tile coords of
  the route's `sourceBuildingId` building on its `from` island, or `null` when the
  route has no `sourceBuildingId` (legacy), the island/building can't be resolved
  (demolished/merged). Caller falls back to the island centre on `null`.
- `routes-renderer.ts`: the `from` endpoint resolves to the source-building world
  position (via the resolver → `tileToWorldPx`), falling back to island centre. The
  `to` endpoint stays the destination island centre (routes target an island, not a
  building there). The per-route cache key already includes `from.x/from.y`, so it
  rebuilds when the source position changes; no key change needed beyond feeding it
  the building position.
- The renderer is constructed with an `IslandPosResolver`; we extend the wiring so
  the `from`-side resolution can consult the source building. Cleanest seam: a small
  `routeEndpointsWorldPx(route, …)` helper the renderer calls, keeping the pure tile
  math testable and the renderer a thin consumer.
- **Draft preview** (creating a route, before it exists): anchor the preview's start
  at the currently selected via-building's tile instead of the from-island centre, so
  the preview matches where the real route will be drawn.

## 2. Live speed + throttle readout

### Pure diagnosis — new module `route-throttle.ts`

`routeThrottleReason(world, states, route): ThrottleReason` returns a discriminated
reason, computed by reusing the **same gates** `planRouteCargo` uses so the badge can
never disagree with the engine:

- `'draining'` — `route.draining === true`.
- `'floors-disabled'` — `routeFloorMultiplier(route, world) === 0` (source at 0 active
  floors; its routes are drained).
- `'idle'` — no cargo configured (empty `route.cargo`, no wildcard).
- `'source-empty'` — every targeted resource has source stock `inv === 0`.
- `'dest-full'` — every targeted resource has `destinationHeadroom <= 0`.
- `'low-fuel'` — mass_driver (Diesel) / teleporter (biofuel) route whose source can't
  afford the per-dispatch fuel bill. Only evaluated for those types; reuses the
  existing fuel-cost helpers. If the fuel check is not cheaply reusable as a pure
  call, this reason is deferred (documented) rather than approximated.
- `'flowing'` — at least one targeted resource is viable (source stock > 0 AND dest
  headroom > 0 AND source-floor gate passes) → the route is actually moving cargo.

Precedence (first match wins): draining → floors-disabled → idle → low-fuel →
flowing → source-empty → dest-full. (`flowing` outranks the empty/full reasons: if
*anything* is moving, the route is not blocked.)

Pure, reads world/states, mutates nothing. Power-link routes (cable/spacetime/
submarine_cable) are not cargo routes → report `'idle'` / skipped (they have no cargo
ledger row).

### Ledger rendering (`routes-ui.ts`)

- Keep the existing per-row effective line `capacity×floorMul u/s · transit` (the
  *actual* floor-scaled speed — already correct post-#136).
- Add a compact throttle badge to the active-route row driven by
  `routeThrottleReason`, e.g. `▶ flowing`, `⏸ source empty`, `⛔ dest full`,
  `floors off`, `low fuel`, `draining`, `idle`. The badge text/colour comes from a
  pure `throttleBadge(reason): { text, tone }` map so it is unit-testable and the
  render stays a thin consumer.
- The row's DOM-rebuild key (`routeStructKey`) gains the reason so the badge refreshes
  when the throttle state changes (it is a per-frame-cheap string already).

## 3. Floor-scaled max in the building selector

- `buildBuildingOptions()` in `routes-ui.ts`: each candidate source-building option
  label shows the **max throughput including floor scaling** using the existing
  `floorScaledCapacity(b, profile.capacityPerSec)` helper (= `capacity × (1 +
  activeFloorLevel)`), instead of the tier-base `profile.capacityPerSec`. Format with
  the shared `fmtUPerSec` (#136) for unit consistency. This matches SPEC §2.4's
  existing statement that "the route ledger / new-route preview show the effective
  (floor-scaled) values."

## Testing

- `routeThrottleReason` — TDD, one test per reason + precedence (source-empty vs
  dest-full vs flowing when cargo mixes), via small fixtures (reuse drones/economy
  test-state helpers).
- `routeSourceTile` / `routeEndpointsWorldPx` — building-tile vs centre-fallback
  (legacy route, demolished building).
- `throttleBadge` — reason → text/tone map.
- Building selector — assert the option label shows the floor-scaled value (extend
  `routes-ui.test.ts`).
- Renderer — cache-key rebuild on source move; visual screenshot smoke (Daedalus).

## SPEC

- §2.4 / §2.6 ledger text: add the source-anchored rendering note and the active-route
  throttle readout. The floor-scaled-selector behaviour is already covered by the §2.4
  floor-scaling paragraph (line ~200). Update in the same change.

## Out of scope (YAGNI)

- Recomputing route distance/transit/capacity from the building position.
- Per-resource throttle breakdown (one dominant reason per route is enough).
- Destination-building anchoring (routes target islands).
