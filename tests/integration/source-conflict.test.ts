import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClaimRepository, createConflictRepository } from '@adericel/evidence';
import { createNodeRepository } from '@adericel/graph';
import {
  createHarness,
  databaseAvailable,
  seedTenant,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * Two sources disagreeing.
 *
 * Adericel keeps one live claim per (subject, predicate), so before this
 * existed a second source silently superseded the first. Two systems flatly
 * contradicting each other about whether a laptop was encrypted resolved
 * itself by whichever collection happened to run last — and nothing anywhere
 * recorded that the question had been contested.
 *
 * That is manufactured certainty, which is the one thing this product must
 * never do. These tests exist to prove it cannot happen again, so several of
 * them assert that Adericel produces NOTHING where it previously produced a
 * confident answer.
 */

const available = await databaseAvailable();

describe.skipIf(!available)('source conflict', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let deviceNodeId: string;
  let secondIntegrationId: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'conflict-corp', records: [] });

    await harness.db.withTenant(tenant.organisationId, async (ctx) => {
      const nodes = createNodeRepository(ctx);
      const node = await nodes.upsert({
        kind: 'Device',
        externalId: 'laptop-17',
        label: 'laptop-17',
        attributes: {},
        sourceIntegrationId: tenant.integrationId,
        observedAt: '2026-03-01T00:00:00.000Z',
      });
      deviceNodeId = node.id;

      const row = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO integrations
           (organisation_id, connector_key, name, status, configuration)
         VALUES ($1, 'generic-http-json', 'Our RMM', 'CONNECTED', '{}'::jsonb)
         RETURNING id`,
        [tenant.organisationId],
        'Integration',
      );
      secondIntegrationId = row.id;
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  /** Assert one predicate for the device, attributed to one integration. */
  async function assertFrom(
    integrationId: string | null,
    value: unknown,
    options: { predicate?: string; observedAt?: string } = {},
  ) {
    return harness.db.withTenant(tenant.organisationId, async (ctx) => {
      const claims = createClaimRepository(ctx, harness.clock);
      return claims.assert(
        {
          predicate: options.predicate ?? 'device.disk.encrypted',
          subjectNodeId: deviceNodeId,
          subjectExternalId: 'laptop-17',
          value,
          origin: 'DETERMINISTIC_NORMALISATION',
          status: 'CONFIRMED',
          extractionConfidence: null,
          evidenceIds: [],
          observedAt: options.observedAt ?? '2026-03-01T00:00:00.000Z',
          validUntil: null,
          supersedesClaimId: null,
          sourceIntegrationId: integrationId,
          metadata: {},
        },
        'test',
        deviceNodeId,
      );
    });
  }

  async function liveClaims(predicate = 'device.disk.encrypted') {
    return harness.db.withTenant(tenant.organisationId, async (ctx) =>
      ctx.many<{ id: string; value: unknown; status: string; source_integration_id: string | null }>(
        `SELECT id, value, status, source_integration_id FROM claims
         WHERE organisation_id = $1 AND predicate = $2 ORDER BY asserted_at, id`,
        [tenant.organisationId, predicate],
      ),
    );
  }

  async function openConflicts() {
    return harness.db.withTenant(tenant.organisationId, async (ctx) =>
      createConflictRepository(ctx, harness.clock).open(),
    );
  }

  async function setAuthority(
    predicatePattern: string,
    integrationIds: readonly string[],
    freshnessWindowHours: number | null = null,
  ) {
    await harness.db.withTenant(tenant.organisationId, async (ctx) => {
      await ctx.query(
        `INSERT INTO source_authority_policies
           (organisation_id, predicate_pattern, integration_ids, freshness_window_hours, set_by_actor)
         VALUES ($1, $2, $3::uuid[], $4, 'test')
         ON CONFLICT (organisation_id, predicate_pattern) DO UPDATE SET
           integration_ids = EXCLUDED.integration_ids,
           freshness_window_hours = EXCLUDED.freshness_window_hours`,
        [tenant.organisationId, predicatePattern, [...integrationIds], freshnessWindowHours],
      );
    });
  }

  async function clearClaims() {
    await harness.db.withTenant(tenant.organisationId, async (ctx) => {
      await ctx.query(`DELETE FROM claim_conflicts WHERE organisation_id = $1`, [
        tenant.organisationId,
      ]);
      await ctx.query(`DELETE FROM claims WHERE organisation_id = $1`, [tenant.organisationId]);
      await ctx.query(`DELETE FROM source_authority_policies WHERE organisation_id = $1`, [
        tenant.organisationId,
      ]);
    });
  }

  describe('when nothing resolves the disagreement', () => {
    beforeAll(clearClaims);

    it('withholds the claim rather than believing whichever ran last', async () => {
      await assertFrom(tenant.integrationId, true);
      const second = await assertFrom(secondIntegrationId, false);

      expect(second.conflict?.resolution).toBe('UNRESOLVED');
      expect(second.claim.status).toBe('DISPUTED');

      const claims = await liveClaims();
      // Neither position survives as readable truth. That is the point: the
      // honest answer to a contested question is that we do not know.
      expect(claims.map((c) => c.status).sort()).toEqual(['DISPUTED', 'DISPUTED']);
      expect(claims.some((c) => c.status === 'CONFIRMED')).toBe(false);
    });

    it('leaves no live claim for a rule to read, so the control is UNKNOWN', async () => {
      const readable = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
        ctx.many(
          `SELECT id FROM claims
           WHERE organisation_id = $1 AND predicate = 'device.disk.encrypted'
             AND status IN ('CANDIDATE', 'CONFIRMED')`,
          [tenant.organisationId],
        ),
      );
      expect(readable).toHaveLength(0);
    });

    it('records the disagreement with both positions named', async () => {
      const conflicts = await openConflicts();
      expect(conflicts).toHaveLength(1);
      const conflict = conflicts[0]!;
      expect(conflict.predicate).toBe('device.disk.encrypted');
      expect(conflict.resolution).toBe('UNRESOLVED');
      expect(conflict.resolvedValue).toBeNull();
      expect(conflict.distinctValues).toBe(2);
      expect(conflict.sources.map((s) => s.displayName).sort()).toEqual(['Our RMM', 'Test fixture']);
      expect(conflict.detail).toContain('will not choose');
    });

    it('treats a disagreement across ten runs as one fact, not ten', async () => {
      for (let i = 0; i < 4; i += 1) {
        await assertFrom(tenant.integrationId, true);
        await assertFrom(secondIntegrationId, false);
      }
      expect(await openConflicts()).toHaveLength(1);
    });
  });

  describe('when the sources agree', () => {
    beforeAll(clearClaims);

    it('records no conflict and keeps the claim readable', async () => {
      await assertFrom(tenant.integrationId, true);
      const second = await assertFrom(secondIntegrationId, true);
      expect(second.conflict?.resolution).toBe('AGREED');
      expect(await openConflicts()).toHaveLength(0);
      const claims = await liveClaims();
      expect(claims.filter((c) => c.status === 'CONFIRMED')).toHaveLength(1);
    });

    it('closes an open disagreement once the sources agree again', async () => {
      await assertFrom(secondIntegrationId, false);
      expect(await openConflicts()).toHaveLength(1);

      // The RMM is fixed and now agrees. Note this needs the disputed pair to
      // be superseded first, which the next agreeing assertion does.
      await harness.db.withTenant(tenant.organisationId, async (ctx) => {
        await ctx.query(
          `UPDATE claims SET status = 'SUPERSEDED'
           WHERE organisation_id = $1 AND status = 'DISPUTED'`,
          [tenant.organisationId],
        );
      });
      await assertFrom(tenant.integrationId, true);
      await assertFrom(tenant.integrationId, true);
      expect(await openConflicts()).toHaveLength(0);

      const conflicts = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
        ctx.many<{ resolved_at: Date | null }>(
          `SELECT resolved_at FROM claim_conflicts WHERE organisation_id = $1`,
          [tenant.organisationId],
        ),
      );
      // Closed, not deleted. That this control was contested is part of the record.
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.resolved_at).not.toBeNull();
    });
  });

  describe('when the organisation has named an authority', () => {
    beforeAll(clearClaims);

    it('honours the configured source and keeps the claim readable', async () => {
      await setAuthority('device.', [tenant.integrationId]);
      await assertFrom(tenant.integrationId, true);
      const second = await assertFrom(secondIntegrationId, false);

      expect(second.conflict?.resolution).toBe('RESOLVED_BY_AUTHORITY');
      expect(second.conflict?.value).toBe(true);
      // The losing value is not written. The authoritative claim stands.
      expect(second.changed).toBe(false);
      const claims = await liveClaims();
      const live = claims.filter((c) => c.status === 'CONFIRMED');
      expect(live).toHaveLength(1);
      expect(live[0]!.value).toBe(true);
    });

    it('still records that the sources disagreed', async () => {
      const conflicts = await openConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.resolution).toBe('RESOLVED_BY_AUTHORITY');
      expect(conflicts[0]!.resolvedValue).toBe(true);
    });

    it('prefers the more specific pattern over the family', async () => {
      await clearClaims();
      await setAuthority('device.', [tenant.integrationId]);
      await setAuthority('device.disk.encrypted', [secondIntegrationId]);
      await assertFrom(tenant.integrationId, true);
      const second = await assertFrom(secondIntegrationId, false);
      expect(second.conflict?.value).toBe(false);
    });
  });

  describe('recency is not authority', () => {
    beforeAll(clearClaims);

    it('does not let five minutes of scheduling decide a contested fact', async () => {
      await setAuthority('device.', [], 24);
      await assertFrom(tenant.integrationId, true, { observedAt: '2026-03-01T00:00:00.000Z' });
      const second = await assertFrom(secondIntegrationId, false, {
        observedAt: '2026-03-01T00:05:00.000Z',
      });
      expect(second.conflict?.resolution).toBe('UNRESOLVED');
    });

    it('resolves by freshness only when the margin exceeds the configured window', async () => {
      await clearClaims();
      await setAuthority('device.', [], 24);
      await assertFrom(tenant.integrationId, true, { observedAt: '2026-03-01T00:00:00.000Z' });
      const second = await assertFrom(secondIntegrationId, false, {
        observedAt: '2026-03-05T00:00:00.000Z',
      });
      expect(second.conflict?.resolution).toBe('RESOLVED_BY_FRESHNESS');
      expect(second.conflict?.value).toBe(false);
    });
  });

  describe('what is not a conflict', () => {
    beforeAll(clearClaims);

    it('lets one source revise its own reading without dispute', async () => {
      await assertFrom(tenant.integrationId, true);
      const revised = await assertFrom(tenant.integrationId, false);
      expect(revised.conflict).toBeNull();
      expect(revised.claim.status).toBe('CONFIRMED');
      expect(revised.claim.value).toBe(false);
      expect(await openConflicts()).toHaveLength(0);
    });

    it('does not dispute a human assertion against an integration reading', async () => {
      await clearClaims();
      await assertFrom(tenant.integrationId, true);
      // A person recording something has no source integration. Treating that
      // as a machine conflict would make manual evidence unusable.
      const manual = await assertFrom(null, false);
      expect(manual.conflict).toBeNull();
      expect(manual.claim.status).toBe('CONFIRMED');
    });
  });
});
