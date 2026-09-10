import { describe, expect, it } from 'vitest';
import {
  HUMAN_ONLY_PERMISSIONS,
  PRINCIPAL_TYPES,
  ROLE_PERMISSIONS,
  accessibleOrganisationIds,
  authorise,
  permissionsForRoles,
  type Principal,
} from './authz.js';

const AT = '2026-09-09T12:00:00.000Z';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    principalType: 'USER',
    principalId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Test User',
    email: 'user@example.com',
    mspId: null,
    grants: [],
    sessionId: null,
    apiKeyId: null,
    viaDelegation: false,
    mfaSatisfied: true,
    ...overrides,
  };
}

describe('authorise', () => {
  it('denies by default when the principal holds no grants', () => {
    const answer = authorise(
      principal(),
      { permission: 'org:read', organisationId: 'org-1' },
      { atIso: AT },
    );
    expect(answer.allowed).toBe(false);
  });

  it('allows via a direct organisation grant', () => {
    const p = principal({
      grants: [
        { scopeType: 'ORGANISATION', scopeId: 'org-1', roles: ['ORG_ANALYST'], expiresAt: null },
      ],
    });
    expect(
      authorise(p, { permission: 'org:read', organisationId: 'org-1' }, { atIso: AT }).allowed,
    ).toBe(true);
  });

  it('does not let an organisation grant reach a different organisation', () => {
    const p = principal({
      grants: [
        { scopeType: 'ORGANISATION', scopeId: 'org-1', roles: ['ORG_ADMIN'], expiresAt: null },
      ],
    });
    expect(
      authorise(p, { permission: 'org:read', organisationId: 'org-2' }, { atIso: AT }).allowed,
    ).toBe(false);
  });

  it('allows an MSP grant only over organisations proven to belong to that MSP', () => {
    const p = principal({
      mspId: 'msp-1',
      grants: [{ scopeType: 'MSP', scopeId: 'msp-1', roles: ['MSP_ADMIN'], expiresAt: null }],
    });
    expect(
      authorise(
        p,
        { permission: 'org:read', organisationId: 'org-1' },
        { atIso: AT, organisationMspId: 'msp-1' },
      ).allowed,
    ).toBe(true);
    expect(
      authorise(
        p,
        { permission: 'org:read', organisationId: 'org-1' },
        { atIso: AT, organisationMspId: 'msp-2' },
      ).allowed,
    ).toBe(false);
  });

  it('refuses to infer MSP ownership when it was not supplied', () => {
    const p = principal({
      grants: [{ scopeType: 'MSP', scopeId: 'msp-1', roles: ['MSP_ADMIN'], expiresAt: null }],
    });
    expect(
      authorise(p, { permission: 'org:read', organisationId: 'org-1' }, { atIso: AT }).allowed,
    ).toBe(false);
  });

  it('ignores expired grants', () => {
    const p = principal({
      grants: [
        {
          scopeType: 'ORGANISATION',
          scopeId: 'org-1',
          roles: ['ORG_ADMIN'],
          expiresAt: '2026-09-09T11:00:00.000Z',
        },
      ],
    });
    expect(
      authorise(p, { permission: 'org:read', organisationId: 'org-1' }, { atIso: AT }).allowed,
    ).toBe(false);
  });

  it('honours a live time-bounded delegation', () => {
    const p = principal({
      grants: [
        {
          scopeType: 'ORGANISATION',
          scopeId: 'org-1',
          roles: ['ORG_ADMIN'],
          expiresAt: '2026-09-09T13:00:00.000Z',
        },
      ],
    });
    expect(
      authorise(p, { permission: 'org:read', organisationId: 'org-1' }, { atIso: AT }).allowed,
    ).toBe(true);
  });

  it('grants platform scope across every organisation', () => {
    const p = principal({
      grants: [
        { scopeType: 'PLATFORM', scopeId: null, roles: ['PLATFORM_ADMIN'], expiresAt: null },
      ],
    });
    expect(
      authorise(p, { permission: 'org:action:execute', organisationId: 'any' }, { atIso: AT })
        .allowed,
    ).toBe(true);
  });
});

describe('role definitions', () => {
  it('separates proposing an action from approving it', () => {
    const approver = permissionsForRoles(['ORG_APPROVER']);
    expect(approver.has('org:action:approve')).toBe(true);
    expect(approver.has('org:action:propose')).toBe(false);

    const analyst = permissionsForRoles(['ORG_ANALYST']);
    expect(analyst.has('org:action:propose')).toBe(true);
    expect(analyst.has('org:action:approve')).toBe(false);
  });

  it('lets an analyst dispatch an action someone else approved', () => {
    // Execution adds no authority: an action can only leave AUTHORISED, which
    // already required an approval from someone other than the proposer.
    const analyst = permissionsForRoles(['ORG_ANALYST']);
    expect(analyst.has('org:action:execute')).toBe(true);
  });

  it('does not let a pure approver execute or propose', () => {
    const approver = permissionsForRoles(['ORG_APPROVER']);
    expect(approver.has('org:action:execute')).toBe(false);
    expect(approver.has('org:action:propose')).toBe(false);
  });

  it('never lets a read-only role write', () => {
    for (const role of ['ORG_READONLY', 'MSP_READONLY'] as const) {
      const permissions = ROLE_PERMISSIONS[role];
      expect(permissions.some((p) => p.includes(':write') || p.includes(':manage'))).toBe(false);
      expect(permissions).not.toContain('org:action:execute');
    }
  });

  it('does not let automation approve its own actions', () => {
    const automation = permissionsForRoles(['AUTOMATION']);
    expect(automation.has('org:action:propose')).toBe(true);
    expect(automation.has('org:action:approve')).toBe(false);
    expect(automation.has('org:exception:approve')).toBe(false);
  });
});

describe('permissions only a human may hold', () => {
  // The strongest form of the four-eyes guarantee: not "we do not grant this to
  // service accounts" but "a service account holding it is still refused".
  const ORG = '22222222-2222-4222-8222-222222222222';

  it('refuses approval to every non-human principal type, even with a platform grant', () => {
    for (const principalType of PRINCIPAL_TYPES) {
      if (principalType === 'USER') continue;
      const p = principal({
        principalType,
        grants: [
          { scopeType: 'PLATFORM', scopeId: null, roles: ['PLATFORM_ADMIN'], expiresAt: null },
          { scopeType: 'ORGANISATION', scopeId: ORG, roles: ['ORG_APPROVER'], expiresAt: null },
        ],
      });
      const answer = authorise(
        p,
        { permission: 'org:action:approve', organisationId: ORG },
        { atIso: AT },
      );
      expect(answer.allowed, `${principalType} was allowed to approve`).toBe(false);
      expect(answer.reason).toContain('requires a human principal');
    }
  });

  it('refuses exception approval to every non-human principal type', () => {
    // Approving an exception is the decision that a control may remain
    // unsatisfied — the same weight of judgement as authorising a change, and
    // the same reason a workflow must not be able to make it.
    for (const principalType of PRINCIPAL_TYPES) {
      if (principalType === 'USER') continue;
      const p = principal({
        principalType,
        grants: [
          { scopeType: 'PLATFORM', scopeId: null, roles: ['PLATFORM_ADMIN'], expiresAt: null },
          { scopeType: 'ORGANISATION', scopeId: ORG, roles: ['ORG_APPROVER'], expiresAt: null },
        ],
      });
      const answer = authorise(
        p,
        { permission: 'org:exception:approve', organisationId: ORG },
        { atIso: AT },
      );
      expect(answer.allowed, `${principalType} was allowed to approve an exception`).toBe(false);
      expect(answer.reason).toContain('requires a human principal');
    }
  });

  it('names every permission that only a human may hold, so additions are deliberate', () => {
    // A change to this list changes who can accept risk on a customer's behalf.
    // It should never happen as a side effect of something else.
    expect([...HUMAN_ONLY_PERMISSIONS].sort()).toEqual([
      'org:action:approve',
      'org:exception:approve',
    ]);
  });

  it('still allows a human approver', () => {
    const p = principal({
      grants: [
        { scopeType: 'ORGANISATION', scopeId: ORG, roles: ['ORG_APPROVER'], expiresAt: null },
      ],
    });
    expect(
      authorise(p, { permission: 'org:action:approve', organisationId: ORG }, { atIso: AT })
        .allowed,
    ).toBe(true);
  });

  it('does not accidentally gate permissions automation legitimately needs', () => {
    expect(HUMAN_ONLY_PERMISSIONS.has('org:action:propose')).toBe(false);
    expect(HUMAN_ONLY_PERMISSIONS.has('org:action:execute')).toBe(false);
    expect(HUMAN_ONLY_PERMISSIONS.has('org:evidence:write')).toBe(false);
  });
});

describe('permissions that require a second factor', () => {
  const ORG = '22222222-2222-4222-8222-222222222222';
  const approver = (mfaSatisfied: boolean) =>
    principal({
      mfaSatisfied,
      grants: [
        { scopeType: 'ORGANISATION', scopeId: ORG, roles: ['ORG_APPROVER'], expiresAt: null },
      ],
    });

  it('refuses approval on a session that presented only a password', () => {
    const answer = authorise(
      approver(false),
      { permission: 'org:action:approve', organisationId: ORG },
      { atIso: AT },
    );
    expect(answer.allowed).toBe(false);
    expect(answer.reason).toContain('requires a second factor');
  });

  it('allows approval once a second factor has been presented', () => {
    expect(
      authorise(
        approver(true),
        { permission: 'org:action:approve', organisationId: ORG },
        { atIso: AT },
      ).allowed,
    ).toBe(true);
  });

  it('does not gate ordinary work behind a second factor', () => {
    const analyst = principal({
      mfaSatisfied: false,
      grants: [
        { scopeType: 'ORGANISATION', scopeId: ORG, roles: ['ORG_ANALYST'], expiresAt: null },
      ],
    });
    for (const permission of ['org:read', 'org:evidence:write', 'org:action:propose'] as const) {
      expect(
        authorise(analyst, { permission, organisationId: ORG }, { atIso: AT }).allowed,
        `${permission} should not require MFA`,
      ).toBe(true);
    }
  });

  it('refuses a non-human principal before it even considers the factor', () => {
    // Both gates would refuse this. The message proves which one ran first,
    // because "enrol a second factor" is the wrong advice to give a workflow.
    const workflow = principal({
      principalType: 'WORKFLOW',
      mfaSatisfied: true,
      grants: [
        { scopeType: 'ORGANISATION', scopeId: ORG, roles: ['ORG_APPROVER'], expiresAt: null },
      ],
    });
    const answer = authorise(
      workflow,
      { permission: 'org:action:approve', organisationId: ORG },
      { atIso: AT },
    );
    expect(answer.allowed).toBe(false);
    expect(answer.reason).toContain('requires a human principal');
  });
});

describe('accessibleOrganisationIds', () => {
  it('lists only live organisation-scoped grants', () => {
    const p = principal({
      grants: [
        { scopeType: 'ORGANISATION', scopeId: 'org-1', roles: ['ORG_READONLY'], expiresAt: null },
        {
          scopeType: 'ORGANISATION',
          scopeId: 'org-2',
          roles: ['ORG_READONLY'],
          expiresAt: '2020-01-01T00:00:00.000Z',
        },
        { scopeType: 'MSP', scopeId: 'msp-1', roles: ['MSP_ADMIN'], expiresAt: null },
      ],
    });
    expect(accessibleOrganisationIds(p, AT)).toEqual(['org-1']);
  });
});
