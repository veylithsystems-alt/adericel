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
  version: '1.0.0',
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
      remediation: {
        actionType: 'device.firewall.enable',
        riskClass: 'CONFIGURATION',
        parameterTemplate: {},
        rationale: 'Enable the host-based firewall on the affected device.',
      },
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
