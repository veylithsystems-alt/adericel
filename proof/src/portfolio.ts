import {
  createHarness,
  seedTenant,
  signIn,
  signInWithMfa,
  type Harness,
  type SeededTenant,
} from '../../tests/helpers/harness.js';
import { portfolioPlan, type Archetype } from './archetypes.js';

/**
 * Building the hundred-customer estate.
 *
 * By calling the real API and running the real engine. There is no shortcut
 * here that writes assurance states directly, and that is deliberate: a
 * demonstration that inserted the answers would look identical to this one and
 * prove nothing about the product.
 *
 * The one thing done directly against the database is ageing — moving a
 * timestamp backwards to produce a customer whose evidence is 75 days old.
 * Time cannot be driven through the API, and waiting is not an option. Every
 * other condition in the portfolio is produced by making the product do it.
 */

export interface ProofCustomer {
  readonly slug: string;
  readonly archetype: Archetype;
  readonly tenant: SeededTenant;
}

export interface ProofPortfolio {
  readonly harness: Harness;
  readonly mspId: string;
  readonly operatorToken: string;
  readonly approverToken: string;
  readonly customers: readonly ProofCustomer[];
}

const MSP_SLUG = 'proof-portfolio';

/** An estate: identities and devices, some of them wrong on purpose. */
export function records(archetype: Archetype, slug: string) {
  const out: {
    kind: string;
    subjectExternalId: string;
    payload: Record<string, unknown>;
  }[] = [];

  for (let i = 0; i < archetype.identities; i += 1) {
    out.push({
      kind: 'IDENTITY_STATE',
      subjectExternalId: `${slug}-user-${i}`,
      payload: {
        externalId: `${slug}-user-${i}`,
        displayName: `${slug} person ${i}`,
        enabled: true,
        accountType: 'USER',
        mfaEnforced: i >= archetype.identitiesWithoutMfa,
        lastSignInAt: '2026-09-01T09:00:00.000Z',
      },
    });
  }

  /**
   * The rest of the estate.
   *
   * Identity and device facts alone leave thirteen controls permanently
   * UNKNOWN, because the frameworks also ask about backups, cloud storage,
   * vulnerabilities, policies and organisational configuration. A demonstration
   * that omitted them would show every customer with a coverage gap, which is
   * true of the fixture and not true of a properly connected customer.
   *
   * Supplied only to archetypes meant to be well observed. A customer whose
   * archetype is "thin coverage" keeps the gap, because that is the condition
   * being demonstrated.
   */
  if (archetype.fullEstate === true) {
    out.push({
      kind: 'CLOUD_RESOURCE_STATE',
      subjectExternalId: `${slug}-store-0`,
      payload: {
        externalId: `${slug}-store-0`,
        displayName: `${slug} object store`,
        category: 'OBJECT_STORAGE',
        publicAccess: false,
        encryptionEnabled: true,
        defaultCredentialsPresent: false,
      },
    });
    // Vulnerability facts attach to the asset they are about. The rule
    // aggregates over Device, Application, Service and CloudResource subjects,
    // so a free-standing "vulnerability summary" subject would satisfy nothing.
    for (const subject of [
      ...Array.from({ length: archetype.devices }, (_, i) => `${slug}-device-${i}`),
      `${slug}-store-0`,
      `${slug}-app-0`,
    ]) {
      out.push({
        kind: 'VULNERABILITY',
        subjectExternalId: subject,
        payload: {
          externalId: subject,
          displayName: subject,
          criticalOverdue: false,
          highOrCriticalOverdue14d: false,
          openCount: 3,
        },
      });
    }
    out.push({
      kind: 'BACKUP_STATE',
      subjectExternalId: `${slug}-backup-0`,
      payload: {
        externalId: `${slug}-backup-0`,
        displayName: `${slug} primary backup`,
        required: true,
        lastStatus: 'SUCCEEDED',
        lastSuccessAt: '2026-09-09T02:00:00.000Z',
      },
    });
    out.push({
      kind: 'CONFIGURATION_SETTING',
      subjectExternalId: `${slug}-config`,
      payload: {
        externalId: `${slug}-config`,
        displayName: 'Organisation configuration',
        passwordMinLength: 14,
        adminCount: 2,
        loggingEnabled: true,
        logRetentionDays: 180,
        lastRestoreTestAt: '2026-08-20T10:00:00.000Z',
        trainingCompletionRate: 0.96,
        incidentPlanPublished: true,
        incidentLastExerciseAt: '2026-06-15T10:00:00.000Z',
        changeProcessPublished: true,
        boundaryFirewallPresent: true,
      },
    });
    out.push({
      kind: 'POLICY_DOCUMENT',
      subjectExternalId: `${slug}-policy-infosec`,
      payload: {
        externalId: `${slug}-policy-infosec`,
        displayName: 'Information security policy',
        published: true,
        lastReviewedAt: '2026-05-01T10:00:00.000Z',
      },
    });
    out.push({
      kind: 'SUPPLIER_ATTESTATION',
      subjectExternalId: `${slug}-supplier-0`,
      payload: {
        externalId: `${slug}-supplier-0`,
        displayName: 'Primary cloud supplier',
        criticality: 'HIGH',
        assuranceType: 'ISO27001',
        verifiedAt: '2026-04-10T10:00:00.000Z',
      },
    });
    out.push({
      kind: 'APPLICATION_STATE',
      subjectExternalId: `${slug}-app-0`,
      payload: {
        externalId: `${slug}-app-0`,
        displayName: 'Line of business application',
        vendorSupported: true,
        defaultCredentialsPresent: false,
      },
    });
  }

  for (let i = 0; i < archetype.devices; i += 1) {
    out.push({
      kind: 'DEVICE_STATE',
      subjectExternalId: `${slug}-device-${i}`,
      payload: {
        externalId: `${slug}-device-${i}`,
        displayName: `${slug} laptop ${i}`,
        managed: true,
        diskEncrypted: i >= archetype.devicesUnencrypted,
        firewallEnabled: true,
        autorunDisabled: true,
        osSupported: true,
        osVersion: '14.6',
        lastPatchedAt: '2026-09-05T03:00:00.000Z',
        lastSyncAt: '2026-09-10T06:00:00.000Z',
        endpointProtectionInstalled: true,
        endpointProtectionRealtime: true,
        signaturesUpdatedAt: '2026-09-10T04:00:00.000Z',
        vendorSupported: true,
        defaultCredentialsPresent: false,
      },
    });
  }

  return out;
}

/**
 * Provision the portfolio.
 *
 * Sequential rather than parallel. A hundred customers created concurrently
 * would be a load test of the seeding path rather than a demonstration of the
 * product, and the interesting timings are in the operating cycle.
 */
export async function buildPortfolio(options: { quiet?: boolean } = {}): Promise<ProofPortfolio> {
  const log = (message: string): void => {
    if (!options.quiet) process.stdout.write(`${message}\n`);
  };

  const harness = await createHarness();
  await harness.truncate();

  const plan = portfolioPlan();
  const customers: ProofCustomer[] = [];

  log(`Provisioning ${plan.length} customer organisations under one MSP…`);
  for (const [index, entry] of plan.entries()) {
    const tenant = await seedTenant(harness, {
      slug: entry.slug,
      mspSlug: MSP_SLUG,
      records: records(entry.archetype, entry.slug),
      // Level 4 lets policy-permitted remediation run unattended, which is the
      // distinction the whole workload argument rests on. Customers whose
      // archetype needs an approval get a lower level below.
      autonomyLevel: entry.archetype.remediate === true ? 4 : 2,
    });
    customers.push({ slug: entry.slug, archetype: entry.archetype, tenant });
    if ((index + 1) % 20 === 0) log(`  ${index + 1}/${plan.length}`);
  }

  const mspId = customers[0]!.tenant.mspId;
  const operatorToken = await signIn(harness, `owner-${customers[0]!.slug}@test.invalid`);
  const approverToken = await signInWithMfa(harness, `approver-${customers[0]!.slug}@test.invalid`);

  log(`Provisioned ${customers.length} organisations under MSP ${mspId}.`);
  return { harness, mspId, operatorToken, approverToken, customers };
}

/**
 * Apply the conditions that cannot be produced by seeding alone.
 *
 * Run after the first collection, because several of them are about what
 * happens to an estate that has already been observed once.
 */
export async function applyConditions(portfolio: ProofPortfolio): Promise<void> {
  const { harness } = portfolio;

  for (const customer of portfolio.customers) {
    const { archetype, tenant } = customer;

    if (archetype.noConnector === true) {
      // Remove the integration entirely: this customer was never connected.
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(`DELETE FROM integrations WHERE organisation_id = $1`, [
          tenant.organisationId,
        ]);
      });
    }

    if (archetype.authenticationFails === true) {
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(`UPDATE integrations SET status = 'ERROR' WHERE organisation_id = $1`, [
          tenant.organisationId,
        ]);
      });
    }

    if (archetype.driftAfterFirstCycle === true) {
      // Somebody in the customer's estate turns off a second factor. Nobody
      // tells anybody; Adericel has to notice on the next collection.
      harness.fixtureState.apply(tenant.integrationId, `${customer.slug}-user-0`, {
        mfaEnforced: false,
      });
    }

    if (archetype.staleByDays !== undefined) {
      // The only direct database manipulation in the proof, and it is time.
      // Evidence, observations and determinations are all moved back together
      // so the estate is internally consistent — an inconsistent one would
      // produce exceptions that are artefacts of the harness.
      const days = archetype.staleByDays;
      await harness.db.withPlatform(async (ctx) => {
        for (const [table, column] of [
          ['evidence', 'collected_at'],
          ['observations', 'observed_at'],
          ['claims', 'asserted_at'],
          ['assessments', 'assessed_at'],
        ] as const) {
          await ctx.query(
            `UPDATE ${table} SET ${column} = ${column} - ($2 || ' days')::interval
              WHERE organisation_id = $1`,
            [tenant.organisationId, String(days)],
          );
        }
        await ctx.query(
          `UPDATE assurance_states
              SET since = since - ($2 || ' days')::interval,
                  last_assessed_at = last_assessed_at - ($2 || ' days')::interval
            WHERE organisation_id = $1`,
          [tenant.organisationId, String(days)],
        );
      });
    }
  }
}
