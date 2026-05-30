// The visibility predicate moved to vision-source.ts (shared with the ocean
// layer), so most former tests now live in vision-source.test.ts. This stub
// keeps the WEATHER_OVERLAY_REBUILD_MS sanity check so the module retains a
// test surface and main.ts's cadence wiring can't silently drift.

import { describe, expect, it } from 'vitest';

import {
  FORECAST_ALPHA_MULTIPLIER,
  WEATHER_OVERLAY_REBUILD_MS,
} from './weather-overlay.js';

describe('WEATHER_OVERLAY_REBUILD_MS', () => {
  it('is bounded between 1s and 60s (sanity)', () => {
    expect(WEATHER_OVERLAY_REBUILD_MS).toBeGreaterThanOrEqual(1000);
    expect(WEATHER_OVERLAY_REBUILD_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('FORECAST_ALPHA_MULTIPLIER', () => {
  it('is strictly between 0 and 1 so forecast sprites stay visible but read as preview', () => {
    expect(FORECAST_ALPHA_MULTIPLIER).toBeGreaterThan(0);
    expect(FORECAST_ALPHA_MULTIPLIER).toBeLessThan(1);
  });
});
