/**
 * The record of processing, as code.
 *
 * Every organisation that processes personal data has to keep a record of what
 * it holds, why, on what basis, and for how long (UK GDPR Article 30). That
 * record is normally a spreadsheet, and a spreadsheet is wrong within a month
 * of being written, because nothing fails when a migration adds a column and
 * nobody updates the document.
 *
 * So the record lives here, next to the code, and
 * `tests/security/personal-data.test.ts` holds it against the live schema in
 * both directions: every entry must name a table and columns that exist, and
 * every column in the database whose name suggests personal data must appear
 * here or be explicitly exonerated. The register cannot silently go stale.
 *
 * It is also the thing erasure and retention are driven from, rather than a
 * document that describes what some other code is believed to do.
 *
 * The register is not legal advice and does not make Veylith compliant on its
 * own. It makes the factual half of compliance — what is actually held, and
 * what the code actually does with it — true rather than asserted.
 */

/** Whose data it is. This decides who can ask for it and who answers. */
export const DATA_SUBJECT_KINDS = [
  /** Someone with an Adericel login: MSP staff, customer staff, Veylith staff. */
  'PLATFORM_USER',
  /** A business contact Veylith approached. Never a consumer. */
  'PROSPECT',
  /**
   * A person inside a customer's estate, observed through a connector: an
   * account name, a device owner, a mailbox. Veylith is a processor for these
   * and never contacts them; a request from one of them is answered by the
   * customer, with Adericel's assistance.
   */
  'CUSTOMER_END_USER',
] as const;
export type DataSubjectKind = (typeof DATA_SUBJECT_KINDS)[number];

export const LAWFUL_BASES = [
  'CONTRACT',
  'LEGITIMATE_INTERESTS',
  'LEGAL_OBLIGATION',
  'CONSENT',
] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];

/**
 * What happens to this data when erasure is requested and granted.
 *
 * `PSEUDONYMISE` is not `DELETE` and the difference is never blurred. Saying
 * "erased" of a record that still exists in a re-identifiable form would be the
 * same class of untruth as calling an unverified control PASS.
 */
export const ERASURE_TREATMENTS = [
  /** The row goes. */
  'DELETE',
  /**
   * The row stays; the fields that identify a person are irreversibly replaced.
   * Used where destroying the row would destroy the integrity of a record
   * somebody else is entitled to — an audit trail, an approval, an assessment.
   */
  'PSEUDONYMISE',
  /**
   * Kept, because it is needed to establish, exercise or defend a legal claim,
   * or because a legal obligation requires it. Refusing erasure is lawful here,
   * and the refusal is stated to the person rather than quietly applied.
   */
  'RETAIN_FOR_LEGAL_CLAIMS',
] as const;
export type ErasureTreatment = (typeof ERASURE_TREATMENTS)[number];

export const RETENTION_POLICIES = [
  /** Held while the account or organisation is live; goes when it goes. */
  'WHILE_ACTIVE',
  /** Held for a fixed number of days from the row's own clock, then acted on. */
  'FIXED_PERIOD',
  /** Held until the organisation is closed and erasure is requested. */
  'UNTIL_ORGANISATION_ERASED',
] as const;
export type RetentionPolicy = (typeof RETENTION_POLICIES)[number];

export interface RetentionRule {
  readonly policy: RetentionPolicy;
  /** Days from `timestampColumn`. Required for FIXED_PERIOD, null otherwise. */
  readonly days: number | null;
  /** The column the period is measured from. Required for FIXED_PERIOD. */
  readonly timestampColumn: string | null;
  /** Why this period and not another. Every one of these is a judgement. */
  readonly rationale: string;
}

export interface PersonalDataEntry {
  /** Schema-qualified when it is not in the default schema. */
  readonly table: string;
  /** The columns in this table that are, or can identify, personal data. */
  readonly columns: readonly string[];
  readonly subject: DataSubjectKind;
  /** Veylith's role for this data. Decides who answers a request about it. */
  readonly role: 'CONTROLLER' | 'PROCESSOR';
  readonly purpose: string;
  readonly lawfulBasis: LawfulBasis;
  readonly retention: RetentionRule;
  readonly erasure: ErasureTreatment;
  /** Article 9 special category data. Adericel holds none, and this proves it. */
  readonly specialCategory: boolean;
}

const NO_SPECIAL_CATEGORY = false;

export const PERSONAL_DATA_REGISTRY: readonly PersonalDataEntry[] = [
  // ---------------------------------------------------------------------------
  // People with an Adericel login. Veylith is the controller for these.
  // ---------------------------------------------------------------------------
  {
    table: 'users',
    columns: ['email', 'display_name'],
    subject: 'PLATFORM_USER',
    role: 'CONTROLLER',
    purpose: 'Identify the person signing in, and attribute what they decided.',
    lawfulBasis: 'CONTRACT',
    retention: {
      policy: 'WHILE_ACTIVE',
      days: null,
      timestampColumn: null,
      rationale:
        'An account that no longer exists cannot sign in, and the attribution left ' +
        'behind in the audit trail is held under its own entry rather than this one.',
    },
    erasure: 'PSEUDONYMISE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },
  {
    table: 'msps',
    columns: ['contact_email'],
    subject: 'PLATFORM_USER',
    role: 'CONTROLLER',
    purpose: 'Reach the MSP about its own account: billing, incidents, service notices.',
    lawfulBasis: 'CONTRACT',
    retention: {
      policy: 'WHILE_ACTIVE',
      days: null,
      timestampColumn: null,
      rationale: 'Needed for as long as there is a contract to service.',
    },
    erasure: 'PSEUDONYMISE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },
  {
    table: 'sessions',
    columns: ['source_ip', 'user_agent'],
    subject: 'PLATFORM_USER',
    role: 'CONTROLLER',
    purpose:
      'Let a person see and end their own sessions, and let an investigation ' +
      'establish where a session was used from.',
    lawfulBasis: 'LEGITIMATE_INTERESTS',
    retention: {
      policy: 'FIXED_PERIOD',
      days: 90,
      timestampColumn: 'expires_at',
      rationale:
        'Ninety days after a session expires is long enough to investigate an ' +
        'account compromise reported late, and short enough that a location ' +
        'history does not accumulate.',
    },
    erasure: 'DELETE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },
  {
    table: 'mfa_challenges',
    columns: ['source_ip', 'user_agent'],
    subject: 'PLATFORM_USER',
    role: 'CONTROLLER',
    purpose: 'Detect and investigate attempts to defeat a second factor.',
    lawfulBasis: 'LEGITIMATE_INTERESTS',
    retention: {
      policy: 'FIXED_PERIOD',
      days: 90,
      timestampColumn: 'created_at',
      rationale: 'Same reasoning as sessions: useful to an investigation, not a history.',
    },
    erasure: 'DELETE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },
  {
    table: 'audit_log',
    columns: ['actor_id', 'actor_display'],
    subject: 'PLATFORM_USER',
    role: 'PROCESSOR',
    purpose:
      'Say who decided what. An assurance record that cannot name the person who ' +
      'authorised a change to a customer estate is not evidence of anything.',
    lawfulBasis: 'LEGAL_OBLIGATION',
    retention: {
      policy: 'FIXED_PERIOD',
      days: 2555,
      timestampColumn: 'occurred_at',
      rationale:
        'Seven years, matching the ordinary limitation period for a contractual ' +
        'claim in England and Wales plus a margin. This is the record a customer ' +
        'or an insurer would need if a decision is later disputed.',
    },
    erasure: 'RETAIN_FOR_LEGAL_CLAIMS',
    specialCategory: NO_SPECIAL_CATEGORY,
  },
  {
    table: 'audit_log',
    columns: ['source_ip', 'user_agent'],
    subject: 'PLATFORM_USER',
    role: 'PROCESSOR',
    purpose: 'Establish where an action was taken from, during an investigation.',
    lawfulBasis: 'LEGITIMATE_INTERESTS',
    retention: {
      policy: 'FIXED_PERIOD',
      days: 400,
      timestampColumn: 'occurred_at',
      rationale:
        'Thirteen months: long enough to cover an annual audit cycle and a breach ' +
        'discovered a year late. The audit entry itself survives; only the network ' +
        'identifiers are removed, because who decided is the part that matters ' +
        'seven years on and where they were sitting is not.',
    },
    erasure: 'PSEUDONYMISE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },
  {
    table: 'approval_decisions',
    columns: ['source_ip'],
    subject: 'PLATFORM_USER',
    role: 'PROCESSOR',
    purpose: 'Evidence that a four-eyes approval was made by a person at a place.',
    lawfulBasis: 'LEGITIMATE_INTERESTS',
    retention: {
      policy: 'FIXED_PERIOD',
      days: 400,
      timestampColumn: 'decided_at',
      rationale:
        'The approval and the approver are kept with the action for as long as the ' +
        'action record lives. The address is only useful while an incident could ' +
        'still be under investigation.',
    },
    erasure: 'PSEUDONYMISE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },
  {
    table: 'passport_share_views',
    columns: ['source_ip', 'user_agent'],
    subject: 'PLATFORM_USER',
    role: 'PROCESSOR',
    purpose:
      'Tell a customer who has opened the assurance record they shared, which is ' +
      'the point of a share being revocable at all.',
    lawfulBasis: 'LEGITIMATE_INTERESTS',
    retention: {
      policy: 'FIXED_PERIOD',
      days: 400,
      timestampColumn: 'viewed_at',
      rationale:
        'A customer needs to know an insurer opened their passport during this ' +
        'renewal cycle. They do not need a permanent log of a third party.',
    },
    erasure: 'PSEUDONYMISE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },
  {
    table: 'invitations',
    columns: ['email'],
    subject: 'PLATFORM_USER',
    role: 'CONTROLLER',
    purpose: 'Send someone an invitation to an organisation, and let them accept it.',
    lawfulBasis: 'CONTRACT',
    retention: {
      policy: 'FIXED_PERIOD',
      days: 90,
      timestampColumn: 'expires_at',
      rationale:
        'An invitation that expired three months ago has done its work or failed. ' +
        'Keeping the address of someone who never accepted is holding data about a ' +
        'person who never became a user.',
    },
    erasure: 'DELETE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },
  {
    table: 'signups',
    columns: ['email', 'contact_name', 'requested_ip'],
    subject: 'PLATFORM_USER',
    role: 'CONTROLLER',
    purpose: 'Complete a self-serve signup, and resist automated abuse of the form.',
    lawfulBasis: 'CONTRACT',
    retention: {
      policy: 'FIXED_PERIOD',
      days: 90,
      timestampColumn: 'created_at',
      rationale:
        'A signup that was never completed is an abandoned form. Ninety days ' +
        'allows someone to come back to a verification email they ignored.',
    },
    erasure: 'DELETE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },

  // ---------------------------------------------------------------------------
  // Business contacts Veylith approached. Controller, legitimate interests,
  // B2B only.
  // ---------------------------------------------------------------------------
  {
    table: 'veylith.prospects',
    columns: ['contact_email', 'contact_name'],
    subject: 'PROSPECT',
    role: 'CONTROLLER',
    purpose: 'Approach an MSP about Adericel, and remember not to approach it twice.',
    lawfulBasis: 'LEGITIMATE_INTERESTS',
    retention: {
      policy: 'FIXED_PERIOD',
      days: 730,
      timestampColumn: 'updated_at',
      rationale:
        'Two years without engagement, after which continuing to hold a named ' +
        "person's details for a conversation that never happened is not a " +
        'legitimate interest any more.',
    },
    erasure: 'DELETE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },

  // ---------------------------------------------------------------------------
  // People inside a customer's estate. Veylith is a processor. These are the
  // records a customer's own staff appear in, observed through connectors.
  // ---------------------------------------------------------------------------
  {
    table: 'observations',
    columns: ['subject_external_id', 'payload'],
    subject: 'CUSTOMER_END_USER',
    role: 'PROCESSOR',
    purpose:
      'Record what a connector saw — that an account exists, that it has a second ' +
      'factor, that a device is encrypted — so a control can be determined from ' +
      'facts rather than from an assertion.',
    lawfulBasis: 'CONTRACT',
    retention: {
      policy: 'FIXED_PERIOD',
      days: 400,
      timestampColumn: 'observed_at',
      rationale:
        'Superseded observations are pruned by the existing purge job. The ceiling ' +
        'is thirteen months so that a full annual cycle can be replayed and an ' +
        'assessment re-derived from the inputs it actually used.',
    },
    erasure: 'DELETE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },
  {
    table: 'claims',
    columns: ['subject_external_id'],
    subject: 'CUSTOMER_END_USER',
    role: 'PROCESSOR',
    purpose: 'Hold the current believed state of one subject against one predicate.',
    lawfulBasis: 'CONTRACT',
    retention: {
      policy: 'UNTIL_ORGANISATION_ERASED',
      days: null,
      timestampColumn: null,
      rationale:
        'A claim is the current truth about a control. It stops being held when ' +
        'the organisation it belongs to is erased, not before.',
    },
    erasure: 'DELETE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },
  {
    table: 'claim_conflicts',
    columns: ['subject_external_id'],
    subject: 'CUSTOMER_END_USER',
    role: 'PROCESSOR',
    purpose: 'Record that two sources disagreed about one subject, so neither is believed.',
    lawfulBasis: 'CONTRACT',
    retention: {
      policy: 'UNTIL_ORGANISATION_ERASED',
      days: null,
      timestampColumn: null,
      rationale: 'Held with the claim it disputes.',
    },
    erasure: 'DELETE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },
  {
    table: 'graph_nodes',
    columns: ['external_id', 'label'],
    subject: 'CUSTOMER_END_USER',
    role: 'PROCESSOR',
    purpose:
      'Name the things assurance is about. Where the thing is a person — an ' +
      'identity, a mailbox, a laptop with an owner — the name is personal data.',
    lawfulBasis: 'CONTRACT',
    retention: {
      policy: 'UNTIL_ORGANISATION_ERASED',
      days: null,
      timestampColumn: null,
      rationale: 'The estate map is the record; it goes when the organisation is erased.',
    },
    erasure: 'DELETE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },
  {
    table: 'evidence',
    columns: ['payload', 'storage_key', 'collected_by_actor'],
    subject: 'CUSTOMER_END_USER',
    role: 'PROCESSOR',
    purpose:
      'Hold the artefact a determination rests on. Uploaded evidence is whatever ' +
      'the customer uploaded, so it must be assumed to contain personal data.',
    lawfulBasis: 'CONTRACT',
    retention: {
      policy: 'UNTIL_ORGANISATION_ERASED',
      days: null,
      timestampColumn: null,
      rationale:
        'Evidence outlives the assessment that used it, because an assessment ' +
        'nobody can re-derive is an opinion. It goes when the organisation does.',
    },
    erasure: 'DELETE',
    specialCategory: NO_SPECIAL_CATEGORY,
  },
];

/** Every table named in the register, deduplicated. */
export function registeredTables(): readonly string[] {
  return [...new Set(PERSONAL_DATA_REGISTRY.map((entry) => entry.table))].sort();
}

/** Every entry with a fixed retention period, which is what the sweep acts on. */
export function timeLimitedEntries(): readonly PersonalDataEntry[] {
  return PERSONAL_DATA_REGISTRY.filter((entry) => entry.retention.policy === 'FIXED_PERIOD');
}

/**
 * Whether a column name looks like personal data.
 *
 * Used by the register's own test to search the live schema for anything that
 * should have been declared. Deliberately over-broad: a false positive costs
 * one line in an exoneration list, and a false negative is personal data
 * nobody knows is being held.
 */
const PERSONAL_DATA_NAME =
  /(email|source_ip|requested_ip|user_agent|display_name|contact_name|full_name|phone|first_name|last_name|postcode|address|subject_external_id)/i;

export function looksPersonal(columnName: string): boolean {
  return PERSONAL_DATA_NAME.test(columnName);
}
