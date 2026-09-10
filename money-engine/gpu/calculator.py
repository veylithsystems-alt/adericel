#!/usr/bin/env python3
"""
GPU rental break-even calculator (UK).

The whole question is: does the card earn more per hour than the electricity
it burns? In the UK that is genuinely marginal, because our power is expensive
and you are competing with hosts in places where it isn't.

Every number here is an ESTIMATE and must be checked against live rates
before you trust it. Vast.ai pricing moves with demand.
"""

USD_TO_GBP = 0.78          # check the live rate

# GPU: (total system watts under load, low $/hr, high $/hr)
# Watts include the rest of the machine, not just the card.
# VRAM is what makes a card rentable for ML — 24GB cards earn far more.
GPUS = {
    "RTX 3060 (12GB)":  (260, 0.04, 0.08),
    "RTX 3070 (8GB)":   (310, 0.06, 0.10),
    "RTX 3080 (10GB)":  (410, 0.09, 0.15),
    "RTX 3090 (24GB)":  (450, 0.15, 0.25),
    "RTX 4070 (12GB)":  (290, 0.10, 0.16),
    "RTX 4080 (16GB)":  (420, 0.20, 0.30),
    "RTX 4090 (24GB)":  (560, 0.30, 0.45),
}

TARIFFS = {
    "Fixed (~26p/kWh)":          0.26,
    "Octopus Agile avg (~18p)":  0.18,
    "Agile cheap hours (~8p)":   0.08,
}

# You will not be rented 100% of the time. This is the number people forget,
# and it is the difference between the advertised figure and your bank balance.
UTILISATION = 0.55

HOURS_PER_MONTH = 730


def monthly(watts, usd_hr, price_kwh, utilisation=UTILISATION):
    """Net £/month. Electricity is only burned while actually rented."""
    gross_gbp_hr = usd_hr * USD_TO_GBP
    kwh_hr       = watts / 1000
    cost_gbp_hr  = kwh_hr * price_kwh
    net_hr       = gross_gbp_hr - cost_gbp_hr
    return net_hr * HOURS_PER_MONTH * utilisation


def bar(v):
    if v <= 0:
        return "LOSS"
    return "#" * min(int(v / 3), 28)


print("=" * 92)
print(f"GPU RENTAL — NET £/MONTH AFTER ELECTRICITY   (utilisation {UTILISATION:.0%}, "
      f"${USD_TO_GBP}/£)")
print("=" * 92)

for tariff_name, price in TARIFFS.items():
    print(f"\n  ── {tariff_name} " + "─" * (74 - len(tariff_name)))
    print(f"  {'GPU':<20} {'pessimistic':>12} {'optimistic':>12}   ")
    for gpu, (watts, lo, hi) in GPUS.items():
        net_lo = monthly(watts, lo, price)
        net_hi = monthly(watts, hi, price)
        lo_s = f"£{net_lo:,.0f}" if net_lo > 0 else "LOSS"
        hi_s = f"£{net_hi:,.0f}" if net_hi > 0 else "LOSS"
        print(f"  {gpu:<20} {lo_s:>12} {hi_s:>12}   {bar(net_hi)}")

print("\n" + "=" * 92)
print("THE ANGLE: only run when power is cheap")
print("=" * 92)
print("""
On a fixed tariff you pay ~26p/kWh around the clock. On Octopus Agile the price
changes every 30 minutes and is published a day ahead — overnight it often drops
to 5-10p, and occasionally goes NEGATIVE (they pay you to use power).

A GPU that loses money at 26p can be solidly profitable at 8p. So the system
does not rent the card continuously. It reads tomorrow's prices, works out which
half-hour slots clear the break-even, and only accepts work then.

Below: what that switching is worth on a 3090, vs leaving it running always.
""")

watts, lo, hi = GPUS["RTX 3090 (24GB)"]
always_fixed = monthly(watts, hi, TARIFFS["Fixed (~26p/kWh)"])
always_agile = monthly(watts, hi, TARIFFS["Octopus Agile avg (~18p)"])
# Cheap-slot-only: fewer hours available, so utilisation drops, but each hour
# is far more profitable.
smart_agile  = monthly(watts, hi, TARIFFS["Agile cheap hours (~8p)"], utilisation=0.30)

print(f"  Always on, fixed tariff          £{always_fixed:>6,.0f}/mo")
print(f"  Always on, Agile average         £{always_agile:>6,.0f}/mo")
print(f"  Cheap slots only, Agile          £{smart_agile:>6,.0f}/mo   <-- fewer hours, more profit each")
print(f"\n  Difference vs fixed-tariff always-on: £{smart_agile - always_fixed:,.0f}/month")
print(f"  Over a year: £{(smart_agile - always_fixed) * 12:,.0f}")
print()
