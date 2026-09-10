import { z } from 'zod';

/**
 * Identity, authority and scope.
 *
 * The chain Adericel enforces is:
 *   who -> authenticated as -> authorised for -> which organisation ->
 *   which resource -> which operation -> under which policy.
 *
 * A caller-supplied organisation id is never sufficient. Tenant context is
 * always derived from the authenticated principal's grants.
 */
export const PRINCIPAL_TYPES = ['USER', 'API_KEY', 'SERVICE', 'WORKFLOW'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const SCOPE_TYPES = ['PLATFORM', 'MSP', 'ORGANISATION'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];
export const scopeTypeSchema = z.enum(SCOPE_TYPES);

/**
 * Permissions are verbs over resource families. Kept coarse enough to reason
 * about and fine enough that an MSP support engineer cannot silently gain the
 * ability to execute destructive actions.
 */
export const PERMISSIONS = [
  // Platform administration
  'platform:admin',
  'platform:read',

  // MSP operator plane
  'msp:read',
  'msp:manage',
  'msp:organisation:create',
  'msp:organisation:read',
  'msp:organisation:manage',
  'msp:member:manage',
  'msp:baseline:manage',
  'msp:billing:read',
  'msp:billing:manage',

  // Organisation plane
  'org:read',
  'org:manage',
  'org:member:manage',
  'org:asset:read',
  'org:asset:write',
  'org:evidence:read',
  'org:evidence:write',
  'org:evidence:revoke',
  'org:claim:read',
  'org:claim:write',
  'org:control:read',
  'org:control:manage',
  'org:assessment:read',
  'org:assessment:run',
  'org:finding:read',
  'org:finding:manage',
  'org:risk:read',
  'org:risk:manage',
  'org:exception:read',
  'org:exception:request',
  'org:exception:approve',
  'org:action:read',
  'org:action:propose',
  'org:action:approve',
  'org:action:execute',
  'org:integration:read',
  'org:integration:manage',
  'org:audit:read',
  'org:export',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export const permissionSchema = z.enum(PERMISSIONS);

export const ROLES = [
  'PLATFORM_ADMIN',
  'MSP_OWNER',
  'MSP_ADMIN',
  'MSP_ANALYST',
  'MSP_READONLY',
  'ORG_ADMIN',
  'ORG_SECURITY_LEAD',
  'ORG_APPROVER',
  'ORG_ANALYST',
  'ORG_READONLY',
  'AUTOMATION',
] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

const ORG_READ_PERMISSIONS: readonly Permission[] = [
  'org:read',
  'org:asset:read',
  'org:evidence:read',
  'org:claim:read',
  'org:control:read',
  'org:assessment:read',
  'org:finding:read',
  'org:risk:read',
  'org:exception:read',
  'org:action:read',
  'org:integration:read',
  'org:audit:read',
];

const ORG_ANALYST_PERMISSIONS: readonly Permission[] = [
  ...ORG_READ_PERMISSIONS,
  'org:asset:write',
  'org:evidence:write',
  'org:claim:write',
  'org:assessment:run',
  'org:finding:manage',
  'org:risk:manage',
  'org:exception:request',
  'org:action:propose',
  // Dispatching an already-approved action carries no additional authority:
  // the action can only leave AUTHORISED, which required an approval by someone
  // other than the proposer. The meaningful control is approval, not who
  // presses the button, and withholding execute would only mean an approver has
  // to come back and do it themselves.
  'org:action:execute',
  'org:export',
];

/**
 * Role definitions.
 *
 * Note that `ORG_APPROVER` deliberately holds `org:action:approve` but NOT
 * `org:action:propose`: separating proposal from approval is what makes
 * four-eyes control real rather than decorative.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  PLATFORM_ADMIN: [...PERMISSIONS],
  MSP_OWNER: [
    'msp:read',
    'msp:manage',
    'msp:organisation:create',
    'msp:organisation:read',
    'msp:organisation:manage',
    'msp:member:manage',
    'msp:baseline:manage',
    'msp:billing:read',
    'msp:billing:manage',
    ...ORG_ANALYST_PERMISSIONS,
    'org:manage',
    'org:member:manage',
    'org:control:manage',
    'org:integration:manage',
    'org:evidence:revoke',
    'org:exception:approve',
    'org:action:approve',
  ],
  MSP_ADMIN: [
    'msp:read',
    'msp:organisation:create',
    'msp:organisation:read',
    'msp:organisation:manage',
    'msp:baseline:manage',
    'msp:billing:read',
    ...ORG_ANALYST_PERMISSIONS,
    'org:manage',
    'org:member:manage',
    'org:control:manage',
    'org:integration:manage',
    'org:exception:approve',
    'org:action:approve',
  ],
  MSP_ANALYST: ['msp:read', 'msp:organisation:read', ...ORG_ANALYST_PERMISSIONS],
  MSP_READONLY: ['msp:read', 'msp:organisation:read', ...ORG_READ_PERMISSIONS],
  ORG_ADMIN: [
    ...ORG_ANALYST_PERMISSIONS,
    'org:manage',
    'org:member:manage',
    'org:control:manage',
    'org:integration:manage',
    'org:evidence:revoke',
    'org:exception:approve',
    'org:action:approve',
  ],
  ORG_SECURITY_LEAD: [
    ...ORG_ANALYST_PERMISSIONS,
    'org:control:manage',
    'org:exception:approve',
    'org:action:approve',
  ],
  ORG_APPROVER: [...ORG_READ_PERMISSIONS, 'org:action:approve', 'org:exception:approve'],
  ORG_ANALYST: [...ORG_ANALYST_PERMISSIONS],
  ORG_READONLY: [...ORG_READ_PERMISSIONS],
  AUTOMATION: [
    'org:read',
    'org:asset:read',
    'org:asset:write',
    'org:evidence:read',
    'org:evidence:write',
    'org:claim:read',
    'org:claim:write',
    'org:control:read',
    'org:assessment:read',
    'org:assessment:run',
    'org:finding:read',
    'org:finding:manage',
    'org:risk:read',
    'org:action:read',
    'org:action:propose',
    'org:action:execute',
    'org:integration:read',
    'org:audit:read',
  ],
};

export function permissionsForRoles(roles: readonly Role[]): ReadonlySet<Permission> {
  const set = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) set.add(permission);
  }
  return set;
}

/** A grant binds a principal to a set of roles within one scope. */
export interface Grant {
  readonly scopeType: ScopeType;
  /** MSP id or organisation id. Null for PLATFORM scope. */
  readonly scopeId: string | null;
  readonly roles: readonly Role[];
  /** Optional expiry, used for delegated/just-in-time MSP access. */
  readonly expiresAt: string | null;
}

/**
 * The authenticated caller. Constructed only by the auth layer from verified
 * credentials — never from request-supplied fields.
 */
export interface Principal {
  readonly principalType: PrincipalType;
  readonly principalId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly mspId: string | null;
  readonly grants: readonly Grant[];
  readonly sessionId: string | null;
  readonly apiKeyId: string | null;
  /** True when the principal is acting through an MSP's delegated authority. */
  readonly viaDelegation: boolean;
  /**
   * Whether a second factor was presented for this session. Loaded from the
   * session row, never from the token — a claim in a token would make this a
   * statement the client controls.
   */
  readonly mfaSatisfied: boolean;
}

export interface AuthorisationQuestion {
  readonly permission: Permission;
  readonly organisationId?: string | null;
  readonly mspId?: string | null;
}

export interface AuthorisationAnswer {
  readonly allowed: boolean;
  readonly reason: string;
  readonly viaScope: ScopeType | null;
  readonly viaScopeId: string | null;
}

/**
 * Permissions that only a human being may hold.
 *
 * Four-eyes control is worthless if the second pair of eyes can be a workflow,
 * an API key, or an agent acting on a model's output. Rather than relying on
 * nobody ever granting an approver role to a service account, `authorise()`
 * refuses these permissions to any principal that is not a USER — before it
 * looks at a single grant, so there is no scope or role combination that
 * reaches them.
 *
 * The consequence is deliberate and stated in ADR-0015: there is no
 * configuration in which Adericel approves its own actions.
 */
export const HUMAN_ONLY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'org:action:approve',
  // Approving an exception is the decision that a control may stay unsatisfied.
  // It is an assurance judgement with the same weight as authorising a change,
  // and it was previously defended only at the route. The route check is still
  // there; this makes the rule hold wherever authorisation is asked, including
  // from a future caller that forgets.
  'org:exception:approve',
]);

/**
 * Permissions that require a second factor to have been presented in this
 * session.
 *
 * Approval is the point where a human takes responsibility for a change to
 * somebody else's production estate. A stolen password should not be able to
 * reach it, and four-eyes control backed by one factor is one credential
 * theft away from being one pair of eyes.
 *
 * This is checked against the session, not the token, because authority is
 * resolved per request (ADR-0008): revoking a factor takes effect on the next
 * call rather than at token expiry.
 */
export const MFA_DENIAL_PREFIX = 'mfa-required: ';

export const MFA_REQUIRED_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'org:action:approve',
  'org:exception:approve',
]);

function grantIsLive(grant: Grant, atIso: string): boolean {
  return grant.expiresAt === null || Date.parse(grant.expiresAt) > Date.parse(atIso);
}

/**
 * The single authorisation decision function.
 *
 * Resolution order is platform, then MSP, then organisation. An MSP grant
 * authorises action inside a customer organisation only when the organisation
 * is passed in `organisationsByMsp` — membership is proven, never assumed from
 * the request.
 */
export function authorise(
  principal: Principal,
  question: AuthorisationQuestion,
  context: {
    readonly atIso: string;
    /** organisationId -> owning mspId. Supplied by the caller from the database. */
    readonly organisationMspId?: string | null;
  },
): AuthorisationAnswer {
  // Checked before any grant is examined, so there is no scope — platform
  // included — through which a non-human principal can acquire one of these.
  if (HUMAN_ONLY_PERMISSIONS.has(question.permission) && principal.principalType !== 'USER') {
    return {
      allowed: false,
      reason:
        `${question.permission} requires a human principal; ` +
        `this caller is a ${principal.principalType}`,
      viaScope: null,
      viaScopeId: null,
    };
  }

  if (MFA_REQUIRED_PERMISSIONS.has(question.permission) && !principal.mfaSatisfied) {
    return {
      allowed: false,
      // Prefixed so the API edge can tell this denial apart from a tenancy
      // denial and answer it specifically. Every other refusal is deliberately
      // indistinguishable to the caller; this one must not be, because the
      // person is authorised and simply needs to present their factor, and
      // saying "no access" to them is both wrong and unactionable.
      reason:
        `${MFA_DENIAL_PREFIX}${question.permission} requires a second factor; ` +
        'this session was not authenticated with one',
      viaScope: null,
      viaScopeId: null,
    };
  }

  const live = principal.grants.filter((grant) => grantIsLive(grant, context.atIso));

  for (const grant of live) {
    if (grant.scopeType !== 'PLATFORM') continue;
    if (permissionsForRoles(grant.roles).has(question.permission)) {
      return { allowed: true, reason: 'Platform grant', viaScope: 'PLATFORM', viaScopeId: null };
    }
  }

  if (question.organisationId) {
    for (const grant of live) {
      if (grant.scopeType !== 'ORGANISATION' || grant.scopeId !== question.organisationId) continue;
      if (permissionsForRoles(grant.roles).has(question.permission)) {
        return {
          allowed: true,
          reason: 'Direct organisation grant',
          viaScope: 'ORGANISATION',
          viaScopeId: grant.scopeId,
        };
      }
    }

    const owningMsp = context.organisationMspId ?? null;
    if (owningMsp !== null) {
      for (const grant of live) {
        if (grant.scopeType !== 'MSP' || grant.scopeId !== owningMsp) continue;
        if (permissionsForRoles(grant.roles).has(question.permission)) {
          return {
            allowed: true,
            reason: 'Delegated MSP grant over the owning MSP',
            viaScope: 'MSP',
            viaScopeId: grant.scopeId,
          };
        }
      }
    }

    return {
      allowed: false,
      reason: `No live grant conveys ${question.permission} over organisation ${question.organisationId}`,
      viaScope: null,
      viaScopeId: null,
    };
  }

  if (question.mspId) {
    for (const grant of live) {
      if (grant.scopeType !== 'MSP' || grant.scopeId !== question.mspId) continue;
      if (permissionsForRoles(grant.roles).has(question.permission)) {
        return { allowed: true, reason: 'MSP grant', viaScope: 'MSP', viaScopeId: grant.scopeId };
      }
    }
    return {
      allowed: false,
      reason: `No live grant conveys ${question.permission} over MSP ${question.mspId}`,
      viaScope: null,
      viaScopeId: null,
    };
  }

  return {
    allowed: false,
    reason: `No live grant conveys ${question.permission}`,
    viaScope: null,
    viaScopeId: null,
  };
}

/** Organisations the principal can reach, for portfolio queries. */
export function accessibleOrganisationIds(principal: Principal, atIso: string): readonly string[] {
  return principal.grants
    .filter((grant) => grant.scopeType === 'ORGANISATION' && grantIsLive(grant, atIso))
    .map((grant) => grant.scopeId)
    .filter((id): id is string => id !== null);
}

export function accessibleMspIds(principal: Principal, atIso: string): readonly string[] {
  return principal.grants
    .filter((grant) => grant.scopeType === 'MSP' && grantIsLive(grant, atIso))
    .map((grant) => grant.scopeId)
    .filter((id): id is string => id !== null);
}

export function hasPlatformScope(principal: Principal, atIso: string): boolean {
  return principal.grants.some(
    (grant) => grant.scopeType === 'PLATFORM' && grantIsLive(grant, atIso),
  );
}
