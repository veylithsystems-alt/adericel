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
 * Assessment, assurance change handling, and finding triage.
 *
 * The Truth Engine is never reimplemented here. These workflows ask Adericel to
 * assess and then react to what it concluded. That separation is what keeps the
 * engine testable and its results reproducible.
 */

export function assessmentWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Assessment\n\n' +
        'Asks the Adericel API to assess. **The Truth Engine runs inside Adericel, ' +
        'never here.**\n\n' +
        'If assessment logic lived in an n8n Code node it would be a second, ' +
        'untested implementation of the truth model, it could not be replayed, and ' +
        'a workflow edit would silently change what the organisation believes to be ' +
        'true. All this workflow does is ask, and report what came back.',
      [-620, -200],
      [560, 300],
      3,
    ),
    subWorkflowTrigger([0, 0], 'Called with { organisationId, correlationId }.'),
    configurationNode([220, 0]),
    adericelRequest('Run full assessment', [440, 0], {
      method: 'POST',
      url: '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/assessments/run-all',
      notes:
        'Assesses every control, then rolls up requirements, frameworks and the organisation so ' +
        'each level aggregates freshly assessed children.',
    }),
    ifNode('Assessed?', [660, 0], {
      left: '={{ $json.statusCode }}',
      operator: 'lt',
      right: '300',
      type: 'number',
    }),
    codeNode(
      'Report outcome',
      [900, -100],
      `/**
 * Report what the assessment concluded, in the product's own vocabulary.
 *
 * Unknown is reported separately from failing throughout. Folding them together
 * would tell an MSP that a customer they cannot see is the same as a customer
 * who is failing, and those need completely different responses.
 */
const result = $input.first().json.body || {};
const summary = result.summary || {};
const counts = summary.counts || {};
const trigger = $('When called by another workflow').first().json;

return [
  {
    json: {
      organisationId: trigger.organisationId,
      correlationId: trigger.correlationId,
      controlsAssessed: result.controlsAssessed || 0,
      statesChanged: result.statesChanged || 0,
      findingsOpened: result.findingsOpened || 0,
      findingsResolved: result.findingsResolved || 0,
      state: summary.state,
      counts,
      unknownCount: counts.UNKNOWN || 0,
      failingCount: counts.NOT_SATISFIED || 0,
    },
  },
];`,
    ),
    node(
      'Assessment failed',
      'n8n-nodes-base.stopAndError',
      1,
      {
        errorMessage:
          '=Assessment failed with HTTP {{ $json.statusCode }}. Assurance state has NOT been updated; the previous state remains authoritative.',
      },
      [900, 120],
      {
        notes:
          'A failed assessment leaves the previous state in place. Adericel never substitutes a ' +
          'guess for a determination it could not make.',
      },
    ),
  ];

  let connections = chain(
    'When called by another workflow',
    'Configuration',
    'Run full assessment',
    'Assessed?',
  );
  connections = connect(connections, 'Assessed?', 'Report outcome', 0);
  connections = connect(connections, 'Assessed?', 'Assessment failed', 1);

  return workflow({
    id: WORKFLOW_IDS.assessment,
    name: 'Adericel — 06 Assessment',
    description:
      'Requests a full reassessment from the Adericel API and reports the outcome. Contains no ' +
      'assessment logic of its own.',
    nodes,
    connections,
    tags: ['adericel', 'assurance'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

/**
 * Assurance change handling.
 *
 * Reacts to AssuranceStateChanged. A move into UNKNOWN is treated as
 * significant in its own right, not as a lesser version of a failure: it
 * usually means Adericel stopped being able to see something, which is an
 * operational problem the MSP owns.
 */
export function assuranceChangeWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Assurance change\n\n' +
        'Classifies what actually happened, then notifies proportionately.\n\n' +
        '**Losing visibility is its own event.** A control moving from Proven to ' +
        'Unknown is not a smaller failure — it usually means a source stopped ' +
        "collecting, which is Adericel's problem to fix, not the customer's.",
      [-620, -200],
      [520, 280],
      4,
    ),
    subWorkflowTrigger([0, 0], 'Invoked on AssuranceStateChanged.'),
    configurationNode([220, 0]),
    codeNode(
      'Classify the change',
      [440, 0],
      `/**
 * Work out what kind of change this is and how loudly to say so.
 *
 * Four distinct transitions, deliberately not collapsed into "good" and "bad":
 *
 *  - deterioration  — was proven, now failing. The customer's posture changed.
 *  - visibility lost — was determinate, now unknown. Adericel stopped being able
 *    to see. Usually a collection problem, and usually ours.
 *  - improvement    — now proven. Worth recording, quietly.
 *  - visibility gained — was unknown, now determinate. Evidence arrived.
 */
const event = $input.first().json;
const payload = event.payload || {};
const previous = payload.previousState;
const current = payload.state;

const determinate = ['SATISFIED', 'PARTIALLY_SATISFIED', 'NOT_SATISFIED', 'EXCEPTED'];

let kind;
let severity;
let headline;

if (current === 'UNKNOWN' && determinate.includes(previous)) {
  kind = 'visibility-lost';
  severity = 'attention';
  headline = 'Adericel can no longer determine a control it previously could';
} else if (current === 'NOT_SATISFIED' && previous !== 'NOT_SATISFIED') {
  kind = 'deterioration';
  severity = 'urgent';
  headline = 'A control has started failing';
} else if (determinate.includes(current) && previous === 'UNKNOWN') {
  kind = 'visibility-gained';
  severity = 'info';
  headline = 'Adericel can now determine a control that was unknown';
} else if (current === 'SATISFIED') {
  kind = 'improvement';
  severity = 'info';
  headline = 'A control is now proven';
} else {
  kind = 'change';
  severity = 'info';
  headline = 'A control changed state';
}

const message =
  headline + '. ' + (payload.controlKey || payload.subjectType || 'Subject') +
  ' moved from ' + (previous || 'no previous state') + ' to ' + current + '. ' +
  (payload.rationale || '') +
  (kind === 'visibility-lost'
    ? ' This usually means a source stopped collecting or its evidence passed its freshness limit. ' +
      'It is not a statement that the customer got worse — it is a statement that Adericel stopped being able to say.'
    : '');

return [
  {
    json: {
      organisationId: event.organisationId,
      correlationId: event.correlationId,
      kind,
      severity,
      subject: 'Adericel: ' + headline,
      message,
      controlKey: payload.controlKey || null,
      previousState: previous,
      state: current,
      notifiable: kind === 'deterioration' || kind === 'visibility-lost',
    },
  },
];`,
    ),
    ifNode(
      'Worth notifying?',
      [660, 0],
      { left: '={{ $json.notifiable }}', operator: 'true', type: 'boolean' },
      'Improvements are recorded but do not page anyone. Alert fatigue is how real alerts get ignored.',
    ),
    executeSubWorkflow('Notify', [900, -100], WORKFLOW_IDS.notifications),
    node('Recorded only', 'n8n-nodes-base.noOp', 1, {}, [900, 120], {
      notes: 'The change is already durably recorded in Adericel; no notification is warranted.',
    }),
  ];

  let connections = chain(
    'When called by another workflow',
    'Configuration',
    'Classify the change',
    'Worth notifying?',
  );
  connections = connect(connections, 'Worth notifying?', 'Notify', 0);
  connections = connect(connections, 'Worth notifying?', 'Recorded only', 1);

  return workflow({
    id: WORKFLOW_IDS.assuranceChange,
    name: 'Adericel — 07 Assurance change',
    description:
      'Classifies an assurance state change, distinguishing a deterioration from a loss of ' +
      'visibility, and notifies proportionately.',
    nodes,
    connections,
    tags: ['adericel', 'assurance'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

/**
 * Finding triage.
 *
 * Decides whether Adericel should propose a remediation. It proposes only; the
 * policy engine decides whether the proposal may ever run, and a human decides
 * whether it does.
 */
export function findingTriageWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Finding triage\n\n' +
        'Decides whether to **propose** a remediation. It never decides whether one ' +
        'runs — the Adericel policy engine does that, and for anything consequential ' +
        'a person does.\n\n' +
        'The remediation is read from the ruleset that raised the finding, so this ' +
        'workflow contains no mapping of its own between findings and fixes.',
      [-620, -220],
      [520, 300],
      4,
    ),
    subWorkflowTrigger([0, 0], 'Invoked on FindingCreated.'),
    configurationNode([220, 0]),
    adericelRequest('Read the finding', [440, 0], {
      url: '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/findings?openOnly=true&limit=200',
    }),
    adericelRequest('Read available capabilities', [660, 0], {
      url: "={{ $('Configuration').first().json.apiBaseUrl }}/v1/capabilities",
      notes:
        'The set of things Adericel can actually execute in this deployment. A remediation with no ' +
        'connector behind it is recorded for a human rather than proposed.',
    }),
    adericelRequest('Read the rulesets', [880, 0], {
      url: "={{ $('Configuration').first().json.apiBaseUrl }}/v1/rulesets",
    }),
    codeNode(
      'Decide whether to propose',
      [1100, 0],
      `/**
 * Decide whether this finding has an automatable remediation.
 *
 * The mapping from finding to fix lives in the ruleset that raised it, not
 * here. That matters: the rule author decides what an appropriate remediation
 * is, it is versioned and hashed with the rule, and this workflow cannot invent
 * a fix the rule never sanctioned.
 */
const event = $('When called by another workflow').first().json;
const findingId = event.subjectId;
const payload = event.payload || {};

const findings = ($('Read the finding').first().json.body || {}).findings || [];
const finding = findings.find((candidate) => candidate.id === findingId);

if (!finding) {
  return [{ json: { propose: false, reason: 'The finding is no longer open.', findingId } }];
}

const capabilities = ($('Read available capabilities').first().json.body || {}).capabilities || [];
const rulesets = ($('Read the rulesets').first().json.body || {}).engineRulesets || [];

const controlKey = (finding.control && finding.control.key) || payload.controlKey;
const rule = rulesets
  .flatMap((ruleset) => ruleset.rules || [])
  .find((candidate) => candidate.key === controlKey);

if (!rule || !rule.hasRemediation) {
  return [
    {
      json: {
        propose: false,
        findingId,
        organisationId: event.organisationId,
        correlationId: event.correlationId,
        severity: finding.severity,
        reason:
          'The rule that raised this finding declares no automated remediation. It is recorded ' +
          'for a person to act on.',
      },
    },
  ];
}

// The ruleset lists a remediation, but this deployment may have no connector
// able to perform it. Proposing something that cannot execute would be noise.
const capability = capabilities.find((candidate) =>
  rulesets.some((ruleset) =>
    (ruleset.rules || []).some((r) => r.key === controlKey && candidate.actionType),
  ),
);

return [
  {
    json: {
      propose: Boolean(capability),
      findingId,
      organisationId: event.organisationId,
      correlationId: event.correlationId,
      controlKey,
      severity: finding.severity,
      title: finding.title,
      description: finding.description,
      actionType: capability ? capability.actionType : null,
      riskClass: capability ? capability.riskClass : null,
      reason: capability
        ? 'A connector in this deployment can perform the remediation the rule specifies.'
        : 'The rule specifies a remediation but no connector in this deployment can perform it.',
    },
  },
];`,
    ),
    ifNode('Propose a remediation?', [1340, 0], {
      left: '={{ $json.propose }}',
      operator: 'true',
      type: 'boolean',
    }),
    executeSubWorkflow('Propose action', [1580, -100], WORKFLOW_IDS.actionProposal),
    codeNode(
      'Record for a human',
      [1580, 120],
      `/**
 * No automated remediation. Say so plainly rather than staying silent.
 *
 * A finding nobody is told about is worse than one with no automated fix.
 */
const input = $input.first().json;
return [
  {
    json: {
      organisationId: input.organisationId,
      correlationId: input.correlationId,
      severity: input.severity === 'CRITICAL' || input.severity === 'HIGH' ? 'urgent' : 'info',
      subject: 'Adericel finding needs a person: ' + (input.title || input.findingId),
      message:
        (input.description || '') + '\\n\\n' + input.reason +
        '\\n\\nThis finding is recorded and will keep ageing from its first detection until it is ' +
        'resolved or an exception is authorised.',
    },
  },
];`,
    ),
    executeSubWorkflow('Notify', [1820, 120], WORKFLOW_IDS.notifications),
  ];

  let connections = chain(
    'When called by another workflow',
    'Configuration',
    'Read the finding',
    'Read available capabilities',
    'Read the rulesets',
    'Decide whether to propose',
    'Propose a remediation?',
  );
  connections = connect(connections, 'Propose a remediation?', 'Propose action', 0);
  connections = connect(connections, 'Propose a remediation?', 'Record for a human', 1);
  connections = connect(connections, 'Record for a human', 'Notify');

  return workflow({
    id: WORKFLOW_IDS.findingTriage,
    name: 'Adericel — 08 Finding triage',
    description:
      'Decides whether a finding has an automatable remediation declared by the rule that raised ' +
      'it, and either proposes it or records it for a person.',
    nodes,
    connections,
    tags: ['adericel', 'findings'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}
