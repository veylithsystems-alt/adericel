# GPU Rental — analysis, and why there's no software here

I was going to build a system that rents your GPU out and pauses it when
electricity gets expensive. I modelled it first. **It isn't worth building**,
and the honest thing is to say so rather than ship it anyway.

Run the numbers yourself:

```bash
python3 calculator.py     # net £/month by card and tariff
python3 agile_model.py    # is price-gating worth automating? (no)
```

## What the model says

Renting a GPU in the UK is marginal because our electricity is expensive and
you're competing against hosts whose isn't. Net income after power, assuming
55% of offered hours actually get rented:

| Card | Fixed tariff (~26p) | On Octopus Agile |
|---|---|---|
| RTX 3060 | **loss** | £0–6/mo |
| RTX 3070 | **loss** | £0–9/mo |
| RTX 3080 | £0–4/mo | £0–17/mo |
| RTX 3090 (24GB) | £0–31/mo | £14–46/mo |
| RTX 4070 | £1–20/mo | £10–29/mo |
| RTX 4080 | £19–50/mo | £32–64/mo |
| RTX 4090 (24GB) | £35–82/mo | £53–100/mo |

Two things drive everything: **VRAM** (24GB cards earn multiples of 8GB ones,
because that's what ML workloads need) and **your electricity tariff**.

## Why the clever automation doesn't pay

The naive idea — "only run in the cheap overnight hours" — is actively worse
than leaving it on. It throws away paid work during perfectly profitable hours.
On a 3090 it earns £35/mo versus £46/mo for simply running always.

The *correct* rule is to pause only when power costs more than the work earns:

```
break_even_p_per_kwh = (gross £/hr) / (kW drawn)
```

But when you model that against a real Agile day, it's worth **£1–6/month**.
For every card from the 3090 up at decent rental rates, the break-even sits
above every price Agile ever reaches — meaning the optimal strategy is
*never pause*, and the optimal amount of code is *none*.

## So: two actions, thirty minutes, done forever

1. **List the card on vast.ai** (or salad.io — lower earnings, much simpler).
   Set your price at or slightly below comparable cards to get utilisation up;
   an unrented GPU earns nothing regardless of what you ask for it.
2. **Switch to Octopus Agile** if your card is a 3080 or below. Below a 3090 on
   a fixed tariff you are burning more in electricity than you earn.

Then leave it alone. That's the whole system.

## Before you do it, the non-financial costs

These matter more than the money at this scale, and with a baby in the house:

- **Noise and heat.** A GPU at full load for hours is loud and warms the room.
- **The PC is unusable while rented.** You can't game on it.
- **Wear.** Sustained load and thermal cycling age fans and paste faster.
- **It isn't truly zero-maintenance.** Drivers, Docker, the odd reboot.
- **Check your tenancy or mortgage terms** if you're running it hard.

At £30–60/month, ask whether the noise in a small home with an 8-month-old is
worth it. That's a genuine question, not a rhetorical one — for some setups
it clearly is.

---

*All figures are estimates. Vast.ai pricing moves with demand and the USD rate
moves too. Check live numbers before committing; the scripts take your own
inputs.*
