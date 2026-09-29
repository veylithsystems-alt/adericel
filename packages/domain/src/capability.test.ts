import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_STATUSES,
  HUMAN_ESTABLISHED_STATUSES,
  attestationProblems,
  positionOf,
  registerProblems,
  type Capability,
  type CapabilityStatus,
  type StatusAttestation,
} from './capability.js';

/**
 * The capability status lifecycle.
 *
 * Contract v3.1 §6. One property runs through the file: **a status is never
 * inferred from another.** Every way of getting that wrong produces the same
 * outcome — a document claiming a capability is further along than anybody
 * established — and that is the exact failure this product exists to refuse in
 * its customers' systems.
 */

function attest(
  status: CapabilityStatus,
  overrides: Partial<StatusAttestation> = {},
): StatusAttestation {
  return {
    status,
    source: 'AUTOMATED_CHECK',
    evidence: 'packages/example/src/thing.test.ts proves the named guard refuses',
    establishedAt: '2026-09-23',
    ...overrides,
  };
}

function capability(attestations: readonly StatusAttestation[]): Capability {
  return { key: 'example', title: 'The example capability', attestations };
}

describe('no status is inferred from another', () => {
  it('reports the statuses below the attested one that nobody attested', () => {
    /**
     * The defect this model exists to prevent.
     *
     * A single `status` column holding OPERATIONAL says every earlier stage is
     * satisfied too. It isn't: this capability runs in production and nobody
     * ever proved an invariant by breaking it. That is worth seeing, and a
     * transition function would have hidden it.
     */
    const position = positionOf(capability([attest('IMPLEMENTED'), attest('OPERATIONAL')]));

    expect(position.attested).toBe('OPERATIONAL');
    expect(position.skipped).toEqual(['DESIGNED', 'TESTED', 'VERIFIED']);
    expect(position.statement).toMatch(/skipped rather than satisfied/);
  });

  it('says nothing is attested rather than defaulting to the first status', () => {
    const position = positionOf(capability([]));

    // Not DESIGNED. A capability nobody has recorded anything about has not
    // been designed either — it has been named.
    expect(position.attested).toBeNull();
    expect(position.statement).toMatch(/no attested status/);
    expect(position.statement).toMatch(/not the same as it not existing/);
  });

  it('leaves every later status unestablished, and says nothing implies them', () => {
    const position = positionOf(capability([attest('DESIGNED'), attest('IMPLEMENTED')]));
    expect(position.notYetEstablished).toEqual([
      'TESTED',
      'VERIFIED',
      'OPERATIONAL',
      'PROVEN',
      'PRODUCTION_READY',
      'COMMERCIAL_VALIDATED',
    ]);
    expect(position.statement).toMatch(/nothing here implies them/);
  });

  it('does not treat RETIRED as the most mature status', () => {
    /**
     * RETIRED sorts last in the vocabulary because it is terminal, not because
     * it is furthest along. Taking the highest-ordered attested status
     * literally would report a withdrawn capability as the most mature thing
     * in the system — on the front page of a document a customer reads.
     */
    const position = positionOf(capability([attest('TESTED'), attest('RETIRED')]));
    expect(position.attested).toBe('RETIRED');
    expect(position.skipped).toEqual([]);
    expect(position.notYetEstablished).toEqual([]);
    expect(position.statement).toMatch(/history is not editable/);
  });

  it('never reports a status nobody attested, over every single status', () => {
    // Quantified rather than sampled: for each status on its own, that status
    // is what comes back, and nothing adjacent to it does.
    for (const status of CAPABILITY_STATUSES) {
      const position = positionOf(capability([attest(status)]));
      expect(position.attested, status).toBe(status);
      expect(position.skipped, status).not.toContain(status);
      expect(position.notYetEstablished, status).not.toContain(status);
    }
  });
});

describe('what a green pipeline is not evidence of', () => {
  it('refuses an automated attestation of every human-established status', () => {
    /**
     * Named explicitly before the loop.
     *
     * Iterating an empty list passes, so emptying `HUMAN_ESTABLISHED_STATUSES`
     * — which is exactly the shortcut somebody takes to get a release out —
     * would leave this test green while a pipeline declared the product
     * production ready. Found by that mutation, so the names are asserted
     * rather than assumed.
     */
    expect([...HUMAN_ESTABLISHED_STATUSES]).toEqual([
      'PROVEN',
      'PRODUCTION_READY',
      'COMMERCIAL_VALIDATED',
    ]);

    for (const status of HUMAN_ESTABLISHED_STATUSES) {
      const problems = attestationProblems(attest(status, { source: 'AUTOMATED_CHECK' }));
      expect(problems.join(' '), status).toMatch(/cannot be established by an automated check/);
    }
  });

  it('accepts the same status from a named person', () => {
    const problems = attestationProblems(
      attest('PRODUCTION_READY', {
        source: 'NAMED_PERSON',
        evidence: 'Signed off by the named operational owner against the release gate record',
      }),
    );
    expect(problems).toEqual([]);
  });

  it('refuses an attestation whose evidence restates the status', () => {
    // A register full of "it is production ready" reads as substantiated when
    // it is not, which is worse than an empty register.
    const problems = attestationProblems(
      attest('PRODUCTION_READY', { source: 'NAMED_PERSON', evidence: 'it is production ready' }),
    );
    expect(problems.join(' ')).toMatch(/restates the status instead of establishing it/);
  });

  it('refuses an attestation with nothing behind it', () => {
    const problems = attestationProblems(attest('TESTED', { evidence: 'done' }));
    expect(problems.join(' ')).toMatch(/carries no usable evidence/);
  });

  it('reports every problem across a register in one pass', () => {
    // One problem per run would mean fixing a register takes as many runs as
    // it has mistakes, which is how a register stops being maintained.
    const problems = registerProblems([
      { key: 'a', title: 'A', attestations: [attest('PROVEN')] },
      { key: 'b', title: 'B', attestations: [attest('TESTED', { evidence: 'x' })] },
      { key: 'c', title: 'C', attestations: [attest('TESTED')] },
    ]);
    expect(problems.map((entry) => entry.key)).toEqual(['a', 'b']);
  });
});
