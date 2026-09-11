/**
 * Demonstration dataset.
 *
 * Deliberately realistic and deliberately imperfect. A demonstration where
 * everything passes proves nothing: the value of Adericel is visible only when
 * some controls fail, some evidence has gone stale, and some things are
 * genuinely unknown.
 *
 * Every record produced from this dataset is marked `demonstrationData: true`
 * by the fixture connector and is collected under the source system
 * `adericel-demo-fixture`, so it can never be mistaken for a real environment.
 */

export interface DemoRecord {
  readonly kind: string;
  readonly subjectExternalId: string | null;
  readonly payload: Record<string, unknown>;
  readonly observedAt?: string | null;
}

export interface DemoOrganisation {
  readonly name: string;
  readonly slug: string;
  readonly industry: string;
  readonly sizeBand: '1-9' | '10-49' | '50-249' | '250-999' | '1000+';
  readonly countryCode: string;
  readonly frameworks: readonly string[];
  readonly autonomyLevel: number;
  /** The narrative this organisation demonstrates. */
  readonly narrative: string;
  readonly records: readonly DemoRecord[];
}

function identity(id: string, name: string, overrides: Record<string, unknown> = {}): DemoRecord {
  return {
    kind: 'IDENTITY_STATE',
    subjectExternalId: id,
    payload: {
      externalId: id,
      displayName: name,
      userPrincipalName: `${id}@example.test`,
      enabled: true,
      accountType: 'USER',
      privileged: false,
      mfaEnforced: true,
      adminAccountSeparate: true,
      lastSignInAt: daysAgo(2),
      ...overrides,
    },
  };
}

function device(id: string, name: string, overrides: Record<string, unknown> = {}): DemoRecord {
  return {
    kind: 'DEVICE_STATE',
    subjectExternalId: id,
    payload: {
      externalId: id,
      name,
      operatingSystem: 'Windows',
      osVersion: '10.0.22631.3593',
      managed: true,
      diskEncrypted: true,
      firewallEnabled: true,
      autorunDisabled: true,
      osSupported: true,
      vendorSupported: true,
      defaultCredentialsPresent: false,
      endpointProtectionInstalled: true,
      endpointProtectionRealtime: true,
      signaturesUpdatedAt: daysAgo(1),
      lastPatchedAt: daysAgo(9),
      ...overrides,
    },
  };
}

/**
 * Timestamps are expressed relative to seed time so the demonstration always
 * shows freshness and staleness correctly, whenever it is run.
 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export const DEMO_ORGANISATIONS: readonly DemoOrganisation[] = [
  {
    name: 'Northgate Joinery',
    slug: 'northgate-joinery',
    industry: 'Manufacturing',
    sizeBand: '10-49',
    countryCode: 'GB',
    frameworks: ['cyber-essentials', 'adericel-baseline'],
    autonomyLevel: 3,
    narrative:
      'A well-run small customer with one genuine failure — an account without MFA — that Adericel ' +
      'can remediate end to end. This is the primary demonstration path.',
    records: [
      identity('nj-user-01', 'Alan Brooke'),
      identity('nj-user-02', 'Priya Raman'),
      identity('nj-user-03', 'Tom Ellery'),
      // The finding the demonstration remediates: a real account, MFA not enforced.
      identity('nj-user-04', 'Sasha Idowu', { mfaEnforced: false, lastSignInAt: daysAgo(1) }),
      identity('nj-admin-01', 'Alan Brooke (admin)', {
        privileged: true,
        accountType: 'USER',
        lastSignInAt: daysAgo(3),
      }),
      identity('nj-svc-backup', 'Backup service principal', {
        accountType: 'SERVICE',
        mfaEnforced: false,
        privileged: false,
      }),
      device('nj-dev-01', 'NJ-LAPTOP-01'),
      device('nj-dev-02', 'NJ-LAPTOP-02'),
      device('nj-dev-03', 'NJ-DESKTOP-01'),
      device('nj-dev-04', 'NJ-LAPTOP-04', { lastPatchedAt: daysAgo(12) }),
      {
        kind: 'CONFIGURATION_SETTING',
        subjectExternalId: null,
        payload: {
          passwordMinLength: 14,
          passwordBreachScreening: true,
          adminCount: 2,
          loggingEnabled: true,
          logRetentionDays: 180,
          lastRestoreTestAt: daysAgo(45),
          trainingCompletionRate: 0.94,
          boundaryFirewallPresent: true,
          firewallDefaultDenyInbound: true,
        },
      },
      {
        kind: 'BACKUP_STATE',
        subjectExternalId: 'nj-data-fileshare',
        payload: {
          externalId: 'nj-data-fileshare',
          name: 'Production file share',
          system: 'veeam',
          required: true,
          lastStatus: 'SUCCEEDED',
          lastSuccessAt: daysAgo(1),
        },
      },
      {
        kind: 'VULNERABILITY',
        subjectExternalId: 'nj-dev-01',
        payload: {
          assetExternalId: 'nj-dev-01',
          openCount: 3,
          criticalOverdue: false,
          highOrCriticalOverdue14d: false,
        },
      },
      {
        kind: 'POLICY_DOCUMENT',
        subjectExternalId: 'nj-pol-infosec',
        payload: {
          externalId: 'nj-pol-infosec',
          title: 'Information Security Policy',
          published: true,
          lastReviewedAt: daysAgo(120),
          owner: 'Alan Brooke',
          version: '2.1',
        },
      },
      {
        kind: 'SUPPLIER_ATTESTATION',
        subjectExternalId: 'nj-sup-cloudhost',
        payload: {
          externalId: 'nj-sup-cloudhost',
          name: 'Cloudhost Ltd',
          criticality: 'CRITICAL',
          assuranceType: 'ISO27001',
          verifiedAt: daysAgo(200),
        },
      },
    ],
  },
  {
    name: 'Calder & Finch Solicitors',
    slug: 'calder-finch',
    industry: 'Legal',
    sizeBand: '10-49',
    countryCode: 'GB',
    frameworks: ['cyber-essentials', 'adericel-baseline'],
    autonomyLevel: 1,
    narrative:
      'A customer with a genuinely serious problem — publicly readable cloud storage and an overdue ' +
      'critical vulnerability — plus an unsupported operating system. Demonstrates severity ordering ' +
      'and a remediation the default policy will not execute autonomously.',
    records: [
      identity('cf-user-01', 'Helena Calder', { privileged: true }),
      identity('cf-user-02', 'Marcus Finch'),
      identity('cf-user-03', 'Dana Osei'),
      // Dormant: enabled but unused far beyond the threshold.
      identity('cf-user-04', 'Former employee', { lastSignInAt: daysAgo(210) }),
      device('cf-dev-01', 'CF-LAPTOP-01'),
      device('cf-dev-02', 'CF-LAPTOP-02', {
        osVersion: '10.0.19044.1288',
        osSupported: false,
        vendorSupported: false,
        lastPatchedAt: daysAgo(64),
      }),
      device('cf-dev-03', 'CF-DESKTOP-01', { diskEncrypted: false }),
      {
        kind: 'CLOUD_RESOURCE_STATE',
        subjectExternalId: 'cf-storage-archive',
        payload: {
          externalId: 'cf-storage-archive',
          name: 'case-archive-bucket',
          provider: 'aws',
          region: 'eu-west-2',
          category: 'STORAGE',
          // The critical finding.
          publicAccess: true,
          encryptionEnabled: true,
        },
      },
      {
        kind: 'VULNERABILITY',
        subjectExternalId: 'cf-dev-02',
        payload: {
          assetExternalId: 'cf-dev-02',
          openCount: 27,
          criticalOverdue: true,
          highOrCriticalOverdue14d: true,
        },
      },
      {
        kind: 'CONFIGURATION_SETTING',
        subjectExternalId: null,
        payload: {
          passwordMinLength: 8,
          passwordBreachScreening: false,
          adminCount: 5,
          loggingEnabled: true,
          logRetentionDays: 30,
          trainingCompletionRate: 0.61,
          boundaryFirewallPresent: true,
          firewallDefaultDenyInbound: true,
        },
      },
      {
        kind: 'BACKUP_STATE',
        subjectExternalId: 'cf-data-matters',
        payload: {
          externalId: 'cf-data-matters',
          name: 'Matter management database',
          system: 'azure-backup',
          required: true,
          lastStatus: 'FAILED',
          lastSuccessAt: daysAgo(11),
        },
      },
    ],
  },
  {
    name: 'Brightwater Care',
    slug: 'brightwater-care',
    industry: 'Health and social care',
    sizeBand: '50-249',
    countryCode: 'GB',
    frameworks: ['adericel-baseline'],
    autonomyLevel: 0,
    narrative:
      'A recently onboarded customer where most controls are genuinely UNKNOWN because collection ' +
      'has barely started. Demonstrates that Adericel reports what it does not know rather than ' +
      'presenting an absence of evidence as a clean bill of health.',
    records: [
      identity('bw-user-01', 'Ruth Adeyemi', { privileged: true }),
      identity('bw-user-02', 'Callum Doyle'),
      // No device, cloud, backup, vulnerability or configuration observations at
      // all: those controls must report UNKNOWN, not SATISFIED.
    ],
  },
];
