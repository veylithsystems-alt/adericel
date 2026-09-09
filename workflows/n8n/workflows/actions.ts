import {
  WORKFLOW_IDS,
  adericelRequest,
  chain,
  codeNode,
  configurationNode,
  connect,
  executeSubWorkflow,
  ifNode,
  node,
  stickyNote,
  subWorkflowTrigger,
  workflow,
  type N8nWorkflow,
} from '../lib.js';

/**
 * Action proposal, approval, execution and verification.
 *
 * These are the workflows that touch customer systems, so they are the ones
 * where n8n is deliberately least clever. Every consequential decision is made
 * by Adericel — policy evaluation, approval requirements, idempotency,
 * verification outcome — and n8n orchestrates the sequence.
 *
 * There is no path in this export by which a workflow edit could cause a change
 * to be made in a customer's environment that Adericel's policy would refuse.
 */

export function actionProposalWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Action proposal\n\n' +
        'Proposes a remediation. **Nothing is dispatched by this workflow.**\n\n' +
        'Adericel evaluates policy on the proposal and returns the full decision — ' +
        'which rule matched, the effective autonomy level, how many approvals are ' +
        'needed. If policy denies it, the action ends here and the reason is ' +
        'recorded.',
      [-620, -200],
      [520, 300],
      3,
    ),
    subWorkflowTrigger(
      [0, 0],
      'Called with { organisationId, findingId, actionType, targetNodeId, targetExternalId, correlationId }.',
    ),
    configurationNode([220, 0]),
    codeNode(
      'Build the proposal',
      [440, 0],
      `/**
 * Assemble the proposal, including a stable idempotency key.
 *
 * The key is derived from what the action would do — its type, its target and
 * the finding behind it. Two workflows reacting to the same finding therefore
 * converge on one action instead of dispatching two changes to the same
 * customer system.
 */
const input = $input.first().json;
const crypto = require('crypto');

if (!input.actionType || !input.organisationId) {
  throw new Error('A proposal needs at least an organisationId and an actionType.');
}

const idempotencyKey =
  'act-' +
  crypto
    .createHash('sha256')
    .update(
      [
        input.organisationId,
        input.actionType,
        input.targetExternalId || input.targetNodeId || '',
        input.findingId || '',
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 40);

return [
  {
    json: {
      organisationId: input.organisationId,
      correlationId: input.correlationId || $execution.id,
      apiBaseUrl: $('Configuration').first().json.apiBaseUrl,
      idempotencyKey,
      proposal: {
        actionType: input.actionType,
        integrationId: input.integrationId || null,
        targetNodeId: input.targetNodeId || null,
        targetExternalId: input.targetExternalId || null,
        parameters: input.parameters || {},
        findingId: input.findingId || null,
        rationale:
          input.rationale ||
          'Proposed automatically by the Adericel remediation workflow in response to finding ' +
            (input.findingId || 'unknown') + '.',
        idempotencyKey,
      },
    },
  },
];`,
    ),
    adericelRequest('Propose to Adericel', [660, 0], {
      method: 'POST',
      url: '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/actions',
      body: '={{ JSON.stringify($json.proposal) }}',
      idempotencyKey: '={{ $json.idempotencyKey }}',
      notes:
        'Adericel evaluates policy synchronously and returns the decision. This call proposes; it ' +
        'never executes.',
    }),
    node(
      'What did policy decide?',
      'n8n-nodes-base.switch',
      3.2,
      {
        rules: {
          values: [
            {
              conditions: {
                options: { caseSensitive: true, typeValidation: 'loose', version: 2 },
                conditions: [
                  {
                    leftValue: '={{ $json.body.decision.outcome }}',
                    rightValue: 'ALLOW',
                    operator: { type: 'string', operation: 'equals' },
                  },
                ],
                combinator: 'and',
              },
              renameOutput: true,
              outputKey: 'autonomous',
            },
            {
              conditions: {
                options: { caseSensitive: true, typeValidation: 'loose', version: 2 },
                conditions: [
                  {
                    leftValue: '={{ $json.body.decision.outcome }}',
                    rightValue: 'REQUIRE_APPROVAL',
                    operator: { type: 'string', operation: 'equals' },
                  },
                ],
                combinator: 'and',
              },
              renameOutput: true,
              outputKey: 'needs-approval',
            },
          ],
        },
        options: { fallbackOutput: 'extra', renameFallbackOutput: 'denied' },
      },
      [900, 0],
    ),
    executeSubWorkflow('Execute now', [1160, -160], WORKFLOW_IDS.actionExecution),
    codeNode(
      'Await human approval',
      [1160, 0],
      `/**
 * The action is waiting on a person. Nothing further happens here.
 *
 * Adericel has already published ActionApprovalRequested, which the approval
 * workflow picks up. This branch exists so the proposal workflow ends in a
 * clearly described state rather than appearing to have done nothing.
 */
const response = $input.first().json.body || {};
return [
  {
    json: {
      actionId: response.action && response.action.id,
      state: response.action && response.action.state,
      requiredApprovals: response.decision && response.decision.requiredApprovals,
      reason: response.decision && response.decision.reason,
      outcome: 'awaiting-approval',
    },
  },
];`,
    ),
    codeNode(
      'Record the denial',
      [1160, 160],
      `/**
 * Policy refused. That is a legitimate, common outcome and it is reported.
 *
 * A denied action is not a failure of the workflow — it is the policy engine
 * doing its job. The reason is surfaced so an operator can decide whether the
 * policy is wrong or the proposal was.
 */
const response = $input.first().json.body || {};
const decision = response.decision || {};
const trigger = $('When called by another workflow').first().json;

return [
  {
    json: {
      organisationId: trigger.organisationId,
      correlationId: trigger.correlationId,
      severity: 'info',
      subject: 'Adericel: remediation denied by policy',
      message:
        'A remediation was proposed and refused by policy. ' + (decision.reason || '') +
        (decision.matchedRuleId ? ' (policy rule: ' + decision.matchedRuleId + ')' : '') +
        ' The finding remains open and is recorded for a person to address.',
      outcome: 'denied',
    },
  },
];`,
    ),
    executeSubWorkflow('Notify denial', [1400, 160], WORKFLOW_IDS.notifications),
  ];

  let connections = chain(
    'When called by another workflow',
    'Configuration',
    'Build the proposal',
    'Propose to Adericel',
    'What did policy decide?',
  );
  connections = connect(connections, 'What did policy decide?', 'Execute now', 0);
  connections = connect(connections, 'What did policy decide?', 'Await human approval', 1);
  connections = connect(connections, 'What did policy decide?', 'Record the denial', 2);
  connections = connect(connections, 'Record the denial', 'Notify denial');

  return workflow({
    id: WORKFLOW_IDS.actionProposal,
    name: 'Adericel — 09 Action proposal',
    description:
      'Proposes a remediation to Adericel, which evaluates policy and returns the decision. This ' +
      'workflow dispatches nothing itself.',
    nodes,
    connections,
    tags: ['adericel', 'actions'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

/**
 * Approval.
 *
 * Notifies the people who can approve, with enough context to decide. It
 * deliberately cannot approve anything: approval requires a signed-in human,
 * and the Adericel API refuses an approval presented by an API key.
 */
export function approvalWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Approval\n\n' +
        'This workflow **cannot approve anything**, by design.\n\n' +
        "The Adericel API refuses an approval presented by an API key or a " +
        'workflow, and refuses one from the person who proposed the action. ' +
        'Four-eyes control is meaningless if the system that proposed a change can ' +
        'also authorise it.\n\n' +
        'All this does is make sure a human knows there is a decision waiting, and ' +
        'give them what they need to make it.',
      [-620, -240],
      [560, 340],
      3,
    ),
    subWorkflowTrigger([0, 0], 'Invoked on ActionApprovalRequested.'),
    configurationNode([220, 0]),
    adericelRequest('Read the action', [440, 0], {
      url:
        '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/actions/{{ $json.subjectId }}',
    }),
    codeNode(
      'Compose the request',
      [660, 0],
      `/**
 * Give the approver what they need to decide, not just a link.
 *
 * The policy decision is included in full — which rule matched, the effective
 * autonomy level, the checks that ran — because an approver asked to authorise
 * a change to a customer's environment deserves to see why the system thinks it
 * is permissible.
 */
const action = $input.first().json.body || {};
const event = $('When called by another workflow').first().json;
const decision = action.policyDecision || {};
const checks = (decision.evaluation || [])
  .map((check) => '  - ' + check.check + ': ' + check.detail)
  .join('\\n');

const message =
  'Adericel is asking permission to make a change in a customer environment.\\n\\n' +
  'Action: ' + action.actionType + '\\n' +
  'Target: ' + (action.target || 'not specified') + '\\n' +
  'Risk class: ' + action.riskClass + '\\n' +
  'Effective autonomy: L' + (action.autonomyLevel != null ? action.autonomyLevel : '?') + '\\n\\n' +
  'Why it is proposed:\\n' + (action.rationale || 'No rationale recorded.') + '\\n\\n' +
  'What policy decided:\\n' + (decision.reason || 'No decision recorded.') + '\\n' +
  (checks ? checks + '\\n' : '') +
  '\\nNothing has been dispatched. It will not run until a person other than the proposer approves it' +
  (event.payload && event.payload.expiresAt
    ? ', and the request expires at ' + event.payload.expiresAt + '.'
    : '.');

return [
  {
    json: {
      organisationId: event.organisationId,
      correlationId: event.correlationId,
      actionId: action.id,
      severity: action.riskClass === 'DISRUPTIVE' || action.riskClass === 'DESTRUCTIVE' ? 'urgent' : 'attention',
      subject: 'Adericel needs approval: ' + action.actionType,
      message,
      requiresHumanDecision: true,
    },
  },
];`,
    ),
    executeSubWorkflow('Notify approvers', [900, 0], WORKFLOW_IDS.notifications),
    node(
      'Awaiting a person',
      'n8n-nodes-base.noOp',
      1,
      {},
      [1140, 0],
      {
        notes:
          'The workflow ends here. Approval happens in the Adericel interface, by a person, and is ' +
          'recorded against their identity in the audit trail.',
      },
    ),
  ];

  const connections = chain(
    'When called by another workflow',
    'Configuration',
    'Read the action',
    'Compose the request',
    'Notify approvers',
    'Awaiting a person',
  );

  return workflow({
    id: WORKFLOW_IDS.approval,
    name: 'Adericel — 10 Approval request',
    description:
      'Notifies approvers that a decision is waiting, with the full policy decision. Cannot itself ' +
      'approve anything.',
    nodes,
    connections,
    tags: ['adericel', 'actions', 'four-eyes'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

/**
 * Action execution.
 *
 * Dispatches an action Adericel has already authorised. The API enforces the
 * state machine, so an action that has not been approved cannot be executed
 * from here no matter what this workflow does.
 */
export function actionExecutionWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Action execution\n\n' +
        'Dispatches an action Adericel has **already authorised**.\n\n' +
        'The API enforces the state machine: an action that is not AUTHORISED is ' +
        'refused with 412, whatever this workflow asks for. Execution is also ' +
        'exactly-once — the attempt is recorded before dispatch, so an n8n retry ' +
        'finds the prior attempt instead of repeating the change.\n\n' +
        '**Executed is not successful.** The action moves to VERIFYING and only ' +
        'reaches CONFIRMED once re-observation supports it.',
      [-620, -240],
      [560, 340],
      3,
    ),
    subWorkflowTrigger([0, 0], 'Invoked on ActionApproved, or directly after an autonomous ALLOW.'),
    configurationNode([220, 0]),
    codeNode(
      'Resolve the action',
      [440, 0],
      `/**
 * Work out which action to execute, whichever path called us.
 *
 * This workflow is reached either from an ActionApproved event or directly from
 * the proposal workflow when policy authorised the action outright, and those
 * two shapes differ.
 */
const input = $input.first().json;

const actionId =
  input.subjectId ||
  input.actionId ||
  (input.body && input.body.action && input.body.action.id);

const organisationId = input.organisationId || (input.body && input.body.organisationId);

if (!actionId || !organisationId) {
  throw new Error('Cannot determine which action to execute; refusing to guess.');
}

return [
  {
    json: {
      actionId,
      organisationId,
      correlationId: input.correlationId || $execution.id,
      apiBaseUrl: $('Configuration').first().json.apiBaseUrl,
    },
  },
];`,
    ),
    adericelRequest('Execute', [660, 0], {
      method: 'POST',
      url:
        '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/actions/{{ $json.actionId }}/execute',
      retry: false,
      notes:
        'Deliberately NOT retried at the node level. Adericel makes execution exactly-once, and an ' +
        'attempt whose outcome is unknown must be reconciled by a person rather than repeated.',
    }),
    node(
      'How did it go?',
      'n8n-nodes-base.switch',
      3.2,
      {
        rules: {
          values: [
            {
              conditions: {
                options: { caseSensitive: true, typeValidation: 'loose', version: 2 },
                conditions: [
                  {
                    leftValue: '={{ $json.body.executionStatus }}',
                    rightValue: 'SUCCEEDED',
                    operator: { type: 'string', operation: 'equals' },
                  },
                ],
                combinator: 'and',
              },
              renameOutput: true,
              outputKey: 'succeeded',
            },
            {
              conditions: {
                options: { caseSensitive: true, typeValidation: 'loose', version: 2 },
                conditions: [
                  {
                    leftValue: '={{ $json.statusCode }}',
                    rightValue: 409,
                    operator: { type: 'number', operation: 'equals' },
                  },
                ],
                combinator: 'and',
              },
              renameOutput: true,
              outputKey: 'needs-reconciliation',
            },
          ],
        },
        options: { fallbackOutput: 'extra', renameFallbackOutput: 'failed' },
      },
      [900, 0],
    ),
    node(
      'Settle before verifying',
      'n8n-nodes-base.wait',
      1.1,
      { amount: 30, unit: 'seconds' },
      [1160, -160],
      {
        notes:
          'External systems are eventually consistent. Verifying immediately would frequently ' +
          'report INCONCLUSIVE for a change that did in fact take effect.',
      },
    ),
    executeSubWorkflow('Verify', [1400, -160], WORKFLOW_IDS.verification),
    codeNode(
      'Escalate for reconciliation',
      [1160, 0],
      `/**
 * A previous attempt had an unknown outcome.
 *
 * This is the most dangerous state in the whole system: Adericel dispatched
 * something and never learned whether it took effect. Retrying could duplicate
 * a change in a customer's environment, so it is escalated to a person instead
 * of being resolved automatically.
 */
const input = $input.first().json;
const resolved = $('Resolve the action').first().json;

return [
  {
    json: {
      organisationId: resolved.organisationId,
      correlationId: resolved.correlationId,
      severity: 'urgent',
      subject: 'Adericel: an action needs manual reconciliation',
      message:
        'Action ' + resolved.actionId + ' has a previous execution attempt whose outcome is ' +
        'unknown. Adericel will not retry it, because a retry could duplicate a change in the ' +
        "customer's environment.\\n\\n" +
        'Check the target system to determine whether the change took effect, then resolve the ' +
        'action in Adericel.\\n\\n' +
        'API response: ' + JSON.stringify(input.body || {}),
    },
  },
];`,
    ),
    codeNode(
      'Report the failure',
      [1160, 180],
      `/**
 * The action failed outright. That is a clean outcome: nothing changed.
 */
const input = $input.first().json;
const resolved = $('Resolve the action').first().json;
const body = input.body || {};

return [
  {
    json: {
      organisationId: resolved.organisationId,
      correlationId: resolved.correlationId,
      severity: 'attention',
      subject: 'Adericel: remediation failed',
      message:
        'Action ' + resolved.actionId + ' did not complete. ' +
        (body.detail || 'No detail was returned.') +
        '\\n\\nThe finding remains open and the customer environment is unchanged.',
    },
  },
];`,
    ),
    executeSubWorkflow('Notify', [1400, 90], WORKFLOW_IDS.notifications),
  ];

  let connections = chain(
    'When called by another workflow',
    'Configuration',
    'Resolve the action',
    'Execute',
    'How did it go?',
  );
  connections = connect(connections, 'How did it go?', 'Settle before verifying', 0);
  connections = connect(connections, 'How did it go?', 'Escalate for reconciliation', 1);
  connections = connect(connections, 'How did it go?', 'Report the failure', 2);
  connections = connect(connections, 'Settle before verifying', 'Verify');
  connections = connect(connections, 'Escalate for reconciliation', 'Notify');
  connections = connect(connections, 'Report the failure', 'Notify');

  return workflow({
    id: WORKFLOW_IDS.actionExecution,
    name: 'Adericel — 11 Action execution',
    description:
      'Dispatches an authorised action exactly once, then hands over to verification. Escalates an ' +
      'unknown outcome to a person rather than retrying it.',
    nodes,
    connections,
    tags: ['adericel', 'actions'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

/**
 * Verification.
 *
 * Asks Adericel to re-observe the external system and decide whether the change
 * actually took effect. An inconclusive result leaves the action UNVERIFIED,
 * which is a real outcome and never quietly upgraded to success.
 */
export function verificationWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Verification\n\n' +
        '**An action being issued is not the desired state being achieved.**\n\n' +
        'Adericel re-collects from the source and compares what it now observes ' +
        'against what the action was supposed to achieve. Three outcomes:\n\n' +
        '- `CONFIRMED` — re-observation supports it\n' +
        '- `REFUTED` — the change did not take effect; rollback is required\n' +
        '- `INCONCLUSIVE` — cannot tell. The action stays **UNVERIFIED**, and is ' +
        'never reported as successful.',
      [-620, -240],
      [560, 340],
      3,
    ),
    subWorkflowTrigger([0, 0], 'Invoked on VerificationRequested, or after execution.'),
    configurationNode([220, 0]),
    codeNode(
      'Resolve the action',
      [440, 0],
      `const input = $input.first().json;
const actionId =
  input.subjectId || input.actionId || (input.body && input.body.actionId);
const organisationId = input.organisationId;

if (!actionId || !organisationId) {
  throw new Error('Cannot determine which action to verify; refusing to guess.');
}

return [
  {
    json: {
      actionId,
      organisationId,
      correlationId: input.correlationId || $execution.id,
      apiBaseUrl: $('Configuration').first().json.apiBaseUrl,
    },
  },
];`,
    ),
    adericelRequest('Verify', [660, 0], {
      method: 'POST',
      url:
        '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/actions/{{ $json.actionId }}/verify',
      notes:
        'Adericel re-collects from the integration rather than accepting the executor own report. ' +
        'A verification that trusted the execution would prove nothing.',
    }),
    node(
      'What did verification find?',
      'n8n-nodes-base.switch',
      3.2,
      {
        rules: {
          values: [
            {
              conditions: {
                options: { caseSensitive: true, typeValidation: 'loose', version: 2 },
                conditions: [
                  {
                    leftValue: '={{ $json.body.outcome }}',
                    rightValue: 'CONFIRMED',
                    operator: { type: 'string', operation: 'equals' },
                  },
                ],
                combinator: 'and',
              },
              renameOutput: true,
              outputKey: 'confirmed',
            },
            {
              conditions: {
                options: { caseSensitive: true, typeValidation: 'loose', version: 2 },
                conditions: [
                  {
                    leftValue: '={{ $json.body.outcome }}',
                    rightValue: 'REFUTED',
                    operator: { type: 'string', operation: 'equals' },
                  },
                ],
                combinator: 'and',
              },
              renameOutput: true,
              outputKey: 'refuted',
            },
          ],
        },
        options: { fallbackOutput: 'extra', renameFallbackOutput: 'inconclusive' },
      },
      [900, 0],
    ),
    executeSubWorkflow('Reassess', [1160, -180], WORKFLOW_IDS.assessment),
    codeNode(
      'Report refutation',
      [1160, 20],
      `/**
 * The change did not take effect, despite the execution reporting success.
 *
 * This is exactly why verification exists. Reporting the execution as
 * successful here would have left the customer with an unfixed problem that
 * Adericel believed was fixed — which is worse than never having tried.
 */
const body = $input.first().json.body || {};
const resolved = $('Resolve the action').first().json;

return [
  {
    json: {
      organisationId: resolved.organisationId,
      correlationId: resolved.correlationId,
      severity: 'urgent',
      subject: 'Adericel: a remediation did not take effect',
      message:
        'Action ' + resolved.actionId + ' reported success, but re-observing the source shows the ' +
        'intended change is not in place.\\n\\n' + (body.detail || '') +
        '\\n\\nThe action is marked for rollback and the finding remains open. Do not assume the ' +
        'problem is fixed.',
    },
  },
];`,
    ),
    codeNode(
      'Report inconclusive',
      [1160, 220],
      `/**
 * Adericel cannot tell whether the change took effect.
 *
 * The action stays UNVERIFIED. It is not recorded as successful, and the
 * control it was meant to fix will report on the evidence actually available —
 * which may well still be UNKNOWN.
 */
const body = $input.first().json.body || {};
const resolved = $('Resolve the action').first().json;

return [
  {
    json: {
      organisationId: resolved.organisationId,
      correlationId: resolved.correlationId,
      severity: 'attention',
      subject: 'Adericel: a remediation could not be verified',
      message:
        'Action ' + resolved.actionId + ' was dispatched but Adericel cannot confirm it achieved ' +
        'the intended state.\\n\\n' + (body.detail || '') +
        '\\n\\nThe action is recorded as UNVERIFIED — not as successful. Check the target system ' +
        'directly, or restore collection so Adericel can see it.',
    },
  },
];`,
    ),
    executeSubWorkflow('Notify', [1400, 120], WORKFLOW_IDS.notifications),
  ];

  let connections = chain(
    'When called by another workflow',
    'Configuration',
    'Resolve the action',
    'Verify',
    'What did verification find?',
  );
  connections = connect(connections, 'What did verification find?', 'Reassess', 0);
  connections = connect(connections, 'What did verification find?', 'Report refutation', 1);
  connections = connect(connections, 'What did verification find?', 'Report inconclusive', 2);
  connections = connect(connections, 'Report refutation', 'Notify');
  connections = connect(connections, 'Report inconclusive', 'Notify');

  return workflow({
    id: WORKFLOW_IDS.verification,
    name: 'Adericel — 12 Verification',
    description:
      'Asks Adericel to re-observe the external system and reports honestly when a change cannot ' +
      'be confirmed.',
    nodes,
    connections,
    tags: ['adericel', 'actions', 'verification'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}
