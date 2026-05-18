# Ocean Layer — Design

**Status:** approved spec, ready for implementation plan
**Date:** 2026-05-18
**Author:** brainstorming with project owner (this session)

A new gameplay layer that turns the previously-decorative ocean between islands into a real placement surface for T2+ extraction infrastructure pulling T5/T6 exotic inputs (deuterium, helium-3, rare-earth nodules, hydrothermal vent minerals) into the existing land chains.

---

## Locked decisions (quick reference)

| # | Decision | Value |
|---|---|---|
| 1 | Fantasy | Resource extraction (placeable buildings on ocean tiles) |
| 2 | Anchoring | Cable-tethered to a populated island |
| 3 | Resource theme | T5-T6 exotic inputs |
| 4 | Terrain types | 5: shallows, deep, trench, hydrothermal_vent, nodule_field |
| 5 | Route integration | Logical extensions of anchor island (output → anchor inventory) |
| 6 | Discovery | Sat Scanner + Sonar Buoy, two-axis (surface + depth) |
| 7 | Tier curve | T2 entry, 12-building catalog with ~25 recipes |
| 8 | Cable | New `submarine_cable` variant at T3 |
| 9 | Features are clusters | Not points; building footprints must match contiguous terrain blocks |
| 10 | No richness modifier | Cluster size is the only feature differentiator |
| 11 | Anchor pick | Player-selected at placement (not auto-nearest) |
| 12 | Hover tooltip | Load-bearing UX (weather overlay obscures glyphs) |
| 13 | Inspector cell tooltip | Shipped in initial scope (was punt candidate; promoted by hover requirement) |

---

## 1. Overview

The ocean — currently the 3-tier fog backdrop between islands — becomes a real placement surface for T2+ extraction infrastructure. Every populated island can extend cable out into the surrounding water and anchor specialized rigs that pull T5/T6 exotic inputs the land chains can't supply at scale.

Five ocean terrain types (shallows / deep / trench / hydrothermal_vent / nodule_field) gate which rigs go where. Bulk extractors (deuterium, He-3) work on common terrain. Rare-feature extractors (vent tap, nodule harvester, trench drill) only work on seeded multi-cell clusters the player must discover via the new T2 **Sonar Buoy** building or via existing T6 Scanner Sat coverage.

All rigs are logical extensions of their anchor island: outputs flow back through cable into the player-selected anchor's inventory; no new route type, no new dispatch graph. The cable itself is a real spatial investment — land cable can't go on water; T3 unlocks `submarine_cable` (chemistry-chain gate) as the only way to extend infrastructure offshore.

Net player loop: T2 buoy + open-water extractor near home Coast → discover vents/nodules → T3 submarine cable to reach them → T4-T5 specialized rigs convert exotic raw materials into the T5/T6 chains. Ocean is a mid-to-late-game pull-forward of exotic supply, not a survival/food layer.

---

## 2. Terrain + World-Gen

### Data primitives

- `OceanCellSpec`: `{ terrain: 'shallows' | 'deep' | 'trench' | 'hydrothermal_vent' | 'nodule_field' }`. Carries terrain only — discovery is tracked separately (see §5).
- `World.oceanCells: Map<string, OceanCellSpec>`, keyed `"cellX,cellY"`. Tiles NOT in the map are implicit `deep` (default; saves memory for vast empty seas).

### Generation rules

Runs during `generateWorld`, after islands are placed. Iteration order matters because features cannot overlap:

1. **Shallows** — derived from island proximity: any ocean tile within R=2 cells of an island edge. Stored explicitly (simpler than re-deriving on every read; small overhead given typical island counts).
2. **Trenches** — drawn first (largest features, claim deep area). Per-world: 0-3 trench rectangles, each a 2×N (or rare 3×N) strip with N=4-8, drawn between two random deep-zone endpoints.
3. **Nodule fields** — placed second. Per-world: 2-5 fields, each a 3×3 cluster in deep zones (>R=8 from any island edge). Must not overlap trenches.
4. **Hydrothermal vents** — placed last. Per Volcanic island, roll 0-3 vent clusters within R=5 of the island edge. Each cluster is 2×2 or 3×2 (rolled small/medium). Must not overlap trenches or nodule fields.
5. **Deep** — default for everything else. Implicit; not stored.

All rolls use dedicated per-feature RNG streams (`${seed}_ocean_shallows`, `${seed}_ocean_trench`, `${seed}_ocean_nodule`, `${seed}_ocean_vent`) so adding future generation steps doesn't perturb existing seeds. Mirrors the Coast-rotation pattern (commit `a6578df`).

### Cluster sizing and capacity

Building footprints must lie entirely within a contiguous block of the matching terrain (see §3 building table). With the roll shapes above:

- **Vents** (2×2 or 3×2): every vent cluster hosts exactly 1 building. A 3×2 cluster gives placement flexibility (the 2×2 footprint can sit on either the left two columns or the right two columns) but only one Vent Tap or Geothermal Generator fits without overlap.
- **Nodule fields** (3×3): exactly 1 Nodule Harvester (2×2 footprint), with the remaining row of nodule cells unused.
- **Trenches** (2×N, N=4-8): naturally accommodate multiple Trench Drills along the strip length. A 2×4 trench hosts 1 Drill; a 2×8 trench hosts up to 4 Drills end-to-end.

Trenches are the only feature type where larger cluster size translates directly to multi-building capacity. Vents and nodule fields are 1-per-cluster regardless of which cluster size rolled — the player loop for those is "find the feature, claim it with one building" rather than "build out a large feature with multiple extractors."

### v4 → v5 migration

On load, if a save has `schemaVersion === 4` and no `oceanCells` field:

1. **Re-derive terrain** by running `generateOceanTerrain(world.seed)` — deterministic, produces the same `oceanCells` map any fresh world with that seed would produce. No data lost; the seed is enough.
2. **Bump schema to v5** in the persisted file.

`revealedCells` (existing surface-discovery set) carries through unchanged. `depthRevealedCells` (new, §5) starts empty — players who already explored have full surface visibility but no depth knowledge yet, mirroring the new capability's introduction.

Saves at schemas v1-v3 still drop to "unknown schema" per existing policy.

### Files

- `src/ocean-cell.ts` (new) — type + pure helpers
- `src/ocean-gen.ts` (new) — terrain seeding called from `generateWorld`
- `src/world.ts` — add `World.oceanCells` field
- `src/persistence.ts` — serialize + migrate; schema bump to v5
- `src/world-gen.ts` — call into ocean-gen after island placement

---

## 3. Building Catalog + Recipe Depth

12 buildings total — 11 productive + 1 cable variant. Most extractors and all processors carry 2-4 recipes; ~25 new recipes shipped, ~20 new resources. Chain depth is the goal — every raw goes through at least one processing step before it lands on the player's main island.

### Catalog

| Tier | Building | Footprint | Terrain rule | Recipes |
|---|---|---|---|---|
| T2 | Sonar Buoy | 1×1 | any discovered ocean | — (discovery only) |
| T2 | Seawater Intake Rig | 2×2 | shallows (all 4 tiles) | 2 (dilute_brine, trace deuterium) |
| T3 | Submarine Cable | 1×1 | any ocean | — (infrastructure) |
| T3 | Open-Water Extractor | 2×2 | shallows OR deep (all 4) | 2 (concentrated_brine, He-3 dilute) |
| T3 | Brine Distillation Rig | 3×3 | shallows OR deep (all 9) | 3 (lithium_brine, salt, bromine) |
| T3 | Nodule Harvester | 2×2 | nodule_field (all 4) | 3 (Mn / Re / Co nodules) |
| T4 | Trench Drill | 2×2 | trench (all 4) | 3 (methane_hydrate, heavy_isotope_slurry, vent_sulfide) |
| T4 | Nodule Concentrator | 3×3 | shallows OR deep (all 9) | 2 (rare-earth refine, cobalt refine) |
| T4 | Vent Tap | 2×2 | hydrothermal_vent (all 4) | 2 (vent_sulfide, vent_exotic) |
| T5 | Vent Mineral Refinery | 3×3 | shallows OR deep (all 9) | 2 (exotic_alloy_seed, tritium_seed) |
| T5 | Heavy Water Distiller | 3×3 | shallows OR deep (all 9) | 1 (heavy_water) |
| T6 | Geothermal Vent Generator | 2×2 | hydrothermal_vent (all 4) | — (power source, ~2 kW) |

### Power + recipes

- All productive buildings draw 200-1500W depending on tier (Appendix-A placeholders).
- Submarine cable recipe: `2 rubber + 1 lead_sheath + 1 copper_wire` (placeholder; Appendix-A).
- Recipe specifics (input quantities, cycle times, xpWeight) are Appendix-A placeholders — implementer should mirror the closest existing land building's pattern per tier.

### Chain examples (illustrative, not exhaustive)

**Lithium chain (T3):** Seawater Intake → `dilute_brine` → Brine Distillation Rig → `lithium_brine` → existing land Battery Factory consumes.

**Rare-earth chain (T3→T4):** Nodule Harvester → `re_nodule` → Nodule Concentrator → `rare_earth_concentrate` → existing Magnet / Specialty Alloy buildings.

**Heavy water chain (T3→T5):** Open-Water Extractor → `concentrated_brine` → Heavy Water Distiller → `heavy_water` → Antimatter Refinery (replaces or supplements existing inputs).

**Tritium chain (T4→T5):** Trench Drill → `heavy_isotope_slurry` → Vent Mineral Refinery → `tritium_seed` → new T5 fusion-fuel intermediate, future expansion gate.

**Exotic alloy chain (T4→T5→T6):** Vent Tap → `vent_exotic` → Vent Mineral Refinery → `exotic_alloy_seed` → existing exotic_alloy production (ocean-sourced alternative).

### Resource summary

**Raw extracted (~10):** `dilute_brine`, `concentrated_brine`, `he3_dilute`, `mn_nodule`, `re_nodule`, `co_nodule`, `methane_hydrate`, `heavy_isotope_slurry`, `vent_sulfide`, `vent_exotic`

**Intermediate / processed (~6):** `lithium_brine`, `salt`, `bromine`, `rare_earth_concentrate`, `refined_cobalt`, `exotic_alloy_seed`

**Final / feeds existing chains (~3):** `heavy_water`, `tritium_seed`, plus raws that drop into existing consumers without further processing

### Files

- `src/building-defs.ts` — 12 new building defs with `oceanPlacement: true` + `terrainReqs: readonly OceanTerrain[]`
- `src/recipes.ts` — ~25 new recipes + ~20 new ResourceIds
- `src/storage-categories.ts` — new resources categorized (rare/common/intermediate)
- `src/inventory-ui.ts` — parallel categorization for the inventory panel

---

## 4. Cable + Anchor Model

### Submarine cable

A new `submarine_cable` building variant. Same §5.3 power-pool semantics as land cable (binary-gated unified pool, commit `a92d541`). Placement rules:

- Placed on ocean tiles only; land cable rejected on water, submarine cable rejected on land. Clean type separation.
- Connects to land cable at coast adjacency: a submarine cable cell adjacent to a land cable cell across an island edge joins both into one §5.3 unified pool. No special interconnect building.
- Same capacity per cell as land cable; placement cost slightly higher per the recipe difference.
- Visual: slightly darker tint than land cable so the player can see which segments are submarine.

### Anchor island rule

Every ocean productive building gets an `anchorIslandId` set **by the player** at placement time:

- After the player commits the placement tile, a picker modal opens listing every populated island in the §5.3 cable component the platform will join.
- Each option shows: island name + glyph, current distance in tiles, current inventory headroom for the platform's main output. Closest populated island is pre-highlighted as the default.
- Player confirms → `anchorIslandId` is recorded on the building. Cancel → placement aborted, no building created.
- Single-island case (common bootstrap): picker shows 1 option, pre-selected; Enter commits.

The picker reuses the modal pattern established by the §4.6 placement-time label picker (commits `a96210a` + `144fd15`) — same modal infrastructure, same Enter/Escape keybinds.

### Output flow

The platform is logically a building on `anchorIslandId`'s `buildings[]` array, indexed by an island ID that isn't the platform's geographic location. The existing `advanceIsland` loop produces correctly — no new dispatch code:

- Output deposits to `state.inventory[resourceId]` on the anchor island state.
- Storage cap applies (anchor's normal capacity, with any §5.3 cable-extension effects).
- Cap-throttle uses the existing economy ramp logic.
- Recipes that consume inputs (e.g. processors) draw from the anchor's inventory.

### Edge cases pinned

- **Multiple populated islands in the cable component**: player picks at placement. No tiebreak needed (it's their decision).
- **Component grows later (a new island gets populated)**: anchor doesn't drift. Platform stays bound to its placement-time anchor.
- **Anchor becomes unpopulated** (tier-reset, abandonment, future depopulation): platform halts with `paused: 'anchor-depopulated'` until the anchor is repopulated.
- **Cable component breaks** (cable cell deleted, severing the platform from anchor): platform halts with `paused: 'anchor-disconnected'`. Re-laying cable restores production.
- **Terrain access lost** (hypothetical future event removing a vent): platform halts with `paused: 'terrain-lost'`. Defensive; not expected in initial scope.
- **Anchor relocation**: not supported in initial scope. Player workaround: delete the platform and rebuild. (Re-anchor inspector UI can land in a follow-up if desired.)

### Files

- `src/submarine-cable.ts` (new, or `routes.ts` extension) — cable variant + adjacency rules. Probably folds into existing cable code with a `variant: 'submarine'` discriminator on the building def.
- `src/placement.ts` — new state in the placement state machine: after tile commit, transition to `awaiting-anchor`; emit anchor picker; on confirm, complete placement with `anchorIslandId`.
- `src/economy.ts` — `paused` reason enum gains `'anchor-depopulated'`, `'anchor-disconnected'`, `'terrain-lost'`. No change to `advanceIsland` (platforms are normal buildings on the anchor).
- `src/inspector-ui.ts` — warning chips for the three new paused reasons.
- The anchor picker modal: lives alongside the cargo-label picker (`src/cargo-label-picker.ts`); same modal shell.

---

## 5. Discovery Integration (two-axis model)

### Two axes

- **Surface discovery** (`WorldState.revealedCells: Set<"cellX,cellY">`, existing): "I've been here, I can see this water." Drones and populated-island seeding write to it. Existing fog overlay reads it.
- **Depth discovery** (`WorldState.depthRevealedCells: Set<"cellX,cellY">`, new): "I've scouted what's UNDER this cell." Without it, the player sees ocean surface but doesn't know if there's a vent / nodule field / trench below.

Both sets: persistent (once set, never cleared), pure-data, serialized to save.

### Revealer mapping

| Source | Writes to `revealedCells` | Writes to `depthRevealedCells` |
|---|---|---|
| Populated island seeding | ✓ (existing) | — |
| Drone scan | ✓ (existing) | — |
| Sonar Buoy (new T2) | ✓ (incidental) | ✓ (primary purpose) |
| Scanner Sat (existing §14.5, extended) | ✓ (extended) | ✓ (extended) |

### Sonar Buoy (T2 building)

- 1×1 footprint, 50W power draw, placement cost `~20 iron_ingot + 10 copper_wire + 5 microchip` (Appendix-A placeholder).
- While powered, marks every cell within `SONAR_BUOY_RADIUS_TILES` (placeholder 4 cells; Appendix-A) in BOTH `revealedCells` and `depthRevealedCells`.
- Visual: small pulsing dot on the map; faint cyan ring at reveal radius when inspector is open on it. Distinct color from Antenna / Lighthouse rings.

### Scanner Sat extension

- The existing `cellsCoveredBySat` (§14.5, area-overlap geometry per commit `fb7bd51`) is called per-tick for every active Scanner Sat over cells in coverage. Today it only flips island-discovery flags.
- Extension: also walk `world.oceanCells` and call `revealedCells.add(...)` AND `depthRevealedCells.add(...)` for every ocean cell in the coverage disk.
- One bounded change in the Scanner Sat tick: existing per-cell loop gains a parallel branch for ocean cells. Same coverage math, additional flip-target.

### Render rule for feature glyphs

A cell's feature glyph (∿ for vent, ⋮ for nodule, ▭ for trench) renders only when:

```
revealedCells.has(key) && depthRevealedCells.has(key) && oceanCells.get(key)?.terrain is rare
```

- `revealedCells` false: fog covers everything; no glyph.
- `revealedCells` true, `depthRevealedCells` false: clear water surface, no glyph — player sees water but doesn't know what's beneath.
- Both true and terrain is rare: feature glyph rendered.

### Mid-tier sonar gap

No intermediate building between T2 Sonar Buoy (4-cell radius) and T6 Scanner Sat (much larger coverage). Accepted as deliberate progression — mid-game players grid out buoys; late-game players replace the grid with sat coverage.

### Files

- `src/discovery.ts` — extend with `depthRevealedCells: Set<string>`, mirroring `revealedCells` API
- `src/sonar-buoy.ts` (new) — buoy tick logic, calls a generic `revealOceanCells(world, centerCell, radius, {surface, depth})`
- `src/orbital.ts` — extend Scanner Sat tick to also call `revealOceanCells(..., {surface: true, depth: true})` for cells in coverage
- `src/persistence.ts` — serialize `depthRevealedCells`

---

## 6. Render + UI

### Layer z-order (bottom → top)

1. Unknown fog (existing)
2. Discovery fog tiers (existing `src/ocean.ts`)
3. **Ocean feature glyphs** (new) — ∿ / ⋮ / ▭, rendered for cells passing the render rule in §5
4. Weather overlay (existing `src/weather-overlay.ts`, extended commit `9528864`) — renders ABOVE feature glyphs; a storm visually hides what's underneath, consistent with player intuition
5. Buildings (existing)
6. Routes / cable (existing)
7. **Hover tooltip overlay** (new) — always on top, always readable

### Hover tooltip (load-bearing)

Mouse-over on any cell (land OR ocean) opens a small DOM tooltip positioned near the cursor. The hover is **load-bearing**: weather overlay paints opaque black over cells during storms, so the feature glyphs alone are not a reliable read. The tooltip is the player's always-works channel for cell state.

**Ocean cells (revealed):**
- Terrain: `Shallows` / `Deep Water` / `Trench` / `Hydrothermal Vent` / `Nodule Field` (when depth-revealed) — or `Unscouted depths` (when surface-revealed only)
- For rare features: cluster size + occupancy, e.g. `Hydrothermal Vent — 3×2 cluster (1/2 building slots free)`. The cluster's anchor cell (top-left) surfaces full cluster info; other cells in the cluster point back to the anchor.
- Cable component: "In §5.3 pool of [Island Names]" (if any)
- Anchor-eligible: which populated islands could be anchor if you placed here

**Ocean cells (unrevealed):**
- Just "Open ocean" — no terrain leak, no spoilers.

**Land cells:**
- Tile type (grass / forest / ore vein / etc.) — existing info, surfaced earlier than inspector click
- Building (if any) — same one-line info the inspector shows in its header

**Weather (universal, both ocean and land):**
- Current cycle: `Storm — capacity 35%` / `Clear — capacity 100%` / `High Wind — wind power +50%`
- Forecast (always shown — chosen ungated for universal usefulness, even though the §2.6 Advanced Weather Station mechanic gates the on-map forecast overlay): `→ Clearing in ~2h` or `→ Storm incoming`

### Implementation

- `src/hover-tooltip.ts` (new) — DOM overlay with `pointer-events: none`. Listens to PixiJS canvas mousemove. Throttled to ~30Hz.
- Cell-lookup helper: screen px → world px (camera transform) → tile coords → cell coords. Same math `ocean.ts` already uses for fog tier lookups; extract into a shared pure helper.
- Pure function `cellInfoForHover(world, cellKey, hoverState)` returns the structured info object. Tested separately from the DOM rendering.

### Feature glyph rendering

- 12-16 pixel sprites, fixed pixel size (scale-independent — they shouldn't grow when zooming in).
- Pale-cyan tint that contrasts with both fog tiers.
- One glyph per cluster: rendered at the cluster's anchor cell (top-left), not at every cell of the cluster.
- Pre-baked into PixiJS Texture cache on first use.

### Submarine cable visual

- Same render path as land cable, distinguished by slightly darker tint (e.g. existing cable is light-grey; submarine is steel-blue).
- Inspector header for a submarine cable cell: shows it's submarine + the §5.3 pool it joins.

### Sonar Buoy range ring

- Faint cyan ring at `SONAR_BUOY_RADIUS_TILES` when the inspector is open on a buoy (only — not permanently on the map; would be too busy).
- Same render path as Antenna / Lighthouse rings.

### Scanner Sat coverage

- Already rendered as a coverage disk per `src/satellite-overlay.ts`. No render change — the disk visually covers ocean cells too. Only the data side gains the depth-discovery write.

### Files

- `src/hover-tooltip.ts` (new)
- `src/ocean.ts` — add feature-glyph render pass between fog sprites and weather overlay z-layer; extract cell-lookup helper as pure function
- `src/main.ts` — wire hover tooltip into input pipeline
- `src/inspector-ui.ts` — submarine cable + Sonar Buoy display headers

---

## 7. Testing Strategy

Pure-layer tests only, per `AGENTS.md`'s render/pure separation. TDD discipline as in every commit this session.

### New test files

- `src/ocean-gen.test.ts` — terrain seeding:
  - Determinism (same seed → identical map)
  - Per-feature determinism (per-feature RNG streams isolated)
  - Cluster shape validity (vents 2×2 or 3×2; trenches 2×N; nodule_fields 3×3)
  - Non-overlap (trenches, nodule_fields, vents never share a cell)
  - Biome correlation (vents near Volcanic; nodule_fields in deep zones)
  - Shallows derivation correctness

- `src/ocean-cell.test.ts` — query helpers:
  - `terrainAt(world, cellX, cellY)` returns terrain or `'deep'` default
  - `footprintMatches(world, defId, anchorCell)` validation (full match, partial fail, undersized cluster fail)

- `src/sonar-buoy.test.ts`:
  - Powered buoy writes both sets within radius
  - Unpowered buoy doesn't reveal
  - Multiple buoys union coverage correctly

- `src/submarine-cable.test.ts`:
  - Placeable on ocean only; rejected on land
  - Land cable adjacent to submarine cable across coast joins one §5.3 pool
  - Recipe + placement cost wired through `building-defs.ts`

### Extended existing tests

- `src/discovery.test.ts` — `depthRevealedCells` independence + persistence
- `src/orbital.test.ts` — Scanner Sat ocean-cell reveal; in-transit sats don't reveal
- `src/placement.test.ts` — ocean placement: footprint-match, anchor-picker flow, cancel
- `src/economy.test.ts` — anchor crediting, `paused: 'anchor-depopulated'` and `'anchor-disconnected'` states
- `src/persistence.test.ts` — v4 → v5 migration (terrain populated; empty `depthRevealedCells`; `revealedCells` carried through)

### Render-layer tests — minimal

- Pure helper `shouldRenderFeatureGlyph(cellKey, revealedCells, depthRevealedCells, oceanCells)` if factored; skip PixiJS Sprite assertions
- Pure helper `cellInfoForHover(world, cellKey)` returns structured info; DOM rendering left untested per project convention

### Coverage target

Adding ~70-90 tests, bringing total from current 1746 to ~1820+. No regressions to existing 1746 expected.

---

## Out of scope for initial implementation

- Per-cluster richness modifier (cluster size is the only differentiator)
- Mid-tier sonar building (T4 Sonar Array) bridging the buoy/sat gap
- Anchor-relocation inspector UI (player deletes + rebuilds)
- Independent platform inventory / multi-island route endpoints (platforms are logical extensions of anchor)
- Submarine power broadcasters (cable is the only ocean power transport)
- Ocean-cell weather variance beyond what §2.6 already does

---

## Implementation order suggestion (for the upcoming plan)

1. Data primitives: `OceanCellSpec`, `World.oceanCells`, terrain types
2. World-gen: `generateOceanTerrain`, cluster shapes, biome correlations
3. Migration: v4 → v5 path
4. Submarine cable: variant + adjacency + placement rules
5. Anchor-picker modal (reuse cargo-label-picker shell)
6. Sonar Buoy: building def, tick logic, `depthRevealedCells` writes
7. Scanner Sat extension: ocean-cell depth-discovery
8. Catalog: 12 building defs + 25 recipes + 20 resources
9. Render: feature glyphs, submarine cable visual, sonar ring
10. Hover tooltip: pure cell-info helper + DOM overlay
11. Inspector chips: anchor states
12. Test suite: alongside each piece (TDD)

Each step ships as its own commit; ~12 commits for the full layer.
