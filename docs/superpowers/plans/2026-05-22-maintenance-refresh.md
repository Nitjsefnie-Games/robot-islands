# Manual maintenance-refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the player a one-click "maintenance refresh" on a building — pay half the building's placement-cost materials to snap its §4.7 maintenance state back to pristine.

**Architecture:** Two pure helpers in `maintenance.ts` (`refreshCostFor`, `tryRefreshMaintenance`) carry all the logic — affordability, half-cost deduction, state reset — fully unit-tested. `inspector-ui.ts` only wires a REFRESH button (in the footer, above DEMOLISH) to `tryRefreshMaintenance`. No change to `placement.ts`, `economy.ts`, `persistence.ts`, or `main.ts`.

**Tech Stack:** TypeScript (strict), Vite 5, PixiJS 8, vitest. Pure layer is unit-tested; render layer is verified by clean build + a daedalus live check.

**Spec:** `docs/superpowers/specs/2026-05-22-maintenance-refresh-design.md`

---

## File structure

| File | Change |
|---|---|
| `src/maintenance.ts` | Add `refreshCostFor` and `tryRefreshMaintenance`; add a value import of `affordabilityShortfall` from `placement.ts`. |
| `src/maintenance.test.ts` | New tests for both helpers. |
| `src/inspector-ui.ts` | A REFRESH button in `footerSection` above `demolishBtn`, its click handler, and its paint logic in the maintenance-section paint pass. |

`placement.ts` / `economy.ts` / `persistence.ts` / `main.ts` are **not** touched. `operatingMs` and `maintainedAt` are already persisted fields, so a refresh that mutates them needs no persistence change.

---

## Task 1: `refreshCostFor` — the half-cost basket helper

**Files:**
- Modify: `src/maintenance.ts` (add helper near `maintenanceRecipeFor`)
- Test: `src/maintenance.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/maintenance.test.ts`:

```ts
describe('refreshCostFor', () => {
  it('halves each placement-cost resource, floored', () => {
    const def = { placementCost: { stone: 60, wood: 30, iron_ingot: 20 } } as BuildingDef;
    expect(refreshCostFor(def)).toEqual({ stone: 30, wood: 15, iron_ingot: 10 });
  });
  it('drops a resource whose half rounds to 0', () => {
    const def = { placementCost: { stone: 7, wood: 1 } } as BuildingDef;
    expect(refreshCostFor(def)).toEqual({ stone: 3 });
  });
  it('returns {} for a def with no placementCost', () => {
    expect(refreshCostFor({} as BuildingDef)).toEqual({});
  });
});
```

In `src/maintenance.test.ts`, the import from `./building-defs.js` currently pulls only `BUILDING_DEFS`. Extend it to also import the type:

```ts
import { BUILDING_DEFS, type BuildingDef } from './building-defs.js';
```

Add `refreshCostFor` to the import from `./maintenance.js` (the test file's existing `import { ... } from './maintenance.js'` block).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/maintenance.test.ts -t refreshCostFor`
Expected: FAIL — `refreshCostFor is not a function`.

- [ ] **Step 3: Implement the helper**

In `src/maintenance.ts`, add (after `maintenanceRecipeFor`, before `tryAutoMaintain`):

```ts
/** The 50%-of-placement-cost basket for a manual maintenance refresh.
 *  Math.floor per-resource (matching demolishBuilding's refund rounding);
 *  entries whose half rounds to 0 are dropped. Empty record when the def
 *  has no placementCost. */
export function refreshCostFor(def: BuildingDef): Partial<Record<ResourceId, number>> {
  const out: Partial<Record<ResourceId, number>> = {};
  for (const [r, n] of Object.entries(def.placementCost ?? {}) as Array<[ResourceId, number]>) {
    const half = Math.floor(n / 2);
    if (half <= 0) continue;
    out[r] = half;
  }
  return out;
}
```

`BuildingDef` and `ResourceId` are already imported as types in `maintenance.ts` — no new import needed for this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/maintenance.test.ts -t refreshCostFor`
Expected: PASS — all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/maintenance.ts src/maintenance.test.ts
git commit -m "feat(maintenance): refreshCostFor — 50% placement-cost basket

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 2: `tryRefreshMaintenance` — the refresh action

**Files:**
- Modify: `src/maintenance.ts` (add helper after `tryAutoMaintain`; add a value import)
- Test: `src/maintenance.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/maintenance.test.ts`. These use the file's existing `mkBuilding(defId, operatingMs)` and `blankInventory()` helpers, the real `BUILDING_DEFS.heavy_logger` (tier 2, `placementCost { stone: 60, wood: 30, iron_ingot: 20 }` → refresh cost `{ stone: 30, wood: 15, iron_ingot: 10 }`), and `MAINTENANCE_THRESHOLD_MS_BY_TIER`:

```ts
describe('tryRefreshMaintenance', () => {
  const T2_THRESHOLD = MAINTENANCE_THRESHOLD_MS_BY_TIER[2];
  const HEAVY = BUILDING_DEFS.heavy_logger;

  function stockedInventory(): Record<ResourceId, number> {
    const inv = blankInventory();
    inv.stone = 100;
    inv.wood = 100;
    inv.iron_ingot = 100;
    return inv;
  }

  it('refreshes a degraded building: deducts half cost, resets operatingMs', () => {
    const b = mkBuilding('heavy_logger', T2_THRESHOLD + HOUR);
    const inv = stockedInventory();
    const ok = tryRefreshMaintenance(b, HEAVY, inv, 5000);
    expect(ok).toBe(true);
    expect(inv.stone).toBe(70);
    expect(inv.wood).toBe(85);
    expect(inv.iron_ingot).toBe(90);
    expect(b.operatingMs).toBe(0);
    expect(b.maintainedAt).toBe(5000);
    expect(b.placedAt).toBe(0);
  });

  it('refuses a pristine building (operatingMs below threshold), mutates nothing', () => {
    const b = mkBuilding('heavy_logger', T2_THRESHOLD - HOUR);
    const inv = stockedInventory();
    expect(tryRefreshMaintenance(b, HEAVY, inv, 5000)).toBe(false);
    expect(inv.stone).toBe(100);
    expect(b.operatingMs).toBe(T2_THRESHOLD - HOUR);
  });

  it('refuses an Eternal Servitor, mutates nothing', () => {
    const b = { ...mkBuilding('heavy_logger', T2_THRESHOLD + HOUR), eternalServitor: true };
    const inv = stockedInventory();
    expect(tryRefreshMaintenance(b, HEAVY, inv, 5000)).toBe(false);
    expect(inv.stone).toBe(100);
  });

  it('refuses a def with no placementCost (free refresh disallowed)', () => {
    const b = mkBuilding('heavy_logger', T2_THRESHOLD + HOUR);
    const def = { tier: 2 } as BuildingDef;
    const inv = stockedInventory();
    expect(tryRefreshMaintenance(b, def, inv, 5000)).toBe(false);
    expect(inv.stone).toBe(100);
  });

  it('refuses and mutates nothing when inventory is short on any one resource', () => {
    const b = mkBuilding('heavy_logger', T2_THRESHOLD + HOUR);
    const inv = stockedInventory();
    inv.iron_ingot = 5; // need 10
    expect(tryRefreshMaintenance(b, HEAVY, inv, 5000)).toBe(false);
    expect(inv.stone).toBe(100); // atomicity — nothing consumed
    expect(inv.wood).toBe(100);
    expect(b.operatingMs).toBe(T2_THRESHOLD + HOUR);
  });

  it('honours thresholdMul — a building past base but below scaled threshold is pristine', () => {
    const b = mkBuilding('heavy_logger', T2_THRESHOLD + HOUR);
    const inv = stockedInventory();
    expect(tryRefreshMaintenance(b, HEAVY, inv, 5000, 2)).toBe(false);
    expect(inv.stone).toBe(100);
  });

  it('result matches tryAutoMaintain — both leave factor 1.0', () => {
    const b = mkBuilding('heavy_logger', T2_THRESHOLD + HOUR);
    tryRefreshMaintenance(b, HEAVY, stockedInventory(), 5000);
    expect(maintenanceFactor(b, HEAVY)).toBe(1.0);
  });
});
```

Add `tryRefreshMaintenance` to the test file's `import { ... } from './maintenance.js'` block. (`maintenanceFactor`, `MAINTENANCE_THRESHOLD_MS_BY_TIER`, `HOUR`, `mkBuilding`, `blankInventory` are already available in the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/maintenance.test.ts -t tryRefreshMaintenance`
Expected: FAIL — `tryRefreshMaintenance is not a function`.

- [ ] **Step 3: Implement the helper**

In `src/maintenance.ts`, add a value import near the top (the existing imports are all `import type`; this is the first value import):

```ts
import { affordabilityShortfall } from './placement.js';
```

(`placement.ts` imports nothing from `maintenance.ts`, so this one-directional edge creates no module cycle.)

Add the helper after `tryAutoMaintain`:

```ts
/** Player-triggered maintenance refresh — a manual lump-sum alternative to
 *  the automatic §4.7 supply loop. Consumes 50% of the building's placement
 *  cost (`refreshCostFor`) from `inventory`, then resets the building to
 *  pristine maintenance state (operatingMs = 0, maintainedAt = nowMs) —
 *  exactly the reset `tryAutoMaintain` performs.
 *
 *  Atomic: every halved-cost input is checked present before any is
 *  consumed. Returns false WITHOUT mutating anything when the refresh is not
 *  allowed — Eternal Servitor, building already pristine
 *  (maintenanceFactor >= 1.0), empty placement cost (a free refresh is
 *  disallowed), or inventory short on any halved-cost resource. */
export function tryRefreshMaintenance(
  b: PlacedBuilding,
  def: BuildingDef,
  inventory: Record<ResourceId, number>,
  nowMs: number,
  thresholdMul = 1,
): boolean {
  if (b.eternalServitor === true) return false;
  if (maintenanceFactor(b, def, thresholdMul) >= 1.0) return false;
  const cost = refreshCostFor(def);
  if (Object.keys(cost).length === 0) return false;
  if (Object.keys(affordabilityShortfall(inventory, cost)).length > 0) return false;
  for (const [r, need] of Object.entries(cost) as Array<[ResourceId, number]>) {
    inventory[r] = (inventory[r] ?? 0) - need;
  }
  (b as { operatingMs: number; maintainedAt: number }).operatingMs = 0;
  (b as { operatingMs: number; maintainedAt: number }).maintainedAt = nowMs;
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/maintenance.test.ts`
Expected: PASS — all maintenance tests, including the new `tryRefreshMaintenance` block.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS — all test files, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/maintenance.ts src/maintenance.test.ts
git commit -m "feat(maintenance): tryRefreshMaintenance — player-triggered refresh

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Task 3: REFRESH button in the inspector footer (inspector-ui.ts)

Render-layer task — no unit test; verified by clean build + a live browser check.

**Files:**
- Modify: `src/inspector-ui.ts` (imports; a new `refreshBtn` before `demolishBtn` ~line 983; paint logic in the maintenance-section paint pass ~line 1357-1388)

- [ ] **Step 1: Update imports**

In `src/inspector-ui.ts`, the existing import from `./maintenance.js` pulls `maintenanceFactor` and `MAINTENANCE_THRESHOLD_MS_BY_TIER` (used by the maintenance paint). Extend it to also import the two new helpers:

```ts
import {
  maintenanceFactor,
  MAINTENANCE_RECIPES,
  MAINTENANCE_THRESHOLD_MS_BY_TIER,
  refreshCostFor,
  tryRefreshMaintenance,
} from './maintenance.js';
```

(Match the file's actual existing `./maintenance.js` import list — keep whatever symbols it already imports, and add `refreshCostFor` + `tryRefreshMaintenance`. `affordabilityShortfall` from `./placement.js` is also needed for the paint label — confirm it is imported; if `inspector-ui.ts` does not already import it, add `affordabilityShortfall` to the existing `./placement.js` import.)

- [ ] **Step 2: Create the REFRESH button above DEMOLISH**

In `src/inspector-ui.ts`, immediately **before** the `const demolishBtn = document.createElement('button');` line (~983), add the REFRESH button. Its styling copies `convertBtn` (the industrial-readout button, ~line 856-872):

```ts
  const refreshBtn = document.createElement('button');
  styled(
    refreshBtn,
    [
      'background: transparent',
      `color: ${'var(--ri-accent)'}`,
      `border: 1px solid ${'var(--ri-accent-dim)'}`,
      'padding: 4px 8px',
      'cursor: pointer',
      'font-family: ui-monospace, monospace',
      'font-size: 10.5px',
      'letter-spacing: 0.08em',
      'text-transform: uppercase',
      'border-radius: 2px',
      'transition: background 80ms ease, border-color 80ms ease',
      'text-align: left',
      'margin-bottom: 4px',
    ].join(';'),
  );
  refreshBtn.style.display = 'none';
  refreshBtn.addEventListener('mouseenter', () => {
    if (refreshBtn.disabled) return;
    refreshBtn.style.background = 'rgba(125, 211, 232, 0.08)';
    refreshBtn.style.borderColor = 'var(--ri-accent)';
  });
  refreshBtn.addEventListener('mouseleave', () => {
    refreshBtn.style.background = 'transparent';
    refreshBtn.style.borderColor = refreshBtn.disabled ? 'var(--ri-fg-4)' : 'var(--ri-accent-dim)';
  });
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
  footerSection.appendChild(refreshBtn);
```

The existing `footerSection.appendChild(demolishBtn);` line stays as-is — since `refreshBtn` is appended first, it renders directly above DEMOLISH.

- [ ] **Step 3: Paint the REFRESH button in the maintenance-section paint**

In the maintenance-section paint pass (~line 1357-1388), `refreshBtn` must be shown/hidden/labelled per building state.

In the **Eternal Servitor branch** (`if (building.eternalServitor === true) { ... }`), add:

```ts
      refreshBtn.style.display = 'none';
```

In the **`else` branch** (non-Servitor), after the existing `maintenanceRecipeLine` lines and before `maintenanceSection.wrap.style.display = '';`, add:

```ts
      const refreshCost = refreshCostFor(def);
      const refreshFactor = maintenanceFactor(building, def, skillMul.maintenanceThreshold);
      if (Object.keys(refreshCost).length === 0 || refreshFactor >= 1.0) {
        refreshBtn.style.display = 'none';
      } else {
        const missing = affordabilityShortfall(state.inventory, refreshCost);
        const parts: string[] = [];
        for (const [r, need] of Object.entries(refreshCost)) {
          const have = state.inventory[r as ResourceId] ?? 0;
          parts.push(`${need} ${r} (${have})`);
        }
        refreshBtn.textContent = `REFRESH · ${parts.join(', ')}`;
        refreshBtn.disabled = Object.keys(missing).length > 0;
        refreshBtn.style.display = '';
        if (refreshBtn.disabled) {
          refreshBtn.style.color = 'var(--ri-fg-4)';
          refreshBtn.style.borderColor = 'var(--ri-fg-4)';
          refreshBtn.style.cursor = 'not-allowed';
          refreshBtn.style.opacity = '0.6';
        } else {
          refreshBtn.style.color = 'var(--ri-accent)';
          refreshBtn.style.borderColor = 'var(--ri-accent-dim)';
          refreshBtn.style.cursor = 'pointer';
          refreshBtn.style.opacity = '1';
        }
      }
```

This mirrors the `convertBtn` paint exactly (~line 1413-1426). `skillMul` is already in scope in `paint()` (`const skillMul = effectiveSkillMultipliers(state);`, ~line 1240) — use it; if it is not in scope at the maintenance-section paint point, compute `effectiveSkillMultipliers(state).maintenanceThreshold` inline instead.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: `tsc -b` clean (no unused-import / type errors), `vite build` succeeds. Fix any error and rebuild until clean.

- [ ] **Step 5: Live verification**

Reload `https://islands.nitjsefni.eu/`. Select a building that has accrued maintenance debt (its inspector maintenance line shows `OVERDUE — degraded to NN%`). Confirm:
- A `REFRESH · <cost>` button appears in the inspector footer, directly above DEMOLISH.
- When the island can't afford the half-cost, the button is disabled (greyed, `not-allowed`).
- Clicking it (when affordable) consumes the materials and the maintenance line flips to `0h 00m / Th 00m`; the REFRESH button then hides (building is pristine).
- For a pristine building, an Eternal Servitor, or a non-maintained building (power/storage), no REFRESH button shows.

Screenshot via `mcp__daedalus__screenshot` to confirm.

- [ ] **Step 6: Commit**

```bash
git add src/inspector-ui.ts
git commit -m "feat(maintenance): REFRESH button in the inspector footer

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Notes for the implementer

- The `Co-Authored-By` trailer must name the model that authored the commit (`Kimi K2.6 <noreply@kimi.com>` for a kimi subagent).
- The dev service serves built `dist/` with no HMR — live verification needs `npm run build` first, then a manual browser reload. Do **not** restart `robot-islands-dev.service`.
- Tasks 1-2 are pure and fully unit-tested. Task 3 is render layer: correctness is confirmed by a clean build + a daedalus screenshot, per the repo's pure-layer-only test discipline.
- `placementCostFor` (`placement.ts`) is NOT used — `refreshCostFor` reads `def.placementCost` directly, the same source `placementCostFor` wraps. No need to route through it.
