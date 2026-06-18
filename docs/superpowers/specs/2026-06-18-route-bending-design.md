# Route bending — design (GH #118)

## Goal

Let an **already-placed** route carry up to **4 bend points** (a polyline of up
to 5 segments) so players can steer cargo **around bad weather** instead of
eating the §2.6 straight-line capacity throttle + in-flight losses. Weather and
transit time are computed along the bent polyline. Includes an **unbend**
operation. Bending is **not** available while placing a route — only after it
exists.

## Interaction (user-specified)

Direct on the map:

- **Click a route** on the map → selects it for bending (highlight + handles).
- **Drag the route line** (on a segment, not a handle) → inserts a new bend at
  that point and drags it into position. No-op if already at 4 bends.
- **Drag an existing handle** → moves that bend.
- **Click a handle** (no drag) → removes that bend (per-point unbend).
- **Click empty ocean** → deselect.
- A selected route's panel row also gets an **"Unbend all"** button (clears all
  waypoints in one action) for convenience.
- While a route is selected for bending, the **weather overlay auto-shows** so
  the player can see which cells to avoid.
- All commits flow through the mutation gateway on mouseup; the ≤4 cap and the
  T5/type gate are enforced server-side, not just in the UI.

## Gating (defaults)

- **Bendable types:** non-instant cargo — `cargo`, `drone`, `airship`,
  `mass_driver`. Excludes `teleporter` (instant, no transit) and power links
  (`cable`/`spacetime`/`submarine_cable` — transmit power, skip weather).
- **Tier gate:** the route's **source** island at T5
  (`tierForLevel(sourceState.level) >= 5`). Matches the issue's "likely source"
  and how route skill bonuses already read the source island.

## Data model (`src/routes.ts`)

- Add `waypoints?: ReadonlyArray<{ x: number; y: number }>` to `Route` —
  intermediate points in **tile** coords (same convention as island `cx/cy` and
  drone `waypoints`). Absent/empty = straight route (back-compat). Cap 4.
- Relax `transitTimeSec` from `readonly` to mutable. When waypoints change,
  recompute `transitTimeSec` from the **total bent length** × the source
  building's speed profile. This keeps every downstream reader (dispatch
  `arrivalTime`, the `transitTimeSec <= 0` instant check, the UI ETA) correct
  with no other edits.
- `retargetRoute` drops `waypoints` (the last segment's endpoint moves, so old
  bends are geometrically stale).

## Geometry + weather (`src/weather.ts`, `src/routes.ts`)

- New pure `rasterizePolylineCells(points, cellSizeTiles)`: rasterize
  `[from, ...waypoints, to]` segment-by-segment (reusing `lineSegmentCells`),
  remapping each segment's local `transitFraction ∈ [0,1]` into a **monotonic
  global** fraction `(cumLenBefore + localFrac*segLen) / totalLen`, deduping the
  shared vertex cell between consecutive segments.
- `routeCrossedCells` builds the polyline point list from `from`/`waypoints`/`to`
  and delegates to `rasterizePolylineCells`. A straight route (no waypoints)
  produces the identical cell list it does today.
- §2.6 capacity throttle: factor the min-over-cells loop out of
  `routeCapacityMultiplierForWeather` into a helper that takes pre-rasterized
  cells, so dispatch and delivery share one rasterization of the (possibly bent)
  path. Both the capacity throttle and the in-flight loss then sample along the
  bend, so storms can be routed around.
- Transit time scales with bent length (the intended cost of detouring).

## Mutation gateway + server (`src/mutation-gateway.ts`, `server/src/game/intents.ts`)

- New shared pure `setRouteWaypoints(world, states, routeId, waypoints)`:
  validates route exists, not draining, bend-eligible type, source at T5, ≤4
  finite points; sets `route.waypoints` and recomputes `transitTimeSec`. Empty
  array = unbend. Returns ok/error like `retargetRoute`.
- Gateway method `setRouteWaypoints(routeId, waypoints)`: REMOTE → emit
  `set-route-waypoints` intent; LOCAL → call the pure fn directly.
- Server intent `set-route-waypoints` mirrors exactly via the same pure fn
  (validate point shapes + count server-side).

## Persistence (`src/persistence.ts`)

- Bump `SCHEMA_VERSION` 25 → 26; add `26` to `SUPPORTED_LOAD_VERSIONS`.
- Serialize `waypoints` on routes (omit when empty to keep saves small).
- `SerializedSnapshotV25` alias + `migrateV25toV26` (routes default to no
  waypoints = straight). Tests: v25 fixture → v26 clean; v26 round-trips
  identity; waypoint default exercised.

## Renderer (`src/routes-renderer.ts`, new `src/route-bend-overlay.ts`)

- Draw routes as **polylines** through `waypoints`: animated texture stroke per
  segment; chevrons interpolate along cumulative polyline length.
- Add `waypoints` to `perRouteKey` (VISUAL-FIELD-MARKER compliance) and classify
  it in `routes-renderer.test.ts`.
- New `route-bend-overlay` (Pixi, render-layer): for the selected route, draw
  bend handles (circles at each waypoint) + a faint full-polyline highlight so
  the player sees what they're editing.

## Map interaction (`src/main.ts`, new pure `src/route-bend.ts`)

- Pure hit-testing module `route-bend.ts`:
  - `pickRouteAt(world, islandIndex, worldTile, tolTiles)` → nearest bendable
    route whose polyline passes within `tol` of the point (point-to-segment
    distance over all segments), or null.
  - `pickWaypointAt(route, worldTile, tolTiles)` → waypoint index under the
    point, or null.
  - `insertBendOnSegment(route, worldTile)` → new waypoints array with a bend
    inserted at the correct segment index (clamped to ≤4).
- `main.ts` wires a bend-edit gesture on the canvas:
  - click route → set `selectedBendRouteId`, show weather overlay;
  - mousedown on a handle → drag it (live local preview); mouseup commits
    `setRouteWaypoints`;
  - mousedown on a segment + drag → insert bend then drag; mouseup commits;
  - click (no drag) on a handle → remove it, commit;
  - click empty ocean → deselect, hide overlay.
  - Mutual-exclusion with placement / drone-launch / settlement / orbital modes
    (those disarm bend selection and vice-versa), matching the existing
    mode-exclusion pattern.

## Integration

- Full feature → feature branch `feat/route-bending` off `master`, TDD on the
  pure layer, PR, rebase + fast-forward (linear history per `CONTRIBUTING.md`).
- `SPEC.md` §2.4 (route tiers) and §2.6 (weather modulation) updated in the same
  change — code and spec move together.

## Out of scope

- Bends during route creation (explicitly excluded by the request).
- Bending power links / teleporters.
- Auto-routing around weather (player draws bends manually).
