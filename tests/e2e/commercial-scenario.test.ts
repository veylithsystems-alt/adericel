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
 * The complete commercial scenario.
 *
 * MSP creates an organisation, a source is connected, observations are
 * collected, evidence and claims are produced, the Truth Engine assesses, a
 * finding is raised, an action is proposed, policy is evaluated, a human
 * approves, the action executes, the external state is re-observed, verification
 * runs, and the assurance state updates — with a complete audit trail.
 *
 * This is the minimum meaningful demonstration of the product, so it is a test
 * rather than a script: if any link in the chain breaks, the build fails.
 */

const available = await databaseAvailable();

const DEMO_RECORDS = [
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'e2e-user-ok',
    payload: {
      externalId: 'e2e-user-ok',
      displayName: 'Compliant Person',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: true,
      lastSignInAt: new Date().toISOString(),
    },
  },
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'e2e-user-bad',
    payload: {
      externalId: 'e2e-user-bad',
      displayName: 'Person Without MFA',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: false,
      lastSignInAt: new Date().toISOString(),
    },
  },
];

describe.skipIf(!available)('end-to-end commercial scenario', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let analystToken: string;
  let approverToken: string;
  let controlId: string;
  let findingId: string;
  let actionId: string;
  let subjectNodeId: string;
  let correlationId: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, {
      slug: 'e2e-corp',
      records: DEMO_RECORDS,
      autonomyLevel: 3,
    });
    analystToken = await signIn(harness, 'analyst-e2e-corp@test.invalid');
    // The approver signs in and enrols a second factor, because approval
    // requires one. This is the real flow, not a shortcut around it.
    approverToken = await signInWithMfa(harness, 'approver-e2e-corp@test.invalid');
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('1. collects observations and turns them into evidence and claims', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}/collect`,
      headers: bearer(analystToken),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      status: string;
      observationsRecorded: number;
      evidenceCreated: number;
      claimsChanged: number;
      nodesUpserted: number;
    };
    expect(body.status).toBe('SUCCEEDED');
    expect(body.observationsRecorded).toBe(2);
    expect(body.evidenceCreated).toBe(2);
    expect(body.claimsChanged).toBeGreaterThan(0);
    expect(body.nodesUpserted).toBe(2);
  });

  it('2. records evidence with provenance and a content hash', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/evidence`,
      headers: bearer(analystToken),
    });
    const body = response.json() as {
      evidence: {
        contentHash: string;
        sourceSystem: string;
        usable: boolean;
        integrityLevel: string;
      }[];
    };
    expect(body.evidence.length).toBeGreaterThan(0);
    for (const item of body.evidence) {
      expect(item.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(item.sourceSystem).toBe('adericel-demo-fixture');
      expect(item.usable).toBe(true);
    }
  });

  it('3. assesses deterministically and records reproducible provenance', async () => {
    const controls = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/controls`,
      headers: bearer(analystToken),
    });
    const found = (controls.json() as { controls: { id: string; key: string }[] }).controls.find(
      (c) => c.key === 'identity.mfa.enforced',
    );
    expect(found).toBeDefined();
    controlId = found!.id;

    const assessment = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/assessments`,
      headers: bearer(analystToken),
      payload: { subjectKind: 'CONTROL', subjectId: controlId, trigger: 'MANUAL' },
    });
    expect(assessment.statusCode).toBe(201);

    const body = assessment.json() as {
      assessment: {
        state: string;
        provenance: { rulesetHash: string; inputDigest: string; engineVersion: string };
      };
    };
    // One identity without MFA means the control is not satisfied. Not unknown:
    // the evidence is present and it disproves the control.
    expect(body.assessment.state).toBe('NOT_SATISFIED');
    expect(body.assessment.provenance.rulesetHash).toMatch(/^sha256:/);
    expect(body.assessment.provenance.inputDigest).toMatch(/^sha256:/);
  });

  it('4. explains the state down to the named subject and its evidence', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/controls/${controlId}/explanation`,
      headers: bearer(analystToken),
    });
    const body = response.json() as {
      state: string;
      rationale: string;
      evidence: unknown[];
      claims: unknown[];
      openFindings: { id: string; title: string; severity: string }[];
      assessment: { provenance: { rulesetVersion: string } };
    };
    expect(body.state).toBe('NOT_SATISFIED');
    expect(body.rationale).toContain('1 of 2');
    expect(body.evidence.length).toBeGreaterThan(0);
    expect(body.claims.length).toBeGreaterThan(0);
    expect(body.openFindings.length).toBe(1);
    expect(body.openFindings[0]?.title).toContain('Person Without MFA');
    findingId = body.openFindings[0]!.id;
  });

  it('5. proposes a remediation and evaluates policy without dispatching anything', async () => {
    const nodes = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/nodes?kind=Identity&externalId=e2e-user-bad`,
      headers: bearer(analystToken),
    });
    subjectNodeId = (nodes.json() as { nodes: { id: string }[] }).nodes[0]!.id;

    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions`,
      headers: bearer(analystToken),
      payload: {
        actionType: 'identity.mfa.require',
        integrationId: tenant.integrationId,
        targetNodeId: subjectNodeId,
        targetExternalId: 'e2e-user-bad',
        parameters: { enforcement: 'REQUIRED' },
        findingId,
        rationale: 'Enforce MFA on an active account that has no second factor.',
      },
    });
    expect(response.statusCode).toBe(201);

    const body = response.json() as {
      action: { id: string; state: string; riskClass: string };
      decision: { outcome: string; requiredApprovals: number; effectiveAutonomyLevel: number };
    };
    actionId = body.action.id;
    expect(body.action.state).toBe('AWAITING_APPROVAL');
    expect(body.decision.outcome).toBe('REQUIRE_APPROVAL');
    expect(body.decision.effectiveAutonomyLevel).toBe(3);

    // Nothing has been dispatched: no execution attempt exists yet.
    const executions = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
      ctx.many('SELECT id FROM action_executions WHERE action_id = $1', [actionId]),
    );
    expect(executions).toHaveLength(0);
  });

  it('6. refuses to execute before approval', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions/${actionId}/execute`,
      headers: bearer(analystToken),
    });
    expect(response.statusCode).toBe(412);
    expect((response.json() as { error: { message: string } }).error.message).toMatch(
      /not authorised/i,
    );
  });

  it('7. refuses to let the proposer approve their own action', async () => {
    // The analyst proposed it. Grant them approval authority temporarily so the
    // refusal comes from the four-eyes rule rather than from authorisation.
    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(
        `UPDATE grants SET roles = ARRAY['MSP_ANALYST','ORG_APPROVER']::text[]
         WHERE principal_id = $1 AND revoked_at IS NULL`,
        [tenant.analystUserId],
      );
    });
    // They also enrol a second factor, so the refusal cannot be blamed on a
    // missing one. Every other reason to say no is removed, leaving only the
    // four-eyes rule.
    const freshToken = await signInWithMfa(harness, 'analyst-e2e-corp@test.invalid');

    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions/${actionId}/decision`,
      headers: bearer(freshToken),
      payload: { decision: 'APPROVED' },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { message: string } }).error.message).toMatch(
      /proposer.*may not approve/i,
    );

    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(
        `UPDATE grants SET roles = ARRAY['MSP_ANALYST']::text[]
         WHERE principal_id = $1 AND revoked_at IS NULL`,
        [tenant.analystUserId],
      );
    });
  });

  it('7b. refuses approval from a session that presented only a password', async () => {
    // A second approver exists with the right role and no second factor. The
    // refusal must come from the missing factor, not from the role, which is
    // why this is a different person from the proposer.
    const passwordOnly = await signIn(harness, 'owner-e2e-corp@test.invalid');

    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions/${actionId}/decision`,
      headers: bearer(passwordOnly),
      payload: { decision: 'APPROVED' },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { message: string } }).error.message).toMatch(
      /second factor/i,
    );
  });

  it('8. authorises the action once a different person approves', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions/${actionId}/decision`,
      headers: bearer(approverToken),
      payload: { decision: 'APPROVED', note: 'Reviewed and approved.' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { state: string; fullyApproved: boolean };
    expect(body.fullyApproved).toBe(true);
    expect(body.state).toBe('AUTHORISED');
  });

  it('9. executes and moves to VERIFYING, not to success', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions/${actionId}/execute`,
      headers: bearer(analystToken),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      executionStatus: string;
      state: string;
      verificationRequired: boolean;
      externalOperationRef: string | null;
    };
    expect(body.executionStatus).toBe('SUCCEEDED');
    // Executed is not confirmed. The action must still prove it worked.
    expect(body.state).toBe('VERIFYING');
    expect(body.verificationRequired).toBe(true);
    expect(body.externalOperationRef).toBeTruthy();
  });

  it('10. is idempotent: a repeated execution adopts the prior outcome', async () => {
    const before = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
      ctx.many('SELECT id FROM action_executions WHERE action_id = $1', [actionId]),
    );

    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions/${actionId}/execute`,
      headers: bearer(analystToken),
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { alreadyExecuted: boolean }).alreadyExecuted).toBe(true);

    // Crucially, no second attempt reached the external system.
    const after = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
      ctx.many('SELECT id FROM action_executions WHERE action_id = $1', [actionId]),
    );
    expect(after).toHaveLength(before.length);
  });

  it('11. verifies by re-observing the source, and confirms', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/actions/${actionId}/verify`,
      headers: bearer(analystToken),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { outcome: string; state: string; detail: string };
    expect(body.outcome).toBe('CONFIRMED');
    expect(body.state).toBe('CONFIRMED');
  });

  it('12. updates the assurance state and resolves the finding', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/assessments`,
      headers: bearer(analystToken),
      payload: { subjectKind: 'CONTROL', subjectId: controlId, trigger: 'ACTION_VERIFICATION' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      assessment: { state: string };
      stateChanged: boolean;
      previousState: string;
      findingsResolved: number;
    };
    expect(body.assessment.state).toBe('SATISFIED');
    expect(body.stateChanged).toBe(true);
    expect(body.previousState).toBe('NOT_SATISFIED');
    expect(body.findingsResolved).toBe(1);
  });

  it('13. preserves a complete, ordered audit trail of the whole operation', async () => {
    const audit = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/audit?limit=200`,
      headers: bearer(analystToken),
    });
    const actions = (audit.json() as { entries: { action: string }[] }).entries.map(
      (e) => e.action,
    );

    for (const expected of [
      'integration:collect',
      'action:propose',
      'action:approved',
      'action:execute',
      'action:verify',
      'assessment:run',
    ]) {
      expect(actions, `audit trail is missing ${expected}`).toContain(expected);
    }

    // The refused self-approval is recorded too. A denial is often the most
    // important entry in the table.
    const denials = (audit.json() as { entries: { outcome: string }[] }).entries.filter(
      (e) => e.outcome === 'DENIED',
    );
    expect(denials.length).toBeGreaterThan(0);
  });

  it('14. records the full action history with every state transition', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/actions/${actionId}`,
      headers: bearer(analystToken),
    });
    const body = response.json() as {
      state: string;
      history: { from: string | null; to: string }[];
      approvals: { approverName: string; decision: string }[];
      verifications: { outcome: string }[];
      policyDecision: { outcome: string };
    };
    expect(body.state).toBe('CONFIRMED');
    expect(body.history.map((h) => h.to)).toEqual([
      'PROPOSED',
      'POLICY_EVALUATED',
      'AWAITING_APPROVAL',
      'APPROVED',
      'AUTHORISED',
      'EXECUTING',
      'EXECUTED',
      'VERIFYING',
      'CONFIRMED',
    ]);
    expect(body.approvals).toHaveLength(1);
    expect(body.verifications[0]?.outcome).toBe('CONFIRMED');
    expect(body.policyDecision.outcome).toBe('REQUIRE_APPROVAL');
  });

  it('15. links the whole operation by correlation id', async () => {
    const events = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/events?limit=200`,
      headers: bearer(analystToken),
    });
    const body = events.json() as { events: { type: string; correlationId: string }[] };

    for (const expected of [
      'EvidenceCreated',
      'ClaimChanged',
      'AssessmentCompleted',
      'AssuranceStateChanged',
      'FindingCreated',
      'ActionProposed',
      'ActionApprovalRequested',
      'ActionApproved',
      'ActionExecuted',
      'VerificationRequested',
      'VerificationCompleted',
      'FindingResolved',
    ]) {
      expect(
        body.events.map((e) => e.type),
        `no ${expected} event was published`,
      ).toContain(expected);
    }

    correlationId = body.events.find((e) => e.type === 'ActionExecuted')!.correlationId;
    const trace = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/trace/${correlationId}`,
      headers: bearer(analystToken),
    });
    expect(trace.statusCode).toBe(200);
    const traceBody = trace.json() as { timeline: { kind: string }[]; actions: unknown[] };
    expect(traceBody.timeline.length).toBeGreaterThan(0);
    expect(traceBody.actions.length).toBeGreaterThan(0);
  });

  it('16. exports the complete assurance record', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/export`,
      headers: bearer(analystToken),
    });
    expect(response.statusCode).toBe(200);
    const bundle = response.json() as {
      format: string;
      bundleHash: string;
      counts: Record<string, number>;
      evidence: { contentHash: string }[];
    };
    expect(bundle.format).toBe('adericel.organisation-export');
    expect(bundle.bundleHash).toMatch(/^sha256:/);
    expect(bundle.counts.assessments).toBeGreaterThan(0);
    expect(bundle.counts.actions).toBe(1);
    expect(bundle.counts.verifications).toBe(1);
    expect(bundle.evidence.every((e) => e.contentHash.startsWith('sha256:'))).toBe(true);
  });

  it('17. reflects the change in the portfolio the MSP sees', async () => {
    const ownerToken = await signIn(harness, 'owner-e2e-corp@test.invalid');
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/msps/${tenant.mspId}/portfolio`,
      headers: bearer(ownerToken),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      organisations: { organisationId: string; counts: Record<string, number> }[];
    };
    const org = body.organisations.find((o) => o.organisationId === tenant.organisationId);
    expect(org).toBeDefined();
    expect(org!.counts.NOT_SATISFIED).toBe(0);
  });
});
