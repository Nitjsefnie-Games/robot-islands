// Pure display helpers. No DOM / PixiJS imports — safe to unit-test directly.

/** Trim a number to a short label: integers bare, else 1 decimal. */
function trim(n: number): string {
  return Number.isInteger(n) ? n.toString() : n.toFixed(1);
}

/** Format an electrical-power value (canonical unit = kW) as W / kW / MW / GW. */
export function fmtPower(kW: number): string {
  const a = Math.abs(kW);
  if (a === 0) return '0 W';
  const w = Math.round(kW * 1000);
  if (Math.abs(w) < 1000) return `${w} W`;
  if (a < 1000) return `${trim(kW)} kW`;
  if (a < 1_000_000) return `${trim(kW / 1000)} MW`;
  return `${trim(kW / 1_000_000)} GW`;
}

/** Format a mass value (canonical unit = kg) as kg / t / kt / Mt. */
export function fmtMass(kg: number): string {
  const a = Math.abs(kg);
  if (a === 0) return '0 kg';
  if (a < 1000) return `${trim(kg)} kg`;
  if (a < 1_000_000) return `${trim(kg / 1000)} t`;
  if (a < 1_000_000_000) return `${trim(kg / 1_000_000)} kt`;
  return `${trim(kg / 1_000_000_000)} Mt`;
}
