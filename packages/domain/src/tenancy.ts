import { z } from 'zod';

/**
 * MSP and organisation model.
 *
 * An MSP is an *operator* boundary: it describes who may act.
 * An organisation is a *data* boundary: it describes what data belongs together.
 * These are deliberately different concepts — an MSP never becomes a container
 * for customer data, only a holder of authority over it.
 */
export const MSP_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type MspStatus = (typeof MSP_STATUSES)[number];

export interface MspRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: MspStatus;
  readonly contactEmail: string;
  readonly countryCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const ORGANISATION_STATUSES = [
  'ONBOARDING',
  'ACTIVE',
  'SUSPENDED',
  'OFFBOARDING',
  'CLOSED',
] as const;
export type OrganisationStatus = (typeof ORGANISATION_STATUSES)[number];
export const organisationStatusSchema = z.enum(ORGANISATION_STATUSES);

export interface OrganisationRecord {
  readonly id: string;
  /** Null for a direct (non-MSP) customer. */
  readonly mspId: string | null;
  readonly name: string;
  readonly slug: string;
  readonly status: OrganisationStatus;
  readonly countryCode: string | null;
  readonly industry: string | null;
  readonly sizeBand: string | null;
  readonly settings: OrganisationSettings;
  readonly onboardedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const organisationSettingsSchema = z.object({
  /** Default autonomy ceiling for this organisation. */
  defaultAutonomyLevel: z.number().int().min(0).max(5).default(1),
  /** Timezone used for scheduled reassessment and reporting windows. */
  timezone: z.string().default('Europe/London'),
  /** Days after which unassessed subjects are escalated as critical unknowns. */
  unknownEscalationDays: z.number().int().positive().default(14),
  /** Whether MSP staff may access this organisation without per-session elevation. */
  requireDelegationElevation: z.boolean().default(false),
  /** Retention for raw observations, in days. Evidence retention is separate. */
  observationRetentionDays: z.number().int().positive().default(180),
  evidenceRetentionDays: z.number().int().positive().default(2555),
  notificationEmails: z.array(z.string().email()).default([]),
});

export type OrganisationSettings = z.infer<typeof organisationSettingsSchema>;

export const organisationCreateSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Slug must be lowercase alphanumeric with hyphens')
    .optional(),
  countryCode: z.string().length(2).nullable().optional(),
  industry: z.string().max(120).nullable().optional(),
  sizeBand: z.enum(['1-9', '10-49', '50-249', '250-999', '1000+']).nullable().optional(),
  settings: organisationSettingsSchema.partial().optional(),
  /** Framework keys to enable during onboarding, e.g. ["cyber-essentials"]. */
  frameworks: z.array(z.string().min(1)).default([]),
  /** Apply the MSP's baseline policy at creation. */
  applyMspBaseline: z.boolean().default(true),
});

export type OrganisationCreateInput = z.infer<typeof organisationCreateSchema>;

/**
 * MSP baseline policy inheritance.
 *
 * An MSP defines a baseline; each organisation resolves to an effective
 * configuration. The resolution is explicit about provenance so an MSP can
 * always answer "why does this customer differ from our standard?".
 */
export const INHERITANCE_MODES = [
  'INHERITED',
  'LOCAL',
  'OVERRIDDEN',
  'EXCEPTION',
  'PROHIBITED',
  'UNKNOWN',
] as const;
export type InheritanceMode = (typeof INHERITANCE_MODES)[number];
export const inheritanceModeSchema = z.enum(INHERITANCE_MODES);

export interface BaselineControlDefinition {
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly rulesetKey: string;
  readonly ruleKey: string;
  readonly parameters: Record<string, unknown>;
  readonly requirementKeys: readonly string[];
  /** When true an organisation may not override or disable this control. */
  readonly mandatory: boolean;
}

export interface ResolvedControlConfiguration {
  readonly key: string;
  readonly mode: InheritanceMode;
  readonly title: string;
  readonly rulesetKey: string;
  readonly ruleKey: string;
  readonly parameters: Record<string, unknown>;
  readonly enabled: boolean;
  readonly sourceBaselineKey: string | null;
  readonly overrideReason: string | null;
}

export interface OrganisationControlOverride {
  readonly key: string;
  readonly enabled?: boolean;
  readonly parameters?: Record<string, unknown>;
  readonly reason?: string;
}

/**
 * Resolve an organisation's effective control configuration from the MSP
 * baseline plus local overrides.
 *
 * A mandatory baseline control cannot be disabled or reparameterised locally;
 * the attempt is recorded as PROHIBITED and the baseline value stands, so an
 * MSP's assurance floor cannot be quietly removed by a customer administrator.
 */
export function resolveControlConfiguration(
  baseline: readonly BaselineControlDefinition[],
  overrides: readonly OrganisationControlOverride[],
  localControls: readonly BaselineControlDefinition[] = [],
): readonly ResolvedControlConfiguration[] {
  const overrideByKey = new Map(overrides.map((o) => [o.key, o]));
  const resolved: ResolvedControlConfiguration[] = [];

  for (const control of baseline) {
    const override = overrideByKey.get(control.key);
    if (!override) {
      resolved.push({
        key: control.key,
        mode: 'INHERITED',
        title: control.title,
        rulesetKey: control.rulesetKey,
        ruleKey: control.ruleKey,
        parameters: control.parameters,
        enabled: true,
        sourceBaselineKey: control.key,
        overrideReason: null,
      });
      continue;
    }

    if (control.mandatory) {
      resolved.push({
        key: control.key,
        mode: 'PROHIBITED',
        title: control.title,
        rulesetKey: control.rulesetKey,
        ruleKey: control.ruleKey,
        parameters: control.parameters,
        enabled: true,
        sourceBaselineKey: control.key,
        overrideReason: 'Override rejected: control is mandatory in the MSP baseline',
      });
      continue;
    }

    resolved.push({
      key: control.key,
      mode: 'OVERRIDDEN',
      title: control.title,
      rulesetKey: control.rulesetKey,
      ruleKey: control.ruleKey,
      parameters: { ...control.parameters, ...(override.parameters ?? {}) },
      enabled: override.enabled ?? true,
      sourceBaselineKey: control.key,
      overrideReason: override.reason ?? null,
    });
  }

  const baselineKeys = new Set(baseline.map((c) => c.key));
  for (const control of localControls) {
    if (baselineKeys.has(control.key)) continue;
    resolved.push({
      key: control.key,
      mode: 'LOCAL',
      title: control.title,
      rulesetKey: control.rulesetKey,
      ruleKey: control.ruleKey,
      parameters: control.parameters,
      enabled: true,
      sourceBaselineKey: null,
      overrideReason: null,
    });
  }

  return resolved;
}
