# Energy SI Rebalance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Commit trailer:** each commit ends with the *implementer's* `Co-Authored-By` trailer (the subagent that authored it), per repo CLAUDE.md.

**Goal:** Convert the game's electrical power system to real SI units (canonical unit = **kW**), so producers/consumers carry physically-grounded ratings and the HUD displays W/kW/MW/GW instead of mislabeled "W".

**Architecture:** The stored `power.produces/consumes` number now *is* the value in **kW**. Most consumers keep their existing number (already kW-realistic) and only change meaning; the off-scale **generators** and two **electric-process consumers** get new kW values. The brownout ratio (`min(1, produced/consumed)`) and battery integration are unit-agnostic — battery capacities auto-scale ×1000 (5 kWh→5 MWh) with no math change. A new pure `fmtPower(kW)` formats the display.

**Tech Stack:** TypeScript (strict), Vitest. Pure layer in `economy.ts`/new `format.ts`; render layer in `hud.ts`/`routes.ts`.

**Spec:** `docs/superpowers/specs/2026-05-29-energy-si-rebalance-design.md` · data: `2026-05-29-energy-si-consumer-table.md`

**Test commands:** `npx vitest run <file>` (single), `npm test` (all), `npx tsc --noEmit`, `npm run build`.

---

### Task 1: `fmtPower` formatter + HUD label

**Files:**
- Create: `src/format.ts`
- Create: `src/format.test.ts`
- Modify: `src/hud.ts` (line ~577, the power row)

- [ ] **Step 1: Write the failing test**

`src/format.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { fmtPower } from './format.js';

describe('fmtPower — SI power display (input is kW)', () => {
  it('sub-kW shows W', () => expect(fmtPower(0.02)).toBe('20 W'));
  it('zero', () => expect(fmtPower(0)).toBe('0 W'));
  it('kW range', () => {
    expect(fmtPower(20)).toBe('20 kW');
    expect(fmtPower(7.5)).toBe('7.5 kW');
  });
  it('MW range', () => {
    expect(fmtPower(5000)).toBe('5 MW');
    expect(fmtPower(300000)).toBe('300 MW');
  });
  it('GW range', () => expect(fmtPower(1_000_000)).toBe('1 GW'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/format.test.ts`
Expected: FAIL — cannot resolve `./format.js` / `fmtPower` not defined.

- [ ] **Step 3: Write minimal implementation**

`src/format.ts`:
```ts
// Pure display helpers. No DOM / PixiJS imports — safe to unit-test directly.

/** Trim a number to a short label: integers bare, else 1 decimal. */
function trim(n: number): string {
  return Number.isInteger(n) ? n.toString() : n.toFixed(1);
}

/** Format an electrical-power value (canonical unit = kW) as W / kW / MW / GW. */
export function fmtPower(kW: number): string {
  const a = Math.abs(kW);
  if (a === 0) return '0 W';
  if (a < 1) return `${Math.round(kW * 1000)} W`;
  if (a < 1000) return `${trim(kW)} kW`;
  if (a < 1_000_000) return `${trim(kW / 1000)} MW`;
  return `${trim(kW / 1_000_000)} GW`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/format.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire into the HUD power row**

In `src/hud.ts`, add to the imports near the top (alongside the existing `./economy.js` import):
```ts
import { fmtPower } from './format.js';
```
Replace the power-row line (currently `~577`):
```ts
    powerV.textContent = `${fmt(power.produced)}W / ${fmt(power.consumed)}W · ${power.factor.toFixed(2)}×`;
```
with:
```ts
    powerV.textContent = `${fmtPower(power.produced)} / ${fmtPower(power.consumed)} · ${power.factor.toFixed(2)}×`;
```

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit` → clean.
```bash
git add src/format.ts src/format.test.ts src/hud.ts
git commit -m "feat(energy): fmtPower W/kW/MW/GW formatter; HUD power row in SI units"
```

---

### Task 2: Producer SI values

Change the 9 off-scale generators to their kW ratings. The 6 already-correct producers (water_wheel 20, windmill_t0 15, newcomen_engine 4, solar 50, tidal_array 50000, sunspire 60000) are **left unchanged**.

**Files:**
- Modify: `src/building-defs.ts` (each producer's `power: { produces: N }`)
- Modify: `src/building-defs.test.ts` (the coal_gen value assertion at ~298; any other producer-value assertions)

- [ ] **Step 1: Update the failing producer-value test first**

In `src/building-defs.test.ts`, find the assertion (~line 298):
```ts
  it('coal_gen produces 50 units of power (rev-16 §10.3)', () => {
    expect(BUILDING_DEFS.coal_gen.power?.produces).toBe(50);
```
Change to:
```ts
  it('coal_gen produces 5 MW (5000 kW) of power (energy SI rebalance)', () => {
    expect(BUILDING_DEFS.coal_gen.power?.produces).toBe(5000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/building-defs.test.ts -t "coal_gen produces"`
Expected: FAIL — received 50, expected 5000.

- [ ] **Step 3: Apply the 9 producer edits in `src/building-defs.ts`**

Set each building's `power: { produces: ... }` (keep any other fields like `kind: 'wind'`):

| building | new `produces` |
|---|---|
| `coal_gen` | `5000` |
| `biomass_plant` | `1000` |
| `geothermal_vent` | `1000` |
| `cryogenic_generator` | `3000` |
| `geothermal_vent_generator` | `20000` |
| `nuclear_reactor` | `200000` |
| `fusion_core` | `300000` |
| `casimir_tap` | `1000000` |
| `wind_turbine` | `100` |

Leave `water_wheel` (20), `windmill_t0` (15), `newcomen_engine` (4), `solar` (50), `tidal_array` (50000), `sunspire` (60000) unchanged.

- [ ] **Step 4: Run the producer test + suite-wide grep for other hardcoded producer values**

Run: `npx vitest run src/building-defs.test.ts -t "coal_gen produces"` → PASS.
Run: `grep -rnE "\.power\?\.produces\)\.toBe\(|produces: ?(40|80|200|400|2000|5000|8000)\b" src/*.test.ts`
For each remaining hit asserting an OLD producer value, update it to the new kW value from the table above. (Unlock/placement/biome tests that don't assert the numeric value need no change.)

- [ ] **Step 5: Run full suite to catch power-balance fixtures**

Run: `npm test`
Expected: any failures are tests that hardcoded old producer numbers or computed power balances from them. Update those fixtures to the new kW values until green. Do NOT change the brownout logic.

- [ ] **Step 6: Commit**

```bash
git add src/building-defs.ts src/building-defs.test.ts src/*.test.ts
git commit -m "feat(energy): producer power ratings to real SI kW (coal_gen 5MW, nuclear 200MW, fusion 300MW, casimir 1GW, …)"
```

---

### Task 3: Electric-process consumers (EAF + aluminum) + drop EAF `requiresHeat`

**Files:**
- Modify: `src/building-defs.ts` (`electric_arc_furnace`, `aluminum_smelter`)
- Modify: `src/building-defs.test.ts` (add assertions)

- [ ] **Step 1: Write failing tests**

Add to `src/building-defs.test.ts`:
```ts
  it('electric_arc_furnace is pure-electric 10 MW (no requiresHeat)', () => {
    expect(BUILDING_DEFS.electric_arc_furnace.power?.consumes).toBe(10000);
    expect(BUILDING_DEFS.electric_arc_furnace.requiresHeat).toBeFalsy();
  });
  it('aluminum_smelter draws 10 MW (Hall-Héroult electrolysis)', () => {
    expect(BUILDING_DEFS.aluminum_smelter.power?.consumes).toBe(10000);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/building-defs.test.ts -t "electric_arc_furnace is pure-electric"`
Expected: FAIL (consumes 200, requiresHeat truthy).

- [ ] **Step 3: Edit `src/building-defs.ts`**

- `electric_arc_furnace`: set `power: { consumes: 10000 }`, and **remove the `requiresHeat` field/flag entirely** (an EAF is its own electric heat).
- `aluminum_smelter`: set `power: { consumes: 10000 }`.

- [ ] **Step 4: Run tests + check no recipe relies on EAF heat**

Run: `npx vitest run src/building-defs.test.ts -t "electric_arc_furnace is pure-electric"` → PASS.
Run: `npx vitest run src/economy.test.ts` → confirm no EAF heat-adjacency test now breaks (if one asserts EAF needs heat, update it to reflect pure-electric operation).

- [ ] **Step 5: Commit**

```bash
git add src/building-defs.ts src/building-defs.test.ts
git commit -m "feat(energy): EAF + aluminum_smelter to 10 MW electric-process; drop EAF requiresHeat"
```

---

### Task 4: Consumer tier-coherence nudges (25 buildings)

Small realignments so within-tier draws are coherent. **Edit `src/building-defs.ts`** `power: { consumes: N }` for each:

| building | new kW | | building | new kW |
|---|---|---|---|---|
| bauxite_mine | 25 | | quarry | 25 |
| chromium_mine | 35 | | quartz_mine | 25 |
| clay_pit_extractor | 25 | | sulfur_mine | 25 |
| copper_mine | 25 | | tin_mine | 25 |
| graphite_mine | 25 | | tungsten_mine | 35 |
| lead_mine | 25 | | zinc_mine | 35 |
| limestone_quarry | 25 | | manganese_mine | 35 |
| phosphate_mine | 25 | | nickel_mine | 35 |
| chromium_smelter | 80 | | nickel_smelter | 80 |
| tungsten_smelter | 80 | | lime_slaker | 60 |
| bearing_assembler | 60 | | glass_fiber_spinner | 200 |
| mag_forge | 180 | | motor_assembly | 180 |
| pump_assembly | 100 | | | |

(All other consumers keep their current number — it is already the correct kW.)

- [ ] **Step 1: Write a representative failing test**

Add to `src/building-defs.test.ts`:
```ts
  it('consumer tier nudges land at SI kW', () => {
    expect(BUILDING_DEFS.quarry.power?.consumes).toBe(25);
    expect(BUILDING_DEFS.chromium_smelter.power?.consumes).toBe(80);
    expect(BUILDING_DEFS.glass_fiber_spinner.power?.consumes).toBe(200);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/building-defs.test.ts -t "consumer tier nudges"`
Expected: FAIL (quarry 30, chromium_smelter 50, glass_fiber_spinner 150).

- [ ] **Step 3: Apply the 25 edits** in `src/building-defs.ts` per the table above.

- [ ] **Step 4: Run the test + full suite**

Run: `npx vitest run src/building-defs.test.ts -t "consumer tier nudges"` → PASS.
Run: `npm test` → fix any fixture that hardcoded an old consumer value.

- [ ] **Step 5: Commit**

```bash
git add src/building-defs.ts src/building-defs.test.ts
git commit -m "feat(energy): consumer tier-coherence nudges to SI kW (mines, smelters, mills)"
```

---

### Task 5: Battery capacity labels (kW·s reinterpretation)

No numeric change — the W→kW unit shift makes `BATTERY_CAPACITY_WS` (unchanged values) read as kW·s, so capacities are now MWh-scale. Update the human-facing labels/comments only.

**Files:**
- Modify: `src/economy.ts` (the `BATTERY_CAPACITY_WS` doc comment, ~76)
- Modify: `src/building-defs.ts` (the battery capacity comments: battery_bank/capacitor_bank/flywheel_array/singularity_battery)

- [ ] **Step 1: Add a sanity test**

Add to `src/economy.test.ts` (import `BATTERY_CAPACITY_WS` if not already):
```ts
  it('battery capacities are MWh-scale under the kW power unit', () => {
    // value is power-unit·seconds; power unit is now kW → 5_000*3600 kW·s = 5 MWh
    expect(BATTERY_CAPACITY_WS.battery_bank).toBe(5_000 * 3600);
    // a 5 MW coal_gen surplus fills it in ~1 h: 5 MWh / 5 MW = 1 h
    const hoursToFill = (BATTERY_CAPACITY_WS.battery_bank! / 3600) / 5000; // (kWh)/(kW)
    expect(hoursToFill).toBeCloseTo(1, 5);
  });
```

- [ ] **Step 2: Run to verify it passes (value unchanged) — this is a guard, not a red test**

Run: `npx vitest run src/economy.test.ts -t "battery capacities are MWh-scale"`
Expected: PASS immediately (documents the invariant).

- [ ] **Step 3: Update comments**

In `src/economy.ts` above `BATTERY_CAPACITY_WS`, change the doc to note: *"Capacity in (power-unit)·seconds. The power unit is now **kW**, so these values are kW·seconds → battery_bank = 5_000·3600 kW·s = **5 MWh**."*
In `src/building-defs.ts`, update the battery comments: `battery_bank` 5 kWh → **5 MWh**; `capacitor_bank` 100 kWh → **100 MWh**; `flywheel_array` 2 MWh → **2 GWh**; `singularity_battery` 50 MWh → **50 GWh**.

- [ ] **Step 4: Commit**

```bash
git add src/economy.ts src/economy.test.ts src/building-defs.ts
git commit -m "docs(energy): battery capacities are MWh-scale under kW unit; sanity test"
```

---

### Task 6: Cable-network capacity display label

The cable W-capacity rides the same unit. Find its display and use `fmtPower`.

**Files:**
- Modify: `src/routes.ts` and/or `src/routes-renderer.*` / `src/inspector-ui.ts` (wherever cable capacity is rendered with a `W` suffix)

- [ ] **Step 1: Locate the cable-capacity display**

Run: `grep -rnE "capacity.*W|W.*cap|cableW|transmissionW|\\bW\\b" src/routes.ts src/inspector-ui.ts src/construction-ui.ts | grep -iE "cap|W"`
Identify the string that renders the cable's W-capacity to the user.

- [ ] **Step 2: Apply `fmtPower`**

Import `fmtPower` from `./format.js` in that file and replace the manual `${value}W` formatting of the cable capacity with `${fmtPower(value)}`. If the cable capacity is stored as a bare number it is already in kW — pass it directly.

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit` → clean.
```bash
git add src/routes.ts src/inspector-ui.ts
git commit -m "feat(energy): cable capacity display via fmtPower (SI units)"
```

---

### Task 7: Green gate — full suite, typecheck, build

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all green. Any remaining failure is a fixture hardcoding an old power value or balance — update it to the new kW value (never change brownout logic to make a test pass).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit` → clean.

- [ ] **Step 3: Build**

Run: `npm run build` → succeeds (chunk-size warning ok).

- [ ] **Step 4: In-browser verification (manual)**

After `npm run build` + reload of `https://islands.nitjsefni.eu/`, screenshot the HUD power row → confirm it reads e.g. `… kW / … kW · N×` or MW/GW (never bare `W` on large values), and that a placed coal_gen shows `5 MW`.

- [ ] **Step 5: Commit any final fixups**

```bash
git add -A
git commit -m "test(energy): suite green under SI power units"
```

---

### Task 8 (follow-up): `mine_on_coal` EROI retune

Optional balance pass flagged by the spec — coal EROI is now ~360× (real ~30–80×). This is a **recipe-rate** change, not a power change.

**Files:**
- Modify: `src/recipes.ts` (`mine_on_coal`, ~line 1678)
- Modify: `src/recipes.test.ts` / `src/economy.test.ts` (any coal-loop balance assertion, e.g. the "+0.4 coal/s pair" comment/test)

- [ ] **Step 1:** Compute target. coal_gen burns 0.5 coal/s for 5 MW. For EROI ≈ 50×, mining 1 coal should cost ≈ (5000 kW·2 s)/50 ÷ … i.e. raise the Mine's coal draw OR cut its output rate. Simplest: cut `mine_on_coal` output from `9` per 10 s toward a level that lands EROI in 30–80×, OR raise `mine` consumes for the coal variant. Pick the rate change that keeps the 1:1 pair net coal ≥ 0 (so a pair still self-sustains).

- [ ] **Step 2:** Write/adjust the coal-loop balance test to assert the new net coal/s and the EROI band, run red→green, commit:
```bash
git commit -m "balance(energy): retune mine_on_coal so coal EROI lands ~30-80x"
```

---

## Out of scope (separate follow-ups)

- **Genesis Chamber dynamic draw** — its `consumes` should scale with the runtime-selected target tier (SPEC L1431: T1≈50 kW … T4≈50 MW); needs an economy change to compute draw from the selection, not a static def. Defer.
- **T3 consumer tier uplift** — if T3 should feel more power-hungry, raise the T3 band above the current 100–600 kW. Tunable later.
- **Action-cost SI rescale** (terrain_modifier / land_reclamation_hub / platform_constructor operation costs) — tracked separately.
