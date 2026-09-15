/**
 * Twenty customer shapes.
 *
 * A hundred identical healthy customers would demonstrate nothing. The value of
 * an assurance platform is entirely in how it behaves when things are wrong, so
 * this portfolio is built to be wrong in twenty specific, different ways —
 * including several that look fine from a connector health check and are not.
 *
 * Each archetype names a real operational condition an MSP encounters, and each
 * one should produce a distinguishable outcome in the exception queue. If two
 * archetypes are indistinguishable in the queue, the queue is not saying enough.
 */

export type ArchetypeKey =
  | 'HEALTHY_WELL_OBSERVED'
  | 'HEALTHY_THIN_COVERAGE'
  | 'PARTIALLY_CONFIGURED'
  | 'STALE_EVIDENCE'
  | 'SINGLE_FAILING_CONTROL'
  | 'MULTIPLE_FAILING_CONTROLS'
  | 'CONTRADICTORY_EVIDENCE'
  | 'MISSING_CONNECTOR'
  | 'INSUFFICIENT_PERMISSIONS'
  | 'UNKNOWN_NO_EVIDENCE'
  | 'REMEDIATION_ELIGIBLE'
  | 'REMEDIATION_NEEDS_APPROVAL'
  | 'REMEDIATION_EXECUTED'
  | 'REMEDIATION_FAILED'
  | 'VERIFICATION_FAILED'
  | 'CHANGING_POSTURE'
  | 'REPEATED_EXCEPTIONS'
  | 'NEEDS_HUMAN_REVIEW'
  | 'APPROACHING_DEGRADATION'
  | 'OFFBOARDING';

export interface Archetype {
  readonly key: ArchetypeKey;
  /** What kind of customer this is, in an operator's words. */
  readonly description: string;
  /** What the exception queue should say about them, if anything. */
  readonly expectation: string;
  /** How many of the hundred are this shape. */
  readonly count: number;

  // --- Estate shape ---------------------------------------------------------
  readonly identities: number;
  /** Identities with no second factor. Drives failing controls and findings. */
  readonly identitiesWithoutMfa: number;
  readonly devices: number;
  /** Devices with an unencrypted disk. */
  readonly devicesUnencrypted: number;
  /**
   * Supply the whole estate — backups, cloud, vulnerabilities, policies,
   * configuration — rather than identities and devices alone.
   *
   * A customer without this has controls that can never be determined, which is
   * a legitimate archetype and the default here precisely so that reaching full
   * coverage has to be deliberate.
   */
  readonly fullEstate?: boolean;

  // --- Conditions applied after the estate is built -------------------------
  /** No integration at all: the customer was never connected. */
  readonly noConnector?: boolean;
  /** Connector configured, credentials rejected. */
  readonly authenticationFails?: boolean;
  /** Credentials valid, one capability refused for want of a grant. */
  readonly permissionDenied?: boolean;
  /** Two sources reporting different values for the same subject. */
  readonly conflictingSources?: boolean;
  /** Collection ran long ago and has not run since. */
  readonly staleByDays?: number;
  /** Remediate failing controls, unattended where policy permits. */
  readonly remediate?: boolean;
  /** Dispatch the remediation and make the execution fail. */
  readonly remediationFails?: boolean;
  /** Execute successfully, then make re-observation disagree. */
  readonly verificationFails?: boolean;
  /** Change the estate after the first cycle, so a change is detected. */
  readonly driftAfterFirstCycle?: boolean;
  /** Fix it, break it again, repeatedly. */
  readonly recurrence?: number;
  /** Begin offboarding and stop part-way. */
  readonly offboarding?: boolean;
}

/**
 * The portfolio.
 *
 * Counts are weighted the way a real MSP book looks: most customers are broadly
 * fine, a meaningful minority have something genuinely wrong, and a handful are
 * in states that are individually rare and collectively constant.
 *
 * They sum to 100, and a test asserts that rather than trusting arithmetic done
 * by hand at half past eleven.
 */
export const ARCHETYPES: readonly Archetype[] = [
  {
    key: 'HEALTHY_WELL_OBSERVED',
    description: 'Everything connected, everything observed, everything satisfied.',
    expectation: 'Absent from the exception queue entirely.',
    count: 20,
    identities: 14,
    identitiesWithoutMfa: 0,
    devices: 10,
    devicesUnencrypted: 0,
    fullEstate: true,
  },
  {
    key: 'HEALTHY_THIN_COVERAGE',
    description:
      'Nothing is failing, and Adericel can only see a fraction of the estate. ' +
      'The most dangerous customer in any assurance product, because they look perfect.',
    expectation: 'COVERAGE_GAP. Never reported as assured.',
    count: 8,
    identities: 6,
    identitiesWithoutMfa: 0,
    devices: 0,
    devicesUnencrypted: 0,
  },
  {
    key: 'PARTIALLY_CONFIGURED',
    description: 'Onboarding was started and never finished.',
    expectation: 'COVERAGE_GAP, and a low rung on the coverage ladder.',
    count: 5,
    identities: 4,
    identitiesWithoutMfa: 1,
    devices: 0,
    devicesUnencrypted: 0,
  },
  {
    key: 'STALE_EVIDENCE',
    description: 'Collected once, months ago, and never since. Nobody noticed.',
    expectation: 'EVIDENCE_STALE. The determinations still stand as statements about then.',
    count: 5,
    identities: 10,
    identitiesWithoutMfa: 0,
    devices: 6,
    devicesUnencrypted: 0,
    fullEstate: true,
    staleByDays: 75,
  },
  {
    key: 'SINGLE_FAILING_CONTROL',
    description: 'One control failing, no remediation proposed.',
    expectation: 'REMEDIATION_UNAVAILABLE or an approval, depending on policy.',
    count: 6,
    identities: 12,
    identitiesWithoutMfa: 2,
    devices: 8,
    devicesUnencrypted: 0,
    fullEstate: true,
  },
  {
    key: 'MULTIPLE_FAILING_CONTROLS',
    description: 'Several controls failing at once. A customer in genuine trouble.',
    expectation: 'Multiple exceptions, capped so they cannot flood the queue.',
    count: 5,
    identities: 18,
    identitiesWithoutMfa: 7,
    devices: 12,
    devicesUnencrypted: 5,
    fullEstate: true,
  },
  {
    key: 'CONTRADICTORY_EVIDENCE',
    description: 'Two connected systems disagree about the same person.',
    expectation: 'EVIDENCE_CONFLICT, and the affected controls UNKNOWN rather than guessed.',
    count: 4,
    identities: 10,
    identitiesWithoutMfa: 0,
    devices: 6,
    devicesUnencrypted: 0,
    fullEstate: true,
    conflictingSources: true,
  },
  {
    key: 'MISSING_CONNECTOR',
    description: 'A customer nobody ever connected.',
    expectation: 'NOT_CONNECTED on the ladder. Every control UNKNOWN.',
    count: 4,
    identities: 0,
    identitiesWithoutMfa: 0,
    devices: 0,
    devicesUnencrypted: 0,
    noConnector: true,
  },
  {
    key: 'INSUFFICIENT_PERMISSIONS',
    description:
      'The connector authenticates perfectly and lacks one permission. ' +
      'Green on every health check in this market.',
    expectation: 'CONNECTOR_PERMISSION, naming the exact grant required.',
    count: 4,
    identities: 12,
    identitiesWithoutMfa: 1,
    devices: 8,
    devicesUnencrypted: 0,
    fullEstate: true,
    permissionDenied: true,
  },
  {
    key: 'UNKNOWN_NO_EVIDENCE',
    description: 'Connected, authorised, and the estate simply has nothing to say yet.',
    expectation: 'UNKNOWN held honestly. Never converted to a pass.',
    count: 4,
    identities: 2,
    identitiesWithoutMfa: 0,
    devices: 0,
    devicesUnencrypted: 0,
  },
  {
    key: 'REMEDIATION_ELIGIBLE',
    description: 'Failing, and Adericel is permitted to fix it unattended.',
    expectation: 'Fixed and verified without a person. Absent from the queue.',
    count: 5,
    identities: 12,
    identitiesWithoutMfa: 3,
    devices: 8,
    devicesUnencrypted: 0,
    fullEstate: true,
    remediate: true,
  },
  {
    key: 'REMEDIATION_NEEDS_APPROVAL',
    description: 'Failing, and policy requires a human to authorise the change.',
    expectation: 'APPROVAL_REQUIRED. Nothing changed in the estate yet.',
    count: 5,
    identities: 10,
    identitiesWithoutMfa: 2,
    devices: 8,
    devicesUnencrypted: 2,
    fullEstate: true,
    remediate: true,
  },
  {
    key: 'REMEDIATION_EXECUTED',
    description: 'Was failing, has been fixed, and the fix was independently confirmed.',
    expectation: 'Absent from the queue. This is the product working.',
    count: 5,
    identities: 12,
    identitiesWithoutMfa: 2,
    devices: 8,
    devicesUnencrypted: 0,
    fullEstate: true,
    remediate: true,
  },
  {
    key: 'REMEDIATION_FAILED',
    description: 'The fix was dispatched and the upstream rejected it.',
    expectation: 'AUTOMATION_FAILED. The estate is unchanged and says so.',
    count: 3,
    identities: 10,
    identitiesWithoutMfa: 2,
    devices: 6,
    devicesUnencrypted: 0,
    fullEstate: true,
    remediate: true,
    remediationFails: true,
  },
  {
    key: 'VERIFICATION_FAILED',
    description:
      'The fix was dispatched, the action record says success, and re-observation disagrees. ' +
      'The single most dangerous state in the product.',
    expectation: 'VERIFICATION_FAILED, ranked above almost everything. Never green.',
    count: 2,
    identities: 10,
    identitiesWithoutMfa: 2,
    devices: 6,
    devicesUnencrypted: 0,
    fullEstate: true,
    remediate: true,
    verificationFails: true,
  },
  {
    key: 'CHANGING_POSTURE',
    description: 'Was satisfied. Somebody changed something. Nobody told anybody.',
    expectation: 'DETERIORATION, detected by Adericel rather than reported by the customer.',
    count: 4,
    identities: 14,
    identitiesWithoutMfa: 0,
    devices: 10,
    devicesUnencrypted: 0,
    fullEstate: true,
    driftAfterFirstCycle: true,
  },
  {
    key: 'REPEATED_EXCEPTIONS',
    description: 'The same control keeps failing after being fixed.',
    expectation: 'RECURRING_FAILURE. Automating the loop is not the answer.',
    count: 2,
    identities: 12,
    identitiesWithoutMfa: 2,
    devices: 8,
    devicesUnencrypted: 0,
    fullEstate: true,
    remediate: true,
    recurrence: 3,
  },
  {
    key: 'NEEDS_HUMAN_REVIEW',
    description: 'Failing in a way no connector can fix.',
    expectation: 'REMEDIATION_UNAVAILABLE. Honest about needing a person.',
    count: 3,
    identities: 10,
    identitiesWithoutMfa: 0,
    devices: 8,
    devicesUnencrypted: 4,
    fullEstate: true,
  },
  {
    key: 'APPROACHING_DEGRADATION',
    description: 'Evidence ageing towards the staleness threshold but not yet past it.',
    expectation: 'Not yet an exception. Visible in coverage before it becomes one.',
    count: 4,
    identities: 12,
    identitiesWithoutMfa: 0,
    devices: 8,
    devicesUnencrypted: 0,
    fullEstate: true,
    staleByDays: 20,
  },
  {
    key: 'OFFBOARDING',
    description: 'Leaving, part-way through the process.',
    expectation: 'OFFBOARDING_BLOCKED. Assurance already stopped being asserted.',
    count: 2,
    identities: 8,
    identitiesWithoutMfa: 0,
    devices: 6,
    devicesUnencrypted: 0,
    fullEstate: true,
    offboarding: true,
  },
];

export const PORTFOLIO_SIZE = ARCHETYPES.reduce((total, a) => total + a.count, 0);

/** One entry per customer, in a deterministic order. */
export function portfolioPlan(): readonly { slug: string; archetype: Archetype }[] {
  const plan: { slug: string; archetype: Archetype }[] = [];
  for (const archetype of ARCHETYPES) {
    for (let i = 0; i < archetype.count; i += 1) {
      const name = archetype.key.toLowerCase().replace(/_/g, '-');
      plan.push({ slug: `c${String(plan.length + 1).padStart(3, '0')}-${name}`, archetype });
    }
  }
  return plan;
}
