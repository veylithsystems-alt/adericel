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
