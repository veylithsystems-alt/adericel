/**
 * What state each capability in this repository is actually in.
 *
 * Contract v3.1 §6 and the residual-risk register's RR-052. Until now this was
 * tracked by hand in audit documents, which is how a status becomes stale
 * without anybody deciding that it should.
 *
 * HOW TO READ THIS FILE
 *
 * Each capability lists an attestation **per status**, and each attestation
 * names its own evidence. Nothing is inferred: a capability attested
 * OPERATIONAL with no VERIFIED attestation has skipped the step where an
 * invariant gets proved by breaking it, and `positionOf()` reports that as a
 * skip rather than filling it in.
 *
 * WHY SO MANY ROWS STOP AT VERIFIED OR OPERATIONAL
 *
 * Because that is where they are. PROVEN, PRODUCTION_READY and
 * COMMERCIAL_VALIDATED are claims about the world outside this repository — a
 * real customer used it, a named person would stand behind it in a dispute,
 * somebody paid and stayed — and `attestationProblems()` refuses to let an
 * automated check establish any of them. No capability in Adericel has any of
 * those three today, and this file is the place that says so rather than an
 * audit document somebody has to remember to update.
 *
 * EVIDENCE RULES
 *
 * An evidence string names something a reader can go and look at: a path, a
 * command, a CI job, a person, a customer. It never restates the status.
 */
import type { Capability } from '@adericel/domain';

const TESTED = (evidence: string) =>
  ({ status: 'TESTED', source: 'AUTOMATED_CHECK', evidence, establishedAt: '2026-09-23' }) as const;
const VERIFIED = (evidence: string) =>
  ({
    status: 'VERIFIED',
    source: 'AUTOMATED_CHECK',
    evidence,
    establishedAt: '2026-09-23',
  }) as const;
const IMPLEMENTED = (evidence: string) =>
  ({
    status: 'IMPLEMENTED',
    source: 'AUTOMATED_CHECK',
    evidence,
    establishedAt: '2026-09-23',
  }) as const;
const OPERATIONAL = (evidence: string) =>
  ({
    status: 'OPERATIONAL',
    source: 'AUTOMATED_CHECK',
    evidence,
    establishedAt: '2026-09-23',
  }) as const;
const DESIGNED = (evidence: string) =>
  ({
    status: 'DESIGNED',
    source: 'NAMED_PERSON',
    evidence,
    establishedAt: '2026-09-23',
  }) as const;

export const CAPABILITY_REGISTER: readonly Capability[] = [
  {
    key: 'truth-engine',
    title: 'The Truth Engine',
    attestations: [
      DESIGNED('ADR-0003 (UNKNOWN as a first-class state), ADR-0005 (rules as data)'),
      IMPLEMENTED('packages/truth-engine/src/engine.ts — assessControl()'),
      TESTED('packages/truth-engine/src/*.test.ts'),
      VERIFIED(
        'packages/truth-engine/src/engine.test.ts "invariants across every shipped rule" — no ' +
          'shipped rule reports SATISFIED with no facts at all, quantified over every rule in ' +
          'every built-in ruleset; kleene.test.ts proves no conjunction containing UNKNOWN ' +
          'reports TRUE; tests/unit/engine-purity.test.ts proves the engine reaches no clock, ' +
          'database or model',
      ),
      OPERATIONAL('Runs in the worker and the API on every assessment; .github/workflows/ci.yml'),
    ],
  },
  {
    key: 'tenant-isolation',
    title: 'Tenant isolation',
    attestations: [
      DESIGNED('ADR-0002 (row level security as the second line), ADR-0011 (surfaces)'),
      IMPLEMENTED('database/migrations/0006_row_level_security.sql; packages/graph/src/db.ts'),
      TESTED('tests/tenancy/isolation.test.ts'),
      VERIFIED(
        'tests/security/tenant-isolation-enforcement.test.ts — every tenant table proved to ' +
          'carry FORCE ROW LEVEL SECURITY and a policy, with the application refusing to start ' +
          'when one does not; cross-tenant reads proved refused by deliberate attempt in ' +
          'tests/tenancy/isolation.test.ts',
      ),
      OPERATIONAL('Enforced on every request in every deployment; readiness probe checks it'),
    ],
  },
  {
    key: 'assurance-passport',
    title: 'The Assurance Passport and its independent verification',
    attestations: [
      DESIGNED('ADR-0031 (Passport), ADR-0044 (signed interchange)'),
      IMPLEMENTED(
        'apps/api/src/services/passport.ts, apps/api/src/services/passport-interchange.ts, ' +
          'apps/api/src/routes/passport.ts',
      ),
      TESTED('tests/e2e/assurance-passport.test.ts, tests/e2e/passport-interchange.test.ts'),
      VERIFIED(
        'A Passport signed under one key id proved unverifiable under another, by deliberate ' +
          'substitution; a tampered content block proved to fail the hash check',
      ),
      OPERATIONAL('Issued through the API; verifiable with the published standalone verifier'),
    ],
  },
  {
    key: 'containment',
    title: 'Governed containment C0–C5',
    attestations: [
      DESIGNED('ADR-0046; contract §15'),
      IMPLEMENTED('packages/containment; database/migrations/0028_governed_containment.sql'),
      TESTED('tests/e2e/containment.test.ts'),
      VERIFIED(
        'Automation proved able to enter containment and refused permission to leave it, by ' +
          'deliberate attempt; commercial restriction proved not to reach the containment path',
      ),
    ],
  },
  {
    key: 'break-glass',
    title: 'Break-glass emergency access',
    attestations: [
      DESIGNED('ADR-0047; contract §28'),
      IMPLEMENTED('packages/domain/src/break-glass.ts; apps/api/src/services/break-glass.ts'),
      TESTED('tests/e2e/break-glass.test.ts'),
      VERIFIED(
        'Grant attenuation proved to subtract only: a database trigger refuses a widening ' +
          'update and refuses NULLing the narrowing, each proved by deliberate attempt',
      ),
    ],
  },
  {
    key: 'support',
    title: 'The support domain',
    attestations: [
      DESIGNED('Contract §20–26'),
      IMPLEMENTED('packages/support; database/migrations/0031_support_domain.sql'),
      TESTED('tests/e2e/support-cases.test.ts'),
      VERIFIED(
        'The disclosure gate proved to refuse rather than redact, and an end customer’s case ' +
          'proved to route to their MSP, each by deliberate attempt at the opposite',
      ),
    ],
  },
  {
    key: 'resolution-queue',
    title: 'The resolution queue for unknowns',
    attestations: [
      DESIGNED('Contract §6; the product brief on making UNKNOWN operationally useful'),
      IMPLEMENTED('packages/resolution; apps/api/src/services/resolution.ts'),
      TESTED('tests/e2e/resolution-queue.test.ts, packages/resolution/src/plan.test.ts'),
      VERIFIED(
        'A never-assessed control proved to appear in the queue by reverting the join and ' +
          'watching four tests fail; fan-out routing proved by routing on the first predicate ' +
          'instead of the widest',
      ),
    ],
  },
  {
    key: 'questionnaire-intake',
    title: 'Questionnaire intake',
    attestations: [
      DESIGNED('ADR-0034 to ADR-0038'),
      IMPLEMENTED('packages/questionnaire'),
      TESTED('packages/questionnaire/src/**/*.test.ts'),
      VERIFIED(
        'A zip bomb proved refused with reason INFLATION_CAPPED, an XML entity declaration ' +
          'proved refused in every part including shared strings, and formula injection proved ' +
          'neutralised rather than stripped — each by deliberate attempt',
      ),
    ],
  },
  {
    key: 'sovereign-inference',
    title: 'Sovereign inference',
    attestations: [
      DESIGNED('ADR-0041; docs/operations/sovereign-inference.md'),
      IMPLEMENTED('packages/inference'),
      TESTED('packages/inference/src/*.test.ts, tests/e2e/sovereign-inference.test.ts'),
      VERIFIED(
        'An external provider proved refused without a written acknowledgement, in five ' +
          'deliberate attempts; prompt injection proved contained',
      ),
    ],
  },
  {
    key: 'product-company-separation',
    title: 'Adericel builds without Veylith Systems',
    attestations: [
      DESIGNED('ADR-0049 — Adericel is the product; Veylith is the company that operates it'),
      IMPLEMENTED(
        'infrastructure/docker/Dockerfile product stage; database/migrations/layers.json',
      ),
      TESTED('tests/e2e/product-separation.test.ts, tests/unit/migration-layers.test.ts'),
      VERIFIED(
        'The product image proved to contain no company code and the product migration layer ' +
          'proved to create no veylith schema, each checked against the real build rather than ' +
          'against the package list — which is how the earlier version of this claim passed ' +
          'while being false',
      ),
      OPERATIONAL('Built as a separate image target in CI'),
    ],
  },
  {
    key: 'backup-restore',
    title: 'Backup and restore',
    attestations: [
      DESIGNED('docs/operations/runbook.md'),
      IMPLEMENTED('infrastructure/docker/backup/restore.sh; scripts/verify-restore.ts'),
      TESTED('tests/integration/backup-restore.test.ts'),
      OPERATIONAL('CI job `images` restores a real dump and asserts the schema afterwards'),
    ],
  },
  {
    key: 'mutation-harness',
    title: 'Every claimed guard, proved by breaking it on every build',
    attestations: [
      DESIGNED('Contract: security and privacy claims require executable tests where possible'),
      IMPLEMENTED('tests/mutation/registry.ts; scripts/mutation-test.ts'),
      TESTED(
        'tests/unit/mutation-registry.test.ts checks the registry is well formed; the runner ' +
          'itself was exercised against a deliberately unguarded mutation and reported it as ' +
          'SURVIVED with a non-zero exit',
      ),
      VERIFIED(
        'Nineteen recorded mutations all killed by their named tests, run by CI rather than by ' +
          'hand. The runner refuses a dirty working tree, restores every file it touched ' +
          'including artefacts a suite regenerated, and reports a stale or ambiguous match as ' +
          'an error rather than a pass',
      ),
      OPERATIONAL('A required CI job on every push'),
    ],
  },
  {
    key: 'white-label',
    title: 'White-label presentation for MSPs',
    attestations: [DESIGNED('Contract §38')],
  },
  {
    key: 'signed-releases',
    title: 'SBOM and signed releases',
    attestations: [DESIGNED('Contract §36; supply-chain task')],
  },
];
