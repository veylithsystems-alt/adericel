import { AdericelError } from '@adericel/shared';
import { assertReObservation, createActionService, createReObserver } from '@adericel/actions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signInWithMfa,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * A verification must have looked at something.
 *
 * `ActionService.verify(actionId, observedValue: unknown)` took the value that
 * decides `CONFIRMED` from its caller. The one caller — the API route — did the
 * right thing and re-observed through the connector first. Nothing made the
 * next one do the same, and a `CONFIRMED` verification writes a `verifications`
 * row, which is evidence, which moves assurance state. Adericel would have been
 * asserting it had checked when it had only been told. (RR-095, found by doing
 * the lifecycle comparison RR-080 had deferred for three weeks.)
 *
 * Every test here attacks the verification boundary from the inside — at the
 * service, not through HTTP — because a route is not the only thing that will
 * ever call this. A worker job, an n8n flow and a second endpoint are all
 * plausible, and the point of the fix is that none of them can get it wrong.
 */

const available = await databaseAvailable();

/** A real UUID, because the transition ledger stores it as one. */
const CORRELATION_ID = '4f1c0d7a-6b2e-4a51-9c3d-8e5f1a2b3c4d';

const RECORDS = [
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'attest-user-0',
    payload: {
      externalId: 'attest-user-0',
      displayName: 'Person Without MFA',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: false,
      lastSignInAt: '2026-09-01T09:00:00.000Z',
    },
  },
];

describe('what counts as having looked', () => {
  /**
   * These need no database: the refusal is the first thing `verify` does, and
   * the function it delegates to is pure. Kept in this file rather than in a
   * unit test so the whole boundary reads in one place.
   */
  const refused = [
    ['a bare boolean, which is what an executor reporting its own success looks like', true],
    [
      'the value a connector would have returned, with nothing saying who read it',
      { managed: true },
    ],
    ['a plain string', 'CONFIRMED'],
    ['null', null],
    ['undefined', undefined],
    [
      'an object wearing the right kind but missing its provenance',
      { kind: 'OBSERVED', value: true },
    ],
    [
      'a reading whose run is not identified',
      {
        kind: 'OBSERVED',
        predicate: 'identity.mfa.enforced',
        subjectExternalId: 'attest-user-0',
        integrationId: 'i',
        observedAt: '2026-09-09T12:00:00.000Z',
        value: true,
      },
    ],
    [
      'an absence claiming a reason nobody defined',
      { kind: 'NOT_OBSERVABLE', predicate: 'p', reason: 'DO_NOT_WANT' },
    ],
    ['an absence with no reason at all', { kind: 'NOT_OBSERVABLE', predicate: 'p' }],
  ] as const;

  it('refuses every value that did not come out of a re-observer', () => {
    /**
     * One test rather than nine, deliberately. The mutation registry matches
     * literal test titles, and a title built from a template literal cannot be
     * named by a mutation — so a guard checked only by generated titles is a
     * guard nothing can prove bites. The description is passed as the
     * assertion message instead, so a failure still says which case broke.
     */
    for (const [description, value] of refused) {
      expect(() => assertReObservation(value), description).toThrow(AdericelError);
    }
  });

  it('accepts a well-formed reading that crossed a process boundary as JSON', () => {
    /**
     * Deliberately accepted, and worth stating why. A reading that was earned
     * and then serialised — queued to a worker, posted between services — is
     * still a reading, and a check that rejected it would push somebody into
     * bypassing the check rather than using it.
     *
     * So the run-time check only establishes shape. What makes a *fabricated*
     * reading fail is the database: `verifications.integration_run_id` is a
     * foreign key to `integration_runs`, so an invented run identifier is
     * refused at the insert, by Postgres, in the same transaction. The test
     * below proves that rather than asserting it.
     */
    const earned = JSON.parse(
      JSON.stringify({
        kind: 'OBSERVED',
        predicate: 'identity.mfa.enforced',
        subjectExternalId: 'attest-user-0',
        integrationId: '00000000-0000-0000-0000-000000000001',
        integrationRunId: '00000000-0000-0000-0000-000000000002',
        observedAt: '2026-09-09T12:00:00.000Z',
        value: true,
      }),
    ) as unknown;
    expect(() => assertReObservation(earned)).not.toThrow();
  });
});

describe.skipIf(!available)('verifying an action against something nobody observed', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let token: string;
  let approverToken: string;
  let actionId: string;

  beforeAll(async () => {
    harness = await createHarness();
    tenant = await seedTenant(harness, { slug: 'attest', records: RECORDS });
    token = await signInWithMfa(harness, 'owner-attest@test.invalid');
    // Approval is a different person's act by design, so the owner's token is
    // refused here and the test has to sign the approver in.
    approverToken = await signInWithMfa(harness, 'approver-attest@test.invalid');

    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}/collect`,
      headers: bearer(token),
    });

    const nodes = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/nodes?kind=Identity&externalId=attest-user-0`,
      headers: bearer(token),
    });
    const nodeId = (nodes.json() as { nodes: { id: string }[] }).nodes[0]?.id;
    expect(nodeId, 'the premise: there is a subject to act on').toBeDefined();

    const proposed = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions`,
      headers: bearer(token),
      payload: {
        actionType: 'identity.mfa.require',
        integrationId: tenant.integrationId,
        targetNodeId: nodeId,
        targetExternalId: 'attest-user-0',
        parameters: { enforcement: 'REQUIRED' },
        rationale: 'Identity has no second factor enforced.',
      },
    });
    expect([201, 202]).toContain(proposed.statusCode);
    const action = (proposed.json() as { action: { id: string; state: string } }).action;
    actionId = action.id;

    if (action.state === 'AWAITING_APPROVAL') {
      const decided = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/actions/${actionId}/decision`,
        headers: bearer(approverToken),
        payload: { decision: 'APPROVED', note: 'Required by the baseline.' },
      });
      expect(decided.statusCode).toBe(200);
    }

    const executed = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions/${actionId}/execute`,
      headers: bearer(token),
      payload: {},
    });
    expect(executed.statusCode).toBe(200);
  }, 300_000);

  afterAll(async () => {
    await harness?.close();
  });

  async function serviceFor<T>(
    run: (service: ReturnType<typeof createActionService>) => Promise<T>,
  ): Promise<T> {
    return harness.db.withTenant(tenant.organisationId, async (ctx) =>
      run(
        createActionService({
          ctx,
          clock: harness.clock,
          logger: harness.app.logger,
          connectors: harness.app.connectors,
          policy: harness.app.defaultPolicy,
          policyId: null,
          organisationAutonomyLevel: 'L1',
          correlationId: CORRELATION_ID,
          actor: 'test',
          actorUserId: null,
          unsealCredentials: harness.app.unsealCredentials,
        }),
      ),
    );
  }

  async function verificationCount(): Promise<number> {
    const row = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
      ctx.one<{ count: string }>(
        `SELECT count(*)::text AS count FROM verifications WHERE action_id = $1`,
        [actionId],
      ),
    );
    return Number(row?.count ?? '0');
  }

  it('starts from an executed action awaiting verification', async () => {
    // The premise. Every assertion below is about what verify does to an
    // action in VERIFYING, so an action in any other state would make them
    // vacuous without failing.
    const action = await serviceFor((service) => service.requireById(actionId));
    expect(action.state).toBe('VERIFYING');
    expect(await verificationCount()).toBe(0);
  });

  it('refuses the executor reporting its own success, and records nothing', async () => {
    await expect(
      // The cast is what a caller in a hurry writes, and the reason the check
      // exists at run time as well as in the type.
      serviceFor((service) => service.verify(actionId, true as never)),
    ).rejects.toThrow(AdericelError);

    const action = await serviceFor((service) => service.requireById(actionId));
    expect(action.state, 'a refused verification must not move the action').toBe('VERIFYING');
    expect(await verificationCount(), 'a refused verification must write no evidence').toBe(0);
  });

  it('refuses a fabricated reading at the database, not only at the type', async () => {
    /**
     * The forgery the shape check cannot catch: every field present, every
     * type right, and an `integrationRunId` that was invented. It fails on the
     * foreign key, inside the transaction, so no verification row survives.
     */
    const forged = {
      kind: 'OBSERVED',
      predicate: 'identity.mfa.enforced',
      subjectExternalId: 'attest-user-0',
      integrationId: tenant.integrationId,
      integrationRunId: '00000000-0000-0000-0000-0000000000ff',
      observedAt: '2026-09-09T12:00:00.000Z',
      value: true,
    } as never;
    await expect(serviceFor((service) => service.verify(actionId, forged))).rejects.toThrow();

    const action = await serviceFor((service) => service.requireById(actionId));
    expect(action.state).toBe('VERIFYING');
    expect(await verificationCount()).toBe(0);
  });

  it('cannot confirm from an absence, however the absence is dressed up', async () => {
    const result = await harness.db.withTenant(tenant.organisationId, async (ctx) => {
      const reobserver = createReObserver({
        ctx,
        clock: harness.clock,
        collection: {
          // Never reached: `notObservable` is the statement that no run is
          // possible, so a run that would have succeeded must not be consulted.
          runIntegration: () => {
            throw new Error('notObservable must not run the integration');
          },
        },
      });
      const service = createActionService({
        ctx,
        clock: harness.clock,
        logger: harness.app.logger,
        connectors: harness.app.connectors,
        policy: harness.app.defaultPolicy,
        policyId: null,
        organisationAutonomyLevel: 'L1',
        correlationId: CORRELATION_ID,
        actor: 'test',
        actorUserId: null,
        unsealCredentials: harness.app.unsealCredentials,
      });
      return service.verify(
        actionId,
        reobserver.notObservable('identity.mfa.enforced', 'NO_TARGET'),
      );
    });

    expect(
      result.outcome,
      'an absence is not a refutation and emphatically not a confirmation',
    ).toBe('INCONCLUSIVE');
    expect(result.action.state).toBe('UNVERIFIED');

    const row = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
      ctx.one<{
        integration_run_id: string | null;
        observed_at: string | null;
        not_observable_reason: string | null;
      }>(
        `SELECT integration_run_id, observed_at, not_observable_reason
           FROM verifications WHERE id = $1`,
        [result.verificationId],
      ),
    );
    // The row says why nobody looked, rather than being silent about it.
    expect(row?.not_observable_reason).toBe('NO_TARGET');
    expect(row?.integration_run_id).toBeNull();
    expect(row?.observed_at).toBeNull();
  });
});

describe.skipIf(!available)('a verification earned by re-observing', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let token: string;
  let approverToken: string;

  beforeAll(async () => {
    harness = await createHarness();
    tenant = await seedTenant(harness, { slug: 'attest-earned', records: RECORDS });
    token = await signInWithMfa(harness, 'owner-attest-earned@test.invalid');
    approverToken = await signInWithMfa(harness, 'approver-attest-earned@test.invalid');
    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}/collect`,
      headers: bearer(token),
    });
  }, 300_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('names the collection run its reading came out of', async () => {
    /**
     * The other half of the fix, and the half that makes it evidence rather
     * than a type. A verification row now points at the `integration_runs` row
     * that produced the value it judged, so "we re-observed" is a record an
     * auditor can follow rather than a sentence in a comment.
     */
    const nodes = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/nodes?kind=Identity&externalId=attest-user-0`,
      headers: bearer(token),
    });
    const nodeId = (nodes.json() as { nodes: { id: string }[] }).nodes[0]?.id;

    const proposed = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions`,
      headers: bearer(token),
      payload: {
        actionType: 'identity.mfa.require',
        integrationId: tenant.integrationId,
        targetNodeId: nodeId,
        targetExternalId: 'attest-user-0',
        parameters: { enforcement: 'REQUIRED' },
        rationale: 'Identity has no second factor enforced.',
      },
    });
    const action = (proposed.json() as { action: { id: string; state: string } }).action;

    if (action.state === 'AWAITING_APPROVAL') {
      await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/actions/${action.id}/decision`,
        headers: bearer(approverToken),
        payload: { decision: 'APPROVED', note: 'Required by the baseline.' },
      });
    }
    const executed = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions/${action.id}/execute`,
      headers: bearer(token),
      payload: {},
    });
    // Asserted rather than assumed: a verification attempted on an action that
    // never executed returns 412, and the failure would read as a provenance
    // bug rather than as a test that did not set itself up.
    expect(executed.statusCode, executed.body).toBe(200);
    const verified = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions/${action.id}/verify`,
      headers: bearer(token),
      payload: {},
    });
    expect(verified.statusCode).toBe(200);

    const row = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
      ctx.one<{
        integration_run_id: string | null;
        observed_at: string | null;
        not_observable_reason: string | null;
        trigger: string | null;
      }>(
        `SELECT v.integration_run_id, v.observed_at, v.not_observable_reason, r.trigger
           FROM verifications v
           LEFT JOIN integration_runs r ON r.id = v.integration_run_id
          WHERE v.action_id = $1`,
        [action.id],
      ),
    );
    expect(row?.integration_run_id, 'the verification does not name a run').not.toBeNull();
    expect(row?.observed_at).not.toBeNull();
    expect(row?.not_observable_reason).toBeNull();
    // And the run it names is one that was triggered for verification, not an
    // ordinary collection that happened to be lying around.
    expect(row?.trigger).toBe('VERIFICATION');
  }, 300_000);
});
