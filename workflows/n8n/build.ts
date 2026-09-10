#!/usr/bin/env tsx
/**
 * Build the single importable n8n export.
 *
 * Produces `workflows/n8n/adericel.n8n.json`: one JSON array of workflow
 * objects, which is exactly what `n8n export:workflow --all` emits and what
 * `n8n import:workflow --input=<file>` consumes.
 *
 * The export is generated rather than hand-maintained. A few thousand lines of
 * hand-written JSON cannot be reviewed properly and drifts from the API it
 * calls; a builder is type-checked, and `validate.ts` asserts structural
 * invariants over the result before it is committed.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resetNodeCounter, type N8nWorkflow } from './lib.js';
import { eventIntakeWorkflow, onboardingWorkflow } from './workflows/intake.js';
import {
  documentProcessingWorkflow,
  evidenceIngestionWorkflow,
  observationNormalisationWorkflow,
} from './workflows/evidence.js';
import {
  assessmentWorkflow,
  assuranceChangeWorkflow,
  findingTriageWorkflow,
} from './workflows/assurance.js';
import {
  actionExecutionWorkflow,
  actionProposalWorkflow,
  approvalWorkflow,
  verificationWorkflow,
} from './workflows/actions.js';
import {
  deadLetterRecoveryWorkflow,
  errorHandlerWorkflow,
  evidenceExpiryWorkflow,
  healthMonitorWorkflow,
  notificationsWorkflow,
  reportingWorkflow,
  scheduledCollectionWorkflow,
  scheduledReassessmentWorkflow,
} from './workflows/operations.js';
import {
  coverageWatchWorkflow,
  offboardingWorkflow,
  retentionWatchWorkflow,
  sourceConflictWorkflow,
} from './workflows/lifecycle.js';

export const OUTPUT_PATH = fileURLToPath(new URL('./adericel.n8n.json', import.meta.url));

/**
 * The complete workflow system.
 *
 * Ordering matters for the import: n8n resolves Execute Workflow references by
 * id, and importing leaves is friendlier when a run is interrupted part way.
 * The numbering in each workflow's name is the reading order for a human
 * opening the instance for the first time.
 */
export function buildAllWorkflows(): N8nWorkflow[] {
  resetNodeCounter();
  return [
    // Leaves first: nothing depends on these.
    notificationsWorkflow(),
    errorHandlerWorkflow(),

    // Core assurance operations.
    assessmentWorkflow(),
    assuranceChangeWorkflow(),
    findingTriageWorkflow(),

    // The controlled-autonomy chain.
    actionProposalWorkflow(),
    approvalWorkflow(),
    actionExecutionWorkflow(),
    verificationWorkflow(),

    // Evidence in.
    evidenceIngestionWorkflow(),
    documentProcessingWorkflow(),
    observationNormalisationWorkflow(),

    // Lifecycle and scheduled operations.
    onboardingWorkflow(),
    scheduledCollectionWorkflow(),
    scheduledReassessmentWorkflow(),
    evidenceExpiryWorkflow(),
    reportingWorkflow(),

    // Platform operations.
    healthMonitorWorkflow(),
    deadLetterRecoveryWorkflow(),
    offboardingWorkflow(),
    sourceConflictWorkflow(),
    coverageWatchWorkflow(),
    retentionWatchWorkflow(),

    // Intake last: it references every handler above.
    eventIntakeWorkflow(),
  ];
}

async function main(): Promise<void> {
  const workflows = buildAllWorkflows();
  const json = `${JSON.stringify(workflows, null, 2)}\n`;
  await writeFile(OUTPUT_PATH, json, 'utf8');

  const nodeCount = workflows.reduce((total, wf) => total + wf.nodes.length, 0);
  const activeCount = workflows.filter((wf) => wf.active).length;

  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`  ${workflows.length} workflows, ${nodeCount} nodes`);
  console.log(`  ${activeCount} activate on import (webhooks, schedules, error handler)`);
  console.log(`  ${(json.length / 1024).toFixed(0)} KB`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
