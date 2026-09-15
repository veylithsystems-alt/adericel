import { z } from 'zod';

/**
 * Domain events.
 *
 * Events are the contract between the API, the worker and n8n. They are
 * published through a transactional outbox in the same database transaction as
 * the state change that produced them, so a published event always corresponds
 * to committed state — there is no window in which n8n reacts to something that
 * did not happen.
 */
export const EVENT_TYPES = [
  'MspCreated',
  'OrganisationCreated',
  'OrganisationUpdated',
  'OrganisationOnboardingCompleted',
  'IntegrationConnected',
  'IntegrationDisconnected',
  'IntegrationCollectionFailed',
  'ObservationReceived',
  'EvidenceCreated',
  'EvidenceUpdated',
  'EvidenceSuperseded',
  'EvidenceExpired',
  'EvidenceRevoked',
  'ClaimCreated',
  'ClaimChanged',
  'ClaimConfirmed',
  /**
   * Two sources disagreed and nothing resolved it, so the claim was withheld.
   * A first-class event because it is a change in what Adericel is prepared to
   * assert, and the controls resting on it have just become UNKNOWN.
   */
  'ClaimDisputed',
  'IntegrationCapabilityDegraded',
  'AssessmentRequested',
  'AssessmentCompleted',
  'AssuranceStateChanged',
  'FindingCreated',
  'FindingResolved',
  'RiskChanged',
  'ExceptionCreated',
  'ExceptionApproved',
  'ExceptionExpired',
  'ActionProposed',
  'ActionPolicyEvaluated',
  'ActionApprovalRequested',
  'ActionApproved',
  'ActionRejected',
  'ActionExecutionRequested',
  'ActionExecuted',
  'ActionFailed',
  'VerificationRequested',
  'VerificationCompleted',
  'ReportRequested',
  'ReportGenerated',
  // Billing changes what Adericel is doing for a customer, so it belongs in the
  // customer's own event stream rather than only in an operator's ledger.
  'SubscriptionChanged',
  'AssuranceMaintenanceStopped',
  'AssuranceMaintenanceResumed',
  'SystemHealthDegraded',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export const eventTypeSchema = z.enum(EVENT_TYPES);

/**
 * Envelope shared by every event. `schemaVersion` is per event type and is
 * incremented whenever the payload changes incompatibly; consumers (including
 * n8n) assert on it.
 */
export interface DomainEvent<TPayload = Record<string, unknown>> {
  readonly id: string;
  readonly type: EventType;
  readonly schemaVersion: number;
  readonly organisationId: string | null;
  readonly mspId: string | null;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly payload: TPayload;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly actor: string;
  readonly occurredAt: string;
}

export const EVENT_SCHEMA_VERSIONS: Readonly<Record<EventType, number>> = Object.fromEntries(
  EVENT_TYPES.map((type) => [type, 1]),
) as Record<EventType, number>;

export const domainEventSchema = z.object({
  id: z.string().uuid(),
  type: eventTypeSchema,
  schemaVersion: z.number().int().positive(),
  organisationId: z.string().uuid().nullable(),
  mspId: z.string().uuid().nullable(),
  subjectType: z.string().min(1),
  subjectId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid().nullable(),
  actor: z.string().min(1),
  occurredAt: z.string().datetime(),
});

export interface NewDomainEvent<TPayload = Record<string, unknown>> {
  readonly type: EventType;
  readonly organisationId: string | null;
  readonly mspId?: string | null;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly payload: TPayload;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly actor: string;
}

/**
 * Delivery state of an outbox record. Events that exhaust their attempts land
 * in DEAD_LETTER and are surfaced in system health — they are never silently
 * dropped, because a lost AssuranceStateChanged means the MSP dashboard is
 * quietly wrong.
 */
export const OUTBOX_STATES = ['PENDING', 'IN_FLIGHT', 'DELIVERED', 'DEAD_LETTER'] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export interface OutboxRecord extends DomainEvent {
  readonly state: OutboxState;
  readonly attempts: number;
  readonly availableAt: string;
  readonly lastError: string | null;
  readonly deliveredAt: string | null;
}

/** Audit entries record *who did what*; events record *what happened*. */
export interface AuditEntry {
  readonly id: string;
  readonly organisationId: string | null;
  readonly mspId: string | null;
  readonly actorType: string;
  readonly actorId: string;
  readonly actorDisplay: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  readonly reason: string | null;
  readonly requestId: string | null;
  readonly correlationId: string | null;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly metadata: Record<string, unknown>;
  readonly occurredAt: string;
}
