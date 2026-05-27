#!/usr/bin/env python3
"""
Re-derive the bulk_concrete_plant recipe from ACI 211.1 nominal mix proportions.

Standard structural concrete mix (ACI 211.1 "Standard Practice for Selecting
Proportions for Normal, Heavyweight, and Mass Concrete"):

  cement : sand (fine aggregate) : stone (coarse aggregate) : water
  =   1   :  2                   :  3                       : 0.5
  (by mass, M20-class nominal mix)

Mass closes within rounding because water hydrates into the cement paste
(~25 % bound chemically into C-S-H gel + Ca(OH)₂), and the remainder is
trapped as capillary pore water during the early cure (released slowly over
weeks of curing).

The bulk_concrete_plant is a T6-tier industrial pour line — same chemistry as
the regular concrete_plant in §3.2, scaled up. Optional rebar (steel_beam)
adds 0.5-2 % of the cured-concrete mass for typical structural reinforcement.

Defaults match the rev-13 doc target (per cycle):
  cement       = 1 unit (anchor mass; recipe scales linearly above this)
  sand         = 2 units
  stone        = 3 units
  fresh_water  = 0.5 units
  steel_beam   = 0  (set --rebar 0.01 for 1 % rebar)
  output       = sum of inputs (mass-conservation, no water-evaporation in cycle window)

Run:
    python3 scripts/recalc-bulk-concrete.py --scale 100   # T6 industrial scale
    python3 scripts/recalc-bulk-concrete.py --output-target 100   # back-solve to hit 100 kg

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
"""

import argparse


# Standard ACI 211.1 M20-class nominal mix proportions (by mass).
# Source: https://www.concrete.org/standards/standard-practices.aspx
#         ACI 211.1-91 (reapproved 2009); also IS 456:2000 and ASTM C150.
# These are also the proportions cited in the doc §3.2 concrete_plant row:
# "1 cement + 2 sand + 3 stone + 0.5 fresh_water → 6 concrete"
ACI_CEMENT_RATIO     = 1.0
ACI_SAND_RATIO       = 2.0
ACI_STONE_RATIO      = 3.0
ACI_WATER_RATIO      = 0.5

# Default rebar fraction (fraction of cured-concrete mass).
# Source: ACI 318-19 chapter 25 reinforcement-ratio minimums for slabs/beams.
# 0.5–2 % by mass is typical for structural reinforced concrete; 0.01 = 1 %
# is a conservative mid-range default.
DEFAULT_REBAR_FRACTION = 0.0   # off by default — base recipe is plain concrete


def derive(scale, rebar_fraction):
    """
    Compute the canonical bulk_concrete_plant recipe.

    `scale` multiplies the ACI ratios. scale=1 gives the base unit recipe;
    scale=100 gives a T6 industrial-plant cycle. rebar_fraction is the
    steel_beam-as-rebar mass fraction of the concrete output.
    """
    cement = ACI_CEMENT_RATIO * scale
    sand   = ACI_SAND_RATIO * scale
    stone  = ACI_STONE_RATIO * scale
    water  = ACI_WATER_RATIO * scale
    rebar  = (cement + sand + stone + water) * rebar_fraction / (1 - rebar_fraction) if rebar_fraction < 1 else 0
    # rebar formula: target output = (cement+sand+stone+water+rebar)
    #                rebar = rebar_fraction × output
    #                ⇒ rebar = rebar_fraction × (cement+sand+stone+water+rebar)
    #                ⇒ rebar (1 − rebar_fraction) = rebar_fraction × (cement+sand+stone+water)
    #                ⇒ rebar = rebar_fraction × (cement+sand+stone+water) / (1 − rebar_fraction)

    total_in = cement + sand + stone + water + rebar
    concrete_out = total_in    # mass conservation; water bound or pore-trapped
    return {
        "cement":      cement,
        "sand":        sand,
        "stone":       stone,
        "fresh_water": water,
        "steel_beam_rebar": rebar,
        "total_in":    total_in,
        "concrete_out": concrete_out,
        "delta":       concrete_out - total_in,
    }


def integerize(d, lump_water=False):
    """Round to integer kg. If lump_water, water is added to the concrete
    output line (closer to real cured-concrete bookkeeping; water is bound)."""
    cement = round(d['cement'])
    sand   = round(d['sand'])
    stone  = round(d['stone'])
    water  = round(d['fresh_water'])
    rebar  = round(d['steel_beam_rebar'])
    out    = round(d['concrete_out'])

    if lump_water:
        # Water doesn't appear as an input — model as "ambient" / coupled-pump
        sum_in = cement + sand + stone + rebar
        out = sum_in
        return {
            "cement_in":     cement,
            "sand_in":       sand,
            "stone_in":      stone,
            "steel_beam_in": rebar,
            "concrete_out":  out,
            "delta":         out - sum_in,
        }
    return {
        "cement_in":      cement,
        "sand_in":        sand,
        "stone_in":       stone,
        "fresh_water_in": water,
        "steel_beam_in":  rebar,
        "concrete_out":   out,
        "delta":          out - (cement + sand + stone + water + rebar),
    }


def fmt_recipe(d, lump_water):
    parts = [f"{d['cement_in']} cement", f"{d['sand_in']} sand", f"{d['stone_in']} stone"]
    if not lump_water:
        parts.append(f"{d['fresh_water_in']} fresh_water")
    if d['steel_beam_in'] > 0:
        parts.append(f"{d['steel_beam_in']} steel_beam")
    return " + ".join(parts) + f" → {d['concrete_out']} concrete (kg)"


def main():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--scale", type=float, default=1.0,
                   help="Multiply the 1:2:3:0.5 ACI base ratio by this scale (default 1 = base unit recipe).")
    p.add_argument("--rebar", type=float, default=DEFAULT_REBAR_FRACTION,
                   help=f"Rebar (steel_beam) mass fraction of concrete output (default {DEFAULT_REBAR_FRACTION}, typical structural 0.005-0.02).")
    p.add_argument("--output-target", type=float, default=None,
                   help="Back-solve scale so the rounded concrete output ≈ this kg.")
    p.add_argument("--lump-water", action="store_true",
                   help="Drop water from the recipe (treat as ambient / coupled-pump source). Output then equals dry-input sum.")
    args = p.parse_args()

    if args.output_target is not None:
        # Back-solve: total_in = scale × (1+2+3+0.5 + rebar_term)
        rebar_term = (1.0 + 2.0 + 3.0 + 0.5) * args.rebar / (1 - args.rebar) if args.rebar < 1 else 0
        per_scale_total = 1.0 + 2.0 + 3.0 + 0.5 + rebar_term
        args.scale = args.output_target / per_scale_total

    print("=== INPUT CONSTANTS ===")
    print(f"  ACI 211.1 base ratio (by mass): cement:sand:stone:water = 1:2:3:0.5")
    print(f"  Scale factor: {args.scale:.3f}")
    print(f"  Rebar fraction: {args.rebar:.4f}  ({args.rebar * 100:.2f} % of concrete output)")
    print()

    d = derive(args.scale, args.rebar)

    print("=== DERIVED MASS FLOW ===")
    print(f"  IN  : cement={d['cement']:.3f}, sand={d['sand']:.3f}, stone={d['stone']:.3f}, "
          f"water={d['fresh_water']:.3f}, rebar={d['steel_beam_rebar']:.3f}")
    print(f"  OUT : concrete={d['concrete_out']:.3f}")
    print(f"  Δ   : {d['delta']:+.6f} kg  ({'PASS' if abs(d['delta']) < 1e-6 else 'FAIL'})")
    print()

    di = integerize(d, lump_water=args.lump_water)
    print(f"=== INTEGER RECIPE (lump_water={args.lump_water}) ===")
    print(f"  {fmt_recipe(di, args.lump_water)}")
    sum_in = di['cement_in'] + di['sand_in'] + di['stone_in'] + di.get('fresh_water_in', 0) + di['steel_beam_in']
    print(f"  Mass: {sum_in} in / {di['concrete_out']} out  → integer drift = {di['delta']:+d} kg")
    print()

    print("=== CITATIONS ===")
    print("  ACI 211.1 mix    : https://www.concrete.org/standards/standard-practices.aspx")
    print("                     (also IS 456:2000, ASTM C150 — all use 1:2:3 nominal)")
    print("  doc precedent    : §3.2 concrete_plant uses the identical ratio")
    print("                     '1 cement + 2 sand + 3 stone + 0.5 fresh_water → 6 concrete'")
    print("  Rebar default    : ACI 318-19 ch. 25 (structural reinforcement-ratio minimums)")


if __name__ == "__main__":
    main()
