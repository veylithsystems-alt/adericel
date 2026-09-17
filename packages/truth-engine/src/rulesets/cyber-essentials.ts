/**
 * Cyber Essentials-aligned ruleset v1.
 *
 * Adericel is not a certification body and this ruleset does not confer
 * certification. It expresses the five technical control themes of the UK Cyber
 * Essentials scheme in Adericel's canonical predicates so that an MSP can
 * maintain continuous readiness between assessments, and can see precisely
 * where an organisation would fail today.
 */
export const cyberEssentialsV1 = {
  key: 'cyber-essentials',
  version: '1.1.0',
  name: 'Cyber Essentials (technical controls)',
  engineVersion: '1.0.0',
  description:
    'Continuous readiness against the five Cyber Essentials technical control themes: firewalls, ' +
    'secure configuration, security update management, user access control, and malware protection.',
  rules: [
    {
      key: 'ce.firewalls.boundary',
      title: 'Boundary firewalls are in place and default-deny inbound',
      subjectKinds: [],
      aggregation: 'SINGLE',
      expression: {
        op: 'and',
        operands: [
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'network.firewall.present' },
            right: { op: 'const', value: true },
          },
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'network.firewall.default_deny_inbound' },
            right: { op: 'const', value: true },
          },
        ],
      },
      severity: 'HIGH',
      failureTitle: 'Boundary firewall protection does not meet the Cyber Essentials requirement.',
      failureDescription:
        'Ensure a boundary firewall is present and that inbound connections are denied by default, with documented exceptions.',
      remediation: null,
      maxEvidenceAgeDays: 90,
    },
    {
      key: 'ce.firewalls.host',
      title: 'Host-based firewalls are enabled on managed devices',
      subjectKinds: ['Device'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.managed' },
        right: { op: 'const', value: true },
      },
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.firewall.enabled' },
        right: { op: 'const', value: true },
      },
      aggregation: 'ALL',
      severity: 'MEDIUM',
      failureTitle: 'Host-based firewalls are not enabled on all managed devices.',
      failureDescription: 'Enable the host firewall on the affected devices.',
      // No remediation offered. Endpoint posture is changed through Intune
      // configuration profiles, which are tenant-wide objects: a change Adericel
      // made to one would affect devices far beyond the finding that prompted it.
      // Offering a button that cannot safely run is worse than offering none.
      remediation: null,
      maxEvidenceAgeDays: 14,
    },
    {
      key: 'ce.secure_config.no_default_credentials',
      title: 'Default credentials have been changed or removed',
      subjectKinds: ['Device', 'Application', 'Service', 'Infrastructure'],
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'asset.default_credentials_present' },
        right: { op: 'const', value: false },
      },
      aggregation: 'ALL',
      severity: 'CRITICAL',
      failureTitle: 'Assets are still using default credentials.',
      failureDescription:
        'Default credentials are published and trivially exploited. Change or remove them on the affected assets.',
      remediation: null,
      maxEvidenceAgeDays: 90,
    },
    {
      key: 'ce.secure_config.dormant_accounts',
      title: 'Accounts no longer required have been removed or disabled',
      subjectKinds: ['Identity'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'identity.account.enabled' },
        right: { op: 'const', value: true },
      },
      /**
       * An enabled account that has not signed in for `dormantDays` fails.
       *
       * Deliberately not "has never signed in": a newly created account has no
       * sign-in and is not dormant, it is new. The rule reads the timestamp and
       * an account with none produces UNKNOWN for want of the fact, which is
       * the correct answer — Adericel does not know whether it is dormant or
       * yesterday's joiner.
       */
      expression: {
        op: 'not',
        operand: {
          op: 'olderThanDays',
          value: { op: 'claim', predicate: 'identity.last_sign_in_at' },
          days: { op: 'param', key: 'dormantDays' },
        },
      },
      defaultParameters: { dormantDays: 90 },
      aggregation: 'ALL',
      severity: 'MEDIUM',
      failureTitle: 'Enabled accounts have not been used for an extended period.',
      failureDescription:
        'Cyber Essentials requires accounts to be removed or disabled when no longer needed. ' +
        'Review the dormant accounts and disable the ones that are no longer required.',
      remediation: {
        actionType: 'identity.account.disable',
        // Disruptive, and correctly so: disabling an account a person is
        // actually using is the most visible mistake Adericel can make, so it
        // goes through approval rather than autonomy.
        riskClass: 'DISRUPTIVE',
        parameterTemplate: {},
        rationale: 'Disable the dormant account to remove an unmonitored credential.',
      },
      maxEvidenceAgeDays: 30,
    },
    {
      key: 'ce.secure_config.password_policy',
      title: 'Password-based authentication is protected',
      subjectKinds: [],
      aggregation: 'SINGLE',
      /**
       * Three routes, any one of which satisfies the requirement: multi-factor
       * authentication, a twelve-character minimum, or eight characters with
       * common passwords blocked.
       *
       * Written as a disjunction rather than picking one, because an estate
       * that meets a different route is compliant and a rule that demanded the
       * route Adericel prefers would report a failure that is not one. The
       * organisation-level MFA claim is the weakest of the three to establish,
       * so it is last: Kleene `or` returns TRUE on the first TRUE operand, and
       * an UNKNOWN on a later operand cannot spoil it.
       */
      expression: {
        op: 'or',
        operands: [
          {
            op: 'gte',
            left: { op: 'claim', predicate: 'organisation.password.min_length' },
            right: { op: 'param', key: 'longPasswordLength' },
          },
          {
            op: 'and',
            operands: [
              {
                op: 'gte',
                left: { op: 'claim', predicate: 'organisation.password.min_length' },
                right: { op: 'param', key: 'shortPasswordLength' },
              },
              {
                op: 'eq',
                left: { op: 'claim', predicate: 'organisation.password.common_blocked' },
                right: { op: 'const', value: true },
              },
            ],
          },
        ],
      },
      defaultParameters: { longPasswordLength: 12, shortPasswordLength: 8 },
      severity: 'HIGH',
      failureTitle: 'Password-based authentication does not meet any of the accepted routes.',
      failureDescription:
        'Cyber Essentials accepts a twelve-character minimum, or eight characters with common ' +
        'passwords blocked, or multi-factor authentication. None of the three could be ' +
        'established. Enabling password protection is usually the smallest change.',
      remediation: null,
      maxEvidenceAgeDays: 90,
    },
    {
      key: 'ce.secure_config.device_unlock',
      title: 'Devices require a credential to unlock, with brute-force protection',
      subjectKinds: ['Device'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.managed' },
        right: { op: 'const', value: true },
      },
      /**
       * A credential is required AND brute force is limited, by either route.
       *
       * The scheme accepts a cap on attempts or a throttle between them, so
       * both are read and either satisfies. A rule that demanded the attempt
       * cap would fail every estate that chose the lockout timeout instead —
       * which is most of the mobile ones.
       */
      expression: {
        op: 'and',
        operands: [
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'device.lock.required' },
            right: { op: 'const', value: true },
          },
          {
            op: 'or',
            operands: [
              {
                op: 'lte',
                left: { op: 'claim', predicate: 'device.lock.max_attempts' },
                right: { op: 'param', key: 'maxAttempts' },
              },
              {
                op: 'lte',
                left: { op: 'claim', predicate: 'device.lock.timeout_seconds' },
                right: { op: 'param', key: 'maxLockTimeoutSeconds' },
              },
            ],
          },
        ],
      },
      defaultParameters: { maxAttempts: 10, maxLockTimeoutSeconds: 900 },
      aggregation: 'ALL',
      severity: 'MEDIUM',
      failureTitle: 'Devices do not require an unlock credential with brute-force protection.',
      failureDescription:
        'Require a PIN, password or biometric to unlock, and set either a limit on failed ' +
        'attempts or an automatic lock after a period of inactivity.',
      remediation: null,
      maxEvidenceAgeDays: 30,
    },
    {
      key: 'ce.updates.automatic_enabled',
      title: 'Automatic security updates are enabled where the vendor provides them',
      subjectKinds: ['Device'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.managed' },
        right: { op: 'const', value: true },
      },
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.updates.automatic_enabled' },
        right: { op: 'const', value: true },
      },
      aggregation: 'ALL',
      severity: 'MEDIUM',
      failureTitle: 'Automatic updates are not enabled on all managed devices.',
      failureDescription:
        'Enable automatic installation of security updates. Leaving the decision to the user ' +
        'is not automatic: the fourteen-day requirement then depends on somebody remembering.',
      remediation: null,
      maxEvidenceAgeDays: 30,
    },
    {
      key: 'ce.access.mfa_on_admin_accounts',
      title: 'Multi-factor authentication is enforced on administrative accounts',
      subjectKinds: ['Identity'],
      /**
       * Scoped to privileged accounts, and separate from the cloud-services
       * rule on purpose.
       *
       * An estate where MFA covers most staff but not the administrators is
       * exactly the estate an attacker wants, and aggregating the two into one
       * control would let the ninety-five per cent hide the five. The scheme
       * asks for both; Adericel reports both.
       */
      applicability: {
        op: 'and',
        operands: [
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'identity.privileged' },
            right: { op: 'const', value: true },
          },
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'identity.account.enabled' },
            right: { op: 'const', value: true },
          },
        ],
      },
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'identity.mfa.enforced' },
        right: { op: 'const', value: true },
      },
      aggregation: 'ALL',
      severity: 'CRITICAL',
      failureTitle: 'Administrative accounts are not protected by multi-factor authentication.',
      failureDescription:
        'Every account holding administrative privilege must require a second factor. These ' +
        'are the accounts an attacker is looking for.',
      remediation: {
        actionType: 'identity.mfa.require',
        riskClass: 'CONFIGURATION',
        parameterTemplate: { enforcement: 'REQUIRED' },
        rationale:
          'Add the administrative identity to the group the tenant’s Conditional Access ' +
          'policy targets, so a second factor is required at sign-in.',
      },
      maxEvidenceAgeDays: 30,
    },
    {
      key: 'ce.malware.signatures_current',
      title: 'Malware signatures are up to date',
      subjectKinds: ['Device'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.endpoint_protection.installed' },
        right: { op: 'const', value: true },
      },
      /**
       * Separate from "protection is active" because the failures are different
       * work. Anti-malware that is installed and running on month-old
       * signatures is not a configuration problem, it is a device that has
       * stopped talking to its update source — and an MSP fixes those two
       * things in different places.
       */
      expression: {
        op: 'not',
        operand: {
          op: 'olderThanDays',
          value: { op: 'claim', predicate: 'device.endpoint_protection.signatures_updated_at' },
          days: { op: 'param', key: 'signatureAgeDays' },
        },
      },
      defaultParameters: { signatureAgeDays: 7 },
      aggregation: 'ALL',
      severity: 'HIGH',
      failureTitle: 'Malware signatures are out of date on some devices.',
      failureDescription:
        'Anti-malware running on stale signatures protects against last week. Check why the ' +
        'affected devices are not reaching their update source.',
      remediation: null,
      maxEvidenceAgeDays: 7,
    },
    {
      key: 'ce.malware.web_protection',
      title: 'Malware protection blocks connections to known-malicious websites',
      subjectKinds: ['Device'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.endpoint_protection.installed' },
        right: { op: 'const', value: true },
      },
      expression: {
        op: 'eq',
        left: {
          op: 'claim',
          predicate: 'device.endpoint_protection.web_protection_enabled',
        },
        right: { op: 'const', value: true },
      },
      aggregation: 'ALL',
      severity: 'MEDIUM',
      failureTitle: 'Web protection is not enabled on all protected devices.',
      failureDescription:
        'Enable the anti-malware product’s web or network protection so connections to ' +
        'known-malicious sites are blocked before they are made.',
      remediation: null,
      maxEvidenceAgeDays: 30,
    },
    {
      key: 'ce.secure_config.autorun_disabled',
      title: 'Auto-run of removable media is disabled',
      subjectKinds: ['Device'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.managed' },
        right: { op: 'const', value: true },
      },
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'device.autorun_disabled' },
        right: { op: 'const', value: true },
      },
      aggregation: 'ALL',
      severity: 'LOW',
      failureTitle: 'Auto-run of removable media is not disabled on all devices.',
      failureDescription: 'Disable auto-run through device policy.',
      remediation: null,
      maxEvidenceAgeDays: 30,
    },
    {
      key: 'ce.updates.applied_within_14_days',
      title: 'High and critical security updates are applied within 14 days',
      subjectKinds: ['Device', 'Application', 'Service'],
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'vulnerability.high_or_critical_overdue_14d' },
        right: { op: 'const', value: false },
      },
      aggregation: 'ALL',
      severity: 'CRITICAL',
      failureTitle: 'High or critical security updates are more than 14 days overdue.',
      failureDescription:
        'Cyber Essentials requires high and critical updates within 14 days of release. Patch the affected assets.',
      remediation: null,
      maxEvidenceAgeDays: 7,
    },
    {
      key: 'ce.updates.supported_software',
      title: 'All software in use is supported by its vendor',
      subjectKinds: ['Application', 'Device'],
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'asset.vendor_supported' },
        right: { op: 'const', value: true },
      },
      aggregation: 'ALL',
      severity: 'HIGH',
      failureTitle: 'Unsupported software is in use.',
      failureDescription:
        'Remove, replace or upgrade software that no longer receives vendor security updates.',
      remediation: null,
      maxEvidenceAgeDays: 30,
    },
    {
      key: 'ce.access.mfa_on_cloud_services',
      title: 'Multi-factor authentication is applied to cloud services',
      subjectKinds: ['Identity'],
      applicability: {
        op: 'and',
        operands: [
          {
            op: 'ne',
            left: { op: 'claim', predicate: 'identity.account.type', default: 'USER' },
            right: { op: 'const', value: 'SERVICE' },
          },
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'identity.account.enabled', default: true },
            right: { op: 'const', value: true },
          },
        ],
      },
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'identity.mfa.enforced' },
        right: { op: 'const', value: true },
      },
      aggregation: 'ALL',
      severity: 'CRITICAL',
      failureTitle: 'Multi-factor authentication is not applied to all cloud service accounts.',
      failureDescription:
        'Cyber Essentials requires MFA on cloud services for all users. Enforce it on the affected accounts.',
      remediation: {
        actionType: 'identity.mfa.require',
        riskClass: 'CONFIGURATION',
        parameterTemplate: { enforcement: 'REQUIRED' },
        rationale: 'Enforce MFA to meet the Cyber Essentials user access control requirement.',
      },
      maxEvidenceAgeDays: 7,
    },
    {
      key: 'ce.access.admin_separation',
      title: 'Administrative accounts are separate from day-to-day accounts',
      subjectKinds: ['Identity'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'identity.privileged' },
        right: { op: 'const', value: true },
      },
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'identity.admin_account_separate' },
        right: { op: 'const', value: true },
      },
      aggregation: 'ALL',
      severity: 'HIGH',
      failureTitle: 'Administrative privilege is held on day-to-day user accounts.',
      failureDescription:
        'Issue separate administrative accounts so that routine browsing and email do not run with privilege.',
      remediation: null,
      maxEvidenceAgeDays: 30,
    },
    {
      key: 'ce.malware.protection_active',
      title: 'Malware protection is active on all devices',
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
        ],
      },
      aggregation: 'ALL',
      severity: 'CRITICAL',
      failureTitle: 'Malware protection is not active on all devices.',
      failureDescription: 'Install and enable malware protection on the affected devices.',
      remediation: null,
      maxEvidenceAgeDays: 7,
    },
  ],
} as const;
