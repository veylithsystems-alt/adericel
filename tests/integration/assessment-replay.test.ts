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
 * Historical replay.
 *
 * An assurance product's only real asset is that its answers can be defended
 * later. "This control was satisfied on 14 March" is worth nothing if, on 20
 * March, nobody can say on what basis. So an assessment records the facts it
 * ran on, and replay re-derives the determination from that record — not from
 * the live graph, which by design has moved on.
 *
 * The test that matters here is the third one: the estate changes, the control
 * is reassessed, and the ORIGINAL assessment still reproduces exactly. An
 * implementation that rebuilds the input from current data passes every other
 * test in this file and fails that one.
 */

const available = await databaseAvailable();

const IDENTITIES = [
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'replay-user-ok',
    payload: {
      externalId: 'replay-user-ok',
      displayName: 'Compliant Person',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: true,
      lastSignInAt: '2026-09-01T09:00:00.000Z',
    },
  },
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'replay-user-bad',
    payload: {
      externalId: 'replay-user-bad',
      displayName: 'Person Without MFA',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: false,
      lastSignInAt: '2026-09-01T09:00:00.000Z',
    },
  },
];

interface ReplayBody {
  assessmentId: string;
  reproduced: boolean;
  snapshotIntegrity: string;
  rulesetIntegrity: string;
  originalState: string;
  replayedState: string | null;
  originalUnknownReason: string | null;
  replayedUnknownReason: string | null;
  originalDigest: string;
  replayedDigest: string | null;
  rationaleMatches: boolean;
  explanation: string;
}

describe.skipIf(!available)('historical assessment replay', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let token: string;
  let controlId: string;
  /** The assessment made when exactly one identity lacked MFA. */
  let originalAssessmentId: string;
  let originalDigest: string;

  const assess = async (): Promise<{ id: string; state: string; inputDigest: string }> => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/assessments`,
      headers: bearer(token),
      payload: { subjectKind: 'CONTROL', subjectId: controlId, trigger: 'MANUAL' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      assessment: { id: string; state: string; provenance: { inputDigest: string } };
    };
    return {
      id: body.assessment.id,
      state: body.assessment.state,
      inputDigest: body.assessment.provenance.inputDigest,
    };
  };

  const replay = async (assessmentId: string): Promise<ReplayBody> => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/assessments/${assessmentId}/replay`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as ReplayBody;
  };

  const collect = async (): Promise<void> => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}/collect`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
  };

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'replay-corp', records: IDENTITIES });
    token = await signIn(harness, 'analyst-replay-corp@test.invalid');

    await collect();

    const controls = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/controls`,
      headers: bearer(token),
    });
    const found = (controls.json() as { controls: { id: string; key: string }[] }).controls.find(
      (c) => c.key === 'identity.mfa.enforced',
    );
    expect(found).toBeDefined();
    controlId = found!.id;

    const first = await assess();
    expect(first.state).toBe('NOT_SATISFIED');
    originalAssessmentId = first.id;
    originalDigest = first.inputDigest;
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('records the exact inputs the engine was given', async () => {
    const row = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
      ctx.one<{ snapshot: Record<string, unknown>; ruleset_hash: string; use_count: string }>(
        `SELECT snapshot, ruleset_hash, use_count FROM assessment_inputs
         WHERE organisation_id = $1 AND input_digest = $2`,
        [tenant.organisationId, originalDigest],
      ),
    );
    expect(row).not.toBeNull();
    const snapshot = row!.snapshot as {
      subjects: { claims: unknown[] }[];
      evidence: unknown[];
      asOfIso: string;
      observedSubjectKinds: string[];
    };
    // Not merely "a row exists": the facts, the evidence behind them, and the
    // scope statement that separates "no devices" from "never looked".
    expect(snapshot.subjects.length).toBe(2);
    expect(snapshot.subjects.every((s) => s.claims.length > 0)).toBe(true);
    expect(snapshot.evidence.length).toBeGreaterThan(0);
    expect(snapshot.observedSubjectKinds).toContain('Identity');
    expect(Date.parse(snapshot.asOfIso)).toBeTypeOf('number');
  });

  it('reproduces the determination exactly from the record', async () => {
    const result = await replay(originalAssessmentId);
    expect(result.reproduced).toBe(true);
    expect(result.snapshotIntegrity).toBe('VERIFIED');
    expect(result.rulesetIntegrity).toBe('VERIFIED');
    expect(result.replayedState).toBe(result.originalState);
    expect(result.replayedDigest).toBe(result.originalDigest);
    expect(result.rationaleMatches).toBe(true);
  });

  it('still reproduces the original after the estate has changed underneath it', async () => {
    // The customer fixes the problem. The live graph now says every identity
    // enforces MFA, and the control passes. None of that may alter what
    // Adericel said, or its ability to show why it said it.
    harness.fixtureState.apply(tenant.integrationId, 'replay-user-bad', { mfaEnforced: true });
    await collect();

    const second = await assess();
    expect(second.state).toBe('SATISFIED');
    expect(second.inputDigest).not.toBe(originalDigest);

    const original = await replay(originalAssessmentId);
    expect(original.reproduced).toBe(true);
    expect(original.originalState).toBe('NOT_SATISFIED');
    expect(original.replayedState).toBe('NOT_SATISFIED');
    expect(original.replayedDigest).toBe(originalDigest);

    // And the newer one reproduces on its own terms, rather than the newest
    // record simply overwriting the story.
    const later = await replay(second.id);
    expect(later.reproduced).toBe(true);
    expect(later.replayedState).toBe('SATISFIED');
  });

  it('stores one snapshot per distinct input, not one per assessment', async () => {
    const before = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
      ctx.oneOrFail<{ count: string; use_count: string }>(
        `SELECT count(*)::text AS count, coalesce(max(use_count), 0)::text AS use_count
         FROM assessment_inputs WHERE organisation_id = $1`,
        [tenant.organisationId],
        'Snapshot count',
      ),
    );

    // Reassess with nothing changed. The digest is the same by construction, so
    // this must reuse the stored snapshot rather than duplicate it.
    const repeat = await assess();
    const after = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
      ctx.oneOrFail<{ count: string }>(
        `SELECT count(*)::text AS count FROM assessment_inputs WHERE organisation_id = $1`,
        [tenant.organisationId],
        'Snapshot count',
      ),
    );
    expect(after.count).toBe(before.count);
    expect(Number(before.use_count)).toBeGreaterThanOrEqual(1);

    // Both assessments still replay, from the one shared snapshot.
    expect((await replay(repeat.id)).reproduced).toBe(true);
    expect((await replay(originalAssessmentId)).reproduced).toBe(true);
  });

  it('detects a tampered snapshot instead of replaying the altered facts', async () => {
    const restore = await harness.db.withTenant(tenant.organisationId, async (ctx) => {
      const row = await ctx.oneOrFail<{ snapshot: Record<string, unknown> }>(
        `SELECT snapshot FROM assessment_inputs WHERE organisation_id = $1 AND input_digest = $2`,
        [tenant.organisationId, originalDigest],
        'Snapshot',
      );
      const tampered = JSON.parse(JSON.stringify(row.snapshot)) as {
        subjects: { claims: { predicate: string; value: unknown }[] }[];
      };
      // Flip the failing identity to compliant, exactly as someone covering up
      // a historical failure would.
      for (const subject of tampered.subjects) {
        for (const claim of subject.claims) {
          if (claim.predicate === 'identity.mfa.enforced') claim.value = true;
        }
      }
      await ctx.query(
        `UPDATE assessment_inputs SET snapshot = $3::jsonb
         WHERE organisation_id = $1 AND input_digest = $2`,
        [tenant.organisationId, originalDigest, JSON.stringify(tampered)],
      );
      return row.snapshot;
    });

    const result = await replay(originalAssessmentId);
    expect(result.reproduced).toBe(false);
    expect(result.snapshotIntegrity).toBe('DIGEST_MISMATCH');
    expect(result.replayedDigest).not.toBe(result.originalDigest);
    expect(result.explanation).toMatch(/tampering|corruption/i);
    // The recorded determination is untouched by the tampering.
    expect(result.originalState).toBe('NOT_SATISFIED');

    await harness.db.withTenant(tenant.organisationId, async (ctx) => {
      await ctx.query(
        `UPDATE assessment_inputs SET snapshot = $3::jsonb
         WHERE organisation_id = $1 AND input_digest = $2`,
        [tenant.organisationId, originalDigest, JSON.stringify(restore)],
      );
    });
    expect((await replay(originalAssessmentId)).reproduced).toBe(true);
  });

  it('refuses to replay under a ruleset whose content no longer matches the record', async () => {
    const restore = await harness.db.withTenant(tenant.organisationId, async (ctx) => {
      const row = await ctx.oneOrFail<{ ruleset_hash: string }>(
        `SELECT ruleset_hash FROM assessments WHERE id = $1 AND organisation_id = $2`,
        [originalAssessmentId, tenant.organisationId],
        'Assessment',
      );
      await ctx.query(
        `UPDATE assessments SET ruleset_hash = $3 WHERE id = $1 AND organisation_id = $2`,
        [originalAssessmentId, tenant.organisationId, `sha256:${'0'.repeat(64)}`],
      );
      return row.ruleset_hash;
    });

    const result = await replay(originalAssessmentId);
    expect(result.reproduced).toBe(false);
    expect(result.rulesetIntegrity).toBe('HASH_MISMATCH');
    // No determination is offered under the substitute ruleset. A plausible
    // answer to the wrong question is worse than no answer.
    expect(result.replayedState).toBeNull();
    expect(result.explanation).toMatch(/immutable/i);

    await harness.db.withTenant(tenant.organisationId, async (ctx) => {
      await ctx.query(
        `UPDATE assessments SET ruleset_hash = $3 WHERE id = $1 AND organisation_id = $2`,
        [originalAssessmentId, tenant.organisationId, restore],
      );
    });
  });

  it('says plainly when no inputs were recorded, rather than inventing a reproduction', async () => {
    const restore = await harness.db.withTenant(tenant.organisationId, async (ctx) => {
      const row = await ctx.oneOrFail<{ snapshot: Record<string, unknown> }>(
        `SELECT snapshot FROM assessment_inputs WHERE organisation_id = $1 AND input_digest = $2`,
        [tenant.organisationId, originalDigest],
        'Snapshot',
      );
      await ctx.query(
        `DELETE FROM assessment_inputs WHERE organisation_id = $1 AND input_digest = $2`,
        [tenant.organisationId, originalDigest],
      );
      return row.snapshot;
    });

    const result = await replay(originalAssessmentId);
    expect(result.reproduced).toBe(false);
    expect(result.snapshotIntegrity).toBe('NOT_RECORDED');
    expect(result.replayedState).toBeNull();
    expect(result.replayedDigest).toBeNull();
    expect(result.explanation).toMatch(/no inputs are on record/i);

    await harness.db.withTenant(tenant.organisationId, async (ctx) => {
      await ctx.query(
        `INSERT INTO assessment_inputs
           (organisation_id, input_digest, snapshot, engine_version, ruleset_key, ruleset_version,
            ruleset_hash, control_id, rule_key)
         SELECT $1, $2, $3::jsonb, a.engine_version, a.ruleset_key, a.ruleset_version,
                a.ruleset_hash, a.subject_id, a.rule_key
         FROM assessments a WHERE a.id = $4 AND a.organisation_id = $1`,
        [tenant.organisationId, originalDigest, JSON.stringify(restore), originalAssessmentId],
      );
    });
    expect((await replay(originalAssessmentId)).reproduced).toBe(true);
  });

  it('refuses to replay a roll-up, which the engine never produced', async () => {
    // Roll-ups exist only where a framework maps requirements onto controls, so
    // this runs in its own tenant rather than reshaping the one above.
    const framed = await seedTenant(harness, {
      slug: 'replay-framed',
      records: IDENTITIES,
      frameworks: ['cyber-essentials'],
    });
    const framedToken = await signIn(harness, 'analyst-replay-framed@test.invalid');

    const runAll = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${framed.organisationId}/assessments/run-all`,
      headers: bearer(framedToken),
    });
    expect(runAll.statusCode).toBe(201);

    const rollUp = await harness.db.withTenant(framed.organisationId, async (ctx) =>
      ctx.one<{ id: string }>(
        `SELECT id FROM assessments
         WHERE organisation_id = $1 AND subject_kind <> 'CONTROL' LIMIT 1`,
        [framed.organisationId],
      ),
    );
    expect(rollUp).not.toBeNull();

    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${framed.organisationId}/assessments/${rollUp!.id}/replay`,
      headers: bearer(framedToken),
    });
    expect(response.statusCode).toBe(412);
    expect(JSON.stringify(response.json())).toContain('PRECONDITION_FAILED');
    // And it says why, rather than failing opaquely.
    expect(response.body).toMatch(/Only control assessments/);
  });

  it('does not expose another tenant’s assessment through replay', async () => {
    const other = await seedTenant(harness, { slug: 'replay-other', records: IDENTITIES });
    const otherToken = await signIn(harness, 'analyst-replay-other@test.invalid');

    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${other.organisationId}/assessments/${originalAssessmentId}/replay`,
      headers: bearer(otherToken),
    });
    expect(response.statusCode).toBe(404);

    // And the assessment's own organisation in the path is not enough either:
    // the caller must be entitled to that organisation.
    const crossPath = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/assessments/${originalAssessmentId}/replay`,
      headers: bearer(otherToken),
    });
    expect([403, 404]).toContain(crossPath.statusCode);
  });
});
