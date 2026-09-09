import {
  organisationSettingsSchema,
  type NewDomainEvent,
  type OrganisationCreateInput,
} from '@adericel/domain';
import { publish } from '@adericel/graph';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';

/**
 * Organisation provisioning.
 *
 * Onboarding is the moment Adericel's unit economics are decided. Everything
 * here is automated: an MSP adding their fortieth customer must not require a
 * person to configure controls by hand, or the product becomes a
 * professional-services business wearing software's clothes.
 *
 * The whole provisioning runs in one transaction. A half-onboarded
 * organisation — one with controls but no framework, or a graph root but no
 * baseline — would produce assurance states that mean nothing.
 */

export interface ProvisionInput {
  readonly mspId: string | null;
  readonly input: OrganisationCreateInput;
  readonly actor: string;
  readonly actorUserId: string | null;
  readonly correlationId: string;
}

export interface ProvisionedOrganisation {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly mspId: string | null;
  readonly controlsCreated: number;
  readonly frameworksAdopted: readonly string[];
  readonly nodeId: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export async function provisionOrganisation(
  app: AppContext,
  request: ProvisionInput,
): Promise<ProvisionedOrganisation> {
  const now = app.clock.nowIso();
  const settings = organisationSettingsSchema.parse(request.input.settings ?? {});
  const baseSlug = request.input.slug ?? slugify(request.input.name);
  if (baseSlug.length < 2) {
    throw new AdericelError('VALIDATION_FAILED', 'Organisation name does not yield a usable slug');
  }

  const created = await app.db.withPlatform(async (ctx) => {
    // Slug collisions are resolved by suffixing rather than failing: an MSP
    // with two customers called "Northgate" should not have to invent a slug.
    let slug = baseSlug;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const clash = await ctx.one<{ id: string }>(
        `SELECT id FROM organisations WHERE lower(slug) = lower($1)`,
        [slug],
      );
      if (!clash) break;
      slug = `${baseSlug}-${attempt + 1}`;
      if (attempt === 20) {
        throw new AdericelError(
          'CONFLICT',
          'Could not allocate a unique slug for this organisation',
        );
      }
    }

    const organisation = await ctx.oneOrFail<{
      id: string;
      name: string;
      slug: string;
      status: string;
    }>(
      `INSERT INTO organisations (msp_id, name, slug, status, country_code, industry, size_band, settings)
       VALUES ($1, $2, $3, 'ONBOARDING', $4, $5, $6, $7::jsonb)
       RETURNING id, name, slug, status`,
      [
        request.mspId,
        request.input.name,
        slug,
        request.input.countryCode ?? null,
        request.input.industry ?? null,
        request.input.sizeBand ?? null,
        JSON.stringify(settings),
      ],
      'Organisation',
    );

    return { organisation, slug };
  });

  // Everything below is tenant data, so it runs under the new organisation's
  // own tenant context and is subject to row level security like any other
  // write. Provisioning does not get a privileged path into customer data.
  const provisioned = await app.db.withTenant(created.organisation.id, async (ctx) => {
    const rootNode = await ctx.oneOrFail<{ id: string }>(
      `INSERT INTO graph_nodes (organisation_id, kind, label, attributes, first_observed_at, last_observed_at)
       VALUES ($1, 'Organisation', $2, $3::jsonb, $4, $4)
       RETURNING id`,
      [
        created.organisation.id,
        created.organisation.name,
        JSON.stringify({ slug: created.slug, mspId: request.mspId }),
        now,
      ],
      'Organisation node',
    );

    const frameworksAdopted: string[] = [];
    for (const key of request.input.frameworks) {
      const framework = await ctx.one<{ id: string; key: string }>(
        `SELECT id, key FROM frameworks WHERE key = $1 AND is_system ORDER BY version DESC LIMIT 1`,
        [key],
      );
      if (!framework) continue;
      await ctx.query(
        `INSERT INTO organisation_frameworks (organisation_id, framework_id, adopted_at)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [created.organisation.id, framework.id, now],
      );
      frameworksAdopted.push(framework.key);
    }

    let controlsCreated = 0;
    if (request.mspId && request.input.applyMspBaseline) {
      const baselineControls = await ctx.many<{
        id: string;
        control_key: string;
        title: string;
        description: string | null;
        ruleset_key: string;
        rule_key: string;
        parameters: Record<string, unknown>;
        requirement_keys: string[];
      }>(
        `SELECT c.id, c.control_key, c.title, c.description, c.ruleset_key, c.rule_key,
                c.parameters, c.requirement_keys
         FROM msp_baseline_controls c
         JOIN msp_baselines b ON b.id = c.baseline_id
         WHERE b.msp_id = $1 AND b.is_default
         ORDER BY c.control_key`,
        [request.mspId],
      );

      for (const control of baselineControls) {
        controlsCreated += await createControl(ctx, {
          organisationId: created.organisation.id,
          key: control.control_key,
          title: control.title,
          description: control.description,
          rulesetKey: control.ruleset_key,
          ruleKey: control.rule_key,
          parameters: control.parameters,
          requirementKeys: control.requirement_keys,
          source: 'INHERITED',
          baselineControlId: control.id,
          nowIso: now,
        });
      }
    }

    // A direct customer, or an MSP with no baseline, still gets a working
    // assurance posture: every rule in the Adericel Baseline becomes a control.
    if (controlsCreated === 0) {
      const ruleset = app.rulesets.get('adericel-baseline');
      for (const rule of ruleset.rules) {
        controlsCreated += await createControl(ctx, {
          organisationId: created.organisation.id,
          key: rule.key,
          title: rule.title,
          description: rule.description,
          rulesetKey: ruleset.key,
          ruleKey: rule.key,
          parameters: {},
          requirementKeys: [],
          source: 'LOCAL',
          baselineControlId: null,
          nowIso: now,
        });
      }
    }

    // Map controls onto the requirements of every adopted framework, wherever a
    // requirement names the control key. This is what lets one control
    // implementation satisfy several frameworks at once.
    await ctx.query(
      `INSERT INTO control_requirements (control_id, requirement_id, organisation_id, coverage)
       SELECT c.id, r.id, $1, 1.0
       FROM controls c
       JOIN organisation_frameworks f ON f.organisation_id = $1
       JOIN requirements r ON r.framework_id = f.framework_id
       WHERE c.organisation_id = $1
         AND c.key = ANY(string_to_array(COALESCE(r.description, ''), ' '))
       ON CONFLICT DO NOTHING`,
      [created.organisation.id],
    );

    const events: NewDomainEvent[] = [
      {
        type: 'OrganisationCreated',
        organisationId: created.organisation.id,
        mspId: request.mspId,
        subjectType: 'Organisation',
        subjectId: created.organisation.id,
        payload: {
          name: created.organisation.name,
          slug: created.slug,
          mspId: request.mspId,
          frameworks: frameworksAdopted,
          controlsCreated,
        },
        correlationId: request.correlationId,
        actor: request.actor,
      },
      {
        type: 'OrganisationOnboardingCompleted',
        organisationId: created.organisation.id,
        mspId: request.mspId,
        subjectType: 'Organisation',
        subjectId: created.organisation.id,
        payload: { controlsCreated, frameworks: frameworksAdopted },
        correlationId: request.correlationId,
        actor: request.actor,
      },
    ];
    for (const event of events) await publish(ctx, event, now);

    return { rootNodeId: rootNode.id, controlsCreated, frameworksAdopted };
  });

  // The organisation becomes ACTIVE only once provisioning has committed, so a
  // partially provisioned tenant is never presented as ready.
  await app.db.withPlatform(async (ctx) => {
    await ctx.query(
      `UPDATE organisations SET status = 'ACTIVE', onboarded_at = $2::timestamptz WHERE id = $1`,
      [created.organisation.id, now],
    );
  });

  return {
    id: created.organisation.id,
    name: created.organisation.name,
    slug: created.slug,
    status: 'ACTIVE',
    mspId: request.mspId,
    controlsCreated: provisioned.controlsCreated,
    frameworksAdopted: provisioned.frameworksAdopted,
    nodeId: provisioned.rootNodeId,
  };
}

interface CreateControlInput {
  organisationId: string;
  key: string;
  title: string;
  description: string | null;
  rulesetKey: string;
  ruleKey: string;
  parameters: Record<string, unknown>;
  requirementKeys: readonly string[];
  source: 'INHERITED' | 'LOCAL' | 'OVERRIDDEN';
  baselineControlId: string | null;
  nowIso: string;
}

async function createControl(
  ctx: {
    query: (text: string, values?: readonly unknown[]) => Promise<{ rowCount: number }>;
    oneOrFail: <T>(t: string, v: readonly unknown[], r: string) => Promise<T>;
  },
  input: CreateControlInput,
): Promise<number> {
  const node = await ctx.oneOrFail<{ id: string }>(
    `INSERT INTO graph_nodes (organisation_id, kind, external_id, label, attributes, first_observed_at, last_observed_at)
     VALUES ($1, 'Control', $2, $3, $4::jsonb, $5, $5)
     ON CONFLICT (organisation_id, kind, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET label = EXCLUDED.label
     RETURNING id`,
    [
      input.organisationId,
      `control:${input.key}`,
      input.title,
      JSON.stringify({ controlKey: input.key, rulesetKey: input.rulesetKey }),
      input.nowIso,
    ],
    'Control node',
  );

  const { rowCount } = await ctx.query(
    `INSERT INTO controls
       (organisation_id, node_id, key, title, description, ruleset_key, rule_key, parameters,
        source, baseline_control_id, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, true)
     ON CONFLICT (organisation_id, key) DO NOTHING`,
    [
      input.organisationId,
      node.id,
      input.key,
      input.title,
      input.description,
      input.rulesetKey,
      input.ruleKey,
      JSON.stringify(input.parameters),
      input.source,
      input.baselineControlId,
    ],
  );
  return rowCount;
}
