// Pure display helpers. No DOM / PixiJS imports — safe to unit-test directly.

/** Trim a number to a short label: integers bare, else 1 decimal. */
function trim(n: number): string {
  return Number.isInteger(n) ? n.toString() : n.toFixed(1);
}

/** Format an electrical-power value (canonical unit = kW) as W / kW / MW / GW. */
export function fmtPower(kW: number): string {
  const a = Math.abs(kW);
  if (a === 0) return '0 W';
  if (a < 1) return `${Math.round(kW * 1000)} W`;
  if (a < 1000) return `${trim(kW)} kW`;
  if (a < 1_000_000) return `${trim(kW / 1000)} MW`;
  return `${trim(kW / 1_000_000)} GW`;
}
