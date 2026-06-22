# Land Reclamation must not overwrite already-placed land — placement-order ownership ledger

**Date:** 2026-06-22
**Status:** Design approved, ready for implementation plan
**Spec sections touched:** §3.4 (Land Reclamation), §3.6 (Joining — per-constituent terrain / overlap precedence)

## Problem

On a merged island, the Land Reclamation Hub grows a chosen constituent ellipse
(primary or an absorbed lobe) by +1 on an axis. A growing constituent is
**supposed to never overwrite another constituent's already-placed land**, but it
does.

### Root cause (verified)

Overlap precedence between constituents is resolved by **constituent index
order** — "the earliest constituent (primary, then merge order) wins" — in three
places that all walk `islandConstituents(spec)` in index order and take the first
inscriber:

- `attachTerrainAt`'s `terrainAt` closure (`src/world.ts:294`) — the terrain of a
  tile.
- `constituentBiomeAt` (`src/world.ts:234`) — the biome used for biome-locked
  placement.
- `computeIslandTiles`'s dedup `seen` set (`src/island.ts:233`) — which
  constituent contributes a shared tile to the union list.

`performMerge` (`src/island-merge.ts`) makes the **larger** island the absorber,
which becomes the **primary (index 0)**; the smaller absorbed island becomes a
later `extraEllipses` entry. So when the player grows the **primary** (the common
case — it is the bigger island), the grown ring inscribes tiles the absorbed lobe
already owns, and because the primary is scanned first, **it claims those tiles
and overwrites the lobe's land and terrain**. Generally: any *earlier-index*
constituent grown into a *later-index* one steals its tiles.

This is also **internally inconsistent**: `landReclamationCost`
(`src/land-reclamation.ts:124`, and SPEC §3.4 line 420) already treats "tiles
already covered by another constituent" as **not gained / not charged** — so the
cost model says "you did not gain that tile" while the renderer says "the grower
now owns it." That disagreement *is* the overwrite. SPEC §3.6 line 466 papers
over it by **equating** "earliest constituent index wins" with "already-placed
wins"; those two are only equal *before any growth* and diverge the moment a
constituent grows into a sibling.

### Key facts that bound the fix

- **Only terrain/biome ownership of contested tiles is wrong — never the tile
  set.** The footprint is always the *union* of constituents
  (`islandLocalTiles`, `islandTileCount`, `islandsOverlap`, vision), independent
  of precedence. `computeIslandTiles` reads each tile's terrain via the
  `terrainAt` closure, so fixing the ownership resolver fixes the rendered
  terrain too; the `seen` dedup only decides *list membership* (a union — order
  irrelevant), not terrain.
- **Original footprints are pairwise disjoint at merge time.** Growth is +1 at a
  time, so two approaching islands hit orthogonal adjacency (the §3.6 merge
  trigger) *before* overlap. Overlap therefore only ever arises from growth
  *after* a merge. (A rare single-step jump to a 1-tile overlap is possible; it
  degrades to a single pre-existing contested tile, handled by the same rule.)
- **Persistence rides the existing round-trip.** `serializeWorld`
  (`src/persistence.ts:935`) spreads every `IslandSpec` field except `terrainAt`,
  and the server shares the exact same `serializeWorld`/`deserializeWorld`
  (`server/src/game/runtime.ts`), so a new optional spec field round-trips on
  both client and server with no bespoke serialization.

## Chosen behavior

**Yield, do not overwrite.** Growth still happens, but contested tiles keep the
**already-placed** constituent's land/terrain; the grower gains only genuinely-new
(ocean) tiles — exactly what `landReclamationCost` already charges for. "Already
placed" is **temporal** (who inscribed the tile first in time), resolved fully
and exactly — including the grown-vs-grown case (e.g. you keep growing the
primary outward and it never eats a lobe's earlier reclaimed extension).

## Design: placement-order ownership ledger

### Data model

Add to `IslandSpec` (and the derived `SerializedIslandSpec`):

```ts
/** One ownership claim: constituent `c` inscribed the ring up to (major,minor)
 *  at this point in placement order. `constituent` indexes islandConstituents()
 *  (0 = primary, N = extraEllipses[N-1]). */
export interface OwnershipClaim {
  readonly constituent: number;
  readonly major: number;
  readonly minor: number;
}

// on IslandSpec:
readonly ownershipLedger?: ReadonlyArray<OwnershipClaim>;
```

- **Order is placement (temporal) order.** Earlier entries were placed first.
- **Absent ⇒ implicit baseline** = `islandConstituents(spec)` in index order at
  *current* radii. This reproduces today's "earliest-index wins" exactly, so:
  - single-ellipse islands and merged-but-never-grown islands **store nothing**
    (keeps saves lean — mirrors the route-`waypoints` "persist only when present"
    convention at `persistence.ts:976`), and
  - existing saves load and render **identically** (pre-fix overlaps cannot be
    recovered — there is no history — but they do not change).
- **Invariant:** the *last* claim for each constituent equals that constituent's
  *current* radii (the union covered by the ledger equals the current footprint).
  Asserted by a test; the resolver also self-heals if it is ever violated (below).

A constituent may appear **multiple times** in the ledger (its baseline claim
plus one per later growth). Only **consecutive** same-constituent claims coalesce;
non-consecutive ones must stay separate — that separation is exactly what encodes
"this growth happened after that other constituent's growth," which makes the
grown-vs-grown case correct.

### Shared resolver

One pure function in `src/world.ts`, used by both ownership sites:

```ts
/** The constituent that owns island-local tile (x, y), by placement order
 *  ("already-placed wins"), plus its index. undefined when no constituent
 *  inscribes the tile. */
export function constituentOwnerAt(
  spec: IslandSpec, x: number, y: number,
): { ellipse: ConstituentEllipse; index: number } | undefined {
  const constituents = islandConstituents(spec);
  const ledger = spec.ownershipLedger;
  if (ledger && ledger.length > 0) {
    for (const claim of ledger) {
      const c = constituents[claim.constituent];
      if (!c) continue; // defensive: stale index
      if (tileInscribedInEllipse(x - c.offsetX, y - c.offsetY, claim.major, claim.minor)) {
        return { ellipse: c, index: claim.constituent };
      }
    }
    // Self-heal: if the ledger under-covers the current union (invariant
    // violation), fall through to the current-radii index walk so we never
    // leave a union tile unowned.
  }
  for (let i = 0; i < constituents.length; i++) {
    const c = constituents[i]!;
    if (tileInscribedInEllipse(x - c.offsetX, y - c.offsetY, c.major, c.minor)) {
      return { ellipse: c, index: i };
    }
  }
  return undefined;
}
```

Note the terrain-boundary predicate passed to `terrainAtForBiome` uses the owner
ellipse's **current** radii (`c.major/c.minor`), not the historical claim radii —
terrain is generated for the lobe's current extent, only *ownership* of the
contested tile is historical.

### The three precedence sites

- **`attachTerrainAt`** (`world.ts`): replace the inline constituent loop with
  `const owner = constituentOwnerAt(spec, x, y)`. If `owner`, apply the
  `baseLayoutRadius` hand-layout branch only when `owner.index === 0` (primary),
  then `terrainAtForBiome(owner.ellipse.biome, owner.ellipse.originId, …)` with
  the current-radii boundary predicate. The existing "not inscribed in any
  constituent" fallback is unchanged.
- **`constituentBiomeAt`** (`world.ts`): `return constituentOwnerAt(spec, x, y)?.ellipse.biome`.
- **`computeIslandTiles`** (`island.ts`): **no change.** Tile terrain comes from
  the `terrainAt` closure (now ledger-aware); the dedup remains a union.

### Maintenance — the only two mutation points

- **`expandConstituent`** (`src/land-reclamation.ts`), after the radius bump:
  materialize the implicit baseline if `ownershipLedger` is absent
  (`islandConstituents` → claims at current radii, index order), then append a
  claim `{ constituent: index, major: newMajor, minor: newMinor }`, coalescing
  only if the **last** ledger entry is the same constituent (replace its radii).
- **`performMerge`** (`src/island-merge.ts`): after appending the absorbed
  island's constituents to `extraEllipses` (primary + recursive extras, as today),
  if **either** side has a ledger, ensure the absorber has one (materialize its
  baseline if absent) and append the absorbed island's claims — its own ledger if
  present, else its implicit baseline — **after** the absorber's claims, with each
  claim's `constituent` index remapped to its new position in the absorber. If
  **neither** side has a ledger, leave it absent (the implicit baseline of the
  merged spec is correct, since merge introduces no overlap).

A shared helper for materialize/append/coalesce lives in `world.ts` (next to the
resolver and `islandConstituents`) so both mutators use one implementation.

### Persistence

**No schema bump.** The field is additive, optional, has a safe default (absent =
implicit baseline = prior behavior), and is forward/backward compatible: old code
spreads-and-ignores it on round-trip; new code treats absent as the baseline. It
rides the existing `serializeWorld` spread on both client and server. The
`SerializedIslandSpec` type gains the optional field; `SUPPORTED_LOAD_VERSIONS`
and `SCHEMA_VERSION` are untouched. (Rationale recorded here so a reviewer
steeped in "bump = migrate" sees this is a soft-compatible additive field, not a
shape change to existing data.)

### Behavior-change caveat

For any save with overlapping **grown** constituents, this changes terrain/biome
ownership of the contested tiles, which can change economy output (a resource vein
under a building stops being overwritten and the building keeps producing). So the
**server-bench `catchUp` oracle digest will change for such saves and must be
re-baselined** — this is an intended bugfix, not a regression. Saves with no
post-merge growth overlap are byte-identical.

### Out of scope / known limits

- Pre-fix overlaps in existing saves are not recoverable (no history); they load
  unchanged.
- The Universe Editor reordering/removing constituents would invalidate ledger
  `constituent` indices; the editor must rebuild or clear the ledger (tracked
  separately, not in this change).

## SPEC.md edits (code and spec move together)

- **§3.6 line 466:** rewrite the "Overlap precedence" sentence. Replace the claim
  that a shared tile "is owned by the earliest constituent (the primary, then
  merge order) — the 'already-placed wins' rule" with the temporal rule: a shared
  tile is owned by the constituent that inscribed it **first in placement order**,
  recorded in `IslandSpec.ownershipLedger`; growth appends a claim so a growing
  constituent never takes a tile another constituent already holds. Note terrain
  is resolved by `constituentOwnerAt` (ledger walk), independent of the
  `computeIslandTiles` dedup order.
- **§3.4 line 420:** add a sentence that the union-delta cost (already "tiles
  covered by another constituent are not charged") matches the no-overwrite
  rule — the grower is charged for, and gains, exactly the new ocean tiles.

## Test plan

Pure-layer tests (no renderer), in `src/`:

1. **Reported-bug regression:** a merged island (primary + adjacent lobe with a
   distinct biome/vein). Grow the primary by +1 toward the lobe; assert the
   contested tiles still report the **lobe's** biome (`constituentBiomeAt`) and
   the lobe's terrain (`spec.terrainAt`), and that `landReclamationCost` charged 0
   for them.
2. **Grown-vs-grown ordering:** lobe grows into the gap first, then the primary
   grows over that region; assert the lobe keeps its reclaimed tiles (temporal,
   not index, precedence).
3. **Ledger maintenance:** consecutive same-constituent growths coalesce to one
   trailing entry; interleaved growths produce separate entries in placement
   order; the last-claim-equals-current-radii invariant holds.
4. **Merge maintenance:** merging two ledgered islands appends and index-remaps
   correctly, including a recursive (already-merged) absorbed island; merging two
   never-grown islands leaves the ledger absent.
5. **Union invariant:** `islandTileCount` / `islandLocalTiles` are identical with
   and without a ledger for the same geometry (only terrain ownership differs).
6. **Persistence round-trip:** a spec carrying a ledger serializes and
   deserializes byte-identically; an old (ledger-absent) snapshot loads and
   resolves ownership via the implicit baseline.
