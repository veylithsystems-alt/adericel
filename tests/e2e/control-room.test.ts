import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * The internal control room, through the API.
 *
 * A person governing an autonomous company needs one place that answers: what
 * is the company doing, why, what has failed, and what needs me. These tests
 * hold the API to answering it — and, first, to not answering it to a customer.
 */

const available = await databaseAvailable();
const PASSWORD = 'Test-password-2026!';

describe.skipIf(!available)('the control room', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let customerToken: string;
  let platformToken: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'control-corp', records: [] });
    customerToken = await signIn(harness, 'owner-control-corp@test.invalid');

    // A platform operator: the only kind of principal that may see any of this.
    await harness.db.withPlatform(async (ctx) => {
      const user = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO users (email, display_name, status) VALUES ($1, $2, 'ACTIVE')
         ON CONFLICT (lower(email)) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        ['ops@veylith.test.invalid', 'Veylith Operator'],
        'User',
      );
      const { createPasswordHasher } = await import('@adericel/shared');
      const hash = await createPasswordHasher('').hash(PASSWORD);
      await ctx.query(
        `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
        [user.id, hash],
      );
      await ctx.query(
        `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles)
         VALUES ('USER', $1, 'PLATFORM', NULL, ARRAY['PLATFORM_ADMIN'])
         ON CONFLICT (principal_type, principal_id, scope_type,
                      COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'))
         WHERE revoked_at IS NULL DO UPDATE SET roles = EXCLUDED.roles`,
        [user.id],
      );
    });
    platformToken = await signIn(harness, 'ops@veylith.test.invalid');
  });

  afterAll(async () => {
    await harness.close();
  });

  const get = (path: string, token: string) =>
    harness.server.inject({ method: 'GET', url: path, headers: bearer(token) });

  const post = (path: string, token: string, payload: unknown = {}) =>
    harness.server.inject({ method: 'POST', url: path, headers: bearer(token), payload });

  describe('a customer cannot see the company', () => {
    it('is refused every control room route', async () => {
      for (const path of [
        '/v1/veylith/exceptions',
        '/v1/veylith/autonomy',
        '/v1/veylith/processes',
        '/v1/veylith/events',
        '/v1/veylith/decisions',
      ]) {
        const response = await get(path, customerToken);
        expect(response.statusCode, path).toBe(403);
      }
    });

    it('cannot simulate a policy decision either', async () => {
      // Simulation reads no data, and still discloses the company's authority
      // model — which rules exist, what they permit, where the boundaries sit.
      const response = await post('/v1/veylith/autonomy/simulate', customerToken, {
        processKey: 'finance.payments',
        operation: 'finance.payments.send',
        riskClass: 'FINANCIAL',
      });
      expect(response.statusCode).toBe(403);
    });

    it('cannot resolve an exception', async () => {
      const response = await post(
        `/v1/veylith/exceptions/${'00000000-0000-4000-8000-000000000000'}/resolve`,
        customerToken,
        { resolution: 'nothing to see here' },
      );
      expect(response.statusCode).toBe(403);
    });
  });

  describe('the process registry', () => {
    it('reports every process with its human boundary', async () => {
      const response = await get('/v1/veylith/processes', platformToken);
      expect(response.statusCode).toBe(200);
      const { processes } = response.json() as {
        processes: {
          key: string;
          currentMaturity: number;
          targetMaturity: number;
          humanBoundary: string;
          automationCandidate: boolean;
          automationGap: number;
        }[];
      };
      expect(processes.length).toBeGreaterThan(15);

      // Nothing is automated yet, and the registry says so rather than
      // flattering the plan.
      expect(processes.every((p) => p.currentMaturity === 0)).toBe(true);

      // Every process aiming above "prepare" states what a person always decides.
      for (const process of processes.filter((p) => p.targetMaturity > 2)) {
        expect(process.humanBoundary.length, process.key).toBeGreaterThan(0);
      }
    });

    it('marks money and strategy as things that will never be automated', async () => {
      const response = await get('/v1/veylith/processes', platformToken);
      const { processes } = response.json() as {
        processes: { key: string; automationCandidate: boolean; automationGap: number }[];
      };
      const finance = processes.find((p) => p.key === 'finance.payments');
      const strategy = processes.find((p) => p.key === 'strategy.direction');
      expect(finance?.automationCandidate).toBe(false);
      expect(strategy?.automationCandidate).toBe(false);
      // And therefore contribute nothing to the automation backlog.
      expect(finance?.automationGap).toBe(0);
    });
  });

  describe('simulating a decision', () => {
    it('says what would happen without doing it', async () => {
      const response = await post('/v1/veylith/autonomy/simulate', platformToken, {
        processKey: 'finance.payments',
        operation: 'finance.payments.send',
        riskClass: 'FINANCIAL',
      });
      expect(response.statusCode).toBe(200);
      const { decision } = response.json() as {
        decision: { outcome: string; reason: string; evaluation: unknown[] };
      };
      expect(decision.outcome).toBe('DENY');
      // Inspectable: an operator can find out why an automation is not running
      // before it next tries, rather than reading the rules and guessing.
      expect(decision.evaluation.length).toBeGreaterThan(0);
    });

    it('reports UNKNOWN for an operation nobody wrote a rule for', async () => {
      const response = await post('/v1/veylith/autonomy/simulate', platformToken, {
        processKey: 'sales.outreach',
        operation: 'sales.outreach.telepathy',
        riskClass: 'INTERNAL',
      });
      const { decision } = response.json() as { decision: { outcome: string } };
      expect(decision.outcome).toBe('UNKNOWN');
    });

    it('records nothing, because it did nothing', async () => {
      const before = await get('/v1/veylith/decisions', platformToken);
      const beforeCount = (before.json() as { decisions: unknown[] }).decisions.length;
      await post('/v1/veylith/autonomy/simulate', platformToken, {
        processKey: 'finance.payments',
        operation: 'finance.payments.send',
        riskClass: 'FINANCIAL',
      });
      const after = await get('/v1/veylith/decisions', platformToken);
      // A simulation that wrote a decision would pollute the very metrics an
      // operator uses the simulator to understand.
      expect((after.json() as { decisions: unknown[] }).decisions.length).toBe(beforeCount);
    });
  });

  describe('the autonomy report', () => {
    it('reports a ratio over no operations as null rather than zero', async () => {
      const response = await get('/v1/veylith/autonomy', platformToken);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        metrics: { operations: number; automationRatio: number | null };
        processes: unknown[];
        overstatedProcesses: unknown[];
        policy: { hash: string };
      };
      expect(body.metrics.operations).toBe(0);
      expect(body.metrics.automationRatio).toBeNull();
      expect(body.processes.length).toBeGreaterThan(15);
      // The report names the rules it was produced under.
      expect(body.policy.hash).toMatch(/^sha256:/);
    });

    it('lists no overstated process while nothing has run', async () => {
      const response = await get('/v1/veylith/autonomy', platformToken);
      const body = response.json() as { overstatedProcesses: unknown[] };
      // Claiming a process is overstated on no evidence would be the same
      // error in the opposite direction.
      expect(body.overstatedProcesses).toEqual([]);
    });
  });

  describe('the exception queue', () => {
    it('is empty and says so, rather than erroring', async () => {
      const response = await get('/v1/veylith/exceptions', platformToken);
      expect(response.statusCode).toBe(200);
      const body = response.json() as { exceptions: unknown[]; overdueCount: number };
      expect(body.exceptions).toEqual([]);
      expect(body.overdueCount).toBe(0);
    });

    it('returns 404 for an exception that does not exist', async () => {
      const response = await get(
        '/v1/veylith/exceptions/00000000-0000-4000-8000-000000000000',
        platformToken,
      );
      expect(response.statusCode).toBe(404);
    });
  });

  it('does not leak company data into a customer organisation response', async () => {
    // A blunt check that the two worlds have not been wired together anywhere.
    const response = await get(
      `/v1/organisations/${tenant.organisationId}/assurance`,
      customerToken,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('veylith');
    expect(response.body).not.toContain('finance.payments');
  });
});
