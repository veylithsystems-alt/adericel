/**
 * Test harness.
 *
 * Builds a real API against a real PostgreSQL database. There are no mocked
 * repositories: the properties these tests assert — tenant isolation, row level
 * security, transactional outbox behaviour, four-eyes enforcement — are
 * properties of the database and the wiring, and a mocked test would assert
 * only that the mock behaves as written.
 *
 * When no test database is reachable the suites skip with a clear message
 * rather than failing, so a developer without PostgreSQL still gets a useful
 * unit-test run.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  createPasswordHasher,
  fixedClock,
  loadConfig,
  nullLogger,
  type AdericelConfig,
  type Clock,
} from '@adericel/shared';
import { databaseFromConfig, type Database } from '@adericel/graph';
import { buildConnectorRegistry, createFixtureState, type FixtureState } from '@adericel/integrations';
import { createFilesystemStore } from '@adericel/evidence';
import { buildServer, createAppContext, type AppContext } from '@adericel/api';
import { up as migrateUp } from '../../scripts/migrate.js';

export const TEST_INSTANT = '2026-09-09T12:00:00.000Z';

let migrated = false;
let available: boolean | null = null;

export function testDatabaseUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ??
    'postgres://adericel:adericel@localhost:5432/adericel_test'
  );
}

/** Whether a usable test database is reachable. Cached for the run. */
export async function databaseAvailable(): Promise<boolean> {
  if (available !== null) return available;
  const client = new pg.Client({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    available = true;
  } catch {
    available = false;
  } finally {
    await client.end().catch(() => undefined);
  }
  return available;
}

/**
 * Bring the test database to a known schema.
 *
 * The schema is dropped and rebuilt from the migrations on the first call of a
 * run. Rebuilding rather than reusing means the tests exercise the migrations
 * themselves on every run, and a schema left behind by an interrupted run can
 * never make a suite pass or fail for the wrong reason.
 */
export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  const url = testDatabaseUrl();
  if (!/test/i.test(url)) {
    throw new Error(
      `Refusing to rebuild the schema of a database whose name does not contain "test": ${url}`,
    );
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('DROP SCHEMA IF EXISTS adericel CASCADE');
    await migrateUp(client, () => undefined);
    migrated = true;
  } finally {
    await client.end();
  }
}

export interface Harness {
  readonly app: AppContext;
  readonly server: FastifyInstance;
  readonly db: Database;
  readonly clock: Clock;
  readonly fixtureState: FixtureState;
  readonly config: AdericelConfig;
  close(): Promise<void>;
  /** Remove all tenant and control-plane data, keeping the schema. */
  truncate(): Promise<void>;
}

export async function createHarness(options: { instant?: string } = {}): Promise<Harness> {
  await ensureMigrated();

  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    AUTH_JWT_SECRET: 'test-jwt-secret-value-that-is-long-enough-32',
    AUTH_CREDENTIAL_ENCRYPTION_KEY: 'test-credential-encryption-key-32-bytes!!',
    STORAGE_DRIVER: 'filesystem',
    STORAGE_FILESYSTEM_ROOT: `./var/test-storage/${randomUUID()}`,
    LOG_LEVEL: 'fatal',
    API_RATE_LIMIT_MAX: '100000',
  });

  const clock = fixedClock(options.instant ?? TEST_INSTANT);
  const db = databaseFromConfig(config, nullLogger);
  const fixtureState = createFixtureState();
  const { registry: connectors } = buildConnectorRegistry({
    egressPolicy: { allowlist: [], blockPrivate: false },
    allowDemoConnectors: true,
    fixtureState,
  });

  const app = createAppContext({
    config,
    clock,
    logger: nullLogger,
    db,
    storage: createFilesystemStore(config.storage.filesystemRoot),
    connectors,
  });

  const server = await buildServer(app);

  const harness: Harness = {
    app,
    server,
    db,
    clock,
    fixtureState,
    config,
    async close() {
      await server.close();
      await db.close();
    },
    async truncate() {
      await db.withPlatform(async (ctx) => {
        // Order matters only for the tables outside the cascade; TRUNCATE with
        // CASCADE handles the rest in one statement.
        await ctx.query(`
          TRUNCATE TABLE
            action_transitions, action_executions, verifications, approval_decisions,
            approvals, actions, policies, exceptions, risk_findings, risks, findings,
            assurance_states, assessments, claim_evidence, claims, evidence_observations,
            evidence_subjects, evidence, observations, integration_runs, integrations,
            control_requirements, controls, organisation_frameworks, graph_edges, graph_nodes,
            outbox_events, event_log, audit_log, idempotency_keys, scheduled_jobs, reports,
            subscriptions, msp_baseline_controls, msp_baselines, sessions, api_keys, grants,
            user_credentials, users, organisations, msps, requirements, frameworks
          RESTART IDENTITY CASCADE`);
      });
    },
  };

  return harness;
}

export interface SeededTenant {
  readonly mspId: string;
  readonly organisationId: string;
  readonly organisationSlug: string;
  readonly ownerUserId: string;
  readonly approverUserId: string;
  readonly analystUserId: string;
  readonly integrationId: string;
  readonly rootNodeId: string;
}

const TEST_PASSWORD = 'Test-password-2026!';

/**
 * Provision a minimal but complete tenant: an MSP, an organisation with
 * controls, three users with deliberately different authority, and a fixture
 * integration holding a supplied dataset.
 */
export async function seedTenant(
  harness: Harness,
  options: {
    slug: string;
    name?: string;
    records?: readonly { kind: string; subjectExternalId: string | null; payload: Record<string, unknown> }[];
    autonomyLevel?: number;
    frameworks?: readonly string[];
  },
): Promise<SeededTenant> {
  const { app, db, clock } = harness;
  const passwords = createPasswordHasher('');
  const passwordHash = await passwords.hash(TEST_PASSWORD);

  const mspId = await db.withPlatform(async (ctx) => {
    const row = await ctx.oneOrFail<{ id: string }>(
      `INSERT INTO msps (name, slug, contact_email) VALUES ($1, $2, $3)
       ON CONFLICT (lower(slug)) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [`MSP for ${options.slug}`, `msp-${options.slug}`, `ops-${options.slug}@test.invalid`],
      'MSP',
    );
    await ctx.query(
      `INSERT INTO plans (key, tier, name, price_per_organisation_minor, currency)
       VALUES ('standard', 'STANDARD', 'Standard', 19900, 'GBP')
       ON CONFLICT (key) DO NOTHING`,
    );
    await ctx.query(
      `INSERT INTO subscriptions (msp_id, plan_key, status, price_per_organisation_minor,
                                  current_period_start, current_period_end)
       VALUES ($1, 'standard', 'ACTIVE', 19900, now(), now() + interval '1 month')
       ON CONFLICT (msp_id) WHERE msp_id IS NOT NULL AND status <> 'CANCELLED' DO NOTHING`,
      [row.id],
    );
    return row.id;
  });

  const makeUser = async (
    email: string,
    name: string,
    roles: readonly string[],
  ): Promise<string> =>
    db.withPlatform(async (ctx) => {
      const row = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO users (email, display_name, msp_id, status)
         VALUES ($1, $2, $3, 'ACTIVE')
         ON CONFLICT (lower(email)) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [email, name, mspId],
        'User',
      );
      await ctx.query(
        `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
        [row.id, passwordHash],
      );
      await ctx.query(
        `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles)
         VALUES ('USER', $1, 'MSP', $2, $3::text[])
         ON CONFLICT (principal_type, principal_id, scope_type,
                      COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'))
         WHERE revoked_at IS NULL DO UPDATE SET roles = EXCLUDED.roles`,
        [row.id, mspId, roles],
      );
      return row.id;
    });

  const ownerUserId = await makeUser(`owner-${options.slug}@test.invalid`, 'Owner', ['MSP_OWNER']);
  const analystUserId = await makeUser(`analyst-${options.slug}@test.invalid`, 'Analyst', ['MSP_ANALYST']);
  const approverUserId = await makeUser(`approver-${options.slug}@test.invalid`, 'Approver', [
    'MSP_READONLY',
    'ORG_APPROVER',
  ]);

  const { provisionOrganisation } = await import('@adericel/api');
  const organisation = await provisionOrganisation(app, {
    mspId,
    input: {
      name: options.name ?? `Org ${options.slug}`,
      slug: options.slug,
      countryCode: 'GB',
      industry: null,
      sizeBand: null,
      settings: { defaultAutonomyLevel: options.autonomyLevel ?? 3 },
      frameworks: [...(options.frameworks ?? [])],
      applyMspBaseline: false,
    },
    actor: 'test',
    actorUserId: ownerUserId,
    correlationId: randomUUID(),
  });

  const integrationId = await db.withTenant(organisation.id, async (ctx) => {
    const node = await ctx.oneOrFail<{ id: string }>(
      `INSERT INTO graph_nodes (organisation_id, kind, external_id, label)
       VALUES ($1, 'Integration', 'integration:test-fixture', 'Test fixture')
       RETURNING id`,
      [organisation.id],
      'Integration node',
    );
    const row = await ctx.oneOrFail<{ id: string }>(
      `INSERT INTO integrations (organisation_id, node_id, connector_key, name, status, configuration)
       VALUES ($1, $2, 'adericel-demo-fixture', 'Test fixture', 'CONNECTED', $3::jsonb)
       RETURNING id`,
      [
        organisation.id,
        node.id,
        JSON.stringify({
          datasetName: options.slug,
          records: options.records ?? [],
          executableActionTypes: [
            'identity.mfa.require',
            'identity.account.disable',
            'cloud.storage.block_public_access',
          ],
          failVerificationFor: [],
        }),
      ],
      'Integration',
    );
    await ctx.query(
      `UPDATE integrations SET sealed_credentials = $2, credential_updated_at = $3::timestamptz WHERE id = $1`,
      [row.id, app.credentials.encrypt(JSON.stringify({}), row.id), clock.nowIso()],
    );
    return row.id;
  });

  return {
    mspId,
    organisationId: organisation.id,
    organisationSlug: organisation.slug,
    ownerUserId,
    approverUserId,
    analystUserId,
    integrationId,
    rootNodeId: organisation.nodeId,
  };
}

/** Sign in through the real login endpoint and return an access token. */
export async function signIn(harness: Harness, email: string): Promise<string> {
  const response = await harness.server.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Sign-in failed for ${email}: ${response.statusCode} ${response.body}`);
  }
  return (response.json() as { accessToken: string }).accessToken;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export { TEST_PASSWORD };
