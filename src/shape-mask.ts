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
