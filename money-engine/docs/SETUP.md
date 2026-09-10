# Setup

Written assuming you know nothing about the tech. Every step says what to click.

**You do not have to do this all at once.** It is built in four stages, in order
of money-per-effort. Stage 1 needs no bank connection at all and is worth the
most. Stop after any stage and the system still works.

---

## Stage 1 — The claims calendar (worth the most, needs nothing)

**Money: £2,000–£4,000. Time: 30 minutes to set up.**

This stage needs no bank connection, no API keys, and barely any setup. It is a
reminder engine for the handful of claims that are worth thousands and get lost
purely to forgetting.

Honestly? You could skip the software entirely and just do these four things
this week:

1. **Register for Child Benefit** — [gov.uk/child-benefit/how-to-claim](https://www.gov.uk/child-benefit/how-to-claim)
   Put the claim in whichever of you earns less. That awards National Insurance
   credits toward their State Pension. If your income means you'd have to pay it
   back, **still register** and tick "do not pay me" — you keep the NI credits
   without the tax charge. Not registering at all is the most expensive admin
   mistake new UK parents make.

2. **Open a Tax-Free Childcare account** — [gov.uk/apply-for-tax-free-childcare](https://www.gov.uk/apply-for-tax-free-childcare)
   Government adds £2 for every £8, up to £500 per quarter per child. A
   guaranteed 25% return on money you're already spending. *You must reconfirm
   every 3 months or it silently switches off* — that reconfirmation is exactly
   what the software is for.

3. **Claim Marriage Allowance** — [gov.uk/marriage-allowance](https://www.gov.uk/marriage-allowance)
   If one of you earns under the Personal Allowance and the other is basic-rate.
   Backdatable four years — usually about £1,000 as a lump sum. Claim direct on
   gov.uk; never use a claims company, they take a huge cut of a 15-minute form.

4. **Check your workplace pension percentage.** If your employer matches up to
   6% and you're paying 3%, you're declining a pay rise.

The software's job is to make sure the *repeating* ones (the quarterly childcare
reconfirmation, the annual insurance sweep, the ISA deadline) never get missed
again. To get that running, do the n8n bit below and import
`04-claims-calendar.json` and `05-weekly-digest.json` only.

---

## Stage 2 — n8n and the database

**Time: 1–2 hours.**

### 2.1 Get n8n running

If you already have n8n, skip to 2.2. Otherwise the simplest self-hosted route
is Docker. Create a folder, save this as `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: n8n
      POSTGRES_PASSWORD: CHANGE_THIS_TO_SOMETHING_LONG
      POSTGRES_DB: n8n
    volumes:
      - ./pgdata:/var/lib/postgresql/data

  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    ports:
      - "5678:5678"
    environment:
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: postgres
      DB_POSTGRESDB_DATABASE: n8n
      DB_POSTGRESDB_USER: n8n
      DB_POSTGRESDB_PASSWORD: CHANGE_THIS_TO_SOMETHING_LONG
      GENERIC_TIMEZONE: Europe/London
      TZ: Europe/London
      # Secrets the workflows read via $env
      GOCARDLESS_SECRET_ID: ""
      GOCARDLESS_SECRET_KEY: ""
      GOCARDLESS_REQUISITION_ID: ""
      TELEGRAM_CHAT_ID: ""
    volumes:
      - ./n8n-data:/home/node/.n8n
    depends_on:
      - postgres
```

Then run `docker compose up -d`. n8n is at `http://localhost:5678`.

> **If you'd rather not run servers:** n8n Cloud is a paid hosted option and
> everything here works identically — you'd set the environment variables in
> their UI instead. Given you have a baby and a company to build, paying to not
> maintain a server is a very reasonable trade.

### 2.2 Create the database tables

```bash
docker compose exec -T postgres psql -U n8n -d n8n < sql/schema.sql
```

You should see a series of `CREATE TABLE` lines. That's it — the database is done.

### 2.3 Add the Postgres credential in n8n

In n8n: **Credentials → Add credential → Postgres**

| Field | Value |
|---|---|
| Host | `postgres` |
| Database | `n8n` |
| User | `n8n` |
| Password | whatever you set above |
| Port | `5432` |

Name it exactly **`Money Engine DB`**. Save.

### 2.4 Set up Telegram

1. In Telegram, message **@BotFather**, send `/newbot`, follow the prompts.
2. He gives you a **bot token**. Copy it.
3. In n8n: **Credentials → Add credential → Telegram API**, paste the token,
   name it **`Money Engine Bot`**.
4. Send your new bot any message (say "hello") so it's allowed to reply to you.
5. Get your chat ID: visit
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and look
   for `"chat":{"id":123456789`. That number goes in `TELEGRAM_CHAT_ID`.

### 2.5 Import the workflows

In n8n: **Workflows → Import from File**, one at a time, for each file in
`workflows/`. After importing each one, open it and check every Postgres node
shows `Money Engine DB` and every Telegram node shows `Money Engine Bot` — n8n
usually picks them up automatically but occasionally doesn't.

**Turn on `04-claims-calendar` and `05-weekly-digest` now.** Leave the rest off
until Stage 3.

You should get your first digest the following Sunday at 7pm.

---

## Stage 3 — Connecting your bank

**Money: £800–£2,000/yr. Time: 45 minutes.**

This is what turns the reminder engine into a detector.

### 3.1 Open-banking access

Sign up at **[bankaccountdata.gocardless.com](https://bankaccountdata.gocardless.com)**
(formerly Nordigen). They offer a free tier for personal use covering UK and EU
banks. *Check their current pricing and limits when you sign up — terms change.*

From their dashboard, generate a **Secret ID** and **Secret Key**.

### 3.2 Link your accounts

Follow their "requisition" flow to connect each bank. You'll be bounced to your
bank's own app to approve read-only access. At the end you get a
**requisition ID** — that's what the workflow uses.

Two things worth knowing up front:

- **Consent expires every 90 days.** UK regulations require re-authorisation.
  The workflow throws a clear error when this happens rather than failing
  silently. Put a recurring reminder in your phone.
- **There is a daily API call limit per account** (typically around 4). The
  workflow runs every 12 hours, well inside it.

### 3.3 Put the secrets in

Fill in `GOCARDLESS_SECRET_ID`, `GOCARDLESS_SECRET_KEY` and
`GOCARDLESS_REQUISITION_ID` in your `docker-compose.yml`, then
`docker compose up -d` to restart.

### 3.4 Tell the system what your accounts pay

The API can't read your interest rate, so set it once by hand:

```sql
UPDATE money.balances
SET account_label = 'Main current account', interest_rate_pct = 0.00
WHERE account_id = 'the-id-from-the-balances-table';
```

Run `SELECT * FROM money.balances;` first to see the IDs.

### 3.5 Turn it on

Enable `01-bank-sync`, then run it manually once. It'll pull roughly 90 days of
history. Then enable `02-leak-radar` and `03-idle-cash` and run each manually.

Check what it found:

```sql
SELECT display_name, typical_amount_gbp, interval_days, annual_cost_gbp
FROM money.subscriptions WHERE status = 'active'
ORDER BY annual_cost_gbp DESC;
```

**Most people are genuinely shocked by this list the first time.** That reaction
is the entire point of the system.

---

## Stage 4 — Capital

**Time: 20 minutes, once.**

Once the leaks are plugged you'll have surplus. Set up a standing order on
payday into a Stocks & Shares ISA holding a low-cost global index tracker, and
then never look at it again.

Set `monthly_investment_standing_order_gbp` in the CONFIG block of
`03-idle-cash.json` to the amount. The engine won't move the money — it just
checks the transfer actually happened and nags you if it didn't.

This is the only part of the system that compounds, and the only part that is
genuinely, permanently autonomous. It is also the most boring, which is why it
works.

*Fund and platform choice is yours — I'm automation, not an adviser.*

---

## Living with it

**Every Sunday, 7pm:** one message, up to three items. Reply `done 42` when you
finish one and it banks the win. Reply `skip 42` and you'll never hear about it
again.

**Nothing worth £50+? No message.** Do not "fix" this. It's why you'll still be
reading the messages in six months.

**Once a quarter:** re-authorise the bank consent when it expires.

**Once a year, after the April Budget:** skim `config/levers.yml` and update any
rates that changed.

That's the whole maintenance burden.

---

## When something breaks

```sql
-- Did everything run? Should show all workflows in the last day or two.
SELECT workflow, MAX(ran_at) AS last_run, bool_and(ok) AS healthy
FROM money.sync_log
WHERE ran_at > now() - INTERVAL '7 days'
GROUP BY workflow ORDER BY last_run DESC;
```

| Symptom | Cause | Fix |
|---|---|---|
| "No accounts on this requisition" | 90-day consent expired | Re-run the GoCardless link flow, update the requisition ID |
| No digest arrived | Genuinely nothing above £50 — this is correct behaviour | Check `SELECT * FROM money.actions WHERE status='open'` to confirm |
| Same subscription flagged twice | Merchant name changed at the bank | Merge the rows in `money.subscriptions`, or add it to the `ignore` list |
| Telegram silent | Bot never messaged first | Send your bot a message manually, then retry |
| Every shop looks like a subscription | Detection too loose | Raise `minOccurrences` to 4 in `02-leak-radar.json` |

In n8n, **Executions** in the left sidebar shows every run and exactly which node
failed — that's the first place to look for anything not covered above.
