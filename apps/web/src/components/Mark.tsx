import type { ReactElement } from 'react';
/**
 * The Adericel mark.
 *
 * Three ascending bars: two in ink and slate, the third in proven green. It
 * reads as evidence accumulating towards a conclusion, which is what the
 * product does.
 */
export function Mark({ size = 24, mono = false }: { size?: number; mono?: boolean }): ReactElement {
  const height = size;
  const width = size * 1.45;
  return (
    <svg
      className="mark"
      width={width}
      height={height}
      viewBox="0 0 58 40"
      fill="none"
      role="img"
      aria-label="Adericel"
    >
      <path d="M0 40 L16 0 H26 L10 40 Z" fill={mono ? 'currentColor' : 'var(--ink)'} />
      <path d="M18 40 L34 0 H44 L28 40 Z" fill={mono ? 'currentColor' : 'var(--slate)'} />
      <path
        d="M36 40 L52 0 H58 L58 40 Z"
        fill={mono ? 'currentColor' : 'var(--state-proven)'}
      />
    </svg>
  );
}

export function Wordmark({ size = 24, inverse = false }: { size?: number; inverse?: boolean }): ReactElement {
  return (
    <span className="masthead__brand" style={inverse ? { color: 'var(--text-inverse)' } : undefined}>
      <Mark size={size} />
      <span>Adericel</span>
    </span>
  );
}
