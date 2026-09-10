import { describe, expect, it } from 'vitest';
import {
  JOB_TYPES,
  ON_DEMAND_JOBS,
  ORGANISATION_JOB_TYPES,
  PLATFORM_JOB_TYPES,
  type JobType,
} from '@adericel/worker';

/**
 * Every job runs.
 *
 * A handler with no schedule is the worst kind of dead code: it passes its
 * tests, reads as working, and never once executes in production. That is how
 * `lapse-overdue-subscriptions` came to exist — handled, tested, invoked by
 * hand in a test, and scheduled nowhere — which meant the billing lifecycle's
 * only time-driven lever was never being pulled.
 *
 * A job may be on demand. It may not be forgotten. The difference has to be
 * written down, and this is where.
 */

describe('every job type is scheduled or declared on demand', () => {
  const scheduled = new Set<JobType>([...ORGANISATION_JOB_TYPES, ...PLATFORM_JOB_TYPES]);
  const onDemand = new Set<JobType>(ON_DEMAND_JOBS);

  it('leaves no job type unaccounted for', () => {
    const orphans = JOB_TYPES.filter((type) => !scheduled.has(type) && !onDemand.has(type));
    expect(orphans).toEqual([]);
  });

  it('does not both schedule a job and call it on demand only', () => {
    const both = JOB_TYPES.filter((type) => scheduled.has(type) && onDemand.has(type));
    expect(both).toEqual([]);
  });

  it('schedules each job in exactly one place', () => {
    const organisation = new Set<JobType>(ORGANISATION_JOB_TYPES);
    const overlap = PLATFORM_JOB_TYPES.filter((type) => organisation.has(type));
    // A job registered both per-organisation and platform-wide would run once
    // for the platform and once per customer, which for a purge is a very
    // expensive mistake.
    expect(overlap).toEqual([]);
  });

  it('names only real job types', () => {
    const known = new Set<string>(JOB_TYPES);
    for (const type of [...ORGANISATION_JOB_TYPES, ...PLATFORM_JOB_TYPES, ...ON_DEMAND_JOBS]) {
      expect(known.has(type), `${type} is not a job type`).toBe(true);
    }
  });
});
