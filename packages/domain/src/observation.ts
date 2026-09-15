import { z } from 'zod';

/**
 * An observation is a raw, normalised fact reported by a source about the
 * organisation's environment. It is upstream of evidence: observations are what
 * a connector saw; evidence is an observation that has been given provenance,
 * validity and integrity metadata and is fit to support a claim.
 */
export const OBSERVATION_KINDS = [
  'IDENTITY_STATE',
  'DEVICE_STATE',
  'APPLICATION_STATE',
  'CLOUD_RESOURCE_STATE',
  'CONFIGURATION_SETTING',
  'VULNERABILITY',
  'PATCH_STATE',
  'BACKUP_STATE',
  'ACCESS_GRANT',
  'POLICY_DOCUMENT',
  'INCIDENT',
  'TRAINING_RECORD',
  'SUPPLIER_ATTESTATION',
  'LOG_EVENT',
] as const;

export type ObservationKind = (typeof OBSERVATION_KINDS)[number];
export const observationKindSchema = z.enum(OBSERVATION_KINDS);

export interface ObservationRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly integrationId: string | null;
  readonly kind: ObservationKind;
  readonly sourceSystem: string;
  readonly subjectExternalId: string | null;
  readonly subjectNodeId: string | null;
  /** Normalised, connector-independent representation of what was seen. */
  readonly payload: Record<string, unknown>;
  readonly payloadHash: string;
  readonly observedAt: string | null;
  readonly collectedAt: string;
  readonly createdAt: string;
  readonly correlationId: string | null;
  readonly evidenceId: string | null;
}

export const observationInputSchema = z.object({
  kind: observationKindSchema,
  sourceSystem: z.string().min(1).max(200),
  subjectExternalId: z.string().max(512).nullable().optional(),
  subjectNodeId: z.string().uuid().nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
  observedAt: z.string().datetime().nullable().optional(),
  collectedAt: z.string().datetime().optional(),
});

export type ObservationInput = z.infer<typeof observationInputSchema>;

export const observationBatchSchema = z.object({
  integrationId: z.string().uuid().nullable().optional(),
  observations: z.array(observationInputSchema).min(1).max(1000),
});

export type ObservationBatch = z.infer<typeof observationBatchSchema>;
