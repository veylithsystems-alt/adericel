/**
 * Adericel Baseline ruleset v1.
 *
 * A vendor-neutral assurance baseline covering the controls that matter for a
 * small-to-mid-sized organisation managed by an MSP. Each rule is written
 * against canonical claim predicates, never against a specific product's data
 * shape, so a new connector for the same capability requires a normaliser and
 * no rule changes at all.
 */
export const adericelBaselineV1 = {
  key: 'adericel-baseline',
  version: '1.0.0',
  name: 'Adericel Baseline',
  engineVersion: '1.0.0',
  description:
    'Vendor-neutral security assurance baseline covering identity, endpoint, data protection, ' +
    'vulnerability management, backup and supplier assurance.',
  rules: [
    // ---------------------------------------------------------------- identity
    {
      key: 'identity.mfa.enforced',
      title: 'Multi-factor authentication is enforced for all interactive accounts',
      description:
        'Every account that a person can sign in to interactively must require a second factor. ' +
        'Service principals and accounts blocked from sign-in are out of scope.',
      subjectKinds: ['Identity'],
      applicability: {
        op: 'and',
        operands: [
          // Absence of an account-type claim means "not known to be a service
          // account", which conservatively keeps the identity in scope. The
          // default is stated here so it forms part of the ruleset hash.
          {
            op: 'ne',
            left: { op: 'claim', predicate: 'identity.account.type', default: 'USER' },
            right: { op: 'const', value: 'SERVICE' },
          },
          {
            op: 'ne',
            left: { op: 'claim', predicate: 'identity.account.enabled', default: true },
            right: { op: 'const', value: false },
          },
        ],
      },
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'identity.mfa.enforced' },
        right: { op: 'const', value: true },
      },
      aggregation: 'ALL',
      unknownTolerance: 0,
      severity: 'CRITICAL',
      failureTitle: 'Multi-factor authentication is not enforced on every interactive account.',
      failureDescription:
        'Accounts without a second factor are the most common route to account takeover. ' +
        'Enforce MFA for the affected identities.',
      remediation: {
        actionType: 'identity.mfa.require',
        riskClass: 'CONFIGURATION',
        parameterTemplate: { enforcement: 'REQUIRED' },
        rationale: 'Enforce multi-factor authentication on the affected identity.',
      },
      maxEvidenceAgeDays: 7,
    },
    {
      key: 'identity.admin.count_limited',
      title: 'The number of privileged administrators is constrained',
      description:
        'A small, deliberate set of administrators limits blast radius. The permitted count is a ' +
        'control parameter so it can be sized to the organisation.',
      subjectKinds: [],
      aggregation: 'SINGLE',
      expression: {
        op: 'lte',
        left: { op: 'claim', predicate: 'organisation.identity.admin_count' },
        right: { op: 'param', key: 'maxAdministrators', default: 4 },
      },
      defaultParameters: { maxAdministrators: 4 },
      severity: 'HIGH',
      failureTitle: 'More accounts hold administrative privilege than the agreed limit.',
      failureDescription:
        'Review privileged access and remove administrative rights that are not currently required.',
      remediation: null,
      maxEvidenceAgeDays: 14,
    },
    {
      key: 'identity.dormant.disabled',
      title: 'Dormant accounts are disabled',
      description:
        'Accounts unused beyond the dormancy threshold are disabled, removing standing credentials ' +
        'that nobody is monitoring.',
      subjectKinds: ['Identity'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'identity.account.enabled' },
        right: { op: 'const', value: true },
      },
      expression: {
        op: 'not',
        operand: {
          op: 'olderThanDays',
          value: { op: 'claim', predicate: 'identity.last_sign_in_at' },
          days: { op: 'param', key: 'dormancyDays', default: 90 },
        },
      },
      defaultParameters: { dormancyDays: 90 },
      aggregation: 'ALL',
      severity: 'MEDIUM',
      failureTitle: 'Enabled accounts have not been used within the dormancy threshold.',
      failureDescription:
        'Disable accounts that are no longer in use, or record an exception explaining why they remain enabled.',
      remediation: {
        actionType: 'identity.account.disable',
        riskClass: 'DISRUPTIVE',
        parameterTemplate: {},
        rationale: 'Disable the dormant account to remove an unmonitored credential.',
      },
      maxEvidenceAgeDays: 14,
    },
    {
      key: 'identity.password.policy',
      title: 'Password policy meets the minimum standard',
      subjectKinds: [],
      aggregation: 'SINGLE',
      expression: {
        op: 'and',
        operands: [
          {
            op: 'gte',
            left: { op: 'claim', predicate: 'organisation.password.min_length' },
            right: { op: 'param', key: 'minPasswordLength', default: 12 },
          },
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'organisation.password.breach_screening_enabled' },
            right: { op: 'const', value: true },
          },
        ],
      },
      defaultParameters: { minPasswordLength: 12 },
      severity: 'HIGH',
      failureTitle: 'The password policy does not meet the minimum standard.',
      failureDescription:
        'Set a minimum length of at least the configured value and enable screening against known-breached passwords.',
      remediation: null,
      maxEvidenceAgeDays: 30,
    },

    // ---------------------------------------------------------------- endpoint
    {
      key: 'device.disk.encrypted',
      title: 'Managed devices have full-disk encryption enabled',
      subjectKinds: ['Device'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.managed' },
        right: { op: 'const', value: true },
      },
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.disk.encrypted' },
        right: { op: 'const', value: true },
      },
      aggregation: 'ALL',
      severity: 'HIGH',
      failureTitle: 'Managed devices are not encrypted at rest.',
      failureDescription:
        'Enable full-disk encryption on the affected devices so that a lost or stolen device does not disclose data.',
      // No remediation offered. Endpoint posture is changed through Intune
      // configuration profiles, which are tenant-wide objects: a change Adericel
      // made to one would affect devices far beyond the finding that prompted it.
      // Offering a button that cannot safely run is worse than offering none.
      remediation: null,
      maxEvidenceAgeDays: 7,
    },
    {
      key: 'device.endpoint_protection.active',
      title: 'Endpoint protection is installed, running and current',
      subjectKinds: ['Device'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.managed' },
        right: { op: 'const', value: true },
      },
      expression: {
        op: 'and',
        operands: [
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'device.endpoint_protection.installed' },
            right: { op: 'const', value: true },
          },
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'device.endpoint_protection.realtime_enabled' },
            right: { op: 'const', value: true },
          },
          {
            op: 'not',
            operand: {
              op: 'olderThanDays',
              value: { op: 'claim', predicate: 'device.endpoint_protection.signatures_updated_at' },
              days: { op: 'param', key: 'maxSignatureAgeDays', default: 3 },
            },
          },
        ],
      },
      defaultParameters: { maxSignatureAgeDays: 3 },
      aggregation: 'ALL',
      severity: 'HIGH',
      failureTitle: 'Endpoint protection is missing, disabled or out of date.',
      failureDescription:
        'Ensure endpoint protection is installed, real-time protection is on, and definitions are current.',
      remediation: null,
      maxEvidenceAgeDays: 3,
    },
    {
      key: 'device.os.supported',
      title: 'Managed devices run a supported operating system version',
      subjectKinds: ['Device'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.managed' },
        right: { op: 'const', value: true },
      },
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.os.supported' },
        right: { op: 'const', value: true },
      },
      aggregation: 'THRESHOLD',
      threshold: 0.95,
      severity: 'MEDIUM',
      failureTitle: 'Devices are running an operating system version that is no longer supported.',
      failureDescription:
        'Unsupported operating systems stop receiving security updates. Upgrade or retire the affected devices.',
      remediation: null,
      maxEvidenceAgeDays: 14,
    },

    // --------------------------------------------------- vulnerability & patch
    {
      key: 'vulnerability.critical.remediated',
      title: 'Critical vulnerabilities are remediated within the agreed window',
      subjectKinds: ['Device', 'Application', 'Service', 'CloudResource'],
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'vulnerability.critical_overdue' },
        right: { op: 'const', value: false },
      },
      aggregation: 'ALL',
      severity: 'CRITICAL',
      failureTitle: 'Critical vulnerabilities remain unremediated beyond the agreed window.',
      failureDescription:
        'Patch or otherwise remediate the affected assets, or record a time-bounded exception with compensating controls.',
      remediation: null,
      defaultParameters: { remediationWindowDays: 14 },
      maxEvidenceAgeDays: 7,
    },
    {
      key: 'patch.cadence.met',
      title: 'Security updates are applied within the agreed cadence',
      subjectKinds: ['Device'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.managed' },
        right: { op: 'const', value: true },
      },
      expression: {
        op: 'not',
        operand: {
          op: 'olderThanDays',
          value: { op: 'claim', predicate: 'device.patch.last_applied_at' },
          days: { op: 'param', key: 'patchCadenceDays', default: 30 },
        },
      },
      defaultParameters: { patchCadenceDays: 30 },
      aggregation: 'THRESHOLD',
      threshold: 0.9,
      severity: 'MEDIUM',
      failureTitle: 'Devices have not received security updates within the agreed cadence.',
      failureDescription:
        'Investigate update delivery for the affected devices and bring them current.',
      remediation: null,
      maxEvidenceAgeDays: 7,
    },

    // ------------------------------------------------------- data & resilience
    {
      key: 'backup.recent_success',
      title: 'Protected data assets have a recent successful backup',
      subjectKinds: ['DataAsset', 'Service'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'data.backup.required' },
        right: { op: 'const', value: true },
      },
      expression: {
        op: 'and',
        operands: [
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'data.backup.last_status' },
            right: { op: 'const', value: 'SUCCEEDED' },
          },
          {
            op: 'not',
            operand: {
              op: 'olderThanDays',
              value: { op: 'claim', predicate: 'data.backup.last_success_at' },
              days: { op: 'param', key: 'maxBackupAgeDays', default: 2 },
            },
          },
        ],
      },
      defaultParameters: { maxBackupAgeDays: 2 },
      aggregation: 'ALL',
      severity: 'HIGH',
      failureTitle: 'A protected data asset does not have a recent successful backup.',
      failureDescription:
        'Investigate the backup failure. Without a recent successful backup the organisation has no verified recovery position.',
      remediation: null,
      maxEvidenceAgeDays: 2,
    },
    {
      key: 'backup.restore_tested',
      title: 'Backup restoration has been tested within the review period',
      subjectKinds: [],
      aggregation: 'SINGLE',
      expression: {
        op: 'not',
        operand: {
          op: 'olderThanDays',
          value: { op: 'claim', predicate: 'organisation.backup.last_restore_test_at' },
          days: { op: 'param', key: 'restoreTestIntervalDays', default: 180 },
        },
      },
      defaultParameters: { restoreTestIntervalDays: 180 },
      severity: 'MEDIUM',
      failureTitle: 'Backup restoration has not been tested within the review period.',
      failureDescription:
        'An untested backup is an assumption, not a recovery capability. Perform and record a restoration test.',
      remediation: null,
      maxEvidenceAgeDays: 365,
    },

    // --------------------------------------------------------------- governance
    {
      key: 'policy.published_and_current',
      title: 'Required security policies are published and within review date',
      subjectKinds: ['Policy'],
      expression: {
        op: 'and',
        operands: [
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'policy.published' },
            right: { op: 'const', value: true },
          },
          {
            op: 'not',
            operand: {
              op: 'olderThanDays',
              value: { op: 'claim', predicate: 'policy.last_reviewed_at' },
              days: { op: 'param', key: 'policyReviewIntervalDays', default: 365 },
            },
          },
        ],
      },
      defaultParameters: { policyReviewIntervalDays: 365 },
      aggregation: 'ALL',
      severity: 'LOW',
      failureTitle: 'Security policies are unpublished or overdue for review.',
      failureDescription: 'Publish and review the affected policies.',
      remediation: null,
      maxEvidenceAgeDays: 400,
    },
    {
      key: 'supplier.assurance_current',
      title: 'Critical suppliers hold current security assurance',
      subjectKinds: ['Supplier'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'supplier.criticality' },
        right: { op: 'const', value: 'CRITICAL' },
      },
      expression: {
        op: 'and',
        operands: [
          { op: 'exists', predicate: 'supplier.assurance.type' },
          {
            op: 'not',
            operand: {
              op: 'olderThanDays',
              value: { op: 'claim', predicate: 'supplier.assurance.verified_at' },
              days: { op: 'param', key: 'supplierReviewIntervalDays', default: 365 },
            },
          },
        ],
      },
      defaultParameters: { supplierReviewIntervalDays: 365 },
      aggregation: 'ALL',
      severity: 'MEDIUM',
      failureTitle: 'Critical suppliers do not hold current security assurance.',
      failureDescription:
        'Obtain and record current assurance (certification, audit report or attestation) for the affected suppliers.',
      remediation: null,
      maxEvidenceAgeDays: 400,
    },
    {
      key: 'training.completion_rate',
      title: 'Security awareness training completion meets the agreed rate',
      subjectKinds: [],
      aggregation: 'SINGLE',
      expression: {
        op: 'gte',
        left: { op: 'claim', predicate: 'organisation.training.completion_rate' },
        right: { op: 'param', key: 'minCompletionRate', default: 0.9 },
      },
      defaultParameters: { minCompletionRate: 0.9 },
      severity: 'LOW',
      failureTitle: 'Security awareness training completion is below the agreed rate.',
      failureDescription: 'Chase outstanding training completions.',
      remediation: null,
      maxEvidenceAgeDays: 90,
    },

    // ------------------------------------------------------------------- cloud
    {
      key: 'cloud.storage.not_public',
      title: 'Cloud storage is not publicly accessible',
      subjectKinds: ['CloudResource'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'cloud.resource.category' },
        right: { op: 'const', value: 'STORAGE' },
      },
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'cloud.storage.public_access' },
        right: { op: 'const', value: false },
      },
      aggregation: 'ALL',
      severity: 'CRITICAL',
      failureTitle: 'Cloud storage is publicly accessible.',
      failureDescription:
        'Publicly readable storage is a direct data-exposure route. Restrict public access on the affected resources.',
      remediation: {
        actionType: 'cloud.storage.block_public_access',
        riskClass: 'CONFIGURATION',
        parameterTemplate: {},
        rationale: 'Block public access on the affected storage resource.',
      },
      maxEvidenceAgeDays: 3,
    },
    {
      key: 'logging.retained',
      title: 'Security logging is enabled and retained for the agreed period',
      subjectKinds: [],
      aggregation: 'SINGLE',
      expression: {
        op: 'and',
        operands: [
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'organisation.logging.enabled' },
            right: { op: 'const', value: true },
          },
          {
            op: 'gte',
            left: { op: 'claim', predicate: 'organisation.logging.retention_days' },
            right: { op: 'param', key: 'minRetentionDays', default: 90 },
          },
        ],
      },
      defaultParameters: { minRetentionDays: 90 },
      severity: 'MEDIUM',
      failureTitle: 'Security logging is disabled or retained for too short a period.',
      failureDescription:
        'Without retained logs an incident cannot be investigated. Enable logging and extend retention.',
      remediation: null,
      maxEvidenceAgeDays: 30,
    },
  ],
} as const;
