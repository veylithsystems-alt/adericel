import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertTenantIsolationEnforced,
  createDatabase,
  inspectTenantIsolation,
  type Database,
} from '@adericel/graph';
import { nullLogger } from '@adericel/shared';
import { databaseAvailable, ensureMigrated, testDatabaseUrl } from '../helpers/harness.js';

/**
 * Tenant isolation must be enforced by the database, not by luck.
 *
 * This exists because of a defect that every other test in the repository
 * missed, and that is worth recording precisely.
 *
 * ADR-0007 claims three independent layers of isolation, the second being
 * PostgreSQL row level security. Row level security is bypassed unconditionally
 * by a superuser; `FORCE ROW LEVEL SECURITY` closes the table-owner hole and
 * does nothing at all about a superuser. So whether layer 2 existed depended
 * entirely on how the operator provisioned the role behind `DATABASE_URL`.
 *
 * A deployment that got it wrong passed every test, served every request
 * correctly, and had one layer of defence instead of two — with no signal
 * anywhere. It was caught only because CI's postgres image creates its user as
 * a superuser, so six tenancy tests that passed locally failed there.
 *
 * The fix has two halves and this file tests both: transactions assume a role
 * that provably cannot bypass RLS, and the application refuses to start if that
 * is not true.
 */

const available = await databaseAvailable();

describe.skipIf(!available)('tenant isolation enforcement', () => {
  let enforced: Database;
  let unenforced: Database;

  beforeAll(async () => {
    await ensureMigrated();
    enforced = createDatabase({
      connectionString: testDatabaseUrl(),
      applicationRole: 'adericel_app',
      logger: nullLogger,
    });
    // The same connection, without assuming the application role. This is what
    // every deployment looked like before the fix.
    unenforced = createDatabase({
      connectionString: testDatabaseUrl(),
      applicationRole: null,
      logger: nullLogger,
    });
  });

  afterAll(async () => {
    await enforced?.close();
    await unenforced?.close();
  });

  describe('with the application role assumed', () => {
    it('runs as a role that cannot bypass row level security', async () => {
      const report = await inspectTenantIsolation(enforced);
      expect(report.effectiveRole).toBe('adericel_app');
      expect(report.isSuperuser).toBe(false);
      expect(report.bypassesRls).toBe(false);
    });

    it('protects every table that carries an organisation_id', async () => {
      const report = await inspectTenantIsolation(enforced);
      expect(report.unprotectedTables).toEqual([]);
    });

    it('returns nothing when the tenant context is cleared', async () => {
      const report = await inspectTenantIsolation(enforced);
      expect(report.leaksWithoutContext).toBe(false);
    });

    it('reports whether the behavioural probe was conclusive rather than implying it', async () => {
      // An empty database cannot distinguish enforcement from emptiness. Saying
      // so is the same discipline the product applies to its own customers:
      // absence of a finding is not evidence of a pass.
      const report = await inspectTenantIsolation(enforced);
      expect(typeof report.behaviouralProbeConclusive).toBe('boolean');
    });

    it('reports isolation as enforced, and starts', async () => {
      await expect(
        assertTenantIsolationEnforced({
          db: enforced,
          logger: nullLogger,
          isProduction: true,
        }),
      ).resolves.toMatchObject({ enforced: true });
    });

    it('holds even when the connection itself could bypass RLS', async () => {
      // The property that makes this a fix rather than a rename. The operator
      // may legitimately connect as the owner, or misconfigure a superuser —
      // neither is under Adericel's control. What Adericel controls is the role
      // the transaction runs as, and that is what RLS is evaluated against.
      const connectionRole = await unenforced.withPlatform(async (ctx) =>
        ctx.one<{ is_superuser: boolean }>(
          `SELECT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
                    AS is_superuser`,
        ),
      );
      const report = await inspectTenantIsolation(enforced);

      if (connectionRole?.is_superuser) {
        // The hostile case, and the one CI actually runs.
        expect(report.enforced).toBe(true);
      } else {
        // Still enforced; the assertion above is simply not exercising the
        // interesting condition on this machine.
        expect(report.enforced).toBe(true);
      }
    });
  });

  describe('without it', () => {
    it('is detected rather than assumed', async () => {
      const report = await inspectTenantIsolation(unenforced);
      // On a superuser connection this is the disaster case: isolation absent
      // and nothing complaining. On a non-superuser owner connection FORCE
      // still applies, so the report is honest either way — what matters is
      // that the check reports what is actually true rather than what the
      // configuration claims.
      expect(typeof report.enforced).toBe('boolean');
      expect(report.effectiveRole).not.toBe('adericel_app');
      if (report.isSuperuser) {
        expect(report.enforced).toBe(false);
        // The behavioural probe only proves a leak when there was something to
        // leak. On an empty database the catalogue checks are what condemn it,
        // which is why they are the ones that decide.
        if (report.behaviouralProbeConclusive) {
          expect(report.leaksWithoutContext).toBe(true);
        }
      }
    });

    it('refuses to start in production when isolation is absent', async () => {
      const report = await inspectTenantIsolation(unenforced);
      if (!report.enforced) {
        await expect(
          assertTenantIsolationEnforced({
            db: unenforced,
            logger: nullLogger,
            isProduction: true,
          }),
        ).rejects.toThrow(/Refusing to start: tenant isolation is not enforced/);
      } else {
        // This machine's connection role cannot bypass RLS, so there is nothing
        // to refuse. Asserted explicitly so the branch is not silently skipped.
        expect(report.isSuperuser).toBe(false);
      }
    });

    it('warns rather than refusing outside production, so development is not blocked', async () => {
      await expect(
        assertTenantIsolationEnforced({
          db: unenforced,
          logger: nullLogger,
          isProduction: false,
        }),
      ).resolves.toBeDefined();
    });
  });
});

describe.skipIf(available)('tenant isolation enforcement (skipped)', () => {
  it('requires a test database', () => {
    expect(true).toBe(true);
  });
});
