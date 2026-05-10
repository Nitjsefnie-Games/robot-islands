// Camera: pure state + world↔screen transform.
//
// The camera defines a viewport into world space. World space is measured in
// pixels (already factored by TILE_PX at the caller); the camera stores a
// translation (tx, ty) and a uniform zoom factor. The mapping is:
//
//   screen = world * zoom + (tx, ty)
//   world  = (screen - (tx, ty)) / zoom
//
// This module is intentionally Pixi-free: it just holds state and exposes pure
// functions. The renderer reads {tx, ty, zoom} once per frame and applies it
// to the world container via `position.set` and `scale.set`. Keeping camera
// state separate from the PixiJS scene graph means we can unit-test transforms
// without spinning up a renderer.

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface Camera {
  /** Screen-space translation applied after zoom. */
  tx: number;
  ty: number;
  /** Uniform zoom (1 = world pixels are screen pixels, 2 = 2× in, 0.5 = 2× out). */
  zoom: number;
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

export function makeCamera(tx = 0, ty = 0, zoom = 1): Camera {
  return { tx, ty, zoom };
}

export function clampZoom(z: number): number {
  if (z < MIN_ZOOM) return MIN_ZOOM;
  if (z > MAX_ZOOM) return MAX_ZOOM;
  return z;
}

export function worldToScreen(p: Vec2, cam: Camera): Vec2 {
  return { x: p.x * cam.zoom + cam.tx, y: p.y * cam.zoom + cam.ty };
}

export function screenToWorld(p: Vec2, cam: Camera): Vec2 {
  return { x: (p.x - cam.tx) / cam.zoom, y: (p.y - cam.ty) / cam.zoom };
}

/**
 * Pan the camera by a screen-space delta. WASD/arrow-key handlers and mouse
 * drag both feed through this — the delta is whatever the input system saw
 * on screen, irrespective of zoom.
 */
export function pan(cam: Camera, dxScreen: number, dyScreen: number): void {
  cam.tx += dxScreen;
  cam.ty += dyScreen;
}

/**
 * Zoom around a screen-space pivot. After this call, the world point that
 * was under `pivotScreen` is still under `pivotScreen`. Mouse wheel passes
 * cursor position; keyboard +/- passes the viewport centre.
 *
 * Math: let `w` = world point under pivot before zoom; we need new tx/ty
 * such that `w * newZoom + (newTx, newTy) === pivotScreen`, i.e.
 *   newTx = pivotScreen.x - w.x * newZoom
 *   newTy = pivotScreen.y - w.y * newZoom
 */
export function zoomAt(cam: Camera, pivotScreen: Vec2, newZoomRaw: number): void {
  const newZoom = clampZoom(newZoomRaw);
  const w = screenToWorld(pivotScreen, cam);
  cam.zoom = newZoom;
  cam.tx = pivotScreen.x - w.x * newZoom;
  cam.ty = pivotScreen.y - w.y * newZoom;
}

/**
 * Center the camera on a world-space point so that the point appears at the
 * given screen-space position. Used by "Center on Home" — pass home world
 * coords and the viewport centre.
 */
export function centerOn(cam: Camera, worldPoint: Vec2, screenCentre: Vec2): void {
  cam.tx = screenCentre.x - worldPoint.x * cam.zoom;
  cam.ty = screenCentre.y - worldPoint.y * cam.zoom;
}
