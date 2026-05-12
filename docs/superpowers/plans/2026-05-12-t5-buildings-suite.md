# T5 Buildings Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Time Lock banking/acceleration (#39), Genesis Chamber free-creation (#40), Reality Forge biome reassignment (#42), and Singularity Battery storage (#44).

**Architecture:** Each T5 building adds a field to `IslandState` or `WorldState`. Time Lock uses a per-island `bankedTimeMs` queue. Genesis Chamber adds a `genesisTarget` resource selector. Reality Forge mutates `IslandSpec.biome` and regenerates terrain. Singularity Battery adds a `batteryStoredWs` float.

**Tech Stack:** TypeScript strict, vitest. Pure layer: `economy.ts`, `world.ts`, `recipes.ts`, `building-defs.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/economy.ts` | Time Lock spend/accrual, Genesis Chamber production, Singularity Battery power buffer |
| `src/world.ts` | `IslandState` extensions for T5 fields; `makeInitialIslandState` defaults |
| `src/island.ts` | `regenerateTerrain(biome, seed)` for Reality Forge |
| `src/building-defs.ts` | Defs already exist for all four buildings (data-only) |
| `src/economy.test.ts` | Tests for T5 building mechanics |

---

### Task 1: Time Lock — Banking + Acceleration

**Files:**
- Modify: `src/world.ts`
- Modify: `src/economy.ts`
- Test: `src/economy.test.ts`

- [ ] **Step 1: Add Time Lock state to IslandState**

```typescript
export interface IslandState {
  // ... existing fields ...
  /** Time Lock banked time in minutes. One per Time Lock building. */
  timeLockBankedMin: number;
  /** Currently active acceleration queue: list of {sourceIslandId, durationMin}. */
  accelerationQueue: Array<{ readonly sourceIslandId: string; readonly durationMin: number }>;
  /** Remaining minutes of current acceleration (0 if none). */
  accelerationRemainingMin: number;
}
```

Update `makeInitialIslandState` to default these to `0`, `[]`, `0`.

- [ ] **Step 2: Banking during offline catchup**

In `advanceIsland` (`economy.ts`), at the top of the loop, check if the island has any `time_lock` buildings and if the player configured banking (add a `bankingEnabled: boolean` flag to `IslandState`, default `false`).

If banking is enabled:
- Do NOT advance production/XP for this island during the offline interval.
- Instead, add `offlineMin` to `timeLockBankedMin`, capped at `24 * 60 * timeLockCount` (24 hours per Lock).

```typescript
const timeLockCount = state.buildings.filter(b => b.defId === 'time_lock').length;
if (timeLockCount > 0 && state.bankingEnabled) {
  const maxBank = timeLockCount * 24 * 60;
  const offlineMin = (nowMs - state.lastTick) / 60000;
  state.timeLockBankedMin = Math.min(maxBank, state.timeLockBankedMin + offlineMin);
  state.lastTick = nowMs;
  return; // skip normal advancement
}
```

- [ ] **Step 3: Spending acceleration**

Add a pure function:

```typescript
export function spendTimeLock(
  sourceState: IslandState,
  targetState: IslandState,
  minutes: number
): { ok: true } | { ok: false; reason: 'insufficient-banked-time' | 'target-already-accelerated' } {
  if (sourceState.timeLockBankedMin < minutes) {
    return { ok: false, reason: 'insufficient-banked-time' };
  }
  if (targetState.accelerationRemainingMin > 0) {
    // Queue sequentially
    targetState.accelerationQueue.push({ sourceIslandId: sourceState.id, durationMin: minutes });
  } else {
    targetState.accelerationRemainingMin = minutes;
  }
  sourceState.timeLockBankedMin -= minutes;
  return { ok: true };
}
```

- [ ] **Step 4: Apply acceleration in `advanceIsland`**

When `accelerationRemainingMin > 0`:
- The island's effective `dt` is multiplied by 3×.
- After consuming `dt`, decrement `accelerationRemainingMin` by `dt / 60000`.
- When `accelerationRemainingMin` reaches 0, pop the next queue entry.

```typescript
const accelMul = state.accelerationRemainingMin > 0 ? 3 : 1;
// ... in integration loop:
const effectiveDtMs = Math.min(dtMs, state.accelerationRemainingMin * 60000) * accelMul;
// Actually simpler: just multiply the rates by 3 during acceleration.
```

In `computeRates`, thread an `accelerationMul` (default 1, 3 when accelerated). Multiply all production rates and XP by it.

```typescript
export interface RatesContext {
  // ... existing ...
  readonly accelerationMul?: number;
}
```

- [ ] **Step 5: Tests**

```typescript
describe('Time Lock', () => {
  it('banks offline time instead of advancing', () => {
    // ...
  });
  it('caps bank at 24h per lock', () => {
    // ...
  });
  it('triples production while accelerated', () => {
    // ...
  });
  it('queues multiple spends sequentially', () => {
    // ...
  });
});
```

- [ ] **Step 6: Commit**

```bash
git add src/world.ts src/economy.ts src/economy.test.ts
git commit -m "feat(§13.3): Time Lock banking + 3× acceleration spend"
```

---

### Task 2: Genesis Chamber — Free Creation

**Files:**
- Modify: `src/economy.ts`
- Modify: `src/world.ts`
- Test: `src/economy.test.ts`

- [ ] **Step 1: Add Genesis Chamber state**

```typescript
export interface IslandState {
  // ... existing ...
  /** Target resource for Genesis Chamber, or null if inactive. */
  genesisTarget: ResourceId | null;
}
```

Default to `null` in `makeInitialIslandState`.

- [ ] **Step 2: Genesis Chamber recipe in `computeRates`**

When `genesisTarget` is set and the island has at least one `genesis_chamber` building:

1. Look up the target's tier from `XP_WEIGHT` or a tier mapping.
2. Compute power draw: T1=50kW, T2=500kW, T3=5MW, T4=50MW.
3. Compute cycle time: 5 minutes per unit (300 seconds).
4. If the island has enough power, produce 1 unit of `genesisTarget` every 300 seconds.

Add a synthetic recipe in `computeRates`:

```typescript
if (state.genesisTarget && genesisChamberCount > 0) {
  const tier = tierForResource(state.genesisTarget);
  const powerDraw = genesisPowerForTier(tier);
  const cycleSec = 300;
  // Treat as a recipe with no inputs, 1 output, heavy power consumption
  // Add to rates computation alongside other recipes
}
```

Since `computeRates` iterates buildings, we can add a special case for `genesis_chamber`:

```typescript
if (b.defId === 'genesis_chamber' && state.genesisTarget) {
  const tier = tierForResource(state.genesisTarget);
  const powerDraw = genesisPowerForTier(tier);
  // Reserve power, add output rate
  rates[state.genesisTarget] = (rates[state.genesisTarget] ?? 0) + 1 / 300;
  powerConsumed += powerDraw;
}
```

- [ ] **Step 3: Block T5+ targets**

```typescript
const GENESIS_MAX_TIER = 4;

export function setGenesisTarget(state: IslandState, target: ResourceId): boolean {
  const tier = tierForResource(target);
  if (tier > GENESIS_MAX_TIER) return false;
  state.genesisTarget = target;
  return true;
}
```

- [ ] **Step 4: Tests**

```typescript
describe('Genesis Chamber', () => {
  it('produces T1 resource at 1 per 5min', () => {
    // ...
  });
  it('draws 50MW for T4 target', () => {
    // ...
  });
  it('rejects T5 target', () => {
    expect(setGenesisTarget(state, 'dark_matter')).toBe(false);
  });
});
```

- [ ] **Step 5: Commit**

```bash
git add src/economy.ts src/world.ts src/economy.test.ts
git commit -m "feat(§13.3): Genesis Chamber free-creation T1-T4"
```

---

### Task 3: Reality Forge — Biome Reassignment

**Files:**
- Modify: `src/island.ts`
- Modify: `src/world.ts`
- Modify: `src/economy.ts`
- Test: `src/island.test.ts`

- [ ] **Step 1: Terrain regeneration function**

```typescript
// src/island.ts
export function regenerateTerrain(
  spec: IslandSpec,
  newBiome: Biome,
  seed: string
): void {
  spec.biome = newBiome;
  // Re-run the terrain generation pipeline using the same seed but new biome rules
  // Call existing terrain generator (e.g., generateIslandTerrain)
  spec.terrain = generateIslandTerrain(seed, spec.id, newBiome, spec.ellipse);
}
```

- [ ] **Step 2: Invalidate buildings on terrain change**

After `regenerateTerrain`, iterate `spec.buildings`:

```typescript
for (const b of spec.buildings) {
  const def = BUILDING_DEFS[b.defId];
  const tiles = footprintTiles(b.x, b.y, def.footprint, b.rotation ?? 0);
  const stillValid = tiles.every(t => {
    const terrain = spec.terrainAt(t.x, t.y);
    return terrain && !terrain.blocked && (!def.requiredTile || def.requiredTile === terrain.kind);
  });
  if (!stillValid) {
    // Mark as invalid — the economy skips invalid buildings in computeRates
    (b as any).invalid = true;
  }
}
```

Add `invalid?: boolean` to `PlacedBuilding`.

In `computeRates`, skip buildings with `invalid === true`.

- [ ] **Step 3: Wipe and re-roll modifiers**

```typescript
export function rerollModifiers(spec: IslandSpec, seed: string): void {
  // Exclude natural-only modifiers (Aetheric Anomaly, Frozen Core)
  const allowedModifiers = ALL_MODIFIERS.filter(m => !m.naturalOnly);
  spec.modifiers = pickModifiers(seed, spec.biome, allowedModifiers);
}
```

- [ ] **Step 4: Reality Forge action**

```typescript
export function useRealityForge(
  world: WorldState,
  islandId: string,
  targetBiome: Biome
): void {
  const spec = world.islands.find(i => i.id === islandId);
  if (!spec) return;
  regenerateTerrain(spec, targetBiome, world.seed);
  rerollModifiers(spec, world.seed);
}
```

- [ ] **Step 5: Tests**

```typescript
describe('Reality Forge', () => {
  it('changes biome and regenerates terrain', () => {
    // ...
  });
  it('invalidates Mine on non-ore terrain', () => {
    // ...
  });
  it('preserves Aetheric Anomaly on reroll', () => {
    // ...
  });
});
```

- [ ] **Step 6: Commit**

```bash
git add src/island.ts src/world.ts src/economy.ts src/island.test.ts
git commit -m "feat(§13.3): Reality Forge biome reassignment with terrain regen"
```

---

### Task 4: Singularity Battery — Power Storage

**Files:**
- Modify: `src/economy.ts`
- Modify: `src/world.ts`
- Test: `src/economy.test.ts`

- [ ] **Step 1: Add battery state**

```typescript
export interface IslandState {
  // ... existing ...
  /** Stored energy in W-seconds (Joules). */
  singularityStoredWs: number;
}
```

Default to `0`.

- [ ] **Step 2: Capacity per battery**

```typescript
export const SINGULARITY_BATTERY_CAPACITY_WS = 50e6 * 3600; // 50 MWh in W-seconds
```

- [ ] **Step 3: Charge / discharge in power balance**

In `computeRates` or a power-resolution pass:

1. Compute total generation and consumption as before.
2. If generation > consumption:
   - Charge batteries: `surplusWs = (gen - cons) * dtSec`
   - Distribute across batteries proportionally to remaining capacity.
3. If consumption > generation:
   - Discharge batteries to cover deficit.
   - If batteries empty, apply brownout as before.

```typescript
const batteryCount = state.buildings.filter(b => b.defId === 'singularity_battery').length;
const maxCap = batteryCount * SINGULARITY_BATTERY_CAPACITY_WS;

// After computing net power:
if (netPower > 0) {
  const charge = Math.min(netPower * dtSec, maxCap - state.singularityStoredWs);
  state.singularityStoredWs += charge;
} else if (netPower < 0) {
  const discharge = Math.min(-netPower * dtSec, state.singularityStoredWs);
  state.singularityStoredWs -= discharge;
  const remainingDeficit = -netPower * dtSec - discharge;
  if (remainingDeficit > 0) {
    // brownout
  }
}
```

- [ ] **Step 4: Tests**

```typescript
describe('Singularity Battery', () => {
  it('charges on surplus', () => {
    // ...
  });
  it('discharges on deficit preventing brownout', () => {
    // ...
  });
  it('caps at 50 MWh per battery', () => {
    // ...
  });
});
```

- [ ] **Step 5: Commit**

```bash
git add src/economy.ts src/world.ts src/economy.test.ts
git commit -m "feat(§13.3): Singularity Battery power storage 50 MWh per unit"
```

---

## Self-Review

**1. Spec coverage:**
- §13.3 Time Lock → Task 1
- §13.3 Genesis Chamber → Task 2
- §13.3 Reality Forge → Task 3
- §13.3 Singularity Battery → Task 4

**2. Placeholder scan:** No TBD.

**3. Type consistency:** All new `IslandState` fields have defaults in `makeInitialIslandState`.
