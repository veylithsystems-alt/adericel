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
 * Offboarding: the end of the customer lifecycle.
 *
 * A system of record that cannot be left is not a system of record. These tests
 * hold the product to three things, in this order, because the order is the
 * design: the customer leaves with their record; Adericel stops asserting
 * immediately; and the credentials are destroyed rather than disabled.
 *
 * Several of them assert that closure is REFUSED. That is the point — the
 * moment a customer is least able to argue about their record is exactly when
 * it is most likely to be destroyed.
 */

const available = await databaseAvailable();

describe.skipIf(!available)('offboarding', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, {
      slug: 'leaving-corp',
      records: [
        {
          kind: 'IDENTITY_STATE',
          subjectExternalId: 'u1',
          payload: { externalId: 'u1', enabled: true, mfaEnforced: true, accountType: 'USER' },
        },
      ],
    });
    token = await signIn(harness, 'owner-leaving-corp@test.invalid');

    // Collect and assess, so the customer has a real record to leave with.
    // Offboarding an organisation that never produced any evidence would test
    // the mechanics and none of the thing that matters.
    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}/collect`,
      headers: bearer(token),
    });
    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/assessments/run-all`,
      headers: bearer(token),
      payload: {},
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  const post = (path: string, payload: unknown = {}) =>
    harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}${path}`,
      headers: bearer(token),
      payload,
    });

  const get = (path: string) =>
    harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}${path}`,
      headers: bearer(token),
    });

  interface Status {
    status: string;
    readyToClose: boolean;
    blockers: string[];
    finalExportHash: string | null;
    tasks: { key: string; state: string; required: boolean }[];
  }

  describe('before it starts', () => {
    it('cannot be closed', async () => {
      const response = await post('/offboarding/close');
      expect(response.statusCode).toBe(412);
      expect(response.body).toMatch(/not been started/i);
    });
  });

  describe('beginning', () => {
    it('stops assurance immediately, not at closure', async () => {
      const response = await post('/offboarding', { reason: 'Moved to another provider' });
      expect(response.statusCode).toBe(200);
      const status = response.json() as Status;
      expect(status.status).toBe('OFFBOARDING');

      const row = await harness.db.withPlatform(async (ctx) =>
        ctx.one<{ assurance_maintained: boolean }>(
          `SELECT assurance_maintained FROM organisations WHERE id = $1`,
          [tenant.organisationId],
        ),
      );
      // The customer has left. Every further determination would be about an
      // estate nobody is watching.
      expect(row!.assurance_maintained).toBe(false);
    });

    it('requires a reason', async () => {
      const response = await post('/offboarding', {});
      expect(response.statusCode).toBe(400);
    });

    it('lists what remains, and refuses closure until it is done', async () => {
      const status = (await get('/offboarding')).json() as Status;
      expect(status.readyToClose).toBe(false);
      expect(status.blockers.length).toBeGreaterThan(0);
      expect(status.tasks.map((t) => t.key)).toContain('export');
    });

    it('will not close while the customer has not received their record', async () => {
      const response = await post('/offboarding/close');
      expect(response.statusCode).toBe(412);
      const body = response.json() as { error: { details?: { blockers?: string[] } } };
      expect(body.error.details?.blockers).toContain('Hand the customer their record');
    });
  });

  describe('the record the customer leaves with', () => {
    it('states its own completeness rather than assuming it', async () => {
      const response = await post('/offboarding/export');
      expect(response.statusCode).toBe(200);
      const bundle = response.json() as {
        complete: boolean;
        truncatedTables: string[];
        totals: Record<string, number>;
        counts: Record<string, number>;
        bundleHash: string;
        formatVersion: number;
      };
      // The field a receiving MSP or an auditor should read first.
      expect(bundle.complete).toBe(true);
      expect(bundle.truncatedTables).toEqual([]);
      // Totals and counts agree when nothing was truncated; where they differ,
      // the bundle is telling you what it left out.
      expect(bundle.totals.evidence).toBe(bundle.counts.evidence);
      expect(bundle.bundleHash).toMatch(/^sha256:/);
      expect(bundle.formatVersion).toBe(2);
    });

    it('records the hash of what was actually handed over', async () => {
      const status = (await get('/offboarding')).json() as Status;
      expect(status.finalExportHash).toMatch(/^sha256:/);
      expect(status.tasks.find((t) => t.key === 'export')!.state).toBe('COMPLETED');
    });

    it('contains the customer’s determinations, not just their configuration', async () => {
      const bundle = (await post('/offboarding/export')).json() as {
        counts: Record<string, number>;
      };
      // A record that omits the evidence and the claims is not the record.
      expect(bundle.counts.evidence).toBeGreaterThan(0);
      expect(bundle.counts.claims).toBeGreaterThan(0);
      expect(bundle.counts.audit).toBeGreaterThan(0);
    });
  });

  describe('revocation', () => {
    let shareToken: string;

    beforeAll(async () => {
      // Issue a passport and share it, so there is something real to revoke.
      const issued = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/passports`,
        headers: bearer(token),
        payload: {},
      });
      expect([200, 201], issued.body).toContain(issued.statusCode);
      const passportId = (issued.json() as { id: string }).id;

      const shared = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/passports/${passportId}/shares`,
        headers: bearer(token),
        payload: { audience: 'Our insurer', disclosure: 'REDACTED', expiresInDays: 30 },
      });
      expect([200, 201], shared.body).toContain(shared.statusCode);
      // The token is returned exactly once, embedded in the share URL.
      shareToken = (shared.json() as { url: string }).url.split('/assurance/')[1]!;
    });

    it('the shared passport answers while the customer is still with us', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/assurance/${shareToken}`,
      });
      expect(response.statusCode).toBe(200);
    });

    it('destroys credentials rather than disabling them', async () => {
      const before = await harness.db.withPlatform(async (ctx) =>
        ctx.one<{ count: string }>(
          `SELECT count(*)::text AS count FROM integrations
           WHERE organisation_id = $1 AND sealed_credentials IS NOT NULL`,
          [tenant.organisationId],
        ),
      );
      expect(Number(before!.count)).toBeGreaterThan(0);

      const response = await post('/offboarding/revoke', { reason: 'The customer has left' });
      expect(response.statusCode).toBe(200);

      const after = await harness.db.withPlatform(async (ctx) =>
        ctx.one<{ count: string }>(
          `SELECT count(*)::text AS count FROM integrations
           WHERE organisation_id = $1 AND sealed_credentials IS NOT NULL`,
          [tenant.organisationId],
        ),
      );
      // The ciphertext is the liability. Nothing will legitimately use it again.
      expect(Number(after!.count)).toBe(0);
    });

    it('stops the shared passport answering', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/assurance/${shareToken}`,
      });
      // An insurer holding this link must not go on being told an estate
      // nobody observes is satisfied.
      expect(response.statusCode).toBe(404);
    });

    it('is idempotent, so a partial run can simply be repeated', async () => {
      const first = await post('/offboarding/revoke', { reason: 'again' });
      expect(first.statusCode).toBe(200);
      const body = first.json() as { revoked: { integrations: number; passports: number } };
      // Nothing left to revoke; not an error.
      expect(body.revoked.integrations).toBe(0);
      expect(body.revoked.passports).toBe(0);
    });
  });

  describe('closing', () => {
    it('is refused while any required step is outstanding', async () => {
      const status = (await get('/offboarding')).json() as Status;
      if (status.readyToClose) return;
      const response = await post('/offboarding/close');
      expect(response.statusCode).toBe(412);
    });

    it('closes once everything is done', async () => {
      // Cancel billing, the last required step.
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(
          `UPDATE subscriptions SET status = 'CANCELLED' WHERE organisation_id = $1`,
          [tenant.organisationId],
        );
      });
      const status = (await get('/offboarding')).json() as Status;
      expect(status.readyToClose, `blockers: ${status.blockers.join(', ')}`).toBe(true);

      const response = await post('/offboarding/close');
      expect(response.statusCode).toBe(200);
      expect((response.json() as Status).status).toBe('CLOSED');
    });

    it('keeps the record rather than deleting it', async () => {
      // Closure is not erasure. Determinations stand as statements about the
      // instants they were made, and an investigation, insurance claim or
      // dispute is exactly when they are needed.
      const kept = await harness.db.withPlatform(async (ctx) =>
        ctx.oneOrFail<{ evidence: string; assessments: string; events: string }>(
          `SELECT (SELECT count(*)::text FROM evidence WHERE organisation_id = $1) AS evidence,
                  (SELECT count(*)::text FROM assessments WHERE organisation_id = $1) AS assessments,
                  (SELECT count(*)::text FROM event_log WHERE organisation_id = $1) AS events`,
          [tenant.organisationId],
          'Retained record',
        ),
      );
      expect(Number(kept.evidence)).toBeGreaterThan(0);
      expect(Number(kept.events)).toBeGreaterThan(0);
    });

    it('locks the closed organisation out of the API entirely', async () => {
      // The tenancy middleware refuses a closed organisation before any route
      // runs, so this covers re-opening offboarding as well as reading
      // assurance — there is no route through which a closed organisation can
      // be operated.
      for (const path of ['/assurance', '/offboarding', '/export']) {
        const response = await get(path);
        expect(response.statusCode, path).toBe(412);
        expect(response.body, path).toMatch(/closed/i);
      }
      const reopen = await post('/offboarding', { reason: 'again' });
      expect(reopen.statusCode).toBe(412);
    });
  });

  describe('an owner scoped to the organisation itself', () => {
    /**
     * The case the rest of this suite misses.
     *
     * `seedTenant` grants its owner at MSP scope, so revocation — which targets
     * organisation-scoped grants — never touched their session. A direct
     * customer's own owner IS organisation-scoped, and running the flow live
     * showed them revoking their own access half way through and being unable
     * to complete the closure they had started, leaving an organisation
     * mid-offboarding with its credentials already destroyed and nobody signed
     * in who could finish.
     */
    let ownToken: string;
    let ownOrganisationId: string;

    beforeAll(async () => {
      const signup = await harness.server.inject({
        method: 'POST',
        url: '/v1/signup',
        payload: {
          email: 'direct-owner@test.invalid',
          password: 'Direct-password-2026!',
          contactName: 'Direct Owner',
          accountKind: 'DIRECT',
          organisationName: 'Direct Ltd',
        },
      });
      const { developmentToken } = signup.json() as { developmentToken: string };
      const completed = await harness.server.inject({
        method: 'POST',
        url: '/v1/signup/complete',
        payload: { token: developmentToken, password: 'Direct-password-2026!' },
      });
      const body = completed.json() as {
        accessToken: string;
        account: { organisationId: string };
      };
      ownToken = body.accessToken;
      ownOrganisationId = body.account.organisationId;
    });

    it('is organisation-scoped, which is what makes this different', async () => {
      const grants = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ scope_type: string }>(
          `SELECT scope_type FROM grants WHERE scope_id = $1 AND revoked_at IS NULL`,
          [ownOrganisationId],
        ),
      );
      expect(grants.map((g) => g.scope_type)).toContain('ORGANISATION');
    });

    it('can finish the offboarding it started', async () => {
      const call = (path: string, payload: unknown = {}) =>
        harness.server.inject({
          method: 'POST',
          url: `/v1/organisations/${ownOrganisationId}${path}`,
          headers: bearer(ownToken),
          payload,
        });

      expect((await call('/offboarding', { reason: 'Leaving' })).statusCode).toBe(200);
      expect((await call('/offboarding/export')).statusCode).toBe(200);
      expect((await call('/offboarding/revoke', { reason: 'Leaving' })).statusCode).toBe(200);

      // The operator's own session survives the revocation step, or they
      // cannot get any further than this line.
      const stillIn = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${ownOrganisationId}/offboarding`,
        headers: bearer(ownToken),
      });
      expect(stillIn.statusCode, 'the operator revoked their own access').toBe(200);

      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(
          `UPDATE subscriptions SET status = 'CANCELLED' WHERE organisation_id = $1`,
          [ownOrganisationId],
        );
      });

      const closed = await call('/offboarding/close');
      expect(closed.statusCode, closed.body).toBe(200);
      expect((closed.json() as { status: string }).status).toBe('CLOSED');
    });

    it('loses that session once the relationship has formally ended', async () => {
      // Spared until closure, not spared forever.
      const revoked = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ id: string }>(
          `SELECT s.id FROM sessions s
           WHERE s.revoked_at IS NULL AND s.user_id IN (
             SELECT g.principal_id FROM grants g
             WHERE g.scope_type = 'ORGANISATION' AND g.scope_id = $1 AND g.revoked_at IS NULL)`,
          [ownOrganisationId],
        ),
      );
      expect(revoked).toHaveLength(0);
    });
  });

  describe('the database refuses a bad closure independently', () => {
    it('will not accept CLOSED without a recorded export', async () => {
      const other = await seedTenant(harness, { slug: 'leaving-other', records: [] });
      await expect(
        harness.db.withPlatform(async (ctx) => {
          await ctx.query(
            `UPDATE organisations
             SET status = 'CLOSED', closed_at = now(),
                 offboarding_started_at = now(), offboarding_reason = 'bypass attempt'
             WHERE id = $1`,
            [other.organisationId],
          );
        }),
      ).rejects.toThrow();
      // A bug in the service still cannot produce a closed organisation whose
      // customer never received their record.
    });
  });
});
