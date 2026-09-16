import { z } from 'zod';
import type { ContainmentLevel, ContainmentScope } from './level.js';

/**
 * What can put an estate into containment.
 *
 * Every trigger contract v3.1 §15 enumerates, each carrying the least
 * disruptive level that actually addresses it. The mapping is the interesting
 * part: containment that reaches further than the threat is itself a harm, and
 * an operator who has been over-contained once will hesitate the next time.
 */

export const CONTAINMENT_TRIGGERS = [
  'CREDENTIAL_COMPROMISE',
  'PRIVILEGE_ESCALATION',
  'SUSPECTED_TENANT_ISOLATION_FAILURE',
  'CROSS_TENANT_EXPOSURE',
  'INTEGRATION_SCOPE_ANOMALY',
  'OAUTH_PERMISSION_ANOMALY',
  'EVIDENCE_INTEGRITY_FAILURE',
  'UNSAFE_OR_UNAUTHORISED_ACTION',
  'RULESET_INTEGRITY_MISMATCH',
  'SECRET_EXPOSURE',
  'PRODUCTION_COMPROMISE',
  'SUPPLY_CHAIN_COMPROMISE',
  'CRITICAL_VULNERABILITY',
  'BACKUP_COMPROMISE',
  'UNAUTHORISED_EXPORT',
  'LEGAL_RESTRICTION_REQUIRED',
] as const;
export type ContainmentTrigger = (typeof CONTAINMENT_TRIGGERS)[number];
export const containmentTriggerSchema = z.enum(CONTAINMENT_TRIGGERS);

export interface TriggerProfile {
  readonly trigger: ContainmentTrigger;
  /** The least disruptive level that actually addresses this. */
  readonly minimumLevel: ContainmentLevel;
  /** What the threat reaches, which bounds what containment needs to reach. */
  readonly naturalScope: ContainmentScope;
  /**
   * Whether Adericel may act on this without a human.
   *
   * True only where the signal is unambiguous AND the response is cheap to
   * reverse. A false positive on an automatic trigger costs an operator an
   * outage they did not cause, so the bar is high and deliberately narrow.
   */
  readonly automaticEntryPermitted: boolean;
  /** What an operator needs to be told, in a sentence. */
  readonly meaning: string;
}

export const TRIGGER_PROFILES: Readonly<Record<ContainmentTrigger, TriggerProfile>> = {
  CREDENTIAL_COMPROMISE: {
    trigger: 'CREDENTIAL_COMPROMISE',
    minimumLevel: 'C2',
    naturalScope: 'INTEGRATION',
    // Unambiguous and cheap to reverse: stop using one credential. Waiting for
    // a human while a known-compromised token keeps working is the worse risk.
    automaticEntryPermitted: true,
    meaning: 'A stored credential is believed to be in someone else’s hands.',
  },
  PRIVILEGE_ESCALATION: {
    trigger: 'PRIVILEGE_ESCALATION',
    minimumLevel: 'C2',
    naturalScope: 'INTEGRATION',
    automaticEntryPermitted: true,
    meaning: 'An identity or integration gained authority nobody granted it.',
  },
  SUSPECTED_TENANT_ISOLATION_FAILURE: {
    trigger: 'SUSPECTED_TENANT_ISOLATION_FAILURE',
    minimumLevel: 'C4',
    naturalScope: 'PLATFORM',
    // Never automatic. The blast radius is every customer, and a false positive
    // takes the whole platform down. A human decides.
    automaticEntryPermitted: false,
    meaning: 'One tenant may be able to reach another tenant’s data.',
  },
  CROSS_TENANT_EXPOSURE: {
    trigger: 'CROSS_TENANT_EXPOSURE',
    minimumLevel: 'C4',
    naturalScope: 'PLATFORM',
    automaticEntryPermitted: false,
    meaning: 'Data from one organisation has been observed reaching another.',
  },
  INTEGRATION_SCOPE_ANOMALY: {
    trigger: 'INTEGRATION_SCOPE_ANOMALY',
    minimumLevel: 'C1',
    naturalScope: 'INTEGRATION',
    automaticEntryPermitted: true,
    meaning: 'A connector is reaching for data outside the scope it was given.',
  },
  OAUTH_PERMISSION_ANOMALY: {
    trigger: 'OAUTH_PERMISSION_ANOMALY',
    minimumLevel: 'C1',
    naturalScope: 'INTEGRATION',
    automaticEntryPermitted: true,
    meaning: 'The permissions granted to a connector changed without a request.',
  },
  EVIDENCE_INTEGRITY_FAILURE: {
    trigger: 'EVIDENCE_INTEGRITY_FAILURE',
    minimumLevel: 'C1',
    naturalScope: 'ORGANISATION',
    // Automation stops; observation continues. Adericel must not act on a
    // record it can no longer vouch for, but it must keep gathering the
    // evidence that will explain what happened.
    automaticEntryPermitted: true,
    meaning: 'Stored evidence no longer matches its recorded hash.',
  },
  UNSAFE_OR_UNAUTHORISED_ACTION: {
    trigger: 'UNSAFE_OR_UNAUTHORISED_ACTION',
    minimumLevel: 'C1',
    naturalScope: 'ORGANISATION',
    automaticEntryPermitted: true,
    meaning: 'An action ran that policy or authority did not permit.',
  },
  RULESET_INTEGRITY_MISMATCH: {
    trigger: 'RULESET_INTEGRITY_MISMATCH',
    minimumLevel: 'C1',
    naturalScope: 'PLATFORM',
    automaticEntryPermitted: true,
    meaning: 'A ruleset no longer hashes to the value it was published with.',
  },
  SECRET_EXPOSURE: {
    trigger: 'SECRET_EXPOSURE',
    minimumLevel: 'C2',
    naturalScope: 'INTEGRATION',
    automaticEntryPermitted: true,
    meaning: 'A secret has appeared somewhere it should never have been.',
  },
  PRODUCTION_COMPROMISE: {
    trigger: 'PRODUCTION_COMPROMISE',
    minimumLevel: 'C5',
    naturalScope: 'PLATFORM',
    automaticEntryPermitted: false,
    meaning: 'The platform itself is believed to be under someone else’s control.',
  },
  SUPPLY_CHAIN_COMPROMISE: {
    trigger: 'SUPPLY_CHAIN_COMPROMISE',
    minimumLevel: 'C5',
    naturalScope: 'PLATFORM',
    automaticEntryPermitted: false,
    meaning: 'A dependency Adericel ships is believed to be malicious.',
  },
  CRITICAL_VULNERABILITY: {
    trigger: 'CRITICAL_VULNERABILITY',
    minimumLevel: 'C1',
    naturalScope: 'PLATFORM',
    automaticEntryPermitted: false,
    meaning: 'A vulnerability exists that a patch has not yet closed.',
  },
  BACKUP_COMPROMISE: {
    trigger: 'BACKUP_COMPROMISE',
    minimumLevel: 'C1',
    naturalScope: 'PLATFORM',
    automaticEntryPermitted: false,
    meaning: 'A backup is believed altered, unreadable, or in the wrong hands.',
  },
  UNAUTHORISED_EXPORT: {
    trigger: 'UNAUTHORISED_EXPORT',
    minimumLevel: 'C3',
    naturalScope: 'ORGANISATION',
    // C3 restricts what a customer can do, so no automatic entry — see the
    // level definition. Detection raises it; a person applies it.
    automaticEntryPermitted: false,
    meaning: 'Data left the platform without authority to do so.',
  },
  LEGAL_RESTRICTION_REQUIRED: {
    trigger: 'LEGAL_RESTRICTION_REQUIRED',
    minimumLevel: 'C3',
    naturalScope: 'ORGANISATION',
    automaticEntryPermitted: false,
    meaning: 'A legal or regulatory instruction requires processing to stop.',
  },
};

export function profileOf(trigger: ContainmentTrigger): TriggerProfile {
  return TRIGGER_PROFILES[trigger];
}
