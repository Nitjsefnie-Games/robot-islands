#!/usr/bin/env python3
"""
Verify the cell_press assembly mass-balance from first-principles inputs.

cell_press is NOT a chemistry-tuned recipe — it's a structural assembly. A
saltwater electrolysis cell consists of: electrodes (iron + copper wire),
casing/electrolyte container (the iron_ingot doubles as housing here), and
an electrolyte fill (saltwater). The "derivation" is just additive
mass-balance, not a stoichiometric reaction.

The interesting part isn't the chemistry — it's catching inputs/outputs that
don't sum cleanly, which is exactly the bug rev-11 had (3 kg output anchor
when inputs sum to 2.5 kg). Rev-12 fixed it.

Defaults below match the rev-13 doc:
  saltwater   = 1 L  ≈ 1.03 kg (round to 1.0 kg, < 3 % error)
  iron_ingot  = 1 kg
  wire        = 0.5 kg (§2.2 calibration: 1 unit wire = 0.5 kg)
  saltwater_cell output = 1 piece ≈ 2.5 kg

Run:
    python3 scripts/recalc-cell-press.py                # defaults
    python3 scripts/recalc-cell-press.py --wire 0.5     # explicit
    python3 scripts/recalc-cell-press.py --saltwater 1.03 --strict

Output:
    inputs:   1 saltwater (1.0 kg) + 1 iron_ingot (1.0 kg) + 1 wire (0.5 kg) = 2.5 kg
    output:   1 saltwater_cell (2.5 kg)
    Δ (out − in) = 0.000 kg ✓

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
"""

import argparse


# Component mass defaults (kg per unit) — from doc §2.2 calibration table,
# section "Per-piece manufactured parts" + "Fluids billed by volume" rows.
# Source: docs/superpowers/plans/2026-05-27-si-units-rework-foundation.html
# (rev-13, internal lines ~480-515)
DEFAULT_SALTWATER_KG     = 1.0     # 1 L @ density 1.03 kg/L rounded for legibility
DEFAULT_IRON_INGOT_KG    = 1.0     # T1 refined metal anchor: 1 unit = 1 kg
DEFAULT_WIRE_KG          = 0.5     # §2.2 per-piece component: 1 wire = 0.5 kg
DEFAULT_CELL_OUTPUT_KG   = 2.5     # 1 saltwater_cell piece ≈ 2.5 kg (the
                                    # assembled cell: electrodes + casing + electrolyte)


def derive(saltwater_kg, iron_ingot_kg, wire_kg, cell_output_kg):
    """Return assembly mass-balance dict."""
    total_in = saltwater_kg + iron_ingot_kg + wire_kg
    delta = cell_output_kg - total_in
    return {
        "saltwater_in":   saltwater_kg,
        "iron_ingot_in":  iron_ingot_kg,
        "wire_in":        wire_kg,
        "total_in":       total_in,
        "cell_out":       cell_output_kg,
        "delta":          delta,
    }


def main():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--saltwater",  type=float, default=DEFAULT_SALTWATER_KG,
                   help=f"Saltwater per cycle in kg (default {DEFAULT_SALTWATER_KG}).")
    p.add_argument("--iron-ingot", type=float, default=DEFAULT_IRON_INGOT_KG,
                   help=f"Iron ingot per cycle in kg (default {DEFAULT_IRON_INGOT_KG}).")
    p.add_argument("--wire",       type=float, default=DEFAULT_WIRE_KG,
                   help=f"Wire per cycle in kg (default {DEFAULT_WIRE_KG}).")
    p.add_argument("--output",     type=float, default=DEFAULT_CELL_OUTPUT_KG,
                   help=f"saltwater_cell per cycle in kg (default {DEFAULT_CELL_OUTPUT_KG}).")
    p.add_argument("--strict", action="store_true",
                   help="Exit 1 if |delta| > 0.001 kg.")
    args = p.parse_args()

    d = derive(args.saltwater, args.iron_ingot, args.wire, args.output)

    print("=== INPUT CONSTANTS (per cell_press cycle) ===")
    print(f"  saltwater  : {d['saltwater_in']} kg  (§2.2: 1 L @ 1.03 kg/L rounded to 1.0)")
    print(f"  iron_ingot : {d['iron_ingot_in']} kg  (§2.2: T1 refined-metal anchor)")
    print(f"  wire       : {d['wire_in']} kg  (§2.2: per-piece component, 1 unit = 0.5 kg)")
    print(f"  output     : {d['cell_out']} kg  (§2.2: 1 saltwater_cell piece ≈ 2.5 kg assembled)")
    print()

    print("=== MASS-BALANCE ===")
    print(f"  inputs total : {d['total_in']:.3f} kg")
    print(f"  output       : {d['cell_out']:.3f} kg")
    sign = "+" if d['delta'] >= 0 else ""
    pass_str = "PASS" if abs(d['delta']) < 1e-6 else "FAIL"
    print(f"  Δ (out − in) : {sign}{d['delta']:.6f} kg  ({pass_str})")
    print()

    print("=== CANONICAL RECIPE ===")
    sw = round(d['saltwater_in']) if abs(d['saltwater_in'] - round(d['saltwater_in'])) < 1e-6 else d['saltwater_in']
    ii = round(d['iron_ingot_in']) if abs(d['iron_ingot_in'] - round(d['iron_ingot_in'])) < 1e-6 else d['iron_ingot_in']
    print(f"  {sw} saltwater + {ii} iron_ingot + {d['wire_in']} wire → 1 saltwater_cell (= {d['cell_out']} kg)")
    print()

    print("=== CITATIONS ===")
    print("  Component masses: doc §2.2 calibration table (no external source — these")
    print("                    are GAME calibrations, not chemistry derivations).")
    print("  Assembly pattern: structural mass-balance only. cell_press is an")
    print("                    electrochemistry-cell ASSEMBLY (electrodes + casing +")
    print("                    electrolyte fill), not a chemical reaction; no")
    print("                    stoichiometry to derive. Real industrial reference:")
    print("                    Pletcher & Walsh, Industrial Electrochemistry 2e")
    print("                    (Springer), ch. 6 — cell-component BOMs.")

    if args.strict and abs(d['delta']) > 0.001:
        import sys
        sys.exit(1)


if __name__ == "__main__":
    main()
