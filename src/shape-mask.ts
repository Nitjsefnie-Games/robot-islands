// Shape-mask primitives — pure data + tile math.
//
// Centralised here to avoid a runtime import cycle between building-defs.ts
// (which needs SHAPES to populate BUILDING_DEFS) and placement.ts (which
// needs BUILDING_DEFS for validation).

export interface ShapeMask {
  readonly tiles: ReadonlyArray<{ readonly dx: number; readonly dy: number }>;
}

export function shapeWidth(mask: ShapeMask): number {
  if (mask.tiles.length === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const { dx } of mask.tiles) {
    if (dx < min) min = dx;
    if (dx > max) max = dx;
  }
  return max - min + 1;
}

export function shapeHeight(mask: ShapeMask): number {
  if (mask.tiles.length === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const { dy } of mask.tiles) {
    if (dy < min) min = dy;
    if (dy > max) max = dy;
  }
  return max - min + 1;
}

export function rotateShape(mask: ShapeMask, rotations: number): ShapeMask {
  let tiles = mask.tiles;
  for (let i = 0; i < rotations; i++) {
    tiles = tiles.map(({ dx, dy }) => ({ dx: dy === 0 ? 0 : -dy, dy: dx }));
  }
  return { tiles };
}

/** 4-way rotation in 90° CW increments. 0 = identity, 1 = 90° CW, etc. */
export type Rotation = 0 | 1 | 2 | 3;

/**
 * All tile coordinates a footprint covers when its anchor sits at
 * `(anchorX, anchorY)` under the given rotation.
 *
 * Convention: rotation pivots around the anchor and stays anchored at the
 * top-left of the AXIS-ALIGNED bounding box that wraps the rotated shape.
 * For a w×h rectangle the bounding box is (w × h) on rotations 0/2 and
 * (h × w) on rotations 1/3. The set of tiles a 2×3 rectangle covers under
 * rotation 1 is therefore a 3×2 axis-aligned block at the same anchor —
 * just with the original "width axis" now running vertically. This matches
 * the §4.2 spec where rotation does not move the placement origin, only
 * reshapes the footprint extent.
 */
export function footprintTiles(
  mask: ShapeMask,
  anchorX: number,
  anchorY: number,
  rotation: Rotation,
): ReadonlyArray<{ readonly x: number; readonly y: number }> {
  const rotated = rotateShape(mask, rotation);
  let minDx = Infinity;
  let minDy = Infinity;
  for (const { dx, dy } of rotated.tiles) {
    if (dx < minDx) minDx = dx;
    if (dy < minDy) minDy = dy;
  }
  return rotated.tiles.map(({ dx, dy }) => ({
    x: anchorX + dx - minDx,
    y: anchorY + dy - minDy,
  }));
}

/**
 * The effective axis-aligned bounding-box dimensions of a footprint under
 * rotation. For rectangular masks: rotations 0/2 keep `{w, h}`;
 * rotations 1/3 swap to `{h, w}`.
 */
export function rotatedDims(
  mask: ShapeMask,
  rotation: Rotation,
): { readonly width: number; readonly height: number } {
  const r = rotateShape(mask, rotation);
  return { width: shapeWidth(r), height: shapeHeight(r) };
}

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
  rect2x3: { tiles: [
    { dx: 0, dy: 0 }, { dx: 1, dy: 0 },
    { dx: 0, dy: 1 }, { dx: 1, dy: 1 },
    { dx: 0, dy: 2 }, { dx: 1, dy: 2 },
  ]},
  rect3x2: { tiles: [
    { dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 2, dy: 0 },
    { dx: 0, dy: 1 }, { dx: 1, dy: 1 }, { dx: 2, dy: 1 },
  ]},
  line4h: { tiles: [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 2, dy: 0 }, { dx: 3, dy: 0 }] },
  square3: { tiles: [
    { dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 2, dy: 0 },
    { dx: 0, dy: 1 }, { dx: 1, dy: 1 }, { dx: 2, dy: 1 },
    { dx: 0, dy: 2 }, { dx: 1, dy: 2 }, { dx: 2, dy: 2 },
  ]},
  square4: { tiles: [
    { dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 2, dy: 0 }, { dx: 3, dy: 0 },
    { dx: 0, dy: 1 }, { dx: 1, dy: 1 }, { dx: 2, dy: 1 }, { dx: 3, dy: 1 },
    { dx: 0, dy: 2 }, { dx: 1, dy: 2 }, { dx: 2, dy: 2 }, { dx: 3, dy: 2 },
    { dx: 0, dy: 3 }, { dx: 1, dy: 3 }, { dx: 2, dy: 3 }, { dx: 3, dy: 3 },
  ]},
} as const satisfies Record<string, ShapeMask>;
