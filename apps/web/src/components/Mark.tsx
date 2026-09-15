import type { ReactElement } from 'react';

/**
 * The Adericel mark — Brand Pack v1.2.
 *
 * Three ascending slanted bars. Two are solid; the middle one is hatched with
 * the same diagonal used for the Unknown state everywhere else in the product.
 *
 * That is not decoration. The mark says the thing the product says: some of
 * what we know is established, and some of it is honestly not, and the second
 * part is drawn rather than hidden. It is the only logo in the category that
 * admits to a gap, which is the whole positioning in one shape.
 *
 * The mark carries no green. Green is a state colour — it means an assurance
 * state is proven — and the brand pack lists using it as a brand colour, or
 * building a green app icon, as explicit DON'Ts. A green mark would spend the
 * one colour that carries meaning on something that carries none.
 *
 * GEOMETRY STATUS: PROVISIONAL (v1.2 §29).
 *
 * These paths are reconstructed from the v1.1 raster brand sheet. They are
 * reference only. They are not the official vector master and are not described
 * as official, final, canonical or source artwork anywhere in this repository.
 *
 * They are deliberately identical to `MARK_BARS` in
 * `scripts/build-brand-assets.ts`, and a test asserts it — otherwise the mark in
 * the product and the mark in a customer's deck stop being the same mark. When
 * the official master arrives, both change together and nothing else does.
 */

export type MarkVariant = 'light' | 'dark' | 'mono';

const HATCH_ID = 'adericel-mark-hatch';

/** Slant, shared by all three bars so the mark reads as one object. */
const BARS = [
  { d: 'M0 40 L16 0 H26 L10 40 Z', hatched: false },
  { d: 'M18 40 L34 0 H44 L28 40 Z', hatched: true },
  { d: 'M36 40 L48 10 H58 L46 40 Z', hatched: false },
] as const;

export function Mark({
  size = 24,
  variant = 'light',
  title,
}: {
  size?: number;
  /**
   * `light` on paper, `dark` on ink, `mono` to inherit `currentColor`.
   *
   * The mono variant deliberately draws the middle bar solid rather than
   * hatched. At a single colour and small sizes the hatch fills in and reads as
   * a muddy block, which is worse than an honest solid — the brand pack ships
   * separate mono assets for exactly this reason.
   */
  variant?: MarkVariant;
  /** Set when the mark is the only label; omit when text sits beside it. */
  title?: string;
}): ReactElement {
  const height = size;
  const width = size * 1.45;

  // A unique id per instance: two marks on one page sharing a pattern id makes
  // the second one reference the first one's definition, which breaks the
  // moment the first is removed from the DOM.
  const hatchId = `${HATCH_ID}-${variant}-${size}`;

  const fill =
    variant === 'mono'
      ? 'currentColor'
      : variant === 'dark'
        ? 'var(--c-paper, #fbfbf9)'
        : 'var(--c-ink, #14181f)';

  return (
    <svg
      className="mark"
      width={width}
      height={height}
      viewBox="0 0 58 40"
      fill="none"
      role={title ? 'img' : 'presentation'}
      {...(title ? { 'aria-label': title } : { 'aria-hidden': true })}
    >
      {variant !== 'mono' ? (
        <defs>
          <pattern
            id={hatchId}
            patternUnits="userSpaceOnUse"
            width="5"
            height="5"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="5" stroke={fill} strokeWidth="1.6" />
          </pattern>
        </defs>
      ) : null}

      {BARS.map((bar) => (
        <path
          key={bar.d}
          d={bar.d}
          fill={bar.hatched && variant !== 'mono' ? `url(#${hatchId})` : fill}
          {...(bar.hatched && variant !== 'mono'
            ? { stroke: fill, strokeWidth: 1.5, strokeLinejoin: 'round' as const }
            : {})}
        />
      ))}
    </svg>
  );
}

export function Wordmark({
  size = 24,
  inverse = false,
}: {
  size?: number;
  inverse?: boolean;
}): ReactElement {
  return (
    <span
      className="masthead__brand"
      style={inverse ? { color: 'var(--text-on-brand)' } : undefined}
    >
      <Mark size={size} variant={inverse ? 'dark' : 'light'} />
      <span>Adericel</span>
    </span>
  );
}
