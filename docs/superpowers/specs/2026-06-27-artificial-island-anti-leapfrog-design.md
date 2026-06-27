# Artificial-island anti-leapfrog — design

**Date:** 2026-06-27
**Status:** approved design, pre-implementation
**Touches:** SPEC §2.5 (Artificial Islands), §3.4 (Land Reclamation), §3.6 (Merging); `src/construction-gate.ts`, `src/artificial-island.ts`, `src/world.ts`, `src/persistence.ts`, `server/src/game/intents.ts`, construction UI + LOCAL gateway.

## Problem

Island **merging** (§3.6) is intended to stay a *side effect* of geometry: two
islands merge when their inscribed-tile footprints touch. That is fine. What is
broken is how **cheaply** a player can *manufacture* those touches and thereby
collapse an entire archipelago — and the logistics pillar built around it
(routes, drones, submarines, airships, and ~5 skill disciplines) — into one
self-sufficient megatile.

### The exploit (observed on the `migtest` save)

`home` is a single merged island: **17 constituents** (base + 16 absorbed
ellipses), of which **10 ellipses are artificial** (2 artificial islands,
`art-1`/`art-2`, each reclamation-grown to biome max), reaching out to
`offsetX −285`. The account has `routes/drones/vehicles/satellites = 0` despite
fully unlocking every transport/submarine/network skill keystone — proof the
logistics game was deleted, not played.

The technique, verbatim from the player:

> place an artificial island so it would merge when an edge of the main island
> grows to it; grow the merged island to max−1; add a new island next to it;
> merge; repeat.

This is a **leapfrog**: each hop is one artificial placement plus a **single**
reclamation tile-step by the *already-existing* island. It defeats
`BIOME_MAX_RADII` as a reach limit, because every new artificial lobe is a fresh
r≤28 budget — so reach is unbounded while per-hop cost is ~one tile-ring.

### Verified current behavior (code, not assumption)

- **Cost** (`LAND_TILE_COST`, `building-defs.ts`) = `{ steel_beam: 1, concrete: 10 }`
  per land tile. Flat. No scaling with island size or constituent count. Billed
  in bulk goods a T3+ island floods. (`computeConstructionCost` /
  `landReclamationCost` both multiply tile counts by this basket.)
- **Server position validation** (`construct-island` intent,
  `server/src/game/intents.ts`) re-runs `positionIsFree` (overlap) and
  `regionDiscoveredOrVisible` (visibility) authoritatively. **There is no
  proximity/range gate, and no anti-leapfrog gate.**
- A range check alone would not help: you place in *clear, visible* water (passes
  both existing gates) and *grow into contact*, so the overlap check is satisfied
  at placement time and the merge happens one step later.

## Goal

Keep merge-as-side-effect. Make **reaching** a merge cost real investment, by
gating **artificial-island construction** with three placement-time rules. All
three are **pure predicates** in `construction-gate.ts`, re-run identically by
the construction UI, the LOCAL mutation gateway, and the authoritative
`construct-island` server intent — the established trust-surface pattern.

Non-goals: changing the merge trigger itself; un-merging existing islands (merge
stays permanent, §3.6); touching `LAND_TILE_COST` magnitude (a separate, optional
cost-curve change — see "Out of scope").

## The three rules

### Rule 1 — Anchor (no cheap swallow)

> Reject placement if the candidate footprint **touches or overlaps the
> max-growth footprint of any populated island**.

- *max-growth footprint* of an island = every constituent (base + each
  `extraEllipse`) rasterized at its **`BIOME_MAX_RADII`** radii, not its current
  radii. Computed regardless of whether the island currently has a Land
  Reclamation Hub (a hub can always be built later, so conditioning on it would
  be circumventable).
- New pure helper, built on the existing `islandsOverlap` tile machinery with
  each constituent's radii swapped to its biome cap:
  `maxGrowthFootprintTouches(world, cx, cy, major, minor): boolean`.
- **Effect:** forces a gap no *existing* island can close by growing. The only
  path to a merge is growing the *new* artificial island in — which is exactly
  the "forces progressing the island" investment the player should pay. Directly
  outlaws the "grow the existing island one cheap step" half of the loop.
- **Margin:** strict — *touching* the max-growth footprint is rejected, mirroring
  the existing overlap rule. (Tunable; a buffer of +k tiles can be added later if
  boundary-gaming appears.)

### Rule 2 — Range (bounded to founder)

> Reject if the candidate footprint's nearest-tile distance to the **founder
> island** (the Platform Constructor island paying for the build) exceeds
> `ARTIFICIAL_RANGE_TILES`.

- Placeholder **`ARTIFICIAL_RANGE_TILES = 48`**, tunable (codebase convention for
  placeholder magnitudes).
- Distance = minimum tile gap between the candidate's inscribed footprint and the
  founder island's inscribed footprint (consistent with the footprint-based
  anchor/overlap tests).
- **Effect:** stops giant leaps and claiming distant ocean; construction stays
  local to the builder. Combined with the anchor rule the legal placement zone is
  a **band**: beyond every populated island's max-growth reach, yet within 48
  tiles of the founder.

### Rule 3 — Ratio (per-founder budget)

> At construct time, reject if
> `attributedArtificial(founder) + 1 > RATIO × naturalConstituents(founder)`,
> with `RATIO = 2`.

- `naturalConstituents(founder)` = count of the founder's constituents (base +
  `extraEllipses`) whose origin is **natural** — `originId` not beginning `art-`.
  An artificial founder's own base is artificial ⇒ 0 natural ⇒ cannot build (an
  artificial island can never found another).
- `attributedArtificial(founder)` = count of **every** artificial origin-island
  **anywhere in the world** — standalone `art-*` islands **and** absorbed
  artificial lobes in *any* island's `extraEllipses` — whose
  `founderId === founder.id`. This is the founder's *lifetime* artificial-creation
  count: it never decreases when an island it built is merged (the attribution
  survives into the lobe metadata), so pre-building a swarm of standalone
  platforms is fully counted, not deferred until merge.
- **Effect:** an island's capacity to manufacture artificial land is proportional
  to its natural mass; absorbing more *natural* islands legitimately raises the
  ceiling, but artificial land cannot bootstrap itself.

## Data-model change (schema v32 → v33)

Rule 3 requires attribution to survive merges, so:

- Add **`founderId?: string`** to `IslandSpec` (the founding island's id at
  construction time). Stamped by `constructIsland`.
- Add **`founderId?: string`** to the `extraEllipse` entry shape, so a merge that
  absorbs an artificial island carries the attribution into the lobe (alongside
  the existing `originId`). `island-merge` must copy it through.
- **Migration `migrateV32toV33`:** for every existing artificial island/lobe,
  backfill `founderId` = the id of the island that currently holds it (the
  standalone island's own id, or the absorbing island's id for a lobe). Natural
  constituents get no `founderId`. This is best-effort historical attribution;
  it cannot reconstruct the true original founder, but it keeps every existing
  save legal and never un-merges anything.
  - On `migtest`: both artificial lobes resolve to `home`; `home` has 7 natural
    constituents ⇒ budget 14 ≥ 2 used. Legal, unchanged.

Follow the repo migration discipline (`AGENTS.md` "bump = migrate"): add the
`SerializedSnapshotV32` alias, the `migrateV32toV33` function wired into
`loadWorld`, and `32` to `SUPPORTED_LOAD_VERSIONS`.

## Enforcement surfaces (all three rules)

Mirror the existing `positionIsFree` / `regionDiscoveredOrVisible` wiring exactly:

1. **Pure** (`construction-gate.ts`): the three predicates + a single
   `validateArtificialPlacement(world, founderSpec, cx, cy, major, minor)`
   convenience that returns a reason code (`leapfrog-anchor` / `out-of-range` /
   `ratio-exceeded`).
2. **Server intent** (`construct-island`, `server/src/game/intents.ts`): call the
   predicates right after the existing `positionIsFree` / `regionDiscoveredOrVisible`
   checks; return `{ ok:false, error: <reason> }` on failure. Stamp `founderId`
   on the minted spec.
3. **LOCAL gateway:** same predicates on the client-authoritative path.
4. **Construction UI:** surface the reason (ghost turns red + tooltip), and clamp
   the draggable ghost to the legal band where practical.

## Testing

- **Rule 1:** placement touching a populated island's max-growth footprint is
  rejected even when it does NOT touch the *current* footprint (the exact
  leapfrog placement); placement just beyond max-growth is accepted.
- **Rule 2:** placement > 48 tiles from founder rejected; ≤ 48 accepted; distance
  measured footprint-to-footprint, not centre-to-centre.
- **Rule 3:** founder with N natural constituents accepts up to 2N artificial
  builds and rejects the (2N+1)-th; attribution counts a previously-merged
  artificial island; an artificial founder (0 natural) is rejected outright.
- **Migration:** a v32 fixture with an artificial lobe loads to v33 with
  `founderId` backfilled; v33 round-trips identity; `migtest`-shaped save stays
  legal.
- **Parity:** LOCAL and REMOTE reject identically for each reason (crafted-intent
  test, as with the existing gates).

## Out of scope (flagged, not done here)

- **Cost-curve (`LAND_TILE_COST`) scaling.** The flat `concrete×10` per tile is a
  real secondary lever (each hop is still cheap in bulk goods), but the three
  structural rules above are what break the leapfrog. A super-linear size/
  constituent cost curve can follow as a separate change if still desired after
  these land.

## Known limitation

If the **founder island itself** is later merged into a bigger host, the
artificial islands it created keep `founderId` = the original founder's id, so
they stop counting against the new host's budget. The anchor + range rules still
gate every individual placement regardless, so this cannot be spun into a fresh
cheap leapfrog — it only means the per-founder *count* ceiling is per original
founder, not per current megastructure. Documented, accepted.

## Tunable parameters (placeholders)

| Constant | Value | Where |
|---|---|---|
| `ARTIFICIAL_RANGE_TILES` | 48 | `construction-gate.ts` (Rule 2) |
| `ARTIFICIAL_RATIO` | 2 | `construction-gate.ts` (Rule 3) |
| anchor margin | 0 (strict touch) | Rule 1 |
