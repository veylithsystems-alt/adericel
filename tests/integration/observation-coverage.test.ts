import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * "What can Adericel actually see?", answered through the API.
 *
 * Before this existed, an UNKNOWN control said "no evidence recorded" and left
 * the customer to work out which of three quite different things had happened:
 * nothing is connected that could see this; something is connected and was
 * refused a permission this morning; or two systems disagree and Adericel is
 * declining to choose. Presenting all three identically sends a customer
 * chasing a problem that is ours, or ignoring one that is theirs.
 *
 * These tests hold the API to telling them apart.
 */

const available = await databaseAvailable();

describe.skipIf(!available)('observation coverage', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    // A fixture configured with real records, because the fixture's capability
    // is a property of its dataset: an empty one honestly supplies nothing.
    tenant = await seedTenant(harness, {
      slug: 'coverage-corp',
      records: [
        {
          kind: 'IDENTITY_STATE',
          subjectExternalId: 'u1',
          payload: {
            externalId: 'u1',
            displayName: 'Alex Doe',
            enabled: true,
            accountType: 'USER',
            mfaEnforced: true,
          },
        },
        {
          kind: 'DEVICE_STATE',
          subjectExternalId: 'd1',
          payload: { externalId: 'd1', name: 'laptop-1', managed: true, diskEncrypted: true },
        },
      ],
    });
    token = await signIn(harness, 'owner-coverage-corp@test.invalid');
  });

  afterAll(async () => {
    await harness.close();
  });

  const coverage = async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/observation-coverage`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      domains: {
        domain: string;
        noConnectorExists: boolean;
        capabilities: { key: string; available: boolean }[];
      }[];
      requiredPredicates: number;
      satisfiedPredicates: number;
      gaps: { predicate: string; wouldBeSuppliedBy: { connectorKey: string; name: string }[] }[];
      multiplySourced: { predicate: string; sources: string[] }[];
      brokenCapabilities: unknown[];
      temporarilyUnavailable: string[];
      containsDemonstrationData: boolean;
    };
  };

  it('states how much of what the rulesets need can currently be supplied', async () => {
    const report = await coverage();
    expect(report.requiredPredicates).toBeGreaterThan(0);
    expect(report.satisfiedPredicates).toBeLessThanOrEqual(report.requiredPredicates);
    // The seeded tenant has only the fixture connector, so most of what Cyber
    // Essentials and ISO 27001 ask for is genuinely unavailable. Reporting that
    // honestly is the point.
    expect(report.gaps.length).toBeGreaterThan(0);
  });

  it('names the connector that would close each gap', async () => {
    const report = await coverage();
    const mfa = report.gaps.find((gap) => gap.predicate === 'identity.mfa.enforced');
    // The fixture supplies MFA state, so it should not be a gap at all.
    expect(mfa).toBeUndefined();

    const patch = report.gaps.find((gap) => gap.predicate === 'device.patch.last_applied_at');
    // Nothing supplies this. Saying so, and saying no connector would, is more
    // useful than an empty list that implies we simply have not looked.
    expect(patch?.wouldBeSuppliedBy).toEqual([]);
  });

  it('never offers a demonstration connector as the remedy for a gap', async () => {
    const report = await coverage();
    for (const gap of report.gaps) {
      expect(gap.wouldBeSuppliedBy.map((c) => c.connectorKey)).not.toContain(
        'adericel-demo-fixture',
      );
    }
  });

  it('says plainly when the estate contains demonstration data', async () => {
    const report = await coverage();
    expect(report.containsDemonstrationData).toBe(true);
  });

  it('groups what is and is not covered by evidence domain', async () => {
    const report = await coverage();
    const identity = report.domains.find((d) => d.domain === 'IDENTITY');
    expect(identity?.capabilities.some((c) => c.available)).toBe(true);
    expect(identity?.noConnectorExists).toBe(false);
    // A domain nothing can see must appear and say so. Omitting it would let a
    // customer read the covered domains as the whole picture and conclude
    // their backups were fine because nothing said otherwise.
    const backup = report.domains.find((d) => d.domain === 'BACKUP');
    expect(backup, 'a domain with no connector must still be listed').toBeDefined();
    expect(backup!.noConnectorExists).toBe(true);
    expect(backup!.capabilities).toEqual([]);

  });

  describe('an integration in detail', () => {
    it('reports NEVER_RUN rather than HEALTHY before the first collection', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}`,
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        health: string;
        fidelity: string;
        capabilities: { key: string; lastOutcome: string }[];
      };
      // A green light on an integration that has never run once is the exact
      // shape of a reassuring lie.
      expect(body.health).toBe('NEVER_RUN');
      expect(body.capabilities.every((c) => c.lastOutcome === 'NOT_YET_RUN')).toBe(true);
    });

    it('marks the fixture as DEMONSTRATION in the API, not only in the interface', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}`,
        headers: bearer(token),
      });
      const body = response.json() as { manifest: { fidelity: string } | null };
      expect(body.manifest?.fidelity).toBe('DEMONSTRATION');
    });

    it('does not leak another organisation an integration id it does not own', async () => {
      const other = await seedTenant(harness, { slug: 'coverage-other', records: [] });
      const otherToken = await signIn(harness, 'owner-coverage-other@test.invalid');
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${other.organisationId}/integrations/${tenant.integrationId}`,
        headers: bearer(otherToken),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('explaining an UNKNOWN control', () => {
    it('says which of the three reasons applies, and what would fix it', async () => {
      const list = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${tenant.organisationId}/assurance`,
        headers: bearer(token),
      });
      expect(list.statusCode).toBe(200);
      const controls = (list.json() as { controls: { id: string; state: string }[] }).controls;
      const unknown = controls.find((control) => control.state === 'UNKNOWN');
      expect(unknown, 'a freshly seeded tenant should have UNKNOWN controls').toBeDefined();

      const detail = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${tenant.organisationId}/controls/${unknown!.id}/explanation`,
        headers: bearer(token),
      });
      expect(detail.statusCode).toBe(200);
      const body = detail.json() as {
        state: string;
        evidenceGaps: { predicate: string; reason: string; remedy: string | null }[];
      };
      expect(body.state).toBe('UNKNOWN');
      expect(body.evidenceGaps.length).toBeGreaterThan(0);
      for (const gap of body.evidenceGaps) {
        expect([
          'NO_SOURCE',
          'CAPABILITY_FAILING',
          'SOURCES_DISAGREE',
          'AWAITING_COLLECTION',
        ]).toContain(gap.reason);
      }
    });
  });

  describe('source authority', () => {
    it('refuses an integration belonging to another organisation', async () => {
      const other = await seedTenant(harness, { slug: 'coverage-third', records: [] });
      const response = await harness.server.inject({
        method: 'PUT',
        url: `/v1/organisations/${tenant.organisationId}/source-authority`,
        headers: bearer(token),
        payload: {
          predicatePattern: 'device.',
          integrationIds: [other.integrationId],
        },
      });
      // Naming another tenant's integration must not succeed, and must not
      // confirm that the id exists either.
      expect(response.statusCode).toBe(400);
    });

    it('accepts a predicate family and stores it', async () => {
      const response = await harness.server.inject({
        method: 'PUT',
        url: `/v1/organisations/${tenant.organisationId}/source-authority`,
        headers: bearer(token),
        payload: {
          predicatePattern: 'device.',
          integrationIds: [tenant.integrationId],
          freshnessWindowHours: null,
        },
      });
      expect(response.statusCode).toBe(204);
    });

    it('rejects a pattern that is not a predicate namespace', async () => {
      const response = await harness.server.inject({
        method: 'PUT',
        url: `/v1/organisations/${tenant.organisationId}/source-authority`,
        headers: bearer(token),
        payload: { predicatePattern: 'DROP TABLE claims', integrationIds: [] },
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
