import {
  authoriseContainment,
  authoriseRecovery,
  effectiveLevel,
  impairmentsFor,
  leastDisruptiveLevel,
  mayReturnDirectlyToNormal,
  profileOf,
  stopsCollection,
  type ContainmentActor,
  type ContainmentLevel,
  type ContainmentScope,
  type ContainmentTrigger,
  type ResolutionKind,
} from '@adericel/containment';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';

/**
 * Applying and lifting containment.
 *
 * The decision logic is pure and lives in `@adericel/containment`. This layer
 * does the three things a decision cannot do for itself: establish whether the
 * actor genuinely governs the estate, write an append-only record of what was
 * decided, and move the denormalised level that the rest of the system reads.
 *
 * `actorGovernsTarget` is resolved here from grants, never taken from the
 * request. A caller asserting authority over an estate is a caller, not an
 * authority (§22).
 */

export interface ContainRequest {
  readonly scope: ContainmentScope;
  readonly organisationId: string | null;
  readonly integrationId: string | null;
  readonly level: ContainmentLevel;
  readonly trigger: ContainmentTrigger;
  readonly justification: string;
}

export interface ContainmentRecord {
  readonly id: string;
  readonly scope: ContainmentScope;
  readonly fromLevel: ContainmentLevel;
  readonly toLevel: ContainmentLevel;
  readonly trigger: ContainmentTrigger | null;
  readonly actorKind: ContainmentActor;
  readonly actorLabel: string;
  readonly justification: string;
  readonly reviewRequired: boolean;
  readonly occurredAt: string;
  /** Stated on every response: containment never withholds the record. */
  readonly evidenceRemainsReadable: true;
}

/**
 * Whether this principal governs the estate they are trying to contain.
 *
 * Read from grants. A platform principal governs everything; an MSP principal
 * governs organisations belonging to its own MSP and nothing else. Row-level
 * security enforces the same boundary underneath — this layer exists so the
 * refusal can explain itself during an incident, when a bare 404 is the least
 * helpful thing a system can say.
 */
async function resolveAuthority(
  app: AppContext,
  principal: { readonly isPlatform: boolean; readonly mspId: string | null },
  organisationId: string | null,
): Promise<{ actor: ContainmentActor; governs: boolean }> {
  if (principal.isPlatform) return { actor: 'VEYLITH', governs: true };
  if (!principal.mspId) return { actor: 'MSP', governs: false };
  if (organisationId === null) {
    // Platform scope. An MSP never governs the platform: containing it would
    // stop every other MSP's estate, which is not one partner's to decide.
    return { actor: 'MSP', governs: false };
  }

  const owned = await app.db.withPlatform(async (ctx) =>
    ctx.one<{ id: string }>(`SELECT id FROM organisations WHERE id = $1 AND msp_id = $2`, [
      organisationId,
      principal.mspId,
    ]),
  );
  return { actor: 'MSP', governs: owned !== null };
}

async function currentLevel(
  app: AppContext,
  scope: ContainmentScope,
  organisationId: string | null,
  integrationId: string | null,
): Promise<ContainmentLevel> {
  return app.db.withPlatform(async (ctx) => {
    if (scope === 'INTEGRATION' && integrationId) {
      const row = await ctx.one<{ containment_level: string }>(
        `SELECT containment_level FROM integrations WHERE id = $1`,
        [integrationId],
      );
      return (row?.containment_level ?? 'C0') as ContainmentLevel;
    }
    if (scope === 'ORGANISATION' && organisationId) {
      const row = await ctx.one<{ containment_level: string }>(
        `SELECT containment_level FROM organisations WHERE id = $1`,
        [organisationId],
      );
      return (row?.containment_level ?? 'C0') as ContainmentLevel;
    }
    // Platform scope is the strictest level currently held anywhere, so that
    // lifting one organisation cannot appear to lift the platform.
    const rows = await ctx.many<{ containment_level: string }>(
      `SELECT containment_level FROM organisations WHERE containment_level <> 'C0'`,
      [],
    );
    return effectiveLevel(rows.map((r) => r.containment_level as ContainmentLevel));
  });
}

export async function contain(
  app: AppContext,
  request: ContainRequest,
  principal: {
    readonly isPlatform: boolean;
    readonly mspId: string | null;
    readonly userId: string | null;
    readonly displayName: string;
  },
  correlationId: string,
): Promise<ContainmentRecord> {
  const { actor, governs } = await resolveAuthority(app, principal, request.organisationId);
  const from = await currentLevel(
    app,
    request.scope,
    request.organisationId,
    request.integrationId,
  );

  const decision = authoriseContainment({
    actor,
    level: request.level,
    scope: request.scope,
    trigger: request.trigger,
    actorGovernsTarget: governs,
    justification: request.justification,
  });

  if (!decision.permitted) throw new AdericelError('FORBIDDEN', decision.reason);

  // Containment raises. A request to a level at or below the current one is not
  // a containment, and silently treating it as one would let an operator
  // believe they had acted when nothing changed.
  if (request.level <= from) {
    throw new AdericelError(
      'PRECONDITION_FAILED',
      `This estate is already at ${from}. Containment raises the level; to reduce it, recover ` +
        'through the recovery path, which requires findings and re-observation.',
    );
  }

  const now = app.clock.nowIso();

  return app.db.withPlatform(async (ctx) => {
    const row = await ctx.oneOrFail<{ id: string; occurred_at: Date }>(
      `INSERT INTO containment_events
         (organisation_id, integration_id, scope, transition, from_level, to_level, trigger,
          actor_kind, actor_user_id, actor_label, justification, review_required,
          correlation_id, occurred_at)
       VALUES ($1,$2,$3,'CONTAIN',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz)
       RETURNING id, occurred_at`,
      [
        request.organisationId,
        request.integrationId,
        request.scope,
        from,
        request.level,
        request.trigger,
        actor,
        actor === 'AUTOMATIC' ? null : principal.userId,
        principal.displayName,
        request.justification,
        decision.requiresHumanReview,
        correlationId,
        now,
      ],
      'Containment',
    );

    if (request.scope === 'INTEGRATION' && request.integrationId) {
      await ctx.query(
        `UPDATE integrations SET containment_level = $2,
           contained_since = COALESCE(contained_since, $3::timestamptz)
         WHERE id = $1`,
        [request.integrationId, request.level, now],
      );
    } else if (request.scope === 'ORGANISATION' && request.organisationId) {
      await ctx.query(
        `UPDATE organisations SET containment_level = $2,
           contained_since = COALESCE(contained_since, $3::timestamptz)
         WHERE id = $1`,
        [request.organisationId, request.level, now],
      );
    } else {
      // Platform containment reaches every estate. Applied to each row so that
      // the level a reader sees on an organisation is the level that applies to
      // it, rather than something they must remember to combine with a global.
      await ctx.query(
        `UPDATE organisations SET containment_level = $1,
           contained_since = COALESCE(contained_since, $2::timestamptz)
         WHERE status <> 'CLOSED'`,
        [request.level, now],
      );
    }

    return {
      id: row.id,
      scope: request.scope,
      fromLevel: from,
      toLevel: request.level,
      trigger: request.trigger,
      actorKind: actor,
      actorLabel: principal.displayName,
      justification: request.justification,
      reviewRequired: decision.requiresHumanReview,
      occurredAt: row.occurred_at.toISOString(),
      evidenceRemainsReadable: true,
    };
  });
}

export interface RecoverRequest {
  readonly scope: ContainmentScope;
  readonly organisationId: string | null;
  readonly integrationId: string | null;
  readonly toLevel: ContainmentLevel;
  readonly resolution: ResolutionKind;
  readonly findings: string;
  readonly reObserved: boolean;
  readonly evidencePreserved: boolean;
  readonly riskAcceptedBy: string | null;
}

export async function recover(
  app: AppContext,
  request: RecoverRequest,
  principal: {
    readonly isPlatform: boolean;
    readonly mspId: string | null;
    readonly userId: string | null;
    readonly displayName: string;
  },
  correlationId: string,
): Promise<ContainmentRecord> {
  const { actor, governs } = await resolveAuthority(app, principal, request.organisationId);
  const from = await currentLevel(
    app,
    request.scope,
    request.organisationId,
    request.integrationId,
  );

  const decision = authoriseRecovery({
    actor,
    fromLevel: from,
    toLevel: request.toLevel,
    resolution: request.resolution,
    findings: request.findings,
    reObserved: request.reObserved,
    evidencePreserved: request.evidencePreserved,
    riskAcceptedBy: request.riskAcceptedBy,
    actorGovernsTarget: governs,
  });

  if (!decision.permitted) {
    throw new AdericelError(
      'PRECONDITION_FAILED',
      `${decision.reason} Outstanding: ${decision.missing.join('; ')}.`,
    );
  }

  // An estate that needed operations restricted comes back through C1, where
  // observation resumes and automation stays off, so somebody watches it run
  // before Adericel is trusted to act on it again.
  if (request.toLevel === 'C0' && !mayReturnDirectlyToNormal(from)) {
    throw new AdericelError(
      'PRECONDITION_FAILED',
      `Recovery from ${from} returns to C1 first, not straight to normal. Observation resumes ` +
        'and automation stays off, so the estate is watched running before Adericel is trusted ' +
        'to act on it again.',
    );
  }

  const now = app.clock.nowIso();

  return app.db.withPlatform(async (ctx) => {
    const row = await ctx.oneOrFail<{ id: string; occurred_at: Date }>(
      `INSERT INTO containment_events
         (organisation_id, integration_id, scope, transition, from_level, to_level,
          actor_kind, actor_user_id, actor_label, justification, resolution, findings,
          re_observed, evidence_preserved, risk_accepted_by, review_required,
          correlation_id, occurred_at)
       VALUES ($1,$2,$3,'RECOVER',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false,$15,$16::timestamptz)
       RETURNING id, occurred_at`,
      [
        request.organisationId,
        request.integrationId,
        request.scope,
        from,
        request.toLevel,
        actor,
        principal.userId,
        principal.displayName,
        `Recovery from ${from} to ${request.toLevel}: ${request.resolution}.`,
        request.resolution,
        request.findings,
        request.reObserved,
        request.evidencePreserved,
        request.riskAcceptedBy,
        correlationId,
        now,
      ],
      'Recovery',
    );

    const clearSince = request.toLevel === 'C0';
    if (request.scope === 'INTEGRATION' && request.integrationId) {
      await ctx.query(
        `UPDATE integrations SET containment_level = $2,
           contained_since = CASE WHEN $3 THEN NULL ELSE contained_since END
         WHERE id = $1`,
        [request.integrationId, request.toLevel, clearSince],
      );
    } else if (request.scope === 'ORGANISATION' && request.organisationId) {
      await ctx.query(
        `UPDATE organisations SET containment_level = $2,
           contained_since = CASE WHEN $3 THEN NULL ELSE contained_since END
         WHERE id = $1`,
        [request.organisationId, request.toLevel, clearSince],
      );
    } else {
      await ctx.query(
        `UPDATE organisations SET containment_level = $1,
           contained_since = CASE WHEN $2 THEN NULL ELSE contained_since END
         WHERE status <> 'CLOSED' AND containment_level > $1`,
        [request.toLevel, clearSince],
      );
    }

    return {
      id: row.id,
      scope: request.scope,
      fromLevel: from,
      toLevel: request.toLevel,
      trigger: null,
      actorKind: actor,
      actorLabel: principal.displayName,
      justification: request.findings,
      reviewRequired: false,
      occurredAt: row.occurred_at.toISOString(),
      evidenceRemainsReadable: true,
    };
  });
}

/**
 * Impairments for an organisation's contained integrations.
 *
 * Read by the assessment path so that a contained estate reports BLOCKED with
 * reason CONTAINED rather than letting its controls decay to UNKNOWN. Without
 * this the containment would be safe and dishonest: the portfolio would show a
 * customer who appears to have quietly stopped being monitored.
 */
export async function containmentImpairments(
  app: AppContext,
  organisationId: string,
): Promise<readonly { predicate: string; kind: 'BLOCKED'; reason: 'CONTAINED'; detail: string }[]> {
  const rows = await app.db.withPlatform(async (ctx) =>
    ctx.many<{
      containment_level: string;
      contained_since: Date | null;
      connector_key: string;
      org_level: string;
    }>(
      `SELECT i.containment_level, i.contained_since, i.connector_key,
              o.containment_level AS org_level
         FROM integrations i
         JOIN organisations o ON o.id = i.organisation_id
        WHERE i.organisation_id = $1`,
      [organisationId],
    ),
  );

  const out: { predicate: string; kind: 'BLOCKED'; reason: 'CONTAINED'; detail: string }[] = [];
  for (const row of rows) {
    const level = effectiveLevel([
      row.containment_level as ContainmentLevel,
      row.org_level as ContainmentLevel,
    ]);
    if (!stopsCollection(level)) continue;

    // Predicates are declared per collect capability, not on the manifest root:
    // one connector supplies several, and a contained connector takes all of
    // them with it.
    const connector = app.connectors.get(row.connector_key);
    const predicates = [
      ...new Set((connector?.manifest.collect ?? []).flatMap((c) => c.predicates)),
    ];
    out.push(
      ...impairmentsFor({
        level,
        predicates,
        since: row.contained_since?.toISOString() ?? 'an earlier date',
        reason: 'security containment',
      }),
    );
  }
  return out;
}

export { leastDisruptiveLevel, profileOf };
