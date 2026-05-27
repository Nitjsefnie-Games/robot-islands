#!/usr/bin/env python3
"""
Re-derive the beam_mill and metal_rolling_mill recipes from hot-rolling yield.

Both buildings take refined steel (1 unit = 1 kg per §2.2) and roll it into a
shaped product (steel_beam = 50 kg/piece, or wire = 0.5 kg/piece per §2.2).
Hot rolling has two mass losses:

  - mill scale: ~1-3 % of input mass oxidises to FeO/Fe₂O₃/Fe₃O₄ flakes
    that detach from the bar surface during the high-temperature passes.
  - crop / trim: ~2-5 % of the ingot ends are cropped off (head + tail of
    the rolled bar are out-of-spec and trimmed for scrap).

Total finished-product yield: 92-97 % of input steel mass. Worse for thin
wire (more passes → more scale → lower yield). Better for thick beams (one
pass + simple trim).

Defaults below:
  beam_mill yield   = 0.95  (1 ingot → 0.95 kg beam + 0.05 kg mill_scale)
  rolling_mill yield = 0.92 (1 ingot → 0.92 kg wire + 0.08 kg mill_scale)

Run:
    python3 scripts/recalc-rolling-mill.py --product beam
    python3 scripts/recalc-rolling-mill.py --product wire --yield 0.94
    python3 scripts/recalc-rolling-mill.py --product beam --steel-batch 100   # T2 mill cycle

The integer-recipe step uses the unit-mass calibration from §2.2:
  beam: 1 unit steel_beam = 50 kg  → a 50 kg steel input rolls into 1 beam
                                     (with 95 % yield, only 47.5 kg of usable
                                     beam comes out — see closure-error note).
  wire: 1 unit wire = 0.5 kg       → a 0.5 kg steel input rolls into 1 wire
                                     (with 92 % yield, only 0.46 kg of usable
                                     wire — scale up the batch to hit integer
                                     units cleanly).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
"""

import argparse


# Product unit masses (kg per unit) from doc §2.2.
# Source: docs/superpowers/plans/2026-05-27-si-units-rework-foundation.html
# line ~509 "Per-piece manufactured parts" row.
STEEL_BEAM_KG_PER_UNIT = 50.0   # structural I/W-beam, see §2.2
WIRE_KG_PER_UNIT       = 0.5    # spooled wire, see §2.2

# Hot-rolling yields. Source for ranges:
#   - WorldSteel "Steel industry by-products fact sheet" — mill scale 1-3 %.
#     https://worldsteel.org/wp-content/uploads/Steel-industry-by-products.pdf
#   - Degarmo, Black & Kohser, "Materials and Processes in Manufacturing" 11e
#     (Wiley) ch. 19 — rolling-mill yields 90-97 % range, lower for thinner
#     products (more passes ⇒ more scale).
#   - U.S. Bureau of Mines / USGS metallurgical-statistics archives.
DEFAULT_BEAM_YIELD     = 0.95   # beam rolling: chunky, few passes, low loss
DEFAULT_WIRE_YIELD     = 0.92   # wire rolling: many passes, more scale loss


def derive(steel_in_kg, product_yield, product_kg_per_unit):
    """Return mass-flow dict for one rolling cycle."""
    product_kg = steel_in_kg * product_yield
    mill_scale_kg = steel_in_kg * (1 - product_yield)
    product_units = product_kg / product_kg_per_unit
    return {
        "steel_in_kg":       steel_in_kg,
        "product_kg":        product_kg,
        "mill_scale_kg":     mill_scale_kg,
        "product_units":     product_units,
        "delta":             (product_kg + mill_scale_kg) - steel_in_kg,
    }


def integer_recipe(steel_in_kg, product_yield, product_kg_per_unit, lump_scale=False):
    """Pick the smallest integer-steel batch that produces a clean integer
    number of product units, then report mass-balance."""
    d = derive(steel_in_kg, product_yield, product_kg_per_unit)
    steel_int = round(d['steel_in_kg'])
    units_int = round(d['product_units'])
    scale_int = round(d['mill_scale_kg'])
    # back-compute output kg
    out_product_kg = units_int * product_kg_per_unit

    if lump_scale:
        # mill_scale absorbed into product line (game-simplification)
        return {
            "steel_in":     steel_int,
            "product_units": units_int,
            "product_kg":   out_product_kg,
            "mill_scale_kg": 0,
            "delta":        out_product_kg - steel_int,
        }
    return {
        "steel_in":      steel_int,
        "product_units": units_int,
        "product_kg":    out_product_kg,
        "mill_scale_kg": scale_int,
        "delta":         (out_product_kg + scale_int) - steel_int,
    }


def main():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--product", choices=("beam", "wire"), required=True,
                   help="Which mill: 'beam' (beam_mill) or 'wire' (metal_rolling_mill).")
    p.add_argument("--yield", type=float, dest="prod_yield", default=None,
                   help="Finished-product mass yield (default: 0.95 for beam, 0.92 for wire).")
    p.add_argument("--unit-mass", type=float, default=None,
                   help="kg per unit of product (default: 50 kg/beam, 0.5 kg/wire per §2.2).")
    p.add_argument("--steel-batch", type=float, default=None,
                   help="Steel input batch in kg (default: just enough for 1 product unit).")
    p.add_argument("--lump-scale", action="store_true",
                   help="Don't track mill_scale as a separate output line.")
    args = p.parse_args()

    # Resolve defaults
    if args.product == "beam":
        prod_yield = args.prod_yield if args.prod_yield is not None else DEFAULT_BEAM_YIELD
        unit_mass = args.unit_mass if args.unit_mass is not None else STEEL_BEAM_KG_PER_UNIT
        product_name = "steel_beam"
        building = "beam_mill"
    else:
        prod_yield = args.prod_yield if args.prod_yield is not None else DEFAULT_WIRE_YIELD
        unit_mass = args.unit_mass if args.unit_mass is not None else WIRE_KG_PER_UNIT
        product_name = "wire"
        building = "metal_rolling_mill"

    if args.steel_batch is not None:
        steel_in = args.steel_batch
    else:
        # Default: pick the smallest steel batch that produces ≥1 finished unit
        # at the chosen yield. steel_for_one_unit = unit_mass / yield.
        steel_in = unit_mass / prod_yield

    print(f"=== INPUT CONSTANTS ({building}) ===")
    print(f"  product            : {product_name}")
    print(f"  product unit mass  : {unit_mass} kg/unit  (§2.2)")
    print(f"  rolling yield      : {prod_yield}  ({prod_yield * 100:.1f} % of input → finished product)")
    print(f"  steel batch in     : {steel_in} kg")
    print()

    d = derive(steel_in, prod_yield, unit_mass)
    print("=== DERIVED MASS FLOW ===")
    print(f"  IN  : steel = {d['steel_in_kg']:.3f} kg")
    print(f"  OUT : {product_name} = {d['product_kg']:.3f} kg ({d['product_units']:.4f} units), "
          f"mill_scale = {d['mill_scale_kg']:.3f} kg")
    print(f"  Δ   : {d['delta']:+.6f} kg  ({'PASS' if abs(d['delta']) < 1e-6 else 'FAIL'})")
    print()

    di = integer_recipe(steel_in, prod_yield, unit_mass, lump_scale=args.lump_scale)
    print(f"=== INTEGER RECIPE (lump_scale={args.lump_scale}) ===")
    if args.lump_scale:
        print(f"  {di['steel_in']} steel → {di['product_units']} {product_name} (kg in/out: {di['steel_in']}/{di['product_kg']:.0f})")
    else:
        print(f"  {di['steel_in']} steel → {di['product_units']} {product_name} + {di['mill_scale_kg']} mill_scale "
              f"(kg in/out: {di['steel_in']}/{di['product_kg'] + di['mill_scale_kg']:.0f})")
    print(f"  integer drift = {di['delta']:+.3f} kg")
    print()

    print("=== CALIBRATION-COMPATIBILITY CHECK ===")
    if args.product == "beam":
        old_recipe_in_kg = 1.0   # "1 steel" = 1 kg
        old_recipe_out_kg = 2 * STEEL_BEAM_KG_PER_UNIT  # "2 steel_beam" = 100 kg
        if abs(old_recipe_out_kg - old_recipe_in_kg) > 1.0:
            print(f"  WARNING: doc §12.9.1 says '1 steel → 2 steel_beam'.")
            print(f"  Under §2.2 calibration (steel=1 kg/unit, steel_beam=50 kg/unit) this is")
            print(f"  1 kg in → 100 kg out. Mass-positive 100×. The current doc has a unit-")
            print(f"  calibration drift between §2.2 and §12.9.1; the rolling-mill recipe")
            print(f"  can't be both 'realistic-mass-scale' AND 'integer-batch-size' without")
            print(f"  changing one calibration. Pick:")
            print(f"    (a) keep §2.2 (steel_beam = 50 kg/unit) → recipe is 50+ steel per beam;")
            print(f"    (b) update §2.2 to steel_beam ≈ 0.5 kg/unit (small structural element);")
            print(f"        then '1 steel → 2 steel_beam' is mass-balanced at ~50 % yield.")
    elif args.product == "wire":
        old_recipe_in_kg = 1.0
        old_recipe_out_kg = 1 * WIRE_KG_PER_UNIT
        if old_recipe_in_kg > old_recipe_out_kg * 1.5:
            print(f"  WARNING: doc §12.9.1 says '1 steel → 1 wire'.")
            print(f"  Under §2.2 calibration (steel=1 kg/unit, wire=0.5 kg/unit) this is")
            print(f"  1 kg in → 0.5 kg out. 50 % mass-loss — well above the 3-8 % real")
            print(f"  rolling-mill scale loss. The other 50 % isn't accounted as mill_scale.")
            print(f"  Recipe needs: 1 steel → 2 wire (matches mass) OR 1 steel → 1 wire +")
            print(f"  0.5 mill_scale (acknowledges the loss in mass-balance).")

    print()
    print("=== CITATIONS ===")
    print("  Yield range  : Degarmo/Black/Kohser 'Materials and Processes in Manufacturing'")
    print("                 11e ch. 19 (rolling mill 90-97 %).")
    print("  Mill scale   : WorldSteel by-products fact sheet (1-3 % typical).")
    print("  Unit masses  : doc §2.2 calibration table (steel_beam = 50 kg, wire = 0.5 kg).")


if __name__ == "__main__":
    main()
