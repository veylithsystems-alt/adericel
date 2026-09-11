import { AdericelError, type Logger } from '@adericel/shared';
import type { Database } from './db.js';

/**
 * Prove that tenant isolation is actually in force.
 *
 * ADR-0007 claims three independent layers, the second being PostgreSQL row
 * level security. That claim was conditionally false in a way nothing detected:
 * RLS is bypassed unconditionally by a superuser, `FORCE ROW LEVEL SECURITY`
 * does nothing about that, and so whether the layer existed at all depended on
 * how the operator provisioned the role in `DATABASE_URL`.
 *
 * A deployment that got it wrong passed every test, served every request
 * correctly, and silently had one layer of defence in depth instead of two.
 * That is the exact shape of failure this product exists to refuse in its
 * customers, so it cannot be tolerated in itself.
 *
 * This runs at startup and asserts the property directly rather than trusting
 * configuration. It is deliberately not a health check: a running instance that
 * cannot isolate tenants should never have started.
 */

export interface IsolationReport {
  readonly effectiveRole: string;
  readonly isSuperuser: boolean;
  readonly bypassesRls: boolean;
  /** Tables carrying an organisation_id with no forced policy. */
  readonly unprotectedTables: readonly string[];
  /** True when a query with no tenant context returned rows. */
  readonly leaksWithoutContext: boolean;
  /**
   * Whether the behavioural probe had anything to find.
   *
   * On an empty database the zero-context read returns nothing whether or not
   * row level security is doing anything, so a pass there proves nothing. This
   * says so rather than letting a vacuous result count as evidence — the same
   * distinction the product makes between "proven" and "no reading here".
   */
  readonly behaviouralProbeConclusive: boolean;
  readonly enforced: boolean;
}

/**
 * A syntactically valid organisation id that cannot exist.
 *
 * The probe runs inside `withTenant` because that is the code path production
 * uses; checking the pool's own role would test something no request goes
 * through. Nothing is written, and the id resolves to no rows by construction.
 */
const PROBE_ORGANISATION = '00000000-0000-4000-8000-0000000000ff';

export async function inspectTenantIsolation(db: Database): Promise<IsolationReport> {
  return db.withTenant(PROBE_ORGANISATION, async (ctx) => {
    const role = await ctx.one<{
      current_user: string;
      is_superuser: boolean;
      bypasses_rls: boolean;
    }>(
      `SELECT current_user,
              COALESCE((SELECT rolsuper      FROM pg_roles WHERE rolname = current_user), false) AS is_superuser,
              COALESCE((SELECT rolbypassrls  FROM pg_roles WHERE rolname = current_user), false) AS bypasses_rls`,
    );

    // Every table carrying an organisation_id must have row level security
    // forced and at least one policy. A table added without one is tenant data
    // the database is not protecting.
    const unprotected = await ctx.many<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid
         LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE n.nspname = 'adericel'
          AND c.relkind = 'r'
          AND a.attname = 'organisation_id'
          AND a.attnum > 0
          AND NOT a.attisdropped
        GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
       HAVING NOT c.relrowsecurity
           OR NOT c.relforcerowsecurity
           OR COUNT(p.polname) = 0
        ORDER BY c.relname`,
    );

    // Whether there is anything for the probe to find. Asked under platform
    // scope, which the policy admits, so it reports the true row count rather
    // than a filtered one.
    await ctx.query(`SELECT set_config('adericel.scope', 'platform', true)`);
    const populated = await ctx.many<{ id: string }>('SELECT id FROM graph_nodes LIMIT 1');
    const behaviouralProbeConclusive = populated.length > 0;

    // The behavioural check. With no tenant context, a tenant-scoped read must
    // return nothing. This is the property every other guarantee rests on, and
    // verifying it against the live database beats inferring it from catalogue
    // state — a policy can exist and still be wrong.
    await ctx.query(`SELECT set_config('adericel.organisation_id', '', true)`);
    await ctx.query(`SELECT set_config('adericel.scope', 'tenant', true)`);
    const leaked = await ctx.many<{ id: string }>('SELECT id FROM graph_nodes LIMIT 1');

    const isSuperuser = role?.is_superuser ?? true;
    const bypassesRls = role?.bypasses_rls ?? true;
    const unprotectedTables = unprotected.map((row) => row.table_name);
    const leaksWithoutContext = leaked.length > 0;

    return {
      effectiveRole: role?.current_user ?? 'unknown',
      isSuperuser,
      bypassesRls,
      unprotectedTables,
      leaksWithoutContext,
      behaviouralProbeConclusive,
      // The catalogue checks hold on an empty database and are therefore the
      // ones that decide. The behavioural probe can only ever add a failure,
      // never manufacture a pass it did not earn.
      enforced:
        !isSuperuser && !bypassesRls && unprotectedTables.length === 0 && !leaksWithoutContext,
    };
  });
}

function describe(report: IsolationReport): string {
  const reasons: string[] = [];
  if (report.isSuperuser) {
    reasons.push(
      `the effective role "${report.effectiveRole}" is a superuser, and a superuser bypasses ` +
        'row level security unconditionally',
    );
  }
  if (report.bypassesRls) {
    reasons.push(`the effective role "${report.effectiveRole}" has BYPASSRLS`);
  }
  if (report.unprotectedTables.length > 0) {
    reasons.push(
      `these tables hold an organisation_id with no forced policy: ${report.unprotectedTables.join(', ')}`,
    );
  }
  if (report.leaksWithoutContext) {
    reasons.push('a query with no tenant context returned rows instead of none');
  }
  if (reasons.length === 0) {
    reasons.push('the reason could not be determined, which is itself disqualifying');
  }
  return reasons.join('; ');
}

/**
 * Refuse to start when tenant isolation is not in force.
 *
 * In production this throws. There is no configuration to soften it, because
 * the whole point is that the failure is otherwise invisible — an instance in
 * this state works perfectly right up until it serves one customer another
 * customer's assurance data.
 *
 * Outside production it logs at error level and continues, so that a developer
 * pointing at a scratch database is told clearly rather than blocked.
 */
export async function assertTenantIsolationEnforced(options: {
  readonly db: Database;
  readonly logger: Logger;
  readonly isProduction: boolean;
}): Promise<IsolationReport> {
  const report = await inspectTenantIsolation(options.db);

  if (report.enforced) {
    options.logger.info(
      {
        effectiveRole: report.effectiveRole,
        // Recorded rather than hidden: on a database with no rows yet, the
        // behavioural probe could not distinguish enforcement from emptiness,
        // and the catalogue checks are what carried the verdict.
        behaviouralProbeConclusive: report.behaviouralProbeConclusive,
      },
      'tenant isolation verified: row level security is in force',
    );
    return report;
  }

  const detail = describe(report);
  if (options.isProduction) {
    throw new AdericelError(
      'DEPENDENCY_UNAVAILABLE',
      `Refusing to start: tenant isolation is not enforced. ${detail}. ` +
        'Grant the application a non-superuser role (migration 0011 creates adericel_app) ' +
        'and set DATABASE_APPLICATION_ROLE.',
      { safeDetails: { effectiveRole: report.effectiveRole } },
    );
  }

  options.logger.error(
    {
      effectiveRole: report.effectiveRole,
      isSuperuser: report.isSuperuser,
      bypassesRls: report.bypassesRls,
      unprotectedTables: report.unprotectedTables,
      leaksWithoutContext: report.leaksWithoutContext,
    },
    `TENANT ISOLATION IS NOT ENFORCED — ${detail}. This would refuse to start in production.`,
  );
  return report;
}
