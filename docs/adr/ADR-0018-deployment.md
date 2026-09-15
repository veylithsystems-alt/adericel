# ADR-0018: Self-hosted, container-first deployment

**Status:** Accepted · **Date:** 2026-09-09

## Context

Adericel's first deployment is a single 16 GB VPS costing about £11 a month,
running PostgreSQL, Redis, n8n and local models alongside the application. Its
tenth deployment might be an MSP's own infrastructure, because an MSP holding
security data for eighty customers may have a policy against handing it to
another SaaS.

Both have to work from the same repository, and neither can require expertise
the operator does not have.

## Decision

**Containers, composed, with explicit resource limits and profiles.**

- One image for API, worker and migrations (`infrastructure/docker/Dockerfile`),
  because they share code and building them separately means three chances to
  diverge.
- A separate image for the interface: static files served by Caddy, no Node
  process at runtime.
- `docker-compose.yml` with profiles — `core`, `workflow`, `ai` — so an operator
  can run only what they need. `core` alone is a complete, working Adericel.
- **Explicit memory limits on every service.** On a single host the failure mode
  is one process ballooning and the kernel killing something that matters, and
  the kernel's preferred victim is PostgreSQL because it has the largest
  resident set. With limits, the worst case is a service restarting.
- Node's heap cap is set below each container limit so V8 collects rather than
  the process being killed.
- One origin serves the interface and the API, with the edge proxy stripping
  `/api`. This is a security decision as much as a routing one: the browser's
  token is never sent cross-origin and CORS stays closed.

Migrations run as a one-shot service that must complete successfully before the
API starts. Schema and code ship in the same image, so they cannot be different
versions.

## Alternatives considered

**Kubernetes from the start.** Rejected without much difficulty: a control plane
that consumes more memory than the entire application, for a deployment with no
second node. The compose file is written so that the migration is mechanical if
it is ever warranted — every service is stateless except PostgreSQL and the
object store.

**A managed platform (Fly, Render, Railway).** Faster to launch and cheaper in
attention. Rejected as the _primary_ target because it forecloses the MSP
self-hosting case, which is a commercial requirement rather than a technical
preference. Nothing in the architecture prevents deploying there.

**A single process running everything.** Tempting on a small machine and wrong:
the worker's failure modes are different from the API's, and a stuck collection
should not stop serving requests.

**Nix or bare-metal packaging.** Reproducible and unfamiliar. Docker is what the
target operator already has.

## Consequences

- The whole system starts with two commands and a filled-in `.env`.
- Resource limits are documented with their working
  (`docs/operations/vps-sizing.md`) rather than being magic numbers.
- Building on the VPS itself is viable but slow; the images are also built in CI
  on every change, so a Dockerfile that no longer works fails there first.
- The `ai` profile is genuinely optional. Adericel with AI stopped is fully
  functional, because AI never enters the assurance chain (ADR-0004).

## Security implications

Only Caddy publishes ports. PostgreSQL, MinIO, Redis, n8n and Ollama are on the
internal network with `expose` rather than `ports` — a distinction that is easy
to get wrong and that decides whether a database is on the public internet.

The application connects to PostgreSQL as a role that is not the table owner, so
row-level security applies to it (ADR-0007). A deployment that gets this wrong
still passes every test, because the application layer is intact, which is why
it is called out in the runbook and in `.env.example`.

The images run as a non-root user, carry no build toolchain, and exclude the
web application's dependency tree from server images.

## Operational implications

Logs are JSON with rotation configured, so a chatty failure loop cannot fill the
disk. Health checks are wired for dependency ordering, and the API's readiness
probe checks the database rather than only the process.

Certificates are obtained automatically, which means port 80 must be reachable —
the single most common cause of a failed first deployment, and it is in the
first-start checklist for that reason.

## Migration implications

Moving PostgreSQL to its own host is a change to `DATABASE_URL`. Moving to
Kubernetes is a translation of the compose file, since limits, health checks and
dependency ordering are already declared. Neither requires an application
change, which is the property this decision is buying.
