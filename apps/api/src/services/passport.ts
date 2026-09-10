import { randomBytes } from 'node:crypto';
import { summarise, type AssuranceState } from '@adericel/domain';
import { publish, type TenantContext } from '@adericel/graph';
import { AdericelError, canonicalJson, contentHash } from '@adericel/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';

/**
 * The Assurance Passport.
 *
 * Everything Adericel does terminates here. The graph, the evidence, the
 * determinations and the verification history exist so an organisation can
 * answer, to somebody outside itself: what is true about our security, and why
 * should you believe us?
 *
 * Three properties distinguish this from the PDF a compliance tool emails you.
 *
 *   Issued, not rendered. Content is frozen and hashed at the moment of issue.
 *   A shared record whose content changes afterwards is not a record: issuer
 *   and recipient would be looking at different things while both believing
 *   they agreed. The live state is separately available; a passport is what was
 *   true at a stated instant and says so.
 *
 *   Honest about what it does not know. UNKNOWN, evidence age and the reason a
 *   control could not be determined appear with the same prominence as anything
 *   satisfied. A passport that could only say "compliant" would be the artefact
 *   this company exists to replace.
 *
 *   Verifiable. The content hash lets a recipient confirm that what they were
 *   shown is what Adericel holds, without an account and without trusting the
 *   party who sent it to them.
 */

export const PASSPORT_TOKEN_TTL_DAYS_MAX = 365;

export const passportShareSchema = z.object({
  audience: z.string().min(1).max(200),
  disclosure: z.enum(['REDACTED', 'FULL']).default('REDACTED'),
  expiresInDays: z.number().int().min(1).max(PASSPORT_TOKEN_TTL_DAYS_MAX).default(30),
});

export interface PassportControl {
  readonly key: string;
  readonly title: string;
  readonly state: AssuranceState;
  readonly unknownReason: string | null;
  /** Why Adericel concluded this, in the words a person can read. */
  readonly rationale: string | null;
  readonly lastAssessedAt: string | null;
  readonly evidenceCount: number;
  /** Age of the freshest evidence behind this control, in days. */
  readonly evidenceAgeDays: number | null;
}

export interface PassportContent {
  readonly schema: 'adericel.passport/v1';
  readonly organisation: { readonly name: string; readonly countryCode: string | null };
  readonly asOf: string;
  readonly state: AssuranceState;
  readonly summary: {
    readonly total: number;
    readonly satisfied: number;
    readonly failing: number;
    readonly unknown: number;
    readonly excepted: number;
    readonly notApplicable: number;
    /**
     * The proportion of in-scope controls Adericel can currently speak to.
     * Reported alongside every other figure because a high satisfaction rate
     * over a third of the estate is not a good result, and presenting the two
     * separately is how that gets misread.
     */
    readonly coverage: { readonly determined: number; readonly inScope: number };
  };
  readonly frameworks: readonly {
    readonly key: string;
    readonly name: string;
    readonly state: AssuranceState;
  }[];
  readonly controls: readonly PassportControl[];
  readonly findings: readonly {
    readonly severity: string;
    readonly title: string | null;
    readonly control: string;
    readonly ageDays: number;
    readonly status: string;
  }[];
  readonly exceptions: readonly {
    readonly control: string;
    readonly justification: string;
    readonly expiresAt: string;
  }[];
  readonly remediation: readonly {
    readonly actionType: string;
    readonly control: string | null;
    readonly executedAt: string;
    readonly verified: boolean;
    readonly verificationDetail: string | null;
  }[];
  readonly evidence: {
    readonly total: number;
    readonly stale: number;
    readonly freshestDays: number | null;
    readonly oldestDays: number | null;
  };
  readonly disclosure: 'REDACTED' | 'FULL';
  /**
   * Said in the passport itself, not in a footnote, because a recipient who
   * misreads UNKNOWN as satisfactory has been misled by the document.
   */
  readonly interpretation: string;
}

export interface IssuedPassport {
  readonly id: string;
  readonly sequence: number;
  readonly contentHash: string;
  readonly state: AssuranceState;
  readonly asOf: string;
  readonly issuedAt: string;
  readonly content: PassportContent;
}

function daysBetween(fromIso: string | Date | null, toEpochMs: number): number | null {
  if (fromIso === null) return null;
  const from = fromIso instanceof Date ? fromIso.getTime() : Date.parse(fromIso);
  if (!Number.isFinite(from)) return null;
  return Math.max(0, Math.floor((toEpochMs - from) / 86_400_000));
}

/**
 * Assemble the passport from the tenant's own data.
 *
 * Reads only what the organisation owns, under its own tenant context, so a
 * passport is subject to the same isolation as everything else.
 */
export async function buildPassportContent(
  ctx: TenantContext,
  options: {
    readonly organisationId: string;
    readonly asOfIso: string;
    readonly nowEpochMs: number;
    readonly disclosure: 'REDACTED' | 'FULL';
  },
): Promise<PassportContent> {
  const organisation = await ctx.oneOrFail<{ name: string; country_code: string | null }>(
    `SELECT name, country_code FROM organisations WHERE id = $1`,
    [options.organisationId],
    'Organisation',
  );

  // Driven from `controls`, so a control that has never been assessed appears
  // as UNKNOWN rather than being silently absent. A passport listing only the
  // controls that happen to have a state row would flatter the organisation by
  // omission, which is the quietest way to lie.
  const controls = await ctx.many<{
    key: string;
    title: string;
    state: string | null;
    unknown_reason: string | null;
    rationale: string | null;
    last_assessed_at: Date | null;
    evidence_count: string;
    freshest: Date | null;
  }>(
    `SELECT c.key, c.title,
            a.state, a.unknown_reason,
            latest.rationale,
            a.last_assessed_at,
            COALESCE(array_length(latest.evidence_ids, 1), 0)::text AS evidence_count,
            (SELECT max(e.collected_at) FROM evidence e
              WHERE e.organisation_id = c.organisation_id
                AND e.id = ANY(COALESCE(latest.evidence_ids, ARRAY[]::uuid[]))) AS freshest
     FROM controls c
     LEFT JOIN assurance_states a
       ON a.organisation_id = c.organisation_id AND a.subject_kind = 'CONTROL'
      AND a.subject_id = c.id
     LEFT JOIN assessments latest ON latest.id = a.assessment_id
     WHERE c.organisation_id = $1 AND c.enabled
     ORDER BY c.key`,
    [options.organisationId],
  );

  const passportControls: PassportControl[] = controls.map((row) => ({
    key: row.key,
    title: row.title,
    state: (row.state ?? 'UNKNOWN') as AssuranceState,
    unknownReason: row.state === null ? 'NO_EVIDENCE' : row.unknown_reason,
    rationale:
      row.state === null
        ? 'This control has not been assessed. Adericel has observed nothing that bears on it.'
        : row.rationale,
    lastAssessedAt: row.last_assessed_at?.toISOString() ?? null,
    evidenceCount: Number(row.evidence_count),
    evidenceAgeDays: daysBetween(row.freshest, options.nowEpochMs),
  }));

  const states = passportControls.map((c) => c.state);
  const summary = summarise(states);

  const frameworks = await ctx.many<{ key: string; name: string; state: string | null }>(
    `SELECT f.key, f.name, a.state
     FROM organisation_frameworks orgf
     JOIN frameworks f ON f.id = orgf.framework_id
     LEFT JOIN assurance_states a
       ON a.organisation_id = orgf.organisation_id AND a.subject_kind = 'FRAMEWORK'
      AND a.subject_id = orgf.framework_id
     WHERE orgf.organisation_id = $1
     ORDER BY f.key`,
    [options.organisationId],
  );

  const findingRows = await ctx.many<{
    severity: string;
    title: string;
    control_key: string;
    first_detected_at: Date;
    status: string;
  }>(
    `SELECT fi.severity, fi.title, c.key AS control_key, fi.first_detected_at, fi.status
     FROM findings fi
     JOIN controls c ON c.id = fi.control_id
     WHERE fi.organisation_id = $1 AND fi.status IN ('OPEN', 'ACKNOWLEDGED', 'IN_REMEDIATION')
     ORDER BY fi.first_detected_at`,
    [options.organisationId],
  );

  const exceptions = await ctx.many<{
    control_key: string;
    justification: string;
    expires_at: Date;
  }>(
    `SELECT c.key AS control_key, e.justification, e.expires_at
     FROM exceptions e JOIN controls c ON c.id = e.control_id
     WHERE e.organisation_id = $1 AND e.status = 'APPROVED' AND e.revoked_at IS NULL
       AND e.expires_at > $2::timestamptz
     ORDER BY e.expires_at`,
    [options.organisationId, options.asOfIso],
  );

  // Remediation history is the part a competitor's report cannot produce: not
  // "we raised a ticket" but "we changed it, then looked again and confirmed".
  const remediation = await ctx.many<{
    action_type: string;
    control_key: string | null;
    executed_at: Date;
    state: string;
    detail: string | null;
  }>(
    `SELECT a.action_type, c.key AS control_key, a.executed_at, a.state,
            v.detail
     FROM actions a
     LEFT JOIN findings fi ON fi.id = a.finding_id
     LEFT JOIN controls c ON c.id = fi.control_id
     LEFT JOIN verifications v ON v.id = a.verification_id
     WHERE a.organisation_id = $1 AND a.executed_at IS NOT NULL
     ORDER BY a.executed_at DESC
     LIMIT 100`,
    [options.organisationId],
  );

  const evidence = await ctx.oneOrFail<{
    total: string;
    stale: string;
    freshest: Date | null;
    oldest: Date | null;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE status <> 'ACTIVE'
                             OR (valid_until IS NOT NULL AND valid_until < $2::timestamptz))::text
              AS stale,
            max(collected_at) AS freshest,
            min(collected_at) AS oldest
     FROM evidence WHERE organisation_id = $1`,
    [options.organisationId, options.asOfIso],
    'Evidence summary',
  );

  const unknown = summary.counts.UNKNOWN ?? 0;
  const determined = summary.inScope - unknown;

  return {
    schema: 'adericel.passport/v1',
    organisation: { name: organisation.name, countryCode: organisation.country_code },
    asOf: options.asOfIso,
    state: summary.state,
    summary: {
      total: passportControls.length,
      satisfied: summary.counts.SATISFIED ?? 0,
      failing: summary.counts.NOT_SATISFIED ?? 0,
      unknown,
      excepted: summary.counts.EXCEPTED ?? 0,
      notApplicable: summary.counts.NOT_APPLICABLE ?? 0,
      coverage: { determined, inScope: summary.inScope },
    },
    frameworks: frameworks.map((f) => ({
      key: f.key,
      name: f.name,
      state: (f.state ?? 'UNKNOWN') as AssuranceState,
    })),
    controls: passportControls,
    findings: findingRows.map((f) => ({
      severity: f.severity,
      // Finding titles name the affected subject — an account, a device. A
      // party the organisation is proving itself to gets the shape of the
      // problem, not a map of where to attack.
      title: options.disclosure === 'FULL' ? f.title : null,
      control: f.control_key,
      ageDays: daysBetween(f.first_detected_at, options.nowEpochMs) ?? 0,
      status: f.status,
    })),
    exceptions: exceptions.map((e) => ({
      control: e.control_key,
      justification: e.justification,
      expiresAt: e.expires_at.toISOString(),
    })),
    remediation: remediation.map((r) => ({
      actionType: r.action_type,
      control: r.control_key,
      executedAt: r.executed_at.toISOString(),
      // CONFIRMED is the only state that means the fix was re-observed. An
      // executed action is not a remediated finding, and a passport that
      // conflated them would be claiming work it had not proven.
      verified: r.state === 'CONFIRMED',
      verificationDetail: options.disclosure === 'FULL' ? r.detail : null,
    })),
    evidence: {
      total: Number(evidence.total),
      stale: Number(evidence.stale),
      freshestDays: daysBetween(evidence.freshest, options.nowEpochMs),
      oldestDays: daysBetween(evidence.oldest, options.nowEpochMs),
    },
    disclosure: options.disclosure,
    interpretation: buildInterpretation(summary.state, unknown, summary.inScope, determined),
  };
}

/**
 * How to read this passport, stated inside it.
 *
 * A recipient who takes UNKNOWN for satisfactory has been misled by the
 * document, whatever the numbers technically said. So the document says what it
 * means, in the place they are looking.
 */
function buildInterpretation(
  state: AssuranceState,
  unknown: number,
  inScope: number,
  determined: number,
): string {
  const coverage =
    inScope === 0
      ? 'No controls are in scope.'
      : `Adericel can currently speak to ${determined} of ${inScope} in-scope controls.`;

  if (unknown > 0) {
    return (
      `${coverage} ${unknown} control(s) are UNKNOWN: Adericel does not hold evidence sufficient ` +
      'to determine them, and has therefore said so rather than assuming they are satisfied. ' +
      'UNKNOWN is not a pass. Treat an UNKNOWN control as undetermined, and ask what evidence ' +
      'would settle it.'
    );
  }
  if (state === 'SATISFIED') {
    return (
      `${coverage} Every in-scope control is satisfied on the evidence held at the stated ` +
      'instant. This describes that instant, not the present: check the evidence ages, and ' +
      'ask for a current passport if the dates matter to your decision.'
    );
  }
  return (
    `${coverage} At least one in-scope control is not satisfied. The failing controls are ` +
    'named above with the reason Adericel reached that conclusion.'
  );
}

export async function issuePassport(
  app: AppContext,
  options: {
    readonly organisationId: string;
    readonly issuedBy: string;
    readonly correlationId: string;
    readonly disclosure?: 'REDACTED' | 'FULL';
  },
): Promise<IssuedPassport> {
  const asOfIso = app.clock.nowIso();

  return app.db.withTenant(options.organisationId, async (ctx) => {
    const content = await buildPassportContent(ctx, {
      organisationId: options.organisationId,
      asOfIso,
      nowEpochMs: app.clock.nowEpochMs(),
      disclosure: options.disclosure ?? 'FULL',
    });

    // Hashed over the canonical encoding, so two passports with identical
    // content agree on their hash regardless of key order.
    const hash = contentHash(content);

    const next = await ctx.oneOrFail<{ seq: number }>(
      `SELECT COALESCE(max(sequence), 0) + 1 AS seq FROM assurance_passports
       WHERE organisation_id = $1`,
      [options.organisationId],
      'Passport sequence',
    );

    const row = await ctx.oneOrFail<{ id: string; issued_at: Date }>(
      `INSERT INTO assurance_passports
         (organisation_id, sequence, content, content_hash, state, controls_total,
          controls_unknown, controls_satisfied, controls_failing, open_findings, as_of,
          issued_by, correlation_id)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, issued_at`,
      [
        options.organisationId,
        next.seq,
        canonicalJson(content),
        hash,
        content.state,
        content.summary.total,
        content.summary.unknown,
        content.summary.satisfied,
        content.summary.failing,
        content.findings.length,
        asOfIso,
        options.issuedBy,
        options.correlationId,
      ],
      'Passport',
    );

    await publish(
      ctx,
      {
        type: 'ReportGenerated',
        organisationId: options.organisationId,
        subjectType: 'Report',
        subjectId: row.id,
        payload: {
          kind: 'assurance-passport',
          sequence: next.seq,
          state: content.state,
          contentHash: hash,
          unknownControls: content.summary.unknown,
        },
        correlationId: options.correlationId,
        actor: options.issuedBy,
      },
      asOfIso,
    );

    return {
      id: row.id,
      sequence: next.seq,
      contentHash: hash,
      state: content.state,
      asOf: asOfIso,
      issuedAt: row.issued_at.toISOString(),
      content,
    };
  });
}

/** Redact a stored passport down to what a REDACTED share may disclose. */
export function redactPassport(content: PassportContent): PassportContent {
  return {
    ...content,
    findings: content.findings.map((f) => ({ ...f, title: null })),
    remediation: content.remediation.map((r) => ({ ...r, verificationDetail: null })),
    disclosure: 'REDACTED',
  };
}

export function mintShareToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface ResolvedShare {
  readonly organisationName: string;
  readonly passport: PassportContent;
  readonly contentHash: string;
  readonly sequence: number;
  readonly issuedAt: string;
  readonly withdrawn: { readonly at: string; readonly reason: string | null } | null;
}

/**
 * Resolve a shared passport for an unauthenticated recipient.
 *
 * The token is the whole control: an insurer or a procurement team will not
 * hold an Adericel account, so there is nothing else to check. Expiry,
 * revocation and withdrawal are therefore all enforced here, and a withdrawn
 * passport is still returned — marked as withdrawn — because a recipient
 * relying on an old record must be told it was withdrawn rather than told it
 * never existed.
 */
export async function resolveShare(
  app: AppContext,
  token: string,
  view: { readonly ip: string | null; readonly userAgent: string | null },
): Promise<ResolvedShare> {
  const tokenHash = app.tokens.hash('invitation', `passport-share:${token}`);

  const found = await app.db.withPlatform(async (ctx) =>
    ctx.one<{
      share_id: string;
      organisation_id: string;
      disclosure: 'REDACTED' | 'FULL';
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id AS share_id, organisation_id, disclosure, expires_at, revoked_at
       FROM passport_shares WHERE token_hash = $1`,
      [tokenHash],
    ),
  );

  // One message for unknown, revoked and expired. A recipient who should not
  // have the link learns nothing from which of those it is.
  const invalid = (): never => {
    throw new AdericelError(
      'NOT_FOUND',
      'This assurance record is not available. The link may have expired or been withdrawn by ' +
        'the organisation that issued it.',
    );
  };
  if (!found) invalid();
  if (found!.revoked_at !== null) invalid();
  if (found!.expires_at.getTime() <= app.clock.nowEpochMs()) invalid();

  return app.db.withTenant(found!.organisation_id, async (ctx) => {
    const passport = await ctx.oneOrFail<{
      content: PassportContent;
      content_hash: string;
      sequence: number;
      issued_at: Date;
      withdrawn_at: Date | null;
      withdrawn_reason: string | null;
    }>(
      `SELECT p.content, p.content_hash, p.sequence, p.issued_at, p.withdrawn_at,
              p.withdrawn_reason
       FROM assurance_passports p
       JOIN passport_shares s ON s.passport_id = p.id
       WHERE s.id = $1`,
      [found!.share_id],
      'Passport',
    );

    const organisation = await ctx.oneOrFail<{ name: string }>(
      `SELECT name FROM organisations WHERE id = $1`,
      [found!.organisation_id],
      'Organisation',
    );

    await ctx.query(
      `UPDATE passport_shares
       SET view_count = view_count + 1, last_viewed_at = $2::timestamptz
       WHERE id = $1`,
      [found!.share_id, app.clock.nowIso()],
    );
    await ctx.query(
      `INSERT INTO passport_share_views (organisation_id, share_id, source_ip, user_agent)
       VALUES ($1, $2, $3::inet, $4)`,
      [found!.organisation_id, found!.share_id, view.ip, view.userAgent?.slice(0, 500) ?? null],
    );

    return {
      organisationName: organisation.name,
      passport: found!.disclosure === 'FULL' ? passport.content : redactPassport(passport.content),
      // The hash is over the stored content as issued, which is what makes it
      // verifiable. Redaction changes what the recipient sees, so the hash is
      // reported alongside a statement of the disclosure level rather than
      // silently recomputed over the redacted view.
      contentHash: passport.content_hash,
      sequence: passport.sequence,
      issuedAt: passport.issued_at.toISOString(),
      withdrawn:
        passport.withdrawn_at === null
          ? null
          : {
              at: passport.withdrawn_at.toISOString(),
              reason: passport.withdrawn_reason,
            },
    };
  });
}
