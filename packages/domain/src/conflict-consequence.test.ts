import { describe, expect, it } from 'vitest';
import {
  ASSURANCE_LIMITATIONS,
  conflictConsequence,
  conflictNeedsAttention,
  resolveConflict,
  type SourcedValue,
} from './conflict.js';

/**
 * What a conflict costs.
 *
 * Contract v3.2 requires a conflict to expose affected controls and the
 * resulting assurance limitation. Before this, `ConflictOutcome` reported that
 * two systems disagreed and stopped — leaving an operator to work out for
 * themselves which controls that darkened, which is the same cost the resolution
 * queue was built to remove.
 *
 * The property running through the file: a consequence never states the
 * limitation as a restatement of the state. "The control stays UNKNOWN" is a
 * tautology; what an operator needs is the sentence they would have to say to
 * the customer.
 */

function source(name: string, value: unknown, collectedAt: string): SourcedValue {
  return {
    integrationId: `int-${name}`,
    connectorKey: name,
    displayName: name,
    value,
    observedAt: collectedAt,
    collectedAt,
  };
}

const INTUNE = source('Intune', true, '2026-09-29T09:00:00.000Z');
const RMM = source('the RMM', false, '2026-09-29T09:00:00.000Z');

describe('a conflict states what it costs', () => {
  it('names every limitation it can report', () => {
    expect([...ASSURANCE_LIMITATIONS]).toEqual([
      'NONE',
      'DETERMINATION_WITHHELD',
      'DETERMINATION_RESTS_ON_ONE_SOURCE',
    ]);
  });

  it('withholds a determination when nothing resolves the disagreement', () => {
    const outcome = resolveConflict('device.disk.encrypted', 'device-17', [INTUNE, RMM]);
    expect(outcome.resolution).toBe('UNRESOLVED');

    const consequence = conflictConsequence(outcome, [
      'ce.secure_config.disk_encryption',
      'iso.A.8.24',
    ]);
    expect(consequence.limitation).toBe('DETERMINATION_WITHHELD');
    expect(consequence.affectedControlKeys).toEqual([
      'ce.secure_config.disk_encryption',
      'iso.A.8.24',
    ]);
    expect(consequence.limitationBecause).toMatch(/Intune and the RMM disagree/);
    expect(consequence.limitationBecause).toMatch(/2 control\(s\)/);
  });

  it('states the consequence as what you would have to tell the customer', () => {
    // Not "the control stays UNKNOWN", which is a tautology and tells an
    // operator nothing they did not already know from the state.
    const outcome = resolveConflict('device.disk.encrypted', 'device-17', [INTUNE, RMM]);
    const consequence = conflictConsequence(outcome, ['ce.secure_config.disk_encryption']);
    expect(consequence.ifUnresolved).toMatch(/reads to a third party exactly like a failure/);
    expect(consequence.ifUnresolved).not.toMatch(/stays? UNKNOWN/);
  });

  it('refuses to choose, and says whose job it is', () => {
    const outcome = resolveConflict('device.disk.encrypted', 'device-17', [INTUNE, RMM]);
    const consequence = conflictConsequence(outcome, ['ce.secure_config.disk_encryption']);
    expect(consequence.resolvedBy).toMatch(/ADR-0029/);
    // Collecting harder is the wrong instinct and the plan says so, because it
    // is the first thing an engineer will try.
    expect(consequence.resolvedBy).toMatch(/collecting again will produce the same disagreement/i);
  });

  it('distinguishes "decided on a contested reading" from "undecided"', () => {
    /**
     * The distinction v3.2 is really asking for.
     *
     * A conflict resolved by a configured authority produced a determination.
     * That is a legitimate basis and it is not unanimity — and a recipient of an
     * Assurance Passport is entitled to know the reading was contested, because
     * "Intune says encrypted" and "Intune says encrypted while the RMM says
     * otherwise" are different statements.
     */
    const outcome = resolveConflict('device.disk.encrypted', 'device-17', [INTUNE, RMM], {
      authoritativeIntegrationIds: ['int-Intune'],
    });
    expect(outcome.resolution).toBe('RESOLVED_BY_AUTHORITY');

    const consequence = conflictConsequence(outcome, ['ce.secure_config.disk_encryption']);
    expect(consequence.limitation).toBe('DETERMINATION_RESTS_ON_ONE_SOURCE');
    expect(consequence.limitationBecause).toMatch(/is not unanimity/);
    expect(consequence.ifUnresolved).toMatch(/decided, not undecided/);
    // Still worth a person's attention: a source that keeps disagreeing is
    // usually a real fault in one of the two systems.
    expect(conflictNeedsAttention(consequence)).toBe(true);
  });

  it('limits nothing when the sources agree', () => {
    const outcome = resolveConflict('device.disk.encrypted', 'device-17', [
      INTUNE,
      source('the RMM', true, '2026-09-29T09:00:00.000Z'),
    ]);
    expect(outcome.resolution).toBe('AGREED');

    const consequence = conflictConsequence(outcome, ['ce.secure_config.disk_encryption']);
    expect(consequence.limitation).toBe('NONE');
    expect(conflictNeedsAttention(consequence)).toBe(false);
    expect(consequence.ifUnresolved).toMatch(/no disagreement to resolve/i);
  });

  it('reports a conflict on a predicate no control reads, without overstating it', () => {
    /**
     * A disagreement about a predicate nothing currently evaluates is real and
     * costs nothing today. Reporting "0 controls stay undecided" as though it
     * were an incident would teach an operator to ignore the whole category;
     * dropping it would lose a fault that matters the moment a control is added.
     */
    const outcome = resolveConflict('device.disk.encrypted', 'device-17', [INTUNE, RMM]);
    const consequence = conflictConsequence(outcome, []);
    expect(consequence.limitation).toBe('DETERMINATION_WITHHELD');
    expect(consequence.affectedControlKeys).toEqual([]);
    expect(consequence.ifUnresolved).toMatch(/nothing is undecided by it today/);
    expect(consequence.ifUnresolved).toMatch(/still on record/);
  });

  it('counts each affected control once, in a stable order', () => {
    // The caller supplies the fan-out and may supply duplicates; a count that
    // double-counted would inflate the stated consequence.
    const outcome = resolveConflict('device.disk.encrypted', 'device-17', [INTUNE, RMM]);
    const consequence = conflictConsequence(outcome, ['b.control', 'a.control', 'b.control']);
    expect(consequence.affectedControlKeys).toEqual(['a.control', 'b.control']);
    expect(consequence.limitationBecause).toMatch(/2 control\(s\)/);
  });

  it('names the organisation rather than a subject for an organisation-wide predicate', () => {
    const outcome = resolveConflict('organisation.logging.enabled', null, [INTUNE, RMM]);
    const consequence = conflictConsequence(outcome, ['ce.logging.retained']);
    expect(consequence.limitationBecause).toMatch(/for the organisation/);
  });
});
