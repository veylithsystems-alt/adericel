import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileAutonomyPolicy, DEFAULT_COMPANY_POLICY } from '@adericel/autonomy';
import {
  createBusinessEventLedger,
  createExceptionQueue,
  createMetricsService,
  createOperator,
  loadActivePolicy,
} from '@adericel/vaol';
import { nullLogger } from '@adericel/shared';
import {
  createHarness,
  databaseAvailable,
  seedTenant,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * The company's autonomous layer, attacked.
 *
 * An autonomous operations layer is itself a high-value attack surface: it
 * holds credentials, it acts on the company's behalf, and it is by design not
 * watched by a person most of the time. These tests try to make it do things it
 * must not, and to reach data it must not see.
 */

const available = await databaseAvailable();
const policy = compileAutonomyPolicy(DEFAULT_COMPANY_POLICY);

describe.skipIf(!available)('the VAOL authority boundary', () => {
  let harness: Harness;
  let tenant: SeededTenant;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'vaol-corp', records: [] });
  });

  afterAll(async () => {
    await harness.close();
  });

  const operator = () =>
    harness.db.withPlatform(async (ctx) =>
      createOperator({ ctx, clock: harness.clock, logger: nullLogger, policy, actor: 'test-automation' }),
    );

  /** Run one operation through the gate and return everything it produced. */
  async function operate(request: Parameters<Awaited<ReturnType<typeof operator>>['operate']>[0]) {
    return harness.db.withPlatform(async (ctx) => {
      const op = createOperator({
        ctx,
        clock: harness.clock,
        logger: nullLogger,
        policy,
        actor: 'test-automation',
      });
      return op.operate(request);
    });
  }

  // ---- Tenancy ------------------------------------------------------------

  describe('company data is not tenant data', () => {
    it('is invisible to a tenant-scoped transaction', async () => {
      // The whole reason for a separate schema. If this ever passes rows back,
      // a customer's API session can read the commercial pipeline.
      const rows = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
        ctx.many(`SELECT key FROM veylith.company_processes`, []),
      );
      expect(rows).toHaveLength(0);
    });

    it('is invisible across every company table, not just the one', async () => {
      await operate({
        processKey: 'finance.payments',
        operation: 'finance.payments.send',
        riskClass: 'FINANCIAL',
        eventType: 'PAYMENT_RECEIVED',
        subjectKind: 'Test',
        subjectId: 'leak-probe',
        intent: 'Probe for a tenancy leak',
        effect: async () => 'should not run',
      });

      for (const table of [
        'company_processes',
        'policy_decisions',
        'business_events',
        'operational_exceptions',
        'exception_transitions',
        'autonomy_policies',
      ]) {
        const rows = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
          ctx.many(`SELECT 1 FROM veylith.${table}`, []),
        );
        expect(rows, `${table} leaked to a tenant transaction`).toHaveLength(0);
      }
    });

    it('cannot be written from a tenant transaction either', async () => {
      // A read barrier that permits writes is not a barrier.
      await expect(
        harness.db.withTenant(tenant.organisationId, async (ctx) =>
          ctx.query(
            `INSERT INTO veylith.company_processes (key, domain, title) VALUES ($1,$2,$3)`,
            ['attacker.injected', 'STRATEGY', 'Injected by a tenant'],
          ),
        ),
      ).rejects.toThrow();
    });
  });

  // ---- The gate -----------------------------------------------------------

  describe('the gate', () => {
    it('does not run the effect when policy refuses', async () => {
      let ran = false;
      const outcome = await operate({
        processKey: 'finance.payments',
        operation: 'finance.payments.send',
        riskClass: 'FINANCIAL',
        eventType: 'PAYMENT_RECEIVED',
        subjectKind: 'Invoice',
        subjectId: 'inv-1',
        intent: 'Pay a supplier invoice',
        effect: async () => {
          ran = true;
          return 'paid';
        },
      });

      expect(outcome.permitted).toBe(false);
      expect(outcome.decision.outcome).toBe('DENY');
      // The point. A refusal that still runs the effect is not a refusal.
      expect(ran).toBe(false);
      expect(outcome.result).toBeNull();
    });

    it('raises an exception rather than declining silently', async () => {
      const outcome = await operate({
        processKey: 'engineering.deployment',
        operation: 'engineering.deployment.production',
        riskClass: 'OPERATIONAL_CHANGE',
        eventType: 'ENGINEERING_EVENT',
        subjectKind: 'Release',
        subjectId: 'rel-1',
        intent: 'Deploy release rel-1 to production',
        effect: async () => 'deployed',
      });

      expect(outcome.permitted).toBe(false);
      expect(outcome.exception).not.toBeNull();
      expect(outcome.exception!.category).toBe('AUTHORITY_REQUIRED');
      expect(outcome.exception!.requiredAuthority).toBe('Engineering owner');
      // A person must be able to see what the company wanted to do.
      expect(outcome.exception!.attempted).toContain('engineering.deployment.production');
    });

    it('records the refusal, not only the permission', async () => {
      const decisions = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ outcome: string }>(
          `SELECT outcome FROM veylith.policy_decisions WHERE process_key = 'finance.payments'`,
          [],
        ),
      );
      expect(decisions.length).toBeGreaterThan(0);
      expect(decisions.every((d) => d.outcome === 'DENY')).toBe(true);
    });

    it('treats an unregistered process as UNKNOWN, not as permitted', async () => {
      let ran = false;
      const outcome = await operate({
        processKey: 'nobody.registered.this',
        operation: 'nobody.registered.this.act',
        riskClass: 'INTERNAL',
        eventType: 'PRODUCT_EVENT',
        subjectKind: 'Thing',
        subjectId: 'x',
        intent: 'Do something in an unregistered process',
        effect: async () => {
          ran = true;
          return 'done';
        },
      });
      expect(outcome.decision.outcome).toBe('UNKNOWN');
      expect(ran).toBe(false);
      expect(outcome.exception!.severity).toBe('HIGH');
    });

    it('treats a disabled process as UNKNOWN rather than as maturity zero', async () => {
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(
          `UPDATE veylith.company_processes SET enabled = false WHERE key = 'engineering.ci'`,
          [],
        );
      });
      const outcome = await operate({
        processKey: 'engineering.ci',
        operation: 'engineering.ci.rerun',
        riskClass: 'INTERNAL',
        eventType: 'ENGINEERING_EVENT',
        subjectKind: 'Build',
        subjectId: 'b1',
        intent: 'Re-run a failed build',
        effect: async () => 'rerun',
      });
      expect(outcome.decision.outcome).toBe('UNKNOWN');
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(
          `UPDATE veylith.company_processes SET enabled = true WHERE key = 'engineering.ci'`,
          [],
        );
      });
    });

    it('runs the effect when policy permits', async () => {
      // The control must not be so strict that nothing works. Without this the
      // tests above prove only that the gate is shut.
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(
          `UPDATE veylith.company_processes SET current_maturity = 3 WHERE key = 'market.prospect_discovery'`,
          [],
        );
      });
      let ran = false;
      const outcome = await operate({
        processKey: 'market.prospect_discovery',
        operation: 'market.prospect_discovery.enrich',
        riskClass: 'INTERNAL',
        eventType: 'LEAD_ENRICHED',
        subjectKind: 'Lead',
        subjectId: 'lead-1',
        intent: 'Enrich a prospect record',
        effect: async () => {
          ran = true;
          return 'enriched';
        },
      });
      expect(outcome.permitted).toBe(true);
      expect(ran).toBe(true);
      expect(outcome.result).toBe('enriched');
      expect(outcome.exception).toBeNull();
    });
  });

  // ---- Idempotency --------------------------------------------------------

  describe('idempotency', () => {
    it('does not repeat an effect for a repeated key', async () => {
      let runs = 0;
      const request = {
        processKey: 'market.prospect_discovery',
        operation: 'market.prospect_discovery.enrich',
        riskClass: 'INTERNAL' as const,
        eventType: 'LEAD_ENRICHED' as const,
        subjectKind: 'Lead',
        subjectId: 'lead-idem',
        idempotencyKey: 'enrich:lead-idem:v1',
        intent: 'Enrich lead-idem',
        effect: async () => {
          runs += 1;
          return runs;
        },
      };
      const first = await operate(request);
      const second = await operate(request);

      expect(first.alreadyPerformed).toBe(false);
      expect(second.alreadyPerformed).toBe(true);
      expect(runs).toBe(1);
    });

    it('claims the key before running, so a concurrent retry cannot double up', async () => {
      let runs = 0;
      const request = {
        processKey: 'market.prospect_discovery',
        operation: 'market.prospect_discovery.enrich',
        riskClass: 'INTERNAL' as const,
        eventType: 'LEAD_ENRICHED' as const,
        subjectKind: 'Lead',
        subjectId: 'lead-race',
        idempotencyKey: 'enrich:lead-race:v1',
        intent: 'Enrich lead-race',
        effect: async () => {
          runs += 1;
          await new Promise((resolve) => setTimeout(resolve, 40));
          return runs;
        },
      };
      const results = await Promise.allSettled([operate(request), operate(request)]);
      // One transaction wins the unique index; the other either sees the claim
      // or conflicts. Either way the effect runs once.
      expect(runs).toBe(1);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    });
  });

  // ---- Failure ------------------------------------------------------------

  describe('when a permitted operation fails', () => {
    it('records UNKNOWN_OUTCOME rather than FAILED', async () => {
      const outcome = await operate({
        processKey: 'market.prospect_discovery',
        operation: 'market.prospect_discovery.enrich',
        riskClass: 'INTERNAL',
        eventType: 'LEAD_ENRICHED',
        subjectKind: 'Lead',
        subjectId: 'lead-fails',
        intent: 'Enrich a lead against a service that is down',
        effect: async () => {
          throw new Error('upstream timed out');
        },
      });

      expect(outcome.permitted).toBe(true);
      expect(outcome.result).toBeNull();
      expect(outcome.exception).not.toBeNull();
      expect(outcome.exception!.category).toBe('AUTOMATION_FAILED');
      // A timeout after a request was accepted is indistinguishable from one
      // that never arrived. Calling it FAILED would invite a retry that
      // duplicates a real effect.
      expect(outcome.exception!.recommendedAction).toContain('does not mean nothing changed');

      const events = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ result: string }>(
          `SELECT result FROM veylith.business_events WHERE subject_id = 'lead-fails'`,
          [],
        ),
      );
      expect(events[0]!.result).toBe('UNKNOWN_OUTCOME');
    });
  });

  // ---- The exception queue ------------------------------------------------

  describe('the exception queue', () => {
    const queue = async () =>
      harness.db.withPlatform(async (ctx) => createExceptionQueue(ctx, harness.clock));

    it('counts a recurring condition once, not once per occurrence', async () => {
      const raise = () =>
        harness.db.withPlatform(async (ctx) =>
          createExceptionQueue(ctx, harness.clock).raise(
            {
              processKey: 'support.triage',
              category: 'EXTERNAL_DEPENDENCY',
              title: 'The ticketing API is unreachable',
              attempted: 'support.triage.fetch',
              failureReason: 'connect ETIMEDOUT',
            },
            'test',
          ),
        );
      const first = await raise();
      await raise();
      const third = await raise();

      expect(first.id).toBe(third.id);
      expect(third.occurrences).toBe(3);
    });

    it('raises severity on recurrence but never lowers it', async () => {
      const raise = (severity: 'LOW' | 'CRITICAL') =>
        harness.db.withPlatform(async (ctx) =>
          createExceptionQueue(ctx, harness.clock).raise(
            {
              processKey: 'security.monitoring',
              category: 'SECURITY',
              severity,
              title: 'Unrecognised administrative sign-in',
              attempted: 'security.monitoring.review',
              failureReason: 'unknown source address',
            },
            'test',
          ),
        );
      await raise('CRITICAL');
      const lowered = await raise('LOW');
      // A condition that was critical once must not be quietly downgraded by a
      // milder later report of the same fault.
      expect(lowered.severity).toBe('CRITICAL');
    });

    it('gives a critical exception a much shorter deadline than a low one', async () => {
      const [critical, low] = await Promise.all([
        harness.db.withPlatform(async (ctx) =>
          createExceptionQueue(ctx, harness.clock).raise(
            {
              processKey: 'security.response',
              category: 'SECURITY',
              severity: 'CRITICAL',
              title: 'Credential possibly exposed',
              attempted: 'security.response.contain',
              failureReason: 'containment requires authority',
            },
            'test',
          ),
        ),
        harness.db.withPlatform(async (ctx) =>
          createExceptionQueue(ctx, harness.clock).raise(
            {
              processKey: 'product.feedback',
              category: 'DATA_MISSING',
              severity: 'LOW',
              title: 'Feedback record has no source',
              attempted: 'product.feedback.classify',
              failureReason: 'no source recorded',
            },
            'test',
          ),
        ),
      ]);
      expect(Date.parse(critical.dueAt)).toBeLessThan(Date.parse(low.dueAt));
    });

    it('does not mark a resolution verified by default', async () => {
      const raised = await harness.db.withPlatform(async (ctx) =>
        createExceptionQueue(ctx, harness.clock).raise(
          {
            processKey: 'billing.dunning',
            category: 'FINANCIAL',
            title: 'Card declined',
            attempted: 'billing.dunning.retry',
            failureReason: 'card_declined',
          },
          'test',
        ),
      );
      const resolved = await harness.db.withPlatform(async (ctx) =>
        createExceptionQueue(ctx, harness.clock).resolve(raised.id, 'Customer updated card', 'ops'),
      );
      // A resolution nobody confirmed is a claim, not a fact.
      expect(resolved.verification).toBe('PENDING');
      expect(resolved.status).toBe('RESOLVED_BY_HUMAN');
    });

    it('records who did what, so handling an exception is itself auditable', async () => {
      const raised = await harness.db.withPlatform(async (ctx) =>
        createExceptionQueue(ctx, harness.clock).raise(
          {
            processKey: 'support.triage',
            category: 'AMBIGUOUS',
            title: 'Cannot classify an inbound message',
            attempted: 'support.triage.classify',
            failureReason: 'no rule matched',
          },
          'test',
        ),
      );
      await harness.db.withPlatform(async (ctx) =>
        createExceptionQueue(ctx, harness.clock).acknowledge(raised.id, 'alex'),
      );
      await harness.db.withPlatform(async (ctx) =>
        createExceptionQueue(ctx, harness.clock).resolve(raised.id, 'Routed by hand', 'alex'),
      );
      const trail = await harness.db.withPlatform(async (ctx) =>
        createExceptionQueue(ctx, harness.clock).transitions(raised.id),
      );
      expect(trail.map((t) => t.toStatus)).toEqual(['OPEN', 'ACKNOWLEDGED', 'RESOLVED_BY_HUMAN']);
      void queue;
    });
  });

  // ---- Metrics ------------------------------------------------------------

  describe('autonomy metrics', () => {
    it('reports a ratio over no operations as null, not as zero', async () => {
      const metrics = await harness.db.withPlatform(async (ctx) =>
        createMetricsService(ctx, harness.clock).autonomy(0),
      );
      // A quiet week is not a regression to 0% autonomy.
      expect(metrics.operations).toBe(0);
      expect(metrics.automationRatio).toBeNull();
    });

    it('counts refusals by outcome, so an over-tight policy is visible', async () => {
      const metrics = await harness.db.withPlatform(async (ctx) =>
        createMetricsService(ctx, harness.clock).autonomy(24 * 365),
      );
      expect(metrics.operations).toBeGreaterThan(0);
      expect(metrics.refusals.DENY).toBeGreaterThan(0);
      expect(metrics.refusals.UNKNOWN).toBeGreaterThan(0);
      expect(metrics.exceptionsRaised).toBeGreaterThan(0);
    });

    it('reports observed maturity below the recorded one when the evidence says so', async () => {
      const byProcess = await harness.db.withPlatform(async (ctx) =>
        createMetricsService(ctx, harness.clock).byProcess(24 * 365),
      );
      const finance = byProcess.find((p) => p.processKey === 'finance.payments');
      expect(finance?.autonomous).toBe(0);
      // Nothing here is a candidate for automation, and nothing ran.
      expect(finance?.automationCandidate).toBe(false);
    });
  });

  // ---- Policy loading -----------------------------------------------------

  describe('with no policy loaded', () => {
    it('refuses rather than falling back to something permissive', async () => {
      await expect(
        harness.db.withPlatform(async (ctx) => loadActivePolicy(ctx, 'veylith.company.default')),
      ).rejects.toThrow(/no authority model/i);
    });
  });

  // ---- The ledger ---------------------------------------------------------

  describe('the business event ledger', () => {
    it('requires humanInLoop to be stated rather than defaulted', async () => {
      await expect(
        harness.db.withPlatform(async (ctx) =>
          createBusinessEventLedger(ctx, harness.clock).record({
            eventType: 'LEAD_CREATED',
            subjectKind: 'Lead',
            subjectId: 'l1',
            actorKind: 'SYSTEM',
            actor: 'test',
          } as never),
        ),
      ).rejects.toThrow();
    });
  });
});
