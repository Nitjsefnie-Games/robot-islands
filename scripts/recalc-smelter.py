#!/usr/bin/env python3
"""
Re-derive the DRI smelter recipe (§3.1 of the SI-units rework foundation doc)
from first principles.

Overall reduction reaction (carbothermal direct reduction):

    Fe₂O₃ + 3 C  →  2 Fe + 3 CO

In a real coal-based DRI shaft / rotary kiln the C is supplied as bituminous
coal (not pure C), the ore is not pure Fe₂O₃ (it carries gangue), some Fe is
lost to slag as FeO, and the coal carries ash + volatiles that don't engage
the reduction but do contribute to the mass-balance bookkeeping.

This script does the bookkeeping symbolically from named constants. Each
constant is cited at the top with its source URL. CLI flags override every
constant for sensitivity analysis.

Run:
    python3 scripts/recalc-smelter.py                # defaults
    python3 scripts/recalc-smelter.py --ore-fe 0.62  # leaner ore
    python3 scripts/recalc-smelter.py --basis 100    # 100 kg ore basis
    python3 scripts/recalc-smelter.py --integerize 10  # try integer recipe at 10 kg ore

Output: a mass-flow table + an integer-rounded game recipe with the closure
error explicitly reported.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
"""

import argparse
from typing import Dict


# ---------------------------------------------------------------------------
# Molar masses (g/mol) — IUPAC standard atomic weights, 2021 abridged values
# Source: https://iupac.qmul.ac.uk/AtWt/  (mirror at
# https://en.wikipedia.org/wiki/Standard_atomic_weight )
# ---------------------------------------------------------------------------
M_Fe = 55.845
M_O  = 15.999
M_C  = 12.011
M_Fe2O3 = 2 * M_Fe + 3 * M_O      # 159.687
M_CO    = M_C + M_O                # 28.010
M_FeO   = M_Fe + M_O               # 71.844

# ---------------------------------------------------------------------------
# Industrial-process defaults
#
# ORE_FE_DEFAULT: 0.64
#   DSO (direct-shipping ore) export-grade hematite ore typically sits in the
#   62-64% Fe range; magnetite concentrates run higher (~70%). 0.64 is the
#   high end of DSO export-grade.
#   Source: https://en.wikipedia.org/wiki/Iron_ore  ("Export-grade DSO ores
#   are generally in the 62-64% Fe range.")
#
# COAL_C_DEFAULT: 0.70
#   Metallurgical / coking coal (medium-volatile bituminous) has fixed-carbon
#   content in the 69-78% range on a dry, mineral-matter-free basis. 0.70 is
#   the low end — conservative for a coal-direct-reduction kiln that uses
#   non-coking grades.
#   Source: https://en.wikipedia.org/wiki/Bituminous_coal  ("medium-volatile
#   spans 69-78%" fixed carbon, dry-mineral-matter-free).
#
# COAL_ASH_DEFAULT: 0.10
#   Bituminous coal ash content typically 5-15% by mass. 0.10 is mid-range.
#   The remaining 100% − COAL_C − COAL_ASH is volatile matter (H, O, N, S
#   compounds + moisture).
#   Source: https://en.wikipedia.org/wiki/Bituminous_coal  (volatile-matter
#   ranges by sub-rank, plus the ~1.7-1.8% S and 6.7% O figures.)
#
# FE_YIELD_DEFAULT: 0.95
#   Modern DRI processes (Midrex, HYL, rotary-kiln coal-DR) report ~93-96% Fe
#   recovery to product; the rest reports to slag as FeO. 0.95 is mid-range.
#   Source: https://en.wikipedia.org/wiki/Direct_reduced_iron  ("Direct-reduced
#   iron has about the same iron content as pig iron, typically 90-94% total
#   iron"; combined with ore-Fe input, implies 93-96% recovery typical.)
# ---------------------------------------------------------------------------
ORE_FE_DEFAULT     = 0.64
COAL_C_DEFAULT     = 0.70
COAL_ASH_DEFAULT   = 0.10
FE_YIELD_DEFAULT   = 0.95


def derive(
    ore_kg: float,
    ore_fe_fraction: float,
    coal_c_fraction: float,
    coal_ash_fraction: float,
    fe_yield_to_ingot: float,
) -> Dict[str, float]:
    """
    Return mass-flow dictionary in kg.

    Iron balance:
        Fe_in_ore = ore × ore_fe
        Fe_to_ingot = Fe_in_ore × yield
        Fe_to_slag (as FeO) = Fe_in_ore × (1 − yield)

    Oxygen balance:
        O_total_in_ore = Fe_in_ore × (3 × M_O)/(2 × M_Fe)         [from Fe₂O₃]
        O_bound_in_FeO_slag = Fe_to_slag × (M_O / M_Fe)
        O_to_CO = O_total_in_ore − O_bound_in_FeO_slag

    CO out:
        moles_CO = O_to_CO / M_O
        mass_CO  = moles_CO × M_CO
        C_consumed = moles_CO × M_C

    Coal in:
        coal = C_consumed / coal_c_fraction
        coal_ash = coal × coal_ash_fraction
        coal_volatiles = coal − C_consumed − coal_ash

    Slag total:
        slag = gangue + FeO_in_slag + coal_ash
        gangue = ore − Fe₂O₃_in_ore
    """
    fe_in_ore = ore_kg * ore_fe_fraction
    fe2o3_in_ore = fe_in_ore * (M_Fe2O3 / (2 * M_Fe))
    gangue = ore_kg - fe2o3_in_ore

    fe_to_ingot = fe_in_ore * fe_yield_to_ingot
    fe_to_slag  = fe_in_ore - fe_to_ingot
    feo_in_slag = fe_to_slag * (M_FeO / M_Fe)
    o_bound_in_feo = feo_in_slag - fe_to_slag

    o_total_in_ore = fe_in_ore * (3 * M_O) / (2 * M_Fe)
    o_to_co = o_total_in_ore - o_bound_in_feo
    if o_to_co < 0:
        raise ValueError(
            f"O_to_CO < 0 ({o_to_co:.3f} kg). Fe yield too low — more Fe lost "
            f"to slag than ore O can support without an external O source."
        )

    moles_co = o_to_co / M_O
    mass_co = moles_co * M_CO
    c_consumed_in_co = moles_co * M_C

    coal_mass = c_consumed_in_co / coal_c_fraction
    coal_ash = coal_mass * coal_ash_fraction
    coal_volatiles = coal_mass - c_consumed_in_co - coal_ash

    slag_total = gangue + feo_in_slag + coal_ash

    return {
        "ore_in":         ore_kg,
        "coal_in":        coal_mass,
        "ingot_out":      fe_to_ingot,
        "slag_out":       slag_total,
        "CO_out":         mass_co,
        "volatiles_out":  coal_volatiles,
        # diagnostic detail
        "gangue":         gangue,
        "FeO_in_slag":    feo_in_slag,
        "coal_ash":       coal_ash,
        "c_consumed":     c_consumed_in_co,
    }


def closure_error(d: Dict[str, float]) -> float:
    """Signed closure error: (mass_out − mass_in)."""
    mass_in = d["ore_in"] + d["coal_in"]
    mass_out = d["ingot_out"] + d["slag_out"] + d["CO_out"] + d["volatiles_out"]
    return mass_out - mass_in


def integerize(d: Dict[str, float], lump_volatiles_into_co: bool) -> Dict[str, int]:
    """Round to integer kg. If lump_volatiles_into_co, the volatiles mass is
    added to the off-gas line before rounding."""
    if lump_volatiles_into_co:
        co = d["CO_out"] + d["volatiles_out"]
        vol = 0.0
    else:
        co = d["CO_out"]
        vol = d["volatiles_out"]

    return {
        "ore_in":     round(d["ore_in"]),
        "coal_in":    round(d["coal_in"]),
        "ingot_out":  round(d["ingot_out"]),
        "slag_out":   round(d["slag_out"]),
        "off_gas_out": round(co),
        "volatiles_out": round(vol),
    }


def fmt(d: Dict[str, float], precision: int = 2) -> str:
    return ", ".join(f"{k}={v:.{precision}f}" for k, v in d.items())


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--basis", type=float, default=100.0,
                   help="Basis ore mass in kg (default 100).")
    p.add_argument("--ore-fe", type=float, default=ORE_FE_DEFAULT,
                   help=f"Ore Fe mass fraction (default {ORE_FE_DEFAULT}).")
    p.add_argument("--coal-c", type=float, default=COAL_C_DEFAULT,
                   help=f"Coal fixed-C mass fraction (default {COAL_C_DEFAULT}).")
    p.add_argument("--coal-ash", type=float, default=COAL_ASH_DEFAULT,
                   help=f"Coal ash mass fraction (default {COAL_ASH_DEFAULT}).")
    p.add_argument("--fe-yield", type=float, default=FE_YIELD_DEFAULT,
                   help=f"Fe → ingot yield (default {FE_YIELD_DEFAULT}, rest to slag as FeO).")
    p.add_argument("--integerize", type=float, default=None, metavar="BASIS_KG",
                   help="Also produce an integer-rounded recipe at this ore basis.")
    p.add_argument("--lump-volatiles", action="store_true",
                   help="In the integer recipe, lump coal volatiles into the off-gas (CO) line.")
    args = p.parse_args()

    print("=== INPUT CONSTANTS ===")
    print(f"  Molar masses: Fe={M_Fe}, O={M_O}, C={M_C}, Fe₂O₃={M_Fe2O3:.3f}, CO={M_CO:.3f}, FeO={M_FeO:.3f}")
    print(f"  Ore Fe fraction:   {args.ore_fe}")
    print(f"  Coal C fraction:   {args.coal_c}")
    print(f"  Coal ash fraction: {args.coal_ash}")
    print(f"  Fe yield to ingot: {args.fe_yield}  (Fe to slag as FeO: {1 - args.fe_yield:.3f})")
    print()

    d = derive(
        ore_kg=args.basis,
        ore_fe_fraction=args.ore_fe,
        coal_c_fraction=args.coal_c,
        coal_ash_fraction=args.coal_ash,
        fe_yield_to_ingot=args.fe_yield,
    )

    print(f"=== DERIVED MASS FLOW (basis: {args.basis} kg ore) ===")
    print(f"  IN  : ore={d['ore_in']:.3f}, coal={d['coal_in']:.3f}")
    print(f"  OUT : ingot={d['ingot_out']:.3f}, slag={d['slag_out']:.3f}, CO={d['CO_out']:.3f}, volatiles={d['volatiles_out']:.3f}")
    print(f"  DETAIL: gangue={d['gangue']:.3f}, FeO_in_slag={d['FeO_in_slag']:.3f}, coal_ash={d['coal_ash']:.3f}, C_consumed={d['c_consumed']:.3f}")
    err = closure_error(d)
    print(f"  CLOSURE (out − in) = {err:+.6f} kg  ({'PASS' if abs(err) < 1e-6 else 'FAIL'})")
    print()

    if args.integerize is not None:
        d_int_basis = derive(
            ore_kg=args.integerize,
            ore_fe_fraction=args.ore_fe,
            coal_c_fraction=args.coal_c,
            coal_ash_fraction=args.coal_ash,
            fe_yield_to_ingot=args.fe_yield,
        )
        di = integerize(d_int_basis, lump_volatiles_into_co=args.lump_volatiles)
        mass_in_int = di["ore_in"] + di["coal_in"]
        mass_out_int = di["ingot_out"] + di["slag_out"] + di["off_gas_out"] + di["volatiles_out"]
        err_int = mass_out_int - mass_in_int

        print(f"=== INTEGER RECIPE (basis: {args.integerize} kg ore, lump_volatiles={args.lump_volatiles}) ===")
        if args.lump_volatiles:
            print(f"  {di['ore_in']} ore + {di['coal_in']} coal → "
                  f"{di['ingot_out']} ingot + {di['slag_out']} slag + {di['off_gas_out']} off-gas (kg)")
            print(f"  Mass: {mass_in_int} in / {mass_out_int} out  → closure error = {err_int:+d} kg")
        else:
            print(f"  {di['ore_in']} ore + {di['coal_in']} coal → "
                  f"{di['ingot_out']} ingot + {di['slag_out']} slag + "
                  f"{di['off_gas_out']} CO + {di['volatiles_out']} volatiles (kg)")
            print(f"  Mass: {mass_in_int} in / {mass_out_int} out  → closure error = {err_int:+d} kg")
        if err_int != 0:
            print(f"  Note: integer rounding introduces {err_int:+d} kg drift; adjust one line by ±1 to close.")
        print()

    print("=== CITATIONS ===")
    print("  Stoichiometry  : Fe₂O₃ + 3 C → 2 Fe + 3 CO  (carbothermal direct reduction)")
    print("                   https://en.wikipedia.org/wiki/Iron(III)_oxide#Chemistry")
    print("  Ore Fe content : https://en.wikipedia.org/wiki/Iron_ore  (DSO export-grade 62-64% Fe)")
    print("  Coal C content : https://en.wikipedia.org/wiki/Bituminous_coal  (med-vol bituminous 69-78% fixed C)")
    print("  Coal ash       : https://en.wikipedia.org/wiki/Bituminous_coal  (typical 5-15%)")
    print("  Fe yield to ingot : https://en.wikipedia.org/wiki/Direct_reduced_iron  (DRI 90-94% Fe ⇒ ~93-96% recovery)")


if __name__ == "__main__":
    main()
