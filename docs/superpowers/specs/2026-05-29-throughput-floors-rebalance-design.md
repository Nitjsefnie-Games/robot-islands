# Extraction / Speed (cycleSec) rebalance + Floor-upgrade system — design spec

**Date:** 2026-05-29. **Status:** design locked (user-approved); → writing-plans (phased).
**Companion data (canonical source):** `2026-05-29-throughput-density-table.md` — the full
sourced areal-density table, building→archetype map, fantasy anchoring, and anomalies. The
cycleSec generator reads that table; the densities below are a summary of it.
**Relation to prior passes:** follows the SI mass-balance rework (recipes are kg-balanced)
and the energy SI rebalance (power in kW). This pass grounds *time* (production rates).

## Goal

Recompute **every recipe's `cycleSec`** (all 249) and normalize **extraction amounts**
from real-world 24/7 throughput, area-normalized to our 1 m²/tile buildings; and add a
universal **floor-upgrade** mechanic so the player scales throughput/power/capacity per
tile through play. Today's cycleSec (2 s … 28800 s, median 120 s) and extraction rates
(e.g. `mine_on_coal` 9/10 s vs most mines 1/20 s) are ad-hoc; this makes them physics-grounded.

## Core formula

```
throughput_kg_per_s   = areal_density[kg·s⁻¹·m⁻²] × footprint_m² × M × floorMul × skillMul
cycleSec(base)        = output_kg_per_cycle / (areal_density × footprint_m² × M)
output_kg_per_cycle   = Σ(output_units × RESOURCE_META.massPerUnitKg)   // total mass, all outputs
```

- **footprint_m²:** 1 tile = 1×1 m. single=1, 2×2=4, 2×3/3×2=6, 3×3=9, 4×4=16.
- **M (global pace multiplier) = 1.4535×10⁻³**, fixed by anchoring a 1-floor Mine to 20 s:
  `M = 1 / (density_mine 8.6 × footprint 4 × 20)`. Single global constant; no per-recipe tuning.
- **No power-law / no compression.** The real ~6-order density spread is intended; the
  dynamic range that makes it playable comes from floors (≤×10) × all-skills speed (×10,
  already in `skilltree.ts` via multiplicative `recipeRateMul` + extractor yield bonuses) ×
  building count, plus offline catch-up (`advanceIsland`). Base rate = naive 1-floor/no-skill/1-building.
- **Multi-output recipes:** `cycleSec` is set from **total output mass** per cycle; the
  per-output rates then fall out of the recipe's existing output ratios.

### Resulting base ladder (illustrative, M = mine 20 s; ×100 = max floors×all-skills)

| recipe | base (1 floor, no skills) | maxed ×100 |
|---|---|---|
| Mine | 20 s | 0.2 s |
| Quarry | ~40 s | 0.4 s |
| Logger | ~23 min | ~14 s |
| Smelter (iron) | ~50 min | ~30 s |
| Glassworks | ~6 h | ~3.7 min |
| Lithography (microchip) | ~14 d | ~3.3 h |
| Quantum chip | ~25 d | ~6 h |

(…then ÷ building count, plus offline catch-up. The long base tail is by design.)

## Areal density table (real, 24/7 nameplate, production-unit footprint)

Summary of the canonical companion `2026-05-29-throughput-density-table.md` (full sources,
building→archetype map, fantasy anchoring, and anomalies are there). kg·s⁻¹·m⁻²:

| archetype | density | example basis |
|---|---|---|
| Water / fluid pump | ~42 | centrifugal pump skid |
| Hard-rock mining / ore loading | 8.6 | PC9000 excavator 8000 t/h ÷ 259 m² |
| Surface quarrying (stone/clay/sand/limestone) | ~4.3 | excavator × 0.5 bulk factor |
| Crude refining (atm. distillation) | 2.8 | CDU 200 kbbl/d ÷ 113 m² |
| BOF steel | 2.1 | 250 t/40 min ÷ 50 m² |
| Air separation / cryo | 3.9 | ASU 3000 t O₂/d ÷ 9 m² |
| EAF steel | 1.3 | 300 t/60 min ÷ 64 m² |
| Blast furnace (pig iron) | 0.75 | 10000 t/d ÷ 154 m² |
| Logging / timber | 0.49 | feller-buncher 60 m³/h ÷ 24 m² |
| Polymers / plastics / lubricant | 0.48 | gas-phase PE 300 kt/yr ÷ 20 m² |
| Oil/gas wellhead | 0.40 | 1000 bbl/d ÷ 4 m² |
| Acids (sulfuric/HCl) | 0.22 | 547 t/d ÷ 28 m² |
| Cement kiln | 0.19 | 10000 t/d ÷ 600 m² |
| Non-ferrous smelter (Cu/Pb/Zn/Sn/Ni) | 0.062 | flash furnace 500 kt/yr ÷ 257 m² |
| Lime kiln | 0.036 | 1000 t/d ÷ 320 m² |
| Electrolysis (chlor-alkali/H₂) | ~0.03 (est) | ~40 kt Cl₂/yr ÷ ~40 m² |
| Brick/ceramic kiln | 0.016 | tunnel kiln 600 t/d ÷ 432 m² |
| Assembly line (station basis) | ~0.6 (station) / 0.012 (line) | auto final assy |
| Coke/charcoal oven | 0.008 | 30 t/20 h ÷ 52 m² |
| Glass furnace | 0.0077 | float tank 1000 t/d ÷ 1500 m² |
| Battery cell production | 0.0032 | 10 GWh line ÷ 150 m² |
| Machining (bolt/gear/component) | ~0.002 | CNC hobber ÷ 4 m² |
| PCB fab | ~7×10⁻⁴ | etch/plate line |
| Aluminum (Hall-Héroult) | 1.4×10⁻⁴ | 1 t/d pot ÷ 80 m² (Faraday-limited) |
| Wafer fab / lithography | 6.4×10⁻⁵ | gigafab ÷ 30 m² scanner |
| **Fantasy/endgame** | tier-anchored | wafer-fab floor × tier band (T4 ×1, T5 ×0.1, T6 ×0.01); extraction-flavored (casimir, pyroforge, zero-point) anchored to nearest real archetype × 0.01–0.3 |

Building→archetype mapping (all ~80 buildings) is in the density research report; it becomes
a `RECIPE_ARCHETYPE` / `density` lookup in the generator.

## Extraction normalization
Kill ad-hoc outliers (`mine_on_coal` 9/10 s, `heavy_logger` 9/10 s, `deep_mine` 3/20 s).
Normalize each extractor to a consistent output unit, with the rate expressed purely via
`cycleSec` from `density × footprint × M`. Tile-variant recipes (`mine_on_ore`/`mine_on_coal`)
use the same mining density; differing only by output resource mass.

## Floor-upgrade mechanic (final phase) — universal

Per-building integer floor level **L ∈ [0,9]** (1–10 floors; cap 10).

| aspect | rule |
|---|---|
| Effect (throughput / power **output** / storage capacity / pad slots) | **× (1 + L)** → up to ×10 |
| Consumer power **draw** | **× (1 + 0.5·L)** → up to ×5.5 (×10 output for ×5.5 power) |
| Material cost of the L-th upgrade | **0.8 × base placementCost** (build on top) |
| Build time of the L-th upgrade | **base construction time × (L + 1)** (9th floor = ×10 time) |
| Applies to | **every** building — producers, consumers, generators, drone pads, storage, etc. |
| Skill interaction | multiplicative with existing `recipeRateMul`/yield skills (×10 all-in) |

Touches: persistence (schema bump — per-building `floorLevel`), `economy.ts` (scale
throughput + power by L), placement/construction (upgrade cost + progressive time),
`building-defs`/storage (capacity × (1+L)), power output (generators × (1+L)), and UI
(per-building upgrade control showing cost/time/next-floor effect).

## Phasing (each phase = own plan + subagent-driven impl, tests green per phase)

1. **Phase 1 — Density→cycleSec generator + extraction & core chain.** Build the
   reproducible generator (`density × footprint × M` → cycleSec; reads recipe outputs +
   `RESOURCE_META` + footprints + archetype/density map). Apply to extraction (42) + smelting
   (21) + the T1–T2 core chain; normalize extraction amounts. Throughput-sanity tests; fix
   broken cycleSec fixtures.
2. **Phase 2 — Remaining recipe cycleSec.** Chemistry, manufacturing, electronics, power-fuel,
   and fantasy/endgame (tier-anchored). Complete all 249; suite green.
3. **Phase 3 (final) — Floor-upgrade system.** The mechanic above: persistence schema bump,
   economy throughput/power scaling, placement upgrade cost, progressive build time, capacity/
   output scaling, UI, skill multiplicativity. Tests + in-browser verify.

## Verification
- cycleSec values are generator-reproducible from the formula (a test re-derives a sample).
- No recipe outside its intended band; multi-output recipes balance to total-mass throughput.
- Floor mechanic: ×(1+L) effect, ×(1+0.5L) power, 0.8× cost/level, ×(L+1) time, cap 10;
  persistence round-trips `floorLevel`; UI upgrade path works; skills stack multiplicatively.
- `npm test` green + `tsc` clean + `npm run build` per phase; browser screenshot of a built+
  upgraded building and the cycleSec feel.

## Risks / open
- **M re-tune:** single knob; if early pace feels off, re-anchor (regenerate — cheap).
- **Fantasy anchoring** is abstracted (no real basis) — tier-band densities; revisit if endgame feel is off.
- **Large fixture churn:** many tests assert specific cycleSec/rates (as the energy pass saw) — expect broad fixture updates; never change economy logic to pass a test.
- **Supersedes the deferred coal EROI retune:** mine + coal rates are now physics-derived;
  verify the resulting EROI is sane (it's now grounded, not ad-hoc).
- **Tutorial interaction:** the paused tutorial chain cites recipe *stoichiometry* (unaffected)
  but its pacing/"scale power" hints may shift; reconcile on tutorial resume.
