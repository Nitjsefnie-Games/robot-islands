# Throughput rebalance — real areal-density data (companion to the cycleSec spec)

**Companion to:** `2026-05-29-throughput-floors-rebalance-design.md`.
This is the **canonical data source** for the cycleSec generator:
`cycleSec = output_kg / (areal_density × footprint_m² × M)`, M = 1.4535×10⁻³.
All densities are **24/7 nameplate** (no human capacity factor) over the **production-unit
footprint** (the furnace/reactor/machine, not the whole site). Unit: **kg·s⁻¹·m⁻²**.
`RESOURCE_META.massPerUnitKg ≈ 1` for nearly all resources, so output units ≈ kg.

## Per-archetype density table (sourced)

| # | Archetype | Example real unit | 24/7 throughput (kg/s) | Unit footprint (m²) | density (kg·s⁻¹·m⁻²) | throughput source | footprint source |
|---|---|---|---|---|---|---|---|
| 1 | Hard-rock mining / ore loading | Komatsu PC9000-12 excavator, 8000 t/h | 2222 | 259 | **8.6** | ivtinternational.com (PC9000 launch) | same |
| 2 | Water / fluid pumping | industrial centrifugal pump, 150 m³/h | 41.7 | ~1 | **~42** | UNICEF/Berkeley pump curves | Pentair |
| 3 | Logging / timber | feller-buncher, 60 m³/h × ~700 kg/m³ | 11.7 | 24 | **0.49** | USFS / Wood Business | Wikipedia: feller buncher |
| 4 | Oil / gas wellhead | ~1000 bbl/d ≈ 137 t/d | 1.59 | ~4 | **0.40** | EIA wells | Wikipedia: Christmas tree |
| 5 | Surface quarrying (stone/clay/sand/limestone) | excavator class × ~0.5 bulk | ~1100 | 259 | **~4.3** | ivtinternational.com | same |
| 6 | Deep drilling (uranium/helium/mercury) | drilling-rig class, low mass | ~0.5 | ~9 | **~0.05** | EIA wells | est. |
| 7 | Blast furnace (pig iron) | 10000 t HM/day, 14 m hearth | 115.7 | 154 | **0.75** | Wikipedia/ScienceDirect | ScienceDirect hearth dia |
| 8 | BOF steel | 250 t / 40-min heat, 8 m vessel | 104 | 50 | **2.1** | Wikipedia BOS | SubsTech BOF |
| 9 | EAF steel | 300 t / 60-min tap, 9 m shell | 83 | 64 | **1.3** | IspatGuru EAF | Britannica EAF |
| 10 | Non-ferrous smelter (Cu/Pb/Zn/Sn/Ni) | Outokumpu flash, 500 kt Cu/yr | 15.85 | 257 | **0.062** | Metso 500 ktpa | flash settler dims (ResearchGate) |
| 11 | Aluminum (Hall-Héroult) ⚠ | reduction pot, 1 t Al/day, 20×4 m | 0.0116 | 80 | **1.4×10⁻⁴** | StudyGuides Hall-Héroult | Springer/ScienceDirect cell |
| 12 | Cement kiln (clinker) | rotary 6×100 m, 10000 t/day | 115.7 | 600 | **0.19** | Wikipedia cement kiln | same |
| 13 | Lime kiln | rotary 4×80 m, 1000 t/day | 11.6 | 320 | **0.036** | AGICO | Wikipedia lime kiln |
| 14 | Brick / ceramic kiln | tunnel 120×3.6 m, 600 t/d | 6.9 | 432 | **0.016** | brickplantmachine | wd-brickmachine |
| 15 | Coke / charcoal oven | by-product, ~30 t/20 h, 14×3.7 m | 0.42 | 52 | **0.008** | IspatGuru coke | ScienceDirect coke oven |
| 16 | Glass furnace | float 60×25 m, 1000 t/day | 11.6 | 1500 | **0.0077** | HORN/glassglobal | ResearchGate float size |
| 17 | Crude refining (atm. distillation) | CDU 200 kbbl/d, 12 m column | 315 | 113 | **2.8** | McKinsey Energy Insights | Wikipedia atm. distillation |
| 18 | Air separation / cryo | 3000 t O₂/day, 3×3 m cold box | 34.7 | 9 | **3.9** | ScienceDirect ASU | Cheresources ASU dims |
| 19 | Electrolysis (chlor-alkali / H₂) ⚠est | ~40 kt Cl₂/yr, ~40 m² stack | 1.27 | ~40 | **~0.03** | tk nucera (element 2.85 m²) | derived (flagged) |
| 20 | Acids (sulfuric / HCl) | contact plant 547 t/day, 6 m converter | 6.33 | 28 | **0.22** | manufacturingplantindia | Wikipedia contact process |
| 21 | Polymers / plastics / lubricant | gas-phase PE 300 kt/yr, 5 m vessel | 9.5 | 20 | **0.48** | olivepipe / academia | HAL gas-phase PE |
| 22 | Rolling / wire / pipe / sheet mill | hot strip mill 250 t/h | 69.4 | 140 (train) / 10 (stand) | **~0.5** (train) / ~7 (stand) | IspatGuru hot strip | Britannica hot strip |
| 23 | Machining (bolt/gear/component) | CNC gear hobber ~30 kg/h, 2×2 m | 0.0083 | 4 | **~0.002** | zhygear | Artizono hobbing |
| 24 | Assembly line | auto final 60 veh/h × 1500 kg | 25 | 2100 (line) / 42 (station) | **0.012** (line) / ~0.6 (station) | ASSEMBLY mag | MIT engine plants |
| 25 | Battery cell production | 10 GWh line, coater 1.5×100 m | 0.48 | 150 | **0.0032** | PEM RWTH | coatingedge / CATL |
| 26 | Semiconductor wafer fab / lithography | gigafab 100k wafers/mo, scanner+track ~30 m² | 0.0019 | 30 | **6.4×10⁻⁵** | construction-physics | Wikipedia fab list |
| 27 | PCB fabrication | conveyorized etch/plate line | ~0.02 | ~30 | **~7×10⁻⁴** | fastturnpcbs | etchmachinery DES |

⚠ = boundary judgment call (see anomalies). est = footprint derived, not directly sourced.
Density spread ~6 orders: water (~42), ore (8.6) at top; aluminum (1.4×10⁻⁴), wafer (6.4×10⁻⁵) at floor.

## Building → archetype map (all ~80 buildings)

- **Extraction:** Mine, Deep Mine, Quartz Mine, Copper/Tin/Lead/Bauxite/Manganese/Zinc/Chromium/Nickel/Tungsten/Sulfur/Phosphate/Graphite Mine, Diamond Quarry → **#1** (metallic) / **#5** (non-metallic). Limestone Quarry, Sand Pit, Clay Pit → **#5**. Uranium Mine, Mercury Well, Lithium Extractor, Drilling Rig → **#6**. Pump Jack, Gas Extractor → **#4**. Well, Coastal Pump, Seawater Intake Rig, Open-Water Extractor, Nodule Harvester, Trench Drill, Vent Tap → **#2**. Logger, Heavy Logger → **#3**.
- **Smelting:** Smelter, Blast Furnace → **#7**. Steel Mill, Steel Mill (Scrap), Oxygen Converter → **#8**. Electric Arc Furnace → **#9**. Copper/Tin/Lead/Zinc/Chromium/Nickel/Tungsten/Manganese Smelter, Silicon Crusher, Slag Reprocessor, Solder/Bronze/Brass/Magnetic Alloyer, Mag Forge → **#10**. Aluminum Smelter → **#11**. Coke Oven → **#15**.
- **Kilns:** Limekiln → **#13**. Lime Slaker, Cement Mill, Concrete Plant, Mortar Mixer → **#12**. Brick Kiln, Ceramic Kiln, Optical Glass Kiln → **#14**. Charcoal Kiln → **#15**. Glassworks, Glass Panel Press → **#16**.
- **Chemistry:** Electrolyzer, Chlor-Alkali Plant → **#19**. Sulfuric Acid Plant, HCl Plant, Phosphor Plant, Chemical Reactor → **#20**. Air Separator, Cryo Air Separator, Cryo Lab, Cryo Compressor, Cryogenic Generator, Cryo Compound Lab → **#18**. Naphtha Cracker, Crude Oil Cracker, Diesel Refinery, Kerosene Refinery, Lubricant Refinery → **#17**. Plastic Polymerizer A, Rubber Synthesizer, Coolant Synthesizer → **#21**. Alumina Refinery → **#10**. Biofuel Plant → **#21**. Evaporator → **#13/#20**. Brine Distillation Rig, Nodule Concentrator, Vent Mineral Refinery, Heavy Water Distiller → **#18/#20**.
- **Manufacturing:** Workshop, Assembler, Kit Assembler ×3, Bearing Assembler, Spring Press, Motor/Pump/Hydraulic/Pneumatic Assembly, Generator Lab, Fuel Cell Lab, Fuel Rod Assembler, Plasma/Cryo Containment Assembler, Self-Replication Lab, Quantum Manipulator → **#24** (assembly) / **#23** (machining). Sheet Metal/Pipe/Beam/Cable/Metal Rolling/Carbon Steel/Stainless/Tool Steel Mill, Galvanizing Bath → **#22**. Rigid/Flexible Plastic Press → **#21**. Plank Mill, Lumber Mill → **#23** (finished) / #3 (cutting). Battery Factory → **#25**. Glass Fiber Spinner, Optical Fiber Drawer → **#22/#16**.
- **Electronics:** PCB Etcher → **#27**. Lithography Lab, Wafer Lab, Quantum Chip Fab, Processor Fab, Compute Module Fab → **#26**. Transistor/Capacitor/Resistor Doping, Memory Lab, Circuit Assembler, Solar Cell Lab, Singularity Sensor Lab, Accelerator Core Lab, Cryogenic Compute Center → **#26** / **#23–24**.
- **Power generators / storage / logistics / special / discovery** (no mass-production recipe): excluded from density assignment (power covered by the energy SI pass; storage capacity scales via the floor mechanic). If a power building has a material output recipe, anchor to its physical analog.

## Fantasy / endgame — NO REAL BASIS (anchored, tier-scaled)

Anchor to nearest real archetype; descend by tier (T4 ×1, T5 ×0.1, T6 ×0.01 of the wafer-fab floor 6.4×10⁻⁵), overridden upward where flavor is extraction/smelting.

| output / building | anchor | proposed density |
|---|---|---|
| quantum_chip (Quantum Chip Fab) | wafer #26 | ~2×10⁻⁵ (0.3×) |
| ai_core (Cryogenic Compute Center) | wafer + assy | ~6×10⁻⁶ (0.1×) |
| exotic_alloy (Pyroforge) | non-ferrous #10 | ~0.02 (0.3×) |
| carbon_fiber (Carbon Forge) | polymer #21 | ~0.05 (0.1×) |
| reality_anchor (Reality Forge, T5) | assembly #24 | ~1×10⁻³ (0.1×) |
| casimir_energy (Casimir Tap, T5) | ASU #18 | ~4×10⁻³ (extraction-flavored) |
| genesis_cell, ascendant_core (T6) | assembly #24 | ~1×10⁻⁴ (×0.01) |
| antimatter_propellant (T6) | ASU/cryo #18 | ~4×10⁻⁴ |
| satellite assemblies (scanner/relay/mirror/sweeper/OIP) | assembly #24 | ~4×10⁻³ (0.3×) |
| time_crystal, probability/causal/dimensional/tachyonic/aether/reality-engine labs, zero-point/neutronium extractor | wafer-fab floor, by tier | T4 ~1×10⁻⁴ · T5 ~1×10⁻⁵ · T6 ~1×10⁻⁶ |
| Skill Forge crystals | assembly #24 | ×0.01 per tier step |

## Anomalies / judgment calls

1. **Aluminum (1.4×10⁻⁴) is correct, not a bug** — Hall-Héroult is Faraday-rate-limited, so it sits in *electronics* territory; real smelters reach scale only by tiling hundreds of pots. **Do not "fix" it up to the other smelters.**
2. **Mine/quarry footprint = the working machine, not the pit.** Extraction bounded to the excavator/loader (259 m²), not the orebody/pit/tailings — the pit is the resource, not the production unit.
3. **Water pump (~42) is a real outlier** (water is dense, pump skid tiny) → in-game water/saltwater intake should be the fastest per-tile producer.
4. **Rolling mill — two boundaries:** single stand ~7, full train ~0.5; use the **train (~0.5)** for a "mill" building.
5. **Assembly — line (0.012) vs station (~0.6):** compact buildings map to **station basis**; large multi-tile factories to line basis.
6. **Chlor-alkali (0.03) is derived/flagged** — sources give whole-plant (wrong boundary) or single 2.85 m² element; reconstructed a ~40 m² stack. Order-of-magnitude only.
7. **Coke-oven footprint generous** (14×3.7 m per-oven incl. heating walls/ram access); chamber-only would raise density ~8×.
8. **Logger wood density** standardized at green ~700 kg/m³ (range 700–1000).
9. **Multi-output recipes** (blast furnace → iron+slag+co; cracker → multiple cuts): density is **total mass throughput** of the unit; `cycleSec` from total output mass per cycle, split across outputs by recipe ratios.
10. **Power/storage/special** buildings mostly have no mass-production recipe; excluded.
11. **Alloyers (solder/bronze/brass/mag alloyer, mag forge) are classified as non-ferrous smelter (#10)** because alloying is physically a melt-and-mix operation, not assembly or machining.
