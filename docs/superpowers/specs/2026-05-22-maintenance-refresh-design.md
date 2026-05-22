# Manual maintenance-refresh action — design

Date: 2026-05-22
Status: approved (brainstorming) — pending implementation plan

## Problem

Building maintenance (SPEC §4.7) is a fully automatic, ongoing loop. Every
productive building accrues wall-clock operating time (`PlacedBuilding.operatingMs`,
`buildings.ts:84`). Once `operatingMs` crosses the tier threshold
(`MAINTENANCE_THRESHOLD_MS_BY_TIER`, `maintenance.ts:35`) the building's output
factor degrades linearly 1.0 → 0.5 over 4h (`maintenanceFactor`,
`maintenance.ts:84`). It is restored only when the engine's auto-maintenance
cycle (`tryAutoMaintain`, `maintenance.ts:129`) finds the tier's maintenance
recipe (`MAINTENANCE_RECIPES`, `maintenance.ts:56`) present in the island
inventory at a segment boundary; that cycle consumes the materials and resets
`operatingMs = 0` / `maintainedAt = nowMs` (`maintenance.ts:156-157`).

This means a player whose island can't keep a steady trickle of Lubricant +
tier parts flowing has no recourse: the building sits degraded at 50% until
the supply chain catches up. There is no player-driven way to pay a lump sum
to restore a building immediately. The inspector's §4.7 maintenance section
(`inspector-ui.ts:1357-1388`) is read-only — it shows `operatingMs / threshold`
or `OVERDUE — degraded to NN%`, but offers no action.

The player *can* effectively reset a building today by demolishing it
(`demolishBuilding`, `placement.ts:630`) and re-placing it — a fresh placement
seeds `operatingMs = 0` (`placement.ts:449`). But that round-trip is clumsy:
it costs the full placement cost again (minus the 50% refund + 30% scrap),
loses the building's position/rotation/recipe binding, and re-incurs
construction time. There is no in-place equivalent.

## Goal

Give the player a one-click **maintenance refresh** on a building: pay half
the building's placement-cost materials, and the building's maintenance state
snaps back to pristine just-built condition — `operatingMs = 0`, output factor
1.0. Conceptually "demolish and rebuild in one click" but the building, its
tile position, rotation, and recipe binding all stay in place; no construction
time is re-incurred. It is a convenience alternative to feeding the building a
steady trickle of maintenance supplies — a lump-sum buyout of the maintenance
loop.

## Decisions (locked in brainstorming)

1. **State reset = exactly the two `tryAutoMaintain` fields.** A refresh sets
   `operatingMs = 0` and `maintainedAt = nowMs` — the same two fields, to the
   same values, that a successful auto-maintenance cycle writes
   (`maintenance.ts:156-157`). `placedAt` is **not** touched (it is the
   immutable placement timestamp, not a maintenance field). `paused` and
   `toxicityExpiryMs` are unrelated subsystems (§4 ocean-anchor / §4.5
   toxicity) and are **not** touched — "pristine just-built state" is scoped
   to the §4.7 maintenance counter only, consistent with what a real
   demolish+rebuild would and would not clear.

2. **Cost = 50% of `placementCost`, floored per-resource.** The bill is
   `Math.floor(n / 2)` for each resource `n` in `def.placementCost` — the
   exact per-resource rounding `demolishBuilding`'s 50% refund uses
   (`placement.ts:690`). Computed per-resource, **not** sum-then-half, so the
   rounding is consistent with the existing demolish-refund math. A resource
   whose half rounds to 0 (placement cost of 1) contributes nothing to the
   bill — same `if (half <= 0) continue` guard as the refund path
   (`placement.ts:691`).

3. **Affordability gate — disabled button, like CONVERT.** If the island
   inventory can't cover the halved cost, the refresh button is **disabled**
   and labelled with the shortfall, mirroring the §13.3 CONVERT button's
   disabled-with-cost-readout pattern (`inspector-ui.ts:1402-1426`). The check
   reuses the existing `affordabilityShortfall(inventory, halvedCost)` helper
   (`placement.ts:115`) — no new affordability helper is introduced.

4. **Button lives in the Maintenance section, next to CONVERT — not in the
   demolish footer.** The task brief suggested the footer alongside DEMOLISH,
   but reading `inspector-ui.ts` shows the §13.3 CONVERT button already lives
   *inside* `maintenanceSection.body` (`inspector-ui.ts:855-890`), not in
   `footerSection`. REFRESH is conceptually a sibling of CONVERT — both are
   "act on this building's maintenance state" — whereas DEMOLISH is
   destruction/cleanup. Placing REFRESH in the maintenance section keeps the
   two maintenance actions together and the readout they act on directly
   above them. **This is a deliberate departure from the task brief**, made
   because the brief's "confirm by reading `inspector-ui.ts`" instruction
   surfaced CONVERT as the truer sibling.

5. **No confirmation dialog.** DEMOLISH uses `window.confirm`
   (`inspector-ui.ts:1012`) because it is irreversible destruction; CONVERT —
   the closer analog and also a material-spending action — does **not**
   (`inspector-ui.ts:883-889`). REFRESH follows CONVERT: it is not
   destructive (the building stays; the worst outcome of a mis-click is
   spending materials a little early, and the building simply re-degrades
   over the next threshold window). The disabled-when-pristine gate
   (Decision 6) already prevents the most wasteful mis-click.

6. **Allowed only when there is maintenance debt to clear.** The task brief
   asked us to recommend "anytime, but say so." We instead recommend
   **disabling the button when `maintenanceFactor === 1.0`** (i.e. the
   building is at or below threshold with no degradation, `operatingMs <
   threshold`). Refreshing a building that is already pristine would drain
   50% of its placement cost for literally zero gain — an obvious player
   trap. The button is enabled exactly when `operatingMs >= threshold` (the
   building has entered the "needs maintenance" state and its factor is
   below 1.0). Note: this is "factor < 1.0", not "operatingMs > 0" — a
   building below threshold has accrued time but no output penalty, so a
   refresh there still buys nothing.

7. **Ineligible building classes are hidden, not just disabled.** Three
   classes of building can never benefit from a refresh; for them the
   REFRESH control is not rendered at all (same display-by-state idiom the
   inspector uses for CONVERT, the construction section, the paused chip):

   - **Eternal Servitors** (`eternalServitor === true`) — `maintenanceFactor`
     hard-returns 1.0 for them (`maintenance.ts:89`); they have no
     maintenance state to refresh. The maintenance section already renders
     the "ETERNAL SERVITOR — exempt" stamp for these
     (`inspector-ui.ts:1361-1365`); REFRESH stays hidden alongside.
   - **Buildings with no productive recipe** — per SPEC §4.7 scope
     (lines 515-520) and the `accrueOperatingTime` doc comment
     (`maintenance.ts:166-177`), power producers, storage, antennas,
     lighthouses, drone pads, shipyards etc. never accrue operating time.
     Their `operatingMs` is permanently 0, `maintenanceFactor` is permanently
     1.0 — a refresh would only drain inventory. The eligibility test in
     Decision 6 (`maintenanceFactor < 1.0`) already excludes them, so in
     practice "hidden for non-maintained" falls out of the same gate; the
     spec calls it out explicitly so the implementer doesn't add a
     redundant separate branch.
   - **Buildings with no `placementCost`** — `placementCostFor` returns `{}`
     (`placement.ts:101`), so the halved bill is empty and the refresh would
     be **free**. A free maintenance reset is exploitable (it would make the
     §4.7 supply loop irrelevant for that building). Hide REFRESH when
     `placementCostFor(def)` is empty. Every shipped def post-§14 carries a
     `placementCost`, so this is defensive forward-compat (mirrors the
     "Buildings without a placementCost (defensively…)" language already in
     `demolishBuilding`, `placement.ts:684-686`).

   Additionally, **buildings still under construction**
   (`constructionRemainingMs > 0`) get no REFRESH control: an
   under-construction building hasn't started accruing operating time
   (`buildings.ts:71-78`), so its factor is 1.0 and Decision 6's gate hides
   the button anyway. No separate branch needed — noted so the implementer
   doesn't add one.

## Components

### 1. `maintenance.ts` — pure refresh helper

A single new pure helper, structured as the player-triggered sibling of
`tryAutoMaintain`. It does the affordability check, the half-cost deduction,
and the state reset atomically — so `inspector-ui.ts` stays pure UI wiring.

```ts
/** Player-triggered maintenance refresh (manual lump-sum alternative to the
 *  automatic §4.7 supply loop). Consumes 50% of the building's placement
 *  cost (Math.floor per-resource, matching demolishBuilding's refund math)
 *  from `inventory`, then resets the building to pristine maintenance state
 *  — operatingMs = 0, maintainedAt = nowMs — exactly as tryAutoMaintain does.
 *
 *  Atomic: ALL halved-cost inputs are checked present before ANY is
 *  consumed (same pattern as tryAutoMaintain, maintenance.ts:144-151).
 *
 *  Returns false WITHOUT mutating anything when the refresh is not allowed:
 *    - Eternal Servitor (no maintenance state).
 *    - building already pristine: maintenanceFactor(b, def) >= 1.0.
 *    - empty placement cost (free refresh — disallowed).
 *    - inventory short on any halved-cost resource.
 *  Returns true after a successful consume + reset.
 *
 *  `thresholdMul` is the island's §9.x maintenance-threshold skill
 *  multiplier — threaded through so the pristine-check agrees with the
 *  economy loop's own maintenanceFactor calls (economy.ts:1084). */
export function tryRefreshMaintenance(
  b: PlacedBuilding,
  def: BuildingDef,
  inventory: Record<ResourceId, number>,
  nowMs: number,
  thresholdMul = 1,
): boolean;
```

Plus a tiny pure cost helper so the UI label and the consume path can't
drift on what "half cost" means:

```ts
/** The 50%-of-placement-cost basket for a manual maintenance refresh.
 *  Math.floor per-resource; entries whose half rounds to 0 are dropped.
 *  Empty record when the def has no placementCost. */
export function refreshCostFor(def: BuildingDef): Partial<Record<ResourceId, number>>;
```

`tryRefreshMaintenance` computes its bill via `refreshCostFor`, checks it
with `affordabilityShortfall` (imported from `placement.ts`), deducts each
entry from `inventory`, then writes `operatingMs = 0` / `maintainedAt = nowMs`
through the same `(b as { operatingMs: number; maintainedAt: number })` cast
`tryAutoMaintain` uses (`maintenance.ts:156-157`) — `PlacedBuilding`'s fields
are `readonly` at the type level and the maintenance module already documents
this mutation convention.

> Import-direction note: `placement.ts` currently imports nothing from
> `maintenance.ts`, and `maintenance.ts` imports nothing from `placement.ts`.
> Adding `maintenance.ts → placement.ts` (for `affordabilityShortfall`) must
> not create a cycle — `circular-deps.test.ts` guards this. If the import
> would cycle, the fallback is to inline the trivial shortfall loop in
> `tryRefreshMaintenance` (it is six lines) rather than restructure modules.

### 2. `inspector-ui.ts` — REFRESH button in the maintenance section

A new button element, created next to `convertBtn` and appended into
`maintenanceSection.body` (after `convertBtn`, `inspector-ui.ts:890`). Styling
copies `convertBtn`'s industrial-readout button style
(`inspector-ui.ts:856-882`) — transparent background, `var(--ri-accent)`
border, hover lift, disabled state in `var(--ri-fg-4)`.

Click handler:

```ts
refreshBtn.addEventListener('click', () => {
  if (!target) return;
  const def = BUILDING_DEFS[target.building.defId];
  const ok = tryRefreshMaintenance(
    target.building,
    def,
    target.state.inventory,
    Date.now(),
    effectiveSkillMultipliers(target.state).maintenanceThreshold,
  );
  if (ok) paint();
});
```

`Date.now()` is the `nowMs` source — the inspector already uses `Date.now()`
as its perf-clock anchor for `computeRates` (`inspector-ui.ts:1208`), so the
`maintainedAt` stamp lands in the same clock domain the economy integrates
from. No state-rebuild or layer-rebuild is needed (the building's geometry is
unchanged); a local `paint()` is the only follow-up — same as the CONVERT
handler (`inspector-ui.ts:884-889`).

Paint logic, inside the existing maintenance-section block
(`inspector-ui.ts:1357-1388`), in the `else` branch (non-Servitor):

- Compute `cost = refreshCostFor(def)`.
- **Hide** `refreshBtn` (`style.display = 'none'`) when any of: building is an
  Eternal Servitor (already in the `if` branch — button stays hidden there),
  `Object.keys(cost).length === 0` (no placement cost), or
  `maintenanceFactor(building, def, thresholdMul) >= 1.0` (pristine — no debt).
- Otherwise **show** it. Label format mirrors CONVERT
  (`inspector-ui.ts:1413`): `REFRESH · <n RESOURCE (have)>, …`, e.g.
  `REFRESH · 15 STONE (40), 7 WOOD (3)`.
- Affordability: `missing = affordabilityShortfall(state.inventory, cost)`.
  `refreshBtn.disabled = Object.keys(missing).length > 0`. When disabled,
  apply the `var(--ri-fg-4)` / `not-allowed` / `opacity 0.6` treatment exactly
  as the CONVERT button does (`inspector-ui.ts:1416-1426`); the per-resource
  `(have)` annotation in the label already shows the player the shortfall.

The maintenance-section paint already runs every `refresh()` from the main
ticker, so the button's enabled/label state stays live as inventory and
`operatingMs` move.

### 3. No change to `placement.ts`, `economy.ts`, `persistence.ts`, `main.ts`

- `placement.ts` — `affordabilityShortfall` is reused as-is (exported
  already, `placement.ts:115`). `demolishBuilding` is untouched.
- `economy.ts` — the auto-maintenance loop is unaffected. A manual refresh
  just zeroes `operatingMs`; the next economy segment sees a pristine
  building and `findNextCapEvent` / `nextMaintenanceBoundaryMs` recompute
  the next threshold crossing naturally. No new tick wiring.
- `persistence.ts` — `operatingMs` / `maintainedAt` are already persisted
  fields (`persistence.ts:75-79, 462-497`). A refresh only mutates existing
  fields to in-range values; the snapshot/restore paths need no change.
- `main.ts` — the refresh is fully self-contained in the inspector (pure
  helper + local `paint()`), so no new inspector dep callback is needed,
  unlike `onDemolish` which requires a world-layer rebuild. `InspectorDeps`
  is unchanged.

## Data flow

```
building degrades: operatingMs crosses threshold → maintenanceFactor < 1.0
        │
        ▼
inspector maintenance section paints REFRESH button
   cost = refreshCostFor(def)          (50% placementCost, floor per-resource)
   enabled iff affordable AND factor < 1.0 AND has placementCost AND not Servitor
        │  player clicks
        ▼
tryRefreshMaintenance(building, def, state.inventory, Date.now(), thresholdMul)
   ├─ re-gate (Servitor / pristine / empty cost / affordability) → false on fail
   ├─ atomic: check all halved-cost inputs present
   ├─ deduct each halved-cost resource from inventory
   └─ operatingMs = 0 ; maintainedAt = nowMs        (== tryAutoMaintain reset)
        │  returns true
        ▼
inspector paint() — maintenance readout flips to "0h 00m / Th 00m",
                     REFRESH button hides (factor now 1.0)
        │
        ▼
next economy segment integrates the pristine building at factor 1.0
```

## Error handling / edge cases

- **Insufficient materials** — button disabled; the per-resource `(have)`
  annotation shows the shortfall. `tryRefreshMaintenance` also re-checks
  affordability and returns `false` without mutating, guarding the race
  between the paint-time gate and the click (a sibling production tick could
  consume inventory in between — same race `placeBuilding` re-guards,
  `placement.ts:373-382`).
- **Building already pristine (`factor >= 1.0`)** — button hidden by the
  paint gate; `tryRefreshMaintenance` also returns `false` for this case so a
  programmatic / test caller can't waste materials on a no-op.
- **Eternal Servitor** — button never rendered (paint stays in the Servitor
  `if` branch); helper returns `false` defensively.
- **No `placementCost`** — button hidden (empty cost basket); helper returns
  `false`. Prevents a free refresh.
- **Building under construction** — `constructionRemainingMs > 0` means
  `operatingMs === 0` and `factor === 1.0`, so the pristine gate hides the
  button. No separate branch.
- **Refresh deep in the degrade ramp vs. on the 0.5 plateau** — irrelevant to
  the helper: it always resets `operatingMs` to 0 regardless of how degraded
  the building was. The 50% cost is flat (it is a function of the def's
  placement cost, not of how degraded the building is). This is intentional —
  a flat lump sum, like demolish+rebuild, which also costs the same whenever
  you do it.
- **Two buildings of the same def, different degradation** — each has its own
  `operatingMs`; refreshing one does not touch the other. The helper takes a
  single `PlacedBuilding`.

## Testing

Pure-layer unit tests in `maintenance.test.ts` (the render/UI wiring is
verified live in the browser via daedalus, per the repo's
pure-layer-only test discipline):

- `refreshCostFor` returns `Math.floor(n / 2)` per resource for a def with a
  multi-resource `placementCost`; drops a resource whose cost is 1 (half → 0);
  returns `{}` for a def with no `placementCost`.
- `tryRefreshMaintenance` on a degraded building (operatingMs past threshold)
  with sufficient inventory: returns `true`, deducts exactly the halved cost
  per resource, sets `operatingMs = 0` and `maintainedAt` to the passed
  `nowMs`, leaves `placedAt` unchanged.
- `tryRefreshMaintenance` returns `false` and mutates **nothing** (inventory
  and building untouched) when: the building is pristine
  (`operatingMs < threshold`), the building is an Eternal Servitor, the def
  has no `placementCost`, or inventory is short on any one halved-cost
  resource (atomicity — partial baskets must not be consumed).
- `tryRefreshMaintenance` honours `thresholdMul`: a building that is past the
  base threshold but below `threshold * thresholdMul` is still pristine and
  the refresh is refused.
- Round-trip: a building refreshed via `tryRefreshMaintenance` has the same
  `maintenanceFactor` (1.0) as one just maintained via `tryAutoMaintain`.

## Out of scope

- Tuning the 50% rate — the figure is locked to mirror `demolishBuilding`'s
  refund percentage; re-tuning is Appendix A balance work.
- A "refresh all degraded buildings on this island" bulk action — per-building
  only, consistent with the inspector being a single-building panel.
- Any change to the automatic §4.7 auto-maintenance loop, its targeting
  policy (`pickMostDegradedTarget`), or its recipes.
- Partial refreshes (e.g. pay 25% for a half-restore) — refresh is all-or-
  nothing to pristine, matching the demolish+rebuild mental model.
- A keybinding / `input.ts` action for refresh — it is an inspector-panel
  button only; no map-level shortcut.
- Refreshing non-§4.7 subsystems (ocean-anchor `paused`, §4.5
  `toxicityExpiryMs`) — the action is scoped to the maintenance counter.

## Open questions

None load-bearing. One minor implementation choice is flagged inline (the
`maintenance.ts → placement.ts` import for `affordabilityShortfall` — use the
import if `circular-deps.test.ts` stays green, otherwise inline the six-line
shortfall loop); the spec's intent holds either way.
