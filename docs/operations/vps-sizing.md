# Running Adericel on one 16 GB VPS

This is the working behind the memory limits in `docker-compose.yml`, and an
honest account of what the box will and will not do. It is written for the
specific case it was sized for: a 16 GB UK VPS at roughly £11/month, running
Adericel, PostgreSQL, Redis, n8n and local Ollama models side by side.

## The short answer

Yes, it runs, with one condition attached: **do not run Ollama and expect
interactive response times while a collection is in flight.** Everything else
fits comfortably. Adericel itself — API, worker, interface, database — is a
small footprint; n8n is the second-largest consumer; Ollama is larger than
everything else combined and is the only optional part.

## Measured, not estimated

These are resident-set sizes taken from a running instance with four
organisations, 122 graph nodes, 29 evidence records, 194 claims, 84 assessments
and 417 events:

| Process            | Measured                 | Limit set | Why the headroom                                                                                          |
| ------------------ | ------------------------ | --------- | --------------------------------------------------------------------------------------------------------- |
| Adericel API       | ~117 MB (dev, unbundled) | 512 MB    | Evidence uploads are streamed but multipart parsing spikes; 50 MB upload cap × a few concurrent           |
| Adericel worker    | ~90 MB                   | 448 MB    | Outbox batches of 25, each carrying an event payload                                                      |
| PostgreSQL         | ~101 MB idle             | 2 GB      | `shared_buffers` alone is 512 MB; the rest is connection working memory at `work_mem=8MB × 60` worst case |
| Web (static files) | ~8 MB                    | 64 MB     | Caddy serving a directory                                                                                 |
| Caddy (edge)       | ~20 MB                   | 128 MB    | TLS session state                                                                                         |
| Redis              | —                        | 512 MB    | `maxmemory 384mb`, so the container limit is never the binding constraint                                 |
| n8n                | —                        | 1.5 GB    | Node heap capped at 1 GB; the rest is the editor bundle and execution data                                |

The Adericel database was 14 MB at that data volume. Growth is dominated by
`event_log`, `audit_log` and `assessments`, all append-only by design — see
"Storage growth" below.

Total for everything except Ollama: **about 5.1 GB of limits**, against roughly
340 MB actually resident at idle. Leaving 1.5 GB for the operating system and
page cache, that leaves **approximately 9 GB for Ollama**.

## What 9 GB buys you in local inference

| Model class                                    | Quantisation | Resident    | Fits                                                          |
| ---------------------------------------------- | ------------ | ----------- | ------------------------------------------------------------- |
| 7–8B (Llama 3.1 8B, Mistral 7B, Qwen 2.5 7B)   | Q4_K_M       | ~5.5 GB     | Yes, comfortably                                              |
| 7–8B                                           | Q8_0         | ~9 GB       | Only with the `workflow` profile stopped                      |
| 13–14B                                         | Q4_K_M       | ~9.5 GB     | No                                                            |
| Embedding models (nomic-embed-text, bge-small) | —            | ~0.3–0.7 GB | Yes, alongside an 8B model? No — `OLLAMA_MAX_LOADED_MODELS=1` |

That last row is the one that catches people. If you want embeddings _and_
generation, either raise `OLLAMA_MAX_LOADED_MODELS` to 2 and drop to a smaller
generation model, or accept that Ollama will swap models between requests, which
costs several seconds of load time each way.

The bigger constraint is not memory, it is CPU. A 16 GB VPS in this price band
has 4–6 shared vCPUs and no GPU. An 8B model at Q4 on 3 CPU cores produces
roughly **4–8 tokens per second**. A 500-token extraction takes over a minute.
That is fine for the way Adericel uses AI — batch document extraction producing
candidate claims a human later confirms — and completely unusable for anything
interactive.

`OLLAMA_CPUS` defaults to 3 for exactly this reason. Without a CPU limit, one
inference saturates the box, PostgreSQL checkpoints stall, and the API health
check starts timing out. The limit means inference is slow instead of everything
being slow.

## Vector embeddings

Adericel does not require a separate vector database. If you add semantic search
over evidence and policy text later, install the `pgvector` extension into the
existing PostgreSQL instance rather than running a second store. At the scale
this box handles — tens of thousands of chunks, not tens of millions — an
IVFFlat index in PostgreSQL is both faster to operate and one fewer thing to
back up. Budget roughly 6 KB per chunk with a 768-dimension embedding; 50,000
chunks is about 300 MB, which fits inside the 2 GB PostgreSQL allocation without
changing anything.

## Profiles: what you can turn off

```
docker compose --profile core up -d                                  # ~3.2 GB of limits
docker compose --profile core --profile workflow up -d               # ~5.1 GB
docker compose --profile core --profile workflow --profile ai up -d  # ~13.1 GB
```

The `ai` profile is genuinely optional. Adericel's assurance chain does not
depend on it: AI can only ever produce candidate claims marked `AI_SUGGESTED`,
which `isRuleEligible()` refuses to feed to the Truth Engine until a human
confirms them (ADR-0004). With the profile stopped, document extraction has to
be done by hand and everything else is unchanged. Nothing reports UNKNOWN
because AI is off; it reports UNKNOWN because evidence is missing, which is the
same thing it would report either way.

## What this box will not do

Stated plainly, so it is not discovered at the wrong moment:

- **No high availability.** One host, one PostgreSQL. A kernel panic is an
  outage until it reboots, and an unrecoverable disk failure is a restore from
  backup.
- **No horizontal scale.** The worker uses `FOR UPDATE SKIP LOCKED`, so a second
  worker is safe to add — but there is nowhere to put it on this machine.
- **Concurrent collection is limited.** Integration collection runs in the
  worker with a bounded pool. Ten organisations collecting simultaneously will
  queue rather than fail, but a portfolio-wide reassessment is a several-minute
  operation, not a several-second one.
- **Backups are not free space.** `pg_dump` of a growing database plus its
  retained copies needs room. See below.

## Where the ceiling actually is

Extrapolating from the measured 14 MB for four organisations, dominated by
append-only history rather than by current state:

| Organisations | Database size after 12 months | Comfortable?                                     |
| ------------- | ----------------------------- | ------------------------------------------------ |
| 10            | ~1.5 GB                       | Yes                                              |
| 50            | ~8 GB                         | Yes                                              |
| 150           | ~25 GB                        | Yes on memory; watch disk and `pg_dump` duration |
| 400+          | ~70 GB                        | Move PostgreSQL to its own host                  |

Memory is not what runs out first. Disk and backup windows are. The trigger to
move PostgreSQL onto its own machine is a `pg_dump` that takes longer than the
window you are willing to hold a consistent snapshot for, which in practice
arrives somewhere between 150 and 250 organisations.

## Storage growth and retention

Three tables grow monotonically and are meant to: `event_log`, `audit_log`, and
`assessments`. That is a deliberate consequence of "do not destroy historical
truth" (ADR-0010) — an assessment history you prune is an assurance history you
cannot replay.

What you _can_ prune safely:

- **n8n execution data.** Already configured: `EXECUTIONS_DATA_PRUNE=true`,
  14 days, 20,000 executions. This is by far the fastest-growing table on the
  box and none of it is Adericel truth.
- **Evidence object bodies past their retention policy**, once superseded and
  past any regulatory hold. The evidence _record_ — hash, provenance, validity
  window — stays; the bytes can go to cold storage. The record remains
  verifiable in the sense that matters: you can still prove what was asserted,
  when, and by whom.

What you must not prune: assessments, the event log, the audit log, or evidence
records. If disk pressure ever makes that tempting, that is the signal to move
PostgreSQL to its own host, not to start deleting history.

## First-start checklist

```bash
cp .env.example .env
# Fill in POSTGRES_PASSWORD, AUTH_JWT_SECRET, AUTH_CREDENTIAL_ENCRYPTION_KEY,
# MINIO_ROOT_PASSWORD, N8N_ENCRYPTION_KEY, ADERICEL_DOMAIN.

docker compose --profile core up -d
docker compose logs -f migrate          # migrations run once, then exit 0
docker compose --profile core --profile workflow up -d

# Import the workflow system into n8n:
docker compose cp workflows/n8n/adericel.n8n.json n8n:/tmp/adericel.n8n.json
docker compose exec n8n n8n import:workflow --separate --input=/tmp/adericel.n8n.json
```

Then, in the n8n interface, create the `Adericel API` credential (a header
credential carrying an Adericel API key you issue from the Adericel interface).
The export references that credential by name and contains no secret of its own
— which is why the import is not complete until you have created it.

## Swap

Add 2 GB of swap even though the box has 16 GB. Not to run in, but so that a
transient spike degrades into slowness rather than the OOM killer choosing a
victim — and the OOM killer's preferred victim on a box like this is
PostgreSQL, because it has the largest resident set.

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10   # swap as a safety net, not as a strategy
```

## When to move off this box

In order of which arrives first:

1. **n8n execution volume** — the pruning settings stop coping. Move n8n to its
   own host; it is the most isolated component and the easiest to relocate.
2. **Inference latency** — AI extraction is being used often enough that
   minutes-per-document matters. This is a case for a hosted model API, not a
   bigger VPS: a GPU host costs more per month than the entire rest of the
   deployment.
3. **PostgreSQL backup duration** — as above, 150–250 organisations.
4. **Everything at once** — at which point the answer is two machines
   (application, database) rather than one bigger one, because the failure
   domains are what you are actually buying.
