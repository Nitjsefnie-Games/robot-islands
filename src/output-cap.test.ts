import { describe, it, expect } from 'vitest';
import { OUTPUT_CAP_EXEMPT, isOutputCapExempt } from './output-cap.js';

describe('output-cap', () => {
  it('slag is in the default-on set (P4 + this feature)', () => {
    expect(OUTPUT_CAP_EXEMPT.has('slag')).toBe(true);
    expect(OUTPUT_CAP_EXEMPT.has('co')).toBe(true);
    expect(OUTPUT_CAP_EXEMPT.has('iron_ingot')).toBe(false);
  });

  it('no overrides ⇒ falls through to the global default', () => {
    expect(isOutputCapExempt({}, 'slag')).toBe(true);        // default on
    expect(isOutputCapExempt({}, 'iron_ingot')).toBe(false); // default off
  });

  it('an override wins over the default, either direction', () => {
    expect(isOutputCapExempt({ ignoreCapOverrides: { slag: false } }, 'slag')).toBe(false);
    expect(isOutputCapExempt({ ignoreCapOverrides: { iron_ingot: true } }, 'iron_ingot')).toBe(true);
  });
});
