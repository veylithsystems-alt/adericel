# Money Engine

**A system that finds money you are already losing, and tells you about it —
three things, once a week, and nothing else.**

Entirely separate from Adericel. Self-contained in this folder. Lifts into its
own repository whenever you want it to.

---

## What it is, in one paragraph

Every 12 hours it reads your bank accounts (read-only). It works out which
payments are recurring, notices when one quietly puts its price up or when a
free trial starts charging, spots cash sitting at 0% that could be earning ~4.5%,
and remembers the big government claims that are worth thousands and get lost
purely to forgetting. On Sunday evening it sends you one Telegram message with
at most three things to do, each showing the pounds and the minutes. If nothing
is worth £50 or more, **it sends nothing at all.**

## What it is not

It is **not a trading bot.** Retail algo-trading has a negative expected return
after fees — you are competing with firms whose servers sit in the same building
as the exchange. That is the thing most people picture when they say "autonomous
money system", and it is the one approach that reliably loses.

It also **never moves your money.** Initiating payments requires an FCA licence.
The engine reads, detects, and tells you; you press the button. That is a
feature, not a limitation: a bug in this system can cost you attention, never cash.

---

## The money

Realistic first year for a UK household with one young child:

| | Year 1 |
|---|---|
| One-off claims (childcare, marriage allowance, pension match) | £2,000 – £4,000 |
| Recurring leaks plugged (subscriptions, insurance, idle cash) | £800 – £2,000 |
| Switch offers and regular savers | £200 – £600 |
| **Total** | **£3,000 – £6,000** |
| **Your time after setup** | **~15 min/month** |

A pound you stop losing is untaxed, so £3,000 of plugged leaks is worth roughly
£4,400 of gross salary at basic rate.

Full reasoning, with the maths and the honest caveats: **[docs/STRATEGY.md](docs/STRATEGY.md)**

---

## How it fits together

```
        ┌──────────────────────────────────────┐
        │  Your banks (read-only, open banking)│
        └────────────────┬─────────────────────┘
                         │ every 12h
                  ┌──────▼───────┐
                  │ 01 Bank Sync │  normalises merchants, dedupes
                  └──────┬───────┘
                         │
              ┌──────────┴──────────┐
              │   Postgres (money.*)│
              └──────────┬──────────┘
                         │
     ┌───────────────────┼───────────────────┐
     │                   │                   │
┌────▼─────┐      ┌──────▼──────┐     ┌──────▼──────┐
│ 02 Leak  │      │ 03 Idle Cash│     │ 04 Claims   │
│  Radar   │      │  & Capital  │     │  Calendar   │
│ (daily)  │      │  (weekly)   │     │  (daily)    │
└────┬─────┘      └──────┬──────┘     └──────┬──────┘
     │                   │                   │
     └───────────────────┼───────────────────┘
                         │  everything queues into money.actions
                  ┌──────▼────────┐
                  │ 05 Weekly     │  top 3 by £, or silence
                  │    Digest     │
                  └──────┬────────┘
                         │ Telegram, Sunday 7pm
                  ┌──────▼────────┐
                  │ 06 Close The  │  you reply "done 42"
                  │    Loop       │  → banks the win
                  └───────────────┘
```

Each workflow is independent. If one breaks, the others keep running.

---

## The files

```
money-engine/
├── README.md                      ← you are here
├── config/levers.yml              ← the only file you should need to edit
├── sql/schema.sql                 ← run once against Postgres
├── workflows/                     ← import these into n8n
│   ├── 01-bank-sync.json
│   ├── 02-leak-radar.json
│   ├── 03-idle-cash.json
│   ├── 04-claims-calendar.json
│   ├── 05-weekly-digest.json
│   └── 06-close-the-loop.json
└── docs/
    ├── STRATEGY.md                ← why this works and what doesn't
    ├── SETUP.md                   ← step by step, assumes no tech knowledge
    └── TEMPORAL-MIGRATION.md      ← when and how to move off n8n
```

---

## Getting started

**Read [docs/STRATEGY.md](docs/STRATEGY.md) first.** Twenty minutes, and it is the
part that actually makes you money. The code is just the part that stops you
forgetting.

Then **[docs/SETUP.md](docs/SETUP.md)** walks through the build in stages. You do
not have to do it all at once — Stage 1 alone (the claims calendar) needs no bank
connection and is worth the most money.

---

## The design rule

> Silence is the default. It speaks once a week. Never more than three things.
> Every item names the pounds and links to the button.

A system that pings you constantly is a system you mute in nine days, and a muted
system earns nothing. The restraint is the feature, not a missing dashboard.

---

*Not financial advice. This is automation infrastructure. Product, fund and
account choices are yours, and every rate quoted needs checking against what is
actually available when you read it.*
