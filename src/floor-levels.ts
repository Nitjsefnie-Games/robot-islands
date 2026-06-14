// Pure floor-level helpers (NO pixi import).
//
// Extracted from `buildings.ts` so the authoritative server (and any other
// pure consumer) can read a building's floor count without dragging in the
// PixiJS render layer that `buildings.ts` imports. `buildings.ts` re-exports
// these so the render layer is unaffected.
//
// Floor-effect scaling clamps at L = 9 (10 floors) per §4.9 in the effect
// callers; cost and display follow the raw value, so these helpers are
// unbounded on the high end and only clamp the low end at 0.

/** Effective floor level for throughput / power / storage effects.
 *  Unbounded on the high end; floors below 0 are treated as 0. */
export function floorLevel(b: { floorLevel?: number }): number {
  return Math.max(0, b.floorLevel ?? 0);
}

/** Raw stored floor level (same as `floorLevel` now that effects are unbounded). */
export function rawFloorLevel(b: { floorLevel?: number }): number {
  return floorLevel(b);
}

/** Player-facing floor count: raw floor level + 1 (1 = fresh building). */
export function displayedFloorLevel(b: { floorLevel?: number }): number {
  return rawFloorLevel(b) + 1;
}

/** §NEW floor-disable: count of ACTIVE floors ∈ [0, displayedFloorLevel].
 *  = built floors minus `disabledFloors` (clamped at 0). */
export function activeFloors(b: { floorLevel?: number; disabledFloors?: number }): number {
  return Math.max(0, displayedFloorLevel(b) - (b.disabledFloors ?? 0));
}

/** §NEW floor-disable: 0-based effective floor level for the floor-effect
 *  multipliers (activeFloors − 1). ≥ 0 for an operational building; −1 when
 *  fully disabled (never read — the building is then non-operational). */
export function activeFloorLevel(b: { floorLevel?: number; disabledFloors?: number }): number {
  return activeFloors(b) - 1;
}
