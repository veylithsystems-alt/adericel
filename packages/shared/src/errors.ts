/**
 * Adericel error taxonomy.
 *
 * Every error carries a stable machine-readable `code`, an HTTP status for the
 * API edge, and a `safeDetails` payload that is explicitly allowed to leave the
 * process. Anything not in `safeDetails` stays in the logs — organisational
 * security data must not leak through error messages.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'TENANT_MISMATCH'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RATE_LIMITED'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'RULESET_NOT_FOUND'
  | 'EVIDENCE_UNAVAILABLE'
  | 'INTEGRATION_ERROR'
  | 'VERIFICATION_FAILED'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR'
  | 'DEPENDENCY_UNAVAILABLE';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  TENANT_MISMATCH: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  POLICY_DENIED: 403,
  APPROVAL_REQUIRED: 409,
  RULESET_NOT_FOUND: 404,
  EVIDENCE_UNAVAILABLE: 422,
  INTEGRATION_ERROR: 502,
  VERIFICATION_FAILED: 422,
  NOT_IMPLEMENTED: 501,
  INTERNAL_ERROR: 500,
  DEPENDENCY_UNAVAILABLE: 503,
};

export interface AdericelErrorOptions {
  readonly safeDetails?: Record<string, unknown>;
  readonly cause?: unknown;
  /** Set when the caller may usefully retry the same request. */
  readonly retryable?: boolean;
}

export class AdericelError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly safeDetails: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: AdericelErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AdericelError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.safeDetails = options.safeDetails ?? {};
    this.retryable =
      options.retryable ?? (code === 'DEPENDENCY_UNAVAILABLE' || code === 'RATE_LIMITED');
  }
}

export const validationFailed = (message: string, details?: Record<string, unknown>) =>
  new AdericelError('VALIDATION_FAILED', message, { safeDetails: details });

export const unauthenticated = (message = 'Authentication required') =>
  new AdericelError('UNAUTHENTICATED', message);

export const forbidden = (message: string, details?: Record<string, unknown>) =>
  new AdericelError('FORBIDDEN', message, { safeDetails: details });

export const tenantMismatch = (message = 'Resource does not belong to the active organisation') =>
  new AdericelError('TENANT_MISMATCH', message);

export const notFound = (resource: string, id?: string) =>
  new AdericelError('NOT_FOUND', `${resource} not found`, {
    safeDetails: id ? { resource, id } : { resource },
  });

export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AdericelError('CONFLICT', message, { safeDetails: details });

export const policyDenied = (message: string, details?: Record<string, unknown>) =>
  new AdericelError('POLICY_DENIED', message, { safeDetails: details });

export const internalError = (message: string, cause?: unknown) =>
  new AdericelError('INTERNAL_ERROR', message, { cause });

export function isAdericelError(value: unknown): value is AdericelError {
  return value instanceof AdericelError;
}

/** Wire format for API error responses. Stable across API versions. */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    correlationId?: string;
  };
}

export function toErrorBody(error: AdericelError, correlationId?: string): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(Object.keys(error.safeDetails).length > 0 ? { details: error.safeDetails } : {}),
      ...(correlationId ? { correlationId } : {}),
    },
  };
}
