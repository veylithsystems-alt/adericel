/**
 * Time is an injected dependency in Adericel.
 *
 * The Truth Engine must be replayable: given the same inputs and the same
 * ruleset version it must produce the same assessment. Ambient wall-clock reads
 * make that impossible, so every component that needs "now" receives a Clock.
 */
export interface Clock {
  now(): Date;
  nowIso(): string;
  nowEpochMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
  nowEpochMs: () => Date.now(),
};

/** Deterministic clock for tests and for replaying historical assessments. */
export function fixedClock(instant: Date | string): Clock {
  const at = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(at.getTime())) {
    throw new TypeError(`fixedClock: invalid instant ${String(instant)}`);
  }
  return {
    now: () => new Date(at.getTime()),
    nowIso: () => at.toISOString(),
    nowEpochMs: () => at.getTime(),
  };
}

/** A clock that advances only when explicitly told to. */
export function manualClock(start: Date | string): Clock & { advance(ms: number): void } {
  let current = (typeof start === 'string' ? new Date(start) : start).getTime();
  return {
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    nowEpochMs: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export const MILLISECOND = 1;
export const SECOND = 1000 * MILLISECOND;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseInstant(value: Date | string | number): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`Invalid instant: ${String(value)}`);
  return d;
}

export function ageMs(clock: Clock, at: Date | string): number {
  return clock.nowEpochMs() - parseInstant(at).getTime();
}

export function ageDays(clock: Clock, at: Date | string): number {
  return ageMs(clock, at) / DAY;
}
