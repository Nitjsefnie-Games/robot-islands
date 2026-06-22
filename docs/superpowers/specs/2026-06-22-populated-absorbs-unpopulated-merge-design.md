# Design: populated islands absorb non-populated neighbors on contact

**Date:** 2026-06-22
**Status:** Approved (brainstorming) → ready for plan
**SPEC §:** 3.6 (Joining)

## Context

Today a populated island can grow via the Land Reclamation Hub until its tile
footprint *touches* a neighbor — but the merge engine (`findNextMerge`,
`src/island-merge.ts`) only ever considers islands where `populated === true`.
A discovered-but-unpopulated (or undiscovered) neighbor is invisible to it, so
the growing island's footprint can reach — and visually overlap — an unsettled
neighbor with **nothing happening**. This was underspecified in §3.6, which
silently assumes both parties to a merge are populated. The decision: a
populated island that grows to touch *any* non-populated neighbor absorbs it.

## Decision

**A merge fires whenever two island footprints touch and at least one of them is
populated.** The populated island is always the surviving **absorber** (it owns
the only `IslandState`); the non-populated neighbor is folded in as a new
constituent lobe, contributing exactly what it has — its **land area, biome,
terrain seed, and ownership-ledger lobe** — and nothing else (no inventory,
skill points, level, buildings, routes, drones). Two unpopulated islands never
merge (neither has state to survive as).

The existing **populated-vs-populated** behavior — "larger absorbs smaller,
level tiebreak" via `chooseMergeAbsorber` — is **unchanged**. The size rule only
governs that case; when exactly one party is populated, the populated one is the
absorber regardless of relative size.

**Eligibility:** any island the footprint touches, discovered or not. We do
**not** gate on the `discovered` flag. In practice the target is essentially
always already discovered before contact — a populated island's vision halo
extends `VISION_PADDING_TILES` (10) beyond its ellipse, well past its footprint,
so vision discovers the neighbor before the footprint physically reaches it —
but skipping the flag check keeps the rule simple and robust.

## Why this approach

- `performMerge` (`src/island-merge.ts:121`) is **already state-safe**: every
  step touching the absorbed island's `IslandState` (inventory transfer at
  `:238`, skill refund at `:253`, storage credit at `:224`) is guarded by
  `absorbedState &&`, and an unpopulated island has no buildings/routes/drones to
  migrate. So the absorption path requires *no behavioral change* in
  `performMerge` — only the trigger and absorber-selection in `findNextMerge`.
- The settlement-vehicle interplay is **already handled gracefully**: a settler
  in transit to a now-absorbed island is retargeted to the absorber by
  `performMerge` step 7 (`:292`), and on arrival `tickVehicles`
  (`src/settlement.ts:896`) sees `target.populated` and consumes the vehicle +
  cargo cleanly (counts as an arrival, no crash, no new state). No new logic.

## Change inventory

### `src/island-merge.ts`

1. **`findNextMerge` (`:381`)** — the only substantive logic change.
   - **Candidate scan:** change from "pairs within the `populated` set" to
     "pairs where ≥1 island is populated." Iterate `populated × world.islands`
     (skip self; dedupe each unordered pair once) so cost stays **O(P·N)**
     (P = populated count, small) rather than O(N²) over all islands.
   - **Absorber resolution:** if both populated → existing
     `chooseMergeAbsorber(a, b, sa, sb)`. If exactly one populated → the
     populated island is the absorber unconditionally.
   - **State bail:** relax the `!sa || !sb` guard (`:438`) to require only the
     **absorber's** state to exist (a populated absorber always has state; a
     missing absorber state is still a real bug → skip).
   - **`mergeSignature` (`:369`):** must cover every participating island
     (id + ellipse geometry + a populated bit), since an unpopulated target's
     presence/removal affects the scan result. Memoization correctness is
     preserved: only null (no-merge) results are cached; a non-null result is
     consumed by the immediate `performMerge` that mutates geometry → next
     signature differs → recompute.
2. **`performMerge` (`:121`)** — no behavioral change. Update the stale comments
   that assert "both islands are populated" (`:236-237`, `:253`) to reflect that
   the absorbed island may be stateless.
3. **`chooseMergeAbsorber` (`:48`)** — unchanged (only invoked when both
   populated).

### `SPEC.md` §3.6

Update the §3.6 trigger paragraph (`:448`) and the "larger island absorbs the
smaller" bullet (`:454`) to state the precondition explicitly:
- A merge requires **≥1 populated** island; two unpopulated islands never merge.
- When both are populated: larger absorbs smaller (level tiebreak) — unchanged.
- When exactly one is populated: the **populated** island absorbs the
  non-populated neighbor regardless of size; only the neighbor's land / biome /
  terrain-seed / ownership-ledger lobe transfers (it has no
  inventory/skill/level/buildings/routes to carry).
- Eligibility is geometric contact, independent of the `discovered` flag.

Also update the in-code comment at `src/island-merge.ts:344-350`
("Only populated islands participate…").

## Verification

- New + updated unit tests pass (`npx vitest run src/island-merge.test.ts`).
- Full client suite green (`npx vitest run` client project) — server PG not
  required for this change, but `npm run build` (`tsc -b`) must pass clean under
  strict.
- SPEC §3.6 and the code agree (no divergence).

## Tests (`src/island-merge.test.ts`)

- **Invert** the existing `:788` "skips unpopulated islands (no merge between
  populated and unpopulated)" test → assert the populated island **absorbs** a
  touching unpopulated island.
- **Add:**
  - absorbed unpopulated lobe keeps its **biome + terrain seed** (a constituent
    is appended with the absorbed island's `originId`);
  - an **undiscovered** island is absorbed on contact (no `discovered` gate);
  - two **unpopulated** overlapping islands do **not** merge;
  - a settlement vehicle in transit to the absorbed island is retargeted to the
    absorber and consumed cleanly (no crash, counts as arrival).

## Risks

- **Memoization staleness** — LOW. The signature now spans more islands; verify
  it includes every participant so a stale null isn't served after an
  unpopulated target appears/changes. Unpopulated geometry is static, so the
  common case is unaffected.
- **Perf on large saves** — LOW. The candidate scan grows from O(P²) to O(P·N)
  but P stays small and the null-result memo still elides the per-step rescan
  during catch-up.

## Out of scope

- **Adding the absorbed undiscovered lobe's footprint cells to
  `revealedCells`** — cosmetically moot (the merged island is populated → renders
  `'visible'` regardless of `revealedCells`). Left untouched unless a fog
  inconsistency surfaces.
- **Un-merge / settling a lobe back out** — merging stays permanent, consistent
  with §3.6 ("Joining is permanent").

## Integration track

Single contained system (the merge trigger). Per `CONTRIBUTING.md`, lands
**directly on `master`** assuming green — not a feature branch.
