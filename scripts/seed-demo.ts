#!/usr/bin/env tsx
/**
 * Seed the demonstration environment.
 *
 * Produces a realistic MSP portfolio that exercises the whole assurance chain:
 * collection, normalisation, evidence, claims, deterministic assessment,
 * findings, an action, approval, execution, verification and an updated
 * assurance state.
 *
 * The demonstration deliberately includes failures, stale evidence and genuine
 * unknowns. A demo in which everything passes would demonstrate nothing.
 *
 * Idempotent: running it twice converges rather than duplicating.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PLANS,
  organisationSettingsSchema,
  type NewDomainEvent,
} from '@adericel/domain';
import { createCollectionService, createAssessmentService } from '@adericel/actions';
import { createBuiltInRegistry } from '@adericel/truth-engine';
import {
  createCredentialCipher,
  createLogger,
  createPasswordHasher,
  generateApiKey,
  loadConfig,
  newCorrelationId,
  systemClock,
} from '@adericel/shared';
import { databaseFromConfig, publish, type Database, type PlatformContext } from '@adericel/graph';
import { buildConnectorRegistry } from '@adericel/integrations';
import { SYSTEM_FRAMEWORKS } from '../database/seeds/frameworks.js';
import { DEMO_ORGANISATIONS } from '../database/seeds/demo-data.js';
import { ensureOrganisationJobs, ensurePlatformJobs } from '../apps/worker/src/jobs/scheduler.js';

const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'Adericel-demo-2026!';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.nodeEnv === 'production' && process.env.ADERICEL_ALLOW_DEMO_SEED !== 'yes') {
    throw new Error(
      'Refusing to seed demonstration data into a production environment. ' +
        'Set ADERICEL_ALLOW_DEMO_SEED=yes only if you are certain.',
    );
  }

  const clock = systemClock;
  const logger = createLogger({ level: 'info', pretty: true });
  const db = databaseFromConfig(config, logger);
  const passwords = createPasswordHasher(config.auth.passwordPepper);
  const cipher = createCredentialCipher(config.auth.credentialEncryptionKey);
  const rulesets = createBuiltInRegistry();
  const { registry: connectors } = buildConnectorRegistry({
    egressPolicy: { allowlist: [], blockPrivate: false },
    allowDemoConnectors: true,
  });
  const unsealCredentials = (sealed: string, integrationId: string) =>
    JSON.parse(cipher.decrypt(sealed, integrationId)) as Record<string, unknown>;

  const now = clock.nowIso();
  const correlationId = newCorrelationId();

  logger.info({}, 'seeding plans and frameworks');
  await db.withPlatform(async (ctx) => {
    for (const plan of DEFAULT_PLANS) {
      await ctx.query(
        `INSERT INTO plans (key, tier, name, price_per_organisation_minor, currency,
                            included_organisations, volume_tiers, features)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::text[])
         ON CONFLICT (key) DO UPDATE SET
           name = EXCLUDED.name,
           price_per_organisation_minor = EXCLUDED.price_per_organisation_minor,
           volume_tiers = EXCLUDED.volume_tiers,
           features = EXCLUDED.features`,
        [
          plan.key,
          plan.tier,
          plan.name,
          plan.pricePerOrganisationMinor,
          plan.currency,
          plan.includedOrganisations,
          JSON.stringify(plan.volumeTiers),
          plan.features,
        ],
      );
    }

    for (const framework of SYSTEM_FRAMEWORKS) {
      const row = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO frameworks (key, name, version, publisher, description, is_system)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (key, version) WHERE is_system
         DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
         RETURNING id`,
        [framework.key, framework.name, framework.version, framework.publisher, framework.description],
        'Framework',
      );
      for (const requirement of framework.requirements) {
        // The control keys live in the description because that is what the
        // onboarding mapping reads to link controls to requirements.
        await ctx.query(
          `INSERT INTO requirements (framework_id, key, title, description, weight)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (framework_id, key)
           DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description`,
          [
            row.id,
            requirement.key,
            requirement.title,
            requirement.controlKeys.join(' '),
            requirement.weight ?? 1,
          ],
        );
      }
    }

    await ensurePlatformJobs(ctx, now);
  });

  logger.info({}, 'seeding platform administrator');
  const platformAdminId = await upsertUser(db, passwords, {
    email: 'admin@adericel.test',
    displayName: 'Adericel Platform Admin',
    mspId: null,
    roles: ['PLATFORM_ADMIN'],
    scopeType: 'PLATFORM',
    scopeId: null,
  });

  logger.info({}, 'seeding MSP');
  const msp = await db.withPlatform(async (ctx) => {
    const row = await ctx.oneOrFail<{ id: string }>(
      `INSERT INTO msps (name, slug, contact_email, country_code)
       VALUES ('Meridian Managed IT', 'meridian', 'ops@meridian.test', 'GB')
       ON CONFLICT (lower(slug)) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [],
      'MSP',
    );

    await ctx.query(
      `INSERT INTO subscriptions
         (msp_id, plan_key, status, currency, price_per_organisation_minor, organisation_limit,
          current_period_start, current_period_end)
       VALUES ($1, 'standard', 'ACTIVE', 'GBP', 19900, 100, $2::timestamptz,
               $2::timestamptz + interval '1 month')
       ON CONFLICT (msp_id) WHERE msp_id IS NOT NULL AND status <> 'CANCELLED'
       DO UPDATE SET status = 'ACTIVE'`,
      [row.id, now],
    );

    // The MSP baseline: the assurance floor Meridian applies to every customer.
    const baseline = await ctx.oneOrFail<{ id: string }>(
      `INSERT INTO msp_baselines (msp_id, key, name, description, is_default)
       VALUES ($1, 'meridian-standard', 'Meridian Standard Assurance',
               'The controls Meridian applies to every managed customer.', true)
       ON CONFLICT (msp_id, key) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [row.id],
      'Baseline',
    );

    const ruleset = rulesets.get('adericel-baseline');
    const ce = rulesets.get('cyber-essentials');
    // MFA and public cloud storage are mandatory: a customer administrator
    // cannot weaken them locally.
    const mandatory = new Set(['identity.mfa.enforced', 'cloud.storage.not_public']);

    for (const rule of [...ruleset.rules, ...ce.rules]) {
      await ctx.query(
        `INSERT INTO msp_baseline_controls
           (baseline_id, control_key, title, description, ruleset_key, rule_key, parameters,
            requirement_keys, mandatory)
         VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, ARRAY[]::text[], $7)
         ON CONFLICT (baseline_id, control_key) DO UPDATE SET title = EXCLUDED.title`,
        [
          baseline.id,
          rule.key,
          rule.title,
          rule.description,
          ruleset.rules.includes(rule) ? ruleset.key : ce.key,
          rule.key,
          mandatory.has(rule.key),
        ],
      );
    }

    return row.id;
  });

  const mspOwnerId = await upsertUser(db, passwords, {
    email: 'owner@meridian.test',
    displayName: 'Jo Whitfield',
    mspId: msp,
    roles: ['MSP_OWNER'],
    scopeType: 'MSP',
    scopeId: msp,
  });

  const mspAnalystId = await upsertUser(db, passwords, {
    email: 'analyst@meridian.test',
    displayName: 'Dev Chandra',
    mspId: msp,
    roles: ['MSP_ANALYST'],
    scopeType: 'MSP',
    scopeId: msp,
  });

  // A dedicated approver who cannot propose. Four-eyes control is only real if
  // proposing and approving are held by different people.
  const approverId = await upsertUser(db, passwords, {
    email: 'approver@meridian.test',
    displayName: 'Ren Okafor',
    mspId: msp,
    roles: ['MSP_READONLY'],
    scopeType: 'MSP',
    scopeId: msp,
  });
  await db.withPlatform(async (ctx) => {
    await ctx.query(
      `UPDATE grants SET roles = ARRAY['MSP_READONLY','ORG_APPROVER']::text[]
       WHERE principal_id = $1 AND scope_type = 'MSP' AND revoked_at IS NULL`,
      [approverId],
    );
  });

  logger.info({}, 'provisioning organisations');
  const { provisionOrganisation } = await import('../apps/api/src/services/onboarding.js');
  const { createAppContext } = await import('../apps/api/src/context.js');
  const appContext = createAppContext({ config, clock, logger, db, connectors });

  const provisioned: { id: string; slug: string; narrative: string }[] = [];

  for (const demo of DEMO_ORGANISATIONS) {
    const existing = await db.withPlatform(async (ctx) =>
      ctx.one<{ id: string }>(`SELECT id FROM organisations WHERE slug = $1`, [demo.slug]),
    );

    const organisationId =
      existing?.id ??
      (
        await provisionOrganisation(appContext, {
          mspId: msp,
          input: {
            name: demo.name,
            slug: demo.slug,
            countryCode: demo.countryCode,
            industry: demo.industry,
            sizeBand: demo.sizeBand,
            settings: { defaultAutonomyLevel: demo.autonomyLevel },
            frameworks: [...demo.frameworks],
            applyMspBaseline: true,
          },
          actor: 'seed',
          actorUserId: mspOwnerId,
          correlationId,
        })
      ).id;

    await db.withPlatform(async (ctx) => {
      const settings = organisationSettingsSchema.parse({ defaultAutonomyLevel: demo.autonomyLevel });
      await ctx.query(`UPDATE organisations SET settings = $2::jsonb WHERE id = $1`, [
        organisationId,
        JSON.stringify(settings),
      ]);
      await ensureOrganisationJobs(ctx, organisationId, now);
    });

    // The fixture integration holds this organisation's demonstration dataset.
    const integrationId = await db.withTenant(organisationId, async (ctx) => {
      const node = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO graph_nodes (organisation_id, kind, external_id, label, attributes)
         VALUES ($1, 'Integration', 'integration:demo-fixture', 'Demonstration data source', '{}'::jsonb)
         ON CONFLICT (organisation_id, kind, external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET label = EXCLUDED.label
         RETURNING id`,
        [organisationId],
        'Integration node',
      );
      const row = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO integrations
           (organisation_id, node_id, connector_key, name, status, configuration, schedule_cron)
         VALUES ($1, $2, 'adericel-demo-fixture', 'Demonstration data source', 'CONNECTED',
                 $3::jsonb, '*/15 * * * *')
         ON CONFLICT (organisation_id, lower(name))
         DO UPDATE SET configuration = EXCLUDED.configuration, status = 'CONNECTED'
         RETURNING id`,
        [
          organisationId,
          node.id,
          JSON.stringify({
            datasetName: demo.slug,
            records: demo.records,
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
        `UPDATE integrations SET sealed_credentials = $2, credential_updated_at = now() WHERE id = $1`,
        [row.id, cipher.encrypt(JSON.stringify({}), row.id)],
      );
      return row.id;
    });

    logger.info({ organisation: demo.slug }, 'collecting demonstration observations');
    const collection = await db.withTenant(organisationId, async (ctx) =>
      createCollectionService({
        ctx,
        clock,
        logger,
        connectors,
        correlationId,
        actor: 'seed',
        unsealCredentials,
      }).runIntegration(integrationId, 'ONBOARDING'),
    );

    logger.info(
      {
        organisation: demo.slug,
        observations: collection.observationsRecorded,
        evidence: collection.evidenceCreated,
        claims: collection.claimsChanged,
        nodes: collection.nodesUpserted,
      },
      'collected',
    );

    logger.info({ organisation: demo.slug }, 'assessing');
    const assessed = await db.withTenant(organisationId, async (ctx) => {
      const service = createAssessmentService({
        ctx,
        clock,
        logger,
        rulesets,
        actor: 'seed',
        correlationId,
      });
      const outputs = await service.assessAllControls('ONBOARDING');

      const requirements = await ctx.many<{ requirement_id: string }>(
        `SELECT DISTINCT requirement_id FROM control_requirements WHERE organisation_id = $1`,
        [organisationId],
      );
      for (const row of requirements) await service.rollUpRequirement(row.requirement_id);

      const frameworks = await ctx.many<{ framework_id: string }>(
        `SELECT framework_id FROM organisation_frameworks WHERE organisation_id = $1`,
        [organisationId],
      );
      for (const row of frameworks) await service.rollUpFramework(row.framework_id);

      await service.rollUpOrganisation();
      return outputs;
    });

    const states = assessed.reduce<Record<string, number>>((acc, output) => {
      acc[output.assessment.state] = (acc[output.assessment.state] ?? 0) + 1;
      return acc;
    }, {});
    logger.info({ organisation: demo.slug, states }, 'assessed');

    provisioned.push({ id: organisationId, slug: demo.slug, narrative: demo.narrative });
  }

  logger.info({}, 'seeding the Adericel self-assurance organisation');
  const selfOrg = await db.withPlatform(async (ctx) =>
    ctx.one<{ id: string }>(`SELECT id FROM organisations WHERE slug = 'adericel'`),
  );
  if (!selfOrg) {
    const created = await provisionOrganisation(appContext, {
      mspId: null,
      input: {
        name: 'Adericel',
        slug: 'adericel',
        countryCode: 'GB',
        industry: 'Security software',
        sizeBand: '1-9',
        settings: { defaultAutonomyLevel: 1 },
        frameworks: ['adericel-baseline'],
        applyMspBaseline: false,
      },
      actor: 'seed',
      actorUserId: platformAdminId,
      correlationId,
    });
    logger.info({ organisationId: created.id }, 'Adericel now assesses itself with the same engine');
  }

  logger.info({}, 'issuing an API key for workflow automation');
  const apiKey = generateApiKey();
  await db.withPlatform(async (ctx) => {
    await ctx.query(`DELETE FROM api_keys WHERE name = 'n8n orchestration'`);
    const row = await ctx.oneOrFail<{ id: string }>(
      `INSERT INTO api_keys (key_id, secret_hash, name, description, msp_id, created_by)
       VALUES ($1, $2, 'n8n orchestration', 'Used by the Adericel n8n workflows', $3, $4)
       RETURNING id`,
      [apiKey.keyId, apiKey.secretHash, msp, platformAdminId],
      'API key',
    );
    // AUTOMATION deliberately cannot approve: a workflow must never satisfy the
    // four-eyes requirement for a change it proposed.
    await ctx.query(
      `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles, granted_by, grant_reason)
       VALUES ('API_KEY', $1, 'MSP', $2, ARRAY['AUTOMATION']::text[], $3,
               'n8n orchestration for the Meridian portfolio')
       ON CONFLICT DO NOTHING`,
      [row.id, msp, platformAdminId],
    );
  });

  await db.withPlatform(async (ctx) =>
    publish(
      ctx,
      {
        type: 'MspCreated',
        organisationId: null,
        mspId: msp,
        subjectType: 'Msp',
        subjectId: msp,
        payload: { name: 'Meridian Managed IT', organisations: provisioned.length },
        correlationId,
        actor: 'seed',
      } satisfies NewDomainEvent,
      now,
    ),
  );

  await db.close();

  console.log('');
  console.log('Adericel demonstration environment ready');
  console.log('═══════════════════════════════════════');
  console.log('');
  console.log('Sign in at the web interface with any of:');
  console.log('');
  console.log(`  Platform admin   admin@adericel.test      ${DEMO_PASSWORD}`);
  console.log(`  MSP owner        owner@meridian.test      ${DEMO_PASSWORD}`);
  console.log(`  MSP analyst      analyst@meridian.test    ${DEMO_PASSWORD}   (can propose, cannot approve)`);
  console.log(`  Approver         approver@meridian.test   ${DEMO_PASSWORD}   (can approve, cannot propose)`);
  console.log('');
  console.log('API key for n8n and automation (shown once, store it now):');
  console.log(`  ${apiKey.presented}`);
  console.log('');
  console.log('Organisations:');
  for (const org of provisioned) {
    console.log(`  ${org.slug.padEnd(20)} ${org.narrative}`);
  }
  console.log('');
  console.log('Suggested demonstration path:');
  console.log('  1. Open the Meridian portfolio. Northgate is green-ish; Calder & Finch is not;');
  console.log('     Brightwater is largely UNKNOWN because collection has barely started.');
  console.log('  2. Open Northgate, then the "Multi-factor authentication" control. Read why it');
  console.log('     fails — one identity, named, with the evidence that proves it.');
  console.log('  3. Propose the remediation as the analyst. Policy requires approval, so nothing');
  console.log('     happens yet.');
  console.log('  4. Sign in as the approver and approve it. The analyst could not have done this.');
  console.log('  5. Execute, then verify. Verification re-collects from the source rather than');
  console.log('     trusting the execution report.');
  console.log('  6. Reassess. The control moves to satisfied, and the audit trail holds every step.');
  console.log('');
}

interface SeedUser {
  readonly email: string;
  readonly displayName: string;
  readonly mspId: string | null;
  readonly roles: readonly string[];
  readonly scopeType: 'PLATFORM' | 'MSP' | 'ORGANISATION';
  readonly scopeId: string | null;
}

async function upsertUser(
  db: Database,
  passwords: { hash(password: string): Promise<string> },
  user: SeedUser,
): Promise<string> {
  const passwordHash = await passwords.hash(DEMO_PASSWORD);
  return db.withPlatform(async (ctx: PlatformContext) => {
    const row = await ctx.oneOrFail<{ id: string }>(
      `INSERT INTO users (email, display_name, msp_id, status)
       VALUES ($1, $2, $3, 'ACTIVE')
       ON CONFLICT (lower(email)) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [user.email, user.displayName, user.mspId],
      'User',
    );
    await ctx.query(
      `INSERT INTO user_credentials (user_id, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash,
                                           failed_attempts = 0, locked_until = NULL`,
      [row.id, passwordHash],
    );
    await ctx.query(
      `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles, grant_reason)
       VALUES ('USER', $1, $2, $3, $4::text[], 'Demonstration environment seed')
       ON CONFLICT (principal_type, principal_id, scope_type,
                    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'))
       WHERE revoked_at IS NULL
       DO UPDATE SET roles = EXCLUDED.roles`,
      [row.id, user.scopeType, user.scopeId, user.roles],
    );
    return row.id;
  });
}

main().catch((error: unknown) => {
  console.error('Seeding failed:', error instanceof Error ? error.stack : error);
  process.exit(1);
});

export { randomUUID };
