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
 * "Where does our data go?"
 *
 * Every MSP selling assurance to a UK SME is asked this, usually by somebody
 * with a solicitor. The answer has to come from the running system rather than
 * from a PDF, and a customer has to be able to check it themselves.
 *
 * These tests exercise the answer through the real API, on the default
 * deployment — the one an MSP actually installs — where no model is configured
 * at all.
 */

const available = await databaseAvailable();

interface DataProcessing {
  inference: {
    provider: string;
    sovereignty: string;
    sovereign: boolean;
    model: string;
    enabled: boolean;
    meaning: string;
    acknowledgement: string | null;
    standing: string;
  };
  assurance: string;
  limits: string;
}

describe.skipIf(!available)('where a deployment sends data', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, {
      slug: 'sovereign-corp',
      frameworks: ['cyber-essentials'],
    });
    token = await signIn(harness, 'analyst-sovereign-corp@test.invalid');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  const read = async (): Promise<DataProcessing> => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/v1/system/data-processing',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as DataProcessing;
  };

  it('answers that the default deployment sends documents nowhere', async () => {
    const body = await read();
    expect(body.inference.provider).toBe('none');
    expect(body.inference.sovereign).toBe(true);
    expect(body.inference.enabled).toBe(false);
  });

  it('states that no model participates in an assurance determination', async () => {
    const body = await read();
    // The sentence that makes the page safe to quote. Determinations come from
    // the Truth Engine reading observed evidence, at every provider setting.
    expect(body.assurance).toMatch(/no model participates in them/i);
    expect(body.inference.standing).toMatch(/not a determination/i);
  });

  it('refuses to be read as a compliance claim', async () => {
    const body = await read();
    // Somebody will otherwise screenshot this and put it in a tender response
    // under a heading about GDPR.
    expect(body.limits).toMatch(/not a statement of legal compliance/i);
  });

  it('is readable by an ordinary customer session, not just an operator', async () => {
    // The point of the page is that an MSP can show it to a customer and the
    // customer can check it themselves. A route only Veylith can read would
    // answer nobody's question.
    const response = await harness.server.inject({
      method: 'GET',
      url: '/v1/system/data-processing',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
  });

  it('is not readable without a session', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/v1/system/data-processing',
    });
    expect(response.statusCode).toBe(401);
  });

  it('names no organisation, so it cannot be used to enumerate customers', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/v1/system/data-processing',
      headers: bearer(token),
    });
    expect(response.body).not.toContain('sovereign-corp');
    expect(response.body).not.toContain(tenant.organisationId);
  });
});

/**
 * A deployment that has been pointed at someone else's infrastructure.
 *
 * The property under test is that it cannot happen quietly.
 */
describe.skipIf(!available)('a deployment configured to send data outside', () => {
  const ACKNOWLEDGEMENT =
    'Processed by our own vLLM server at rack 4, Manchester DC, operated by us. ' +
    'Approved by J. Whitmore, 2026-09-15.';

  it('refuses to start when nobody has said so in writing', async () => {
    await expect(
      createHarness({
        env: {
          INFERENCE_PROVIDER: 'openai-compatible',
          INFERENCE_BASE_URL: 'https://api.example.invalid/v1',
        },
      }),
    ).rejects.toThrow(/local-first by design/);
  }, 120_000);

  it('starts with an acknowledgement, and reports it where a customer can read it', async () => {
    const harness = await createHarness({
      env: {
        INFERENCE_PROVIDER: 'openai-compatible',
        INFERENCE_BASE_URL: 'https://gpu.internal.example.invalid/v1',
        INFERENCE_API_KEY: 'sk-not-a-real-key-value',
        INFERENCE_EXTERNAL_ACKNOWLEDGEMENT: ACKNOWLEDGEMENT,
      },
    });
    try {
      await harness.truncate();
      await seedTenant(harness, { slug: 'external-corp', frameworks: ['cyber-essentials'] });
      const token = await signIn(harness, 'analyst-external-corp@test.invalid');

      const response = await harness.server.inject({
        method: 'GET',
        url: '/v1/system/data-processing',
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as DataProcessing;

      expect(body.inference.sovereign).toBe(false);
      expect(body.inference.sovereignty).toBe('EXTERNAL');
      expect(body.inference.acknowledgement).toBe(ACKNOWLEDGEMENT);

      // The endpoint and the key never appear. An internal hostname is a small
      // gift to somebody mapping the estate.
      expect(response.body).not.toContain('gpu.internal.example.invalid');
      expect(response.body).not.toContain('sk-not-a-real-key-value');
    } finally {
      await harness.close();
    }
  }, 180_000);
});
