# Settlement Vehicle Loadouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement per-tier settlement vehicle stats (speed, fuel efficiency, payload capacity) per §12.6.

**Architecture:** Replace hardcoded T1 ship / T2 helicopter constants with tiered lookup tables. Vehicle records carry their computed stats at dispatch time. Loadout determines Foundation Kit count and starter buildings on arrival.

**Tech Stack:** TypeScript strict, vitest. Pure layer: `settlement.ts`, `recipes.ts`, `building-defs.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/settlement.ts` | Tiered vehicle tables, dispatch logic, arrival loadout application |
| `src/settlement.test.ts` | Tests for per-tier stats and loadouts |
| `src/building-defs.ts` | Starter building defs (no changes needed) |
| `src/world.ts` | `makeInitialIslandState` may need starter building placement helper |

---

### Task 1: Per-Tier Vehicle Stats

**Files:**
- Modify: `src/settlement.ts`
- Test: `src/settlement.test.ts`

- [ ] **Step 1: Define tiered stat tables**

```typescript
// src/settlement.ts

export interface VehicleStats {
  readonly speed: number; // tiles/sec
  readonly fuelEfficiency: number; // tiles per fuel unit
  readonly maxKits: number; // Foundation Kits carried
  readonly failureRate: number; // §12.5 mechanical failure
  readonly weatherMultiplier: number; // §2.6
}

export const SHIP_STATS: Record<VehicleTier, VehicleStats> = {
  1: { speed: 0.5, fuelEfficiency: 8, maxKits: 1, failureRate: 0.02, weatherMultiplier: 1.0 },
  2: { speed: 0.6, fuelEfficiency: 12, maxKits: 2, failureRate: 0.015, weatherMultiplier: 0.9 },
  3: { speed: 0.8, fuelEfficiency: 16, maxKits: 2, failureRate: 0.01, weatherMultiplier: 0.8 },
  4: { speed: 1.0, fuelEfficiency: 20, maxKits: 2, failureRate: 0.005, weatherMultiplier: 0.7 },
};

export const HELICOPTER_STATS: Record<VehicleTier, VehicleStats> = {
  1: { speed: 0, fuelEfficiency: 0, maxKits: 0, failureRate: 0, weatherMultiplier: 0 }, // no T1 heli
  2: { speed: 1.2, fuelEfficiency: 6, maxKits: 1, failureRate: 0.01, weatherMultiplier: 1.2 },
  3: { speed: 1.5, fuelEfficiency: 8, maxKits: 1, failureRate: 0.008, weatherMultiplier: 1.0 },
  4: { speed: 2.0, fuelEfficiency: 10, maxKits: 2, failureRate: 0.005, weatherMultiplier: 0.7 },
};
```

- [ ] **Step 2: Update `dispatchVehicle` to use tiered stats**

Replace hardcoded `SHIP_SPEED`, `HELI_SPEED`, etc. with table lookups:

```typescript
const stats = kind === 'ship' ? SHIP_STATS[tier] : HELICOPTER_STATS[tier];
if (!stats || stats.speed === 0) {
  return { ok: false, reason: 'invalid-tier-for-kind' };
}

const travelTimeSec = distanceTiles / stats.speed;
const fuelNeeded = Math.ceil(distanceTiles / stats.fuelEfficiency);
// ...
```

- [ ] **Step 3: Update `SettlementVehicle` interface**

Remove hardcoded weather multiplier and failure rate constants; they now come from the tier table. Ensure `speed` on the record matches the table.

- [ ] **Step 4: Update arrival loadouts**

In `tickVehicles`, on arrival:

```typescript
const stats = vehicle.kind === 'ship'
  ? SHIP_STATS[vehicle.tier]
  : HELICOPTER_STATS[vehicle.tier];

// Kits consumed = min(vehicle.foundationKitCount, stats.maxKits)
// Apply richer starter state based on tier
const starterBuildings = computeStarterBuildings(vehicle.kind, vehicle.tier);
const starterInventory = computeStarterInventory(vehicle.tier, vehicle.foundationKitCount);
const freeSkillPoints = computeFreeSkillPoints(vehicle.tier);
```

Per §12.4 table:

```typescript
function computeStarterBuildings(kind: VehicleKind, tier: VehicleTier): PlacedBuilding[] {
  if (kind === 'ship' && tier >= 3) {
    return [
      { defId: 'solar', x: 0, y: 0 },
      { defId: 'workshop', x: 2, y: 0 },
      { defId: 'mine', x: 4, y: 0 }, // or logger, based on dominant terrain
    ];
  }
  if (kind === 'helicopter' && tier >= 3) {
    return [
      { defId: 'solar', x: 0, y: 0 },
      { defId: 'workshop', x: 2, y: 0 },
    ];
  }
  if (tier >= 4) {
    return [
      { defId: 'solar', x: 0, y: 0 },
      { defId: 'workshop', x: 2, y: 0 },
      { defId: 'mine', x: 4, y: 0 },
      { defId: 'coal_gen', x: 6, y: 0 },
      { defId: 'crate', x: 8, y: 0 },
    ];
  }
  return []; // T1/T2 basic: just dock/helipad
}
```

- [ ] **Step 5: Tests**

```typescript
describe('per-tier vehicle stats', () => {
  it('T3 ship is faster than T1 ship', () => {
    expect(SHIP_STATS[3].speed).toBeGreaterThan(SHIP_STATS[1].speed);
  });
  it('T4 VTOL carries 2 kits', () => {
    expect(HELICOPTER_STATS[4].maxKits).toBe(2);
  });
  it('T3 carrier drops starter buildings', () => {
    const buildings = computeStarterBuildings('ship', 3);
    expect(buildings.some(b => b.defId === 'solar')).toBe(true);
  });
  it('T1 ship has 2% failure rate', () => {
    expect(SHIP_STATS[1].failureRate).toBe(0.02);
  });
});
```

- [ ] **Step 6: Commit**

```bash
git add src/settlement.ts src/settlement.test.ts
git commit -m "feat(§12.6): per-tier settlement vehicle stats and loadouts"
```

---

## Self-Review

**1. Spec coverage:**
- §12.6 vehicle tier table → Task 1
- §12.4 richer starter drops → Task 1 Step 4

**2. Placeholder scan:** No TBD.

**3. Type consistency:** `VehicleStats` table indexed by `VehicleTier`.
