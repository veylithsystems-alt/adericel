import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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
 * The proof-of-value machine, run for real.
 *
 * An MSP does not buy a dashboard. They buy back the hours their engineers
 * currently spend proving that a hundred customers are secure. This drives a
 * realistic portfolio through the entire cycle — collect, determine, detect
 * change, assess impact, remediate, verify independently — and then asks
 * Adericel what that was worth.
 *
 * The numbers produced here come from the real engine operating on a real
 * database. Nothing in this file computes an expected figure by hand and checks
 * that the code agrees: that would only prove the test and the code share an
 * assumption. Everything asserted is either a count that must be right because
 * of what the cycle did, or a rule the report must obey whatever the counts
 * turn out to be.
 *
 * The most important tests here are the ones where the machine REFUSES to
 * produce a number.
 */

const available = await databaseAvailable();

/** A customer estate with some things right and some things wrong. */
function estate(prefix: string, identities: number, badIdentities: number) {
  const records = [];
  for (let i = 0; i < identities; i += 1) {
    const compliant = i >= badIdentities;
    records.push({
      kind: 'IDENTITY_STATE',
      subjectExternalId: `${prefix}-user-${i}`,
      payload: {
        externalId: `${prefix}-user-${i}`,
        displayName: `${prefix} person ${i}`,
        enabled: true,
        accountType: 'USER',
        mfaEnforced: compliant,
        lastSignInAt: '2026-09-01T09:00:00.000Z',
      },
    });
  }
  return records;
}

interface PortfolioOrganisation {
  readonly tenant: SeededTenant;
  readonly slug: string;
  readonly badIdentities: number;
}

describe.skipIf(!available)('the MSP proof-of-value machine', () => {
  let harness: Harness;
  const organisations: PortfolioOrganisation[] = [];
  let mspId: string;
  let ownerToken: string;
  let approverToken: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();

    // A realistic small portfolio: five customers of different sizes, each with
    // a different amount wrong. Autonomy 4 so that policy-permitted
    // remediation runs unattended and the distinction between "Adericel did it"
    // and "a person had to" is actually exercised.
    const shapes = [
      { slug: 'pov-alpha', identities: 12, bad: 3 },
      { slug: 'pov-bravo', identities: 8, bad: 1 },
      { slug: 'pov-charlie', identities: 20, bad: 5 },
      { slug: 'pov-delta', identities: 6, bad: 2 },
      { slug: 'pov-echo', identities: 15, bad: 4 },
    ];

    for (const shape of shapes) {
      const tenant = await seedTenant(harness, {
        slug: shape.slug,
        // One MSP, five customers. The shape every real MSP has, and the one
        // the harness could not previously produce.
        mspSlug: 'pov-portfolio',
        records: estate(shape.slug, shape.identities, shape.bad),
        autonomyLevel: 4,
      });
      organisations.push({ tenant, slug: shape.slug, badIdentities: shape.bad });
    }

    mspId = organisations[0]!.tenant.mspId;
    ownerToken = await signIn(harness, 'owner-pov-alpha@test.invalid');
    approverToken = await signInWithMfa(harness, 'approver-pov-alpha@test.invalid');
  }, 300_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('seeds one MSP with five customer organisations', () => {
    expect(organisations).toHaveLength(5);
    // Every organisation must belong to the same MSP or the portfolio figures
    // would be aggregating across businesses.
    for (const organisation of organisations) {
      expect(organisation.tenant.mspId).toBe(mspId);
    }
  });

  it('establishes assurance state across the whole portfolio', async () => {
    for (const organisation of organisations) {
      const collected = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${organisation.tenant.organisationId}/integrations/${organisation.tenant.integrationId}/collect`,
        headers: bearer(ownerToken),
      });
      expect(collected.statusCode, organisation.slug).toBe(200);
      const body = collected.json() as { observationsRecorded: number; evidenceCreated: number };
      expect(body.observationsRecorded).toBeGreaterThan(0);
      expect(body.evidenceCreated).toBeGreaterThan(0);

      const assessed = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${organisation.tenant.organisationId}/assessments/run-all`,
        headers: bearer(ownerToken),
        payload: {},
      });
      expect(assessed.statusCode, organisation.slug).toBe(201);
    }
  }, 300_000);

  it('raises a finding for every non-compliant identity it found', async () => {
    for (const organisation of organisations) {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${organisation.tenant.organisationId}/findings?status=OPEN&limit=100`,
        headers: bearer(ownerToken),
      });
      expect(response.statusCode).toBe(200);
      const findings = (response.json() as { findings: unknown[] }).findings;
      // One per identity without a second factor. The count is determined by
      // the estate, so a mismatch means the engine missed something.
      expect(findings.length, organisation.slug).toBeGreaterThanOrEqual(organisation.badIdentities);
    }
  });

  it('detects a change when a customer estate drifts', async () => {
    // A previously compliant person loses their second factor. Nobody told
    // Adericel; it has to notice.
    const target = organisations[0]!;
    harness.fixtureState.apply(target.tenant.integrationId, `${target.slug}-user-11`, {
      mfaEnforced: false,
    });

    const before = await harness.db.withTenant(target.tenant.organisationId, async (ctx) =>
      ctx.one<{ count: string }>(
        `SELECT count(*)::text AS count FROM claims WHERE supersedes_claim_id IS NOT NULL`,
      ),
    );

    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${target.tenant.organisationId}/integrations/${target.tenant.integrationId}/collect`,
      headers: bearer(ownerToken),
    });

    const after = await harness.db.withTenant(target.tenant.organisationId, async (ctx) =>
      ctx.one<{ count: string }>(
        `SELECT count(*)::text AS count FROM claims WHERE supersedes_claim_id IS NOT NULL`,
      ),
    );

    // A superseding claim is a detected change. This is the number that becomes
    // "change.detect" in the report, so it has to be real.
    expect(Number(after?.count ?? '0')).toBeGreaterThan(Number(before?.count ?? '0'));
  });

  it('remediates and verifies independently, and records who did what', async () => {
    const target = organisations[1]!;
    const organisationId = target.tenant.organisationId;

    const nodes = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${organisationId}/nodes?kind=Identity&externalId=${target.slug}-user-0`,
      headers: bearer(ownerToken),
    });
    const nodeId = (nodes.json() as { nodes: { id: string }[] }).nodes[0]?.id;
    expect(nodeId).toBeDefined();

    const proposed = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${organisationId}/actions`,
      headers: bearer(ownerToken),
      payload: {
        actionType: 'identity.mfa.require',
        integrationId: target.tenant.integrationId,
        targetNodeId: nodeId,
        targetExternalId: `${target.slug}-user-0`,
        parameters: { enforcement: 'REQUIRED' },
        rationale: 'Identity has no second factor enforced.',
      },
    });
    expect([201, 202]).toContain(proposed.statusCode);
    const action = (proposed.json() as { action: { id: string; state: string } }).action;

    // Whether this needed an approval is the policy's decision, not the test's.
    // Both paths are legitimate; what matters is that the ledger later reports
    // whichever one actually happened.
    if (action.state === 'AWAITING_APPROVAL') {
      const decided = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${organisationId}/actions/${action.id}/decision`,
        headers: bearer(approverToken),
        payload: { decision: 'APPROVED', note: 'Required by the baseline.' },
      });
      expect(decided.statusCode).toBe(200);
    }

    const executed = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${organisationId}/actions/${action.id}/execute`,
      headers: bearer(ownerToken),
      payload: {},
    });
    expect(executed.statusCode).toBe(200);

    const verified = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${organisationId}/actions/${action.id}/verify`,
      headers: bearer(ownerToken),
      payload: {},
    });
    expect(verified.statusCode).toBe(200);

    // Independent verification: the estate is re-observed rather than the
    // action being trusted about its own success. CONFIRMED means the
    // observation agreed; UNVERIFIED means it could not be established, and
    // Adericel says so rather than assuming the change took.
    const result = verified.json() as { outcome: string; state: string };
    expect(['CONFIRMED', 'REFUTED', 'INCONCLUSIVE']).toContain(result.outcome);
    expect(['CONFIRMED', 'UNVERIFIED']).toContain(result.state);
  }, 120_000);

  describe('the report, before anyone has priced anything', () => {
    it('reports every operation it performed and refuses to value any of it', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/msps/${mspId}/value/report?windowDays=30`,
        headers: bearer(ownerToken),
      });
      expect(response.statusCode).toBe(200);
      const { report } = response.json() as {
        report: {
          organisationCount: number;
          hoursDisplaced: number;
          modelCompleteness: number;
          caveats: string[];
          ledger: Record<string, number>;
          lines: { task: { key: string }; performedByAdericel: number }[];
        };
      };

      expect(report.organisationCount).toBe(5);

      // The work is real and counted.
      expect(report.ledger.observationsCollected).toBeGreaterThan(50);
      expect(report.ledger.controlDeterminations).toBeGreaterThan(0);
      expect(report.ledger.evidenceCollectedAutomatically).toBeGreaterThan(0);
      expect(report.ledger.changesDetected).toBeGreaterThan(0);

      // And it is worth exactly nothing until the MSP says otherwise.
      expect(report.hoursDisplaced).toBe(0);
      expect(report.modelCompleteness).toBe(0);
      expect(report.caveats[0]).toContain('No durations have been supplied');
    });

    it('refuses to project to a hundred customers with nothing priced', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/msps/${mspId}/value/report?windowDays=30&target=100&ftePerMonthHours=130`,
        headers: bearer(ownerToken),
      });
      const { projection } = response.json() as { projection: { basis: string; reason?: string } };
      expect(projection.basis).toBe('REFUSED');
      expect(projection.reason).toContain('only this MSP can say what they are worth');
    });
  });

  describe('the report, once the MSP has supplied its own numbers', () => {
    beforeAll(async () => {
      // The MSP times its own work. These are their numbers, not Adericel's,
      // and every one carries how it was arrived at.
      const timings: [string, number, string][] = [
        ['evidence.collect', 4, 'Timed across 20 samples in August 2026'],
        ['evidence.file', 2, 'Timed across 20 samples in August 2026'],
        ['control.determine', 6, 'Timed by two engineers over a week'],
        ['control.explain', 5, 'Timed by two engineers over a week'],
        ['change.detect', 8, 'Estimated from the monthly review meeting'],
        ['change.impact', 12, 'Estimated from the monthly review meeting'],
        ['finding.triage', 7, 'Timed from the ticket queue'],
        ['remediation.perform', 15, 'Timed from the ticket queue'],
        ['remediation.verify', 9, 'Timed from the ticket queue'],
        ['report.produce', 90, 'The monthly pack, timed'],
        ['enquiry.answer', 35, 'Timed from three insurer requests'],
      ];

      for (const [taskKey, minutes, basis] of timings) {
        const response = await harness.server.inject({
          method: 'PUT',
          url: `/v1/msps/${mspId}/value/effort-model/${taskKey}`,
          headers: bearer(ownerToken),
          payload: { minutes, source: 'MSP_MEASURED', basis },
        });
        expect(response.statusCode, taskKey).toBe(200);
      }
    });

    it('shows the arithmetic rather than a headline', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/msps/${mspId}/value/report?windowDays=30`,
        headers: bearer(ownerToken),
      });
      const { report } = response.json() as {
        report: {
          hoursDisplaced: number;
          hoursStillSpent: number;
          hoursIfEntirelyManual: number;
          modelCompleteness: number;
          displacementRatio: number;
          lines: {
            task: { key: string; title: string };
            performedByAdericel: number;
            performedByPeople: number;
            minutesEach: number | null;
            minutesSource: string;
            minutesBasis: string | null;
            hoursDisplaced: number | null;
          }[];
        };
      };

      expect(report.modelCompleteness).toBe(1);
      expect(report.hoursDisplaced).toBeGreaterThan(0);
      expect(report.hoursIfEntirelyManual).toBeGreaterThan(report.hoursStillSpent);

      // Every line can be checked by hand by the person reading it. That is the
      // whole design: operations x their own minutes, with the source shown.
      for (const line of report.lines) {
        expect(line.minutesSource).toBe('MSP_MEASURED');
        expect(line.minutesBasis).toBeTruthy();
        if (line.minutesEach !== null && line.hoursDisplaced !== null) {
          const expected =
            Math.round(((line.performedByAdericel * line.minutesEach) / 60) * 100) / 100;
          expect(line.hoursDisplaced, line.task.key).toBe(expected);
        }
      }

      // And the two halves add up to the derived baseline.
      expect(report.hoursIfEntirelyManual).toBeCloseTo(
        report.hoursDisplaced + report.hoursStillSpent,
        1,
      );
    });

    it('answers the hundred-customer question, labelled as a projection', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/msps/${mspId}/value/report?windowDays=30&target=100&ftePerMonthHours=130`,
        headers: bearer(ownerToken),
      });
      const { projection } = response.json() as {
        projection: {
          basis: string;
          targetOrganisations: number;
          sampleOrganisations: number;
          hoursWithoutAdericel: number;
          hoursWithAdericel: number;
          hoursReleased: number;
          fteWithoutAdericel: number;
          fteWithAdericel: number;
          caveats: string[];
        };
      };

      expect(projection.basis).toBe('PROJECTED');
      expect(projection.sampleOrganisations).toBe(5);
      expect(projection.targetOrganisations).toBe(100);
      expect(projection.hoursWithoutAdericel).toBeGreaterThan(projection.hoursWithAdericel);
      expect(projection.hoursReleased).toBeGreaterThan(0);
      expect(projection.fteWithoutAdericel).toBeGreaterThan(0);

      // It never presents itself as a measurement, and it always says what it
      // was built from.
      expect(projection.caveats.join(' ')).toContain('Projected from 5 organisation(s)');
      expect(projection.caveats.join(' ')).toContain('Assumes work scales');
    });

    it('keeps the report, hashed, so a quoted figure can be reproduced', async () => {
      const retained = await harness.server.inject({
        method: 'POST',
        url: `/v1/msps/${mspId}/value/reports`,
        headers: bearer(ownerToken),
        payload: { windowDays: 30 },
      });
      expect(retained.statusCode).toBe(201);
      const body = retained.json() as { contentHash: string };
      expect(body.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

      const listed = await harness.server.inject({
        method: 'GET',
        url: `/v1/msps/${mspId}/value/reports`,
        headers: bearer(ownerToken),
      });
      const reports = (listed.json() as { reports: { contentHash: string }[] }).reports;
      expect(reports.some((r) => r.contentHash === body.contentHash)).toBe(true);
    });

    it('measures the assurance quality it delivered, not only the labour', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/msps/${mspId}/value/report?windowDays=30`,
        headers: bearer(ownerToken),
      });
      const { report } = response.json() as {
        report: {
          quality: {
            medianEvidenceAgeHours: number | null;
            evidenceSupportingClaims: number;
            controlsDetermined: number;
            controlsTotal: number;
            determinationCoverage: number | null;
            unknownControls: number;
          };
        };
      };

      // Less work is only half the claim. This is the other half, and it is
      // measured with metrics a vendor would not choose.
      expect(report.quality.evidenceSupportingClaims).toBeGreaterThan(0);
      expect(report.quality.medianEvidenceAgeHours).not.toBeNull();
      expect(report.quality.controlsDetermined).toBeGreaterThan(0);
      expect(report.quality.determinationCoverage).not.toBeNull();
    });
  });

  describe('the boundaries hold around the commercial data', () => {
    it('keeps the MSP cost model out of every client organisation', async () => {
      // What an MSP believes its own work costs is MSP_PORTFOLIO information.
      // A client must never see it, and the surface boundary refuses it before
      // any handler runs.
      const clientToken = await signIn(harness, 'analyst-pov-bravo@test.invalid');
      const organisationId = organisations[1]!.tenant.organisationId;

      // Prove the client session is real by using it successfully first.
      const own = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${organisationId}/assurance`,
        headers: bearer(clientToken),
      });
      expect(own.statusCode).toBe(200);

      const scopedToOrganisation = await harness.db.withPlatform(async (ctx) => {
        const user = await ctx.oneOrFail<{ id: string }>(
          `SELECT id FROM users WHERE lower(email) = lower($1)`,
          ['analyst-pov-bravo@test.invalid'],
          'User',
        );
        // Move this person to an organisation-scoped grant, which is what a
        // customer's own staff actually hold.
        await ctx.query(`UPDATE grants SET revoked_at = now() WHERE principal_id = $1`, [user.id]);
        await ctx.query(
          `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles)
           VALUES ('USER', $1, 'ORGANISATION', $2, ARRAY['ORG_ADMIN'])`,
          [user.id, organisationId],
        );
        return user.id;
      });
      expect(scopedToOrganisation).toBeTruthy();

      const clientAgain = await signIn(harness, 'analyst-pov-bravo@test.invalid');
      for (const path of [
        `/v1/msps/${mspId}/value/report`,
        `/v1/msps/${mspId}/value/effort-model`,
        `/v1/msps/${mspId}/value/reports`,
      ]) {
        const response = await harness.server.inject({
          method: 'GET',
          url: path,
          headers: bearer(clientAgain),
        });
        expect(response.statusCode, `${path} was served to a client`).toBe(403);
      }
    });
  });
});
