import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
  TEST_PASSWORD,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * Governed containment, end to end.
 *
 * Contract v3.1 §15 and §16. The properties under test are the ones an incident
 * actually turns on: that containment is attributable, that it cannot be
 * released by whoever or whatever applied it automatically, that it never
 * denies an organisation its own record, and that it is not the same thing as
 * not having paid.
 */

const available = await databaseAvailable();

const JUSTIFICATION =
  'Entra client secret was found in a public paste; isolating the connector while we rotate.';
const FINDINGS =
  'Secret rotated, paste removed, and Entra sign-in logs show no use of the exposed credential.';

describe.skipIf(!available)('containment', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let mspToken: string;
  let platformToken: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, {
      slug: 'contained-corp',
      frameworks: ['cyber-essentials'],
    });
    mspToken = await signIn(harness, 'owner-contained-corp@test.invalid');

    const hash = await harness.app.passwords.hash(TEST_PASSWORD);
    await harness.db.withPlatform(async (ctx) => {
      const user = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO users (email, display_name, status) VALUES ($1,$2,'ACTIVE')
         ON CONFLICT (lower(email)) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        ['ops@veylith.test.invalid', 'Veylith Operator'],
        'User',
      );
      await ctx.query(
        `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
        [user.id, hash],
      );
      await ctx.query(
        `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles)
         VALUES ('USER', $1, 'PLATFORM', NULL, $2::text[])
         ON CONFLICT (principal_type, principal_id, scope_type,
                      COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'))
         WHERE revoked_at IS NULL DO UPDATE SET roles = EXCLUDED.roles`,
        [user.id, ['PLATFORM_ADMIN']],
      );
    });
    platformToken = await signIn(harness, 'ops@veylith.test.invalid');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  const url = `/v1/organisations`;

  it('publishes what each level costs, so a decision is informed', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/v1/containment/levels',
      headers: bearer(mspToken),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      levels: { level: string; evidenceReadable: boolean }[];
      invariant: string;
      separation: string;
    };

    expect(body.levels).toHaveLength(6);
    // The invariant, stated where an operator reads it rather than only in code.
    for (const level of body.levels) expect(level.evidenceReadable).toBe(true);
    expect(body.invariant).toMatch(/does not stop customers knowing things/i);
    expect(body.separation).toMatch(/non-payment is never a containment/i);
  });

  it('refuses a containment with no stated reason', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `${url}/${tenant.organisationId}/containment`,
      headers: bearer(mspToken),
      payload: { level: 'C1', trigger: 'SECRET_EXPOSURE', justification: 'bad' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('contains an organisation, attributably', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `${url}/${tenant.organisationId}/containment`,
      headers: bearer(mspToken),
      payload: { level: 'C1', trigger: 'EVIDENCE_INTEGRITY_FAILURE', justification: JUSTIFICATION },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      fromLevel: string;
      toLevel: string;
      actorKind: string;
      actorLabel: string;
      evidenceRemainsReadable: boolean;
    };
    expect(body.fromLevel).toBe('C0');
    expect(body.toLevel).toBe('C1');
    expect(body.actorKind).toBe('MSP');
    expect(body.actorLabel.length).toBeGreaterThan(0);
    expect(body.evidenceRemainsReadable).toBe(true);
  });

  it('still serves the organisation its own assurance record while contained', async () => {
    /**
     * The invariant that matters most, tested through the real API rather than
     * asserted in the domain. An organisation locked out of its record during
     * an incident cannot respond to it.
     */
    const assurance = await harness.server.inject({
      method: 'GET',
      url: `${url}/${tenant.organisationId}/assurance`,
      headers: bearer(mspToken),
    });
    expect(assurance.statusCode).toBe(200);

    const history = await harness.server.inject({
      method: 'GET',
      url: `${url}/${tenant.organisationId}/containment`,
      headers: bearer(mspToken),
    });
    expect(history.statusCode).toBe(200);
    const body = history.json() as { currentLevel: string; history: unknown[] };
    expect(body.currentLevel).toBe('C1');
    // An organisation is entitled to see every restriction placed on it.
    expect(body.history.length).toBeGreaterThan(0);
  });

  it('refuses an MSP a platform-wide protective state', async () => {
    // C5 stops every other MSP's estate. Not one partner's to declare.
    const response = await harness.server.inject({
      method: 'POST',
      url: `${url}/${tenant.organisationId}/containment`,
      headers: bearer(mspToken),
      payload: { level: 'C5', trigger: 'PRODUCTION_COMPROMISE', justification: JUSTIFICATION },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses recovery that cannot say what was found', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `${url}/${tenant.organisationId}/containment/recover`,
      headers: bearer(mspToken),
      payload: {
        toLevel: 'C0',
        resolution: 'RESOLVED',
        findings: 'fixed it',
        reObserved: true,
        evidencePreserved: true,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses recovery without re-observation', async () => {
    // Believing it is fixed is not the same as having looked (§5.5).
    const response = await harness.server.inject({
      method: 'POST',
      url: `${url}/${tenant.organisationId}/containment/recover`,
      headers: bearer(mspToken),
      payload: {
        toLevel: 'C0',
        resolution: 'RESOLVED',
        findings: FINDINGS,
        reObserved: false,
        evidencePreserved: true,
      },
    });
    expect(response.statusCode).toBe(412);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(
      /re-observation/i,
    );
  });

  it('recovers when the account is one somebody could defend in a review', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `${url}/${tenant.organisationId}/containment/recover`,
      headers: bearer(mspToken),
      payload: {
        toLevel: 'C0',
        resolution: 'RESOLVED',
        findings: FINDINGS,
        reObserved: true,
        evidencePreserved: true,
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { fromLevel: string; toLevel: string };
    expect(body.fromLevel).toBe('C1');
    expect(body.toLevel).toBe('C0');
  });

  it('routes a serious containment back through observation', async () => {
    // C3 restricted what the customer could do. Coming straight back to normal
    // would mean nobody watched the estate run before Adericel acts on it again.
    const applied = await harness.server.inject({
      method: 'POST',
      url: `${url}/${tenant.organisationId}/containment`,
      headers: bearer(mspToken),
      payload: { level: 'C3', trigger: 'UNAUTHORISED_EXPORT', justification: JUSTIFICATION },
    });
    expect(applied.statusCode).toBe(201);

    const straightBack = await harness.server.inject({
      method: 'POST',
      url: `${url}/${tenant.organisationId}/containment/recover`,
      headers: bearer(mspToken),
      payload: {
        toLevel: 'C0',
        resolution: 'RESOLVED',
        findings: FINDINGS,
        reObserved: true,
        evidencePreserved: true,
      },
    });
    expect(straightBack.statusCode).toBe(412);
    expect(straightBack.json<{ error: { message: string } }>().error.message).toMatch(/C1 first/i);

    const viaC1 = await harness.server.inject({
      method: 'POST',
      url: `${url}/${tenant.organisationId}/containment/recover`,
      headers: bearer(mspToken),
      payload: {
        toLevel: 'C1',
        resolution: 'RESOLVED',
        findings: FINDINGS,
        reObserved: true,
        evidencePreserved: true,
      },
    });
    expect(viaC1.statusCode).toBe(201);
  });

  it('lets Veylith reach the platform-scale levels an MSP cannot', async () => {
    /**
     * C4 and C5 exist for threats that reach every estate, so they are
     * Veylith's alone — and an MSP operator correctly has no route to them.
     *
     * This test exists because the first version of the model defined those
     * levels and provided no route that could apply them: Veylith holds no
     * standing authority over an individual organisation, so the
     * organisation-scoped route refused them, and the two highest levels were
     * unreachable. A containment ceiling nobody can reach is not a ceiling.
     */
    const response = await harness.server.inject({
      method: 'POST',
      url: '/v1/system/containment',
      headers: bearer(platformToken),
      payload: {
        level: 'C4',
        trigger: 'SUSPECTED_TENANT_ISOLATION_FAILURE',
        justification: 'Possible cross-tenant read observed in the portfolio aggregate query.',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ toLevel: string }>().toLevel).toBe('C4');

    // An MSP cannot reach the same route.
    const refused = await harness.server.inject({
      method: 'POST',
      url: '/v1/system/containment',
      headers: bearer(mspToken),
      payload: {
        level: 'C4',
        trigger: 'SUSPECTED_TENANT_ISOLATION_FAILURE',
        justification: 'An MSP should not be able to stop every other MSP\u2019s estate.',
      },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('keeps the history append-only even to a platform administrator', async () => {
    // The database refuses, not the application. A history that the most
    // privileged principal can rewrite is not a history.
    // The data layer wraps driver errors, so the assertion is that the write
    // is refused at all — the refusal comes from a database trigger, which is
    // the point: no application code path, however privileged, can get past it.
    await expect(
      harness.db.withPlatform(async (ctx) =>
        ctx.query(`UPDATE containment_events SET justification = 'nothing happened'`, []),
      ),
    ).rejects.toThrow();

    await expect(
      harness.db.withPlatform(async (ctx) => ctx.query(`DELETE FROM containment_events`, [])),
    ).rejects.toThrow();

    // And the record is intact afterwards.
    const surviving = await harness.db.withPlatform(async (ctx) =>
      ctx.oneOrFail<{ count: string }>(
        `SELECT count(*)::text AS count FROM containment_events WHERE justification <> 'nothing happened'`,
        [],
        'Containment history',
      ),
    );
    expect(Number(surviving.count)).toBeGreaterThan(0);
  });
});

describe.skipIf(!available)('containment is not a commercial state', () => {
  let harness: Harness;
  let tenant: SeededTenant;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'paying-corp', frameworks: ['cyber-essentials'] });
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('does not contain an organisation because its subscription lapsed', async () => {
    /**
     * Contract v3.1 §16. Non-payment is a commercial matter and security
     * containment is a safety matter, and letting one become the other means an
     * operational restriction applied for the wrong reason to somebody who
     * cannot tell why.
     */
    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(`UPDATE organisations SET status = 'SUSPENDED' WHERE id = $1`, [
        tenant.organisationId,
      ]);
    });

    const row = await harness.db.withPlatform(async (ctx) =>
      ctx.oneOrFail<{ containment_level: string; status: string }>(
        `SELECT containment_level, status FROM organisations WHERE id = $1`,
        [tenant.organisationId],
        'Organisation',
      ),
    );

    // Commercially suspended, and not contained. Two separate columns, on
    // purpose, so no query can casually conflate them.
    expect(row.status).toBe('SUSPENDED');
    expect(row.containment_level).toBe('C0');
  });
});
