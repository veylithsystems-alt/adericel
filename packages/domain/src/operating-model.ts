import { z } from 'zod';
import { ROLE_PERMISSIONS, type Permission, type Role } from './authz.js';
import { ROLES_VALID_IN_SCOPE, type Surface } from './surface.js';
import type { CommercialState } from './commercial.js';

/**
 * The MSP operating model, as data.
 *
 * WHY THIS IS CODE AND NOT A DIAGRAM
 *
 * Adericel is sold to MSPs, and an MSP evaluating it asks operating questions
 * before technical ones: who owns the evidence, who reviews what, where does
 * an escalation go, what does the client have to approve, what happens at
 * offboarding. Those answers exist in this system — spread across the role
 * table, the surface model, the commercial states, the support routing and the
 * retention policy — and nowhere in one place a person could read.
 *
 * The obvious fix is a document with a diagram. The problem with that fix is
 * that it is true on the day it is written: roles change, a state gets added,
 * routing is adjusted, and the diagram keeps reassuring everybody about a
 * system that no longer works that way. An operating model an MSP plans their
 * business around must not be able to go quietly stale.
 *
 * So it is declared here and **checked against the implementation** by
 * `tests/unit/operating-model.test.ts`: every role named must exist, every
 * permission must be one the role actually holds, every commercial state must
 * be real. The document under `docs/product/` is generated from this, which
 * makes the document a view of the system rather than a claim about it.
 */

/** The parties in the model. Four, and the distinctions matter commercially. */
export const OPERATING_PARTIES = [
  /** Veylith Systems: builds and operates the platform. Not a party to the client relationship. */
  'VEYLITH',
  /** The MSP: holds the contract with the client and the credentials to their estate. */
  'MSP',
  /** The client organisation whose security posture is being assured. */
  'CLIENT',
  /** A source of evidence: a cloud tenant, an endpoint manager, a document. */
  'EVIDENCE_SOURCE',
] as const;
export type OperatingParty = (typeof OPERATING_PARTIES)[number];
export const operatingPartySchema = z.enum(OPERATING_PARTIES);

export interface OperatingActor {
  readonly key: string;
  readonly name: string;
  readonly party: OperatingParty;
  /** The role in the authority model this actor holds. Checked to exist. */
  readonly role: Role;
  /** The surface they work on. Checked against the role's valid scopes. */
  readonly surface: Surface;
  /** What they are accountable for, in one sentence. */
  readonly accountableFor: string;
  /** What they may decide without asking anybody. */
  readonly decidesAlone: readonly Permission[];
  /** What they may never do, whatever the pressure. */
  readonly neverDoes: readonly string[];
}

/**
 * The people in the model.
 *
 * `ORG_*` roles are the client's own staff; `MSP_*` are the MSP's. That two
 * populations hold different roles on different surfaces is the whole tenancy
 * design, and stating it as actors makes it legible to somebody who will never
 * read `authz.ts`.
 */
export const OPERATING_ACTORS: readonly OperatingActor[] = [
  {
    key: 'msp.owner',
    name: 'MSP owner or principal',
    party: 'MSP',
    role: 'MSP_OWNER',
    surface: 'ADERICEL_MSP',
    accountableFor:
      'The commercial relationship with each client, and the MSP’s own use of Adericel.',
    decidesAlone: ['msp:organisation:create', 'msp:member:manage', 'msp:billing:manage'],
    neverDoes: [
      'Approve an action they themselves proposed — four-eyes is structural, not procedural.',
      'See another MSP’s portfolio, roster or commercial position.',
    ],
  },
  {
    key: 'msp.assurance_engineer',
    name: 'MSP assurance engineer',
    party: 'MSP',
    role: 'MSP_ANALYST',
    surface: 'ADERICEL_MSP',
    accountableFor:
      'Keeping each client’s assurance position true: connectors working, unknowns resolved, ' +
      'exceptions reviewed.',
    decidesAlone: ['org:assessment:run', 'org:evidence:write', 'org:claim:write'],
    neverDoes: [
      'Approve an action against a client estate alone — that needs a second named human.',
      'Choose between two disagreeing sources without recording which is authoritative.',
      'Mark a client’s S1 support case resolved without the client confirming.',
    ],
  },
  {
    key: 'msp.approver',
    name: 'MSP approver',
    party: 'MSP',
    role: 'ORG_APPROVER',
    surface: 'ADERICEL_MSP',
    accountableFor: 'Authorising changes Adericel proposes against a client estate.',
    decidesAlone: ['org:action:approve', 'org:exception:approve'],
    neverDoes: [
      'Approve their own proposal.',
      'Approve without a second factor — step-up is required at the point of approval.',
      'Approve a request that has changed since it was proposed; the approval binds to a digest.',
    ],
  },
  {
    key: 'client.owner',
    name: 'Client organisation owner',
    party: 'CLIENT',
    role: 'ORG_ADMIN',
    surface: 'ADERICEL_CLIENT',
    accountableFor:
      'Their organisation’s own assurance record, the attestations only they can make, and ' +
      'consent for what Adericel may observe.',
    decidesAlone: ['org:member:manage', 'org:integration:manage', 'org:export'],
    neverDoes: [
      'See their MSP’s commercial position, price or other clients.',
      'Alter the history of what Adericel previously asserted.',
    ],
  },
  {
    key: 'client.staff',
    name: 'Client staff member',
    party: 'CLIENT',
    role: 'ORG_READONLY',
    surface: 'ADERICEL_CLIENT',
    accountableFor:
      'Reading their own organisation’s position and answering what is asked of them.',
    decidesAlone: [],
    neverDoes: ['Change any assurance state.', 'Reach any organisation other than their own.'],
  },
  {
    key: 'veylith.platform',
    name: 'Veylith platform administrator',
    party: 'VEYLITH',
    role: 'PLATFORM_ADMIN',
    surface: 'VEYLITH_INTERNAL',
    accountableFor: 'Running the platform: availability, releases, tenancy provisioning.',
    decidesAlone: ['platform:admin', 'platform:read'],
    neverDoes: [
      'Read any client’s assurance data, estate or personal data — a platform grant is honoured ' +
        'on neither Adericel surface.',
      'Reach a client estate without break-glass: four hours, justified, second factor, MSP ' +
        'told at the time, reviewed afterwards.',
      'Approve anything on a client’s behalf.',
    ],
  },
];

/** Who owns a piece of evidence, and therefore who may do what with it. */
export interface EvidenceOwnership {
  readonly sourceKind: string;
  /** Whose estate it describes. Always the client. */
  readonly describes: 'CLIENT';
  /** Who holds the credential that collects it. */
  readonly credentialHeldBy: OperatingParty;
  /** Who may read it. */
  readonly readableBy: readonly OperatingParty[];
  /** Who it leaves with when the relationship ends. */
  readonly leavesWith: OperatingParty;
  readonly note: string;
}

export const EVIDENCE_OWNERSHIP: readonly EvidenceOwnership[] = [
  {
    sourceKind: 'Cloud tenant (Entra, Google Workspace)',
    describes: 'CLIENT',
    credentialHeldBy: 'MSP',
    readableBy: ['MSP', 'CLIENT'],
    leavesWith: 'CLIENT',
    note:
      'The MSP holds the credential because they administer the tenant. The evidence describes ' +
      'the client and belongs to them: it exports with them, and Veylith cannot read it at all.',
  },
  {
    sourceKind: 'Endpoint management (Intune)',
    describes: 'CLIENT',
    credentialHeldBy: 'MSP',
    readableBy: ['MSP', 'CLIENT'],
    leavesWith: 'CLIENT',
    note: 'As above. Device-level detail is the most sensitive routine evidence Adericel holds.',
  },
  {
    sourceKind: 'Document or policy supplied by the client',
    describes: 'CLIENT',
    credentialHeldBy: 'CLIENT',
    readableBy: ['MSP', 'CLIENT'],
    leavesWith: 'CLIENT',
    note:
      'Uploaded by the client or the MSP on their behalf. Where inference reads it, that ' +
      'happens on infrastructure the operator controls unless they have signed an ' +
      'acknowledgement saying otherwise.',
  },
  {
    sourceKind: 'Human attestation',
    describes: 'CLIENT',
    credentialHeldBy: 'CLIENT',
    readableBy: ['MSP', 'CLIENT'],
    leavesWith: 'CLIENT',
    note:
      'A named person’s assertion, with their name against it. The only source for facts no ' +
      'API reports, and the reason an attestation is never anonymous.',
  },
];

/** A review responsibility: who checks what, and on what trigger. */
export interface ReviewResponsibility {
  readonly what: string;
  readonly by: OperatingParty;
  readonly trigger: string;
  /** Whether the system enforces it or merely surfaces it. Stated honestly. */
  readonly enforcement: 'ENFORCED' | 'SURFACED';
}

export const REVIEW_RESPONSIBILITIES: readonly ReviewResponsibility[] = [
  {
    what: 'An action proposed against a client estate',
    by: 'MSP',
    trigger: 'Before execution, always.',
    enforcement: 'ENFORCED',
  },
  {
    what: 'An AI-suggested claim',
    by: 'MSP',
    trigger: 'Before the Truth Engine will consider it.',
    enforcement: 'ENFORCED',
  },
  {
    what: 'An exception to a control',
    by: 'MSP',
    trigger: 'At its review date.',
    enforcement: 'SURFACED',
  },
  {
    what: 'A break-glass grant Veylith opened',
    by: 'VEYLITH',
    trigger: 'After it closes, whether or not it turned out to be warranted.',
    enforcement: 'SURFACED',
  },
  {
    what: 'A questionnaire answer before submission',
    by: 'MSP',
    trigger: 'Before the file leaves.',
    enforcement: 'ENFORCED',
  },
  {
    what: 'An S1 or S2 support case',
    by: 'CLIENT',
    trigger: 'Before it may be recorded as resolved.',
    enforcement: 'ENFORCED',
  },
];

/** Where something goes when it cannot be settled where it arose. */
export interface EscalationPath {
  readonly from: OperatingParty;
  readonly to: OperatingParty;
  readonly about: string;
  readonly note: string;
}

export const ESCALATION_PATHS: readonly EscalationPath[] = [
  {
    from: 'CLIENT',
    to: 'MSP',
    about: 'Anything at all, by default.',
    note:
      'The §2 distribution boundary: Adericel is delivered through the MSP, so a client request ' +
      'goes to them. Enforced in routing and again in reassignment.',
  },
  {
    from: 'MSP',
    to: 'VEYLITH',
    about: 'A product defect, a coverage gap, a platform problem.',
    note: 'The supported escalation path. This is what the relationship is for.',
  },
  {
    from: 'CLIENT',
    to: 'VEYLITH',
    about: 'A security concern, and nothing else.',
    note:
      'The one exception. If the platform is what is compromised, routing through the MSP costs ' +
      'time and may route through an affected party. It discloses no estate data.',
  },
  {
    from: 'MSP',
    to: 'CLIENT',
    about: 'An attestation only the client can make, or consent only they can give.',
    note:
      'Not an escalation upward but the commonest real blocker: the MSP cannot answer a ' +
      'question about how the client’s business operates.',
  },
];

/** A point at which the client, not the MSP, has to say yes. */
export interface ClientApprovalPoint {
  readonly what: string;
  readonly why: string;
}

export const CLIENT_APPROVAL_POINTS: readonly ClientApprovalPoint[] = [
  {
    what: 'Consent for Adericel to observe a source',
    why: 'It is their estate. Withdrawn consent stops collection, and Adericel does not look again.',
  },
  {
    what: 'An attestation about how the organisation operates',
    why: 'No API reports it, and nobody at the MSP can assert it on their behalf.',
  },
  {
    what: 'Resolution of an S1 or S2 support case',
    why:
      'Those are the severities where something Adericel asserted or maintained was wrong. The ' +
      'client is the only party who can confirm it no longer is.',
  },
  {
    what: 'A questionnaire submission that carries their name',
    why: 'They are the party standing behind the answers to a third party.',
  },
  {
    what: 'Direct support by Veylith rather than through the MSP',
    why:
      'A signed agreement, and the MSP agrees too. Ships granted to nobody: the gate exists ' +
      'because §22 requires it, and shipping it closed means the MSP sees a system that ' +
      'structurally cannot go round them.',
  },
];

/**
 * What each commercial state means operationally, for the MSP running the
 * account rather than for the billing system.
 *
 * Checked against `COMMERCIAL_STATES` so a state cannot be added without
 * deciding what it does to the operating model.
 */
export interface AccountStateMeaning {
  readonly state: CommercialState;
  readonly forTheMsp: string;
  readonly forTheClient: string;
}

export const ACCOUNT_STATE_MEANINGS: readonly AccountStateMeaning[] = [
  {
    state: 'DRAFT',
    forTheMsp: 'Agreed, not provisioned. No work to do.',
    forTheClient: 'Nothing yet.',
  },
  {
    state: 'TRIAL',
    forTheMsp: 'Full service, no charge, bounded.',
    forTheClient: 'Everything works.',
  },
  { state: 'ACTIVE', forTheMsp: 'Business as usual.', forTheClient: 'Everything works.' },
  {
    state: 'PAST_DUE',
    forTheMsp: 'A finance conversation. Nothing operational changes.',
    forTheClient: 'No change. They may not know.',
  },
  {
    state: 'PAYMENT_PLAN',
    forTheMsp: 'Service continues; do not take on new chargeable organisations.',
    forTheClient: 'No change.',
  },
  {
    state: 'COMMERCIAL_RESTRICTION',
    forTheMsp: 'Existing clients continue. New ones wait.',
    forTheClient: 'No change for those already on.',
  },
  {
    state: 'COMMERCIAL_SUSPENSION',
    forTheMsp: 'Assurance stops being maintained. Tell the client before it happens.',
    forTheClient: 'They can still read and export everything. It stops being updated.',
  },
  {
    state: 'TERMINATED',
    forTheMsp: 'Retention window running. Help them export.',
    forTheClient: 'They can still read and export everything throughout.',
  },
  {
    state: 'ARCHIVED',
    forTheMsp: 'Closed. Nothing further happens.',
    forTheClient: 'Retention has elapsed.',
  },
  {
    state: 'UNKNOWN',
    forTheMsp:
      'The billing provider cannot be reached. Everything running keeps running; do not take ' +
      'on new chargeable organisations until it clears.',
    forTheClient: 'No change.',
  },
];

/**
 * Whether an actor's declared solo decisions are ones their role actually
 * holds.
 *
 * Exposed as a function rather than asserted in a test only, because a UI that
 * renders this model should be able to show the discrepancy rather than
 * rendering a model the system does not implement.
 */
export function operatingModelDiscrepancies(): readonly string[] {
  const problems: string[] = [];

  for (const actor of OPERATING_ACTORS) {
    const held = ROLE_PERMISSIONS[actor.role];
    if (!held) {
      problems.push(`${actor.key}: role ${actor.role} does not exist in the authority model.`);
      continue;
    }
    for (const permission of actor.decidesAlone) {
      if (!held.includes(permission)) {
        problems.push(
          `${actor.key}: claims to decide ${permission} alone, but ${actor.role} does not hold it.`,
        );
      }
    }
    const scopes = Object.entries(ROLES_VALID_IN_SCOPE)
      .filter(([, roles]) => (roles as readonly Role[]).includes(actor.role))
      .map(([scope]) => scope);
    if (scopes.length === 0) {
      problems.push(`${actor.key}: role ${actor.role} is valid in no scope.`);
    }
  }

  return problems;
}
