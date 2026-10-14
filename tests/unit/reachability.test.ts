import { describe, expect, it } from 'vitest';
import { findUnreached } from '../../scripts/reachability.js';
import baseline from './reachability-baseline.json' with { type: 'json' };

/**
 * Behaviour that is written, exported, tested, and never invoked.
 *
 * WHY THIS IS ITS OWN CHECK
 *
 * `containmentImpairments` was a complete, correct, documented function with
 * zero callers. The Truth Engine's impairment logic had a passing unit suite
 * and nothing in the product supplied its input, so DEGRADED — a whole
 * designed assurance state, with its own vocabulary, database columns and
 * CHECK constraints — was unreachable, and every broken connector told an
 * engineer to go and connect something that was already connected.
 *
 * Neither was a logic error. Both were holes *between* well-tested functions,
 * which is a class of defect unit coverage cannot see: coverage measures
 * whether a function agrees with its test, never whether anything calls it. A
 * repository can be fully covered and implement nothing.
 *
 * HOW THIS TEST WORKS, AND WHY IT IS A RATCHET
 *
 * There are forty-nine of these today. Allowlisting them with invented reasons
 * would be rubber-stamping, and fixing all forty-nine in one change would be
 * reckless — several are genuine features that need a route, a caller or a
 * deliberate deletion, and each is its own decision.
 *
 * So the baseline is recorded by name and this test asserts the findings are a
 * **subset** of it. A new unreached export fails the build; removing one from
 * the baseline is free. The debt is frozen rather than hidden, and it can only
 * shrink. The triage is in `docs/audit/RESIDUAL_RISK_REGISTER.md` under
 * RR-088, where the three that matter most are named.
 */

/**
 * Known unreached exports, as of 14 October 2026.
 *
 * Held in JSON, not TypeScript, and that is not a style preference. The first
 * version listed them in this file — and naming an export here made the
 * scanner find a reference to it, so the baseline suppressed every finding it
 * was meant to record and the check reported a clean repository. A `.json`
 * file is not scanned, so the list cannot defeat itself.
 *
 * Every line is debt, not an exemption. Deleting a line is the goal.
 */
const BASELINE = baseline as readonly { file: string; name: string }[];

const key = (item: { file: string; name: string }): string => `${item.file}::${item.name}`;

describe('every exported behaviour is reached by something', () => {
  const unreached = findUnreached();
  const known = new Set(BASELINE.map(key));

  it('introduces no new function or class that nothing calls', () => {
    const added = unreached.filter((item) => !known.has(key(item)));
    expect(
      added.map(key),
      'New exported functions that nothing calls. A behaviour nobody invokes is not a feature, ' +
        'however well it is tested — that is how DEGRADED came to be unreachable while its ' +
        'logic had a passing suite. Either wire it up, or delete it and keep the test honest.',
    ).toEqual([]);
  });

  it('keeps the baseline honest by failing when an entry is fixed', () => {
    /**
     * The other direction, and it is not pedantry.
     *
     * A baseline nobody prunes becomes a list of things everybody has stopped
     * looking at. When an entry is wired up or deleted, this fails and the
     * line has to come out — so the list always describes the debt that
     * actually exists rather than the debt that existed in October.
     */
    const stale = [...known].filter((entry) => !unreached.some((item) => key(item) === entry));
    expect(
      stale,
      'These baseline entries are no longer unreached — they have been wired up or deleted. ' +
        'Remove them from BASELINE so the list keeps describing real debt.',
    ).toEqual([]);
  });

  it('finds the shape of defect it was written for', () => {
    /**
     * A guard on the guard.
     *
     * If `findUnreached` silently returned nothing — a changed directory
     * layout, a regex that stopped matching — both tests above would pass and
     * the check would be decoration. The baseline is non-empty today, so
     * finding nothing means the scanner broke, not that the debt was paid.
     */
    expect(BASELINE.length).toBeGreaterThan(0);
    expect(
      unreached.length,
      'The scanner found nothing while the baseline is non-empty. It has stopped working.',
    ).toBeGreaterThan(0);
  });
});
