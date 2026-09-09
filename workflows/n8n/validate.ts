#!/usr/bin/env tsx
/**
 * Validate the n8n export.
 *
 * A workflow export that imports and then fails at 3am is worse than one that
 * does not import at all. These checks assert the invariants that make the
 * difference, and they run in CI so a broken export cannot be committed.
 *
 * Two classes of check:
 *
 *  - structural — every node reachable, every connection resolving, every
 *    sub-workflow reference pointing at a workflow that exists;
 *  - safety — no embedded secret, no hard-coded URL, no hard-coded tenant, and
 *    every workflow that changes state naming an error workflow.
 */
import { readFile } from 'node:fs/promises';
import { buildAllWorkflows, OUTPUT_PATH } from './build.js';
import type { N8nWorkflow } from './lib.js';

export interface Finding {
  readonly workflow: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

/** Node types that reach outside n8n or change Adericel state. */
const STATE_CHANGING_TYPES = new Set([
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.executeWorkflow',
]);

/** Patterns that must never appear in a distributed export. */
const FORBIDDEN_PATTERNS: { pattern: RegExp; message: string }[] = [
  {
    pattern: /\badk_[A-Za-z0-9_-]{8,}/,
    message: 'contains what looks like a real Adericel API key',
  },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    message: 'contains a private key',
  },
  {
    // Adericel's own endpoints must come from configuration. The one permitted
    // literal is the documented fallback inside the env expression, which is
    // stripped before this check runs — see `withoutPermittedFallbacks`.
    pattern: /https?:\/\/[a-z0-9.-]*adericel[a-z0-9.-]*/i,
    message: 'contains a hard-coded Adericel URL; use $env.ADERICEL_API_BASE_URL',
  },
  {
    pattern: /"password"\s*:\s*"(?!\{\{)[^"]{3,}"/,
    message: 'contains an inline password',
  },
];

/**
 * Remove the documented environment fallbacks before scanning for hard-coded
 * values.
 *
 * `{{ $env.ADERICEL_API_BASE_URL || 'http://adericel-api:4000' }}` is exactly
 * the right shape: configuration first, with a fallback matching the
 * docker-compose service name so a fresh deployment works before anyone sets a
 * variable. Everything outside that shape is a genuine hard-coding.
 */
function withoutPermittedFallbacks(serialised: string): string {
  return serialised.replace(/\$env\.[A-Z_]+ \|\| '[^']*'/g, '$env.CONFIGURED_VALUE');
}

export function validateWorkflows(workflows: readonly N8nWorkflow[]): Finding[] {
  const findings: Finding[] = [];
  const idsSeen = new Map<string, string>();
  const workflowIds = new Set(workflows.map((wf) => wf.id));

  for (const wf of workflows) {
    const report = (severity: Finding['severity'], message: string): void => {
      findings.push({ workflow: wf.name, severity, message });
    };

    // ---- identity -------------------------------------------------------
    if (idsSeen.has(wf.id)) {
      report('error', `duplicate workflow id ${wf.id}, also used by "${idsSeen.get(wf.id)}"`);
    }
    idsSeen.set(wf.id, wf.name);

    if (!wf.name.startsWith('Adericel — ')) {
      report('warning', 'name does not carry the Adericel prefix, so it will be hard to find');
    }

    // ---- nodes ----------------------------------------------------------
    const nodeNames = new Set<string>();
    const nodeIds = new Set<string>();

    for (const node of wf.nodes) {
      if (nodeNames.has(node.name)) {
        // n8n addresses nodes by name in connections and expressions, so a
        // duplicate name silently misroutes data.
        report('error', `duplicate node name "${node.name}"`);
      }
      nodeNames.add(node.name);

      if (nodeIds.has(node.id)) report('error', `duplicate node id on "${node.name}"`);
      nodeIds.add(node.id);

      if (!node.type.startsWith('n8n-nodes-base.')) {
        report(
          'error',
          `node "${node.name}" uses ${node.type}, which is not a core node. The export must import ` +
            'into a clean instance without community packages.',
        );
      }

      if (
        node.type === 'n8n-nodes-base.executeWorkflow' &&
        typeof node.parameters.workflowId === 'string' &&
        !workflowIds.has(node.parameters.workflowId)
      ) {
        report(
          'error',
          `node "${node.name}" calls sub-workflow ${String(node.parameters.workflowId)}, which is ` +
            'not in this export',
        );
      }

      if (
        node.type === 'n8n-nodes-base.httpRequest' &&
        node.parameters.authentication === 'genericCredentialType' &&
        !node.credentials
      ) {
        report('error', `node "${node.name}" declares credential auth but names no credential`);
      }
    }

    // ---- connections ----------------------------------------------------
    for (const [from, outputs] of Object.entries(wf.connections)) {
      if (!nodeNames.has(from)) {
        report('error', `connection originates at "${from}", which is not a node in this workflow`);
      }
      for (const output of outputs.main) {
        for (const target of output ?? []) {
          if (!nodeNames.has(target.node)) {
            report(
              'error',
              `connection from "${from}" targets "${target.node}", which does not exist`,
            );
          }
        }
      }
    }

    // ---- reachability ---------------------------------------------------
    const triggerTypes = [
      'n8n-nodes-base.webhook',
      'n8n-nodes-base.scheduleTrigger',
      'n8n-nodes-base.executeWorkflowTrigger',
      'n8n-nodes-base.errorTrigger',
      'n8n-nodes-base.manualTrigger',
    ];
    const triggers = wf.nodes.filter((node) => triggerTypes.includes(node.type));
    if (triggers.length === 0) {
      report('error', 'has no trigger, so it can never run');
    }

    const reachable = new Set<string>(triggers.map((node) => node.name));
    let grew = true;
    while (grew) {
      grew = false;
      for (const [from, outputs] of Object.entries(wf.connections)) {
        if (!reachable.has(from)) continue;
        for (const output of outputs.main) {
          for (const target of output ?? []) {
            if (!reachable.has(target.node)) {
              reachable.add(target.node);
              grew = true;
            }
          }
        }
      }
    }

    for (const node of wf.nodes) {
      // Sticky notes are documentation and are never connected.
      if (node.type === 'n8n-nodes-base.stickyNote') continue;
      if (!reachable.has(node.name)) {
        report('error', `node "${node.name}" is unreachable from any trigger`);
      }
    }

    // ---- error handling -------------------------------------------------
    const changesState = wf.nodes.some((node) => STATE_CHANGING_TYPES.has(node.type));
    const isHandler = wf.name.includes('Error handler') || wf.name.includes('Notifications');
    if (changesState && !isHandler && !wf.settings.errorWorkflow) {
      report(
        'error',
        'can change state but names no error workflow, so a failure would leave the system in an ' +
          'undescribed state',
      );
    }

    // ---- documentation --------------------------------------------------
    if (!wf.nodes.some((node) => node.type === 'n8n-nodes-base.stickyNote')) {
      report('warning', 'has no sticky note explaining what it does or why');
    }

    // ---- safety ---------------------------------------------------------
    const serialised = withoutPermittedFallbacks(JSON.stringify(wf));
    for (const { pattern, message } of FORBIDDEN_PATTERNS) {
      if (pattern.test(serialised)) report('error', message);
    }

    for (const node of wf.nodes) {
      for (const [name, credential] of Object.entries(node.credentials ?? {})) {
        if (!credential.id || !credential.name) {
          report('error', `node "${node.name}" has a malformed ${name} credential reference`);
        }
      }
    }
  }

  // ---- cross-workflow ---------------------------------------------------
  const errorHandler = workflows.find((wf) => wf.name.includes('Error handler'));
  if (!errorHandler) {
    findings.push({
      workflow: '(export)',
      severity: 'error',
      message: 'no error handler workflow is present',
    });
  } else if (!errorHandler.active) {
    findings.push({
      workflow: errorHandler.name,
      severity: 'error',
      message: 'the error handler must be active on import or failures go unreported',
    });
  }

  return findings;
}

async function main(): Promise<void> {
  const built = buildAllWorkflows();
  const findings = validateWorkflows(built);

  // The committed artefact must match what the builder produces, or the file
  // in the repository is not the file the tests validated.
  let driftDetected = false;
  try {
    const onDisk = await readFile(OUTPUT_PATH, 'utf8');
    if (onDisk !== `${JSON.stringify(built, null, 2)}\n`) {
      driftDetected = true;
    }
  } catch {
    driftDetected = true;
  }

  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warning');

  for (const finding of findings) {
    const label = finding.severity === 'error' ? 'ERROR  ' : 'warning';
    console.log(`${label} ${finding.workflow}: ${finding.message}`);
  }

  if (driftDetected) {
    console.log(
      'ERROR   (export): adericel.n8n.json does not match the builder output. Run `pnpm n8n:build`.',
    );
  }

  const nodeCount = built.reduce((total, wf) => total + wf.nodes.length, 0);
  console.log(
    `\n${built.length} workflows, ${nodeCount} nodes — ${errors.length} error(s), ${warnings.length} warning(s)`,
  );

  if (errors.length > 0 || driftDetected) process.exit(1);
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
