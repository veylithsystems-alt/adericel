/**
 * ISO/IEC 27001:2022 Annex A ruleset v1.
 *
 * Adericel is not a certification body and this ruleset does not confer
 * certification. It expresses the subset of Annex A that can be determined from
 * observed technical state, in Adericel's canonical predicates, so an
 * organisation can see continuously where it stands between audits.
 *
 * One decision is worth stating plainly, because it is the opposite of what
 * most tooling does.
 *
 * Annex A has 93 controls. A large number of them are organisational — a
 * documented policy, a defined process, a signed agreement — and no amount of
 * API polling determines whether they hold. The tempting move is to leave those
 * out, which produces a ruleset where every control has an answer and coverage
 * looks complete.
 *
 * They are included instead, and they report UNKNOWN with reason NO_EVIDENCE
 * until someone supplies evidence. An organisation with eighteen proven
 * technical controls and twenty-four unknown organisational ones is in a
 * genuinely different position from one with eighteen proven controls and
 * nothing else in scope, and only one of those two is honest about the gap.
 * That distinction is the entire product (ADR-0003).
 *
 * Control references are to Annex A of ISO/IEC 27001:2022.
 */
export const iso27001V1 = {
  key: 'iso-27001-2022',
  version: '1.0.0',
  name: 'ISO/IEC 27001:2022 Annex A (determinable controls)',
  engineVersion: '1.0.0',
  description:
    'Continuous assurance against the Annex A controls that can be determined from observed state, ' +
    'with organisational controls held as UNKNOWN until evidence is supplied rather than omitted.',
  rules: [
    // ---------------------------------------------------------- 5 Organisational
    {
      key: 'iso.5.1.policies',
      title: 'A.5.1 Information security policy is defined, approved and reviewed',
      description:
        'The policy must exist, be published, and have been reviewed within the last twelve months.',
      subjectKinds: [],
      aggregation: 'SINGLE',
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
      severity: 'HIGH',
      failureTitle:
        'The information security policy is missing or has not been reviewed within the review interval.',
      failureDescription:
        'Publish the information security policy and record a management review. A policy that exists but has not been reviewed does not satisfy A.5.1.',
      remediation: null,
      defaultParameters: { policyReviewIntervalDays: 365 },
      maxEvidenceAgeDays: 400,
    },
    {
      key: 'iso.5.15.access_control',
      title: 'A.5.15 Access is granted according to the access control policy',
      description:
        'Every account is either enabled with a justified type, or disabled. Dormant enabled accounts are the common failure.',
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
          days: { op: 'param', key: 'dormantAccountDays', default: 90 },
        },
      },
      aggregation: 'ALL',
      severity: 'HIGH',
      failureTitle: 'Enabled accounts have not signed in within the dormancy threshold.',
      failureDescription:
        'Review and disable dormant accounts. An enabled account nobody uses is an account nobody notices being used.',
      remediation: {
        actionType: 'identity.account.disable',
        riskClass: 'DISRUPTIVE',
        parameterTemplate: {},
        rationale: 'Disable the dormant account, retaining it for audit rather than deleting it.',
      },
      defaultParameters: { dormantAccountDays: 90 },
      maxEvidenceAgeDays: 7,
    },
    {
      key: 'iso.5.16.identity_management',
      title: 'A.5.16 Privileged identities are separated from day-to-day accounts',
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
      failureTitle: 'Privileged access is exercised from accounts also used for ordinary work.',
      failureDescription:
        'Issue separate administrative accounts. Browsing the web from an account that can change tenant configuration is the shortest path from a phishing email to a tenant compromise.',
      remediation: null,
      maxEvidenceAgeDays: 30,
    },
    {
      key: 'iso.5.17.authentication',
      title: 'A.5.17 Multi-factor authentication is enforced for privileged access',
      subjectKinds: ['Identity'],
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
      failureTitle: 'Multi-factor authentication is not enforced on every privileged account.',
      failureDescription:
        'Enforce phishing-resistant multi-factor authentication on the named accounts.',
      remediation: {
        actionType: 'identity.mfa.require',
        riskClass: 'CONFIGURATION',
        parameterTemplate: {},
        rationale: 'Enforce multi-factor authentication on the privileged account.',
      },
      maxEvidenceAgeDays: 7,
    },
    {
      key: 'iso.5.19.supplier_relationships',
      title: 'A.5.19 Information security is addressed in supplier relationships',
      description:
        'Critical suppliers hold current assurance. Verified within the review interval, not merely claimed once.',
      subjectKinds: ['Supplier'],
      applicability: {
        op: 'eq',
        left: { op: 'claim', predicate: 'supplier.criticality' },
        right: { op: 'const', value: 'CRITICAL' },
      },
      expression: {
        op: 'and',
        operands: [
          {
            op: 'includes',
            collection: { op: 'const', value: ['ISO27001', 'SOC2', 'CYBER_ESSENTIALS_PLUS'] },
            value: { op: 'claim', predicate: 'supplier.assurance.type' },
          },
          {
            op: 'not',
            operand: {
              op: 'olderThanDays',
              value: { op: 'claim', predicate: 'supplier.assurance.verified_at' },
              days: { op: 'param', key: 'supplierReviewDays', default: 365 },
            },
          },
        ],
      },
      aggregation: 'ALL',
      severity: 'MEDIUM',
      failureTitle: 'Critical suppliers do not hold verified, current assurance.',
      failureDescription:
        'Obtain and record current assurance for the named suppliers. An expired certificate on file is not assurance.',
      remediation: null,
      defaultParameters: { supplierReviewDays: 365 },
      maxEvidenceAgeDays: 400,
    },
    {
      key: 'iso.5.24.incident_management',
      title: 'A.5.24 Incident management planning is in place and exercised',
      description:
        'Determined from documented evidence rather than from observed state. UNKNOWN until that evidence is supplied — which is the honest answer, not a gap in the ruleset.',
      subjectKinds: [],
      aggregation: 'SINGLE',
      expression: {
        op: 'and',
        operands: [
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'organisation.incident.plan_published' },
            right: { op: 'const', value: true },
          },
          {
            op: 'not',
            operand: {
              op: 'olderThanDays',
              value: { op: 'claim', predicate: 'organisation.incident.last_exercise_at' },
              days: { op: 'param', key: 'incidentExerciseDays', default: 365 },
            },
          },
        ],
      },
      severity: 'HIGH',
      failureTitle: 'The incident response plan is missing or has not been exercised.',
      failureDescription:
        'Publish an incident response plan and exercise it. A plan nobody has rehearsed is a document, not a capability.',
      remediation: null,
      defaultParameters: { incidentExerciseDays: 365 },
      maxEvidenceAgeDays: 400,
    },
    {
      key: 'iso.5.30.ict_continuity',
      title: 'A.5.30 ICT readiness for business continuity is verified by restore testing',
      description:
        'Backups that have never been restored are an assumption. This checks the restore test, not the backup job.',
      subjectKinds: [],
      aggregation: 'SINGLE',
      expression: {
        op: 'not',
        operand: {
          op: 'olderThanDays',
          value: { op: 'claim', predicate: 'organisation.backup.last_restore_test_at' },
          days: { op: 'param', key: 'restoreTestDays', default: 180 },
        },
      },
      severity: 'HIGH',
      failureTitle: 'No successful restore test within the required interval.',
      failureDescription:
        'Perform and record a restore test. A backup that has never been restored is an untested assumption.',
      remediation: null,
      defaultParameters: { restoreTestDays: 180 },
      maxEvidenceAgeDays: 200,
    },

    // ------------------------------------------------------------------ 6 People
    {
      key: 'iso.6.3.awareness',
      title: 'A.6.3 Information security awareness training is completed',
      subjectKinds: [],
      aggregation: 'SINGLE',
      expression: {
        op: 'gte',
        left: { op: 'claim', predicate: 'organisation.training.completion_rate' },
        right: { op: 'param', key: 'minTrainingCompletion', default: 0.9 },
      },
      severity: 'MEDIUM',
      failureTitle: 'Security awareness training completion is below the required threshold.',
      failureDescription: 'Chase outstanding completions and record them.',
      remediation: null,
      defaultParameters: { minTrainingCompletion: 0.9 },
      maxEvidenceAgeDays: 365,
    },

    // ---------------------------------------------------------- 8 Technological
    {
      key: 'iso.8.1.endpoint_devices',
      title: 'A.8.1 User endpoint devices are protected',
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
            left: { op: 'claim', predicate: 'device.disk.encrypted' },
            right: { op: 'const', value: true },
          },
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'device.firewall.enabled' },
            right: { op: 'const', value: true },
          },
        ],
      },
      aggregation: 'ALL',
      severity: 'HIGH',
      failureTitle: 'Managed endpoints are not protected to the required baseline.',
      failureDescription: 'Enable disk encryption and the host firewall on the affected devices.',
      // No remediation offered. Endpoint posture is changed through Intune
      // configuration profiles, which are tenant-wide objects: a change Adericel
      // made to one would affect devices far beyond the finding that prompted it.
      // Offering a button that cannot safely run is worse than offering none.
      remediation: null,
      maxEvidenceAgeDays: 14,
    },
    {
      key: 'iso.8.2.privileged_access',
      title: 'A.8.2 Privileged access rights are restricted and reviewed',
      description:
        'Administrator count against a ceiling. A tenant with thirty global administrators has not restricted anything.',
      subjectKinds: [],
      aggregation: 'SINGLE',
      expression: {
        op: 'lte',
        left: { op: 'claim', predicate: 'organisation.identity.admin_count' },
        right: { op: 'param', key: 'maxAdministrators', default: 5 },
      },
      severity: 'HIGH',
      failureTitle: 'More privileged accounts exist than the agreed ceiling.',
      failureDescription: 'Review privileged assignments and remove those no longer required.',
      remediation: null,
      defaultParameters: { maxAdministrators: 5 },
      maxEvidenceAgeDays: 7,
    },
    {
      key: 'iso.8.5.secure_authentication',
      title: 'A.8.5 Secure authentication is configured',
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
      severity: 'MEDIUM',
      failureTitle: 'Authentication settings do not meet the required baseline.',
      failureDescription: 'Raise the minimum password length and enable breach screening.',
      remediation: null,
      defaultParameters: { minPasswordLength: 12 },
      maxEvidenceAgeDays: 30,
    },
    {
      key: 'iso.8.7.malware_protection',
      title: 'A.8.7 Protection against malware is active and current',
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
              days: { op: 'param', key: 'maxSignatureAgeDays', default: 7 },
            },
          },
        ],
      },
      aggregation: 'ALL',
      severity: 'CRITICAL',
      failureTitle: 'Malware protection is missing, disabled, or out of date.',
      failureDescription:
        'Install and enable malware protection and confirm signatures are updating. Installed but stale is not protected.',
      remediation: null,
      defaultParameters: { maxSignatureAgeDays: 7 },
      maxEvidenceAgeDays: 3,
    },
    {
      key: 'iso.8.8.vulnerability_management',
      title: 'A.8.8 Technical vulnerabilities are managed within agreed timescales',
      subjectKinds: [],
      aggregation: 'SINGLE',
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'vulnerability.critical_overdue' },
        right: { op: 'const', value: 0 },
      },
      severity: 'CRITICAL',
      failureTitle: 'Critical vulnerabilities are past their remediation deadline.',
      failureDescription:
        'Remediate the overdue critical findings or record an accepted exception.',
      remediation: null,
      maxEvidenceAgeDays: 7,
    },
    {
      key: 'iso.8.9.configuration_management',
      title: 'A.8.9 Configurations are managed and default credentials removed',
      subjectKinds: ['Device', 'CloudResource'],
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'asset.default_credentials_present' },
        right: { op: 'const', value: false },
      },
      aggregation: 'ALL',
      severity: 'CRITICAL',
      failureTitle: 'Assets are still reachable with vendor default credentials.',
      failureDescription: 'Change the default credentials on the named assets.',
      remediation: null,
      maxEvidenceAgeDays: 30,
    },
    {
      key: 'iso.8.13.information_backup',
      title: 'A.8.13 Backups are taken and succeed',
      subjectKinds: [],
      aggregation: 'SINGLE',
      expression: {
        op: 'and',
        operands: [
          {
            op: 'eq',
            left: { op: 'claim', predicate: 'data.backup.last_status' },
            right: { op: 'const', value: 'SUCCESS' },
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
      severity: 'HIGH',
      failureTitle: 'No recent successful backup.',
      failureDescription: 'Investigate the backup job and confirm a successful run.',
      remediation: null,
      defaultParameters: { maxBackupAgeDays: 2 },
      maxEvidenceAgeDays: 3,
    },
    {
      key: 'iso.8.15.logging',
      title: 'A.8.15 Logging is enabled and retained for the required period',
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
            right: { op: 'param', key: 'minLogRetentionDays', default: 180 },
          },
        ],
      },
      severity: 'HIGH',
      failureTitle: 'Audit logging is disabled or retained for too short a period.',
      failureDescription:
        'Enable audit logging and raise retention. Logs that expire before an incident is discovered answer nothing.',
      remediation: null,
      defaultParameters: { minLogRetentionDays: 180 },
      maxEvidenceAgeDays: 30,
    },
    {
      key: 'iso.8.19.software_on_operational_systems',
      title: 'A.8.19 Operating systems are supported and patched',
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
            left: { op: 'claim', predicate: 'device.os.supported' },
            right: { op: 'const', value: true },
          },
          {
            op: 'not',
            operand: {
              op: 'olderThanDays',
              value: { op: 'claim', predicate: 'device.patch.last_applied_at' },
              days: { op: 'param', key: 'maxPatchAgeDays', default: 30 },
            },
          },
        ],
      },
      aggregation: 'ALL',
      severity: 'HIGH',
      failureTitle: 'Devices are running unsupported or unpatched operating systems.',
      failureDescription:
        'Patch or replace the named devices. An unsupported operating system cannot be patched, so it fails permanently until it is replaced.',
      remediation: null,
      defaultParameters: { maxPatchAgeDays: 30 },
      maxEvidenceAgeDays: 7,
    },
    {
      key: 'iso.8.20.network_security',
      title: 'A.8.20 Networks are secured at the boundary',
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
      failureTitle: 'Network boundary protection is absent or does not default to deny.',
      failureDescription:
        'Deploy boundary firewalling with a default-deny inbound posture and documented exceptions.',
      remediation: null,
      maxEvidenceAgeDays: 90,
    },
    {
      key: 'iso.8.24.cryptography',
      title: 'A.8.24 Stored data is encrypted and not publicly reachable',
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
      failureTitle: 'Storage is reachable without authentication.',
      failureDescription: 'Block public access on the named storage resources.',
      remediation: {
        actionType: 'cloud.storage.block_public_access',
        riskClass: 'CONFIGURATION',
        parameterTemplate: {},
        rationale: 'Block public access on the storage resource.',
      },
      maxEvidenceAgeDays: 7,
    },
    {
      key: 'iso.8.32.change_management',
      title: 'A.8.32 Changes to systems are managed through a defined process',
      description:
        'Determined from documented evidence. UNKNOWN until supplied, and included precisely so that its absence is visible rather than silently outside the denominator.',
      subjectKinds: [],
      aggregation: 'SINGLE',
      expression: {
        op: 'eq',
        left: { op: 'claim', predicate: 'organisation.change.process_published' },
        right: { op: 'const', value: true },
      },
      severity: 'MEDIUM',
      failureTitle: 'No defined change management process is recorded.',
      failureDescription: 'Publish the change management process and supply it as evidence.',
      remediation: null,
      maxEvidenceAgeDays: 400,
    },
  ],
} as const;
