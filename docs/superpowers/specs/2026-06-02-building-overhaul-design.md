# Building Overhaul — Design Spec

**Date:** 2026-06-02
**Branch:** `feat/building-overhaul`
**Status:** Approved (brainstorming → ready for implementation plan)

## Summary

Four related additions to the building/construction system:

1. **Cancel construction** — abort an in-progress (or queued) build/upgrade for a **100% material refund** (distinct from demolish's ~30% scrap, §6.7).
2. **Build queue** — a FIFO waiting line that feeds the existing parallel build slots. Base **2** queued, scaling to keep a **1 : 2** ratio with running slots.
3. **Queue-capacity skill nodes** — mirror nodes in the Robotics sub-path: for every node that grants a parallel build slot, a counterpart grants queue capacity at 2× that contribution.
4. **Persistent floor-level badge** — every building shows its level in the bottom-right corner, always (including L1).

These touch a carefully-built system with subtle invariants (event-driven economy integration, per-tier construction timers, skill-tree effect aggregation, persistence migrations). The design below is written to preserve those invariants.

## Existing system (what we build on)

- Construction is **per-building**: each `PlacedBuilding` carries `constructionRemainingMs`. While `> 0` the building does not produce, does not contribute to power, and does not accrue maintenance time. `constructionRemainingMs` ticks down each `advanceIsland` segment; the building flips operational at 0. (`src/construction.ts`)
- **Parallel build slots** = `parallelBuildSlots(state)` in `src/placement.ts`: `1 + floor(parallelBuildBonus) + (parallelConstruction ? 1 : 0)`.
  - `parallelBuildBonus` aggregates `parallelBuildCapAdd` skill effects — today one node, `robotics.notable.parallelFoundries`, magnitude **2.0** → +2 slots.
  - `parallelConstruction` is a structural keystone (`robotics.keystone.parallelConstruction`) → +1 slot.
  - **Full tree = 1 + 2 + 1 = 4 running slots.**
- `inProgressBuildCount(state)` counts buildings with `constructionRemainingMs > 0`.
- Placement (`placeBuilding`) and upgrade (`applyUpgrade`) both **reject** with `reason: 'queue-full'` when `inProgressBuildCount >= slots`. Materials are deducted at placement/upgrade commit.
- Demolish (`demolishBuilding`) returns ~30% scrap; relocate (`relocateBuilding`) charges a half-fee. Cancel is a **new, distinct** operation (full refund).
- Persistence is at **SCHEMA_VERSION 17**; migrations run v7 → … → current (`src/persistence.ts`). AGENTS.md: **bump = migrate**.
- Skill-tree budget guard (`src/skilltree-budget.test.ts`): each sub-path ≤ **23** total nodes and ≤ **2** filler lever-families.

## 1. Queued-build representation

A queued build is a **`PlacedBuilding` already committed to the map, flagged `queued: true`** — not a separate pending-list structure.

- It **occupies its tiles immediately** (footprint reserved at enqueue; reuses existing overlap validation — no promotion-time re-validation, no "tile got taken" race).
- It carries its full `constructionRemainingMs` but **does not tick** while `queued`.
- It has a `queueSeq: number` — a monotonic per-island enqueue counter for deterministic FIFO ordering. (Sourced from a counter on `IslandState`, not wall-clock — the economy/pure layer forbids `Date.now()`.)

**Why this over a separate queue array:** combined with deduct-at-enqueue (§3), the build has already paid, so **cancel is one uniform operation** (remove building + refund) for both queued and running items, and the footprint validation/overlap path is reused as-is. Cost: a `&& !queued` predicate where "running" is meant, and a distinct queued map visual.

### Predicate changes

- `inProgressBuildCount` must count **running** builds only: `constructionRemainingMs > 0 && !queued`. This is the count gated against `parallelBuildSlots`.
- A new `queuedBuildCount(state)` counts `queued === true`, gated against `queuedBuildSlots`.
- `tickConstruction` / `nextConstructionCompletionMs` (`src/construction.ts`) **skip** `queued` buildings — they neither decrement nor schedule a completion event.
- `computeRates` already zeros production for `constructionRemainingMs > 0`, which correctly covers queued buildings too (no change needed there).

## 2. Two capacities

| Capacity | Function | Base | Full tree | Ratio |
|---|---|---|---|---|
| Running slots | `parallelBuildSlots` (unchanged) | 1 | 4 | — |
| Queue capacity | `queuedBuildSlots` (new) | 2 | 8 | 1 : 2 at empty AND full |

`queuedBuildSlots(state)` mirrors `parallelBuildSlots`:

```
queuedBuildSlots = 2 + floor(queueCapBonus) + (parallelQueue ? 2 : 0)
```

- `queueCapBonus` aggregates a new `queueCapAdd` skill effect. The mirror node grants **2× the parallel grant** → magnitude **4.0** (mirrors `parallelFoundries`' +2 → +4 queue).
- `parallelQueue` is the structural mirror of `parallelConstruction`, granting **+2** queue (mirrors the +1 running slot).
- Empty: 1 : 2. Full: (1+2+1) : (2+4+2) = 4 : 8 = 1 : 2. ✓

### Skill-tree changes

For **each** node that grants a parallel build slot, add a mirror node granting 2× that into queue capacity:

| Parallel grantor | Mirror queue node | Grant |
|---|---|---|
| `robotics.notable.parallelFoundries` (`parallelBuildCapAdd`, +2 slots) | new `robotics.notable.queueFoundries` (`queueCapAdd`, magnitude 4.0) | +4 queue |
| `robotics.keystone.parallelConstruction` (structural +1) | new `robotics.keystone.queueConstruction` (structural `parallelQueue` +2) | +2 queue |

- New effect kind `queueCapAdd` in `src/skilltree.ts` (additive, parallels `parallelBuildCapAdd`); aggregate into `queueCapBonus`; derive magnitude in `src/skilltree-derive-magnitudes.ts` (`queueCapAdd: 4.0`); label in `src/skilltree-archetypes.ts`; hover formatter in `skilltree.ts`.
- New structural effect kind `parallelQueue` (parallels `parallelConstruction`), read via `hasStructuralEffect` in `queuedBuildSlots`.
- Wire the two new nodes into `src/skilltree-catalog.ts` with appropriate edges/keystone prereqs.
- **Budget-guard check:** Robotics gains 2 nodes (one notable, one keystone — neither is filler, so no new filler lever-family). Verify Robotics total stays **≤ 23** before merging (`skilltree-budget.test.ts`).

## 3. Materials timing — deduct at enqueue

Enqueue is the analog of today's placement commit:

- Affordability is checked **once, at enqueue**; inventory is deducted immediately (full placement cost incl. terrain-modifier upfront cost per §8.9, or the upgrade cost for an upgrade job).
- Each enqueue sees the post-deduction balance, so a second enqueue checks the right inventory.
- No promotion-time "can't afford it now" failure mode.
- **Cancel refunds the stored cost** — "refund every spent material" applies uniformly because materials *were* spent at enqueue.

## 4. Cancel = 100% refund

Available whenever `constructionRemainingMs > 0` (queued **or** running). One action, two shapes:

- **Cancel a fresh placement** → remove the building entirely; refund the full placement cost (incl. terrain-modifier upfront cost); strip any storage-cap contribution the placement added; free the slot (and trigger promotion, §5).
- **Cancel an in-progress upgrade** → the building persists; revert to its **pre-upgrade floor level**; clear `constructionRemainingMs`; refund the **upgrade cost only** (not the whole building).

A cancelled placement that was **queued** uses the same removal+refund path (it has not started ticking; nothing else to unwind).

New pure function(s) in `src/placement.ts`, e.g. `cancelConstruction(spec, state, buildingId): CancelResult` returning the refunded basket, mirroring `DemolishResult`'s shape. Storage-cap mutation ordering follows `demolishBuilding`'s discipline (strip contribution before/with refund as appropriate).

## 5. Promotion (pure economy hook)

When a **running** build completes inside `advanceIsland` — at the `nextConstructionCompletionMs` boundary the integrator already splits on — and a free running slot results:

- If any `queued` build exists, **promote the FIFO head** (lowest `queueSeq`): clear its `queued` flag so it begins ticking from that same tick.
- Promote repeatedly if multiple slots are free (e.g. several completions in one segment), until slots are full or the queue is empty.

This keeps promotion inside the existing event-driven integration — no separate scheduler, deterministic for 1-frame and 24h-offline catchup alike.

## 6. UI

### Build-queue window (top-left, draggable)

- A windowed, **draggable** panel reusing `mountPanel` + `makePanelDraggable` (`src/ui-zones.ts`, `src/window-manager.ts`) — the same pattern as the bottom-right HUD economy panel. Registered in the **top-left zone** (`Zone.TL`, currently unused).
- Lists, for the selected island: **running** builds (with progress) then **queued** builds in FIFO order; each row has a **Cancel** button (full-refund). Shows `running N/slots` and `queued M/queueSlots` counts.
- All button handlers dispatch through the `input.ts` registry (`dispatchAction`) — no ad-hoc DOM handlers, per the input-registry rule (AGENTS.md).
- Placement/upgrade UI: when running slots are full **but queue has space**, the existing `'queue-full'` reject becomes an **enqueue** path (the build joins the queue) rather than a hard block. Only when queue is also full does it block.

### Floor-level badge (bottom-right, always shown)

- Added to `src/building-alerts-overlay.ts` (already imports `floorLevel`). A persistent badge in the **bottom-right** corner of each building's footprint, showing the level number, **always** (including L1). Bottom-left stays free. Top corners remain construction (TL) / maintenance (TR).
- Pure PixiJS Graphics in the existing overlay layer; rebuilt on the same throttle.

## 7. Persistence — bump v17 → v18

Per AGENTS.md "bump = migrate":

1. `SerializedSnapshotV17` type alias capturing the current shape.
2. `migrateV17toV18(s: SerializedSnapshotV17): SerializedSnapshotV18` — default new per-building fields (`queued: false`; `queueSeq` absent → treated as 0 / placement order) and the per-island `queueSeq` counter (default 0). Old saves keep working: nothing is queued, every in-progress build is running.
3. Wire into `loadWorld`'s version dispatch.
4. Add `18` to `SUPPORTED_LOAD_VERSIONS`.
5. Tests: v17 fixture loads into v18; v18 round-trips identity; field defaults exercised.

## 8. Testing & invariants (pure-layer + TDD)

All queue/cancel/promotion logic lives in the pure layer (`placement.ts`, `economy.ts`, `construction.ts`, `skilltree.ts`) and is tested without a renderer:

- Enqueue deducts materials; affordability gate; queue-full gate at `queuedBuildSlots`.
- `inProgressBuildCount` counts running only; queued builds excluded from the running gate.
- Promotion on completion: FIFO order, multiple promotions in one segment, offline-catchup correctness.
- Cancel placement (running + queued): building removed, full refund, storage caps restored, slot freed + promotion fires.
- Cancel upgrade: level reverted, upgrade cost refunded, building persists.
- `queuedBuildSlots` math at empty / partial / full tree; 1:2 ratio at empty and full.
- Budget guard still passes (Robotics ≤ 23 nodes).
- Migration tests (§7).

## 9. SPEC.md alignment

During implementation, align the locked spec with the new mechanics (AGENTS.md: find the relevant § and align):

- **§9.3 Robotics** — document queue capacity + the mirror nodes alongside parallel build slots.
- **§4 Building System / §15.1 data structures** — `queued` / `queueSeq` fields on the building model; cancel operation.
- **§15.3 piecewise integration** — promotion at the construction-completion boundary.
- A short **cancel** note distinguishing it from §6.7 demolish (scrap) and relocate (half-fee).

## Open items deferred (YAGNI for v1)

- Queue reordering / drag-to-reorder — **out**; FIFO only.
- "Cancel all queued" bulk button — **out** unless requested; per-item cancel only.
