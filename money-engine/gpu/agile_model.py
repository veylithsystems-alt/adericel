#!/usr/bin/env python3
"""
The right control rule for GPU rental on a half-hourly tariff.

Naive idea: "only run in the cheap hours." Wrong — it throws away paid work
during perfectly profitable hours just because power isn't at its cheapest.

Correct rule: run whenever  gross £/hr  >  power £/hr.
Equivalently, pause only when the electricity price rises above:

    break_even_p_per_kwh  =  (gross £/hr) / (kW drawn)

For a hungry card at a poor rental rate that threshold sits inside the daily
peak, so gating genuinely helps. For a strong card at a good rate the threshold
is above every price Agile ever reaches, and you should simply never pause.

This script shows which case a given card is in.
"""

USD_TO_GBP = 0.78
HOURS_PER_MONTH = 730
BASE_UTILISATION = 0.55   # fraction of offered hours that actually get rented

# A representative Octopus Agile weekday, in p/kWh per half-hour slot.
# Overnight cheap, daytime moderate, hard peak 16:00-19:00.
AGILE_DAY_P = (
    [9.0]  * 12 +   # 00:00-06:00
    [16.0] * 8  +   # 06:00-10:00
    [18.0] * 12 +   # 10:00-16:00
    [31.0] * 6  +   # 16:00-19:00  <- the peak that kills marginal cards
    [17.0] * 10     # 19:00-24:00
)
assert len(AGILE_DAY_P) == 48

GPUS = {
    "RTX 3060 (12GB)":  (260, 0.04, 0.08),
    "RTX 3070 (8GB)":   (310, 0.06, 0.10),
    "RTX 3080 (10GB)":  (410, 0.09, 0.15),
    "RTX 3090 (24GB)":  (450, 0.15, 0.25),
    "RTX 4070 (12GB)":  (290, 0.10, 0.16),
    "RTX 4080 (16GB)":  (420, 0.20, 0.30),
    "RTX 4090 (24GB)":  (560, 0.30, 0.45),
}


def analyse(watts, usd_hr):
    kw          = watts / 1000
    gross_hr    = usd_hr * USD_TO_GBP
    breakeven_p = (gross_hr / kw) * 100          # p/kWh at which profit = 0

    # --- always on: pay whatever the price is, every slot ---
    always = sum((gross_hr - kw * (p / 100)) for p in AGILE_DAY_P) / 2   # /2 = half-hours
    always_month = always * (HOURS_PER_MONTH / 24) * BASE_UTILISATION

    # --- gated: skip only the slots that lose money ---
    profitable = [p for p in AGILE_DAY_P if p < breakeven_p]
    gated = sum((gross_hr - kw * (p / 100)) for p in profitable) / 2
    gated_month = gated * (HOURS_PER_MONTH / 24) * BASE_UTILISATION

    hours_offered = len(profitable) / 2
    return breakeven_p, always_month, gated_month, hours_offered


print("=" * 100)
print("SHOULD THE SYSTEM PAUSE THE CARD? — modelled on a representative Agile day")
print("=" * 100)
print(f"{'GPU':<20} {'rate':<9} {'break-even':>11} {'always-on':>11} {'gated':>9} "
      f"{'hrs/day':>8}  verdict")
print("-" * 100)

worth_building = []

for gpu, (watts, lo, hi) in GPUS.items():
    for label, rate in (("low", lo), ("high", hi)):
        be, always, gated, hrs = analyse(watts, rate)
        gain = gated - always
        if hrs == 0:
            verdict = "NEVER PROFITABLE — don't list it"
        elif hrs == 24:
            verdict = "never pause; gating adds nothing"
        else:
            verdict = f"GATE IT: +£{gain:,.0f}/mo"
            worth_building.append((gpu, label, gain))
        a_s = f"£{always:,.0f}" if always > 0 else f"-£{abs(always):,.0f}"
        print(f"{gpu:<20} {label:<9} {be:>9.0f}p {a_s:>11} £{gated:>8,.0f} {hrs:>8.1f}  {verdict}")
    print()

print("=" * 100)
if worth_building:
    best = max(worth_building, key=lambda x: x[2])
    print(f"Gating earns its keep on {len(worth_building)} of 14 card/rate combinations.")
    print(f"Biggest single gain: {best[0]} at {best[1]} rental rates — +£{best[2]:,.0f}/month.")
    print()
    print("So the automation is worth building, but ONLY for cards whose break-even")
    print("price falls inside the daily peak. For everything else the correct code is")
    print("'leave it on', and the honest answer is that no software is needed.")
else:
    print("Gating never pays. Don't build it.")
print("=" * 100)
