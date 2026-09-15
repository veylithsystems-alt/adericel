/**
 * System framework definitions.
 *
 * Requirements carry the control keys that satisfy them in their description,
 * which is how onboarding maps an organisation's controls onto the frameworks
 * it has adopted. One control implementation therefore satisfies requirements
 * across several frameworks at once, which is where an MSP's leverage comes
 * from.
 */

export interface SeedRequirement {
  readonly key: string;
  readonly title: string;
  /** Control keys that contribute to this requirement. */
  readonly controlKeys: readonly string[];
  readonly weight?: number;
}

export interface SeedFramework {
  readonly key: string;
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly description: string;
  readonly requirements: readonly SeedRequirement[];
}

export const SYSTEM_FRAMEWORKS: readonly SeedFramework[] = [
  {
    key: 'cyber-essentials',
    name: 'Cyber Essentials',
    version: '3.2',
    publisher: 'NCSC / IASME',
    description:
      'The five technical control themes of the UK Cyber Essentials scheme. Adericel maintains ' +
      'continuous readiness against these controls; it does not confer certification.',
    requirements: [
      {
        key: 'CE.1',
        title: 'Firewalls',
        controlKeys: ['ce.firewalls.boundary', 'ce.firewalls.host'],
      },
      {
        key: 'CE.2',
        title: 'Secure configuration',
        controlKeys: [
          'ce.secure_config.no_default_credentials',
          'ce.secure_config.autorun_disabled',
        ],
      },
      {
        key: 'CE.3',
        title: 'Security update management',
        controlKeys: ['ce.updates.applied_within_14_days', 'ce.updates.supported_software'],
      },
      {
        key: 'CE.4',
        title: 'User access control',
        controlKeys: ['ce.access.mfa_on_cloud_services', 'ce.access.admin_separation'],
      },
      {
        key: 'CE.5',
        title: 'Malware protection',
        controlKeys: ['ce.malware.protection_active'],
      },
    ],
  },
  {
    key: 'adericel-baseline',
    name: 'Adericel Assurance Baseline',
    version: '1.0',
    publisher: 'Adericel',
    description:
      'A vendor-neutral assurance baseline covering identity, endpoint, vulnerability management, ' +
      'data resilience, governance and cloud configuration.',
    requirements: [
      {
        key: 'AB.1',
        title: 'Identity is protected',
        controlKeys: [
          'identity.mfa.enforced',
          'identity.admin.count_limited',
          'identity.dormant.disabled',
          'identity.password.policy',
        ],
        weight: 2,
      },
      {
        key: 'AB.2',
        title: 'Endpoints are hardened and current',
        controlKeys: [
          'device.disk.encrypted',
          'device.endpoint_protection.active',
          'device.os.supported',
        ],
        weight: 2,
      },
      {
        key: 'AB.3',
        title: 'Vulnerabilities are remediated within agreed windows',
        controlKeys: ['vulnerability.critical.remediated', 'patch.cadence.met'],
        weight: 2,
      },
      {
        key: 'AB.4',
        title: 'Data is recoverable',
        controlKeys: ['backup.recent_success', 'backup.restore_tested'],
        weight: 2,
      },
      {
        key: 'AB.5',
        title: 'Governance is maintained',
        controlKeys: [
          'policy.published_and_current',
          'supplier.assurance_current',
          'training.completion_rate',
        ],
      },
      {
        key: 'AB.6',
        title: 'Cloud configuration is safe',
        controlKeys: ['cloud.storage.not_public', 'logging.retained'],
        weight: 2,
      },
    ],
  },
];
