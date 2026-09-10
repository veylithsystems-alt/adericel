import type { PlatformContext } from '@adericel/graph';
import type { Clock, Logger } from '@adericel/shared';
import { z } from 'zod';
import type { Operator } from './operate.js';

/**
 * The commercial pipeline.
 *
 * Every state change goes through the operator gate, so nothing here decides
 * its own authority. That is why the service takes an `Operator` rather than
 * constructing one: a pipeline that could build its own gate could build a
 * permissive one.
 */

/**
 * Qualification.
 *
 * Weighted, deterministic and pure, so a score can be explained to the person
 * whose deal it just deprioritised. The weights come from the commercial
 * specification and are here rather than in a database because changing how the
 * company decides who to sell to is a decision, not configuration.
 */
export interface ProspectSignals {
  readonly managedOrganisations: number | null;
  readonly microsoftHeavy: boolean | null;
  readonly complianceWorkload: boolean | null;
  readonly apiCapable: boolean | null;
  readonly automationMaturity: number | null;
  readonly executiveSponsor: boolean | null;
}

export interface Qualification {
  readonly score: number;
  readonly reason: string;
  /**
   * True when too little is known to score honestly.
   *
   * An unenriched prospect scores low for the same reason a bad-fit one does,
   * and treating those the same would bury good prospects nobody had researched
   * yet. `qualify` will not qualify or disqualify an incomplete record.
   */
  readonly incomplete: boolean;
  readonly missing: readonly string[];
}

/** Portfolio size, scored against the ideal 25–250 band. */
function portfolioPoints(count: number): number {
  if (count >= 25 && count <= 250) return 15;
  if (count > 250) return 12;
  if (count >= 10) return 8;
  return 2;
}

export function qualifyProspect(signals: ProspectSignals): Qualification {
  const missing: string[] = [];
  const need = <T>(name: string, value: T | null): T | null => {
    if (value === null) missing.push(name);
    return value;
  };

  const organisations = need('managedOrganisations', signals.managedOrganisations);
  const microsoft = need('microsoftHeavy', signals.microsoftHeavy);
  const compliance = need('complianceWorkload', signals.complianceWorkload);
  const api = need('apiCapable', signals.apiCapable);
  const maturity = need('automationMaturity', signals.automationMaturity);
  const sponsor = need('executiveSponsor', signals.executiveSponsor);

  let score = 0;
  const notes: string[] = [];

  if (organisations !== null) {
    const points = portfolioPoints(organisations);
    score += points;
    notes.push(`${organisations} managed organisations (+${points})`);
  }
  if (compliance === true) {
    score += 15;
    notes.push('recurring compliance workload (+15)');
  }
  if (microsoft === true) {
    score += 15;
    notes.push('Microsoft-heavy estate (+15)');
  }
  if (api === true) {
    score += 20;
    notes.push('API-capable stack (+20)');
  }
  if (maturity !== null) {
    const points = maturity * 2;
    score += points;
    notes.push(`automation maturity L${maturity} (+${points})`);
  }
  if (sponsor === true) {
    score += 15;
    notes.push('identified executive sponsor (+15)');
  }

  // A disqualifier, not a low score. An MSP whose stack cannot be reached is
  // not a slow sale; it is not a sale.
  if (api === false) {
    return {
      score: 0,
      reason: 'The stack is not API-capable, so Adericel cannot observe anything. Disqualified.',
      incomplete: false,
      missing,
    };
  }
  if (compliance === false && organisations !== null && organisations < 25) {
    return {
      score: 0,
      reason: 'No recurring compliance workload and a small portfolio. Disqualified.',
      incomplete: false,
      missing,
    };
  }

  return {
    score: Math.min(100, score),
    reason: notes.join('; ') || 'No positive signals recorded.',
    incomplete: missing.length > 0,
    missing,
  };
}

/** The threshold above which a prospect is worth contacting. */
export const QUALIFICATION_THRESHOLD = 55;

export const prospectInputSchema = z.object({
  domain: z.string().min(3).max(253).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'A domain name'),
  name: z.string().min(1).max(200),
  country: z.string().length(2).default('GB'),
});
export type ProspectInput = z.infer<typeof prospectInputSchema>;

export interface Prospect {
  readonly id: string;
  readonly domain: string;
  readonly name: string;
  readonly stage: string;
  readonly fitScore: number | null;
  readonly fitReason: string;
  readonly lawfulBasis: string;
  readonly suppressed: boolean;
  readonly contactEmail: string | null;
}

interface ProspectRow {
  id: string;
  domain: string;
  name: string;
  stage: string;
  fit_score: number | null;
  fit_reason: string;
  lawful_basis: string;
  suppressed: boolean;
  contact_email: string | null;
}

const SELECT = `id, domain, name, stage, fit_score, fit_reason, lawful_basis, suppressed, contact_email`;

function toProspect(row: ProspectRow): Prospect {
  return {
    id: row.id,
    domain: row.domain,
    name: row.name,
    stage: row.stage,
    fitScore: row.fit_score,
    fitReason: row.fit_reason,
    lawfulBasis: row.lawful_basis,
    suppressed: row.suppressed,
    contactEmail: row.contact_email,
  };
}

export interface PipelineService {
  discover(input: ProspectInput): Promise<{ prospect: Prospect | null; permitted: boolean }>;
  enrich(id: string, signals: ProspectSignals): Promise<{ prospect: Prospect | null; permitted: boolean }>;
  qualify(id: string): Promise<{ prospect: Prospect | null; permitted: boolean; incomplete: boolean }>;
  /** Prepare a message. Never sends: sending is a separate, gated operation. */
  prepareOutreach(
    id: string,
    templateKey: string,
    content: { subject: string; body: string },
  ): Promise<{ outreachId: string | null; permitted: boolean }>;
  /** Attempt to send. The gate decides; a refusal leaves an exception. */
  sendOutreach(
    outreachId: string,
    send: () => Promise<void>,
  ): Promise<{ sent: boolean; reason: string }>;
  suppress(id: string, reason: string): Promise<void>;
  get(id: string): Promise<Prospect | null>;
  actionable(limit?: number): Promise<readonly Prospect[]>;
}

export function createPipelineService(deps: {
  ctx: PlatformContext;
  clock: Clock;
  logger: Logger;
  operator: Operator;
}): PipelineService {
  const { ctx, clock, operator } = deps;

  async function load(id: string): Promise<ProspectRow | null> {
    return ctx.one<ProspectRow>(`SELECT ${SELECT} FROM veylith.prospects WHERE id = $1`, [id]);
  }

  return {
    async get(id) {
      const row = await load(id);
      return row ? toProspect(row) : null;
    },

    async actionable(limit = 50) {
      const rows = await ctx.many<ProspectRow>(
        `SELECT ${SELECT} FROM veylith.prospects
         WHERE stage = 'QUALIFIED' AND suppressed IS false
         ORDER BY fit_score DESC NULLS LAST LIMIT $1`,
        [limit],
      );
      return rows.map(toProspect);
    },

    async discover(rawInput) {
      const input = prospectInputSchema.parse(rawInput);
      const outcome = await operator.operate({
        processKey: 'market.prospect_discovery',
        operation: 'market.prospect_discovery.record',
        riskClass: 'INTERNAL',
        eventType: 'LEAD_CREATED',
        subjectKind: 'Prospect',
        subjectId: input.domain.toLowerCase(),
        intent: `Record ${input.name} as a prospect`,
        idempotencyKey: `prospect:${input.domain.toLowerCase()}`,
        payload: { domain: input.domain, name: input.name },
        effect: async () => {
          const row = await ctx.oneOrFail<ProspectRow>(
            `INSERT INTO veylith.prospects (domain, name, country)
             VALUES ($1, $2, $3)
             ON CONFLICT (lower(domain)) DO UPDATE SET name = EXCLUDED.name, updated_at = $4
             RETURNING ${SELECT}`,
            [input.domain, input.name, input.country, clock.nowIso()],
            'Prospect',
          );
          return row;
        },
      });
      return {
        prospect: outcome.result ? toProspect(outcome.result) : null,
        permitted: outcome.permitted,
      };
    },

    async enrich(id, signals) {
      const existing = await load(id);
      if (!existing) return { prospect: null, permitted: false };

      const outcome = await operator.operate({
        processKey: 'market.prospect_discovery',
        operation: 'market.prospect_discovery.enrich',
        riskClass: 'INTERNAL',
        eventType: 'LEAD_ENRICHED',
        subjectKind: 'Prospect',
        subjectId: id,
        intent: `Enrich ${existing.name}`,
        payload: { domain: existing.domain },
        effect: async () =>
          ctx.oneOrFail<ProspectRow>(
            `UPDATE veylith.prospects
             SET managed_organisations = $2, microsoft_heavy = $3, compliance_workload = $4,
                 api_capable = $5, automation_maturity = $6, executive_sponsor = $7,
                 stage = CASE WHEN stage = 'DISCOVERED' THEN 'ENRICHED' ELSE stage END,
                 updated_at = $8
             WHERE id = $1 RETURNING ${SELECT}`,
            [
              id,
              signals.managedOrganisations,
              signals.microsoftHeavy,
              signals.complianceWorkload,
              signals.apiCapable,
              signals.automationMaturity,
              signals.executiveSponsor,
              clock.nowIso(),
            ],
            'Prospect',
          ),
      });
      return {
        prospect: outcome.result ? toProspect(outcome.result) : null,
        permitted: outcome.permitted,
      };
    },

    async qualify(id) {
      const row = await ctx.one<
        ProspectRow & {
          managed_organisations: number | null;
          microsoft_heavy: boolean | null;
          compliance_workload: boolean | null;
          api_capable: boolean | null;
          automation_maturity: number | null;
          executive_sponsor: boolean | null;
        }
      >(
        `SELECT ${SELECT}, managed_organisations, microsoft_heavy, compliance_workload,
                api_capable, automation_maturity, executive_sponsor
         FROM veylith.prospects WHERE id = $1`,
        [id],
      );
      if (!row) return { prospect: null, permitted: false, incomplete: false };

      const qualification = qualifyProspect({
        managedOrganisations: row.managed_organisations,
        microsoftHeavy: row.microsoft_heavy,
        complianceWorkload: row.compliance_workload,
        apiCapable: row.api_capable,
        automationMaturity: row.automation_maturity,
        executiveSponsor: row.executive_sponsor,
      });

      // An incomplete record is neither qualified nor disqualified. Scoring it
      // would bury a good prospect nobody had researched yet under the same
      // number as a genuinely poor one.
      if (qualification.incomplete) {
        return { prospect: toProspect(row), permitted: true, incomplete: true };
      }

      const outcome = await operator.operate({
        processKey: 'sales.qualification',
        operation: 'sales.qualification.score',
        riskClass: 'INTERNAL',
        eventType: qualification.score >= QUALIFICATION_THRESHOLD ? 'LEAD_QUALIFIED' : 'LEAD_DISQUALIFIED',
        subjectKind: 'Prospect',
        subjectId: id,
        intent: `Score ${row.name}`,
        payload: { score: qualification.score, reason: qualification.reason },
        effect: async () =>
          ctx.oneOrFail<ProspectRow>(
            `UPDATE veylith.prospects
             SET fit_score = $2, fit_reason = $3, scored_at = $4,
                 stage = $5, disqualified_reason = $6, updated_at = $4
             WHERE id = $1 RETURNING ${SELECT}`,
            [
              id,
              qualification.score,
              qualification.reason,
              clock.nowIso(),
              qualification.score >= QUALIFICATION_THRESHOLD ? 'QUALIFIED' : 'DISQUALIFIED',
              qualification.score >= QUALIFICATION_THRESHOLD ? null : qualification.reason,
            ],
            'Prospect',
          ),
      });
      return {
        prospect: outcome.result ? toProspect(outcome.result) : null,
        permitted: outcome.permitted,
        incomplete: false,
      };
    },

    async prepareOutreach(id, templateKey, content) {
      const row = await load(id);
      if (!row) return { outreachId: null, permitted: false };

      // Preparing is internal work. Sending is not, and is a separate call —
      // so a bug in the preparation path can at worst produce a draft.
      const outcome = await operator.operate({
        processKey: 'sales.outreach',
        operation: 'sales.outreach.prepare',
        riskClass: 'INTERNAL',
        eventType: 'OUTREACH_PREPARED',
        subjectKind: 'Prospect',
        subjectId: id,
        intent: `Prepare ${templateKey} for ${row.name}`,
        payload: { templateKey },
        effect: async () =>
          ctx.oneOrFail<{ id: string }>(
            `INSERT INTO veylith.outreach (prospect_id, template_key, subject, body, prepared_at)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [id, templateKey, content.subject, content.body, clock.nowIso()],
            'Outreach',
          ),
      });
      return { outreachId: outcome.result?.id ?? null, permitted: outcome.permitted };
    },

    async sendOutreach(outreachId, send) {
      const row = await ctx.one<{
        id: string;
        prospect_id: string;
        template_key: string;
        status: string;
        name: string;
        lawful_basis: string;
        suppressed: boolean;
        contact_email: string | null;
      }>(
        `SELECT o.id, o.prospect_id, o.template_key, o.status,
                p.name, p.lawful_basis, p.suppressed, p.contact_email
         FROM veylith.outreach o JOIN veylith.prospects p ON p.id = o.prospect_id
         WHERE o.id = $1`,
        [outreachId],
      );
      if (!row) return { sent: false, reason: 'No such outreach' };
      if (row.status === 'SENT') return { sent: false, reason: 'Already sent' };

      // The facts the policy is asked about are read from the record, not
      // asserted by the caller. A caller that could assert its own consent
      // would be deciding its own authority.
      //
      // `lawful_basis_recorded` is deliberately absent — not false — when no
      // basis exists, so the policy answers UNKNOWN rather than DENY, and the
      // exception says nobody established it rather than that it was refused.
      const facts: Record<string, boolean> = {
        not_suppressed: !row.suppressed,
        content_approved: row.status === 'APPROVED',
      };
      if (row.lawful_basis !== '') facts.lawful_basis_recorded = true;

      const outcome = await operator.operate({
        processKey: 'sales.outreach',
        operation: 'sales.outreach.send_email',
        riskClass: 'OUTWARD_FACING',
        eventType: 'OUTREACH_SENT',
        subjectKind: 'Prospect',
        subjectId: row.prospect_id,
        intent: `Send ${row.template_key} to ${row.name}`,
        facts,
        idempotencyKey: `outreach:${outreachId}`,
        payload: { outreachId, templateKey: row.template_key },
        verifiable: true,
        effect: async () => {
          await send();
          await ctx.query(
            `UPDATE veylith.outreach SET status = 'SENT', sent_at = $2 WHERE id = $1`,
            [outreachId, clock.nowIso()],
          );
        },
      });

      return {
        sent: outcome.permitted && outcome.exception === null && !outcome.alreadyPerformed,
        reason: outcome.decision.reason,
      };
    },

    async suppress(id, reason) {
      // Not gated. Suppression only ever removes authority, and a rule that
      // could block it would be a rule that keeps someone on a mailing list
      // against their wishes.
      await ctx.query(
        `UPDATE veylith.prospects
         SET suppressed = true, suppressed_reason = $2, suppressed_at = $3, updated_at = $3
         WHERE id = $1`,
        [id, reason, clock.nowIso()],
      );
    },
  };
}
