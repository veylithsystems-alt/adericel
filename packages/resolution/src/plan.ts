import { z } from 'zod';
import type { BlockedReason, DegradedReason, UnknownReason } from '@adericel/domain';
import {
  KIND_MEANING,
  KIND_OF_BLOCKED_REASON,
  KIND_OF_DEGRADED_REASON,
  KIND_OF_REASON,
  isActionable,
  type UnknownKind,
} from './kind.js';
import {
  assessMateriality,
  materialityRank,
  type Materiality,
  type MaterialityInput,
} from './materiality.js';

/**
 * Turning "we do not know" into "here is how to find out".
 *
 * UNKNOWN as a first-class state is the product's strongest position and, on
 * its own, an incomplete one. Telling an MSP that forty controls are undecided
 * is honest; leaving them to work out what to do about it moves the cost rather
 * than removing it. The claim Adericel should be able to make is not "we are
 * honest about what we do not know" — every competitor will say that once they
 * hear it — but **"we reduce the cost of finding out"**, which is harder to
 * copy because it requires knowing why each unknown is unknown.
 *
 * So every material unknown carries eight things, and none of them is optional:
 *
 *   1. Why it is unknown            `kind` + `becauseUnknown`
 *   2. What evidence would resolve it `resolvedBy`
 *   3. Who or what can provide it    `owner` + `ownerDetail`
 *   4. How material it is            `materiality` + `materialityBecause`
 *   5. What happens if it is not     `ifUnresolved`
 *   6. Which sort of gap it is       `kind`
 *   7. The next recommended action   `nextAction`
 *   8. The uncertainty it would clear `uncertaintyReduction`
 *
 * WHAT (8) IS NOT
 *
 * Not a probability, and not a confidence percentage. It is a count: how many
 * controls would become decidable, and how many of them are undecided for this
 * reason alone. Those are facts about the graph. A number like "73% confidence"
 * would be a fabrication dressed as precision, and this product does not have
 * a place to write that sentence.
 */

/** Who can actually supply the missing thing. */
export const RESOLUTION_OWNERS = [
  /** A connector could supply it if configured, repaired or re-scoped. */
  'INTEGRATION',
  /** The MSP's own engineer: a credential, a scope, a configuration. */
  'MSP',
  /** Somebody at the client organisation: a policy, a decision, an attestation. */
  'CLIENT',
  /** A third party: a supplier, an auditor, a vendor. */
  'THIRD_PARTY',
  /** Veylith: a connector that does not exist yet, or a rule that is wrong. */
  'VEYLITH',
  /** Nobody. The question does not resolve by effort. */
  'NOBODY',
] as const;
export type ResolutionOwner = (typeof RESOLUTION_OWNERS)[number];
export const resolutionOwnerSchema = z.enum(RESOLUTION_OWNERS);

export interface UncertaintyReduction {
  /** Controls that would become decidable if this were resolved. */
  readonly controlsUnblocked: number;
  /**
   * Of those, how many are undecided for this reason and no other — so
   * resolving this alone decides them.
   */
  readonly controlsDecidedOutright: number;
  /**
   * Stated with every figure. These are counts over the assurance graph, not a
   * probability and not a confidence level.
   */
  readonly caveat: string;
}

export interface UnknownItemInput {
  readonly organisationId: string;
  readonly controlId: string;
  readonly controlKey: string;
  readonly controlTitle: string;
  /** At most one of these is set, matching the engine's own output. */
  readonly unknownReason: UnknownReason | null;
  readonly degradedReason: DegradedReason | null;
  /**
   * Set when the control is BLOCKED: a person owes a decision.
   *
   * Carried separately from `unknownReason` because the two lead to opposite
   * actions. An unknown says look harder; a block says stop looking and go and
   * ask somebody.
   */
  readonly blockedReason: BlockedReason | null;
  /** Canonical predicates the rule needed and did not get. */
  readonly missingPredicates: readonly string[];
  /**
   * The connector that declares those predicates, where one does.
   *
   * Resolved by the caller from the manifests, because this module is pure and
   * the manifest set is a property of the deployment.
   */
  readonly supplyingConnector: string | null;
  /** Whether that connector is configured for this organisation at all. */
  readonly connectorConfigured: boolean;
  /** Whether the predicate could only ever come from a person. */
  readonly attestationOnly: boolean;
  readonly materialityInput: MaterialityInput;
  readonly uncertaintyReduction: Omit<UncertaintyReduction, 'caveat'>;
  /** Set when a request has already gone out and is unanswered. */
  readonly outstandingRequestAgeDays: number | null;
}

export interface ResolutionPlan {
  readonly organisationId: string;
  readonly controlId: string;
  readonly controlKey: string;
  readonly controlTitle: string;

  readonly kind: UnknownKind;
  /**
   * What that kind means, in an operator's terms.
   *
   * Carried on the plan rather than looked up by the caller, because a client
   * that had to join the kind against a lookup table is a client that will
   * render the enum when the join is inconvenient — and `CONTRADICTORY` on a
   * screen tells a person nothing about what to do.
   */
  readonly kindMeaning: string;
  /** Why, in the words an operator would use rather than the engine's enum. */
  readonly becauseUnknown: string;

  /** What would settle it. Never empty. */
  readonly resolvedBy: string;
  readonly owner: ResolutionOwner;
  readonly ownerDetail: string;

  readonly materiality: Materiality;
  readonly materialityBecause: readonly string[];
  readonly ifUnresolved: string;

  /** One sentence, imperative, addressed to whoever owns it. */
  readonly nextAction: string;
  readonly uncertaintyReduction: UncertaintyReduction;

  /** For ordering a queue. Not shown as a score. */
  readonly rank: number;
  /** True when nothing inside Adericel can close it. */
  readonly actionable: boolean;
}

const UNCERTAINTY_CAVEAT =
  'These are counts of controls in this organisation’s assurance graph, not a probability ' +
  'and not a confidence level. Resolving this makes them decidable; what they then decide is ' +
  'whatever the evidence says.';

function reasonSentence(input: UnknownItemInput): string {
  if (input.blockedReason !== null) {
    switch (input.blockedReason) {
      case 'AUTHORITY_MISSING':
        return 'Adericel holds no authority to observe what this control needs. Nothing has been collected because nobody granted permission to look, which is not the same as nothing being there.';
      case 'APPROVAL_PENDING':
        return 'An action this control depends on is waiting for a human approval. The work is queued, not failed.';
      case 'CONSENT_REQUIRED':
        return 'The client has not granted the consent collection requires, so Adericel has deliberately not looked.';
      case 'DEPENDENCY_BLOCKED':
        return 'Another control or system this one depends on is itself unresolved, so this cannot be decided until that one is.';
      case 'SAFETY_CONDITION_UNMET':
        return 'A safety precondition for assessing this is not met, so assessment was stopped on purpose rather than attempted and failed.';
      case 'CONTAINED':
        return 'This estate or integration is under containment. Somebody decided to stop looking, and that decision — not an absence of evidence — is why this is undecided.';
    }
  }

  if (input.degradedReason !== null) {
    switch (input.degradedReason) {
      case 'CREDENTIAL_EXPIRED':
        return `The stored credential for ${input.supplyingConnector ?? 'the source'} no longer authenticates, so nothing has been collected since it lapsed.`;
      case 'CONSENT_WITHDRAWN':
        return `Consent for ${input.supplyingConnector ?? 'the source'} was withdrawn or revoked, so Adericel is no longer permitted to look.`;
      case 'SOURCE_UNAVAILABLE':
        return `${input.supplyingConnector ?? 'The source'} is unreachable or returning errors.`;
      case 'PARTIAL_COLLECTION':
        return `Collection from ${input.supplyingConnector ?? 'the source'} ran but returned only part of the estate, so the control cannot be decided across all of it.`;
      case 'SCHEMA_DRIFT':
        return `${input.supplyingConnector ?? 'The source'} changed shape and Adericel no longer recognises the fields it needs.`;
      case 'RATE_LIMITED':
        return `${input.supplyingConnector ?? 'The source'} is throttling collection hard enough that a run cannot finish.`;
      case 'COLLECTION_FAILING':
        return `Collection from ${input.supplyingConnector ?? 'the source'} is failing repeatedly.`;
    }
  }

  switch (input.unknownReason) {
    case 'NO_EVIDENCE':
      return input.connectorConfigured
        ? `${input.supplyingConnector ?? 'The configured source'} has not yet supplied ${describePredicates(input.missingPredicates)}.`
        : `Nothing is configured that could supply ${describePredicates(input.missingPredicates)}.`;
    case 'INSUFFICIENT_EVIDENCE':
      return `Some of what the rule needs arrived and ${describePredicates(input.missingPredicates)} did not, so the rule cannot be completed.`;
    case 'RULE_INPUTS_MISSING':
      return `The rule requires ${describePredicates(input.missingPredicates)}, which nothing has supplied.`;
    case 'STALE_EVIDENCE':
      return 'The evidence exists and is older than this control permits, so it no longer describes the estate as it is now.';
    case 'CONTRADICTORY_EVIDENCE':
      return 'Two sources disagree about this. Collecting again will produce the same disagreement — one of them has to be treated as authoritative.';
    case 'EVIDENCE_INTEGRITY_UNVERIFIED':
      return 'The evidence on record does not hash to what it claims, so it cannot be relied on even though it is present.';
    case 'EVIDENCE_REVOKED':
      return 'The evidence this rested on was revoked, so the conclusion it supported no longer stands.';
    case 'NO_APPLICABLE_RULE':
      return 'No rule in the active ruleset decides this control, so Adericel has nothing to evaluate.';
    case 'COLLECTION_FAILED':
      return `Collection from ${input.supplyingConnector ?? 'the source'} failed, so no observation arrived.`;
    case 'NOT_YET_ASSESSED':
      return 'This control has not been assessed yet. Evidence may exist; nothing has run over it.';
    case null:
      return 'The engine reported UNKNOWN without naming a reason, which is itself a defect worth reporting.';
  }
}

function describePredicates(predicates: readonly string[]): string {
  if (predicates.length === 0) return 'the facts the rule needs';
  if (predicates.length === 1) return `\`${predicates[0]}\``;
  if (predicates.length <= 3) return predicates.map((p) => `\`${p}\``).join(', ');
  return `\`${predicates[0]}\` and ${predicates.length - 1} other predicates`;
}

/**
 * Who owes the decision, per blocked reason.
 *
 * Data rather than a switch, so adding a `BlockedReason` without deciding who
 * resolves it does not compile. The split between CLIENT and MSP is the one
 * that matters operationally: an MSP cannot grant itself authority over a
 * customer's estate, and presenting `CONSENT_REQUIRED` as MSP work would send
 * an engineer to do something they are not permitted to do.
 */
const BLOCKED_ROUTING: Readonly<
  Record<
    BlockedReason,
    { owner: ResolutionOwner; ownerDetail: string; resolvedBy: string; nextAction: string }
  >
> = {
  AUTHORITY_MISSING: {
    owner: 'CLIENT',
    ownerDetail:
      'The authority to observe this belongs to the client. The MSP cannot grant itself ' +
      'access to a customer estate, and Adericel will not act as though it had.',
    resolvedBy:
      'A recorded grant of authority from the client covering what this control needs to ' +
      'observe.',
    nextAction:
      'Ask the client to grant the access this control requires, and record who granted it. ' +
      'Do not widen an existing connector to work around it.',
  },
  APPROVAL_PENDING: {
    owner: 'MSP',
    ownerDetail:
      'An approval is sitting in a queue. Whoever holds it can release this today, and ' +
      'nothing else needs to happen first.',
    resolvedBy: 'The pending approval being decided, either way.',
    nextAction:
      'Find the pending approval and decide it. A refusal resolves this as cleanly as an ' +
      'approval does — what leaves the control undecided is nobody looking.',
  },
  CONSENT_REQUIRED: {
    owner: 'CLIENT',
    ownerDetail:
      'Collection needs the client’s consent and does not have it. Adericel has deliberately ' +
      'not looked.',
    resolvedBy: 'Consent recorded by a named person at the client.',
    nextAction:
      'Ask the client for the consent collection requires, and record who gave it. Until they ' +
      'do, this control stays undecided by design.',
  },
  DEPENDENCY_BLOCKED: {
    owner: 'MSP',
    ownerDetail:
      'Something this control depends on is itself unresolved. Working this item directly ' +
      'will not move it.',
    resolvedBy: 'The control or system this depends on reaching a determinate state.',
    nextAction:
      'Resolve the dependency first. This item will clear on its own once that one does, so ' +
      'do not spend time on it now.',
  },
  SAFETY_CONDITION_UNMET: {
    owner: 'MSP',
    ownerDetail:
      'A precondition for assessing this safely is not met. Adericel stopped rather than ' +
      'proceeding, which is the intended behaviour.',
    resolvedBy: 'The safety precondition being met, or a recorded decision to waive it.',
    nextAction:
      'Establish the missing precondition, or record a decision that assessment may proceed ' +
      'without it and why. Do not disable the check.',
  },
  CONTAINED: {
    owner: 'MSP',
    ownerDetail:
      'Containment is in force and is why this is undecided. That is a decision somebody ' +
      'made, not a fault — and lifting it is also a decision.',
    resolvedBy: 'Containment being lifted, or the containment being recorded as the position.',
    nextAction:
      'Decide whether containment still applies. If it does, record that this control is ' +
      'undecided because of containment rather than leaving it in the work queue.',
  },
};

function ownerOf(
  input: UnknownItemInput,
  kind: UnknownKind,
): {
  owner: ResolutionOwner;
  ownerDetail: string;
  resolvedBy: string;
  nextAction: string;
} {
  if (kind === 'AWAITING_DECISION' && input.blockedReason !== null) {
    // Checked before `attestationOnly`: a contained estate is contained
    // whether or not the predicate could also come from a person, and telling
    // an operator to go and collect an attestation from a client who has
    // withdrawn consent would be the wrong instruction confidently given.
    return BLOCKED_ROUTING[input.blockedReason];
  }

  if (kind === 'OUT_OF_SCOPE') {
    return {
      owner: 'NOBODY',
      ownerDetail:
        'No source and no person resolves this as it stands. Either the control does not apply ' +
        'to this organisation, or the ruleset has a gap.',
      resolvedBy:
        'A scoping decision, or a rule that does not exist yet. Not evidence — there is ' +
        'nothing to collect.',
      nextAction:
        'Record this control as not applicable with a reason, or raise it with Veylith as a ' +
        'ruleset gap. Do not leave it in the queue as work.',
    };
  }

  if (input.attestationOnly) {
    return {
      owner: 'CLIENT',
      ownerDetail:
        'This is a fact about how the organisation operates rather than a system state. No ' +
        'API reports it, so a named person at the client has to assert it.',
      resolvedBy: 'A written attestation from somebody at the client, recorded with their name.',
      nextAction:
        input.outstandingRequestAgeDays === null
          ? 'Ask the client to confirm this in writing, and record who confirmed it.'
          : `The request is ${input.outstandingRequestAgeDays} day(s) old with no answer. ` +
            'Escalate to the client’s named contact, or record the risk as accepted.',
    };
  }

  if (kind === 'UNCOLLECTABLE' || kind === 'STALE') {
    return {
      owner: 'MSP',
      ownerDetail: `The MSP holds the credential and the configuration for ${input.supplyingConnector ?? 'this source'}.`,
      resolvedBy: `A working connection to ${input.supplyingConnector ?? 'the source'}, and one successful collection run.`,
      nextAction:
        input.degradedReason === 'CREDENTIAL_EXPIRED'
          ? `Reauthorise ${input.supplyingConnector ?? 'the connector'} and re-run collection.`
          : input.degradedReason === 'CONSENT_WITHDRAWN'
            ? 'Ask the client to restore consent, then re-run collection. Adericel will not ' +
              'look again until they do.'
            : `Repair collection from ${input.supplyingConnector ?? 'the source'} and re-run it.`,
    };
  }

  if (kind === 'CONTRADICTORY') {
    return {
      owner: 'MSP',
      ownerDetail:
        'Adericel deliberately does not choose between disagreeing sources (ADR-0029). An ' +
        'engineer decides which is authoritative for this predicate.',
      resolvedBy:
        'A recorded decision about which source is authoritative, or a correction at whichever ' +
        'source is wrong.',
      nextAction:
        'Compare the two observations, correct whichever source is wrong, and record which one ' +
        'is authoritative so the disagreement does not recur.',
    };
  }

  // MISSING
  if (input.supplyingConnector === null) {
    return {
      owner: 'VEYLITH',
      ownerDetail:
        'No connector Adericel ships declares these predicates, so no amount of configuration ' +
        'by the MSP will supply them.',
      resolvedBy:
        'A connector that observes this, or a person asserting it in the meantime. Adericel ' +
        'reports the gap as its own rather than the customer’s.',
      nextAction:
        'Record an attestation as an interim position, and raise the coverage gap with Veylith. ' +
        'This is not the MSP’s work to do.',
    };
  }

  return {
    owner: input.connectorConfigured ? 'MSP' : 'MSP',
    ownerDetail: input.connectorConfigured
      ? `${input.supplyingConnector} is connected but has not supplied this yet — usually a ` +
        'missing permission or a capability that was never enabled.'
      : `${input.supplyingConnector} declares these predicates and is not configured for this ` +
        'organisation.',
    resolvedBy: `${describePredicates(input.missingPredicates)}, collected from ${input.supplyingConnector}.`,
    nextAction: input.connectorConfigured
      ? `Check ${input.supplyingConnector}'s granted permissions against what this capability ` +
        'needs, then re-run collection.'
      : `Configure ${input.supplyingConnector} for this organisation and run a first collection.`,
  };
}

export function planResolution(raw: UnknownItemInput): ResolutionPlan {
  /**
   * An omitted reason is the same as an absent one.
   *
   * The three reason fields are required by the interface, and a caller
   * spreading a partial over an object literal can still hand us `undefined` —
   * TypeScript does not always catch it, and a row read from JSON never will.
   * Left unnormalised, `undefined !== null` is true and the plan comes out
   * carrying no kind at all: a response an operator cannot read, produced
   * without an error anybody would see.
   */
  const input: UnknownItemInput = {
    ...raw,
    unknownReason: raw.unknownReason ?? null,
    degradedReason: raw.degradedReason ?? null,
    blockedReason: raw.blockedReason ?? null,
  };

  /**
   * Blocked first, then degraded, then unknown.
   *
   * The order is the order of confidence. A blocked reason names a person and a
   * decision; a degraded reason names a repair; an unknown reason names an
   * absence. If a row somehow carries more than one, the most specific
   * statement about what to do next is the one worth acting on.
   */
  const kind =
    input.blockedReason !== null
      ? KIND_OF_BLOCKED_REASON[input.blockedReason]
      : input.degradedReason !== null
        ? KIND_OF_DEGRADED_REASON[input.degradedReason]
        : input.unknownReason !== null
          ? KIND_OF_REASON[input.unknownReason]
          : 'MISSING';

  const actionable = isActionable(kind);
  const verdict = assessMateriality({ ...input.materialityInput, actionable });
  const routing = ownerOf(input, kind);

  return {
    organisationId: input.organisationId,
    controlId: input.controlId,
    controlKey: input.controlKey,
    controlTitle: input.controlTitle,

    kind,
    kindMeaning: KIND_MEANING[kind],
    becauseUnknown: reasonSentence(input),

    resolvedBy: routing.resolvedBy,
    owner: routing.owner,
    ownerDetail: routing.ownerDetail,

    materiality: verdict.materiality,
    materialityBecause: verdict.because,
    ifUnresolved: verdict.ifUnresolved,

    nextAction: routing.nextAction,
    uncertaintyReduction: { ...input.uncertaintyReduction, caveat: UNCERTAINTY_CAVEAT },

    rank:
      materialityRank(verdict.materiality) * 1000 + input.uncertaintyReduction.controlsUnblocked,
    actionable,
  };
}

/**
 * One queue, ordered, with the unactionable items separated rather than mixed
 * in.
 *
 * An item nobody can action sitting in a work queue teaches an operator to
 * distrust the queue, and a distrusted queue is how the real items get missed.
 * They are returned, because they are still true and still belong in a report.
 */
export function orderResolutionQueue(plans: readonly ResolutionPlan[]): {
  readonly work: readonly ResolutionPlan[];
  readonly notActionable: readonly ResolutionPlan[];
  readonly summary: string;
} {
  const work = plans.filter((plan) => plan.actionable).sort((a, b) => b.rank - a.rank);
  const notActionable = plans.filter((plan) => !plan.actionable);

  const blocking = work.filter((plan) => plan.materiality === 'BLOCKING').length;
  const unblocked = work.reduce(
    (total, plan) => total + plan.uncertaintyReduction.controlsUnblocked,
    0,
  );

  return {
    work,
    notActionable,
    summary:
      `${work.length} unknown(s) can be resolved, ${blocking} of them blocking a dated ` +
      `commitment. Clearing all of them would make ${unblocked} control assessment(s) ` +
      `decidable. ${notActionable.length} further unknown(s) cannot be closed from inside ` +
      'Adericel and are listed separately rather than mixed into the work.',
  };
}
