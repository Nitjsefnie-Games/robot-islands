# Action-cost SI rescale — terrain modifier · land reclamation · platform constructor

**Date:** 2026-06-01
**Branch:** `feat/action-cost-rescale`
**Status:** Approved (brainstorming), pending implementation plan

## Problem

The SI-units rework (Phase 4) rescaled one-time **placement BOMs** but left three
buildings' **per-operation (action) costs** as pre-SI placeholders — flagged as a
deferred follow-up in `docs/superpowers/specs/2026-05-29-tutorial-consolidation-findings.md:151-155`
("Action costs not SI-rescaled: `terrain_modifier`, `land_reclamation_hub`,
`platform_constructor`"). Concretely:

1. **Terrain Modifier — rare-target cost is a stub, and the charge is never deducted.**
   `terrain-modifier.ts` computes a rare-vein shot cost as
   `K(1.5) × naturalExtractionRate × PAYBACK_HORIZON_CYCLES(90)` per tile × 16, but
   `naturalExtractionRate` is hard-coded to **1** (terrain-modifier.ts:129-130), so
   *every* rare vein costs a flat **2160 units** of its own resource regardless of
   how fast that resource extracts. Worse, the computed shot cost is shown in the
   target picker but **never deducted** — `placeBuilding`/the shot-fire path does
   not charge it, so terrain shots are effectively free beyond the placement cost.
2. **Land Reclamation Hub — `5 × r²` stone placeholder.** `landReclamationCost`
   (`land-reclamation.ts:56`) charges `stone = 5 × currentRadius²` per +1 radius —
   a stone-only pre-SI placeholder; §3.4's tables are marked "(placeholders)."
3. **Platform Constructor — `steel ×5/tile` (pre-SI).** `computeConstructionCost`
   (`artificial-island.ts:36`) charges `ceil(tileCount × {steel:5, iron_ingot:3,
   wood:10} × surcharge)` — uses `steel` rather than the SI structural material
   `steel_beam`, and was never rescaled to the SI mass economy.

## Goal

Rescale all three action costs onto coherent SI footings, and wire the
terrain-modifier charge so it is actually deducted.

## Decisions (locked in brainstorming)

| Question | Decision |
|---|---|
| Rare-target cost basis | **30 days of base-time extraction** of the target resource |
| 30-day basis granularity | **Per shot** (the whole 16-tile conversion), not per tile |
| Rare multiplier `K` | **1** (cost = exactly 30 days; "should be enough") |
| Terrain-mod charge | **Wire it** at the shot-fire point for ALL targets (natural + rare) |
| Natural-clear numbers | **Unchanged** (kept as-is; now actually charged) |
| Land-creation cost model | **Unified per-land-tile structural basket** for reclamation + platform |
| Platform vs resource shot | Platform (hundreds of tiles) naturally ≫ a 16-tile resource shot |

## 1. Terrain Modifier — rare-target cost (30-day rule)

Replace the stubbed rare formula in `terrain-modifier.ts` with:

```
rareShotCost(target) = ceil( baseRatePerSec(target) × DAYS × SECONDS_PER_DAY )
  DAYS            = 30
  SECONDS_PER_DAY = 86400          // ⇒ 30 days = 2_592_000 s
  baseRatePerSec(target) = extractorOutputQty(target) / extractorCycleSec(target)
```

- The cost is a **flat per-shot basket** of the target's resource (charged once for
  the 16-tile conversion), NOT a per-tile×16 amount.
- `baseRatePerSec` reads the **base** extractor for the target terrain — the
  canonical floor-0 / no-skill extraction recipe whose output terrain is that
  resource (the recipes the lookup enumerated, e.g. `copper_mine` cycleSec 20 →
  copper_ore; `uranium_mine` 3440; `drilling_rig` 1.5 → helium_3). Output qty is
  read from the recipe (1/cycle for the current extractors, but compute it
  generally as `outputQty / cycleSec` so a >1-output extractor scales correctly).
- `K` is **1** — the cost equals exactly 30 days of base output. The
  `K_RARE_MULT`, `PAYBACK_HORIZON_CYCLES`, and the `naturalExtractionRate = 1`
  stub are removed/replaced by `DAYS`/`SECONDS_PER_DAY` + the real base-rate lookup.

Worked values (per shot): copper (cycleSec 20) → **129,600**; diamond (40) →
64,800; tin/lead/tungsten/etc. (20) → 129,600; uranium/lithium (3440) → **≈753**;
helium-3 (1.5) → **1,728,000**.

**Implication (intended):** slow-extracting resources are cheap to manufacture
(you recover them slowly); fast/precious ones are expensive. The anti-cheese
holds — you can't manufacture a resource you've never discovered, because you
must pay it in its own units.

## 2. Terrain Modifier — wire the shot charge

The shot cost (natural **and** rare) is currently computed and displayed in the
target picker but never deducted. Wire the deduction at the single shot-fire point
(`main.ts` `onTerrainShotFire` / the `terrain_modifier` placement-commit path):

- Compute `conversionCostForTarget(target)` (natural = existing per-tile basket × 16,
  unchanged numbers; rare = §1 formula).
- **Affordability-gate the shot**: if the founder island's inventory can't cover
  the basket, the shot does not fire (no conversion, no self-destruct, surface a
  rejection — mirror the placement affordability pattern).
- On a successful shot: deduct the basket, apply the conversion, self-destruct the
  modifier (existing behaviour).

Natural-clear baskets keep their current numbers (grass 3200 stone + 1600 gear,
stone 8000, tree 8000 wood, etc.) — they were not flagged for re-tuning; wiring
just makes the picker's displayed cost honest.

## 3. Unified per-land-tile structural basket

A single shared constant, **`LAND_TILE_COST`** — placeholder
**`{ steel_beam: 1, concrete: 10 }` per land tile (tunable)** — lives in a shared
module (`building-defs.ts` or a small constants file) so reclamation and platform
read one definition.

### 3a. Land Reclamation Hub — bill the exact tile delta

`landReclamationCost` becomes: cost = `tileDelta × LAND_TILE_COST`, where
`tileDelta` = (count of inscribed tiles at the *new* major/minor radii) − (count at
the *current* radii). The inscribed-tile count uses the existing ellipse geometry
(`computeIslandTiles` / `tileInscribedInEllipse`), so cost tracks land actually
gained on that axis. Replaces `stone = 5 × r²`.

- The function needs the axis being expanded (major or minor) and current radii to
  compute the delta — `expandIsland` already knows both.
- Caps unchanged (`BIOME_MAX_RADII`, `world.ts:87`).
- (A Plains circle r=14→15 adds ≈ 88 tiles → ≈ 88 steel_beam + 880 concrete.)

### 3b. Platform Constructor — same basket, `steel` → `steel_beam`

`computeConstructionCost` becomes: cost = `ceil(tileCount × LAND_TILE_COST × surcharge)`,
`tileCount ≈ π × major × minor`, Volcanic/Arctic surcharge **×1.5** unchanged.
Replaces the `STEEL_PER_TILE=5 / IRON_INGOT_PER_TILE=3 / WOOD_PER_TILE=10` per-tile
multipliers (the `steel` → `steel_beam` switch the deferred note called for).

- A Plains island (tileCount ≈ π·14·14 ≈ 615) costs ≈ 615 steel_beam + 6150
  concrete — far more than any 16-tile resource shot, so "platform takes more"
  holds structurally without a special rule.

## 4. Base-rate lookup

Both the rare-cost formula and any display need `baseRatePerSec(targetTerrain)`.
Provide a pure helper that, given a rare target terrain, resolves its canonical
base extractor recipe and returns `outputQty / cycleSec`. Source of truth is the
extraction recipes in `recipes.ts` (those with `exogenousFlow: 'terrain'`); the
target→resource mapping already exists in `terrain-modifier.ts:98-122`. The helper
is pure and unit-testable.

## 5. Scope / non-goals

- **No new mechanics** — only cost formulas + wiring the existing (already-built)
  terrain-modifier charge.
- **No persistence migration** — all changes are cost computation; no serialized
  shape changes.
- Natural-target clearing numbers are **not** re-tuned (only charged).
- Per-land-tile `LAND_TILE_COST` magnitude and the basket composition are
  placeholders open to tuning; the *formulas* (30-day rule, tile-delta × basket,
  tileCount × basket) are the locked decisions.

## 6. Files touched

- `src/terrain-modifier.ts` — rare-cost formula (30-day) + base-rate lookup;
  drop the `K`/`PAYBACK_HORIZON`/`naturalExtractionRate=1` stub.
- shot-fire path (`src/main.ts` `onTerrainShotFire` + the `terrain_modifier`
  placement-commit in `placement.ts`/`placement-ui.ts`) — wire deduction +
  affordability gate.
- `src/land-reclamation.ts` — `landReclamationCost` → `tileDelta × LAND_TILE_COST`.
- `src/artificial-island.ts` — `computeConstructionCost` → `tileCount × LAND_TILE_COST`
  (steel_beam), keep surcharge.
- shared constant module — `LAND_TILE_COST`.
- `SPEC.md` — §3.4 (reclamation cost), §8.9 (terrain modifier action), §2.5
  (artificial-island cost); clear the "(placeholders)" tags.

## 7. Testing

Pure-layer (no PixiJS/DOM):

- `terrain-modifier.ts`: `rareShotCost` for several targets (copper 129,600;
  uranium ≈753; helium-3 1,728,000) from the real cycleSec; natural-target baskets
  unchanged; the base-rate lookup resolves each rare target → its extractor rate.
- shot charge: a fired shot deducts the basket and is rejected (no conversion, no
  self-destruct) when unaffordable; an affordable shot deducts + converts +
  self-destructs.
- `land-reclamation.ts`: `landReclamationCost` returns `tileDelta × LAND_TILE_COST`
  for a known radius step (assert the inscribed-tile delta and the resulting
  basket); cap still enforced.
- `artificial-island.ts`: `computeConstructionCost` returns
  `ceil(tileCount × LAND_TILE_COST × surcharge)` with `steel_beam` (not `steel`),
  surcharge applied on Volcanic/Arctic.
- Full suite stays green; no schema migration.
