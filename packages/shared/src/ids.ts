import { randomUUID, randomBytes } from 'node:crypto';

/**
 * Branded identifier types. These exist so that a Organisation id can never be
 * silently passed where an Evidence id is expected — a class of bug that is
 * extremely dangerous in a multi-tenant assurance system.
 */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrganisationId = Brand<string, 'OrganisationId'>;
export type MspId = Brand<string, 'MspId'>;
export type UserId = Brand<string, 'UserId'>;
export type NodeId = Brand<string, 'NodeId'>;
export type EdgeId = Brand<string, 'EdgeId'>;
export type EvidenceId = Brand<string, 'EvidenceId'>;
export type ObservationId = Brand<string, 'ObservationId'>;
export type ClaimId = Brand<string, 'ClaimId'>;
export type AssessmentId = Brand<string, 'AssessmentId'>;
export type FindingId = Brand<string, 'FindingId'>;
export type RiskId = Brand<string, 'RiskId'>;
export type ActionId = Brand<string, 'ActionId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type VerificationId = Brand<string, 'VerificationId'>;
export type IntegrationId = Brand<string, 'IntegrationId'>;
export type EventId = Brand<string, 'EventId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;
export type ExceptionId = Brand<string, 'ExceptionId'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Generate a new random (v4) identifier. */
export function newId<T extends string = string>(): Brand<string, T> {
  return randomUUID() as Brand<string, T>;
}

/**
 * Cast a validated string into a branded id. Throws when the value is not a
 * UUID, so malformed identifiers cannot enter the domain layer.
 */
export function asId<T extends string>(value: string, label = 'id'): Brand<string, T> {
  if (!isUuid(value)) {
    throw new TypeError(`Invalid ${label}: expected a UUID, received ${JSON.stringify(value)}`);
  }
  return value as Brand<string, T>;
}

/** Correlation ids follow requests across API, worker, n8n and external systems. */
export function newCorrelationId(): CorrelationId {
  return randomUUID() as CorrelationId;
}

/** URL-safe opaque token, used for API keys and single-use secrets. */
export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
