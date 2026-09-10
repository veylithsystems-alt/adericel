import {
  adericelRequest,
  chain,
  codeNode,
  configurationNode,
  connect,
  executeSubWorkflow,
  ifNode,
  node,
  scheduleTrigger,
  stickyNote,
  subWorkflowTrigger,
  workflow,
  WORKFLOW_IDS,
  type N8nWorkflow,
} from '../lib.js';

/**
 * Workflows for the capabilities built after the first twenty.
 *
 * Each of these exists because a state Adericel can now reach had nobody
 * watching it: a customer leaving, two systems disagreeing, and an integration
 * losing a permission. All three are quiet failures — nothing errors, nothing
 * alerts, and the assurance picture degrades while every light stays green.
 */

export function offboardingWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Offboarding\n\n' +
        'Drives a customer’s departure to completion.\n\n' +
        'The order is deliberate and is the opposite of the convenient one: **export first**, ' +
        'then revoke, then close. The moment a customer is least able to argue about their ' +
        'record is exactly when it is most likely to be destroyed, so the export is taken ' +
        'before anything is revoked and closure is refused without one.\n\n' +
        'This workflow never closes an organisation on its own initiative. It carries out the ' +
        'steps and reports what remains; a person decides that the relationship has ended.',
      [-620, -260],
      [560, 380],
      4,
    ),
    subWorkflowTrigger(
      [0, 0],
      'Called with { organisationId, reason }. Reason is required — an organisation closed ' +
        'without a recorded reason is one nobody can explain later.',
    ),
    configurationNode([220, 0]),
    ifNode('Reason given?', [440, 0], { left: '={{ $json.reason }}', operator: 'notEmpty' }),

    adericelRequest('Begin offboarding', [660, -120], {
      method: 'POST',
      url: '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/offboarding',
      body: { reason: '={{ $json.reason }}' },
      notes:
        'Stops collection and assessment immediately. Nothing further is asserted about an ' +
        'estate Adericel no longer observes.',
    }),

    adericelRequest('Take the final export', [880, -120], {
      method: 'POST',
      url: '={{ $("Configuration").first().json.apiBaseUrl }}/v1/organisations/{{ $("When called by another workflow").first().json.organisationId }}/offboarding/export',
      notes:
        'The record the customer leaves with. Refused by the API if it would be truncated, ' +
        'because a bundle that says it is complete and is not is worse than no bundle.',
    }),

    adericelRequest('Revoke everything', [1100, -120], {
      method: 'POST',
      url: '={{ $("Configuration").first().json.apiBaseUrl }}/v1/organisations/{{ $("When called by another workflow").first().json.organisationId }}/offboarding/revoke',
      body: { reason: '={{ $("When called by another workflow").first().json.reason }}' },
      notes:
        'Passport shares stop answering, stored credentials are destroyed rather than disabled, ' +
        'and sessions end. Idempotent, so a partial run is simply repeated.',
    }),

    adericelRequest('What remains?', [1320, -120], {
      url: '={{ $("Configuration").first().json.apiBaseUrl }}/v1/organisations/{{ $("When called by another workflow").first().json.organisationId }}/offboarding',
    }),

    codeNode(
      'Summarise',
      [1540, -120],
      `const status = $input.first().json.body || {};
const blockers = status.blockers || [];
return [{
  json: {
    organisationId: status.organisationId,
    readyToClose: status.readyToClose === true,
    blockers,
    finalExportHash: status.finalExportHash,
    subject: status.readyToClose
      ? 'Offboarding complete and ready to close'
      : 'Offboarding is under way and cannot be closed yet',
    message: status.readyToClose
      ? 'Everything required has been done. The customer has their record (' +
        String(status.finalExportHash || 'no hash recorded') +
        '), assurance has stopped, shared passports no longer answer, and credentials are ' +
        'destroyed. Closing is a person\\'s decision.'
      : 'Still outstanding: ' + blockers.join('; '),
    // Never CRITICAL. A customer leaving in an orderly way is not an incident,
    // and treating it as one trains people to ignore the channel.
    severity: status.readyToClose ? 'INFO' : 'MEDIUM',
  },
}];`,
    ),

    executeSubWorkflow('Tell somebody', [1760, -120], WORKFLOW_IDS.notifications),

    node(
      'No reason given',
      'n8n-nodes-base.stopAndError',
      1,
      {
        errorMessage:
          'Offboarding needs a recorded reason. An organisation closed without one is one ' +
          'nobody can explain to an auditor, a customer or a court.',
      },
      [660, 140],
    ),
  ];

  let connections = chain('When called by another workflow', 'Configuration', 'Reason given?');
  connections = connect(connections, 'Reason given?', 'Begin offboarding', 0);
  connections = connect(connections, 'Reason given?', 'No reason given', 1);
  connections = connect(connections, 'Begin offboarding', 'Take the final export');
  connections = connect(connections, 'Take the final export', 'Revoke everything');
  connections = connect(connections, 'Revoke everything', 'What remains?');
  connections = connect(connections, 'What remains?', 'Summarise');
  connections = connect(connections, 'Summarise', 'Tell somebody');

  return workflow({
    id: WORKFLOW_IDS.offboarding,
    name: 'Adericel — 21 Offboarding',
    description:
      'Carries a departing customer through export, revocation and readiness to close, in that ' +
      'order. Never closes an organisation by itself.',
    nodes,
    connections,
    tags: ['adericel', 'lifecycle'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

export function sourceConflictWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Sources that disagree\n\n' +
        'Two integrations contradicting each other is the one failure that looks like success: ' +
        'both are connected, both are healthy, and neither is wrong in a way any error would ' +
        'catch.\n\n' +
        'Adericel refuses to choose between them, so the affected controls read **Unknown** ' +
        'until somebody settles it. That is the honest answer and it is also invisible unless ' +
        'something goes looking — which is what this does.',
      [-620, -220],
      [540, 320],
      4,
    ),
    scheduleTrigger(
      'Every four hours',
      [0, 0],
      { field: 'hours', interval: 4 },
      'Often enough that a disagreement is noticed the same working day.',
    ),
    configurationNode([220, 0]),
    ifNode('MSP configured?', [440, 0], { left: '={{ $json.mspId }}', operator: 'notEmpty' }),
    adericelRequest('List organisations', [660, -100], {
      url: '={{ $json.apiBaseUrl }}/v1/msps/{{ $json.mspId }}/organisations?limit=200&status=ACTIVE',
    }),
    codeNode(
      'Fan out',
      [880, -100],
      `const response = $input.first().json.body || {};
const config = $('Configuration').first().json;
return (response.organisations || []).map((organisation) => ({
  json: {
    organisationId: organisation.id,
    organisationName: organisation.name,
    apiBaseUrl: config.apiBaseUrl,
  },
}));`,
    ),
    node(
      'One organisation at a time',
      'n8n-nodes-base.splitInBatches',
      3,
      { batchSize: 1, options: {} },
      [1100, -100],
    ),
    adericelRequest('Open conflicts', [1340, -100], {
      url: '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/source-conflicts',
    }),
    codeNode(
      'Anything contested?',
      [1560, -100],
      `const conflicts = ($input.first().json.body || {}).conflicts || [];
const blocking = conflicts.filter((conflict) => conflict.blocksAssurance);
if (blocking.length === 0) return [];

const context = $('One organisation at a time').first().json;
const lines = blocking.map((conflict) => {
  const positions = (conflict.sources || [])
    .map((source) => source.name + ' says ' + JSON.stringify(source.value))
    .join(', ');
  return '- ' + conflict.predicate +
    (conflict.subjectExternalId ? ' for ' + conflict.subjectExternalId : '') +
    ': ' + positions;
});

return [{
  json: {
    organisationId: context.organisationId,
    subject: blocking.length + ' fact(s) Adericel will not assert for ' + context.organisationName,
    message:
      'Two systems disagree and nothing tells Adericel which to believe, so it will not ' +
      'choose. Every control resting on these reads Unknown until the disagreement is ' +
      'settled.\\n\\n' + lines.join('\\n') +
      '\\n\\nEither correct whichever system is wrong, or name an authoritative source for ' +
      'these facts.',
    // A contested fact is a real gap in assurance, not a technical warning.
    severity: 'HIGH',
  },
}];`,
    ),
    executeSubWorkflow('Tell somebody', [1780, -100], WORKFLOW_IDS.notifications),
    node(
      'No MSP configured',
      'n8n-nodes-base.stopAndError',
      1,
      { errorMessage: 'ADERICEL_MSP_ID is not set on this n8n instance.' },
      [660, 140],
    ),
  ];

  let connections = chain('Every four hours', 'Configuration', 'MSP configured?');
  connections = connect(connections, 'MSP configured?', 'List organisations', 0);
  connections = connect(connections, 'MSP configured?', 'No MSP configured', 1);
  connections = connect(connections, 'List organisations', 'Fan out');
  connections = connect(connections, 'Fan out', 'One organisation at a time');
  connections = connect(connections, 'One organisation at a time', 'Open conflicts', 1);
  connections = connect(connections, 'Open conflicts', 'Anything contested?');
  connections = connect(connections, 'Anything contested?', 'Tell somebody');
  connections = connect(connections, 'Tell somebody', 'One organisation at a time');

  return workflow({
    id: WORKFLOW_IDS.sourceConflict,
    name: 'Adericel — 22 Source conflicts',
    description:
      'Finds facts Adericel is withholding because two systems disagree, and names both ' +
      'positions so somebody can settle it.',
    nodes,
    connections,
    tags: ['adericel', 'scheduled'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

export function coverageWatchWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Coverage watch\n\n' +
        'An integration that loses a permission does not fail. It keeps connecting, keeps ' +
        'returning what it still can, and the controls behind the missing permission quietly ' +
        'become **Unknown** — indistinguishable from a customer who genuinely has no such ' +
        'evidence.\n\n' +
        'This asks each organisation what its integrations can currently see, and reports any ' +
        'capability that is failing **with the exact permission to grant**. That is the ' +
        'difference between an integration fixed before lunch and one broken for a fortnight.',
      [-620, -240],
      [560, 340],
      4,
    ),
    scheduleTrigger(
      'Every morning',
      [0, 0],
      { field: 'cronExpression', expression: '0 7 * * *' },
      'Early enough that somebody can act on it during the working day.',
    ),
    configurationNode([220, 0]),
    ifNode('MSP configured?', [440, 0], { left: '={{ $json.mspId }}', operator: 'notEmpty' }),
    adericelRequest('List organisations', [660, -100], {
      url: '={{ $json.apiBaseUrl }}/v1/msps/{{ $json.mspId }}/organisations?limit=200&status=ACTIVE',
    }),
    codeNode(
      'Fan out',
      [880, -100],
      `const response = $input.first().json.body || {};
const config = $('Configuration').first().json;
return (response.organisations || []).map((organisation) => ({
  json: {
    organisationId: organisation.id,
    organisationName: organisation.name,
    apiBaseUrl: config.apiBaseUrl,
  },
}));`,
    ),
    node(
      'One organisation at a time',
      'n8n-nodes-base.splitInBatches',
      3,
      { batchSize: 1, options: {} },
      [1100, -100],
    ),
    adericelRequest('What can we see?', [1340, -100], {
      url: '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/observation-coverage',
    }),
    codeNode(
      'Anything broken?',
      [1560, -100],
      `const coverage = $input.first().json.body || {};
const broken = coverage.brokenCapabilities || [];
const context = $('One organisation at a time').first().json;

// Demonstration data in a live tenant is worth saying out loud on its own,
// because anything resting on it must not be shared or relied upon.
const notes = [];
if (coverage.containsDemonstrationData) {
  notes.push(
    'This organisation contains demonstration data. Nothing resting on it describes a real ' +
    'estate.',
  );
}
if (broken.length === 0 && notes.length === 0) return [];

const lines = broken.map((capability) => {
  const remedy = capability.requiredPermission
    ? ' Grant ' + capability.requiredPermission + '.'
    : '';
  const cost = (capability.unavailablePredicates || []).length;
  return '- ' + capability.integrationName + ': ' + capability.detail + remedy +
    (cost > 0 ? ' (' + cost + ' fact(s) unavailable)' : '');
});

return [{
  json: {
    organisationId: context.organisationId,
    subject: broken.length > 0
      ? broken.length + ' capability(ies) failing for ' + context.organisationName
      : 'Coverage note for ' + context.organisationName,
    message: [...notes, ...lines].join('\\n') +
      '\\n\\nAdericel can currently supply ' + (coverage.satisfiedPredicates || 0) + ' of the ' +
      (coverage.requiredPredicates || 0) + ' facts your frameworks need.',
    severity: broken.length > 0 ? 'MEDIUM' : 'INFO',
  },
}];`,
    ),
    executeSubWorkflow('Tell somebody', [1780, -100], WORKFLOW_IDS.notifications),
    node(
      'No MSP configured',
      'n8n-nodes-base.stopAndError',
      1,
      { errorMessage: 'ADERICEL_MSP_ID is not set on this n8n instance.' },
      [660, 140],
    ),
  ];

  let connections = chain('Every morning', 'Configuration', 'MSP configured?');
  connections = connect(connections, 'MSP configured?', 'List organisations', 0);
  connections = connect(connections, 'MSP configured?', 'No MSP configured', 1);
  connections = connect(connections, 'List organisations', 'Fan out');
  connections = connect(connections, 'Fan out', 'One organisation at a time');
  connections = connect(connections, 'One organisation at a time', 'What can we see?', 1);
  connections = connect(connections, 'What can we see?', 'Anything broken?');
  connections = connect(connections, 'Anything broken?', 'Tell somebody');
  connections = connect(connections, 'Tell somebody', 'One organisation at a time');

  return workflow({
    id: WORKFLOW_IDS.coverageWatch,
    name: 'Adericel — 23 Coverage watch',
    description:
      'Reports integration capabilities that are failing, with the exact permission that would ' +
      'restore each one, and flags demonstration data in a live tenant.',
    nodes,
    connections,
    tags: ['adericel', 'scheduled'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}
