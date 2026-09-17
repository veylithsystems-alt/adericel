/**
 * Cyber Essentials v3.3: what the scheme asks for, and what Adericel can see.
 *
 * Contract v3.1 §4 and §12, gap-report item C2. The wedge does not work without
 * this: an MSP buys Adericel to keep Cyber Essentials readiness true between
 * assessments, and a system that covers half the requirements while presenting
 * a single readiness figure is worse than one that covers none — it produces
 * confidence in a position nobody has checked.
 *
 * WHAT THIS FILE IS
 *
 * A map, not a ruleset. Each entry names a requirement, the predicates that
 * would evidence it, and — the part that matters — an honest verdict on whether
 * Adericel can actually observe it:
 *
 *   OBSERVED       a connector supplies every predicate the requirement needs
 *   PARTIAL        some predicates arrive; the requirement cannot be decided
 *   ATTESTED_ONLY  no connector can see this; a human must assert it
 *   NOT_OBSERVABLE nothing in a cloud API could establish it, ever
 *
 * `ATTESTED_ONLY` and `NOT_OBSERVABLE` are different claims and are kept apart.
 * The first is a gap that a future connector closes. The second is a statement
 * about the world: no API tells you whether a member of staff has written their
 * password on a note, and pretending otherwise is how a compliance product
 * becomes a liability.
 *
 * WHY A MAP RATHER THAN MORE RULES
 *
 * Writing rules for requirements nothing can observe would produce a ruleset
 * that reports UNKNOWN for two thirds of Cyber Essentials and tells an MSP
 * nothing about why. The map is the thing an MSP can act on: it says which
 * requirements are continuously maintained, which need a person once a year,
 * and which are not Adericel's to answer.
 *
 * SOURCING, STATED PLAINLY
 *
 * The requirement text below is a paraphrase written from the author's
 * knowledge of the scheme, not a quotation from the IASME requirements
 * document, which was not available to the author at the time of writing.
 * Before this is shown to a customer it must be reconciled against the
 * published "Cyber Essentials Requirements for IT Infrastructure v3.3", and
 * `sourceChecked` below is the flag that records whether anyone has done so.
 * It is `false` everywhere, deliberately: the contract forbids claiming
 * compliance coverage merely because a document exists, and that applies to
 * Adericel's own documents first.
 */

export const CE_THEMES = [
  'FIREWALLS',
  'SECURE_CONFIGURATION',
  'SECURITY_UPDATE_MANAGEMENT',
  'USER_ACCESS_CONTROL',
  'MALWARE_PROTECTION',
] as const;
export type CeTheme = (typeof CE_THEMES)[number];

export const OBSERVABILITY = ['OBSERVED', 'PARTIAL', 'ATTESTED_ONLY', 'NOT_OBSERVABLE'] as const;
export type Observability = (typeof OBSERVABILITY)[number];

export interface CeRequirement {
  /** Stable identifier. Theme prefix plus a number, so it can be cited. */
  readonly id: string;
  readonly theme: CeTheme;
  /** A paraphrase. See the sourcing note above. */
  readonly requirement: string;
  /**
   * The canonical predicates that would evidence this requirement, if they
   * arrived. Empty where nothing could.
   */
  readonly predicates: readonly string[];
  readonly observability: Observability;
  /** The ruleset rule that decides it, where one exists. */
  readonly ruleKey: string | null;
  /**
   * Why it is not observed, in the words an MSP would want. Required for
   * anything other than OBSERVED, so a gap always explains itself.
   */
  readonly note: string | null;
  /**
   * Whether the paraphrase has been checked against the published scheme
   * document by a person. False everywhere until somebody does it.
   */
  readonly sourceChecked: false;
}

export const CE_V3_3_REQUIREMENTS: readonly CeRequirement[] = [
  // ------------------------------------------------------------------ Firewalls
  {
    id: 'FW-1',
    theme: 'FIREWALLS',
    requirement: 'A boundary firewall protects every internet-facing device or network.',
    predicates: ['network.firewall.present'],
    observability: 'PARTIAL',
    ruleKey: 'ce.firewalls.boundary',
    note:
      'Adericel observes that a firewall is declared, not that every internet-facing device ' +
      'sits behind one. Establishing the second needs an inventory of what faces the ' +
      'internet, which no current connector supplies.',
    sourceChecked: false,
  },
  {
    id: 'FW-2',
    theme: 'FIREWALLS',
    requirement: 'Inbound connections are blocked by default.',
    predicates: ['network.firewall.default_deny_inbound'],
    observability: 'PARTIAL',
    ruleKey: 'ce.firewalls.boundary',
    note:
      'Observed where the firewall is a cloud resource Adericel can read. An on-premises ' +
      'appliance is attested.',
    sourceChecked: false,
  },
  {
    id: 'FW-3',
    theme: 'FIREWALLS',
    requirement: 'The default administrative password on every firewall has been changed.',
    predicates: ['network.firewall.default_credentials_changed'],
    observability: 'ATTESTED_ONLY',
    ruleKey: null,
    note:
      'No API reports whether a device still has its shipped password. A connector that ' +
      'tried to establish this would have to attempt the default credential, which is an ' +
      'attack, not an observation.',
    sourceChecked: false,
  },
  {
    id: 'FW-4',
    theme: 'FIREWALLS',
    requirement:
      'The firewall administrative interface is not accessible from the internet, or is ' +
      'protected by MFA or an IP allow-list.',
    predicates: ['network.firewall.admin_interface_internet_facing'],
    observability: 'ATTESTED_ONLY',
    ruleKey: null,
    note: 'Requires reading the appliance configuration. No connector reaches network hardware.',
    sourceChecked: false,
  },
  {
    id: 'FW-5',
    theme: 'FIREWALLS',
    requirement:
      'Every open inbound port has a documented business need, approved by an authorised person.',
    predicates: ['network.firewall.open_ports', 'network.firewall.port_justifications'],
    observability: 'ATTESTED_ONLY',
    ruleKey: null,
    note:
      'The ports could in principle be read from a cloud firewall. The business need cannot ' +
      'be: it is a decision recorded by a person, and Adericel holds the record rather than ' +
      'deriving it.',
    sourceChecked: false,
  },
  {
    id: 'FW-6',
    theme: 'FIREWALLS',
    requirement: 'A host-based firewall is enabled on devices used on untrusted networks.',
    predicates: ['device.firewall.enabled', 'device.managed'],
    observability: 'OBSERVED',
    ruleKey: 'ce.firewalls.host',
    note: null,
    sourceChecked: false,
  },

  // -------------------------------------------------------- Secure configuration
  {
    id: 'SC-1',
    theme: 'SECURE_CONFIGURATION',
    requirement: 'Unnecessary user accounts have been removed or disabled.',
    predicates: ['identity.account.enabled', 'identity.last_sign_in_at', 'identity.account.type'],
    observability: 'OBSERVED',
    ruleKey: 'ce.secure_config.dormant_accounts',
    note: null,
    sourceChecked: false,
  },
  {
    id: 'SC-2',
    theme: 'SECURE_CONFIGURATION',
    requirement: 'Default or guessable passwords have been changed.',
    predicates: ['asset.default_credentials_present'],
    observability: 'PARTIAL',
    ruleKey: 'ce.secure_config.no_default_credentials',
    note:
      'Entra reports whether the built-in guest account is enabled, which is the one case a ' +
      'directory can see. A default password on an application or appliance is attested.',
    sourceChecked: false,
  },
  {
    id: 'SC-3',
    theme: 'SECURE_CONFIGURATION',
    requirement: 'Unnecessary software has been removed or disabled.',
    predicates: ['device.software.inventory'],
    observability: 'PARTIAL',
    ruleKey: null,
    note:
      'Intune supplies a detected-application inventory. Deciding which of them are ' +
      '"unnecessary" is a judgement about a business, not a fact about a device, so Adericel ' +
      'presents the inventory and does not score it.',
    sourceChecked: false,
  },
  {
    id: 'SC-4',
    theme: 'SECURE_CONFIGURATION',
    requirement: 'Auto-run and auto-play of untrusted content is disabled.',
    predicates: ['device.autorun_disabled'],
    observability: 'OBSERVED',
    ruleKey: 'ce.secure_config.autorun_disabled',
    note: null,
    sourceChecked: false,
  },
  {
    id: 'SC-5',
    theme: 'SECURE_CONFIGURATION',
    requirement:
      'A device unlocking credential is required, with brute-force protection: either a limit ' +
      'on attempts or a throttle between them.',
    predicates: ['device.lock.required', 'device.lock.max_attempts', 'device.lock.timeout_seconds'],
    observability: 'OBSERVED',
    ruleKey: 'ce.secure_config.device_unlock',
    note: null,
    sourceChecked: false,
  },
  {
    id: 'SC-6',
    theme: 'SECURE_CONFIGURATION',
    requirement:
      'Password-based authentication is protected by one of: multi-factor authentication, a ' +
      'minimum length of twelve characters, or a minimum of eight characters with automatic ' +
      'blocking of common passwords.',
    predicates: [
      'organisation.password.min_length',
      'organisation.password.common_blocked',
      'identity.mfa.enforced',
    ],
    observability: 'OBSERVED',
    ruleKey: 'ce.secure_config.password_policy',
    note: null,
    sourceChecked: false,
  },

  // ----------------------------------------------- Security update management
  {
    id: 'SU-1',
    theme: 'SECURITY_UPDATE_MANAGEMENT',
    requirement: 'All software is licensed and supported by its vendor.',
    predicates: ['device.os.supported', 'asset.vendor_supported'],
    observability: 'PARTIAL',
    ruleKey: 'ce.updates.supported_software',
    note:
      'Operating-system support is observed from the version. Application support needs a ' +
      'vendor lifecycle feed that Adericel does not carry — see RR-068.',
    sourceChecked: false,
  },
  {
    id: 'SU-2',
    theme: 'SECURITY_UPDATE_MANAGEMENT',
    requirement:
      'Security updates rated critical or high are applied within fourteen days of release.',
    predicates: ['vulnerability.high_or_critical_overdue_14d', 'device.patch.last_applied_at'],
    observability: 'PARTIAL',
    ruleKey: 'ce.updates.applied_within_14_days',
    note:
      'The rule exists and decides correctly, but no connector yet supplies patch state. ' +
      'Intune reports when a device last synchronised, which is not when it was last ' +
      'patched, and Windows Update for Business reporting is an asynchronous export job ' +
      'rather than a read. This is the single highest-value gap remaining: it is the ' +
      'requirement most often failed in a real assessment. RR-070.',
    sourceChecked: false,
  },
  {
    id: 'SU-3',
    theme: 'SECURITY_UPDATE_MANAGEMENT',
    requirement: 'Automatic updates are enabled where the vendor provides them.',
    predicates: ['device.updates.automatic_enabled'],
    observability: 'OBSERVED',
    ruleKey: 'ce.updates.automatic_enabled',
    note: null,
    sourceChecked: false,
  },
  {
    id: 'SU-4',
    theme: 'SECURITY_UPDATE_MANAGEMENT',
    requirement: 'Software no longer supported is removed from devices.',
    predicates: ['asset.vendor_supported', 'device.software.inventory'],
    observability: 'PARTIAL',
    ruleKey: null,
    note:
      'Depends on the same vendor lifecycle feed as SU-1, plus an application inventory to ' +
      'know what is installed in the first place.',
    sourceChecked: false,
  },

  // -------------------------------------------------------- User access control
  {
    id: 'UA-1',
    theme: 'USER_ACCESS_CONTROL',
    requirement: 'Every user has a unique account; accounts are not shared.',
    predicates: ['identity.account.shared'],
    observability: 'ATTESTED_ONLY',
    ruleKey: null,
    note:
      'A directory cannot tell an account used by one person from one used by four. Sign-in ' +
      'patterns hint at it and hints are not observations, so Adericel does not assert it.',
    sourceChecked: false,
  },
  {
    id: 'UA-2',
    theme: 'USER_ACCESS_CONTROL',
    requirement: 'Account creation follows a documented approval process.',
    predicates: [],
    observability: 'NOT_OBSERVABLE',
    ruleKey: null,
    note:
      'A process is not a system state. Adericel can hold the documented process as evidence ' +
      'and can show when accounts were created, but whether each one was approved is not a ' +
      'thing any API knows.',
    sourceChecked: false,
  },
  {
    id: 'UA-3',
    theme: 'USER_ACCESS_CONTROL',
    requirement: 'Accounts are removed or disabled when no longer required.',
    predicates: ['identity.account.enabled', 'identity.last_sign_in_at'],
    observability: 'OBSERVED',
    ruleKey: 'ce.secure_config.dormant_accounts',
    note: null,
    sourceChecked: false,
  },
  {
    id: 'UA-4',
    theme: 'USER_ACCESS_CONTROL',
    requirement: 'Multi-factor authentication is enforced on all cloud services.',
    predicates: ['identity.mfa.enforced'],
    observability: 'OBSERVED',
    ruleKey: 'ce.access.mfa_on_cloud_services',
    note: null,
    sourceChecked: false,
  },
  {
    id: 'UA-5',
    theme: 'USER_ACCESS_CONTROL',
    requirement: 'Multi-factor authentication is enforced on every administrative account.',
    predicates: ['identity.mfa.enforced', 'identity.privileged'],
    observability: 'OBSERVED',
    ruleKey: 'ce.access.mfa_on_admin_accounts',
    note: null,
    sourceChecked: false,
  },
  {
    id: 'UA-6',
    theme: 'USER_ACCESS_CONTROL',
    requirement:
      'Administrative accounts are separate from day-to-day accounts and are not used for ' +
      'email or web browsing.',
    predicates: ['identity.privileged', 'identity.admin_account_separate'],
    observability: 'PARTIAL',
    ruleKey: 'ce.access.admin_separation',
    note:
      'Whether an admin account is separate is a question about how a person works, and the ' +
      'directory only shows a name. Adericel observes which accounts are privileged and ' +
      'requires the separation itself to be asserted — deliberately, because a naming ' +
      'convention is not a control.',
    sourceChecked: false,
  },
  {
    id: 'UA-7',
    theme: 'USER_ACCESS_CONTROL',
    requirement: 'Administrative privilege is reviewed and removed when no longer needed.',
    predicates: ['identity.privileged', 'organisation.identity.admin_count'],
    observability: 'PARTIAL',
    ruleKey: null,
    note:
      'Adericel observes the current set of privileged accounts and can show it changing. ' +
      'Whether a review happened is a fact about a meeting.',
    sourceChecked: false,
  },

  // ------------------------------------------------------- Malware protection
  {
    id: 'MP-1',
    theme: 'MALWARE_PROTECTION',
    requirement:
      'Anti-malware software is active on every in-scope device, or execution is restricted ' +
      'to approved applications.',
    predicates: [
      'device.endpoint_protection.installed',
      'device.endpoint_protection.realtime_enabled',
    ],
    observability: 'OBSERVED',
    ruleKey: 'ce.malware.protection_active',
    note: null,
    sourceChecked: false,
  },
  {
    id: 'MP-2',
    theme: 'MALWARE_PROTECTION',
    requirement: 'Malware signatures are kept up to date.',
    predicates: ['device.endpoint_protection.signatures_updated_at'],
    observability: 'OBSERVED',
    ruleKey: 'ce.malware.signatures_current',
    note: null,
    sourceChecked: false,
  },
  {
    id: 'MP-3',
    theme: 'MALWARE_PROTECTION',
    requirement: 'Anti-malware software prevents connections to known-malicious websites.',
    predicates: ['device.endpoint_protection.web_protection_enabled'],
    observability: 'OBSERVED',
    ruleKey: 'ce.malware.web_protection',
    note: null,
    sourceChecked: false,
  },
];

export interface CoverageSummary {
  readonly total: number;
  readonly observed: number;
  readonly partial: number;
  readonly attestedOnly: number;
  readonly notObservable: number;
  /**
   * Requirements Adericel maintains continuously, as a fraction of those it
   * could ever maintain — `NOT_OBSERVABLE` is excluded from the denominator
   * because including it would make the figure a criticism of the scheme
   * rather than a measure of Adericel.
   */
  readonly continuousCoverage: number;
  /** Said with every figure. A percentage without this sentence is a claim. */
  readonly caveat: string;
}

export function summariseCeCoverage(
  requirements: readonly CeRequirement[] = CE_V3_3_REQUIREMENTS,
): CoverageSummary {
  const count = (observability: Observability): number =>
    requirements.filter((r) => r.observability === observability).length;

  const observed = count('OBSERVED');
  const notObservable = count('NOT_OBSERVABLE');
  const observable = requirements.length - notObservable;

  return {
    total: requirements.length,
    observed,
    partial: count('PARTIAL'),
    attestedOnly: count('ATTESTED_ONLY'),
    notObservable,
    continuousCoverage: observable === 0 ? 0 : observed / observable,
    caveat:
      'Continuous coverage counts requirements Adericel observes end to end. It is not a ' +
      'readiness figure, not a certification position, and not a percentage of Cyber ' +
      'Essentials achieved. The requirement paraphrases have not been checked against the ' +
      'published scheme document.',
  };
}

/** Requirements by theme, for a per-theme view an assessor would recognise. */
export function ceRequirementsByTheme(
  theme: CeTheme,
  requirements: readonly CeRequirement[] = CE_V3_3_REQUIREMENTS,
): readonly CeRequirement[] {
  return requirements.filter((requirement) => requirement.theme === theme);
}

/**
 * Which predicates Cyber Essentials needs that no connector supplies.
 *
 * The input is the set of predicates the installed connectors declare, so this
 * answers a real question for a real deployment rather than a general one:
 * "given what I have connected, what is Cyber Essentials still missing".
 */
export function ceObservationGaps(
  suppliedPredicates: readonly string[],
  requirements: readonly CeRequirement[] = CE_V3_3_REQUIREMENTS,
): readonly {
  readonly requirementId: string;
  readonly theme: CeTheme;
  readonly missing: readonly string[];
}[] {
  const supplied = new Set(suppliedPredicates);
  return requirements
    .filter((requirement) => requirement.observability !== 'NOT_OBSERVABLE')
    .map((requirement) => ({
      requirementId: requirement.id,
      theme: requirement.theme,
      missing: requirement.predicates.filter((predicate) => !supplied.has(predicate)),
    }))
    .filter((entry) => entry.missing.length > 0);
}
