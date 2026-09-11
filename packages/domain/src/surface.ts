import { z } from 'zod';
import { PERMISSIONS, type Permission, type Role, type ScopeType } from './authz.js';

/**
 * Surfaces: the three information boundaries.
 *
 * Adericel is a product. Veylith Systems is the company that operates it. They
 * are not the same system and they must not become the same window. Three
 * populations look at this platform and each of them is entitled to a strictly
 * different set of facts:
 *
 *   VEYLITH_INTERNAL  The internal control room. How the company itself is
 *                     running: its processes, its exceptions, its autonomy
 *                     maturity, its commercial pipeline. Veylith's own staff.
 *
 *   ADERICEL_MSP      The MSP control room. An operator managing assurance
 *                     across a portfolio of client organisations: the roster,
 *                     the commercial position, and the assurance state of each
 *                     client they are contracted to run.
 *
 *   ADERICEL_CLIENT   The client view. One organisation's own staff looking at
 *                     their own assurance state, their own evidence, and their
 *                     own reasons for UNKNOWN.
 *
 * The boundaries between them are not presentation. They are enforced twice,
 * independently:
 *
 *   1. By information class. Each permission belongs to exactly one class, and
 *      each surface may reach only certain classes. A permission outside the
 *      surface's classes is refused before any grant is consulted.
 *
 *   2. By scope. Each surface accepts grants of exactly one scope type. A
 *      platform grant is invisible on the Adericel surfaces; an MSP grant is
 *      invisible on the Veylith surface; an organisation grant reaches its own
 *      organisation and nothing else, ever.
 *
 * The consequence that matters most is deliberate: a Veylith platform
 * administrator has NO standing access to any customer's assurance data or
 * personal data. Support that genuinely requires it is obtained by issuing an
 * expiring MSP or organisation grant, which is a recorded act with a name
 * against it, rather than a permanent capability nobody can see being used.
 */
export const SURFACES = ['VEYLITH_INTERNAL', 'ADERICEL_MSP', 'ADERICEL_CLIENT'] as const;
export type Surface = (typeof SURFACES)[number];
export const surfaceSchema = z.enum(SURFACES);

/**
 * Classes of information.
 *
 * The unit of the boundary is not the table and not the route. It is the kind
 * of fact being disclosed, because that is what survives refactoring.
 */
export const INFORMATION_CLASSES = [
  /** How Veylith Systems itself is running. Never customer data. */
  'COMPANY_OPERATIONS',
  /** Acts that create or reconfigure tenants of the platform. */
  'PLATFORM_ADMINISTRATION',
  /** An MSP's roster of clients seen together, and its commercial position. */
  'MSP_PORTFOLIO',
  /** One organisation's assurance state: controls, evidence, findings, actions. */
  'TENANT_ASSURANCE',
  /** One organisation's own configuration: members, integrations, audit, export. */
  'TENANT_ADMINISTRATION',
] as const;
export type InformationClass = (typeof INFORMATION_CLASSES)[number];

/**
 * Every permission, classified.
 *
 * Exhaustive by construction: `Record<Permission, ...>` means adding a
 * permission without deciding which surfaces may see it does not compile.
 */
export const PERMISSION_CLASS: Readonly<Record<Permission, InformationClass>> = {
  'platform:admin': 'PLATFORM_ADMINISTRATION',
  'platform:read': 'COMPANY_OPERATIONS',

  'msp:read': 'MSP_PORTFOLIO',
  'msp:manage': 'MSP_PORTFOLIO',
  'msp:organisation:create': 'MSP_PORTFOLIO',
  'msp:organisation:read': 'MSP_PORTFOLIO',
  'msp:organisation:manage': 'MSP_PORTFOLIO',
  'msp:member:manage': 'MSP_PORTFOLIO',
  'msp:baseline:manage': 'MSP_PORTFOLIO',
  'msp:billing:read': 'MSP_PORTFOLIO',
  'msp:billing:manage': 'MSP_PORTFOLIO',

  'org:read': 'TENANT_ASSURANCE',
  'org:asset:read': 'TENANT_ASSURANCE',
  'org:asset:write': 'TENANT_ASSURANCE',
  'org:evidence:read': 'TENANT_ASSURANCE',
  'org:evidence:write': 'TENANT_ASSURANCE',
  'org:evidence:revoke': 'TENANT_ASSURANCE',
  'org:claim:read': 'TENANT_ASSURANCE',
  'org:claim:write': 'TENANT_ASSURANCE',
  'org:control:read': 'TENANT_ASSURANCE',
  'org:control:manage': 'TENANT_ASSURANCE',
  'org:assessment:read': 'TENANT_ASSURANCE',
  'org:assessment:run': 'TENANT_ASSURANCE',
  'org:finding:read': 'TENANT_ASSURANCE',
  'org:finding:manage': 'TENANT_ASSURANCE',
  'org:risk:read': 'TENANT_ASSURANCE',
  'org:risk:manage': 'TENANT_ASSURANCE',
  'org:exception:read': 'TENANT_ASSURANCE',
  'org:exception:request': 'TENANT_ASSURANCE',
  'org:exception:approve': 'TENANT_ASSURANCE',
  'org:action:read': 'TENANT_ASSURANCE',
  'org:action:propose': 'TENANT_ASSURANCE',
  'org:action:approve': 'TENANT_ASSURANCE',
  'org:action:execute': 'TENANT_ASSURANCE',

  'org:manage': 'TENANT_ADMINISTRATION',
  'org:member:manage': 'TENANT_ADMINISTRATION',
  'org:integration:read': 'TENANT_ADMINISTRATION',
  'org:integration:manage': 'TENANT_ADMINISTRATION',
  'org:audit:read': 'TENANT_ADMINISTRATION',
  'org:export': 'TENANT_ADMINISTRATION',
};

export interface SurfaceDefinition {
  readonly surface: Surface;
  /** The one scope type whose grants are honoured here. */
  readonly scope: ScopeType;
  /** Which product this surface belongs to. */
  readonly product: 'VEYLITH' | 'ADERICEL';
  /** How many organisations a single session may see through it. */
  readonly breadth: 'COMPANY' | 'PORTFOLIO' | 'SINGLE_ORGANISATION';
  readonly reads: readonly InformationClass[];
  readonly summary: string;
}

export const SURFACE_DEFINITIONS: Readonly<Record<Surface, SurfaceDefinition>> = {
  VEYLITH_INTERNAL: {
    surface: 'VEYLITH_INTERNAL',
    scope: 'PLATFORM',
    product: 'VEYLITH',
    breadth: 'COMPANY',
    // Deliberately excludes every TENANT_ class. Operating the platform is not
    // a reason to read what a customer's estate looks like.
    reads: ['COMPANY_OPERATIONS', 'PLATFORM_ADMINISTRATION'],
    summary:
      'Veylith Internal Control Room. How the company is running: processes, ' +
      'exceptions, autonomy maturity, pipeline, and the acts that create tenants. ' +
      'Carries no customer assurance data and no customer personal data.',
  },
  ADERICEL_MSP: {
    surface: 'ADERICEL_MSP',
    scope: 'MSP',
    product: 'ADERICEL',
    breadth: 'PORTFOLIO',
    reads: ['MSP_PORTFOLIO', 'TENANT_ASSURANCE', 'TENANT_ADMINISTRATION'],
    summary:
      'Adericel MSP Control Room. One MSP operating assurance across the client ' +
      'organisations it is contracted to run, plus its own commercial position.',
  },
  ADERICEL_CLIENT: {
    surface: 'ADERICEL_CLIENT',
    scope: 'ORGANISATION',
    product: 'ADERICEL',
    breadth: 'SINGLE_ORGANISATION',
    // MSP_PORTFOLIO is absent on purpose: a client can never learn who else the
    // MSP serves, what the MSP is charged, or how large its book is.
    reads: ['TENANT_ASSURANCE', 'TENANT_ADMINISTRATION'],
    summary:
      "Adericel Client View. One organisation's own staff seeing their own " +
      'assurance state, their own evidence, and their own reasons for UNKNOWN.',
  },
};

/** The scope type whose grants a surface honours. Exactly one each. */
export function scopeForSurface(surface: Surface): ScopeType {
  return SURFACE_DEFINITIONS[surface].scope;
}

/** Whether a surface may disclose a class of information at all. */
export function surfaceReads(surface: Surface, informationClass: InformationClass): boolean {
  return SURFACE_DEFINITIONS[surface].reads.includes(informationClass);
}

/** Whether a permission is reachable on a surface, before any grant is read. */
export function surfaceAdmits(surface: Surface, permission: Permission): boolean {
  return surfaceReads(surface, PERMISSION_CLASS[permission]);
}

/** Every permission reachable on a surface. Used to describe a session. */
export function permissionsOnSurface(surface: Surface): readonly Permission[] {
  return PERMISSIONS.filter((permission) => surfaceAdmits(surface, permission));
}

/** The surfaces on which a permission is reachable. Empty means unreachable. */
export function surfacesFor(permission: Permission): readonly Surface[] {
  return SURFACES.filter((surface) => surfaceAdmits(surface, permission));
}

/**
 * Roles, restricted to the scopes in which they mean anything.
 *
 * Without this, a row in `grants` naming `PLATFORM_ADMIN` at organisation scope
 * would quietly hand out every organisation permission there is. The roles are
 * named for their scope; this makes the name binding rather than decorative.
 *
 * MSP scope accepts the ORG_ roles because MSP staff genuinely act inside their
 * clients' organisations — that is the job. Organisation scope does not accept
 * the MSP_ roles, because acting inside one organisation never confers anything
 * about the MSP above it.
 */
export const ROLES_VALID_IN_SCOPE: Readonly<Record<ScopeType, readonly Role[]>> = {
  PLATFORM: ['PLATFORM_ADMIN'],
  MSP: [
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
  ],
  ORGANISATION: [
    'ORG_ADMIN',
    'ORG_SECURITY_LEAD',
    'ORG_APPROVER',
    'ORG_ANALYST',
    'ORG_READONLY',
    'AUTOMATION',
  ],
};

export function roleValidInScope(role: Role, scope: ScopeType): boolean {
  return ROLES_VALID_IN_SCOPE[scope].includes(role);
}
