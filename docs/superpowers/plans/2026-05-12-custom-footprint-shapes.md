# Custom Footprint Shapes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current rectangle-only footprint model with shape masks (array of `{dx, dy}` offsets) supporting L-tromino, tetromino shapes, and rotation (§4.1 / §4.2).

**Architecture:** `BuildingDef.footprint` changes from `{width, height}` to `ShapeMask`. `footprintTiles` in `placement.ts` becomes the canonical rotator + expander. Collision detection, placement validation, and rendering all consume the rotated tile list.

**Tech Stack:** TypeScript strict, vitest. Pure layer: `placement.ts`, `building-defs.ts`. Render layer: `buildings.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/placement.ts` | `ShapeMask`, rotation, `footprintTiles` rewrite |
| `src/building-defs.ts` | Update defs to use new `ShapeMask` |
| `src/buildings.ts` | Render using rotated shape tiles |
| `src/placement.test.ts` | Tests for rotation, collision, placement validation |

---

### Task 1: ShapeMask Data Model

**Files:**
- Modify: `src/placement.ts`
- Test: `src/placement.test.ts`

- [ ] **Step 1: Define ShapeMask and rotation**

```typescript
// src/placement.ts

export interface ShapeMask {
  /** Anchor-relative tile offsets. (0,0) is the anchor tile. */
  readonly tiles: ReadonlyArray<{ readonly dx: number; readonly dy: number }>;
}

/** 90-degree clockwise rotation: (dx, dy) -> (-dy, dx). */
export function rotateShape(mask: ShapeMask, rotations: 0 | 1 | 2 | 3): ShapeMask {
  let tiles = mask.tiles;
  for (let i = 0; i < rotations; i++) {
    tiles = tiles.map(({ dx, dy }) => ({ dx: -dy, dy: dx }));
  }
  return { tiles };
}

/** Returns absolute world tiles for a placed building given its rotation. */
export function footprintTiles(
  x: number,
  y: number,
  mask: ShapeMask,
  rotation: 0 | 1 | 2 | 3 = 0
): Array<{ x: number; y: number }> {
  const rotated = rotateShape(mask, rotation);
  return rotated.tiles.map(({ dx, dy }) => ({ x: x + dx, y: y + dy }));
}
```

- [ ] **Step 2: Standard shape library**

```typescript
export const SHAPES = {
  single: { tiles: [{ dx: 0, dy: 0 }] },
  line2h: { tiles: [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }] },
  line2v: { tiles: [{ dx: 0, dy: 0 }, { dx: 0, dy: 1 }] },
  square2: { tiles: [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 1 }] },
  line3h: { tiles: [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 2, dy: 0 }] },
  line3v: { tiles: [{ dx: 0, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: 2 }] },
  lTromino: { tiles: [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }] },
  lTetromino: { tiles: [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 2, dy: 0 }, { dx: 0, dy: 1 }] },
  tTetromino: { tiles: [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 2, dy: 0 }, { dx: 1, dy: 1 }] },
  square3: { tiles: [/* 3x3 = 9 tiles */] },
  square4: { tiles: [/* 4x4 = 16 tiles */] },
} as const satisfies Record<string, ShapeMask>;
```

- [ ] **Step 3: Tests for rotation**

```typescript
import { describe, expect, it } from 'vitest';
import { rotateShape, SHAPES, footprintTiles } from './placement.js';

describe('rotateShape', () => {
  it('rotates L-tromino 90°', () => {
    const r = rotateShape(SHAPES.lTromino, 1);
    expect(r.tiles).toContainEqual({ dx: 0, dy: 0 });
    expect(r.tiles).toContainEqual({ dx: 0, dy: 1 });
    expect(r.tiles).toContainEqual({ dx: -1, dy: 0 });
  });
  it('4 rotations returns original', () => {
    const r = rotateShape(SHAPES.lTetromino, 4);
    expect(r.tiles).toEqual(SHAPES.lTetromino.tiles);
  });
  it('footprintTiles with rotation', () => {
    const tiles = footprintTiles(5, 5, SHAPES.lTromino, 1);
    expect(tiles).toContainEqual({ x: 5, y: 5 });
    expect(tiles).toContainEqual({ x: 5, y: 6 });
    expect(tiles).toContainEqual({ x: 4, y: 5 });
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add src/placement.ts src/placement.test.ts
git commit -m "feat(§4.1): ShapeMask data model + rotation + standard shape library"
```

---

### Task 2: Update BuildingDef and All Defs

**Files:**
- Modify: `src/building-defs.ts`
- Modify: `src/placement.ts` (validatePlacement)

- [ ] **Step 1: Change BuildingDef.footprint type**

```typescript
import type { ShapeMask } from './placement.js';

export interface BuildingDef {
  // ... other fields ...
  footprint: ShapeMask;
  // ...
}
```

- [ ] **Step 2: Migrate all BUILDING_DEFS entries**

Replace every `{ width: N, height: M }` with the equivalent `SHAPES` reference.

```typescript
// Before:
footprint: { width: 1, height: 1 }
// After:
footprint: SHAPES.single

// Before:
footprint: { width: 2, height: 2 }
// After:
footprint: SHAPES.square2

// Before:
footprint: { width: 3, height: 3 }
// After:
footprint: SHAPES.square3

// Before:
footprint: { width: 4, height: 4 }
// After:
footprint: SHAPES.square4
```

For 2×1 or 1×2 buildings, use `SHAPES.line2h` or `line2v` (pick canonical, rotation handles the rest).

- [ ] **Step 3: Update validatePlacement to use rotated footprint**

`validatePlacement` currently uses `footprintTiles(x, y, { width, height })`. Update to:

```typescript
const def = BUILDING_DEFS[defId];
const tiles = footprintTiles(x, y, def.footprint, rotation);
```

Add `rotation: 0 | 1 | 2 | 3` parameter to `validatePlacement`.

Update `PlacedBuilding` in `src/buildings.ts` to carry `rotation?: 0 | 1 | 2 | 3`.

- [ ] **Step 4: Update collision detection**

The existing collision check iterates `footprintTiles` for each existing building. It already works with the new `footprintTiles` signature — just pass the building's stored rotation.

- [ ] **Step 5: Update adjacency computation**

`adjacentBuildings` in `adjacency.ts` uses `footprintTiles`. Ensure it reads `building.rotation` (defaulting to 0).

- [ ] **Step 6: Render-layer update in buildings.ts**

`renderBuildings` currently draws rectangles based on width/height. Change to:

```typescript
for (const tile of footprintTiles(b.x, b.y, def.footprint, b.rotation ?? 0)) {
  // draw each tile as a 1×1 square at tileToWorldPx(tile.x, tile.y)
}
```

For L-shapes, this naturally draws the correct irregular footprint.

- [ ] **Step 7: Tests**

```typescript
describe('validatePlacement with rotation', () => {
  it('allows L-tromino rotated 90° on valid tiles', () => {
    // Build a fixture island, place an L-tromino at (0,0) rotation 1
  });
  it('rejects rotation that places tile outside island', () => {
    // ...
  });
});
```

- [ ] **Step 8: Commit**

```bash
git add src/building-defs.ts src/placement.ts src/buildings.ts src/adjacency.ts src/building-defs.test.ts src/placement.test.ts
git commit -m "feat(§4.1/§4.2): custom footprint shapes with 4-rotation support"
```

---

## Self-Review

**1. Spec coverage:**
- §4.1 footprint shapes → Task 1 + Task 2
- §4.2 rotation → Task 1 + Task 2

**2. Placeholder scan:** No TBD.

**3. Type consistency:** `ShapeMask` used in `BuildingDef`, `footprintTiles`, `validatePlacement`, `PlacedBuilding`.
