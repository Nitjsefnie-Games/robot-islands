// Camera transform round-trip and zoom-pivot invariants.

import { describe, expect, it } from 'vitest';

import {
  centerOn,
  clampZoom,
  makeCamera,
  MAX_ZOOM,
  MIN_ZOOM,
  pan,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from './camera.js';

describe('camera transform round-trip', () => {
  it('screenToWorld(worldToScreen(p)) === p at identity', () => {
    const cam = makeCamera();
    const p = { x: 17, y: -42 };
    const back = screenToWorld(worldToScreen(p, cam), cam);
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });

  it('round-trips at a non-trivial pan + zoom', () => {
    const cam = makeCamera(123, -45, 2.5);
    const p = { x: 100, y: -200 };
    const back = screenToWorld(worldToScreen(p, cam), cam);
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });

  it('round-trips at sub-unit zoom', () => {
    const cam = makeCamera(-300, 7, 0.4);
    const p = { x: -50, y: 50 };
    const back = screenToWorld(worldToScreen(p, cam), cam);
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });
});

describe('pan', () => {
  it('shifts world container in screen pixels', () => {
    const cam = makeCamera(0, 0, 2);
    pan(cam, 10, -20);
    expect(cam.tx).toBe(10);
    expect(cam.ty).toBe(-20);
  });
});

describe('zoomAt pivots around the cursor', () => {
  it('keeps the world point under the pivot fixed across zoom-in', () => {
    const cam = makeCamera(0, 0, 1);
    const pivot = { x: 400, y: 300 };
    const wBefore = screenToWorld(pivot, cam);
    zoomAt(cam, pivot, 2.5);
    const wAfter = screenToWorld(pivot, cam);
    expect(wAfter.x).toBeCloseTo(wBefore.x);
    expect(wAfter.y).toBeCloseTo(wBefore.y);
    expect(cam.zoom).toBe(2.5);
  });

  it('keeps the world point under the pivot fixed across zoom-out', () => {
    const cam = makeCamera(50, -80, 2);
    const pivot = { x: 100, y: 100 };
    const wBefore = screenToWorld(pivot, cam);
    zoomAt(cam, pivot, 0.5);
    const wAfter = screenToWorld(pivot, cam);
    expect(wAfter.x).toBeCloseTo(wBefore.x);
    expect(wAfter.y).toBeCloseTo(wBefore.y);
  });

  it('preserves pivot invariant when the camera is already panned', () => {
    // Zoom-pivot works at pan=0 but breaks if the world point isn't
    // refreshed after the pan.
    const cam = makeCamera(-217, 333, 1.3);
    const pivot = { x: 512, y: 384 };
    const wBefore = screenToWorld(pivot, cam);
    zoomAt(cam, pivot, 3.7);
    const wAfter = screenToWorld(pivot, cam);
    expect(wAfter.x).toBeCloseTo(wBefore.x);
    expect(wAfter.y).toBeCloseTo(wBefore.y);
  });

  it('clamps zoom to MIN_ZOOM..MAX_ZOOM', () => {
    const cam = makeCamera();
    zoomAt(cam, { x: 0, y: 0 }, 99);
    expect(cam.zoom).toBe(MAX_ZOOM);
    zoomAt(cam, { x: 0, y: 0 }, 0.001);
    expect(cam.zoom).toBe(MIN_ZOOM);
  });
});

describe('centerOn', () => {
  it('places the named world point at the named screen point', () => {
    const cam = makeCamera(0, 0, 2);
    centerOn(cam, { x: 100, y: 50 }, { x: 400, y: 300 });
    const onScreen = worldToScreen({ x: 100, y: 50 }, cam);
    expect(onScreen.x).toBeCloseTo(400);
    expect(onScreen.y).toBeCloseTo(300);
  });
});

describe('clampZoom', () => {
  it('respects bounds', () => {
    expect(clampZoom(MIN_ZOOM / 2)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
  });
});
