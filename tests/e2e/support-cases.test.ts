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
 * The support domain, end to end.
 *
 * Contract v3.1 §20–26. Two properties carry the file:
 *
 *   - Support is a disclosure surface, so nothing about any organisation is
 *     said before identity and entitlement are established — including whether
 *     the organisation exists.
 *   - Adericel is sold through MSPs, so an end customer's case goes to their
 *     MSP. That boundary has one exception, and it is a security concern.
 */

const available = await databaseAvailable();

const REASON = 'Entra connector reauthorised and re-collection confirmed running against it.';

describe.skipIf(!available)('support cases', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  /** A person at the client organisation. The §20 end customer. */
  let clientToken: string;
  /** A person at the MSP that runs it. */
  let mspToken: string;
  let caseId: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'help-corp', frameworks: ['cyber-essentials'] });
    mspToken = await signIn(harness, 'analyst-help-corp@test.invalid');

    /**
     * An organisation-scoped user, built explicitly.
     *
     * Every user `seedTenant` creates holds an MSP-scoped grant, so a case
     * they raise is an MSP escalating to its supplier — which is a different
     * §20 path and routes to Veylith, correctly. Testing the end-customer
     * boundary needs an actual end customer.
     */
    const hash = await harness.app.passwords.hash(TEST_PASSWORD);
    await harness.db.withPlatform(async (ctx) => {
      const user = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO users (email, display_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
        ['client-help-corp@test.invalid', 'Client Staff'],
        'User',
      );
      await ctx.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)`, [
        user.id,
        hash,
      ]);
      await ctx.query(
        `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles)
         VALUES ('USER', $1, 'ORGANISATION', $2, ARRAY['ORG_ADMIN']::text[])`,
        [user.id, tenant.organisationId],
      );
    });
    clientToken = await signIn(harness, 'client-help-corp@test.invalid');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  const open = async (
    payload: Record<string, unknown> = {},
    token = clientToken,
  ): ReturnType<Harness['server']['inject']> =>
    harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/support/cases`,
      headers: bearer(token),
      payload: {
        category: 'INTEGRATION_FAILURE',
        severity: 'S2',
        subject: 'Entra connector stopped supplying observations',
        description: 'Every identity control has read UNKNOWN since Sunday.',
        ...payload,
      },
    });

  const move = async (
    payload: Record<string, unknown>,
    id = caseId,
  ): ReturnType<Harness['server']['inject']> =>
    harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/support/cases/${id}/transitions`,
      headers: bearer(clientToken),
      payload: { reason: REASON, ...payload },
    });

  it('publishes what it promises, including what it will not do', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/v1/support/model',
      headers: bearer(clientToken),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      severities: { severity: string; closureNeedsCustomerConfirmation: boolean }[];
      prohibitedTransitions: { to: string; because: string }[];
      routing: string;
      disclosure: string;
    }>();

    expect(body.severities).toHaveLength(4);
    expect(body.prohibitedTransitions.length).toBeGreaterThanOrEqual(4);
    // Published deliberately: a customer is entitled to know nobody can mark
    // their S1 resolved without them.
    expect(body.prohibitedTransitions.map((rule) => rule.to)).toContain('RESOLVED');
    expect(body.routing).toMatch(/delivered through MSPs/i);
    expect(body.disclosure).toMatch(/including whether it exists/i);
  });

  it('routes an end customer to their MSP, and says so', async () => {
    const response = await open();
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      id: string;
      reference: string;
      queue: string;
      routingReason: string;
      state: string;
    }>();
    caseId = body.id;

    expect(body.queue).toMatch(/^MSP_/);
    expect(body.routingReason).toMatch(/delivered through your MSP/i);
    // Not TRIAGING, even for a signed-in caller. The walk through identity and
    // entitlement is what writes the record of how they were identified.
    expect(body.state).toBe('RECEIVED');
    expect(body.reference).toMatch(/^ADC-\d{8}-\d{4}$/);
  });

  it('routes the MSP’s own escalation to Veylith, which is the other half of §20', async () => {
    /**
     * The boundary has two sides and only one is a restriction. An MSP raising
     * a case IS escalating to its supplier — that is what the relationship is
     * for — so it goes to Veylith. Asserting only the refusal would leave a
     * system that refuses everything looking correct.
     */
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/support/cases`,
      headers: bearer(mspToken),
      payload: {
        category: 'INTEGRATION_FAILURE',
        severity: 'S3',
        subject: 'Escalating a connector fault we cannot reproduce',
        description: 'Entra collection fails only for this customer; other tenants are fine.',
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ queue: string; routingReason: string }>();
    expect(body.queue).toBe('VEYLITH_INTEGRATIONS');
    expect(body.routingReason).toMatch(/supported escalation path/i);
  });

  it('gives a reference that does not name the tenant', async () => {
    // References get quoted in email. One carrying an organisation slug tells
    // every recipient which customer the case is about.
    const row = await harness.db.withPlatform(async (ctx) =>
      ctx.oneOrFail<{ reference: string }>(
        `SELECT reference FROM support_cases WHERE id = $1`,
        [caseId],
        'Case',
      ),
    );
    expect(row.reference).not.toContain('help-corp');
    expect(row.reference).not.toContain(tenant.organisationId);
  });

  it('refuses to start work before knowing who is asking', async () => {
    const response = await move({ to: 'IN_PROGRESS' });
    expect(response.statusCode).toBe(412);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(
      /identity and entitlement/i,
    );
  });

  it('discloses nothing at all while the case is still arriving', async () => {
    /**
     * The failure this prevents: somebody plausible rings up and is told which
     * controls the organisation is failing. Row-level security does not stop
     * that — the person disclosing is authorised.
     */
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/support/cases/${caseId}/disclosure-check`,
      headers: bearer(clientToken),
      payload: { kind: 'ASSURANCE_STATE' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ reason: string }>().reason).toMatch(/whether the organisation exists/i);
  });

  it('records the refusal, not only the disclosure', async () => {
    // An entitlement gate whose refusals leave no trace cannot tell "nobody
    // asked" from "somebody asked eleven times".
    const rows = await harness.db.withPlatform(async (ctx) =>
      ctx.many<{ permitted: boolean; decision_reason: string }>(
        `SELECT permitted, decision_reason FROM support_disclosures WHERE case_id = $1`,
        [caseId],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.permitted).toBe(false);
    expect(rows[0]!.decision_reason).toMatch(/Remedy:/);
  });

  it('discloses once identity and entitlement are established', async () => {
    expect((await move({ to: 'IDENTITY_PENDING' })).statusCode).toBe(200);
    expect((await move({ to: 'ENTITLEMENT_PENDING' })).statusCode).toBe(200);
    expect((await move({ to: 'TRIAGING' })).statusCode).toBe(200);

    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/support/cases/${caseId}/disclosure-check`,
      headers: bearer(clientToken),
      payload: { kind: 'ASSURANCE_STATE' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ permitted: boolean }>().permitted).toBe(true);
  });

  it('never tells a client their MSP’s commercial position', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/support/cases/${caseId}/disclosure-check`,
      headers: bearer(clientToken),
      payload: { kind: 'COMMERCIAL_POSITION' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ remedy: string }>().remedy).toMatch(/Refer them to their MSP/i);
  });

  it('will not let a backlog tidy-up move the case to Veylith', async () => {
    expect((await move({ to: 'ROUTED_TO_MSP' })).statusCode).toBe(200);
    expect((await move({ to: 'IN_PROGRESS' })).statusCode).toBe(200);

    const response = await move({ to: 'QUEUED', queue: 'VEYLITH_INTEGRATIONS' });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(
      /through the MSP/i,
    );
  });

  it('will not let the engineer resolve an S2 on their own say-so', async () => {
    expect((await move({ to: 'RESOLUTION_PROPOSED' })).statusCode).toBe(200);
    expect((await move({ to: 'AWAITING_VERIFICATION' })).statusCode).toBe(200);

    const response = await move({ to: 'RESOLVED', customerVerified: false });
    expect(response.statusCode).toBe(412);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(
      /customer says it is/i,
    );

    expect((await move({ to: 'RESOLVED', customerVerified: true })).statusCode).toBe(200);
  });

  it('cannot reopen a closed case', async () => {
    expect((await move({ to: 'CLOSED' })).statusCode).toBe(200);

    const response = await move({ to: 'IN_PROGRESS' });
    expect(response.statusCode).toBe(412);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(
      /finished record/i,
    );
  });

  it('keeps the history, and will not let it be rewritten', async () => {
    const rows = await harness.db.withPlatform(async (ctx) =>
      ctx.many<{ from_state: string; to_state: string }>(
        `SELECT from_state, to_state FROM support_case_transitions
          WHERE case_id = $1 ORDER BY occurred_at`,
        [caseId],
      ),
    );
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows[0]!.from_state).toBe('RECEIVED');

    await expect(
      harness.db.withPlatform(async (ctx) =>
        ctx.query(`UPDATE support_case_transitions SET reason = 'tidied'`, []),
      ),
    ).rejects.toThrow();
    await expect(
      harness.db.withPlatform(async (ctx) => ctx.query(`DELETE FROM support_case_transitions`, [])),
    ).rejects.toThrow();
  });

  it('cannot be reached by pairing your own organisation with somebody else’s case', async () => {
    const other = await seedTenant(harness, { slug: 'other-help-corp', frameworks: [] });
    const otherToken = await signIn(harness, 'analyst-other-help-corp@test.invalid');
    const otherCase = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${other.organisationId}/support/cases`,
      headers: bearer(otherToken),
      payload: {
        category: 'ONBOARDING',
        severity: 'S4',
        subject: 'Adding a second framework',
        description: 'Want ISO 27001 alongside Cyber Essentials.',
      },
    });
    expect(otherCase.statusCode).toBe(201);
    const otherCaseId = otherCase.json<{ id: string }>().id;

    // Own organisation in the path, somebody else's case id. The answer must be
    // the same as for a case that does not exist.
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/support/cases/${otherCaseId}/transitions`,
      headers: bearer(clientToken),
      payload: { to: 'IDENTITY_PENDING', reason: REASON },
    });
    expect(response.statusCode).toBe(404);

    const untouched = await harness.db.withPlatform(async (ctx) =>
      ctx.oneOrFail<{ state: string }>(
        `SELECT state FROM support_cases WHERE id = $1`,
        [otherCaseId],
        'Case',
      ),
    );
    expect(untouched.state).toBe('RECEIVED');
  });

  it('refuses a caller trying to choose who answers them', async () => {
    // Sending `requesterKind` or `queue` on open would be a client selecting
    // its own routing. Strict schema, so it is refused rather than ignored.
    for (const payload of [{ requesterKind: 'MSP' }, { queue: 'VEYLITH_ENGINEERING' }]) {
      expect((await open(payload)).statusCode).toBe(400);
    }
  });
});

describe.skipIf(!available)('diagnostic bundles', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let token: string;
  let caseId: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'bundle-corp', frameworks: ['cyber-essentials'] });
    token = await signIn(harness, 'owner-bundle-corp@test.invalid');

    const opened = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/support/cases`,
      headers: bearer(token),
      payload: {
        category: 'INTEGRATION_FAILURE',
        severity: 'S2',
        subject: 'Collector is failing repeatedly',
        description: 'Three consecutive failures on the fixture connector.',
      },
    });
    caseId = opened.json<{ id: string }>().id;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('produces an integrity-protected bundle for one tenant', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/support/cases/${caseId}/diagnostics`,
      headers: bearer(token),
      payload: { sections: ['INTEGRATION_HEALTH', 'PLATFORM_VERSIONS'] },
    });
    expect(response.statusCode).toBe(201);
    const bundle = response.json<{
      organisationId: string;
      contentHash: string;
      scope: string;
      content: Record<string, unknown>;
    }>();

    expect(bundle.organisationId).toBe(tenant.organisationId);
    expect(bundle.contentHash).toMatch(/^sha256:/);
    expect(bundle.scope).toContain(tenant.organisationId);
  });

  it('carries no credential and no personal data', async () => {
    /**
     * The bundle is the artefact most likely to leak: broad by design, it
     * leaves the platform, and it is assembled at speed under pressure.
     *
     * Asserted over the serialised bundle rather than a field list, because the
     * thing that goes wrong is a collector widening and nobody noticing.
     */
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/support/cases/${caseId}/diagnostics`,
      headers: bearer(token),
      payload: { sections: ['INTEGRATION_HEALTH', 'IMPAIRMENT_STATE', 'PLATFORM_VERSIONS'] },
    });
    expect(response.statusCode).toBe(201);

    // Over `content` specifically, because that is what the collectors
    // produce and therefore the only part that can widen without anyone
    // noticing. The surrounding fields are fixed strings — and one of them is
    // the sentence promising there are no credentials in here, which a scan
    // over the whole body would flag as a credential.
    const serialised = JSON.stringify(response.json<{ content: unknown }>().content).toLowerCase();
    for (const forbidden of [
      'secret',
      'password',
      'token',
      'credential',
      'ciphertext',
      'apikey',
      '@test.invalid',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('records that a bundle was produced, and its hash', async () => {
    const rows = await harness.db.withPlatform(async (ctx) =>
      ctx.many<{ content_hash: string; sections: string[] }>(
        `SELECT content_hash, sections FROM support_diagnostic_bundles WHERE case_id = $1`,
        [caseId],
      ),
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.content_hash).toMatch(/^sha256:/);
      expect(row.sections.length).toBeGreaterThan(0);
    }
  });

  it('refuses to build a bundle for an organisation the case does not concern', async () => {
    /**
     * Called at the service, not through the route.
     *
     * The route pins the organisation from the path and proves the case
     * belongs to it, so a mismatched pair cannot arrive that way — which is
     * why removing this check broke no test until now. It defends the next
     * caller: a worker, a scheduled job, an internal escalation, any of which
     * passes both ids itself.
     *
     * A bundle spanning two tenants is not a convenience. It is a
     * cross-tenant disclosure with a filename.
     */
    const { produceDiagnosticBundle } = await import('@adericel/api');
    const other = await seedTenant(harness, { slug: 'bundle-other-corp', frameworks: [] });

    await expect(
      produceDiagnosticBundle(
        harness.app,
        { caseId, organisationId: other.organisationId, sections: ['PLATFORM_VERSIONS'] },
        { userId: null, label: 'Internal job' },
        'test-correlation',
      ),
    ).rejects.toThrow(/and no other/i);

    const rows = await harness.db.withPlatform(async (ctx) =>
      ctx.many<{ id: string }>(
        `SELECT id FROM support_diagnostic_bundles WHERE organisation_id = $1`,
        [other.organisationId],
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it('never stores the bundle itself', async () => {
    // Keeping every bundle would make one table the largest concentration of
    // estate detail in the platform, for the convenience of not asking again.
    const columns = await harness.db.withPlatform(async (ctx) =>
      ctx.many<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'support_diagnostic_bundles'`,
        [],
      ),
    );
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('content');
    expect(names).not.toContain('payload');
    expect(names).toContain('content_hash');
  });
});
