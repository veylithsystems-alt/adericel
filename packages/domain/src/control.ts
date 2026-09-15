import { z } from 'zod';

/**
 * Frameworks, requirements and controls.
 *
 * A framework (Cyber Essentials, ISO 27001, an MSP's own baseline) contains
 * requirements. Controls are the organisation's means of satisfying them. The
 * separation matters commercially: one control implementation can satisfy
 * requirements across several frameworks, which is where an MSP's leverage
 * comes from.
 */
export interface FrameworkRecord {
  readonly id: string;
  readonly organisationId: string | null;
  readonly mspId: string | null;
  readonly key: string;
  readonly name: string;
  readonly version: string;
  readonly publisher: string | null;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly createdAt: string;
}

export interface RequirementRecord {
  readonly id: string;
  readonly frameworkId: string;
  readonly organisationId: string | null;
  readonly nodeId: string | null;
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly parentRequirementId: string | null;
  readonly weight: number;
  readonly createdAt: string;
}

export const CONTROL_IMPLEMENTATION_TYPES = [
  'TECHNICAL',
  'ADMINISTRATIVE',
  'PHYSICAL',
  'CONTRACTUAL',
] as const;
export type ControlImplementationType = (typeof CONTROL_IMPLEMENTATION_TYPES)[number];

export const CONTROL_SOURCES = ['INHERITED', 'LOCAL', 'OVERRIDDEN'] as const;
export type ControlSource = (typeof CONTROL_SOURCES)[number];
export const controlSourceSchema = z.enum(CONTROL_SOURCES);

export interface ControlRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly nodeId: string;
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly implementationType: ControlImplementationType;
  /** Rule the Truth Engine runs to assess this control. */
  readonly rulesetKey: string;
  readonly ruleKey: string;
  readonly parameters: Record<string, unknown>;
  readonly source: ControlSource;
  /** Populated when this control derives from an MSP baseline. */
  readonly baselineControlId: string | null;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const controlInputSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Control key must be lowercase alphanumeric with . _ -'),
  title: z.string().min(1).max(300),
  description: z.string().max(4000).nullable().optional(),
  implementationType: z.enum(CONTROL_IMPLEMENTATION_TYPES).default('TECHNICAL'),
  rulesetKey: z.string().min(1).max(120),
  ruleKey: z.string().min(1).max(120),
  parameters: z.record(z.string(), z.unknown()).default({}),
  requirementIds: z.array(z.string().uuid()).default([]),
  enabled: z.boolean().default(true),
});

export type ControlInput = z.infer<typeof controlInputSchema>;

/** Mapping between a control and the requirement(s) it contributes to. */
export interface ControlRequirementMapping {
  readonly controlId: string;
  readonly requirementId: string;
  /** How much of the requirement this control covers, 0..1. */
  readonly coverage: number;
}
