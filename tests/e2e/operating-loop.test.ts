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
 * The loop an MSP is actually buying, run end to end.
 *
 * Connect, collect, determine, triage, and then the two commercial questions:
 * what did the machine do, and how many customers can one engineer carry.
 *
 * The capacity assertions are mostly assertions that the engine REFUSES. That
 * number is what an owner makes hiring decisions with, and a tool that produces
 * one when pressed is worse than a tool with no opinion.
 */

const available = await databaseAvailable();

function estate(slug: string, identities: number, withoutMfa: number) {
  return Array.from({ length: identities }, (_, i) => ({
    kind: 'IDENTITY_STATE',
    subjectExternalId: `${slug}-user-${i}`,
    payload: {
      externalId: `${slug}-user-${i}`,
      displayName: `${slug} person ${i}`,
      enabled: true,
      accountType: 'USER',
      mfaEnforced: i >= withoutMfa,
      lastSignInAt: '2026-09-01T09:00:00.000Z',
    },
  }));
}

describe.skipIf(!available)('the operating loop', () => {
  let harness: Harness;
  const tenants: SeededTenant[] = [];
  let mspId: string;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();

    for (const [index, shape] of [
      { slug: 'loop-alpha', identities: 10, bad: 2 },
      { slug: 'loop-bravo', identities: 8, bad: 0 },
      { slug: 'loop-charlie', identities: 12, bad: 3 },
      { slug: 'loop-delta', identities: 6, bad: 1 },
    ].entries()) {
      tenants.push(
        await seedTenant(harness, {
          slug: shape.slug,
          mspSlug: 'loop-portfolio',
          records: estate(shape.slug, shape.identities, shape.bad),
          autonomyLevel: index % 2 === 0 ? 4 : 2,
        }),
      );
    }

    mspId = tenants[0]!.mspId;
    token = await signIn(harness, 'owner-loop-alpha@test.invalid');
  }, 300_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('runs one pass of the whole loop and records what it did', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/msps/${mspId}/loop/cycles`,
      headers: bearer(token),
      payload: { collect: true },
    });
    expect(response.statusCode).toBe(201);

    const cycle = response.json() as {
      cycleId: string;
      organisationsInScope: number;
      observationsCollected: number;
      determinationsMade: number;
      exceptionsOpen: number;
      stageTimings: { stage: string; milliseconds: number }[];
      organisationsSkipped: unknown[];
    };

    expect(cycle.organisationsInScope).toBe(4);
    // The loop actually did the work rather than recording that it had.
    expect(cycle.observationsCollected).toBeGreaterThan(0);
    expect(cycle.determinationsMade).toBeGreaterThan(0);
    // Every stage is timed, so a scaling problem surfaces as a stage rather
    // than as a feeling that the product got slower.
    expect(cycle.stageTimings.map((t) => t.stage)).toEqual([
      'collect',
      'determine',
      'measure',
      'triage',
    ]);
  }, 300_000);

  it('never silently drops a customer it could not complete', async () => {
    // A customer whose connector is gone must appear in the skipped list, not
    // vanish from the denominator of every metric downstream.
    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(`UPDATE integrations SET status = 'FAILED' WHERE organisation_id = $1`, [
        tenants[3]!.organisationId,
      ]);
    });

    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/msps/${mspId}/loop/cycles`,
      headers: bearer(token),
      payload: { collect: true },
    });
    const cycle = response.json() as {
      organisationsInScope: number;
      organisationsSkipped: { organisationId: string; reason: string }[];
    };

    expect(cycle.organisationsInScope).toBe(4);
    expect(cycle.organisationsSkipped.map((s) => s.organisationId)).toContain(
      tenants[3]!.organisationId,
    );
    expect(cycle.organisationsSkipped[0]?.reason).toContain('No connected integration');
  }, 300_000);

  it('keeps the cycle history, so the loop is a trend rather than a snapshot', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/msps/${mspId}/loop/cycles`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    const { cycles } = response.json() as { cycles: unknown[] };
    expect(cycles.length).toBeGreaterThanOrEqual(2);
  });

  describe('capacity', () => {
    it('refuses to say how many customers an engineer can run, at first', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/msps/${mspId}/capacity?windowDays=30`,
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(200);
      const report = response.json() as {
        load: { organisations: number };
        capacity: { basis: string; missing?: string[] };
      };

      // The load is measured and real.
      expect(report.load.organisations).toBe(4);
      // The capacity is refused, because nobody has said what their time costs.
      expect(report.capacity.basis).toBe('REFUSED');
      expect(report.capacity.missing?.join(' ')).toContain('hours one of your engineers has');
    });

    it('answers once the MSP has supplied its own numbers', async () => {
      for (const [responseType, minutes] of [
        ['DECIDE', 6],
        ['CONFIGURE', 20],
        ['INVESTIGATE', 45],
        ['ASK_CUSTOMER', 15],
      ] as const) {
        const recorded = await harness.server.inject({
          method: 'PUT',
          url: `/v1/msps/${mspId}/capacity/response-effort/${responseType}`,
          headers: bearer(token),
          payload: {
            minutes,
            source: 'MSP_MEASURED',
            basis: 'Timed across a fortnight of the queue',
          },
        });
        expect(recorded.statusCode, responseType).toBe(200);
      }

      const hours = await harness.server.inject({
        method: 'PUT',
        url: `/v1/msps/${mspId}/capacity/engineer-hours`,
        headers: bearer(token),
        payload: { hoursPerMonth: 130, basis: 'Four days a week on assurance, less holiday' },
      });
      expect(hours.statusCode).toBe(200);

      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/msps/${mspId}/capacity?windowDays=30`,
        headers: bearer(token),
      });
      const report = response.json() as {
        capacity: {
          basis: string;
          customersPerEngineer: number;
          hoursPerCustomerPerMonth: number;
          caveats: string[];
        };
      };

      expect(report.capacity.basis).toBe('MEASURED');
      expect(report.capacity.customersPerEngineer).toBeGreaterThan(0);
      expect(Number.isInteger(report.capacity.customersPerEngineer)).toBe(true);
      // And it always says what it is not counting.
      expect(report.capacity.caveats.join(' ')).toContain(
        'upper bound on the assurance work alone',
      );
    });

    it('refuses a duration with no stated basis', async () => {
      const response = await harness.server.inject({
        method: 'PUT',
        url: `/v1/msps/${mspId}/capacity/response-effort/DECIDE`,
        headers: bearer(token),
        payload: { minutes: 6, source: 'MSP_MEASURED', basis: null },
      });
      // A number nobody can check is not evidence of anything.
      expect(response.statusCode).toBe(400);
    });
  });

  it('keeps the whole loop off the client surface', async () => {
    // An MSP's cost model and capacity are MSP_PORTFOLIO information. A client
    // must never see what its MSP believes its own people cost.
    const clientToken = await signIn(harness, 'analyst-loop-bravo@test.invalid');
    await harness.db.withPlatform(async (ctx) => {
      const user = await ctx.oneOrFail<{ id: string }>(
        `SELECT id FROM users WHERE lower(email) = lower($1)`,
        ['analyst-loop-bravo@test.invalid'],
        'User',
      );
      await ctx.query(`UPDATE grants SET revoked_at = now() WHERE principal_id = $1`, [user.id]);
      await ctx.query(
        `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles)
         VALUES ('USER', $1, 'ORGANISATION', $2, ARRAY['ORG_ADMIN'])`,
        [user.id, tenants[1]!.organisationId],
      );
    });
    expect(clientToken).toBeTruthy();
    const scoped = await signIn(harness, 'analyst-loop-bravo@test.invalid');

    for (const path of [`/v1/msps/${mspId}/capacity`, `/v1/msps/${mspId}/loop/cycles`]) {
      const response = await harness.server.inject({
        method: 'GET',
        url: path,
        headers: bearer(scoped),
      });
      expect(response.statusCode, path).toBe(403);
    }
  });
});
