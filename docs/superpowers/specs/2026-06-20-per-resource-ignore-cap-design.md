# Per-resource Ignore Cap — replaces Force Run

**Date:** 2026-06-20
**Status:** Design approved, pending implementation plan
**Scope:** Generalize the two existing output-cap-exemption mechanisms — the
per-building `forceRun` boolean (§4.6) and the global automatic
`OUTPUT_CAP_EXEMPT` set (§15.3 A, P4 Phase 1) — into a single per-`(building,
output-resource)` **Ignore Cap** flag, user-configurable in the inspector.
This **fully replaces** Force Run.

## Problem

Two separate, overlapping mechanisms govern "a full output bin must not stall
the producer":

1. **`forceRun?: boolean`** on `PlacedBuilding` (§4.6) — a per-building toggle
   in the inspector. When on, the building is exempt from the cap-stall on
   **all** its outputs. It is **blunt**: it also voids the building's valuable
   *primary* output, not just the side outputs the player wants to keep
   overflowing.
2. **`OUTPUT_CAP_EXEMPT: ReadonlySet<ResourceId>`** in `economy.ts` (P4 Phase
   1) — a global, automatic, hardcoded set of 8 byproducts (`co`,
   `refinery_gas`, `wood_tar`, `water_vapor`, `cryo_coolant_vented`,
   `mill_scale`, `tar`, `asphalt`) that are exempt for **every** producer so a
   full byproduct bin never throttles the valuable primary. The player has no
   control over it.

A player who wants fine-grained control — "keep overflowing *steel* on this
mill for XP, but throttle on a full *slag* bin" — cannot express it. Force Run
is all-or-nothing; the byproduct exemptions are automatic and invisible.

## Goal

A single per-`(building, output-resource)` **Ignore Cap** flag:

- **Ignore-cap ON for `(b, r)`** ⇒ `b`'s output `r` is stored up to cap and
  drawable, overflow above cap is voided, but a full `r` bin never stalls or
  throttles `b`. `b` keeps running on its other constraints (other capped
  outputs, empty inputs, power, heat, adjacency), earning XP and wearing.
- **Ignore-cap OFF** ⇒ a full `r` bin throttles `b` continuously (today's
  default net-flow behavior).

This subsumes both old mechanisms: the global byproduct set becomes the
**default-on** state; Force Run becomes "every output of this building ON".

## Decisions (from brainstorming)

- **Fully configurable.** Every output resource is a free toggle. The 9
  default-on resources (the 8 above **plus `slag`**, newly added) just *default*
  to ON; the player can turn any of them OFF and any default-off output ON.
  The P4 no-stall invariant for byproducts becomes the player's responsibility,
  not a hard floor.
- **Naming:** the control is called **"Ignore Cap"** (matches the internal
  `ignoreOutputCap` / `OUTPUT_CAP_EXEMPT` vocabulary).
- **Map badge:** the green level badge lights when the building forces a
  **non-default** output (any override `{r: true}` with `r ∉
  OUTPUT_CAP_EXEMPT`) — preserving today's "deliberately overproducing
  something valuable" signal. Default byproduct exemptions do not light it.
- **`slag` added to the default-on set** (`OUTPUT_CAP_EXEMPT`): it is a side
  output of smelter (`iron_ingot`) / steel_mill (`steel`) with a real consumer
  (`slag_reprocessor`), so a full slag bin throttling steel is exactly the
  regression the exemption exists to prevent.

## Data model

`OUTPUT_CAP_EXEMPT` stays as the **global default-on set**, now 9 resources
(adds `slag`).

Per building, store only **overrides** (compact; an untouched building carries
no field and behaves exactly as today; robust to future changes of the default
set):

```ts
// src/buildings.ts — on PlacedBuilding, REPLACES `forceRun?: boolean`
/** §4.6 per-output Ignore Cap overrides. Maps an output resource to an
 *  explicit on/off that overrides the global OUTPUT_CAP_EXEMPT default for
 *  THIS building. Absent resource ⇒ use the global default. Absent field ⇒
 *  all outputs at their global default (byproducts on, everything else off). */
ignoreCapOverrides?: Partial<Record<ResourceId, boolean>>;
```

The single effective predicate, used everywhere a cap-exemption is checked:

```ts
// new helper (src/building-operational.ts — pure, server-usable)
export function isOutputCapExempt(
  b: Pick<PlacedBuilding, 'ignoreCapOverrides'>,
  r: ResourceId,
): boolean {
  return b.ignoreCapOverrides?.[r] ?? OUTPUT_CAP_EXEMPT.has(r);
}
```

(`OUTPUT_CAP_EXEMPT` is re-exported / passed so `building-operational.ts` stays
PixiJS-free and importable by the server.)

## Engine change

The two old code paths collapse into the one predicate above.

- **`flow-solver.ts`** — `FlowBuildingSpec.ignoreOutputCap: boolean` (whole
  building) → **`capExemptOutputs: ReadonlySet<ResourceId>`** (the resources
  exempt for *that* building). The solver excludes only those `(building,
  resource)` pairs from `capConstrained` / the shared `θ[r]`, instead of
  excluding the whole building or relying on the global set.
- **`economy.ts`** — `outputAvail` and the per-building flow-spec builder
  (`computeRates` pass) compute exemptions via `isOutputCapExempt(b, r)`
  instead of `OUTPUT_CAP_EXEMPT.has(id)` + the building-level `forceRun`/
  `ignoreOutputCap`. `co2` / `NON_STORED_OUTPUTS` handling is unchanged.

Behavior is **identical** for every building that exists today (see Migration
equivalence). The change is purely a generalization of *which* `(building,
resource)` pairs are exempt.

## Persistence migration (v29 → v30)

1. Add `SerializedSnapshotV29` type alias (current shape with `forceRun`).
2. `migrateV29toV30`: for each building,
   - `forceRun === true` ⇒ set `ignoreCapOverrides = { r: true for every output
     resource r of the building's recipe (incl. rotateOutputs) }`, drop
     `forceRun`. This reproduces today's "all outputs exempt" exactly.
   - `forceRun` absent/false ⇒ drop `forceRun`, no `ignoreCapOverrides`
     (defaults apply: byproducts incl. slag exempt, primaries not).
   - The migration imports the building catalog/recipes (pure data) to
     enumerate a def's output resources.
3. Bump `SCHEMA_VERSION = 30`; add `30` to `SUPPORTED_LOAD_VERSIONS`; wire
   `migrateV29toV30` into the `deserializeWorld` chain.

**Migration equivalence (why behavior is preserved):**
- A force-run building today exempts all capped outputs → after migration
  `ignoreCapOverrides` has every output `true` → `isOutputCapExempt` true for
  all → identical.
- A non-force-run building today exempts exactly `OUTPUT_CAP_EXEMPT` outputs →
  after migration no overrides → `isOutputCapExempt` falls through to the
  global default → identical (and `slag` newly joins the default, a deliberate
  behavior change documented in §15.3).

## UI (`inspector-ui.ts`)

Replace the single **Force Run** button (Maintenance section) with an
**Ignore Cap** subsection: one checkbox per output resource of the building's
recipe (rotating outputs included). Default-on resources render checked on a
fresh building. Shown only for buildings whose recipe has productive outputs
(storage / power / logistics buildings have nothing a cap can throttle — no
subsection). Reuses the existing pending-ref + `defineAction` dispatch pattern;
each checkbox dispatches one resource's new value.

## Server + mutation-gateway seam

- **Intent** `set-force-run` → **`set-ignore-cap`**, payload `{ islandId,
  buildingId, resource, value: boolean }`. Server re-validates: building exists,
  `resource` is an actual output of the building def's recipe, `value` boolean.
  Writes `b.ignoreCapOverrides[resource] = value`. Normalizes an entry that
  matches the global default back out (keep the map minimal) — optional but
  keeps saves clean.
- **Gateway** (`mutation-gateway.ts`) `setForceRun(islandId, buildingId,
  value)` → **`setIgnoreCap(islandId, buildingId, resource, value)`** in both
  the LOCAL (direct pure-layer write) and REMOTE (WS `set-ignore-cap` intent)
  arms. `main.ts`'s `onSetForceRun` inspector dep → `onSetIgnoreCap`.
- **`discovery-signature.ts`** — fold a deterministic serialization of
  `ignoreCapOverrides` into the per-island fingerprint in place of `forceRun`.

## Map badge (`building-alerts-overlay.ts`)

Green level badge when `∃ r : isOutputCapExempt(b, r) === true ∧ r ∉
OUTPUT_CAP_EXEMPT` — i.e. the building forces a non-default output. (Equivalent:
any `ignoreCapOverrides` entry `{r: true}` with `r` not in the global default.)

## Spec updates (SPEC.md — same change)

- **§4.6** — rewrite "Force Run" → per-resource "Ignore Cap": the per-output
  override model, default-on set, fully-configurable semantics, the cost (still
  consumes inputs/power, still wears), badge rule.
- **§15.3 (A)** — `OUTPUT_CAP_EXEMPT` reframed as the *default-on* set (add
  `slag`); the per-building override layered on top; the solver's
  `capExemptOutputs`.
- **Maintenance note (§4.7)** — Ignore-Cap-on outputs keep a nonzero duty cycle
  (they wear), unchanged from the Force Run wording.

## Out of scope (YAGNI)

- No "ignore cap on ALL outputs" master toggle (the per-resource checkboxes
  cover it; Force-Run-style bulk is recoverable by checking each box).
- No per-floor / per-recipe-variant granularity.
- No change to `NON_STORED_OUTPUTS` (`co2`) handling.

## Integration

Full feature → branch `feat/per-resource-ignore-cap` off master, TDD per task,
PR, rebase + fast-forward (CONTRIBUTING). `master` stays green and linear.

## Test surface

- `flow-solver.test.ts` — per-resource exemption: a building with one output
  exempt and one not gates on the non-exempt bin only; an all-outputs-exempt
  building matches the old force-run behavior.
- `economy.test.ts` — `slag` no longer stalls steel_mill/smelter; a forced
  primary keeps producing for XP; an un-forced default (slag turned OFF) does
  stall.
- `persistence.test.ts` — v29 (forceRun true / false / absent) → v30 migration;
  forced building gets all-outputs overrides; round-trip identity at v30.
- `inspector-ui.test.ts` — renders one checkbox per output; toggling dispatches
  the right resource+value; no subsection for output-less buildings.
- `intents.test.ts` (server) — `set-ignore-cap` accepted for a real output,
  rejected for a non-output resource / unknown building; writes the override.
- `discovery-signature.test.ts` — overrides change the fingerprint
  deterministically; equal overrides ⇒ equal signature.
- `building-alerts-overlay` badge logic (where covered) — green only on a
  forced non-default output.
