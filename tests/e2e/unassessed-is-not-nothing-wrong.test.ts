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
 * An organisation nobody has assessed yet must not look fine.
 *
 * Found by rendering the interface for the first time (RR-096). A freshly
 * onboarded customer with sixteen in-scope controls and no assessment showed,
 * on the MSP's portfolio page:
 *
 *   0 CRITICAL FINDINGS · 0 FAILING CONTROLS · 0 UNKNOWN CONTROLS
 *
 * All zeroes, on the first page an MSP sees. The assurance page one level down
 * said the opposite — sixteen unknown — and its own comment in the source warns
 * about exactly this: "An empty page is read as 'nothing wrong' — the same
 * claim a green dashboard makes, only quieter, and at the exact moment a
 * customer is deciding what this product is."
 *
 * The portfolio counted rows in `assurance_states`, so a control that had never
 * been assessed counted as nothing at all. It also fed `attentionRank`, so the
 * customer Adericel could say least about sorted last.
 *
 * The same page also said "No evidence has been collected" for every control of
 * an organisation holding three usable evidence records — a cause Adericel had
 * not established, stated as though it had.
 *
 * These go through HTTP rather than the services, because the defect was in
 * what the two routes answered, and both answers were individually defensible.
 */

const available = await databaseAvailable();

const RECORDS = [
  {
    kind: 'DEVICE_STATE',
    subjectExternalId: 'fresh-device-0',
    payload: {
      externalId: 'fresh-device-0',
      displayName: 'A Laptop',
      managed: true,
      diskEncrypted: true,
      osVersion: '14.6.1',
      lastSeenAt: '2026-09-08T09:00:00.000Z',
    },
  },
];

interface PortfolioBody {
  readonly organisationCount: number;
  readonly totals: { readonly unknownControls: number; readonly failingControls: number };
  readonly organisations: readonly {
    readonly organisationId: string;
    readonly counts: Record<string, number>;
    readonly state: string;
    readonly attentionRank: number;
  }[];
}

interface AssuranceBody {
  readonly controls: readonly {
    readonly key: string;
    readonly state: string;
    readonly unknownReason: string | null;
  }[];
}

describe.skipIf(!available)('a customer nobody has assessed yet', () => {
  let harness: Harness;
  let fresh: SeededTenant;
  let token: string;
  let controlCount: number;

  beforeAll(async () => {
    harness = await createHarness();
    // Deliberately NOT collected and NOT assessed. This is the state every
    // customer is in for the first few minutes of their life.
    fresh = await seedTenant(harness, { slug: 'fresh', records: RECORDS });
    token = await signIn(harness, 'owner-fresh@test.invalid');

    const row = await harness.db.withTenant(fresh.organisationId, async (ctx) =>
      ctx.one<{ count: string }>(`SELECT count(*)::text AS count FROM controls WHERE enabled`),
    );
    controlCount = Number(row?.count ?? '0');
  }, 300_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('has in-scope controls and no assessments at all', async () => {
    // The premise, asserted because both tests below would pass vacuously
    // against an organisation with no controls.
    expect(controlCount, 'the organisation has no in-scope controls').toBeGreaterThan(5);
    const assessed = await harness.db.withTenant(fresh.organisationId, async (ctx) =>
      ctx.one<{ count: string }>(
        `SELECT count(*)::text AS count FROM assurance_states WHERE subject_kind = 'CONTROL'`,
      ),
    );
    expect(Number(assessed?.count ?? '0'), 'something has already assessed this').toBe(0);
  });

  it('is reported to the MSP as unknown, not as nothing wrong', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/msps/${fresh.mspId}/portfolio`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as PortfolioBody;

    const entry = body.organisations.find((o) => o.organisationId === fresh.organisationId);
    expect(entry, 'the organisation is missing from its own MSP portfolio').toBeDefined();
    expect(
      entry?.counts.UNKNOWN,
      'every in-scope control is unassessed, so every one of them is unknown',
    ).toBe(controlCount);
    expect(entry?.counts.SATISFIED, 'nothing has been proven').toBe(0);
    expect(
      body.totals.unknownControls,
      'the portfolio total is the number an MSP reads first, and it was zero',
    ).toBe(controlCount);
    // The headline is the one word that reaches a person who reads nothing
    // else on the page.
    expect(entry?.state).toBe('UNKNOWN');
    // And it is not sorted below customers Adericel can actually speak to.
    expect(
      entry?.attentionRank,
      'a customer Adericel cannot speak to must not rank as needing no attention',
    ).toBeGreaterThan(0);
  });

  it('says the controls have never been assessed, not that no evidence exists', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${fresh.organisationId}/assurance`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as AssuranceBody;
    expect(body.controls.length).toBe(controlCount);

    const reasons = new Set(body.controls.map((control) => control.unknownReason));
    expect(
      [...reasons],
      'the reason must be the fact Adericel established, not a cause it inferred',
    ).toEqual(['NOT_YET_ASSESSED']);
    expect([...reasons], 'NO_EVIDENCE asserts a cause nobody checked').not.toContain('NO_EVIDENCE');
  });
});

describe.skipIf(!available)('a customer whose evidence was collected but not yet assessed', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness();
    tenant = await seedTenant(harness, { slug: 'collected', records: RECORDS });
    token = await signIn(harness, 'owner-collected@test.invalid');
    const collected = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}/collect`,
      headers: bearer(token),
    });
    expect(collected.statusCode, collected.body).toBe(200);
  }, 300_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('holds evidence, which is why "no evidence has been collected" was a lie', async () => {
    /**
     * The sharpest version of the defect. This organisation's own Proof page
     * reports three usable evidence records while its assurance page said no
     * evidence had been collected — two pages of the same product
     * contradicting each other about the same estate.
     */
    const held = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
      ctx.one<{ count: string }>(
        `SELECT count(*)::text AS count FROM evidence WHERE status = 'ACTIVE'`,
      ),
    );
    expect(
      Number(held?.count ?? '0'),
      'nothing was collected, so this proves nothing',
    ).toBeGreaterThan(0);

    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/assurance`,
      headers: bearer(token),
    });
    const body = response.json() as AssuranceBody;
    const claiming = body.controls
      .filter((c) => c.unknownReason === 'NO_EVIDENCE')
      .map((c) => c.key);
    expect(
      claiming,
      'these controls claim no evidence has been collected, and evidence has been collected',
    ).toEqual([]);
  });
});
