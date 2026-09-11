# Code scanning findings and dispositions

Every CodeQL finding on this repository is recorded here with a disposition —
fixed, false positive, or accepted risk — and the technical reasoning. Nothing
is dismissed on the grounds that the application appears to work.

The list is reproducible. It was produced by running the same query suite CI
runs, against the same commit, with the CodeQL CLI:

```bash
codeql database create db --language=javascript-typescript --source-root=.
codeql database analyze db javascript-security-extended.qls --format=sarif-latest --output=results.sarif
```

**Baseline: 20 results across 11 distinct source locations.**
**After this pass: 2 results, both one rule, both documented below.**

---

## Fixed

### `js/hardcoded-credentials` — 6 locations, security-severity 9.8

`crypto.ts`, `envelope.ts`, `totp.ts`, `auth/tokens.ts`.

**Genuine, and one instance was exploitable.**

Every site used the shape `createHmac('sha256', '<public label>').update(secret)`.
That puts a public constant in HMAC's _key_ position and the secret in the
_message_ position. HMAC's security as a key-derivation function rests on the
key being secret, so these were domain-separated hashes of a secret rather than
keyed derivations — reproducible by anyone who knew the label, which is anyone
who has read the source.

For 32-byte random values the practical impact was nil: an attacker with the
database still faces a 256-bit search. **Recovery codes were different.** They
were ten base32 characters — 50 bits, because a person has to type them — and
their digest was reproducible. A database disclosure therefore permitted an
offline search of roughly a day on rented GPU time, recovering every recovery
code in the table and defeating the second factor that guards approval
authority.

Fixed in three parts:

- `deriveSubkey()` uses **HKDF-SHA256**, with the deployment's root secret as
  input keying material and the label as `info` — which is what `info` is for.
- `createTokenHasher()` produces **keyed** digests for refresh tokens, API key
  secrets and recovery codes, each under its own subkey so a digest from one
  table cannot be replayed against another. The key derives from the existing
  root secret rather than a new setting: HKDF exists precisely so one
  well-guarded secret yields many purpose-bound subkeys, and a fourth secret for
  an operator to mismanage would be a worse outcome than the one it prevents.
- Recovery codes are now **15 base32 characters (75 bits)**, so the entropy
  holds even if the hashing key is disclosed alongside the database.

Regression coverage: `packages/shared/src/totp.test.ts` asserts the code format
and that the module exposes only a normalised digest _input_ — it has no access
to the secret, so any hash it grew would necessarily be unkeyed again.

While fixing this, a second copy of the credential key derivation was found in
`envelope.ts`, already diverged from the one in `crypto.ts`. It now delegates
rather than duplicating. Two copies of a key derivation is a defect waiting for
a quiet Tuesday.

### `js/polynomial-redos` — 2 locations, security-severity 7.5

`onboarding.ts` (`slugify`) and `totp.ts` (`base32Decode`).

**True of the pattern, not exploitable in context — fixed anyway.**

Both were anchored repetition (`/^-+|-+$/`, `/=+$/`) over attacker-influenced
text. Measured against V8 at up to 60,000 repetitions the cost stayed flat, and
the organisation name is capped at 200 characters by validation before it
reaches `slugify`.

Both facts are about the current situation rather than properties of the
functions. Somebody calling `slugify` from an unbounded path later reintroduces
the problem silently. Both now trim with a loop, which cannot backtrack at all.

### Rate limiting returned 500 instead of 429 — found while verifying a finding

Not reported by CodeQL. Found by writing the test that was meant to _dismiss_
`js/missing-rate-limiting` as a false positive, which is the argument for
proving mitigations rather than asserting them.

`@fastify/rate-limit` hands its built response to the error handler rather than
sending it. The body carried no `statusCode`, so it fell through to the
unhandled branch: exceeding a rate limit produced `500 INTERNAL_ERROR`. A
throttled client could not distinguish a limit from a fault, and 500 is the
response a client retries hardest — so the bug amplified the load it existed to
shed.

Worse, health endpoints were themselves throttled. Once the budget was exhausted
`/health/live` returned 500, which an orchestrator reads as a dead container.
A traffic spike would have become a restart loop.

Both fixed and covered by `tests/security/webhook-hardening.test.ts`.

---

## False positive, mitigation verified

### `js/missing-rate-limiting` — 2 locations, security-severity 7.5

`apps/api/src/routes/webhooks.ts` — the observation ingestion and ping routes.

CodeQL cannot see `@fastify/rate-limit`, which is registered as a plugin rather
than as per-route middleware it recognises. The routes are rate-limited twice
over: the global limiter applies to every route, and these two carry an explicit
per-route budget of **60 requests per minute** — tighter than the API-wide
setting, because they are the only routes reachable without a principal.

This is documented as a false positive only because the mitigation is proven
rather than described: `tests/security/webhook-hardening.test.ts` drives the
endpoint past its budget and asserts a 429. Writing that test is what surfaced
the 500-instead-of-429 defect above.

A further mitigation worth recording: when no signing secret is configured, the
webhook endpoints are **disabled outright** rather than accepting unsigned
deliveries, and signature verification runs before any database access — so a
forged request costs one HMAC and nothing else.

---

## Scanner configuration

`.github/codeql-config.yml` excludes two things, both because they produced
findings that were not about Adericel's source.

**`dist/`** is compiled output of files already being scanned. Every genuine
finding appeared twice and every fix needed verifying twice. It also contains
the bundled web application, which reported `js/incomplete-url-scheme-check`
inside a third-party router — a finding about a dependency's code, surfaced as
though it were ours.

**Test files** hold deliberately fake credentials: a Stripe webhook secret used
to prove that signature verification rejects the wrong key was reported as a
hard-coded credential. Flagging those trains the reader to skim the list, which
is the failure mode that lets a real one through.

Neither exclusion hides application code from analysis.
