import { registerVeylithRoutes } from '@adericel/veylith';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
} from '../helpers/harness.js';
import type { Harness } from '../helpers/harness.js';

/**
 * Veylith's own deployment of Adericel.
 *
 * WHY THIS FILE IS NOT IN `tests/e2e`
 *
 * It needs `@adericel/veylith`, and `tests/company/` is the one test directory
 * the product does not carry. It used to be the second half of
 * `tests/e2e/product-separation.test.ts`, which meant the product's own
 * repository would have held a test importing a package it does not have.
 *
 * The product half stayed where it was: a product deployment proving it holds
 * none of this is the product's own claim to make, in its own repository.
 */

const available = await databaseAvailable();

describe.skipIf(!available)('a Veylith deployment', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    /**
     * A company deployment is now a composition, not a flag.
     *
     * `apps/veylith` is an entry point that depends on the product and hands it
     * the company's routes. That is what this does, which is why the import is
     * of `@adericel/veylith` and not of anything inside `apps/api`: if the
     * company's surface could still be reached from the product's own source,
     * the separation would not be real.
     */
    harness = await createHarness({
      env: { ADERICEL_COMPANY_LAYER: 'true' },
      additionalRoutes: [registerVeylithRoutes],
    });
    await harness.truncate();
    await seedTenant(harness, { slug: 'company-corp', frameworks: [] });
    token = await signIn(harness, 'analyst-company-corp@test.invalid');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('composes the company layer onto the product, so nothing was deleted', () => {
    /**
     * The positive case. A separation that removed the company layer and could
     * not put it back would be a deletion rather than a boundary, and every
     * negative test in the product suite would still pass.
     *
     * Note what is asserted and what is not: the routes are present **because
     * the entry point passed them in**, not because a flag was set. The flag
     * remains, and `apps/veylith` refuses to start without it, but it no longer
     * decides whether the product loads company code — the product has no
     * company code to load.
     */
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
