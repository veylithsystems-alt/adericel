import { registerVeylithRoutes } from '@adericel/veylith';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
  type Harness,
} from '../helpers/harness.js';

/**
 * The company surface, present and still bounded.
 *
 * WHY THIS IS NOT IN `tests/security`
 *
 * It needs `@adericel/veylith`, and `tests/company/` is the one test directory
 * the product does not carry. These assertions used to live inside
 * `tests/security/information-boundary.test.ts`, which meant that suite could
 * only pass with the company's code present — so the product's own repository
 * would have held a security suite it could not run.
 *
 * WHAT IS ASSERTED HERE AND NOT THERE
 *
 * The product suite asserts a client or an MSP gets 403 **or** 404 for a
 * company path, because on a product deployment the routes are absent. That is
 * the weaker statement, and it is all a product deployment can make. This
 * asserts the stronger one: with the company routes actually registered, the
 * surface boundary refuses them to everybody but Veylith. A separation that
 * only works because the code is missing is not a boundary — it is an absence,
 * and absences come back.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("Veylith's own surface, registered", () => {
  let harness: Harness;
  let mspToken: string;
  let clientToken: string;

  beforeAll(async () => {
    harness = await createHarness({
      env: { ADERICEL_COMPANY_LAYER: 'true' },
      additionalRoutes: [registerVeylithRoutes],
    });
    await harness.truncate();
    await seedTenant(harness, { slug: 'boundary-co', frameworks: [] });
    mspToken = await signIn(harness, 'owner-boundary-co@test.invalid');
    clientToken = await signIn(harness, 'analyst-boundary-co@test.invalid');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('registers the company routes, so the refusals below mean something', () => {
    // The premise. Every assertion here is that a *present* route is refused,
    // and against an unregistered route they would all pass by accident.
    expect(harness.server.printRoutes({ commonPrefix: false })).toMatch(/veylith/i);
  });

  it('refuses an MSP owner, with the routes present', async () => {
    for (const path of [
      '/v1/veylith/exceptions',
      '/v1/veylith/autonomy',
      '/v1/veylith/processes',
    ]) {
      const response = await harness.server.inject({
        method: 'GET',
        url: path,
        headers: bearer(mspToken),
      });
      expect(response.statusCode, `${path} answered ${response.statusCode} to an MSP owner`).toBe(
        403,
      );
    }
  });

  it('refuses a client analyst, with the routes present', async () => {
    for (const path of [
      '/v1/veylith/exceptions',
      '/v1/veylith/autonomy',
      '/v1/veylith/decisions',
    ]) {
      const response = await harness.server.inject({
        method: 'GET',
        url: path,
        headers: bearer(clientToken),
      });
      expect(response.statusCode, `${path} answered ${response.statusCode} to a client`).toBe(403);
    }
  });
});
