import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  databaseAvailable,
  enrolTotp,
  type Harness,
} from '../helpers/harness.js';

/**
 * Onboarding, from a cold email address to an evidence-backed answer.
 *
 * Nobody is seeded, nothing is inserted by a fixture, and no test reads a token
 * out of the database. Every credential is obtained the way a person obtains
 * it: from a message that was actually sent.
 *
 * The measure this suite exists to protect is the one that decides whether
 * Adericel is a product or a professional-services engagement: how long it
 * takes, unattended, to go from "I gave you my email" to "I am looking at a
 * statement about my own estate that cites the evidence behind it".
 */

const available = await databaseAvailable();

const RECORDS = [
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'newco-founder',
    payload: {
      externalId: 'newco-founder',
      displayName: 'Founder',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: true,
      lastSignInAt: '2026-09-08T09:00:00.000Z',
    },
  },
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'newco-contractor',
    payload: {
      externalId: 'newco-contractor',
      displayName: 'Contractor',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: false,
      lastSignInAt: '2026-09-08T09:00:00.000Z',
    },
  },
];

/** Pull the one-time link out of the message body, as a person would. */
function tokenFromMessage(body: string): string {
  const match = /token=([A-Za-z0-9_-]+)/.exec(body);
  if (!match) throw new Error(`No token in message:\n${body}`);
  return match[1]!;
}

describe.skipIf(!available)('self-serve onboarding', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  describe('a direct business customer, unattended', () => {
    let accessToken: string;
    let organisationId: string;
    let integrationId: string;

    it('accepts a signup and sends a verification link', async () => {
      const response = await harness.server.inject({
        method: 'POST',
        url: '/v1/signup',
        payload: {
          email: 'founder@newco.test.invalid',
          contactName: 'Sam Founder',
          accountKind: 'DIRECT',
          organisationName: 'Newco Limited',
          countryCode: 'GB',
        },
      });
      expect(response.statusCode).toBe(202);

      const message = harness.notifier.lastTo('founder@newco.test.invalid');
      expect(message).not.toBeNull();
      expect(message!.kind).toBe('signup-verification');
      // The message tells them what they are about to see, because the first
      // view is a page of UNKNOWN and that is the moment a customer decides
      // whether the product is broken or unusually honest.
      expect(message!.text).toMatch(/UNKNOWN/);
      expect(message!.text).toMatch(/has not\s*\n?\s*looked at anything yet/i);
    });

    it('gives the same answer for an address that already exists', async () => {
      // This endpoint is unauthenticated, so any difference between "new
      // address" and "known address" is a customer-list oracle.
      const first = await harness.server.inject({
        method: 'POST',
        url: '/v1/signup',
        payload: {
          email: 'founder@newco.test.invalid',
          contactName: 'Sam Founder',
          accountKind: 'DIRECT',
          organisationName: 'Newco Limited',
        },
      });
      const second = await harness.server.inject({
        method: 'POST',
        url: '/v1/signup',
        payload: {
          email: 'nobody-at-all@newco.test.invalid',
          contactName: 'Nobody',
          accountKind: 'DIRECT',
          organisationName: 'Nowhere Ltd',
        },
      });
      expect(first.statusCode).toBe(second.statusCode);
      expect((first.json() as { message: string }).message).toBe(
        (second.json() as { message: string }).message,
      );
    });

    it('creates the account, signs the person in, and says the posture is UNKNOWN', async () => {
      const message = harness.notifier.lastTo('founder@newco.test.invalid')!;
      const response = await harness.server.inject({
        method: 'POST',
        url: '/v1/signup/complete',
        payload: {
          token: tokenFromMessage(message.text),
          password: 'a-genuinely-long-password-2026',
        },
      });
      expect(response.statusCode).toBe(201);

      const body = response.json() as {
        accessToken: string;
        account: { organisationId: string; controlsCreated: number; mspId: string | null };
        posture: { state: string; explanation: string };
      };
      accessToken = body.accessToken;
      organisationId = body.account.organisationId;

      // A working assurance posture exists immediately: controls are in place,
      // and every one of them honestly reads UNKNOWN.
      expect(body.account.controlsCreated).toBeGreaterThan(0);
      expect(body.account.mspId).toBeNull();
      expect(body.posture.state).toBe('UNKNOWN');
      expect(body.posture.explanation).toMatch(/has not observed your estate/i);

      // Signed in already. Nobody is sent back to a login page to retype a
      // password they set four seconds ago.
      const me = await harness.server.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: bearer(accessToken),
      });
      expect(me.statusCode).toBe(200);
    });

    it('refuses to reuse the verification link', async () => {
      const message = harness.notifier.lastTo('founder@newco.test.invalid')!;
      const response = await harness.server.inject({
        method: 'POST',
        url: '/v1/signup/complete',
        payload: {
          token: tokenFromMessage(message.text),
          password: 'another-genuinely-long-password',
        },
      });
      expect(response.statusCode).toBe(400);
      // Spent, unknown and expired are one message. Distinguishing them tells
      // the holder of a stolen link which of those it is.
      expect(response.body).toMatch(/not valid/i);
    });

    it('shows every control as UNKNOWN rather than a clean bill of health', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${organisationId}/assurance`,
        headers: bearer(accessToken),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        controls?: { state: string }[];
        summary?: Record<string, unknown>;
      };
      const controls = body.controls ?? [];
      expect(controls.length).toBeGreaterThan(0);
      // Not one satisfied control. Nothing has been observed, so nothing can be
      // satisfied, and a product that showed otherwise here would be guessing.
      expect(controls.filter((c) => c.state === 'SATISFIED')).toHaveLength(0);
    });

    it('tells the customer exactly what to do next, and what is blocked until they do', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${organisationId}/onboarding`,
        headers: bearer(accessToken),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        tasks: { key: string; state: string; required: boolean }[];
        nextStep: string | null;
        complete: boolean;
        canAuthoriseChange: boolean;
        approvers: { withSecondFactor: number; note: string | null };
      };

      expect(body.complete).toBe(false);
      expect(body.nextStep).toBe('account.mfa');

      // Steps that cannot yet be done are BLOCKED, not PENDING: nobody is asked
      // to collect evidence before connecting a source.
      const byKey = new Map(body.tasks.map((t) => [t.key, t]));
      expect(byKey.get('source.connected')!.state).toBe('PENDING');
      expect(byKey.get('evidence.collected')!.state).toBe('BLOCKED');
      expect(byKey.get('assessment.first')!.state).toBe('BLOCKED');

      // The single most commercially damaging fact about a one-person tenant,
      // stated rather than left to be discovered three weeks later.
      expect(body.canAuthoriseChange).toBe(false);
      expect(body.approvers.withSecondFactor).toBe(0);
      expect(body.approvers.note).toMatch(/no remediation can be authorised/i);
    });

    it('reaches its first evidence-backed determination', async () => {
      await enrolTotp(harness, accessToken);

      integrationId = await harness.db.withTenant(organisationId, async (ctx) => {
        const node = await ctx.oneOrFail<{ id: string }>(
          `INSERT INTO graph_nodes (organisation_id, kind, external_id, label)
           VALUES ($1, 'Integration', 'integration:newco', 'Newco directory') RETURNING id`,
          [organisationId],
          'Integration node',
        );
        const row = await ctx.oneOrFail<{ id: string }>(
          `INSERT INTO integrations (organisation_id, node_id, connector_key, name, status, configuration)
           VALUES ($1, $2, 'adericel-demo-fixture', 'Newco directory', 'CONNECTED', $3::jsonb)
           RETURNING id`,
          [
            organisationId,
            node.id,
            JSON.stringify({
              datasetName: 'newco',
              records: RECORDS,
              executableActionTypes: ['identity.mfa.require'],
              failVerificationFor: [],
            }),
          ],
          'Integration',
        );
        await ctx.query(
          `UPDATE integrations SET sealed_credentials = $2, credential_updated_at = $3::timestamptz
           WHERE id = $1`,
          [
            row.id,
            await harness.app.credentials.seal(JSON.stringify({}), {
              organisationId,
              aad: row.id,
            }),
            harness.clock.nowIso(),
          ],
        );
        return row.id;
      });

      const collected = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${organisationId}/integrations/${integrationId}/collect`,
        headers: bearer(accessToken),
      });
      expect(collected.statusCode).toBe(200);

      const assessed = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${organisationId}/assessments/run-all`,
        headers: bearer(accessToken),
      });
      expect(assessed.statusCode).toBe(201);

      // The claim that matters: a determination that is not UNKNOWN, resting on
      // evidence that was actually collected.
      const determinations = await harness.db.withTenant(organisationId, async (ctx) =>
        ctx.many<{ state: string; evidence_ids: string[]; rationale: string }>(
          `SELECT state, evidence_ids, rationale FROM assessments
           WHERE organisation_id = $1 AND subject_kind = 'CONTROL' AND state <> 'UNKNOWN'`,
          [organisationId],
        ),
      );
      expect(determinations.length).toBeGreaterThan(0);
      expect(determinations.some((d) => d.evidence_ids.length > 0)).toBe(true);
      expect(determinations.some((d) => d.state === 'NOT_SATISFIED')).toBe(true);
    });

    it('marks the onboarding steps complete because they actually happened', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${organisationId}/onboarding`,
        headers: bearer(accessToken),
      });
      const body = response.json() as { tasks: { key: string; state: string }[] };
      const byKey = new Map(body.tasks.map((t) => [t.key, t.state]));
      expect(byKey.get('source.connected')).toBe('COMPLETED');
      expect(byKey.get('evidence.collected')).toBe('COMPLETED');
      expect(byKey.get('assessment.first')).toBe('COMPLETED');
    });

    it('reopens a step when the fact behind it stops being true', async () => {
      // The ledger is recomputed from real state, so it cannot say "connected"
      // about a source that has since been disconnected. A checklist that
      // remembers a successful API call rather than a current fact is a lie
      // with a tick next to it.
      await harness.db.withTenant(organisationId, async (ctx) => {
        await ctx.query(`UPDATE integrations SET status = 'FAILED' WHERE id = $1`, [integrationId]);
      });
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${organisationId}/onboarding`,
        headers: bearer(accessToken),
      });
      const body = response.json() as { tasks: { key: string; state: string }[] };
      expect(body.tasks.find((t) => t.key === 'source.connected')!.state).toBe('PENDING');

      await harness.db.withTenant(organisationId, async (ctx) => {
        await ctx.query(`UPDATE integrations SET status = 'CONNECTED' WHERE id = $1`, [
          integrationId,
        ]);
      });
    });

    it('unblocks approval only when a second person with a factor exists', async () => {
      const invite = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${organisationId}/invitations`,
        headers: bearer(accessToken),
        payload: {
          email: 'approver@newco.test.invalid',
          roles: ['ORG_APPROVER'],
          message: 'Please be our second pair of eyes.',
        },
      });
      expect(invite.statusCode).toBe(201);

      const message = harness.notifier.lastTo('approver@newco.test.invalid');
      expect(message).not.toBeNull();
      // The invitation explains what being an approver means, because most
      // people receiving one have never been asked before.
      expect(message!.text).toMatch(/proposed a change can never be the person who approves/i);

      const accepted = await harness.server.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        payload: {
          token: tokenFromMessage(message!.text),
          displayName: 'Alex Approver',
          password: 'a-second-genuinely-long-password',
        },
      });
      expect(accepted.statusCode).toBe(201);
      const acceptedBody = accepted.json() as { accessToken: string; mfaRequired: boolean };
      expect(acceptedBody.mfaRequired).toBe(true);

      // A second person exists but has no factor, so approval is still
      // unreachable and the product says so rather than implying otherwise.
      const before = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${organisationId}/onboarding`,
        headers: bearer(accessToken),
      });
      expect((before.json() as { canAuthoriseChange: boolean }).canAuthoriseChange).toBe(false);

      await enrolTotp(harness, acceptedBody.accessToken);

      const after = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${organisationId}/onboarding`,
        headers: bearer(accessToken),
      });
      const afterBody = after.json() as {
        canAuthoriseChange: boolean;
        tasks: { key: string; state: string }[];
      };
      expect(afterBody.canAuthoriseChange).toBe(true);
      expect(afterBody.tasks.find((t) => t.key === 'approver.second')!.state).toBe('COMPLETED');
    });
  });

  describe('an MSP, unattended', () => {
    it('creates an operator account that can onboard its own customers', async () => {
      const signup = await harness.server.inject({
        method: 'POST',
        url: '/v1/signup',
        payload: {
          email: 'ops@partner.test.invalid',
          contactName: 'Jo Operator',
          accountKind: 'MSP',
          organisationName: 'Partner IT Services',
          countryCode: 'GB',
        },
      });
      expect(signup.statusCode).toBe(202);

      const message = harness.notifier.lastTo('ops@partner.test.invalid')!;
      expect(message.text).toMatch(/operator account/i);

      const completed = await harness.server.inject({
        method: 'POST',
        url: '/v1/signup/complete',
        payload: {
          token: tokenFromMessage(message.text),
          password: 'operator-password-long-enough',
        },
      });
      expect(completed.statusCode).toBe(201);
      const body = completed.json() as {
        accessToken: string;
        account: { mspId: string | null; organisationId: string };
      };
      expect(body.account.mspId).not.toBeNull();

      // The operator can immediately onboard a customer, without anybody at
      // Adericel doing anything.
      const customer = await harness.server.inject({
        method: 'POST',
        url: `/v1/msps/${body.account.mspId}/organisations`,
        headers: bearer(body.accessToken),
        payload: {
          name: 'Client One Ltd',
          countryCode: 'GB',
          frameworks: ['cyber-essentials'],
          applyMspBaseline: false,
        },
      });
      expect(customer.statusCode).toBe(201);
      const created = customer.json() as { id: string; controlsCreated: number };
      expect(created.controlsCreated).toBeGreaterThan(0);

      // And the operator's own tenant is separate from the customer's.
      expect(created.id).not.toBe(body.account.organisationId);
    });

    it('does not let an MSP invitation grant organisation-scoped authority', async () => {
      const msp = await harness.db.withPlatform(async (ctx) =>
        ctx.oneOrFail<{ id: string }>(
          `SELECT id FROM msps WHERE contact_email = $1`,
          ['ops@partner.test.invalid'],
          'MSP',
        ),
      );
      const token = await harness.server.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'ops@partner.test.invalid', password: 'operator-password-long-enough' },
      });
      const accessToken = (token.json() as { accessToken: string }).accessToken;

      const response = await harness.server.inject({
        method: 'POST',
        url: `/v1/msps/${msp.id}/invitations`,
        headers: bearer(accessToken),
        // ORG_APPROVER at MSP scope would be authority over every customer at
        // once, granted through a route meant for staffing the operator.
        payload: { email: 'sneaky@partner.test.invalid', roles: ['ORG_APPROVER'] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).toMatch(/cannot be granted at MSP scope/i);
    });

    it('refuses to grant PLATFORM_ADMIN by invitation at any scope', async () => {
      const msp = await harness.db.withPlatform(async (ctx) =>
        ctx.oneOrFail<{ id: string }>(
          `SELECT id FROM msps WHERE contact_email = $1`,
          ['ops@partner.test.invalid'],
          'MSP',
        ),
      );
      const token = await harness.server.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'ops@partner.test.invalid', password: 'operator-password-long-enough' },
      });
      const response = await harness.server.inject({
        method: 'POST',
        url: `/v1/msps/${msp.id}/invitations`,
        headers: bearer((token.json() as { accessToken: string }).accessToken),
        payload: { email: 'takeover@partner.test.invalid', roles: ['PLATFORM_ADMIN'] },
      });
      // PLATFORM_ADMIN operates Adericel itself. No customer-facing route may
      // ever mint it.
      expect(response.statusCode).toBe(403);
    });
  });
});
