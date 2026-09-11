import { describe, expect, it } from 'vitest';
import { evaluateVerification } from './verification.js';

/**
 * The point where ACTION ATTEMPTED becomes ACTION VERIFIED.
 *
 * Everything here is one question: can any input make this say CONFIRMED when
 * the external system did not actually do what was asked?
 */

const RAN_AT = '2026-03-01T12:00:00.000Z';

describe('EQUALS', () => {
  const ask = (observedValue: unknown) =>
    evaluateVerification({
      predicate: 'identity.account.enabled',
      expectedValue: false,
      comparison: 'EQUALS',
      observedValue,
      executedAt: RAN_AT,
    });

  it('confirms when the re-observed value is what the action was meant to produce', () => {
    expect(ask(false).outcome).toBe('CONFIRMED');
  });

  it('refutes when the state did not change', () => {
    expect(ask(true).outcome).toBe('REFUTED');
  });

  it('is inconclusive when nothing came back, never confirmed', () => {
    expect(ask(null).outcome).toBe('INCONCLUSIVE');
    expect(ask(undefined).outcome).toBe('INCONCLUSIVE');
  });

  it('does not accept a value that merely coerces to the expected one', () => {
    // `0 == false` in JavaScript. It must not mean the account was disabled.
    expect(ask(0).outcome).toBe('REFUTED');
    expect(ask('false').outcome).toBe('REFUTED');
  });
});

describe('OBSERVED_AFTER_EXECUTION', () => {
  const ask = (observedValue: unknown, executedAt: string | null = RAN_AT) =>
    evaluateVerification({
      predicate: 'device.management.last_sync_at',
      expectedValue: null,
      comparison: 'OBSERVED_AFTER_EXECUTION',
      observedValue,
      executedAt,
    });

  it('confirms when the timestamp advanced past the moment the action ran', () => {
    expect(ask('2026-03-01T12:00:30.000Z').outcome).toBe('CONFIRMED');
  });

  it('refutes a stale timestamp from before the action', () => {
    // A device that is switched off. The request succeeded, nothing happened,
    // and this is the case that must never read as success.
    const judgement = ask('2026-02-27T09:00:00.000Z');
    expect(judgement.outcome).toBe('REFUTED');
    expect(judgement.detail).toContain('has not done what was asked');
  });

  it('refutes a timestamp exactly equal to the execution instant', () => {
    // Equal is not later. Nothing new was observed.
    expect(ask(RAN_AT).outcome).toBe('REFUTED');
  });

  it('is inconclusive when the observed value is not a timestamp', () => {
    expect(ask(true).outcome).toBe('INCONCLUSIVE');
    expect(ask('recently').outcome).toBe('INCONCLUSIVE');
  });

  it('is inconclusive when we do not know when the action ran', () => {
    expect(ask('2026-03-01T12:00:30.000Z', null).outcome).toBe('INCONCLUSIVE');
  });

  it('is inconclusive rather than confirmed when nothing was observed', () => {
    expect(ask(null).outcome).toBe('INCONCLUSIVE');
  });
});
