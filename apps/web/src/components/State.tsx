import type { ReactElement } from 'react';
import {
  SEVERITY_TONE,
  STATE_PRESENTATION,
  type AssuranceState,
  type Severity,
} from '../lib/assurance-presentation.js';

/**
 * The assurance state tag — Brand Pack v1.1.
 *
 * A filled pill in the state colour, except Unknown, which is hatched and has
 * no colour at all. The title attribute carries the full meaning, because
 * "Unknown" on its own invites the reader to assume it means "probably fine",
 * and that assumption is the single thing this product exists to prevent.
 *
 * The label is wrapped in its own element so the Unknown hatch can be laid
 * behind the pill without running through the text.
 */
export function StateChip({
  state,
  reason,
}: {
  state: AssuranceState;
  reason?: string | null;
}): ReactElement {
  const presentation = STATE_PRESENTATION[state];
  return (
    <span
      className={`state state--${presentation.tone}`}
      title={reason ? `${presentation.meaning} Reason: ${reason}` : presentation.meaning}
    >
      <span>{presentation.label}</span>
    </span>
  );
}

export function SeverityChip({ severity }: { severity: Severity }): ReactElement {
  return (
    <span className={`state state--${SEVERITY_TONE[severity]}`}>
      <span>{severity.charAt(0) + severity.slice(1).toLowerCase()}</span>
    </span>
  );
}

export interface StateCounts {
  SATISFIED: number;
  PARTIALLY_SATISFIED: number;
  NOT_SATISFIED: number;
  EXCEPTED: number;
  NOT_APPLICABLE: number;
  UNKNOWN: number;
}

/**
 * Proportional bar of assurance states.
 *
 * Segments are sized by count and labelled by count. There is no percentage
 * anywhere: the bar shows composition, and the numbers beside it say exactly
 * how many of what.
 */
export function CountBar({ counts }: { counts: StateCounts }): ReactElement {
  const total =
    counts.SATISFIED +
    counts.PARTIALLY_SATISFIED +
    counts.NOT_SATISFIED +
    counts.EXCEPTED +
    counts.UNKNOWN +
    counts.NOT_APPLICABLE;

  if (total === 0) {
    return <div className="count-bar" aria-label="No controls in scope" />;
  }

  const segments: { key: string; tone: string; count: number }[] = [
    { key: 'NOT_SATISFIED', tone: 'failing', count: counts.NOT_SATISFIED },
    { key: 'UNKNOWN', tone: 'unknown', count: counts.UNKNOWN },
    { key: 'PARTIALLY_SATISFIED', tone: 'exception', count: counts.PARTIALLY_SATISFIED },
    { key: 'EXCEPTED', tone: 'exception', count: counts.EXCEPTED },
    { key: 'SATISFIED', tone: 'proven', count: counts.SATISFIED },
    { key: 'NOT_APPLICABLE', tone: 'muted', count: counts.NOT_APPLICABLE },
  ];

  return (
    <div
      className="count-bar"
      role="img"
      aria-label={segments
        .filter((s) => s.count > 0)
        .map((s) => `${s.count} ${STATE_PRESENTATION[s.key as AssuranceState].label}`)
        .join(', ')}
    >
      {segments
        .filter((segment) => segment.count > 0)
        .map((segment) => (
          <div
            key={segment.key}
            className={`count-bar__segment count-bar__segment--${segment.tone}`}
            style={{ flexGrow: segment.count }}
          />
        ))}
    </div>
  );
}

/** A count with its label. Never a percentage. */
export function Metric({
  value,
  label,
  note,
  tone,
}: {
  value: string | number;
  label: string;
  note?: string;
  tone?: 'proven' | 'failing' | 'exception' | 'unknown';
}): ReactElement {
  const colour =
    tone === 'failing'
      ? 'var(--state-failing)'
      : tone === 'proven'
        ? 'var(--state-proven)'
        : tone === 'exception'
          ? 'var(--state-exception)'
          : undefined;
  return (
    <div className="metric">
      <span className="metric__value" style={colour ? { color: colour } : undefined}>
        {value}
      </span>
      <span className="metric__label">{label}</span>
      {note ? <span className="metric__note">{note}</span> : null}
    </div>
  );
}
