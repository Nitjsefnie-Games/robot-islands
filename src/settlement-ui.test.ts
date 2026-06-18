// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import { vehicleEndpointLabel } from './settlement-ui.js';

describe('vehicleEndpointLabel (#136.1 settlement ledger names)', () => {
  const islands = [
    { id: 'home', name: 'Ironforge' },
    { id: 'island_3', name: 'Tidehaven' },
  ];

  it('resolves island ids to player-facing names', () => {
    expect(vehicleEndpointLabel({ from: 'home', target: 'island_3' }, islands)).toBe('Ironforge → Tidehaven');
  });

  it('falls back to the raw id when an island is unknown', () => {
    expect(vehicleEndpointLabel({ from: 'home', target: 'gone_1' }, islands)).toBe('Ironforge → gone_1');
  });
});
