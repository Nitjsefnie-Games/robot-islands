# Demolition Yard — design spec

**Date:** 2026-06-21
**Status:** approved, ready for implementation plan
**Spec sections touched:** §6.7 (byproducts + demolition), §8 (building catalog)

## Problem / motivation

Scrap today has exactly one source: demolishing a completed building (~30% of
`placementCost` as Scrap + 50% in-kind material refund, §6.7). It is a one-shot,
manual, finite faucet. The bootstrap build **planner** (`scripts/bootstrap_planner_v3.py`)
models a *synthetic* `{building}_scrapper` that turns the tedious manual
place-then-demolish loop into a continuous scrap faucet, but no such building
exists in the actual game.

This adds that building to the game: a placeable **Demolition Yard** that
continuously produces Scrap by running the *net economics* of one
place-then-demolish cycle of a player-selected target building type.

## Decisions (from brainstorming)

1. **Input model:** literal demolish automation (not "consume cheap raws").
2. **Literalness:** *net-recipe* model — derive a single recipe from the target's
   cost; do **not** instantiate real building instances, tiles, or build slots.
3. **Target scope:** any building the island can currently place (tier / biome /
   access gates respected at selection time) whose cost basket yields ≥1 scrap.
4. **Name:** Demolition Yard.

## Economics (the core)

The player selects a **target building type** for each Demolition Yard instance.
The Yard's recipe is **derived** from that target def's base (floor-0)
`placementCost`, reusing the **canonical §6.7 formulas already in
`src/placement.ts`** so the Yard and manual demolish can never drift:

- **Output:** `scrap = floor(0.3 · Σ placementCost)` — identical to
  `demolishBuilding`'s `scrapReturned` (`Math.floor(costSum * 0.3)`).
- **Inputs:** for each cost resource with count `n`, consume `n − floor(n/2)`
  (full place cost minus the 50% demolish refund `floor(totalInvestedCost/2)`).
  Only resources whose net `n − floor(n/2) > 0` are listed.
- **Cycle:** the target tier's base construction time,
  `BASE_CONSTRUCTION_MS_BY_TIER[targetDef.tier] / 1000` seconds
  (`src/construction.ts`).

This equals one place+demolish cycle value-for-value and matches the planner's
scrapper formula exactly:

```py
# scripts/bootstrap_planner_v3.py, lines 491-504
_scrap_out = floor(0.3 * sum(_cost.values()))
_consumed  = {r: n - (n // 2) for r, n in _cost.items() if n - (n // 2) > 0}
_cycle     = BASE_CONSTRUCTION_S_BY_TIER[_tier] / PARALLEL_BUILD_SLOTS  # slots = 1
```

**Worked example.** Target = T1 Mine (`30 stone + 15 wood`, tier-1 construction
30 s): inputs `15 stone + 8 wood`, output `13 scrap`, cycle 30 s → 0.43 scrap/s.
A high-tier target has a long construction time → deliberately slow; the
construction time is the honest rate limiter.

**Idle when unconfigured.** If no `scrapTarget` is selected, the Yard has no
recipe and is idle — exactly like an unlabeled generic-storage Crate.

## Data model & code layout (one responsibility per file)

- **`PlacedBuilding.scrapTarget?: BuildingDefId`** — new optional per-instance
  field in `src/buildings.ts`, mirroring the existing `cargoLabel` precedent
  (per-instance config, undefined = unconfigured, forward-compatible).
- **New pure module `src/demolition-yard.ts`** exporting
  `scrapRecipeForTarget(targetDef: BuildingDef): Recipe | undefined`. Builds the
  derived `Recipe` from `targetDef.placementCost`, importing the canonical
  scrap-recovery + refund formulas/constants from `src/placement.ts` (extract a
  shared §6.7 helper if needed so the magic constants live in one place).
  Returns `undefined` for a basket that mints 0 scrap.
- **`resolveRecipe` branch** (`src/recipes.ts`): when `def.id === 'demolition_yard'`,
  return `b.scrapTarget ? scrapRecipeForTarget(BUILDING_DEFS[b.scrapTarget]) : undefined`.
  Runtime resolution is **permissive** — it resolves from the target def
  regardless of current gates; the tier/biome/access eligibility check lives only
  in the picker at selection time.
- **New def `demolition_yard`** in `src/building-defs.ts`: literal in the
  `BuildingDefId` union + a `BUILDING_DEFS` entry. No biome requirement.

## Server / mutation gateway

This game is server-authoritative; setting a per-instance config field is a
mutation that must flow through the gateway.

- **New intent `set-scrap-target`** in `server/src/game/intents.ts`, modeled
  directly on the existing `relabel-cargo` intent (lines ~725-748): validate
  `islandId`, that the building exists and is a `demolition_yard`, and that the
  supplied target is a valid, eligible `BuildingDefId`; then set
  `building.scrapTarget`.

## Persistence

- **No schema bump.** Planning confirmed the building (de)serializer is a
  structural spread (`{ ...b }` / `...rest`, `persistence.ts:582`/`:1189`), which
  carries any optional field automatically — exactly as `cargoLabel` / `paused` /
  `placedAt` are carried. `scrapTarget` is therefore a purely additive,
  forward/backward-compatible optional field that needs no migration. (Revises the
  initial "bump 31 → 32" idea.) A round-trip test guards it; a no-op
  `migrateV31toV32` can be added later if review prefers the explicit bump.

## UI

Inspector affordance to choose the target, reusing the `cargoLabel` relabel
pattern: a dropdown of eligible building types (cost basket yields ≥1 scrap and
currently placeable on this island). Show the resulting scrap-per-cycle so the
choice is legible. Dispatches the `set-scrap-target` intent.

## Balance values (tunable)

- Name **Demolition Yard**, `category: 'special'`, **tier 1** (available early —
  bootstrap scrap is its purpose), no biome requirement.
- `placementCost: { stone: 100, wood: 60, iron_ingot: 20 }`, standard 2×2
  footprint, **power −20 kW**.

Scrap is the Yard's sole output and is a *consumed* resource (steel chain), so it
**throttles to demand** (not force-run) — it will not burn materials when the
scrap bin is full.

## Testing

- `scrapRecipeForTarget`: matches the planner formula for several sample targets
  (Mine, Smelter, a T2 building); returns `undefined` for a zero-scrap basket.
- `resolveRecipe`: `undefined` when `scrapTarget` unset; the derived recipe when
  set.
- Economy integration: scrap accrues at the expected rate, inputs are consumed,
  output throttles to scrap demand.
- Persistence: v31 fixture loads clean into v32; v32 round-trips identity;
  `scrapTarget` survives save/load.

## SPEC.md updates

- **§6.7** — document the Demolition Yard as a continuous scrap faucet whose
  recipe is derived from the target's `placementCost` via the same 30% scrap /
  50% refund formulas as manual demolish.
- **§8 catalog** — add the Demolition Yard entry (special category, T1).

## Out of scope (YAGNI)

- Fully literal building instantiation (tiles / build slots / construction queue).
- Multi-target or weighted-target Yards (one target type per instance).
- Any change to the manual demolish action or existing scrap consumers.
