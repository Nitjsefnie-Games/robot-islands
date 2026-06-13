# Building refactor — stacked upgrade queue (#31) + temporary floor disabling

This branch bundles two building mechanics that share the same touchpoints
(building fields, the §4.5/#35 cluster capacity, the floor-effect multipliers,
and the persistence schema, so they migrate together):

- **Part 1 — Stacked upgrade queue (#31)** — queue multiple upgrades on one
  building.
- **Part 2 — Temporary floor disabling** — a free, reversible per-building
  active-floor count that scales throughput / power / capacity and replaces the
  binary Disable button.

---

# Part 1 — Stacked upgrade queue (#31)

**Issue:** [#31](https://github.com/Nitjsefnie-Games/robot-islands/issues/31) —
*Cannot queue more than 1 upgrade of the same building.* Pressing **Upgrade**
on a building that is already upgrading does nothing; the expected behaviour is
to **queue another upgrade into the build queue** (but not into a parallel
build slot).

**Decision (approved):** central per-island job queue for **queued upgrades**;
running/in-flight builds keep today's behaviour; **queued** upgrades keep the
building producing until they start.

---

## 1. Root cause

The build queue is modelled as **flags on the building object**, so one
`PlacedBuilding` can represent at most one construction job:

- `constructionRemainingMs` / `constructionTotalMs` — the building's single
  in-progress job timer.
- `floorLevel` — **pre-bumped** to the upgrade target the instant
  `applyUpgrade` runs (a building "upgrading to floor 2" already has
  `floorLevel = 1`).
- `queued` / `queueSeq` — at most one "waiting for a slot" flag.

`applyUpgrade` therefore hard-rejects a second upgrade:

```ts
// placement.ts:931
if ((b.constructionRemainingMs ?? 0) > 0) return { ok: false, reason: 'already-building' };
```

There is nowhere to store a *second* pending upgrade for the same building.

## 2. Approach — central queued-upgrade job list (scoped)

Add **one** new piece of state: a per-island list of **queued upgrade jobs**.
Everything that already works stays put:

- **Running job state stays on the building** (`constructionRemainingMs`,
  `constructionTotalMs`, and `floorLevel` pre-bumped for the *active* upgrade) —
  exactly as today. This is load-bearing: it keeps all **27**
  `isOperationalBuilding` call-sites, the §4.5/#35 cluster-capacity logic
  (`adjacency.ts` reads `constructionRemainingMs` + `floorLevel`), the
  construction alert overlay, the inspector, and the `main.ts` guard **unchanged**.
- **Queued placements stay on the building** (`queued` / `queueSeq` +
  `constructionRemainingMs`) — placements never stack (you place a building
  once), so they need no new representation. Their **slot accounting** is
  unified with queued upgrades (below).
- **Queued upgrades** — the genuinely new, stackable thing — live in the
  central list.

### 2.1 Data model

`IslandState` (in `economy.ts`) gains:

```ts
/** §4.8 queued upgrade jobs that haven't started running yet. Each entry is
 *  ONE pending floor-upgrade for `buildingId`, beyond whatever upgrade (if
 *  any) is currently running on that building. Ordered globally by `seq`
 *  (from nextQueueSeq) for FIFO promotion. A queued upgrade does NOT take the
 *  building offline — the building keeps producing at its completed floor
 *  until the job promotes to running. Cost is paid at enqueue. Optional;
 *  absent ≡ [] (forward-compat with pre-v24 saves). */
buildJobs?: BuildJob[];
```

```ts
export interface BuildJob {
  readonly seq: number;       // global FIFO order, from state.nextQueueSeq
  readonly buildingId: string;
  readonly kind: 'upgrade';   // only upgrades stack today; future-proofed as a union
}
```

`PlacedBuilding`: **no field added or removed.** `floorLevel` keeps its current
"pre-bumped to the running upgrade's target" meaning. The queued jobs do **not**
touch `floorLevel` — it only advances when a job promotes to running.

### 2.2 The "effective top floor" of a building

For cost and display we need the highest floor a building is heading toward,
counting the running upgrade (if any) and all queued upgrades:

```
topLevel(b, state) = rawFloorLevel(b) + countQueuedUpgrades(state, b.id)
```

- `rawFloorLevel(b)` already includes the running upgrade's target (pre-bump).
- `countQueuedUpgrades` = number of `buildJobs` entries with `buildingId === b.id`.

The next upgrade's **target displayed floor** = `topLevel + 2`
(`+1` for the new raw level, `+1` for displayed = raw+1).

## 3. Behaviour

### 3.1 `applyUpgrade` (placement.ts)

Replace the hard reject with a branch:

1. Resolve `def`, compute `targetDisplayed = topLevel(b, state) + 2` and
   `cost = upgradeCost(def, targetDisplayed)`.
2. Affordability check (as today).
3. **Slot decision.** If the building has **no running construction** AND a
   parallel slot is free → start it **running now** (today's path: bump
   `floorLevel`, set `constructionRemainingMs`/`constructionTotalMs`). Otherwise
   it must **queue**: check `queuedBuildCount(state) < queuedBuildSlots(state)`;
   if full, return `'queue-full'`. Append a `BuildJob {seq, buildingId, kind}`,
   `state.nextQueueSeq++`.
4. Deduct cost, return `{ ok: true }`.

The `'already-building'` reason is **removed** (no longer reachable).

### 3.2 Slot / queue accounting (placement.ts)

- `inProgressBuildCount` — **unchanged** (buildings with a running timer).
- `queuedBuildCount` = (buildings with `queued === true`) **+ `buildJobs.length`**.
- `queuedBuildSlots` — unchanged cap; now bounds the combined total.
- `parallelBuildSlots` / `queuedBuildSlots` formulas unchanged.

### 3.3 Promotion (`promoteQueuedBuilds`, placement.ts)

Promotion fills free running slots from the merged FIFO of **queued placements**
(building flags) and **queued upgrade jobs** (`buildJobs`), ordered by `seq`,
with one rule: **never start an upgrade on a building that already has a running
construction** (serialise per building).

For each free slot, take the lowest-`seq` eligible item:
- **queued placement** → clear `queued` (today's behaviour; its
  `constructionRemainingMs` was already set at enqueue).
- **queued upgrade job** → "start" it: bump the building's `floorLevel` by 1,
  set `constructionRemainingMs`/`constructionTotalMs =
  upgradeConstructionMs(def, newFloorLevel)`, and **remove the job** from
  `buildJobs`. (The building now carries the running upgrade exactly as a
  fresh `applyUpgrade` start would.)

A building with N queued upgrades thus processes them one at a time, each taking
a slot when it reaches the FIFO head and the building is free — they compete
fairly with other islands' queued work, and never run two-at-once on the same
building.

### 3.4 Construction completion (economy.ts `advanceIsland`)

Unchanged tick/complete logic. After the existing `tickConstruction` +
storage-cap credit, `promoteQueuedBuilds(state)` already runs each segment — it
now also promotes queued upgrade jobs, so a building's next stacked upgrade
starts within the same advance/offline-catchup call. The storage-cap completion
branch still keys on `floorLevel === 0 ? base : delta`, which remains correct
(a completing upgrade has `floorLevel ≥ 1`).

### 3.5 Producing-while-queued

A queued upgrade does **not** set `constructionRemainingMs`, so
`isOperationalBuilding` returns `true` and the building keeps producing at its
completed floor until the job promotes to running — matching the approved
"keep queued ones working" decision. (Today's behaviour froze even a *queued*
upgrade; this is the deliberate improvement.) A **running** upgrade still takes
the building offline, unchanged.

> Note: this only changes upgrades. Queued **placements** stay non-operational
> (`constructionRemainingMs > 0`) — an unbuilt shell has nothing to produce.

### 3.6 Cancel (`cancelConstruction`, build-queue-ui.ts)

Floors must stay contiguous — you cannot cancel the floor-2 upgrade while a
floor-3 upgrade is queued behind it. So cancel is **LIFO per building**:

- **Cancel a queued upgrade:** remove the **highest-`seq`** `buildJob` for that
  building, refund its `upgradeCost` (clamped to caps, as today). The build-queue
  panel's per-row ✕ targets a specific queued job (row keyed by `seq`); cancelling
  any row for a building removes its newest queued upgrade first.
- **Cancel the running job:** allowed only when the building has **no queued
  upgrade jobs** remaining (otherwise the ✕ on the running row is disabled / a
  no-op while queued upgrades exist). Running-cancel behaviour itself is
  unchanged (revert `floorLevel-1` for an upgrade, or splice for a placement).

`cancelConstruction` gains a path: if `buildingId` has queued upgrade jobs,
cancel the newest job (refund) instead of touching the running timer.

### 3.7 UI

- **Build-queue panel** (`build-queue-ui.ts`): the queued section renders **one
  row per queued upgrade job** (keyed by `seq`), labelled e.g.
  `Mine → floor N`, each with its own ✕. Running section unchanged. Row cache
  re-keys on `seq` rather than building id.
- **Inspector upgrade button** (`inspector-ui.ts`): no longer disabled while the
  building is constructing; enabled whenever another upgrade can be queued
  (queue has room and affordable). Label/subtext shows queued count
  (e.g. `Upgrade (2 queued)`). Cost shown is for the next target floor
  (`topLevel + 2`).

## 4. SPEC.md changes

- **§4.8** (build queue / cancel) — describe stacked upgrades: queued upgrades
  live in `state.buildJobs`, occupy queue slots, keep the building operational
  until promoted, promote by global FIFO with per-building serialisation, and
  cancel LIFO per building.
- **§9.3** (construction) — note `floorLevel` advances only when an upgrade
  *starts running*; queued upgrades are pending jobs that have paid their cost.

## 5. Persistence

Schema bump **v23 → v24**:

- Add `SerializedSnapshotV23` alias capturing the pre-`buildJobs` per-island
  state shape.
- `migrateV23toV24`: per island state, default `buildJobs: []` (no existing save
  has stacked upgrades; running/queued state is already represented on
  buildings, so nothing else moves).
- Wire into `loadWorld`; add `24` to `SUPPORTED_LOAD_VERSIONS`; serialise
  `buildJobs` in `toSnapshot`.
- Tests: v23 fixture loads into v24 with `buildJobs: []`; v24 round-trips
  identity; a v24 snapshot with non-empty `buildJobs` round-trips.

## 6. Test plan (TDD)

Pure-layer first (no DOM):

1. **placement.test.ts** — `applyUpgrade` while running queues a job (was
   `'already-building'`); a second/third stack; cost charged per ascending
   target floor; `queue-full` when the combined queue is full; affordability
   gating.
2. **placement.test.ts** — `promoteQueuedBuilds` starts a building's queued
   upgrade only after its running job frees, never two-at-once on one building;
   merged FIFO with a queued placement orders by `seq`.
3. **economy.test.ts** — `advanceIsland` runs a 3-deep upgrade stack to
   completion sequentially; `floorLevel` lands at the final level; building keeps
   **producing while upgrades are merely queued** and goes offline only while one
   is running; storage caps credited once per completed floor.
4. **placement.test.ts** — cancel LIFO: cancelling removes the newest queued
   upgrade and refunds its cost; running-cancel blocked while queued upgrades
   remain.
5. **persistence.test.ts** — v23→v24 migration + round-trips (above).
6. **circular-deps / full suite** — stay green.

## 7. Out of scope

- Unifying *placements* into `buildJobs` (they don't stack; left on building
  flags to minimise regression risk on a green master).
- Producing at the *completed* level during a **running** upgrade (the approved
  decision keeps running-upgrade downtime as-is).
- Parallel upgrades of the *same* building (inherently sequential by floor).

## 8. Risk / staging

Master stays green and linear (CONTRIBUTING). Stage on a feature branch:
(a) data model + persistence migration; (b) `applyUpgrade` + accounting +
promotion + TDD; (c) cancel LIFO; (d) UI; (e) SPEC. Each stage compiles and
tests green before the next.

## 9. Folded-in fix — upgrades honor construction speed (Swarm Assembly)

Today `upgradeConstructionMs(def, level)` is raw `base × (level+1)` and
**ignores** `skillMul.constructionTime` (the Robotics **Swarm Assembly**
`constructionTimeMul`), while fresh placements honor it via
`constructionTimeFor(def, skillMul.constructionTime)`. Approved: make upgrades
honor it too — `upgradeConstructionMs(def, level, constructionTimeMul=1)`
divides the raw duration by the multiplier exactly like a placement. Threaded at
the two upgrade-start sites (`applyUpgrade`, `promoteQueuedBuilds`), both of
which have `state` → `effectiveSkillMultipliers(state).constructionTime`. SPEC
§9.3 updated.

---

# Part 2 — Temporary floor disabling

**Goal:** replace the binary per-building **Disable** with a free, instantly
reversible **active-floor count** in `[0, built]`. Lowering it reduces the
building's throughput, power (draw and output), storage capacity, and §4.5/#35
cluster contribution proportionally; `0` active floors is the full "disabled"
state (the building drops out of production / power / gates / wear / cluster /
routes, exactly like today's disable).

## 10. Data model

`PlacedBuilding`: **remove** `disabled?: boolean`; **add**

```ts
/** §NEW temporary floor-disable: how many of the building's BUILT floors are
 *  currently switched off, counted from the top. 0 (or absent) = all built
 *  floors active (full effect). Equal to the built floor count
 *  (displayedFloorLevel) = fully disabled (the old `disabled === true`).
 *  Free + instantly reversible; no cost. Scales throughput / power / storage
 *  capacity / cluster contribution by the ACTIVE floor count. */
disabledFloors?: number;
```

Helpers in `buildings.ts`:

```ts
/** Displayed count of ACTIVE floors ∈ [0, displayedFloorLevel]. */
export function activeFloors(b: { floorLevel?: number; disabledFloors?: number }): number {
  return Math.max(0, displayedFloorLevel(b) - (b.disabledFloors ?? 0));
}
/** 0-based effective floor level for the floor-effect multipliers, i.e.
 *  activeFloors − 1. For an operational building (activeFloors ≥ 1) this is in
 *  [0, floorLevel]; for a fully-disabled building it is −1 (never read — the
 *  building is non-operational). */
export function activeFloorLevel(b: { floorLevel?: number; disabledFloors?: number }): number {
  return activeFloors(b) - 1;
}
```

## 11. Operational / cluster gating

`activeFloors === 0` **is** the disabled state — so the two existing predicates
absorb it and every downstream system (power, production, gates, wear, drones,
routes, cluster) follows automatically:

- `isOperationalBuilding(b)` — replace `b.disabled === true` →off with
  `activeFloors(b) <= 0`.
- `participatesInCluster(b)` — replace `b.disabled !== true` with
  `activeFloors(b) > 0`.

(Both predicate param types gain `floorLevel?` + `disabledFloors?`.)

## 12. Effect scaling

Everywhere throughput / power scales by `floorLevel(b)`, use `activeFloorLevel(b)`
instead — these are only reached for operational buildings (active ≥ 1), so the
0-based level is ≥ 0:

- throughput rates: `economy.ts` ~1306, ~1425, ~1459 (`floorEffectMul(floorLevel(b))` → `floorEffectMul(activeFloorLevel(b))`).
- power output: `economy.ts` ~1719.
- power draw: `economy.ts` ~1723, ~1736 (`floorPowerDrawMul`).
- `floorScaledCapacity(b, cap)` (`buildings.ts`) → use `activeFloorLevel(b)`.
  At construction completion a building is full-active, so the completion credit
  is unchanged; demolish/relocate/cap-adjust all read the building's *current*
  contribution.

**§4.5/#35 cluster (approved: active floors).** `clusterFloorCapacity` already
returns `0` for a non-participant. For a participant, change the operational
capacity from `1 + floorLevel` to `1 + activeFloorLevel` = `activeFloors` (the
under-construction discount still applies on top: a running upgrade contributes
its completed-active level). So a half-disabled building contributes its active
floor count to the cluster.

## 13. Toggling — `setBuildingActiveFloors` (placement.ts, pure)

```ts
setBuildingActiveFloors(spec, state, buildingId, newDisabledFloors): { ok, clampedInventory? } 
```

1. Resolve building + def; clamp `newDisabledFloors` to `[0, displayedFloorLevel(b)]`.
2. **Storage cap adjust** (storage defs only): `deltaMult = storage.capacity ×
   (floorEffectMul(newActiveLevel) − floorEffectMul(oldActiveLevel))`;
   `creditStorageCaps(state, b, def, deltaMult)` (negative shrinks).
3. **Clamp overflow** (approved): for each affected resource, if
   `inventory[r] > storageCaps[r]`, set `inventory[r] = storageCaps[r]`
   (discard the excess).
4. Set `b.disabledFloors = newDisabledFloors` (delete the field when 0 to keep
   saves clean).

**Route drain stays in the render/main layer** (pure layer can't reach
`WorldState`): the `main.ts` action handler calls `setBuildingActiveFloors`,
then — if the toggle **crossed from active ≥ 1 to active 0** — calls
`drainRoutesForBuilding(worldState, id)` (the existing one-way drain, mirroring
`main.ts:1402`). Toggling among ≥ 1 active floors never drains.

## 14. Maintenance / wear / alerts

- `maintenance.ts` (~269) and the `advanceIsland` wear skip (`economy.ts` ~2450)
  already skip non-operational buildings via the disabled/invalid checks —
  rewire to `activeFloors(b) <= 0` (a partially-disabled building still wears,
  scaled by its utilization, which already tracks throughput).
- `building-alerts-overlay.ts` (~164): replace the `b.disabled === true` dim cue
  with `activeFloors(b) < displayedFloorLevel(b)` (partial dim) / full dim at
  `activeFloors(b) === 0`.

## 15. UI

- **Inspector** (`inspector-ui.ts` ~1670–1690): replace the Disable button with
  **active-floor steppers** (−/＋ within `[0, built]`) plus quick **Off**
  (active 0) / **Max** (active = built). Show `active/built floors`. All paths
  dispatch through the input registry (AGENTS.md "every button through the
  registry"). Cost line stays free/instant.
- **main.ts** (~1308, ~1328–1337, ~1400–1402): replace the disable-toggle
  actions with set-active-floors actions; keep the cross-to-0 route drain.

## 16. Persistence (shared bump)

The **same** v23 → v24 migration handles both Part 1 and Part 2: per island
state default `buildJobs: []`; per building, `disabled === true` →
`disabledFloors = displayedFloorLevel(b)` (all built floors off), then drop the
`disabled` field; `disabled` falsy → no `disabledFloors`. Tests: a v23 building
with `disabled:true` migrates to `disabledFloors === builtCount`; round-trips.

## 17. SPEC.md (Part 2)

- **§NEW / §4.x building-disable section** (the doc currently describing the
  binary disable, per `docs/superpowers/specs/2026-05-23-building-disable-design.md`)
  — rewrite to the active-floor model: free reversible `[0, built]`, scales
  throughput/power/capacity/cluster by active floors, `0` = fully off (old
  disable, incl. one-way route drain on reaching 0), capacity lower clamps
  overflow.
- **§4.5/#35** note: cluster capacity uses ACTIVE floors.

## 18. Out of scope (Part 2)

- Per-floor selection (which specific floors) — floors disable from the top, a
  single count.
- Scheduling / automation of floor toggles.
- Refunding anything — toggling is always free.
