import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentHash } from '@adericel/shared';
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
 * The Assurance Passport.
 *
 * This is the artefact the whole machine exists to produce: a statement an
 * organisation can hand to an insurer, a client or an auditor, which that third
 * party can rely on without holding an Adericel account and without trusting
 * whoever sent it to them.
 *
 * Two properties are load-bearing and are what these tests defend.
 *
 *   It carries UNKNOWN. A passport that could only say "compliant" would be the
 *   artefact this company exists to replace, and the temptation to quietly drop
 *   undetermined controls from an outward-facing document is enormous.
 *
 *   It is verifiable. The content hash lets a recipient confirm the record is
 *   the one Adericel issued and has not been edited since — including by the
 *   organisation it describes.
 */

const available = await databaseAvailable();

const RECORDS = [
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'pp-good',
    payload: {
      externalId: 'pp-good',
      displayName: 'Compliant Person',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: true,
      lastSignInAt: '2026-09-08T09:00:00.000Z',
    },
  },
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'pp-bad',
    payload: {
      externalId: 'pp-bad',
      displayName: 'Person Without MFA',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: false,
      lastSignInAt: '2026-09-08T09:00:00.000Z',
    },
  },
];

interface PassportBody {
  id: string;
  sequence: number;
  contentHash: string;
  state: string;
  content: {
    schema: string;
    state: string;
    summary: {
      total: number;
      satisfied: number;
      failing: number;
      unknown: number;
      coverage: { determined: number; inScope: number };
    };
    controls: {
      key: string;
      state: string;
      unknownReason: string | null;
      rationale: string | null;
      evidenceAgeDays: number | null;
    }[];
    findings: { severity: string; title: string | null; control: string }[];
    maintenance: { maintained: boolean; stoppedAt: string | null; observedUntil: string | null };
    remediation: { actionType: string; verified: boolean }[];
    evidence: { total: number; stale: number };
    interpretation: string;
    disclosure: string;
  };
}

describe.skipIf(!available)('assurance passport', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let token: string;
  let firstPassport: PassportBody;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, {
      slug: 'passport-corp',
      records: RECORDS,
      frameworks: ['cyber-essentials'],
    });
    token = await signIn(harness, 'analyst-passport-corp@test.invalid');
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  const issue = async (): Promise<PassportBody> => {
    // Time moves between issues, as it does in production. The instant is part
    // of the content, so this is also what keeps two passports of an unchanged
    // estate distinct rather than sharing a hash.
    harness.clock.advance(60_000);
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/passports`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(201);
    return response.json() as PassportBody;
  };

  it('issues a passport before anything has been observed, and says so plainly', async () => {
    firstPassport = await issue();

    // Every control undetermined, and the passport reports that as its
    // headline rather than as an omission.
    expect(firstPassport.state).toBe('UNKNOWN');
    expect(firstPassport.content.summary.unknown).toBe(firstPassport.content.summary.total);
    expect(firstPassport.content.summary.total).toBeGreaterThan(0);
    expect(firstPassport.content.summary.coverage.determined).toBe(0);

    // Controls never assessed appear, rather than being silently absent. A
    // passport listing only the controls that happen to have a state row would
    // flatter the organisation by omission.
    expect(firstPassport.content.controls.length).toBe(firstPassport.content.summary.total);
    for (const control of firstPassport.content.controls) {
      expect(control.state).toBe('UNKNOWN');
      expect(control.unknownReason).not.toBeNull();
      expect(control.rationale).toMatch(/has not been assessed|Adericel/i);
    }

    // And it tells the reader how to read it, in the document.
    expect(firstPassport.content.interpretation).toMatch(/UNKNOWN is not a pass/i);
    // A paying customer's record is maintained, and the passport says so where
    // a third party will see it.
    expect(firstPassport.content.maintenance.maintained).toBe(true);
  });

  it('hashes its content, and the hash is reproducible from the content alone', async () => {
    // This is what makes a passport verifiable by somebody who was emailed it:
    // the hash is over the record, not over a database row id.
    expect(firstPassport.contentHash).toMatch(/^sha256:/);
    expect(contentHash(firstPassport.content)).toBe(firstPassport.contentHash);
  });

  it('reflects real determinations once evidence exists', async () => {
    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}/collect`,
      headers: bearer(token),
    });
    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/assessments/run-all`,
      headers: bearer(token),
    });

    const second = await issue();
    expect(second.sequence).toBe(firstPassport.sequence + 1);
    expect(second.contentHash).not.toBe(firstPassport.contentHash);

    // Determinations now exist, and so does at least one failure — the estate
    // has an account without MFA and the passport says so.
    expect(second.content.summary.coverage.determined).toBeGreaterThan(0);
    expect(second.content.summary.failing).toBeGreaterThan(0);
    expect(second.content.findings.length).toBeGreaterThan(0);
    expect(second.content.evidence.total).toBeGreaterThan(0);

    // Evidence age is carried per control, because a satisfied control resting
    // on a year-old observation is not the same claim as one resting on
    // yesterday's, and a reader cannot tell them apart without the number.
    const determined = second.content.controls.filter((c) => c.state !== 'UNKNOWN');
    expect(determined.some((c) => c.evidenceAgeDays !== null)).toBe(true);
  });

  it('never reports every control satisfied while any remains undetermined', async () => {
    const passport = await issue();
    const undetermined = passport.content.controls.filter((c) => c.state === 'UNKNOWN').length;
    if (undetermined > 0) {
      // The single claim a passport must never make.
      expect(passport.content.state).not.toBe('SATISFIED');
      expect(passport.content.interpretation).toMatch(/UNKNOWN is not a pass/i);
    }
    expect(passport.content.summary.unknown).toBe(undetermined);
  });

  it('is frozen: the record does not change when the estate does', async () => {
    const before = await issue();

    // The customer fixes the problem. The passport already issued describes an
    // instant, and must not silently become a different document — the
    // recipient and the issuer would otherwise be looking at different things
    // while both believing they agreed.
    harness.fixtureState.apply(tenant.integrationId, 'pp-bad', { mfaEnforced: true });
    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}/collect`,
      headers: bearer(token),
    });
    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/assessments/run-all`,
      headers: bearer(token),
    });

    const reread = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/passports/${before.id}`,
      headers: bearer(token),
    });
    const body = reread.json() as { contentHash: string; content: PassportBody['content'] };
    expect(body.contentHash).toBe(before.contentHash);
    expect(body.content.summary.failing).toBe(before.content.summary.failing);

    // A current passport shows the improvement. Both are true; they describe
    // different instants, and each says which.
    const after = await issue();
    expect(after.content.summary.failing).toBeLessThan(before.content.summary.failing);
  });

  describe('sharing with a third party who has no account', () => {
    let shareUrl: string;
    let shareToken: string;
    let sharedPassport: PassportBody;

    it('shares a passport with a named audience for a bounded time', async () => {
      sharedPassport = await issue();
      const response = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/passports/${sharedPassport.id}/shares`,
        headers: bearer(token),
        payload: { audience: 'Northgate Insurance', disclosure: 'REDACTED', expiresInDays: 30 },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json() as { url: string; audience: string };
      expect(body.audience).toBe('Northgate Insurance');
      shareUrl = body.url;
      shareToken = shareUrl.split('/').pop()!;
      expect(shareToken.length).toBeGreaterThan(20);
    });

    it('lets an unauthenticated recipient read it', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/assurance/${shareToken}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        organisation: string;
        contentHash: string;
        passport: PassportBody['content'];
        verification: { endpoint: string };
      };
      // The recipient is told whose assurance record this is, by name.
      expect(body.organisation).toMatch(/passport-corp/i);
      expect(body.contentHash).toBe(sharedPassport.contentHash);
      // Undetermined controls survive the trip outward. This is the whole
      // point: the honest number is the one the third party sees.
      expect(body.passport.summary.unknown).toBe(sharedPassport.content.summary.unknown);
      expect(body.verification.endpoint).toMatch(/assurance\/verify$/);
    });

    it('redacts what a third party has not earned', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/assurance/${shareToken}`,
      });
      const body = response.json() as { passport: PassportBody['content'] };
      expect(body.passport.disclosure).toBe('REDACTED');
      // The shape of the problem, not a map of where to attack: finding
      // counts, severities and the control they belong to, without the subject
      // names that would identify the vulnerable accounts.
      for (const finding of body.passport.findings) {
        expect(finding.title).toBeNull();
        expect(finding.severity).toBeTruthy();
        expect(finding.control).toBeTruthy();
      }
    });

    it('lets anyone verify a passport they were sent, without an account', async () => {
      const genuine = await harness.server.inject({
        method: 'POST',
        url: '/v1/assurance/verify',
        payload: { contentHash: sharedPassport.contentHash },
      });
      expect(genuine.statusCode, genuine.body).toBe(200);
      expect((genuine.json() as { recognised: boolean }).recognised).toBe(true);

      // An edited document. The organisation improves its own numbers before
      // forwarding the file; the hash no longer matches anything Adericel
      // issued, and the recipient can tell.
      const tampered = {
        ...sharedPassport.content,
        summary: { ...sharedPassport.content.summary, unknown: 0, satisfied: 99 },
      };
      const forged = await harness.server.inject({
        method: 'POST',
        url: '/v1/assurance/verify',
        payload: { contentHash: contentHash(tampered) },
      });
      const forgedBody = forged.json() as { recognised: boolean; detail: string };
      expect(forgedBody.recognised).toBe(false);
      expect(forgedBody.detail).toMatch(/altered|did not come from Adericel/i);
    });

    it('treats a hash as identifying content, not one row', async () => {
      // Two issues of a genuinely identical record carry the same hash — that
      // is what content addressing means. Verification must answer about the
      // content, and a passport stands while any issue of it remains live.
      const at = harness.clock.nowIso();
      // Two passports of this test's own, so nothing else in the suite is
      // disturbed by forcing the collision.
      const a = (await issue()).id;
      const b = (await issue()).id;
      await harness.db.withTenant(tenant.organisationId, async (ctx) => {
        await ctx.query(
          `UPDATE assurance_passports SET content_hash = 'sha256:collision-fixture'
           WHERE id = ANY($1::uuid[])`,
          [[a, b]],
        );
      });

      const both = await harness.server.inject({
        method: 'POST',
        url: '/v1/assurance/verify',
        payload: { contentHash: 'sha256:collision-fixture' },
      });
      expect(both.statusCode).toBe(200);
      expect((both.json() as { recognised: boolean; withdrawn: boolean }).withdrawn).toBe(false);

      // Withdraw one. The content is still vouched for by the other.
      await harness.db.withTenant(tenant.organisationId, async (ctx) => {
        await ctx.query(
          `UPDATE assurance_passports SET withdrawn_at = $2::timestamptz WHERE id = $1`,
          [a, at],
        );
      });
      const partial = await harness.server.inject({
        method: 'POST',
        url: '/v1/assurance/verify',
        payload: { contentHash: 'sha256:collision-fixture' },
      });
      expect((partial.json() as { withdrawn: boolean }).withdrawn).toBe(false);

      // Withdraw the last live one and the content is no longer vouched for.
      await harness.db.withTenant(tenant.organisationId, async (ctx) => {
        await ctx.query(
          `UPDATE assurance_passports SET withdrawn_at = $2::timestamptz WHERE id = $1`,
          [b, at],
        );
      });
      const none = await harness.server.inject({
        method: 'POST',
        url: '/v1/assurance/verify',
        payload: { contentHash: 'sha256:collision-fixture' },
      });
      const body = none.json() as { withdrawn: boolean; detail: string };
      expect(body.withdrawn).toBe(true);
      expect(body.detail).toMatch(/Do not rely on it/i);
    });

    it('reveals nothing about the organisation through the verify endpoint', async () => {
      const response = await harness.server.inject({
        method: 'POST',
        url: '/v1/assurance/verify',
        payload: { contentHash: sharedPassport.contentHash },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      expect(body.recognised).toBe(true);
      // It answers about a hash and nothing else, so it cannot be used to
      // enumerate customers or read a record the caller was never given.
      expect(JSON.stringify(body)).not.toContain('passport-corp');
      expect(body.passport).toBeUndefined();
      expect(body.organisation).toBeUndefined();
    });

    it('records who looked and when, for the organisation that shared it', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${tenant.organisationId}/passport-shares`,
        headers: bearer(token),
      });
      const body = response.json() as {
        shares: { audience: string; viewCount: number; live: boolean }[];
      };
      const share = body.shares.find((s) => s.audience === 'Northgate Insurance')!;
      expect(share.viewCount).toBeGreaterThan(0);
      expect(share.live).toBe(true);
    });

    it('stops working the moment the organisation revokes it', async () => {
      const shares = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${tenant.organisationId}/passport-shares`,
        headers: bearer(token),
      });
      const shareId = (shares.json() as { shares: { id: string; audience: string }[] }).shares.find(
        (s) => s.audience === 'Northgate Insurance',
      )!.id;

      const revoked = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/passport-shares/${shareId}/revoke`,
        headers: bearer(token),
      });
      expect(revoked.statusCode).toBe(200);

      const after = await harness.server.inject({
        method: 'GET',
        url: `/v1/assurance/${shareToken}`,
      });
      expect(after.statusCode).toBe(404);
      // Revoked, expired and never-existed are one message: a holder of a link
      // they should not have learns nothing from which it is.
      expect(after.body).toMatch(/not available/i);
    });

    it('refuses an expired link', async () => {
      const fresh = await issue();
      const share = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/passports/${fresh.id}/shares`,
        headers: bearer(token),
        payload: { audience: 'Client Procurement', expiresInDays: 1 },
      });
      const url = (share.json() as { url: string }).url;
      const freshToken = url.split('/').pop()!;

      await harness.db.withTenant(tenant.organisationId, async (ctx) => {
        await ctx.query(
          `UPDATE passport_shares SET expires_at = $2::timestamptz - interval '1 day'
           WHERE organisation_id = $1 AND audience = 'Client Procurement'`,
          [tenant.organisationId, harness.clock.nowIso()],
        );
      });

      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/assurance/${freshToken}`,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('withdrawal', () => {
    it('tells a recipient a passport was withdrawn rather than that it never existed', async () => {
      const passport = await issue();
      const share = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/passports/${passport.id}/shares`,
        headers: bearer(token),
        payload: { audience: 'Auditor', disclosure: 'FULL', expiresInDays: 90 },
      });
      const shareToken = (share.json() as { url: string }).url.split('/').pop()!;

      const withdrawn = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/passports/${passport.id}/withdraw`,
        headers: bearer(token),
        payload: { reason: 'A control was assessed against the wrong scope.' },
      });
      expect(withdrawn.statusCode).toBe(200);

      // Still readable, and marked. Telling a recipient it never existed is
      // indistinguishable from an organisation quietly disowning a statement.
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/assurance/${shareToken}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { withdrawn: { reason: string } | null };
      expect(body.withdrawn).not.toBeNull();
      expect(body.withdrawn!.reason).toMatch(/wrong scope/);

      // And verification says so too, for a recipient holding only the file.
      const verify = await harness.server.inject({
        method: 'POST',
        url: '/v1/assurance/verify',
        payload: { contentHash: passport.contentHash },
      });
      const verifyBody = verify.json() as {
        recognised: boolean;
        withdrawn: boolean;
        detail: string;
      };
      expect(verifyBody.recognised).toBe(true);
      expect(verifyBody.withdrawn).toBe(true);
      expect(verifyBody.detail).toMatch(/Do not rely on it/i);
    });

    it('refuses to share a withdrawn passport', async () => {
      const passport = await issue();
      await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/passports/${passport.id}/withdraw`,
        headers: bearer(token),
        payload: { reason: 'Superseded.' },
      });
      const response = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/passports/${passport.id}/shares`,
        headers: bearer(token),
        payload: { audience: 'Someone', expiresInDays: 30 },
      });
      expect(response.statusCode).toBe(412);
    });
  });

  it('does not expose one tenant’s passport to another', async () => {
    const other = await seedTenant(harness, { slug: 'passport-other', records: RECORDS });
    const otherToken = await signIn(harness, 'analyst-passport-other@test.invalid');

    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${other.organisationId}/passports/${firstPassport.id}`,
      headers: bearer(otherToken),
    });
    expect(response.statusCode).toBe(404);

    const crossPath = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/passports/${firstPassport.id}`,
      headers: bearer(otherToken),
    });
    expect([403, 404]).toContain(crossPath.statusCode);
  });
});
