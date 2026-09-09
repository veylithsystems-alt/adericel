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
    'org:action:execute',
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
    'org:action:execute',
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
    'org:action:execute',
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
  return principal.grants.some((grant) => grant.scopeType === 'PLATFORM' && grantIsLive(grant, atIso));
}
