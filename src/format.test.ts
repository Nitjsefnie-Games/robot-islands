import { describe, expect, it } from 'vitest';
import { fmtMass, fmtPower } from './format.js';

describe('fmtMass — SI mass display (input is kg)', () => {
  it('zero', () => expect(fmtMass(0)).toBe('0 kg'));
  it('sub-tonne shows kg', () => expect(fmtMass(340)).toBe('340 kg'));
  it('fractional kg trims to 1 decimal', () => expect(fmtMass(12.34)).toBe('12.3 kg'));
  it('tonnes', () => expect(fmtMass(1500)).toBe('1.5 t'));
  it('kilotonnes', () => expect(fmtMass(2_300_000)).toBe('2.3 kt'));
  it('megatonnes', () => expect(fmtMass(4_500_000_000)).toBe('4.5 Mt'));
});

describe('fmtPower — SI power display (input is kW)', () => {
  it('sub-kW shows W', () => expect(fmtPower(0.02)).toBe('20 W'));
  it('zero', () => expect(fmtPower(0)).toBe('0 W'));
  it('kW range', () => {
    expect(fmtPower(20)).toBe('20 kW');
    expect(fmtPower(7.5)).toBe('7.5 kW');
  });
  it('MW range', () => {
    expect(fmtPower(5000)).toBe('5 MW');
    expect(fmtPower(300000)).toBe('300 MW');
  });
  it('GW range', () => expect(fmtPower(1_000_000)).toBe('1 GW'));
  it('rounds before choosing the W/kW unit (0.9996 kW → 1.0 kW, not 1000 W)', () => {
    expect(fmtPower(0.9996)).toBe('1.0 kW');
    expect(fmtPower(0.999)).toBe('999 W');
  });
});
