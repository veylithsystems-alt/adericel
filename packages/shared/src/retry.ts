import { AdericelError } from './errors.js';

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffMultiplier: number;
  /** 0..1 — proportion of the delay that is randomised, to avoid thundering herds. */
  readonly jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 250,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  jitterRatio: 0.2,
};

/** Delay before attempt `attempt` (1-based). `random` is injectable for tests. */
export function backoffDelayMs(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const raw = policy.initialDelayMs * policy.backoffMultiplier ** Math.max(0, attempt - 1);
  const capped = Math.min(raw, policy.maxDelayMs);
  const jitterSpan = capped * policy.jitterRatio;
  const jitter = jitterSpan === 0 ? 0 : (random() * 2 - 1) * jitterSpan;
  return Math.max(0, Math.round(capped + jitter));
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof AdericelError) return error.retryable;
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return (
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNREFUSED' ||
      code === 'EAI_AGAIN' ||
      code === 'EPIPE'
    );
  }
  return false;
}

export interface RetryContext {
  readonly attempt: number;
  readonly delayMs: number;
  readonly error: unknown;
}

export interface RetryOptions {
  readonly policy?: RetryPolicy;
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  readonly onRetry?: (context: RetryContext) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly signal?: AbortSignal;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry with exponential backoff. Retries only errors that are explicitly
 * classified as retryable — an authorisation failure or a policy denial must
 * never be retried into eventual success.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const shouldRetry = options.shouldRetry ?? ((error) => isRetryable(error));
  const doSleep = options.sleep ?? sleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const isLast = attempt >= policy.maxAttempts;
      if (isLast || !shouldRetry(error, attempt)) throw error;
      const delayMs = backoffDelayMs(policy, attempt, options.random);
      options.onRetry?.({ attempt, delayMs, error });
      await doSleep(delayMs);
    }
  }
  throw lastError;
}

/** Reject if the operation exceeds `ms`. Guards against hung external calls. */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label = 'operation',
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AdericelError('DEPENDENCY_UNAVAILABLE', `${label} timed out after ${ms}ms`, {
        cause: error,
        retryable: true,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
