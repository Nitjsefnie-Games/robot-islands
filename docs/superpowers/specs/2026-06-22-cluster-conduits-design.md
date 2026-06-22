# Cluster Conduits — design spec

**Date:** 2026-06-22
**Status:** Approved design (pre-implementation)
**Relates to:** SPEC.md §4.4 (Adjacency rules), §4.5 (Adjacency effects / cluster bonus), §13.3 (Lattice Node cross-island adjacency)

## 1. Problem & decision

Today the §4.5 cluster bonus — the floor-weighted, same-category, linear-uncapped multiplier — is earned **only** between buildings that physically touch (4-connected) on the **same island**. `clusterBonusMuls` in `adjacency.ts` runs a per-island union-find over same-category 4-adjacent buildings; the §13.3 cross-island Lattice Node deliberately does **not** feed this term (it carries gating adjacency + exotic-pair skill boosts only).

There is currently **no way** to earn the cluster bonus between buildings that are far apart, on one island or across islands.

**Decision:** add two infrastructure buildings — **Cluster Conduit** (same-island) and **Lattice Conduit** (cross-island) — that let the player wire conduits into a transitive network. Same-category buildings 4-adjacent to any conduit in one wired network cluster together **at full strength, no attenuation**, as if physically adjacent. The Lattice Conduit is the **only** carrier of the §4.5 cluster bonus across islands.

Balance lives entirely in **build cost + tier gate** — no upkeep, no power draw.

## 2. Player-facing model

### 2.1 Buildings

| Building | Scope | Tier gate | Cost (placeholder) | Notes |
|---|---|---|---|---|
| Cluster Conduit | Same-island wiring | T2–T3 | Moderate (steel/concrete) | Wires only to other conduits on the **same island**. |
| Lattice Conduit | Cross-island wiring | T5 | Substantially higher (exotic/endgame materials) | Wires to conduits on **any** island; also works locally. Main throttle on cross-island snowballing. |

Both are pure connectivity infrastructure: they run no recipe and produce/consume no power, so they are **never cluster members** themselves (they bridge other buildings; their own §4.5 bonus is moot).

### 2.2 Attachment

A building is **attached** to a conduit iff it is **4-adjacent** to the conduit's footprint — the exact `borderTiles` / `touchesBorder` test used everywhere else for adjacency (and the same definition the Lattice Node uses for "4-adjacent to the node"). No new range/radius concept is introduced.

### 2.3 Wiring

The player explicitly links conduit → conduit (routes-style click-to-link UI). Wires form an arbitrary graph.

- **Transitive network:** a wire-connected **component** of conduits pools all of its attached buildings. Within that pool the existing **per-category** rule still applies — a Smelter attached to A clusters with a Smelter attached to wired B, but never with a Power building attached to B.
- **Wire legality:** a wire is "cross-island" iff its two endpoints sit on different islands.
  - A **same-island Cluster Conduit** may only participate in **same-island** wires.
  - A **cross-island wire requires a Lattice Conduit at *both* endpoints.**
  - A Lattice Conduit also functions locally, so one network can mix both building types (locals stitched by cheap Cluster Conduits, islands bridged by Lattice Conduits at each end).
- Invalid wire attempts (illegal cross-island wire, self-link, duplicate link) are rejected and tinted red in the UI.

### 2.4 Bonus semantics

Wired neighbours count **exactly** like physical neighbours in the §4.5 formula `mul_i = 1 + rate × (K − c_i)`: a wired building contributes its floor-capacity `c = 1 + floorLevel` to the cluster's `K`, with **no** attenuation, regardless of distance or island. The cluster bonus stays linear and uncapped; cost + tier are the only throttles.

## 3. Architecture

The bonus comes from one place — `clusterBonusMuls` in `adjacency.ts` (union-find over same-category 4-adjacent buildings, grouped by category). The change is to **inject extra union pairs** derived from the conduit network before computing component capacities. **Chosen approach: crossIsland-injection** (keep the per-island calc; feed cross-island attached buildings through the existing `ctx.crossIsland` plumbing). Rejected: a global all-islands cluster pass — it would rewrite the per-island memoization/signature discipline the catch-up perf work depends on.

### 3.1 Data model & persistence

- New world field `World.conduitLinks: ConduitLink[]`, where `ConduitLink = { a: string; b: string }` references **conduit building IDs** (globally unique per `world.ts`). Order-insensitive; deduped.
- Persisted on the snapshot. Schema bump **v31 → v32**: add `SerializedSnapshotV31`, `migrateV31toV32` (defaults `conduitLinks: []`), wire into `loadWorld`'s dispatch, add `32` to `SUPPORTED_LOAD_VERSIONS`. (Current `SCHEMA_VERSION = 31`.)
- `makeInitialWorld` seeds `conduitLinks: []`.

### 3.2 Cluster computation changes

`clusterBonusMuls(buildings, defs, conduitUnions?)` gains an optional `conduitUnions: ReadonlyArray<readonly [string, string]>` parameter — pairs of **building IDs** to union into the same component **when same-category**. The union-find applies these in addition to the physical 4-adjacency unions. A pair whose two buildings differ in category is ignored (the per-category invariant is preserved).

A new pure helper (e.g. `conduitClusterUnions` in `adjacency.ts` or a small `conduits.ts` module) derives the union pairs:
1. Resolve each conduit's attached set (buildings 4-adjacent to it that `participatesInCluster`).
2. Build the conduit wire graph and find its connected components (union-find over conduit IDs via `conduitLinks`).
3. For each component, for each category, emit union pairs linking that category's attached buildings together (e.g. chain them: `[b0,b1],[b1,b2],…`).

### 3.3 Same-island vs cross-island wiring into the calc

- **Same-island:** all attached buildings are already in the island's `clusterBuildings` set, so the derived `conduitUnions` for same-island wires plug straight into the existing per-island `clusterBonusMuls` call (`economy.ts` ~line 997). No structural change beyond the new arg.
- **Cross-island:** the per-island pass must see attached buildings reachable through cross-island wires that live on *other* islands. Reuse the existing `ctx.crossIsland` plumbing (already threaded `EconomyCtx → getDerivationsMemo → derivationsSignature`): feed the conduit-reachable cross-island attached buildings into the island's cluster set + union pairs so they contribute their floor-capacity to `K`. This is the one genuinely new path; it must be included in the derivations **signature** so the memo invalidates when conduit links or remote attached buildings change.

### 3.4 Inspector / read model

`inspector-ui.ts` (which already calls `clusterBonusMul`) shows, for a selected conduit: its attached buildings and wire count; for a selected producing building, whether its cluster bonus includes wired/remote members.

## 4. Change inventory

| File | Change |
|---|---|
| `src/building-defs.ts` | Add `cluster_conduit` + `lattice_conduit` defIds, defs (footprint, tier gate, cost), category (`logistics` or `special`; not a cluster-contributing recipe/power building). |
| `src/adjacency.ts` | `clusterBonusMuls` accepts optional `conduitUnions`; add `conduitClusterUnions` helper deriving union pairs from attached sets + wire components. |
| `src/economy.ts` | Derive `conduitUnions` per island; pass into `clusterBonusMuls`; extend `crossIsland` handling + derivations signature for conduit-reachable remote attached buildings. |
| `src/world.ts` | Add `conduitLinks: ConduitLink[]` to `World`; seed empty in `makeInitialWorld`. New `ConduitLink` type (or in a `conduits.ts`). |
| `src/persistence.ts` | Bump to v32; `SerializedSnapshotV31`, `migrateV31toV32`, `loadWorld` dispatch, `SUPPORTED_LOAD_VERSIONS`, serialize/deserialize `conduitLinks`. |
| `src/conduits.ts` (new, optional) | Pure helpers: wire-graph components, attached-set resolution, legality check (`canWire(a, b)`), link add/remove/dedup. Keeps `adjacency.ts` focused. |
| `src/input.ts` | New `wire-conduit` action + key binding for wiring mode. |
| `src/placement-ui.ts` / new `conduit-wiring-ui.ts` | Wiring-mode interaction: pick conduit A → conduit B, validity tint, commit/cancel. |
| `src/conduit-overlay.ts` (new, render layer) | Draw wires; signature-gated `refresh()` per the per-frame redraw discipline. |
| `src/inspector-ui.ts` | Conduit inspector panel (attached buildings, wire count). |
| `SPEC.md` | New sub-section under §4.5 (cluster-conduit rule + "only cross-island carrier of the cluster bonus" distinction vs §13.3); §8 catalog entries; §15.7/tier-table rows. |
| `AGENTS.md` | Note the new render-layer file(s) if the pure/render file counts are referenced. |

## 5. Verification

- `npx vitest run src/adjacency.test.ts` — new cases:
  - same-island wire unions two distant same-category buildings into one cluster (bonus rises);
  - different categories attached to the same wired network do **not** bridge;
  - transitive A–B–C: a building on A clusters with one on C;
  - cross-island injection: a remote attached building contributes to `K`;
  - legality: a same-island Cluster Conduit cannot form a cross-island wire; cross-island wire requires Lattice Conduits at both ends.
- `npx vitest run src/persistence.test.ts` — v31 fixture migrates to v32 with empty `conduitLinks`; v32 round-trips identity.
- `cd server && npx tsc --noEmit` and root `npm run build` — clean under strict.
- Server-sim oracle (`server/bench/catchup-bench.mts`) — a save **without** conduit links must keep its SHA-256 oracle digest byte-identical (the feature is additive and inert when `conduitLinks` is empty).

## 6. Risks

| Risk | Sev | Mitigation |
|---|---|---|
| Full-strength cross-island clustering snowballs late game | MED | Accepted as intended endgame power; Lattice Conduit cost + T5 gate are the throttle (per design decision). Tunable via `CATEGORY_ADJACENCY_RATE` + conduit cost. |
| Cross-island injection breaks per-island memo / catch-up perf | MED | Include conduit links + remote attached set in the derivations signature so the memo invalidates correctly; verify with the bench oracle (inert when no links). |
| Cluster computation cost grows (union-find is O(N²)) | LOW | Conduit unions add O(wires + attached) edges, not new pairwise scans; the existing O(N²) physical scan is unchanged. Per-tick memo already amortizes. |
| Dangling links after a conduit is demolished | LOW | Demolish/relocate prunes any `conduitLinks` referencing that building ID (same lifecycle hook routes use). |

## 7. Out of scope

- **Attenuation / per-conduit capacity caps** — considered and rejected; full strength per design decision.
- **Per-wire or per-conduit upkeep (power draw)** — considered and rejected; upfront build cost only.
- **Radius-based attachment** — rejected in favour of 4-adjacency (reuses existing test, no new range concept).
- **Carrying gating adjacency (heat/cooling/wastewater) over conduits** — out of scope; conduits carry the §4.5 **cluster bonus** only. Cross-island gating remains the §13.3 Lattice Node's job.
