import pg from 'pg';
import {
  AdericelError,
  type Logger,
  errorFields,
  nullLogger,
  type AdericelConfig,
} from '@adericel/shared';

/**
 * Database access with mandatory tenant context.
 *
 * There is exactly one way to reach tenant data: `withTenant`. It opens a
 * transaction, sets `adericel.organisation_id` transaction-locally, and hands
 * back a query interface. Row level security then guarantees that a query
 * which forgets its WHERE clause returns nothing rather than everything.
 *
 * `withPlatform` exists for control-plane work (creating organisations,
 * resolving a principal's grants, worker sweeps). It is deliberately awkward to
 * reach and every use is audited.
 */

/**
 * A row as returned by the driver. Deliberately unconstrained: callers declare
 * the row shape they expect with an interface, and requiring those interfaces
 * to carry an index signature would add noise at every call site without adding
 * safety — the values are `unknown` until the caller narrows them either way.
 */
export type QueryResultRow = Record<string, unknown>;

export interface Queryable {
  query<T = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
}

export interface TenantContext extends Queryable {
  readonly organisationId: string;
  /** One row or null. Throws if the query returns more than one row. */
  one<T = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<T | null>;
  /** One row, throwing NOT_FOUND when absent. */
  oneOrFail<T = QueryResultRow>(
    text: string,
    values: readonly unknown[],
    resource: string,
  ): Promise<T>;
  many<T = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<T[]>;
}

export interface PlatformContext extends Queryable {
  one<T = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<T | null>;
  oneOrFail<T = QueryResultRow>(
    text: string,
    values: readonly unknown[],
    resource: string,
  ): Promise<T>;
  many<T = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<T[]>;
}

export interface Database {
  withTenant<T>(organisationId: string, fn: (ctx: TenantContext) => Promise<T>): Promise<T>;
  withPlatform<T>(fn: (ctx: PlatformContext) => Promise<T>): Promise<T>;
  /** Liveness probe; returns round-trip latency in milliseconds. */
  ping(): Promise<number>;
  close(): Promise<void>;
  readonly pool: pg.Pool;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function translateError(error: unknown): never {
  const pgError = error as { code?: string; constraint?: string; detail?: string; message?: string };
  switch (pgError.code) {
    case '23505':
      throw new AdericelError('CONFLICT', 'Resource already exists', {
        safeDetails: { constraint: pgError.constraint ?? null },
        cause: error,
      });
    case '23503':
      throw new AdericelError('VALIDATION_FAILED', 'Referenced resource does not exist', {
        safeDetails: { constraint: pgError.constraint ?? null },
        cause: error,
      });
    case '23514':
      throw new AdericelError('VALIDATION_FAILED', 'Value violates a domain constraint', {
        safeDetails: { constraint: pgError.constraint ?? null },
        cause: error,
      });
    case '42501':
      // RLS refusal. This is a genuine isolation event and must be loud.
      throw new AdericelError('TENANT_MISMATCH', 'Operation denied by tenant isolation policy', {
        cause: error,
      });
    case '57014':
      throw new AdericelError('DEPENDENCY_UNAVAILABLE', 'Database statement timed out', {
        cause: error,
        retryable: true,
      });
    case '40001':
    case '40P01':
      throw new AdericelError('CONFLICT', 'Transaction conflict; retry the operation', {
        cause: error,
        retryable: true,
      });
    default:
      throw new AdericelError('INTERNAL_ERROR', 'Database operation failed', { cause: error });
  }
}

function makeHelpers(client: pg.PoolClient): Omit<TenantContext, 'organisationId'> {
  const query = async <T>(text: string, values: readonly unknown[] = []) => {
    try {
      const result = await client.query(text, values as unknown[]);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    } catch (error) {
      translateError(error);
    }
  };

  return {
    query,
    async one<T>(text: string, values: readonly unknown[] = []) {
      const { rows } = await query<T>(text, values);
      if (rows.length > 1) {
        throw new AdericelError('INTERNAL_ERROR', 'Expected at most one row', {
          safeDetails: { received: rows.length },
        });
      }
      return rows[0] ?? null;
    },
    async oneOrFail<T>(
      text: string,
      values: readonly unknown[],
      resource: string,
    ) {
      const { rows } = await query<T>(text, values);
      const row = rows[0];
      if (row === undefined) {
        throw new AdericelError('NOT_FOUND', `${resource} not found`, {
          safeDetails: { resource },
        });
      }
      return row;
    },
    async many<T>(text: string, values: readonly unknown[] = []) {
      const { rows } = await query<T>(text, values);
      return rows;
    },
  };
}

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly poolMax?: number;
  readonly statementTimeoutMs?: number;
  readonly ssl?: boolean;
  readonly logger?: Logger;
  readonly applicationName?: string;
}

export function createDatabase(options: DatabaseOptions): Database {
  const logger = options.logger ?? nullLogger;
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
    application_name: options.applicationName ?? 'adericel',
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: 30_000,
    ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  pool.on('error', (error) => {
    logger.error(errorFields(error), 'database pool error');
  });

  async function runInTransaction<T>(
    setup: (client: pg.PoolClient) => Promise<void>,
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setup(client);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error(errorFields(rollbackError), 'rollback failed');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    pool,

    async withTenant<T>(organisationId: string, fn: (ctx: TenantContext) => Promise<T>): Promise<T> {
      if (!UUID_RE.test(organisationId)) {
        // Guarding here keeps a malformed identifier from ever reaching
        // set_config, where it would silently become an empty context.
        throw new AdericelError('VALIDATION_FAILED', 'Invalid organisation identifier');
      }
      return runInTransaction(
        async (client) => {
          await client.query("SELECT set_config('adericel.scope', 'tenant', true)");
          await client.query('SELECT set_config($1, $2, true)', [
            'adericel.organisation_id',
            organisationId,
          ]);
        },
        async (client) => fn({ organisationId, ...makeHelpers(client) }),
      );
    },

    async withPlatform<T>(fn: (ctx: PlatformContext) => Promise<T>): Promise<T> {
      return runInTransaction(
        async (client) => {
          await client.query("SELECT set_config('adericel.scope', 'platform', true)");
          await client.query("SELECT set_config('adericel.organisation_id', '', true)");
        },
        async (client) => fn(makeHelpers(client)),
      );
    },

    async ping(): Promise<number> {
      const started = Date.now();
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
        return Date.now() - started;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export function databaseFromConfig(config: AdericelConfig, logger?: Logger): Database {
  return createDatabase({
    connectionString: config.database.url,
    poolMax: config.database.poolMax,
    statementTimeoutMs: config.database.statementTimeoutMs,
    ssl: config.database.ssl,
    applicationName: config.serviceName,
    ...(logger ? { logger } : {}),
  });
}
