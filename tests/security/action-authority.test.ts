import { createTokenHasher, generateApiKey } from '@adericel/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_INSTANT,
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
  signInWithMfa,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * The action control plane, attacked rather than reviewed.
 *
 * Adericel's most dangerous capability is that it can change a customer's
 * production environment. The rule that makes that acceptable is:
 *
 *   Policy → Authorisation → Proposal → Approval → Execution → Verification
 *
 * with no path from an AI conclusion, an API key, or a workflow straight to an
 * effect. Every test here tries to find such a path.
 *
 * These go through the real HTTP surface, not the service layer, because the
 * boundary that matters is the one an attacker can actually reach.
 */

const available = await databaseAvailable();

const RECORDS = [
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'auth-user-bad',
    payload: {
      externalId: 'auth-user-bad',
      displayName: 'Person Without MFA',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: false,
      lastSignInAt: '2026-09-01T09:00:00.000Z',
    },
  },
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'auth-user-also-bad',
    payload: {
      externalId: 'auth-user-also-bad',
      displayName: 'Another Person Without MFA',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: false,
      lastSignInAt: '2026-09-01T09:00:00.000Z',
    },
  },
];

describe.skipIf(!available)('action authority', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let analyst: string;
  let approver: string;
  let findingId: string;
  let targetNodeId: string;
  let otherTargetNodeId: string;

  /**
   * Each test gets its own action.
   *
   * Proposals converge on one action by design — two schedulers reacting to the
   * same finding must not dispatch twice — so without a distinct key per test
   * these would all reuse whatever the previous test left behind. Convergence
   * itself is covered by its own tests below rather than relied on here.
   */
  let proposalSeq = 0;

  const propose = async (
    overrides: Record<string, unknown> = {},
    token = analyst,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    proposalSeq += 1;
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions`,
      headers: bearer(token),
      payload: {
        actionType: 'identity.mfa.require',
        integrationId: tenant.integrationId,
        targetNodeId,
        targetExternalId: 'auth-user-bad',
        parameters: { enforcement: 'REQUIRED' },
        findingId,
        rationale: 'Enforce MFA on an active account with no second factor.',
        idempotencyKey: `authority-test-${proposalSeq}`,
        ...overrides,
      },
    });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  };

  const decide = async (actionId: string, decision: string, token = approver) =>
    harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions/${actionId}/decision`,
      headers: bearer(token),
      payload: { decision },
    });

  const execute = async (actionId: string, token = analyst) =>
    harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions/${actionId}/execute`,
      headers: bearer(token),
    });

  const stateOf = async (actionId: string): Promise<string> =>
    harness.db.withTenant(tenant.organisationId, async (ctx) => {
      const row = await ctx.oneOrFail<{ state: string }>(
        `SELECT state FROM actions WHERE id = $1 AND organisation_id = $2`,
        [actionId, tenant.organisationId],
        'Action',
      );
      return row.state;
    });

  /** Propose and fully approve, leaving the action AUTHORISED but unexecuted. */
  const authorised = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const proposed = await propose(overrides);
    expect(proposed.status).toBe(201);
    const actionId = (proposed.body as { action: { id: string } }).action.id;
    const decision = await decide(actionId, 'APPROVED');
    expect(decision.statusCode).toBe(200);
    expect(await stateOf(actionId)).toBe('AUTHORISED');
    return actionId;
  };

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, {
      slug: 'authority-corp',
      records: RECORDS,
      autonomyLevel: 3,
    });
    analyst = await signIn(harness, 'analyst-authority-corp@test.invalid');
    approver = await signInWithMfa(harness, 'approver-authority-corp@test.invalid');

    const collected = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}/collect`,
      headers: bearer(analyst),
    });
    if (collected.statusCode !== 200)
      throw new Error(`collect: ${collected.statusCode} ${collected.body}`);

    const assessed = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/assessments/run-all`,
      headers: bearer(analyst),
    });
    if (assessed.statusCode !== 201)
      throw new Error(`run-all: ${assessed.statusCode} ${assessed.body}`);

    const findings = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/findings`,
      headers: bearer(analyst),
    });
    const open = (findings.json() as { findings?: { id: string; subject: string }[] }).findings;
    if (!open?.length) throw new Error(`no open findings: ${findings.statusCode} ${findings.body}`);
    findingId = open.find((f) => f.subject.includes('Person Without MFA'))!.id;

    const nodes = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/nodes?kind=Identity`,
      headers: bearer(analyst),
    });
    const identities = (nodes.json() as { nodes: { id: string; externalId: string }[] }).nodes;
    targetNodeId = identities.find((n) => n.externalId.includes('auth-user-bad'))!.id;
    otherTargetNodeId = identities.find((n) => n.externalId.includes('also-bad'))!.id;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  // ---- The path from proposal to effect --------------------------------

  describe('nothing reaches the customer without passing every gate', () => {
    it('records no execution attempt at proposal time', async () => {
      const proposed = await propose({
        targetNodeId: otherTargetNodeId,
        targetExternalId: 'auth-user-also-bad',
      });
      const actionId = (proposed.body as { action: { id: string } }).action.id;
      const attempts = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
        ctx.many(`SELECT id FROM action_executions WHERE action_id = $1`, [actionId]),
      );
      // Proposing is not doing. A proposal that dispatched anything would make
      // the approval decorative.
      expect(attempts).toHaveLength(0);
      expect(await stateOf(actionId)).toBe('AWAITING_APPROVAL');
    });

    it('refuses to execute an action that is awaiting approval', async () => {
      const proposed = await propose();
      const actionId = (proposed.body as { action: { id: string } }).action.id;
      const response = await execute(actionId);
      expect(response.statusCode).toBe(412);
      expect(response.body).toMatch(/not authorised/i);
    });

    it('refuses to execute a rejected action', async () => {
      const proposed = await propose();
      const actionId = (proposed.body as { action: { id: string } }).action.id;
      expect((await decide(actionId, 'REJECTED')).statusCode).toBe(200);
      expect(await stateOf(actionId)).toBe('REJECTED');

      const response = await execute(actionId);
      expect(response.statusCode).toBe(412);
      expect(await stateOf(actionId)).toBe('REJECTED');
    });

    it('refuses to approve an action that is not awaiting approval', async () => {
      const proposed = await propose();
      const actionId = (proposed.body as { action: { id: string } }).action.id;
      expect((await decide(actionId, 'REJECTED')).statusCode).toBe(200);
      // A second decision on a settled action would let a rejection be
      // overturned without a new proposal and a new review.
      const again = await decide(actionId, 'APPROVED');
      expect(again.statusCode).toBe(412);
      expect(await stateOf(actionId)).toBe('REJECTED');
    });
  });

  // ---- Who may approve -------------------------------------------------

  describe('approval is a human act, by someone other than the proposer', () => {
    it('refuses approval from a machine principal', async () => {
      const proposed = await propose();
      const actionId = (proposed.body as { action: { id: string } }).action.id;

      // An API key with full organisation authority — the strongest machine
      // principal the system can issue.
      const keyToken = await harness.db.withPlatform(async (ctx) => {
        const key = harness.app.tokens
          ? generateApiKey(harness.app.tokens, 'adk')
          : generateApiKey(createTokenHasher(harness.config.auth.jwtSecret), 'adk');
        const inserted = await ctx.oneOrFail<{ id: string }>(
          `INSERT INTO api_keys (key_id, secret_hash, name, msp_id, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [key.keyId, key.secretHash, 'authority-test', tenant.mspId, tenant.ownerUserId],
          'API key',
        );
        // Granted the strongest authority the system can express, at both the
        // MSP and the organisation, so the refusal cannot be attributed to a
        // missing role.
        await ctx.query(
          `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles)
           VALUES ('API_KEY', $1, 'MSP', $2, ARRAY['MSP_OWNER']::text[]),
                  ('API_KEY', $1, 'ORGANISATION', $3, ARRAY['ORG_APPROVER']::text[])`,
          [inserted.id, tenant.mspId, tenant.organisationId],
        );
        return key.presented;
      });

      const response = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/actions/${actionId}/decision`,
        headers: { authorization: `Bearer ${keyToken}` },
        payload: { decision: 'APPROVED' },
      });
      // Four-eyes exists so a person takes responsibility. A key held by the
      // same system that proposed the change is not a second pair of eyes.
      //
      // The refusal is deliberately indistinguishable from any other denial —
      // an unauthenticated caller learns nothing about what exists — so this
      // asserts the outcome rather than the wording. That the reason really is
      // "requires a human principal", and that it is reached before any grant
      // is consulted, is asserted directly in packages/domain/src/authz.test.ts.
      expect(response.statusCode).toBe(403);
      expect(await stateOf(actionId)).toBe('AWAITING_APPROVAL');

      // The same key can read, so the refusal is specific to approval rather
      // than the key being inert.
      const canRead = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${tenant.organisationId}/actions`,
        headers: { authorization: `Bearer ${keyToken}` },
      });
      expect(canRead.statusCode).toBe(200);
    });

    it('refuses approval from a user with no approver role', async () => {
      const proposed = await propose();
      const actionId = (proposed.body as { action: { id: string } }).action.id;
      // The analyst can propose and execute but was never granted approval
      // authority. Holding one authority must not imply the others.
      const response = await decide(actionId, 'APPROVED', analyst);
      expect(response.statusCode).toBe(403);
      expect(await stateOf(actionId)).toBe('AWAITING_APPROVAL');
    });

    it('counts one approver once, however many times they decide', async () => {
      // A two-approver action, so a single person voting twice would be enough
      // if the count were naive.
      const disruptive = await propose({
        actionType: 'identity.account.disable',
        parameters: { reason: 'Compromised account' },
      });
      expect(disruptive.status).toBe(201);
      const body = disruptive.body as {
        action: { id: string };
        decision: { requiredApprovals: number };
      };
      expect(body.decision.requiredApprovals).toBe(2);
      const actionId = body.action.id;

      expect((await decide(actionId, 'APPROVED')).statusCode).toBe(200);
      expect(await stateOf(actionId)).toBe('AWAITING_APPROVAL');

      // The same approver again. The unique index on (approval, approver) is
      // what stops one person satisfying a two-person requirement.
      const second = await decide(actionId, 'APPROVED');
      expect(second.statusCode).toBeGreaterThanOrEqual(400);
      expect(await stateOf(actionId)).toBe('AWAITING_APPROVAL');

      const count = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
        ctx.oneOrFail<{ n: string }>(
          `SELECT count(*)::text AS n FROM approval_decisions d
           JOIN approvals a ON a.id = d.approval_id
           WHERE a.action_id = $1`,
          [actionId],
          'Decisions',
        ),
      );
      expect(count.n).toBe('1');
    });
  });

  // ---- What was approved is what runs ----------------------------------

  describe('an approval authorises one specific change', () => {
    it('binds a digest of the request at proposal and copies it to the approval', async () => {
      const actionId = await authorised();
      const row = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
        ctx.oneOrFail<{ action_digest: string; approval_digest: string }>(
          `SELECT a.request_digest AS action_digest, ap.request_digest AS approval_digest
           FROM actions a JOIN approvals ap ON ap.id = a.approval_id
           WHERE a.id = $1`,
          [actionId],
          'Action',
        ),
      );
      expect(row.action_digest).toMatch(/^sha256:/);
      expect(row.approval_digest).toBe(row.action_digest);
    });

    it('cancels rather than executes when the parameters changed after approval', async () => {
      const actionId = await authorised();

      // The scenario this defends against: an approver says yes to "require
      // MFA", and between that moment and dispatch the row is edited. Nothing
      // in the current code does this — which is exactly why it must be a
      // control rather than a happy accident of the feature set.
      await harness.db.withTenant(tenant.organisationId, async (ctx) => {
        await ctx.query(
          `UPDATE actions SET parameters = '{"enforcement":"REQUIRED","extra":"smuggled"}'::jsonb
           WHERE id = $1 AND organisation_id = $2`,
          [actionId, tenant.organisationId],
        );
      });

      const response = await execute(actionId);
      expect(response.statusCode).toBe(412);
      expect(response.body).toMatch(/no longer matches what was authorised/i);
      expect(await stateOf(actionId)).toBe('CANCELLED');

      // And nothing was dispatched.
      const attempts = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
        ctx.many(`SELECT id FROM action_executions WHERE action_id = $1`, [actionId]),
      );
      expect(attempts).toHaveLength(0);
    });

    it('cancels when the target was swapped after approval', async () => {
      const actionId = await authorised();
      await harness.db.withTenant(tenant.organisationId, async (ctx) => {
        await ctx.query(
          `UPDATE actions SET target_external_id = 'auth-user-also-bad', target_node_id = $3
           WHERE id = $1 AND organisation_id = $2`,
          [actionId, tenant.organisationId, otherTargetNodeId],
        );
      });
      // Approving a change to one account is not approving the same change to
      // a different one.
      const response = await execute(actionId);
      expect(response.statusCode).toBe(412);
      expect(await stateOf(actionId)).toBe('CANCELLED');
    });

    it('cancels when the action type was swapped for a more dangerous one', async () => {
      const actionId = await authorised();
      await harness.db.withTenant(tenant.organisationId, async (ctx) => {
        await ctx.query(
          `UPDATE actions SET action_type = 'identity.account.disable', risk_class = 'DISRUPTIVE'
           WHERE id = $1 AND organisation_id = $2`,
          [actionId, tenant.organisationId],
        );
      });
      // The escalation path this closes: get a low-risk change approved, then
      // execute a disruptive one under that authority.
      const response = await execute(actionId);
      expect(response.statusCode).toBe(412);
      expect(await stateOf(actionId)).toBe('CANCELLED');
    });

    it('executes normally when nothing was tampered with', async () => {
      // The control must not be so strict that the ordinary path breaks. If
      // this fails, the previous three tests prove nothing useful.
      const actionId = await authorised();
      const response = await execute(actionId);
      expect(response.statusCode).toBe(200);
      const body = response.json() as { executionStatus: string; verificationRequired: boolean };
      expect(body.executionStatus).toBe('SUCCEEDED');
      // EXECUTED is not REMEDIATED. The action is not done until re-observation.
      expect(body.verificationRequired).toBe(true);
      expect(await stateOf(actionId)).toBe('VERIFYING');
    });
  });

  // ---- Expiry, replay and the outer boundary ---------------------------

  describe('time, replay and tenancy', () => {
    it('refuses an approval after the window has closed', async () => {
      const proposed = await propose();
      const actionId = (proposed.body as { action: { id: string } }).action.id;
      await harness.db.withTenant(tenant.organisationId, async (ctx) => {
        await ctx.query(
          // Relative to the harness's manual clock, not the database's: the
          // service compares against the injected instant, which is the whole
          // point of injecting it.
          `UPDATE approvals SET expires_at = $3::timestamptz - interval '1 hour'
           WHERE action_id = $1 AND organisation_id = $2`,
          [actionId, tenant.organisationId, TEST_INSTANT],
        );
      });
      const response = await decide(actionId, 'APPROVED');
      expect(response.statusCode).toBe(412);
      expect(response.body).toMatch(/expired/i);
      expect(await stateOf(actionId)).toBe('AWAITING_APPROVAL');
    });

    it('refuses to execute after the authorisation expired', async () => {
      const actionId = await authorised();
      await harness.db.withTenant(tenant.organisationId, async (ctx) => {
        await ctx.query(
          `UPDATE actions SET expires_at = $3::timestamptz - interval '1 hour'
           WHERE id = $1 AND organisation_id = $2`,
          [actionId, tenant.organisationId, TEST_INSTANT],
        );
      });
      const response = await execute(actionId);
      expect(response.statusCode).toBe(412);
      expect(await stateOf(actionId)).toBe('CANCELLED');
    });

    it('adopts a previous successful execution rather than repeating the effect', async () => {
      const actionId = await authorised({
        targetNodeId: otherTargetNodeId,
        targetExternalId: 'auth-user-also-bad',
      });
      const first = await execute(actionId);
      expect(first.statusCode).toBe(200);
      expect((first.json() as { alreadyExecuted: boolean }).alreadyExecuted).toBe(false);

      // A retry after a network timeout, a worker restart, or an n8n replay.
      // At-least-once delivery must not become at-least-once side effects.
      const replay = await execute(actionId);
      expect(replay.statusCode).toBe(200);
      const body = replay.json() as { alreadyExecuted: boolean; executionStatus: string };
      expect(body.alreadyExecuted).toBe(true);
      expect(body.executionStatus).toBe('SUCCEEDED');

      const attempts = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
        ctx.many(`SELECT id FROM action_executions WHERE action_id = $1`, [actionId]),
      );
      expect(attempts).toHaveLength(1);
    });

    it('refuses to retry blindly after an execution whose outcome is unknown', async () => {
      const actionId = await authorised();
      await harness.db.withTenant(tenant.organisationId, async (ctx) => {
        const action = await ctx.oneOrFail<{ idempotency_key: string }>(
          `SELECT idempotency_key FROM actions WHERE id = $1`,
          [actionId],
          'Action',
        );
        await ctx.query(
          `INSERT INTO action_executions
             (organisation_id, action_id, attempt, idempotency_key, status, error_detail)
           VALUES ($1, $2, 1, $3, 'UNKNOWN_OUTCOME', 'Connection reset after dispatch')`,
          [tenant.organisationId, actionId, action.idempotency_key],
        );
      });

      // We do not know whether the external system acted. Retrying could
      // duplicate a side effect we cannot see, so the honest answer is to stop
      // and reconcile rather than guess.
      const response = await execute(actionId);
      expect(response.statusCode).toBe(409);
      expect(response.body).toMatch(/unknown outcome/i);
      expect(await stateOf(actionId)).not.toBe('EXECUTED');
    });

    it('does not let another tenant approve or execute this tenant’s action', async () => {
      const actionId = await authorised({
        targetNodeId: otherTargetNodeId,
        targetExternalId: 'auth-user-also-bad',
        parameters: { enforcement: 'REQUIRED' },
        idempotencyKey: `cross-tenant-${Date.now()}`,
      });

      const other = await seedTenant(harness, { slug: 'authority-other', records: RECORDS });
      const otherApprover = await signInWithMfa(harness, 'approver-authority-other@test.invalid');
      const otherAnalyst = await signIn(harness, 'analyst-authority-other@test.invalid');

      for (const [path, token] of [
        [`actions/${actionId}/decision`, otherApprover],
        [`actions/${actionId}/execute`, otherAnalyst],
      ] as const) {
        // Through their own organisation's path: the action is invisible.
        const viaOwn = await harness.server.inject({
          method: 'POST',
          url: `/v1/organisations/${other.organisationId}/${path}`,
          headers: bearer(token),
          payload: { decision: 'APPROVED' },
        });
        expect(viaOwn.statusCode).toBe(404);

        // Through the owning organisation's path: they are not entitled to it.
        const viaTheirs = await harness.server.inject({
          method: 'POST',
          url: `/v1/organisations/${tenant.organisationId}/${path}`,
          headers: bearer(token),
          payload: { decision: 'APPROVED' },
        });
        expect([403, 404]).toContain(viaTheirs.statusCode);
      }

      expect(await stateOf(actionId)).toBe('AUTHORISED');
    });
  });
});
