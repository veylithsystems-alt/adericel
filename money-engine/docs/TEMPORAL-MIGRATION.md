# Moving to Temporal (later, not now)

You've said you want to migrate to Temporal.io when you're able. Here's the
honest read on when that's worth doing for *this* system.

---

## Don't migrate yet

For Money Engine specifically, **n8n is the right tool and Temporal would be a
downgrade.** That's not a hedge — it's the actual engineering answer:

| | n8n | Temporal |
|---|---|---|
| Editing a threshold | Click, type, save | Edit code, test, build, deploy |
| Seeing why a run failed | Executions tab, visual | Read logs, query the CLI |
| Adding a Telegram message | Drag a node | Write a client, handle auth |
| Running cost | One container | Server + workers + database |
| **You, at 11pm, one-handed** | Fine | Not fine |

This system's workloads are small, schedule-driven, and independent. That is
n8n's exact sweet spot. Temporal's value is *durable execution* — surviving
crashes mid-workflow, retrying individual steps with state intact, coordinating
long-running processes across days. Money Engine has almost none of that.

**Migrating now would cost you weeks and buy nothing.**

---

## The one part that genuinely wants Temporal

If any piece justifies it, it's **`01-bank-sync`**, because it's the only one
with real durability problems:

- Multiple accounts, each independently rate-limited
- A 90-day consent that expires mid-run
- API calls that must not be retried blindly (you'll burn the daily quota)
- Partial failure that must not lose the accounts that *did* succeed

In n8n today that's handled with `onError: continueRegularOutput` and a sync log.
That's adequate. In Temporal it'd be genuinely better — per-activity retry
policies with backoff, and state that survives a crash mid-loop.

But "genuinely better" on a job that runs twice a day and fails harmlessly is
not worth a rewrite.

---

## Migrate when these become true

Move when you hit **two or more** of these, not before:

1. **You're running it for other people.** Multi-tenant changes everything —
   isolation, per-customer retries, audit trails. Temporal earns its keep here.
2. **A failed run costs real money or trust.** Right now a failed sync means you
   find out next week instead of this week. Nobody is harmed.
3. **You need workflows that span days** with state — a claim submitted, then
   awaiting an HMRC response, then a follow-up, with the whole thing resumable.
4. **n8n's visual editor is fighting you.** When your Code nodes are 200 lines
   and you want tests, version control and a debugger, you've outgrown it.
5. **You need real concurrency control.** Dozens of accounts, global rate limits,
   fair scheduling.

None of those are true for a personal system watching your own bank accounts.

---

## The shape of the migration, when it comes

The good news: **this system was built to migrate cleanly.** That wasn't an
accident.

### What already carries over unchanged

- **The Postgres schema.** Every table, unchanged. Temporal workers would read
  and write exactly the same `money.*` tables.
- **The detection logic.** The Code nodes are plain JavaScript with no n8n
  dependencies — `detect recurring payments` is a pure function from
  transactions to findings. Lift it into a TypeScript activity and it works.
- **The dedupe-key design.** Every finding has a stable, deterministic key. That
  is *precisely* the idempotency model Temporal activities need, so the
  at-least-once retry semantics are already safe.
- **The config.** `levers.yml` is already data, not code.

### What changes

| n8n concept | Temporal equivalent |
|---|---|
| Schedule Trigger | Temporal Schedule |
| HTTP Request node | An Activity with a retry policy |
| Code node | An Activity (or plain workflow code) |
| Postgres node | An Activity wrapping your DB client |
| `onError: continue` | `RetryPolicy` + try/catch in the workflow |
| Split In Batches loop | A plain `for` loop — Temporal makes this durable |
| Executions tab | Temporal Web UI |

### Rough target shape

```typescript
// workflows/bankSync.ts — sketch, not working code
export async function bankSyncWorkflow(): Promise<SyncResult> {
  const token    = await activities.getAccessToken();
  const accounts = await activities.listAccounts(token);

  const results = [];
  for (const accountId of accounts) {
    try {
      // Each account retries independently. One bank being down
      // does not cost you the others — and the loop position
      // survives a worker crash.
      const txs = await activities.fetchTransactions(
        { token, accountId },
        { retry: { maximumAttempts: 3, backoffCoefficient: 2 } }
      );
      // Idempotent because provider_tx_id is unique — a retry is free.
      results.push(await activities.storeTransactions(txs));
    } catch (err) {
      results.push({ accountId, failed: true, err: String(err) });
    }
  }
  return summarise(results);
}
```

### Suggested order, if you do it

1. **`01-bank-sync` first.** Highest durability value, and it's the foundation.
2. **Leave everything else in n8n** and let it read the same database. A hybrid
   runs fine indefinitely — this is the step people skip and regret.
3. **Move `02-leak-radar` next** if the detection logic grows enough to want
   unit tests.
4. **Never move `05-weekly-digest`.** Message formatting is exactly the kind of
   thing you want to tweak visually without a deploy.

Estimated effort for step 1, if you're comfortable with TypeScript: **2–3 days.**
If you're learning Temporal at the same time: **2 weeks.**

---

## The recommendation

Run it on n8n. Get the £3,000–£6,000. Revisit this document in a year, or on the
day you decide to run it for someone other than yourself.

Building the Temporal version first would be the interesting engineering
decision and the wrong business one — and you have a company to build and an
8-month-old. The money is in Stage 1 of `SETUP.md`, and Stage 1 needs no code
at all.
