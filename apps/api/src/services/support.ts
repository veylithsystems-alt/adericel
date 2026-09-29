import {
  buildDiagnosticBundle,
  mayAssign,
  mayDisclose,
  routeCase,
  transitionCase,
  type DiagnosticSection,
  type DisclosureKind,
  type IdentificationMethod,
  type RequesterKind,
  type SupportCaseState,
  type SupportCategory,
  type SupportQueue,
  type SupportSeverity,
} from '@adericel/support';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';

/**
 * Support cases: opening them, moving them, and deciding what may be said.
 *
 * All of the judgement lives in `@adericel/support` and is pure. This layer
 * does what a pure decision cannot: resolve who the requester actually is from
 * grants rather than from what they typed, load the direct-support entitlement
 * from its signed record, write the append-only history, and — the part that
 * matters most — record every disclosure decision including the refusals.
 *
 * A support surface that logs only successful disclosures cannot answer "did
 * anyone try", which is the first question asked after an incident.
 */

export interface OpenCaseRequest {
  readonly organisationId: string | null;
  readonly category: SupportCategory;
  readonly severity: SupportSeverity;
  readonly subject: string;
  readonly description: string;
  readonly raisedBySignal?: string | null;
}

export interface SupportPrincipal {
  readonly requesterKind: RequesterKind;
  readonly userId: string | null;
  readonly label: string;
  readonly mspId: string | null;
  /** How this requester was identified, if at all. Never self-asserted. */
  readonly identifiedBy: IdentificationMethod;
  readonly identifiedAtIso: string | null;
}

export interface SupportCaseRecord {
  readonly id: string;
  readonly reference: string;
  readonly organisationId: string | null;
  readonly category: SupportCategory;
  readonly severity: SupportSeverity;
  readonly queue: SupportQueue;
  readonly routingReason: string;
  readonly state: SupportCaseState;
  readonly subject: string;
  readonly openedAt: string;
}

/**
 * Whether a signed agreement lets Veylith support this organisation directly.
 *
 * Loaded from `direct_support_entitlements`, never from the request. The table
 * is empty by design (ADR-0048, decision D2): the gate exists because §22
 * requires it regardless, and shipping it closed means an MSP sees a system
 * that structurally cannot talk to their customer behind their back.
 */
export async function directSupportEntitled(
  app: AppContext,
  organisationId: string | null,
): Promise<boolean> {
  if (!organisationId) return false;
  const now = app.clock.nowIso();
  const row = await app.db.withPlatform(async (ctx) =>
    ctx.one<{ id: string }>(
      `SELECT id FROM direct_support_entitlements
        WHERE organisation_id = $1
          AND revoked_at IS NULL
          AND effective_from <= $2::timestamptz
          AND (effective_until IS NULL OR effective_until > $2::timestamptz)`,
      [organisationId, now],
    ),
  );
  return row !== null;
}

export async function openCase(
  app: AppContext,
  request: OpenCaseRequest,
  principal: SupportPrincipal,
  correlationId: string,
): Promise<SupportCaseRecord> {
  const entitled = await directSupportEntitled(app, request.organisationId);

  const routing = routeCase({
    requesterKind: principal.requesterKind,
    category: request.category,
    severity: request.severity,
    directSupportEntitled: entitled,
  });

  const mspId = request.organisationId
    ? await app.db.withPlatform(async (ctx) => {
        const row = await ctx.one<{ msp_id: string | null }>(
          `SELECT msp_id FROM organisations WHERE id = $1`,
          [request.organisationId],
        );
        if (!row) throw new AdericelError('NOT_FOUND', 'No such organisation');
        return row.msp_id;
      })
    : principal.mspId;

  const now = app.clock.nowIso();
  /**
   * The case opens in RECEIVED even when the requester is already signed in.
   *
   * It is tempting to skip straight to TRIAGING for an authenticated caller,
   * and wrong: the transition through IDENTITY_PENDING and ENTITLEMENT_PENDING
   * is what writes the record of how they were identified. A case that arrives
   * already triaged has no such record, and the one time it matters is the one
   * time nobody can produce it.
   */
  const row = await app.db.withPlatform(async (ctx) =>
    ctx.oneOrFail<{ id: string; reference: string; opened_at: Date }>(
      `INSERT INTO support_cases
         (reference, organisation_id, msp_id, requester_kind, requester_user_id, requester_label,
          category, severity, queue, routing_reason, state, subject, description,
          identified_by, identified_at, direct_support_entitled, opened_at, raised_by_signal,
          correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'RECEIVED',$11,$12,$13,$14::timestamptz,$15,
               $16::timestamptz,$17,$18)
       RETURNING id, reference, opened_at`,
      [
        await nextReference(app),
        request.organisationId,
        mspId,
        principal.requesterKind,
        principal.requesterKind === 'SYSTEM' ? null : principal.userId,
        principal.label,
        request.category,
        request.severity,
        routing.queue,
        routing.because,
        request.subject,
        request.description,
        principal.identifiedBy === 'NONE' ? null : principal.identifiedBy,
        principal.identifiedBy === 'NONE' ? null : principal.identifiedAtIso,
        entitled,
        now,
        request.raisedBySignal ?? null,
        correlationId,
      ],
      'Support case',
    ),
  );

  return {
    id: row.id,
    reference: row.reference,
    organisationId: request.organisationId,
    category: request.category,
    severity: request.severity,
    queue: routing.queue,
    routingReason: routing.because,
    state: 'RECEIVED',
    subject: request.subject,
    openedAt: row.opened_at.toISOString(),
  };
}

async function nextReference(app: AppContext): Promise<string> {
  // Sequential within a day, so a reference read aloud on a call is short. It
  // carries no tenant identifier: a reference is quoted in email and should not
  // tell a recipient which organisation it concerns.
  const day = app.clock.nowIso().slice(0, 10).replace(/-/g, '');
  const count = await app.db.withPlatform(async (ctx) =>
    ctx.oneOrFail<{ n: string }>(
      `SELECT count(*)::text AS n FROM support_cases WHERE reference LIKE $1`,
      [`ADC-${day}-%`],
      'Reference count',
    ),
  );
  return `ADC-${day}-${String(Number(count.n) + 1).padStart(4, '0')}`;
}

export interface MoveCaseRequest {
  readonly caseId: string;
  readonly to: SupportCaseState;
  readonly reason: string;
  readonly customerVerified?: boolean;
  readonly queue?: SupportQueue;
}

export async function moveCase(
  app: AppContext,
  request: MoveCaseRequest,
  actor: { readonly userId: string | null; readonly label: string },
  correlationId: string,
): Promise<{ readonly from: SupportCaseState; readonly to: SupportCaseState }> {
  const existing = await app.db.withPlatform(async (ctx) =>
    ctx.one<{
      id: string;
      state: string;
      severity: string;
      organisation_id: string | null;
      requester_kind: string;
      category: string;
      direct_support_entitled: boolean;
    }>(
      `SELECT id, state, severity, organisation_id, requester_kind, category,
              direct_support_entitled
         FROM support_cases WHERE id = $1`,
      [request.caseId],
    ),
  );
  if (!existing) throw new AdericelError('NOT_FOUND', 'No such case');

  const from = existing.state as SupportCaseState;
  const decision = transitionCase({
    from,
    to: request.to,
    reason: request.reason,
    severity: existing.severity as SupportSeverity,
    ...(request.customerVerified === undefined
      ? {}
      : { customerVerified: request.customerVerified }),
  });
  if (!decision.permitted) throw new AdericelError('PRECONDITION_FAILED', decision.reason);

  // Reassignment is the path the distribution boundary is usually crossed by:
  // somebody triaging a backlog drags a case into a Veylith queue because that
  // is where the expertise is, and the MSP finds out their supplier has been
  // talking to their customer.
  if (request.queue) {
    const allowed = mayAssign(request.queue, {
      requesterKind: existing.requester_kind as RequesterKind,
      directSupportEntitled: existing.direct_support_entitled,
      category: existing.category as SupportCategory,
    });
    if (!allowed.permitted) throw new AdericelError('FORBIDDEN', allowed.reason);
  }

  const now = app.clock.nowIso();
  await app.db.withPlatform(async (ctx) => {
    const updated = await ctx.one<{ id: string }>(
      `UPDATE support_cases
          SET state = $2,
              queue = COALESCE($3, queue),
              customer_verified = COALESCE($4, customer_verified),
              acknowledged_at = COALESCE(acknowledged_at,
                CASE WHEN $2 <> 'RECEIVED' THEN $5::timestamptz END),
              resolved_at = CASE WHEN $2 = 'RESOLVED' THEN $5::timestamptz ELSE resolved_at END,
              closed_at = CASE WHEN $2 IN ('CLOSED','WITHDRAWN','REJECTED')
                               THEN $5::timestamptz ELSE closed_at END
        WHERE id = $1 AND state = $6
        RETURNING id`,
      [
        request.caseId,
        request.to,
        request.queue ?? null,
        request.customerVerified ?? null,
        now,
        from,
      ],
    );
    if (!updated) {
      throw new AdericelError(
        'CONFLICT',
        'The case moved while this was being decided. Read it again and decide from where it ' +
          'actually is.',
      );
    }

    await ctx.query(
      `INSERT INTO support_case_transitions
         (case_id, organisation_id, from_state, to_state, reason, actor_kind, actor_user_id,
          actor_label, occurred_at, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10)`,
      [
        request.caseId,
        existing.organisation_id,
        from,
        request.to,
        request.reason,
        actor.userId ? 'USER' : 'SYSTEM',
        actor.userId,
        actor.label,
        now,
        correlationId,
      ],
    );
  });

  return { from, to: request.to };
}

/**
 * Decide whether something may be said, and record the decision either way.
 *
 * The recording is not incidental. An entitlement gate whose refusals leave no
 * trace cannot distinguish "nobody asked" from "somebody asked eleven times",
 * and those are very different facts about an afternoon.
 */
export async function decideDisclosure(
  app: AppContext,
  input: {
    readonly caseId: string;
    readonly kind: DisclosureKind;
    readonly requester: SupportPrincipal;
    readonly concernsRequestersOwnOrganisation: boolean;
    readonly requesterMspRunsOrganisation: boolean;
  },
  by: { readonly userId: string | null; readonly label: string },
  correlationId: string,
): Promise<{ readonly permitted: boolean; readonly reason: string; readonly remedy: string }> {
  const existing = await app.db.withPlatform(async (ctx) =>
    ctx.one<{ state: string; organisation_id: string | null; direct_support_entitled: boolean }>(
      `SELECT state, organisation_id, direct_support_entitled FROM support_cases WHERE id = $1`,
      [input.caseId],
    ),
  );
  if (!existing) throw new AdericelError('NOT_FOUND', 'No such case');

  const decision = mayDisclose({
    kind: input.kind,
    caseState: existing.state as SupportCaseState,
    requesterKind: input.requester.requesterKind,
    identifiedBy: input.requester.identifiedBy,
    identifiedAtIso: input.requester.identifiedAtIso,
    atIso: app.clock.nowIso(),
    concernsRequestersOwnOrganisation: input.concernsRequestersOwnOrganisation,
    requesterMspRunsOrganisation: input.requesterMspRunsOrganisation,
    directSupportEntitled: existing.direct_support_entitled,
  });

  const permitted = decision.permitted;
  const reason = permitted ? 'Entitled' : decision.reason;
  const remedy = permitted ? '' : decision.remedy;

  await app.db.withPlatform(async (ctx) => {
    await ctx.query(
      `INSERT INTO support_disclosures
         (case_id, organisation_id, kind, permitted, decision_reason, to_requester_kind,
          to_user_id, identified_by, identified_at, disclosed_by, disclosed_by_label,
          occurred_at, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12::timestamptz,$13)`,
      [
        input.caseId,
        existing.organisation_id,
        input.kind,
        permitted,
        permitted ? reason : `${reason} Remedy: ${remedy}`,
        input.requester.requesterKind,
        input.requester.userId,
        input.requester.identifiedBy === 'NONE' ? null : input.requester.identifiedBy,
        input.requester.identifiedBy === 'NONE' ? null : input.requester.identifiedAtIso,
        by.userId,
        by.label,
        app.clock.nowIso(),
        correlationId,
      ],
    );
  });

  return { permitted, reason, remedy };
}

/**
 * Produce a diagnostic bundle for one organisation.
 *
 * The bundle is returned, not stored. Keeping every bundle would make one table
 * the largest concentration of estate detail in the platform, for the
 * convenience of not asking for it again. What is stored is that one was
 * produced, for which tenant, and its hash.
 */
export async function produceDiagnosticBundle(
  app: AppContext,
  input: {
    readonly caseId: string;
    readonly organisationId: string;
    readonly sections: readonly DiagnosticSection[];
  },
  by: { readonly userId: string | null; readonly label: string },
  correlationId: string,
): Promise<ReturnType<typeof buildDiagnosticBundle>> {
  const owning = await app.db.withPlatform(async (ctx) =>
    ctx.one<{ organisation_id: string | null }>(
      `SELECT organisation_id FROM support_cases WHERE id = $1`,
      [input.caseId],
    ),
  );
  if (!owning) throw new AdericelError('NOT_FOUND', 'No such case');
  if (owning.organisation_id !== input.organisationId) {
    // A bundle spanning two tenants is not a convenience. It is a cross-tenant
    // disclosure with a filename.
    throw new AdericelError(
      'FORBIDDEN',
      'A diagnostic bundle concerns the organisation its case concerns, and no other.',
    );
  }

  const content = await collectSections(app, input.organisationId, input.sections);
  const bundle = buildDiagnosticBundle({
    organisationId: input.organisationId,
    caseId: input.caseId,
    requestedBy: by.label,
    requestedAtIso: app.clock.nowIso(),
    sections: input.sections,
    content,
  });

  await app.db.withPlatform(async (ctx) => {
    await ctx.query(
      `INSERT INTO support_diagnostic_bundles
         (case_id, organisation_id, sections, content_hash, requested_by, requested_by_label,
          requested_at, correlation_id)
       VALUES ($1,$2,$3::text[],$4,$5,$6,$7::timestamptz,$8)`,
      [
        input.caseId,
        input.organisationId,
        [...input.sections],
        bundle.contentHash,
        by.userId,
        by.label,
        bundle.requestedAtIso,
        correlationId,
      ],
    );
  });

  return bundle;
}

/**
 * Gather each section as shaped data.
 *
 * Shaped, never rows. The denylist in `buildDiagnosticBundle` is the second
 * line of defence; this is the first, and the reason every query below selects
 * named columns rather than `*`. A `SELECT *` here would put whatever a future
 * migration adds into a file that leaves the building.
 */
async function collectSections(
  app: AppContext,
  organisationId: string,
  sections: readonly DiagnosticSection[],
): Promise<Record<string, unknown>> {
  const content: Record<string, unknown> = {};

  for (const section of sections) {
    switch (section) {
      case 'INTEGRATION_HEALTH':
        content[section] = await app.db.withTenant(organisationId, async (ctx) =>
          ctx.many<Record<string, unknown>>(
            /**
             * Named columns, and `last_error` deliberately not among them.
             *
             * A provider's error text routinely echoes the request that
             * failed, which is how a token ends up in a field called
             * "message". The denylist in `buildDiagnosticBundle` would not
             * catch it — the key is innocent, the value is not — so it is
             * excluded here, where the shape is decided.
             */
            `SELECT connector_key, status, health, fidelity, last_run_at, last_success_at,
                    consecutive_failures
               FROM integrations WHERE organisation_id = $1 ORDER BY connector_key`,
            [organisationId],
          ),
        );
        break;
      case 'IMPAIRMENT_STATE':
        content[section] = await app.db.withTenant(organisationId, async (ctx) =>
          ctx.many<Record<string, unknown>>(
            `SELECT connector_key, containment_level, contained_since
               FROM integrations WHERE organisation_id = $1 ORDER BY connector_key`,
            [organisationId],
          ),
        );
        break;
      case 'PLATFORM_VERSIONS':
        /**
         * From the running process, not from the migration ledger.
         *
         * Reading `public.schema_migrations` here was refused by row-level
         * security, and correctly: the ledger belongs to the migration runner,
         * not to the application, and an application role that could read it
         * is a role that is one grant away from writing it. What an engineer
         * actually needs is which build and which rulesets produced the
         * assessment they are looking at, and the process knows that already.
         */
        content[section] = {
          release: app.config.releaseVersion,
          rulesets: app.rulesets.list().map((ruleset) => ({
            key: ruleset.key,
            version: ruleset.version,
            hash: ruleset.hash,
          })),
        };
        break;
      default:
        /**
         * Declared, and not yet collected.
         *
         * An empty section is honest: the bundle says it asked for an
         * assessment trace and got nothing, rather than omitting the key and
         * letting a reader assume there was nothing to find. The collectors
         * are tracked as RR-065.
         */
        content[section] = [];
    }
  }

  return content;
}
