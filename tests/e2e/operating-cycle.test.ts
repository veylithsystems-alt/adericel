import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileAutonomyPolicy } from '@adericel/autonomy';
import {
  createExceptionQueue,
  createMetricsService,
  createOperator,
  createPipelineService,
  qualifyProspect,
  QUALIFICATION_THRESHOLD,
  type PipelineService,
  DEFAULT_COMPANY_POLICY,
} from '@adericel/vaol';
import { nullLogger } from '@adericel/shared';
import { createHarness, databaseAvailable, type Harness } from '../helpers/harness.js';

/**
 * A simulated Veylith operating cycle, with failures introduced deliberately.
 *
 * The acceptance test the operating brief asks for. It drives a prospect from
 * discovery through qualification and outreach, and at each step introduces the
 * kind of thing that actually goes wrong: a record nobody finished researching,
 * a message with no lawful basis, a suppression, an external system that times
 * out, a duplicate delivery.
 *
 * The company passes if, for each of those, it detects the condition, stays
 * inside its authority, escalates where it must, records the whole chain, and
 * can still be measured afterwards.
 */

const available = await databaseAvailable();
const policy = compileAutonomyPolicy(DEFAULT_COMPANY_POLICY);

describe.skipIf(!available)('a Veylith operating cycle', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    // Bring the automatable parts of the pipeline up to a maturity where they
    // may run unattended. This is the deliberate act of delegation the model
    // requires — nothing raises its own maturity.
    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(
        `UPDATE veylith.company_processes SET current_maturity = 3
         WHERE key IN ('market.prospect_discovery', 'sales.qualification', 'sales.outreach')`,
        [],
      );
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function withPipeline<T>(fn: (pipeline: PipelineService) => Promise<T>): Promise<T> {
    return harness.db.withPlatform(async (ctx) => {
      const operator = createOperator({
        ctx,
        clock: harness.clock,
        logger: nullLogger,
        policy,
        actor: 'vaol',
      });
      return fn(createPipelineService({ ctx, clock: harness.clock, logger: nullLogger, operator }));
    });
  }

  const openExceptions = () =>
    harness.db.withPlatform(async (ctx) => createExceptionQueue(ctx, harness.clock).open());

  // ---- The happy path, which must actually work -----------------------------

  describe('a good prospect, correctly handled', () => {
    let prospectId: string;

    it('is discovered without a person', async () => {
      const { prospect, permitted } = await withPipeline((p) =>
        p.discover({ domain: 'northwind-it.example', name: 'Northwind IT', country: 'GB' }),
      );
      expect(permitted).toBe(true);
      expect(prospect).not.toBeNull();
      prospectId = prospect!.id;
    });

    it('is not discovered twice', async () => {
      // The same company found through two channels is one prospect.
      const before = await harness.db.withPlatform(async (ctx) =>
        ctx.many(`SELECT id FROM veylith.prospects`, []),
      );
      await withPipeline((p) =>
        p.discover({ domain: 'northwind-it.example', name: 'Northwind IT Ltd', country: 'GB' }),
      );
      const after = await harness.db.withPlatform(async (ctx) =>
        ctx.many(`SELECT id FROM veylith.prospects`, []),
      );
      expect(after.length).toBe(before.length);
    });

    it('will not be qualified while the record is incomplete', async () => {
      const result = await withPipeline((p) => p.qualify(prospectId));
      // An unresearched prospect scores low for the same reason a poor one
      // does. Treating them the same would bury good prospects nobody had got
      // to yet.
      expect(result.incomplete).toBe(true);
      expect(result.prospect!.stage).toBe('DISCOVERED');
      expect(result.prospect!.fitScore).toBeNull();
    });

    it('is qualified once it has been enriched', async () => {
      await withPipeline((p) =>
        p.enrich(prospectId, {
          managedOrganisations: 80,
          microsoftHeavy: true,
          complianceWorkload: true,
          apiCapable: true,
          automationMaturity: 3,
          executiveSponsor: true,
        }),
      );
      const result = await withPipeline((p) => p.qualify(prospectId));
      expect(result.incomplete).toBe(false);
      expect(result.prospect!.stage).toBe('QUALIFIED');
      expect(result.prospect!.fitScore).toBeGreaterThanOrEqual(QUALIFICATION_THRESHOLD);
      // The score is explainable to the person whose deal it just ranked.
      expect(result.prospect!.fitReason).toContain('managed organisations');
    });

    it('reaches the actionable queue', async () => {
      const queue = await withPipeline((p) => p.actionable());
      expect(queue.map((p) => p.id)).toContain(prospectId);
    });
  });

  // ---- Failure 1: no lawful basis ------------------------------------------

  describe('failure: outreach with no lawful basis recorded', () => {
    let prospectId: string;
    let outreachId: string;

    beforeAll(async () => {
      const { prospect } = await withPipeline((p) =>
        p.discover({ domain: 'contoso-msp.example', name: 'Contoso MSP', country: 'GB' }),
      );
      prospectId = prospect!.id;
      await withPipeline((p) =>
        p.enrich(prospectId, {
          managedOrganisations: 60,
          microsoftHeavy: true,
          complianceWorkload: true,
          apiCapable: true,
          automationMaturity: 3,
          executiveSponsor: true,
        }),
      );
      await withPipeline((p) => p.qualify(prospectId));
      const prepared = await withPipeline((p) =>
        p.prepareOutreach(prospectId, 'first-contact', {
          subject: 'Assurance for your customers',
          body: 'A short note.',
        }),
      );
      outreachId = prepared.outreachId!;

      // Approve the wording, so the only thing missing is the lawful basis.
      // Leaving both unmet would test the combination rather than the case this
      // block is named for — and would report DENY, since an unapproved draft
      // is an established false fact while a missing basis is an unestablished
      // one.
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(
          `UPDATE veylith.outreach SET status = 'APPROVED', approved_by = 'commercial-owner'
           WHERE id = $1`,
          [outreachId],
        );
      });
    });

    it('prepares the message, because preparing is internal work', async () => {
      expect(outreachId).toBeTruthy();
      const row = await harness.db.withPlatform(async (ctx) =>
        ctx.one<{ status: string }>(`SELECT status FROM veylith.outreach WHERE id = $1`, [
          outreachId,
        ]),
      );
      // Prepared and approved, and still not sent: approval of wording is not
      // authority to contact anybody.
      expect(row!.status).toBe('APPROVED');
    });

    it('does not send it, and does not call the sender at all', async () => {
      let senderCalled = false;
      const result = await withPipeline((p) =>
        p.sendOutreach(outreachId, async () => {
          senderCalled = true;
        }),
      );
      expect(result.sent).toBe(false);
      // The point: refusing to send means the send function never runs.
      expect(senderCalled).toBe(false);
    });

    it('says nobody established a basis, rather than that one was refused', async () => {
      const exceptions = await openExceptions();
      const relevant = exceptions.find((e) => e.subjectId === prospectId);
      expect(relevant).toBeDefined();
      expect(relevant!.category).toBe('AMBIGUOUS');
      expect(relevant!.failureReason).toContain('Not established is not false');
    });

    it('sends once a basis is recorded', async () => {
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(
          `UPDATE veylith.prospects
           SET lawful_basis = 'Legitimate interest, assessed 2026-09-01',
               lawful_basis_recorded_at = $2 WHERE id = $1`,
          [prospectId, harness.clock.nowIso()],
        );
      });
      let senderCalled = false;
      const result = await withPipeline((p) =>
        p.sendOutreach(outreachId, async () => {
          senderCalled = true;
        }),
      );
      expect(result.sent).toBe(true);
      expect(senderCalled).toBe(true);
    });
  });

  // ---- Failure 2: suppression ----------------------------------------------

  describe('failure: a suppressed prospect', () => {
    it('is never contacted, whatever else is in order', async () => {
      const { prospect } = await withPipeline((p) =>
        p.discover({ domain: 'fabrikam.example', name: 'Fabrikam', country: 'GB' }),
      );
      const id = prospect!.id;
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(
          `UPDATE veylith.prospects
           SET lawful_basis = 'Consent', lawful_basis_recorded_at = $2 WHERE id = $1`,
          [id, harness.clock.nowIso()],
        );
      });
      const prepared = await withPipeline((p) =>
        p.prepareOutreach(id, 'follow-up', { subject: 'Following up', body: '...' }),
      );
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(`UPDATE veylith.outreach SET status = 'APPROVED' WHERE id = $1`, [
          prepared.outreachId,
        ]);
      });

      await withPipeline((p) => p.suppress(id, 'Asked not to be contacted'));

      let senderCalled = false;
      const result = await withPipeline((p) =>
        p.sendOutreach(prepared.outreachId!, async () => {
          senderCalled = true;
        }),
      );
      expect(result.sent).toBe(false);
      expect(senderCalled).toBe(false);
      // A recorded suppression is an established false fact, so this is a
      // refusal rather than an unknown.
      expect(result.reason).toContain('not_suppressed is false');
    });
  });

  // ---- Failure 3: the external system fails --------------------------------

  describe('failure: the sending service times out', () => {
    it('records UNKNOWN_OUTCOME and warns against a blind retry', async () => {
      const { prospect } = await withPipeline((p) =>
        p.discover({ domain: 'tailspin.example', name: 'Tailspin Toys', country: 'GB' }),
      );
      const id = prospect!.id;
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(
          `UPDATE veylith.prospects SET lawful_basis = 'Consent', lawful_basis_recorded_at = $2
           WHERE id = $1`,
          [id, harness.clock.nowIso()],
        );
      });
      const prepared = await withPipeline((p) =>
        p.prepareOutreach(id, 'first-contact', { subject: 'Hello', body: '...' }),
      );
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(`UPDATE veylith.outreach SET status = 'APPROVED' WHERE id = $1`, [
          prepared.outreachId,
        ]);
      });

      const result = await withPipeline((p) =>
        p.sendOutreach(prepared.outreachId!, async () => {
          throw new Error('SMTP gateway timed out after 30s');
        }),
      );
      expect(result.sent).toBe(false);

      const exceptions = await openExceptions();
      const failure = exceptions.find((e) => e.category === 'AUTOMATION_FAILED');
      expect(failure).toBeDefined();
      // The message may or may not have gone out. Telling an operator to retry
      // would risk contacting the same person twice.
      expect(failure!.recommendedAction).toContain('does not mean nothing changed');

      const events = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ result: string }>(
          `SELECT result FROM veylith.business_events
           WHERE event_type = 'OUTREACH_SENT' AND subject_id = $1`,
          [id],
        ),
      );
      expect(events.some((e) => e.result === 'UNKNOWN_OUTCOME')).toBe(true);
    });
  });

  // ---- Failure 4: duplicate delivery ---------------------------------------

  describe('failure: the same instruction arrives twice', () => {
    it('does not contact the same person twice', async () => {
      const { prospect } = await withPipeline((p) =>
        p.discover({ domain: 'adventure-works.example', name: 'Adventure Works', country: 'GB' }),
      );
      const id = prospect!.id;
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(
          `UPDATE veylith.prospects SET lawful_basis = 'Consent', lawful_basis_recorded_at = $2
           WHERE id = $1`,
          [id, harness.clock.nowIso()],
        );
      });
      const prepared = await withPipeline((p) =>
        p.prepareOutreach(id, 'first-contact', { subject: 'Hello', body: '...' }),
      );
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(`UPDATE veylith.outreach SET status = 'APPROVED' WHERE id = $1`, [
          prepared.outreachId,
        ]);
      });

      let sends = 0;
      const send = async () => {
        sends += 1;
      };
      await withPipeline((p) => p.sendOutreach(prepared.outreachId!, send));
      await withPipeline((p) => p.sendOutreach(prepared.outreachId!, send));

      expect(sends).toBe(1);
    });
  });

  // ---- Failure 5: an operation beyond authority ----------------------------

  describe('failure: something nobody authorised', () => {
    it('is refused and escalated with the authority named', async () => {
      let ran = false;
      const outcome = await harness.db.withPlatform(async (ctx) =>
        createOperator({
          ctx,
          clock: harness.clock,
          logger: nullLogger,
          policy,
          actor: 'vaol',
        }).operate({
          processKey: 'legal.contract',
          operation: 'legal.contract.accept_terms',
          riskClass: 'CONTRACTUAL',
          eventType: 'CONTRACT_SIGNED',
          subjectKind: 'Opportunity',
          subjectId: 'opp-1',
          intent: 'Accept a customer’s amended liability clause',
          effect: async () => {
            ran = true;
            return 'signed';
          },
        }),
      );
      expect(outcome.permitted).toBe(false);
      expect(ran).toBe(false);
      expect(outcome.exception!.requiredAuthority).toContain('director');
    });
  });

  // ---- The company can still be measured afterwards -------------------------

  describe('after the cycle', () => {
    it('can say how autonomous it was, from the ledger', async () => {
      const metrics = await harness.db.withPlatform(async (ctx) =>
        createMetricsService(ctx, harness.clock).autonomy(24 * 365),
      );
      expect(metrics.operations).toBeGreaterThan(5);
      expect(metrics.automationRatio).not.toBeNull();
      expect(metrics.automationRatio!).toBeGreaterThan(0);
      // It refused things, and knows what and why.
      expect(metrics.refusals.UNKNOWN + metrics.refusals.DENY).toBeGreaterThan(0);
      // It stopped when it could not proceed, rather than pressing on.
      expect(metrics.exceptionsRaised).toBeGreaterThan(0);
      expect(metrics.unknownOutcomes).toBeGreaterThan(0);
    });

    it('can show the whole chain for one prospect', async () => {
      const events = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ event_type: string; human_in_loop: boolean }>(
          `SELECT e.event_type, e.human_in_loop FROM veylith.business_events e
           JOIN veylith.prospects p ON p.id::text = e.subject_id
           WHERE p.domain = 'contoso-msp.example' ORDER BY e.sequence`,
          [],
        ),
      );
      expect(events.map((e) => e.event_type)).toContain('LEAD_QUALIFIED');
      expect(events.map((e) => e.event_type)).toContain('OUTREACH_SENT');
      // Every one of these ran without a person, and the ledger says so rather
      // than leaving it to be inferred.
      expect(events.every((e) => e.human_in_loop === false)).toBe(true);
    });

    it('reports observed maturity for the processes that actually ran', async () => {
      const byProcess = await harness.db.withPlatform(async (ctx) =>
        createMetricsService(ctx, harness.clock).byProcess(24 * 365),
      );
      const discovery = byProcess.find((p) => p.processKey === 'market.prospect_discovery');
      expect(discovery!.operations).toBeGreaterThan(4);
      expect(discovery!.observedMaturity).not.toBeNull();
    });
  });

  // ---- The qualification model, on its own ---------------------------------

  describe('qualification', () => {
    it('disqualifies an unreachable stack outright rather than scoring it low', async () => {
      const result = qualifyProspect({
        managedOrganisations: 400,
        microsoftHeavy: true,
        complianceWorkload: true,
        apiCapable: false,
        automationMaturity: 5,
        executiveSponsor: true,
      });
      // Every other signal is excellent. It is still not a sale.
      expect(result.score).toBe(0);
      expect(result.reason).toContain('cannot observe anything');
    });

    it('reports what is missing rather than guessing', async () => {
      const result = qualifyProspect({
        managedOrganisations: 50,
        microsoftHeavy: null,
        complianceWorkload: null,
        apiCapable: null,
        automationMaturity: null,
        executiveSponsor: null,
      });
      expect(result.incomplete).toBe(true);
      expect(result.missing).toContain('apiCapable');
    });

    it('is deterministic', async () => {
      const signals = {
        managedOrganisations: 100,
        microsoftHeavy: true,
        complianceWorkload: true,
        apiCapable: true,
        automationMaturity: 4,
        executiveSponsor: false,
      };
      expect(qualifyProspect(signals)).toEqual(qualifyProspect(signals));
    });
  });
});
