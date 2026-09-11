import {
  mayRenderAsBarePositive,
  type AnswerDetermination,
  type AnswerException,
  type AnswerFormat,
  type AnswerState,
  type SenderType,
} from './answer.js';

/**
 * Turning a determination into what goes in the box.
 *
 * Pure functions, no I/O, like the Truth Engine — so a rendering replays from
 * its inputs and a submission can be reproduced byte-identically in a dispute a
 * year later (ADR-0023, ADR-0026).
 *
 * This file is where ADR-0036 is enforced. Everything here is arranged so that
 * producing a bare "Yes" from a state that does not support one requires
 * defeating a check rather than forgetting one.
 */

/** How a sender's forms should be answered when the position is partial. */
export interface SenderPolicy {
  readonly senderType: SenderType;
  /**
   * What QUALIFIED renders as on a yes/no field.
   *
   * `NEGATIVE_WITH_POSITION` is the insurance default: on a form whose answers
   * form the basis of a contract, "yes with exceptions" in a comment box is
   * still read as "yes" by anybody skimming, and the exceptions are exactly
   * what a claims investigator will find. The safer rendering is the negative
   * with the partial position stated.
   */
  readonly qualifiedRendering: 'POSITIVE_WITH_EXCEPTIONS' | 'NEGATIVE_WITH_POSITION';
  /** Whether a second person must approve the submission. */
  readonly requiresFourEyes: boolean;
  /** Whether submitted answers are watched for drift after sending. */
  readonly watchAfterSubmission: boolean;
}

/**
 * Defaults per sender.
 *
 * Insurance is the strictest because the stakes are the highest: the answers
 * form the basis of the contract and a misstatement can leave the client
 * uninsured at the moment they need to claim.
 */
export const SENDER_POLICIES: Readonly<Record<SenderType, SenderPolicy>> = {
  INSURER: {
    senderType: 'INSURER',
    qualifiedRendering: 'NEGATIVE_WITH_POSITION',
    requiresFourEyes: true,
    watchAfterSubmission: true,
  },
  BROKER: {
    senderType: 'BROKER',
    qualifiedRendering: 'NEGATIVE_WITH_POSITION',
    requiresFourEyes: true,
    watchAfterSubmission: true,
  },
  CUSTOMER_DUE_DILIGENCE: {
    senderType: 'CUSTOMER_DUE_DILIGENCE',
    qualifiedRendering: 'POSITIVE_WITH_EXCEPTIONS',
    requiresFourEyes: false,
    watchAfterSubmission: true,
  },
  TENDER: {
    senderType: 'TENDER',
    qualifiedRendering: 'POSITIVE_WITH_EXCEPTIONS',
    requiresFourEyes: true,
    watchAfterSubmission: false,
  },
  CERTIFICATION: {
    senderType: 'CERTIFICATION',
    qualifiedRendering: 'NEGATIVE_WITH_POSITION',
    requiresFourEyes: true,
    watchAfterSubmission: true,
  },
  OTHER: {
    senderType: 'OTHER',
    qualifiedRendering: 'POSITIVE_WITH_EXCEPTIONS',
    requiresFourEyes: false,
    watchAfterSubmission: false,
  },
};

/**
 * Strings that constitute an unqualified positive.
 *
 * Used by the property test and the consistency checker. Kept as one list so
 * there is a single place that defines what "saying yes" means, rather than
 * each renderer having its own opinion.
 */
export const BARE_POSITIVES: readonly string[] = [
  'yes',
  'y',
  'true',
  'compliant',
  'fully compliant',
  'in place',
  'implemented',
  'confirmed',
  'we do',
  'all',
];

/** Whether a rendered value reads as an unqualified positive. */
export function isBarePositive(value: string): boolean {
  const normalised = value
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  if (normalised.length === 0) return false;
  return BARE_POSITIVES.includes(normalised);
}

export interface RenderedAnswer {
  /** What goes in the field. */
  readonly value: string;
  /** What goes in the comment box, where the form has one. */
  readonly comment: string | null;
  /**
   * True when the form's format cannot carry the honest answer and a person
   * must decide. The engine does not choose for them: a format constraint is
   * not a licence to overstate.
   */
  readonly requiresHumanDecision: boolean;
  /** Why a person is needed, where they are. */
  readonly humanDecisionReason: string | null;
  readonly rendererVersion: string;
}

export const RENDERER_VERSION = '1.0.0';

function describeExceptions(exceptions: readonly AnswerException[]): string {
  if (exceptions.length === 0) return '';
  const described = exceptions.slice(0, 5).map((exception) => {
    const parts = [exception.subject];
    if (exception.reason) parts.push(`excluded by ${exception.reason}`);
    if (exception.since) parts.push(`since ${exception.since.slice(0, 10)}`);
    return parts.join(', ');
  });
  const more = exceptions.length > 5 ? `, and ${exceptions.length - 5} more` : '';
  return `${described.join('; ')}${more}`;
}

/**
 * The position, stated as a count.
 *
 * "47 of 49 accounts" is the sentence that makes an exception concrete. A
 * percentage would round, and rounding is how "mostly" becomes "yes".
 */
function positionSentence(determination: AnswerDetermination): string {
  if (determination.subjectsInScope === 0) return '';
  return `${determination.subjectsSatisfying} of ${determination.subjectsInScope} in scope`;
}

/**
 * The templated wording for every state.
 *
 * Exists so a model is never required to produce an answer. A model may
 * rephrase this; the checker in `consistency.ts` compares the rephrasing
 * against the determination and rejects anything that asserts more.
 */
export function templateFor(
  determination: AnswerDetermination,
  policy: SenderPolicy,
): { value: string; comment: string | null } {
  const position = positionSentence(determination);
  const exceptions = describeExceptions(determination.exceptions);

  switch (determination.state) {
    case 'SUPPORTED':
      return { value: 'Yes', comment: determination.reason };

    case 'NOT_MET':
      return {
        value: 'No',
        comment: position ? `${determination.reason} (${position}).` : determination.reason,
      };

    case 'QUALIFIED': {
      // Exceptions first, because exceptions are where disputes arise and are
      // therefore what the reader must not be able to skim past.
      const detail =
        `Exceptions: ${exceptions}.` + (position ? ` The requirement holds for ${position}.` : '');
      return policy.qualifiedRendering === 'NEGATIVE_WITH_POSITION'
        ? { value: 'No', comment: detail }
        : { value: 'Yes, with exceptions', comment: detail };
    }

    case 'UNKNOWN':
      return {
        value: 'Unable to confirm',
        comment: `Adericel could not determine this: ${determination.reason}.`,
      };

    case 'ATTESTED':
      return {
        value: 'Yes, attested',
        comment: `Confirmed by a named person rather than observed: ${determination.reason}.`,
      };

    case 'NOT_APPLICABLE':
      return { value: 'N/A', comment: determination.reason };
  }
}

/**
 * Render a determination into the form's format.
 *
 * The last line of defence is at the bottom of this function: whatever any
 * branch above produced, a value that reads as a bare positive from a state
 * that may not render as one is replaced and escalated to a person. It should
 * be unreachable. It is there because "should be unreachable" is how silent
 * yeses happen.
 */
export function renderAnswer(
  determination: AnswerDetermination,
  format: AnswerFormat,
  policy: SenderPolicy,
): RenderedAnswer {
  const template = templateFor(determination, policy);
  let value = template.value;
  let comment = template.comment;
  let requiresHumanDecision = false;
  let humanDecisionReason: string | null = null;

  if (format === 'YES_NO') {
    // A field that accepts only Yes or No cannot carry QUALIFIED, UNKNOWN or
    // ATTESTED honestly, and there is nowhere to put the qualification. The
    // engine refuses to pick and says why.
    if (determination.state === 'QUALIFIED') {
      value = 'No';
      comment = template.comment;
      requiresHumanDecision = true;
      humanDecisionReason =
        'The form accepts only Yes or No and has no comment field, and the honest answer is ' +
        'partial. Adericel has entered the conservative answer. A person must decide whether ' +
        'to send it, or to attach the exceptions another way.';
    } else if (determination.state === 'UNKNOWN' || determination.state === 'ATTESTED') {
      value = determination.state === 'UNKNOWN' ? 'No' : 'Yes';
      requiresHumanDecision = true;
      humanDecisionReason =
        determination.state === 'UNKNOWN'
          ? 'The form accepts only Yes or No and Adericel cannot determine this. A person must ' +
            'establish the answer or attest to it before sending.'
          : 'This answer rests on a person’s attestation rather than an observation, and the ' +
            'form has nowhere to say so.';
    }
  }

  if (format === 'NUMBER' || format === 'DATE') {
    // A numeric or date field cannot express UNKNOWN. Leaving it blank is the
    // honest rendering; guessing a zero would be a fabricated fact.
    if (determination.state !== 'SUPPORTED' && determination.state !== 'ATTESTED') {
      value = '';
      requiresHumanDecision = true;
      humanDecisionReason =
        'This field takes a value Adericel cannot determine. It has been left blank rather ' +
        'than guessed.';
    }
  }

  if (format === 'FILE_UPLOAD') {
    value = '';
    requiresHumanDecision = true;
    humanDecisionReason = 'This question requires a document. A person must attach it.';
  }

  // ADR-0036, enforced rather than trusted.
  if (!mayRenderAsBarePositive(determination.state) && isBarePositive(value)) {
    value = 'Requires review';
    requiresHumanDecision = true;
    humanDecisionReason =
      `A renderer produced an unqualified positive for a ${determination.state} answer. ` +
      'This is a defect; the answer has been withheld.';
  }

  return {
    value,
    comment,
    requiresHumanDecision,
    humanDecisionReason,
    rendererVersion: RENDERER_VERSION,
  };
}

/** Every format, so the property test can cover all of them without a list. */
export const ALL_FORMATS: readonly AnswerFormat[] = [
  'YES_NO',
  'YES_NO_COMMENT',
  'MULTIPLE_CHOICE',
  'NUMBER',
  'DATE',
  'FREE_TEXT',
  'FILE_UPLOAD',
];

/** Every state, likewise. */
export function statesOtherThan(state: AnswerState): readonly AnswerState[] {
  return (
    ['SUPPORTED', 'NOT_MET', 'QUALIFIED', 'UNKNOWN', 'ATTESTED', 'NOT_APPLICABLE'] as const
  ).filter((candidate) => candidate !== state);
}
