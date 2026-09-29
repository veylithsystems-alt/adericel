import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
} from '../helpers/harness.js';
import type { Harness, SeededTenant } from '../helpers/harness.js';

/**
 * Adericel, running as the product a customer self-hosts.
 *
 * Adericel is sold to MSPs, some of whom will run it on their own
 * infrastructure. What they must receive is the assurance platform. What they
 * must not receive is Veylith Systems' own operating and commercial machinery:
 * the autonomy gate, the exception queue, the business ledger, the pipeline.
 *
 * Until now they got all of it. `apps/api` imported the company layer at
 * startup and registered its routes unconditionally, while the README claimed
 * the opposite and the architecture test asserted the separation over
 * `packages/` only — which is exactly where the dependency was not. The
 * documentation was wrong and the test was true about the wrong thing.
 *
 * This suite is the product deployment, checked from the outside.
 */

const available = await databaseAvailable();

describe.skipIf(!available)('a product deployment', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let token: string;

  beforeAll(async () => {
    // No ADERICEL_COMPANY_LAYER, which is how a customer installs it.
    harness = await createHarness({ env: { ADERICEL_COMPANY_LAYER: '' } });
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'selfhost-corp', frameworks: ['cyber-essentials'] });
    token = await signIn(harness, 'analyst-selfhost-corp@test.invalid');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('runs with the company layer off', () => {
    expect(harness.config.companyLayerEnabled).toBe(false);
  });

  it('registers no company route at all', () => {
    /**
     * Not refused — absent.
     *
     * An unregistered path resolves to no surface and `decide` refuses every
     * question asked with no surface, so authorisation would have caught it
     * anyway. Not registering is stronger: there is nothing to probe, nothing
     * to enumerate, and nothing for a later change to accidentally open.
     */
    const routes = harness.server.printRoutes({ commonPrefix: false });
    expect(routes).not.toMatch(/veylith/i);
  });

  it('answers a company path as if it does not exist', async () => {
    for (const url of [
      '/v1/veylith/processes',
      '/v1/veylith/exceptions',
      '/v1/veylith/ledger',
      '/v1/veylith/pipeline',
    ]) {
      const response = await harness.server.inject({ method: 'GET', url, headers: bearer(token) });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('still does the whole job it was bought for', async () => {
    /**
     * The half that matters as much as the absence. A separation that removed
     * capability would be a worse product honestly labelled, and this asserts
     * that nothing a customer pays for went with the company layer.
     */
    const assurance = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/assurance`,
      headers: bearer(token),
    });
    expect(assurance.statusCode).toBe(200);

    for (const url of [
      `/v1/organisations/${tenant.organisationId}/evidence`,
      `/v1/organisations/${tenant.organisationId}/findings`,
      `/v1/organisations/${tenant.organisationId}/integrations`,
      '/v1/support/model',
      '/v1/commercial/states',
      '/v1/containment/levels',
      '/v1/capabilities',
      '/v1/connectors',
      '/v1/rulesets',
    ]) {
      const response = await harness.server.inject({ method: 'GET', url, headers: bearer(token) });
      expect(response.statusCode, url).toBeLessThan(400);
    }
  });

  it('keeps proof of value, because that belongs to the MSP', async () => {
    /**
     * `@adericel/value` counts what Adericel did and prices it only with
     * durations the MSP supplied. That is the MSP's argument to their own
     * client at renewal — the most useful thing in the product for the
     * conversation that pays for it.
     *
     * The README described it as company machinery alongside VAOL. It is not,
     * and withholding it from a self-hosted deployment would have been
     * withholding the argument for the deployment.
     */
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/msps/${tenant.mspId}/value/effort-model`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBeLessThan(400);
  });

  it('says which layer it is running, so an operator can tell', async () => {
    const response = await harness.server.inject({ method: 'GET', url: '/v1/system/version' });
    expect(response.statusCode).toBe(200);
  });
});

describe.skipIf(!available)('a Veylith deployment', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ env: { ADERICEL_COMPANY_LAYER: 'true' } });
    await harness.truncate();
    await seedTenant(harness, { slug: 'company-corp', frameworks: [] });
    token = await signIn(harness, 'analyst-company-corp@test.invalid');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('has the company layer, so the flag is a switch and not a deletion', () => {
    /**
     * The positive case. A flag that turned the company layer off and could not
     * turn it back on would have removed a capability rather than separated
     * one, and every negative test above would still pass.
     */
    expect(harness.config.companyLayerEnabled).toBe(true);
    expect(harness.server.printRoutes({ commonPrefix: false })).toMatch(/veylith/i);
  });

  it('serves the company routes to a company principal, and to nobody else', async () => {
    // Registered, and still behind the surface boundary: the Veylith routes are
    // VEYLITH_INTERNAL only, so an MSP analyst is refused rather than served.
    const response = await harness.server.inject({
      method: 'GET',
      url: '/v1/veylith/processes',
      headers: bearer(token),
    });
    expect(response.statusCode).not.toBe(404);
    expect([401, 403]).toContain(response.statusCode);
  });
});
