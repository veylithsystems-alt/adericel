import { z } from 'zod';

/**
 * What a question means, written down.
 *
 * "Is MFA enforced for all remote access?" is at least four questions depending
 * on what the reader takes "all" and "remote access" to mean. An engine that
 * determines an answer from observed state has to decide, and the decision
 * changes the answer — so it is recorded, shown to a person, confirmed, and
 * versioned (ADR-0035).
 */

export const INTERPRETATION_ORIGINS = [
  /** Matched deterministically to the shared bank. No model involved. */
  'BANK_MATCHED',
  /** Written or confirmed by a person. */
  'HUMAN_ASSERTED',
  /** Proposed by a model. Always a candidate; never exportable unconfirmed. */
  'AI_SUGGESTED',
  /** Reused from this organisation's own earlier confirmed interpretation. */
  'ORGANISATION_PRIOR',
] as const;
export type InterpretationOrigin = (typeof INTERPRETATION_ORIGINS)[number];

export const INTERPRETATION_STATUSES = ['CANDIDATE', 'CONFIRMED', 'SUPERSEDED'] as const;
export type InterpretationStatus = (typeof INTERPRETATION_STATUSES)[number];

/**
 * How much of the estate the question is asking about.
 *
 * Narrowing the scope is how a strict reading is made answerable: "all remote
 * access" is strict about *all* and specific about *remote access*.
 */
export const INTERPRETATION_SCOPES = [
  'ALL_USERS',
  'HUMAN_USERS',
  'ADMINISTRATIVE_ACCOUNTS',
  'REMOTE_ACCESS',
  'ALL_DEVICES',
  'MANAGED_DEVICES',
  'SERVERS',
  'CLOUD_RESOURCES',
  'ORGANISATION',
  'SUPPLIERS',
] as const;
export type InterpretationScope = (typeof INTERPRETATION_SCOPES)[number];

/**
 * Words that make a question absolute.
 *
 * Detected so the interpretation can default to the strictest reasonable
 * reading. The asymmetry is deliberate and stated in ADR-0035: a strict reading
 * produces QUALIFIED where a loose one produces SUPPORTED, and the cost of the
 * first error is a conversation while the cost of the second is a repudiated
 * claim.
 */
export const ABSOLUTE_WORDS = [
  'all',
  'every',
  'always',
  'any',
  'each',
  'entire',
  'without exception',
  'at all times',
  'fully',
  'completely',
  '100%',
] as const;

/** A time constraint the question imposes, e.g. "within 14 days". */
export interface TimeWindow {
  readonly days: number;
  /** The wording it came from, so a person can check the reading. */
  readonly sourcePhrase: string;
}

const TIME_PATTERNS: readonly { pattern: RegExp; days: (match: RegExpMatchArray) => number }[] = [
  { pattern: /within (\d+) days?/i, days: (m) => Number(m[1]) },
  { pattern: /within (\d+) weeks?/i, days: (m) => Number(m[1]) * 7 },
  { pattern: /within (\d+) months?/i, days: (m) => Number(m[1]) * 30 },
  { pattern: /\b(\d+)[- ]day\b/i, days: (m) => Number(m[1]) },
  { pattern: /\bmonthly\b/i, days: () => 30 },
  { pattern: /\bquarterly\b/i, days: () => 90 },
  { pattern: /\bannually\b|\byearly\b/i, days: () => 365 },
];

export function detectTimeWindow(questionText: string): TimeWindow | null {
  for (const { pattern, days } of TIME_PATTERNS) {
    const match = questionText.match(pattern);
    if (match) return { days: days(match), sourcePhrase: match[0] };
  }
  return null;
}

export function detectAbsoluteWords(questionText: string): readonly string[] {
  const lower = questionText.toLowerCase();
  return ABSOLUTE_WORDS.filter((word) => new RegExp(`\\b${word}\\b`, 'i').test(lower));
}

export interface Interpretation {
  readonly id: string;
  readonly questionId: string;
  /** The requirement, over canonical predicates, in the Truth Engine's language. */
  readonly expression: unknown;
  readonly scope: InterpretationScope;
  /** True when absolute wording was detected and has not been relaxed. */
  readonly strict: boolean;
  /** The absolute words that made it strict, for the person confirming it. */
  readonly absoluteWords: readonly string[];
  readonly timeWindow: TimeWindow | null;
  readonly origin: InterpretationOrigin;
  readonly status: InterpretationStatus;
  readonly version: number;
  /** A person's own words for what this question is taken to mean. */
  readonly statement: string;
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | null;
}

/**
 * Only a confirmed interpretation may produce an exportable answer.
 *
 * The rule exists because a model proposal is the one place hostile text in a
 * questionnaire could reach (ADR-0034, P8). The worst an injection can achieve
 * is a wrong proposal awaiting a human's confirmation.
 */
export function isExportable(interpretation: Interpretation): boolean {
  return interpretation.status === 'CONFIRMED';
}

/** Build the strict default reading of a question, before any model is asked. */
export function defaultReading(questionText: string): {
  strict: boolean;
  absoluteWords: readonly string[];
  timeWindow: TimeWindow | null;
} {
  const absoluteWords = detectAbsoluteWords(questionText);
  return {
    strict: absoluteWords.length > 0,
    absoluteWords,
    timeWindow: detectTimeWindow(questionText),
  };
}

export const interpretationConfirmationSchema = z.object({
  statement: z.string().min(10).max(2000),
  scope: z.enum(INTERPRETATION_SCOPES),
  strict: z.boolean(),
  timeWindowDays: z.number().int().min(1).max(3650).nullable(),
});
