import {
  CREDENTIAL,
  WORKFLOW_IDS,
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
  type N8nWorkflow,
} from '../lib.js';

/**
 * Scheduled operations, notifications, reporting, health and recovery.
 *
 * Schedules here are a safety net rather than the primary mechanism: Adericel's
 * own worker holds the authoritative schedule in the database, so a workflow
 * outage delays work rather than losing it. These workflows exist so an MSP can
 * see and adjust the operational rhythm in one place, and so that a deployment
 * running n8n without the worker still functions.
 */

export function notificationsWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Notifications\n\n' +
        'One dispatch point for everything Adericel needs a person to see.\n\n' +
        'Routing is by severity, not by event type, so an urgent item reaches ' +
        'people the same way regardless of which workflow produced it.\n\n' +
        'Configure `ADERICEL_NOTIFY_EMAIL` for email or ' +
        '`ADERICEL_NOTIFY_WEBHOOK_URL` for a chat webhook. With neither set, ' +
        'messages are recorded in the execution log only — which is a legitimate ' +
        'configuration for a deployment that reads Adericel directly.',
      [-620, -220],
      [560, 320],
      4,
    ),
    subWorkflowTrigger(
      [0, 0],
      'Called with { subject, message, severity, organisationId, correlationId }.',
    ),
    configurationNode([220, 0]),
    codeNode(
      'Normalise the message',
      [440, 0],
      `/**
 * Give every notification the same shape and a consistent severity.
 *
 * The correlation id is always included: it is what turns "something happened"
 * into a trace an operator can follow through Adericel, the worker and the
 * external system.
 */
const input = $input.first().json;
const severity = ['urgent', 'attention', 'info'].includes(input.severity) ? input.severity : 'info';
const config = $('Configuration').first().json;

const prefix = severity === 'urgent' ? '[URGENT] ' : severity === 'attention' ? '[Attention] ' : '';

return [
  {
    json: {
      severity,
      subject: prefix + (input.subject || 'Adericel notification'),
      message:
        (input.message || '') +
        '\\n\\n— Adericel' +
        (input.organisationId ? '\\nOrganisation: ' + input.organisationId : '') +
        (input.correlationId ? '\\nCorrelation: ' + input.correlationId : ''),
      organisationId: input.organisationId || null,
      correlationId: input.correlationId || $execution.id,
      notifyEmail: config.notifyEmail,
      notifyWebhookUrl: config.notifyWebhookUrl,
    },
  },
];`,
    ),
    ifNode('Email configured?', [660, -100], {
      left: '={{ $json.notifyEmail }}',
      operator: 'notEmpty',
    }),
    node(
      'Send email',
      'n8n-nodes-base.emailSend',
      2.1,
      {
        fromEmail: "={{ $env.ADERICEL_NOTIFY_FROM || 'adericel@localhost' }}",
        toEmail: '={{ $json.notifyEmail }}',
        subject: '={{ $json.subject }}',
        emailFormat: 'text',
        text: '={{ $json.message }}',
        options: {},
      },
      [900, -180],
      {
        credentials: { smtp: CREDENTIAL.smtp },
        onError: 'continueRegularOutput',
        notes:
          'A failed notification must not fail the operation that produced it. The underlying ' +
          'event is already durably recorded in Adericel.',
      },
    ),
    ifNode('Webhook configured?', [660, 100], {
      left: '={{ $json.notifyWebhookUrl }}',
      operator: 'notEmpty',
    }),
    node(
      'Post to chat',
      'n8n-nodes-base.httpRequest',
      4.2,
      {
        method: 'POST',
        url: '={{ $json.notifyWebhookUrl }}',
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          '={{ JSON.stringify({ text: $json.subject + "\\n\\n" + $json.message, severity: $json.severity }) }}',
        options: { timeout: 15000 },
      },
      [900, 180],
      { onError: 'continueRegularOutput' },
    ),
    node('Recorded in the execution log', 'n8n-nodes-base.noOp', 1, {}, [900, 0], {
      notes:
        'No delivery channel is configured. The message is visible in this execution, and the ' +
        'underlying event is in Adericel regardless.',
    }),
  ];

  let connections = chain(
    'When called by another workflow',
    'Configuration',
    'Normalise the message',
  );
  connections = connect(connections, 'Normalise the message', 'Email configured?');
  connections = connect(connections, 'Normalise the message', 'Webhook configured?');
  connections = connect(connections, 'Email configured?', 'Send email', 0);
  connections = connect(connections, 'Email configured?', 'Recorded in the execution log', 1);
  connections = connect(connections, 'Webhook configured?', 'Post to chat', 0);

  return workflow({
    id: WORKFLOW_IDS.notifications,
    name: 'Adericel — 13 Notifications',
    description:
      'Single notification dispatch point, routing by severity and always carrying the correlation ' +
      'id needed to trace the operation.',
    nodes,
    connections,
    tags: ['adericel', 'operations'],
  });
}

export function scheduledCollectionWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Scheduled collection\n\n' +
        'Refreshes evidence across the portfolio.\n\n' +
        "This is a **safety net**, not the primary schedule — Adericel's worker " +
        'holds the authoritative schedule in its database, so an n8n outage delays ' +
        'collection rather than losing it. Both paths are idempotent, so running ' +
        'both is harmless.',
      [-620, -200],
      [520, 280],
      4,
    ),
    scheduleTrigger(
      'Every four hours',
      [0, 0],
      { field: 'hours', interval: 4 },
      'Evidence freshness limits are measured in days, so four-hourly collection keeps well inside them.',
    ),
    configurationNode([220, 0]),
    ifNode(
      'MSP configured?',
      [440, 0],
      { left: '={{ $json.mspId }}', operator: 'notEmpty' },
      'Set ADERICEL_MSP_ID so this workflow knows which portfolio to sweep.',
    ),
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
    correlationId: $execution.id + '-' + organisation.id,
  },
}));`,
    ),
    node(
      'One organisation at a time',
      'n8n-nodes-base.splitInBatches',
      3,
      { batchSize: 1, options: {} },
      [1100, -100],
      {
        notes:
          'Sequential rather than parallel. A portfolio sweep that hammered every customer tenant ' +
          'at once would trip their rate limits and look like an attack.',
      },
    ),
    adericelRequest('List sources', [1340, -100], {
      url: '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/integrations',
      onError: 'continueRegularOutput',
    }),
    codeNode(
      'Select collectable sources',
      [1560, -100],
      `const response = $input.first().json;
const batch = $('One organisation at a time').first().json;
const integrations = (response.body && response.body.integrations) || [];

return integrations
  .filter((integration) => ['CONFIGURED', 'CONNECTED', 'DEGRADED'].includes(integration.status))
  .map((integration) => ({
    json: {
      organisationId: batch.organisationId,
      apiBaseUrl: batch.apiBaseUrl,
      correlationId: batch.correlationId,
      integrationId: integration.id,
      name: integration.name,
    },
  }));`,
    ),
    adericelRequest('Collect', [1780, -100], {
      method: 'POST',
      url:
        '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/integrations/' +
        '{{ $json.integrationId }}/collect',
      onError: 'continueRegularOutput',
      notes:
        'A failing source is recorded against that integration and its controls report UNKNOWN. ' +
        'It never stops the rest of the sweep.',
    }),
    node(
      'No MSP configured',
      'n8n-nodes-base.stopAndError',
      1,
      {
        errorMessage:
          'ADERICEL_MSP_ID is not set on this n8n instance, so there is no portfolio to sweep.',
      },
      [660, 120],
    ),
  ];

  let connections = chain('Every four hours', 'Configuration', 'MSP configured?');
  connections = connect(connections, 'MSP configured?', 'List organisations', 0);
  connections = connect(connections, 'MSP configured?', 'No MSP configured', 1);
  connections = connect(connections, 'List organisations', 'Fan out');
  connections = connect(connections, 'Fan out', 'One organisation at a time');
  connections = connect(connections, 'One organisation at a time', 'List sources', 1);
  connections = connect(connections, 'List sources', 'Select collectable sources');
  connections = connect(connections, 'Select collectable sources', 'Collect');
  connections = connect(connections, 'Collect', 'One organisation at a time');

  return workflow({
    id: WORKFLOW_IDS.scheduledCollection,
    name: 'Adericel — 14 Scheduled collection',
    description:
      'Sweeps the portfolio and refreshes evidence from every collectable source, one organisation ' +
      'at a time.',
    nodes,
    connections,
    tags: ['adericel', 'scheduled'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

export function scheduledReassessmentWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Scheduled reassessment\n\n' +
        'Reassesses every organisation.\n\n' +
        'Reassessment matters even when nothing was collected: evidence expires. ' +
        'A control that was Proven last week becomes **Unknown** once the evidence ' +
        'behind it passes its freshness limit, and that transition is the whole ' +
        'difference between continuous assurance and an annual audit.',
      [-620, -200],
      [520, 300],
      4,
    ),
    scheduleTrigger(
      'Every six hours',
      [0, 0],
      { field: 'hours', interval: 6 },
      'Offset from collection so assessment runs against freshly collected evidence.',
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
    apiBaseUrl: config.apiBaseUrl,
    correlationId: $execution.id + '-' + organisation.id,
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
    executeSubWorkflow('Assess', [1340, -100], WORKFLOW_IDS.assessment),
    node(
      'No MSP configured',
      'n8n-nodes-base.stopAndError',
      1,
      { errorMessage: 'ADERICEL_MSP_ID is not set on this n8n instance.' },
      [660, 120],
    ),
  ];

  let connections = chain('Every six hours', 'Configuration', 'MSP configured?');
  connections = connect(connections, 'MSP configured?', 'List organisations', 0);
  connections = connect(connections, 'MSP configured?', 'No MSP configured', 1);
  connections = connect(connections, 'List organisations', 'Fan out');
  connections = connect(connections, 'Fan out', 'One organisation at a time');
  connections = connect(connections, 'One organisation at a time', 'Assess', 1);
  connections = connect(connections, 'Assess', 'One organisation at a time');

  return workflow({
    id: WORKFLOW_IDS.scheduledReassessment,
    name: 'Adericel — 15 Scheduled reassessment',
    description:
      'Reassesses every active organisation so that expiring evidence moves controls into Unknown ' +
      'rather than leaving a stale Proven in place.',
    nodes,
    connections,
    tags: ['adericel', 'scheduled'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

export function evidenceExpiryWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Evidence expiry\n\n' +
        'Chases evidence that is about to stop supporting a claim.\n\n' +
        'This is the highest-leverage operational workflow an MSP runs: chasing ' +
        'evidence a week before it expires prevents a customer silently sliding ' +
        'into Unknown, which is far cheaper than explaining afterwards why the ' +
        'assurance picture went dark.',
      [-620, -200],
      [520, 300],
      4,
    ),
    scheduleTrigger(
      'Daily',
      [0, 0],
      { field: 'days', interval: 1, atHour: 7 },
      'Early enough that a chase lands at the start of the working day.',
    ),
    configurationNode([220, 0]),
    ifNode('MSP configured?', [440, 0], { left: '={{ $json.mspId }}', operator: 'notEmpty' }),
    adericelRequest('Portfolio', [660, -100], {
      url: '={{ $json.apiBaseUrl }}/v1/msps/{{ $json.mspId }}/portfolio',
    }),
    codeNode(
      'Find evidence needing attention',
      [880, -100],
      `/**
 * Identify organisations whose evidence position needs a person.
 *
 * Stale evidence and failed collection are reported together because they have
 * the same consequence — controls going Unknown — and the same owner: the MSP,
 * not the customer.
 */
const portfolio = $input.first().json.body || {};
const organisations = portfolio.organisations || [];

const needsAttention = organisations.filter(
  (organisation) =>
    organisation.staleEvidence > 0 ||
    organisation.failedIntegrations > 0 ||
    organisation.counts.UNKNOWN > 0,
);

if (needsAttention.length === 0) {
  return [{ json: { anythingToChase: false } }];
}

const lines = needsAttention.map((organisation) => {
  const parts = [];
  if (organisation.failedIntegrations > 0) {
    parts.push(organisation.failedIntegrations + ' source(s) not collecting');
  }
  if (organisation.staleEvidence > 0) {
    parts.push(organisation.staleEvidence + ' evidence record(s) past their freshness limit');
  }
  if (organisation.counts.UNKNOWN > 0) {
    parts.push(organisation.counts.UNKNOWN + ' control(s) Unknown');
  }
  return '  - ' + organisation.name + ': ' + parts.join(', ');
});

return [
  {
    json: {
      anythingToChase: true,
      correlationId: $execution.id,
      severity: 'attention',
      subject: 'Adericel: evidence needs attention across ' + needsAttention.length + ' customer(s)',
      message:
        'These customers have evidence gaps. Most are collection problems on our side rather than ' +
        'posture changes on theirs, and each one means Adericel cannot currently speak to controls ' +
        'it previously could.\\n\\n' + lines.join('\\n') +
        '\\n\\nRestoring collection is what reduces the Unknown count.',
    },
  },
];`,
    ),
    ifNode('Anything to chase?', [1100, -100], {
      left: '={{ $json.anythingToChase }}',
      operator: 'true',
      type: 'boolean',
    }),
    executeSubWorkflow('Notify', [1340, -180], WORKFLOW_IDS.notifications),
    node('Nothing to chase', 'n8n-nodes-base.noOp', 1, {}, [1340, -20]),
    node(
      'No MSP configured',
      'n8n-nodes-base.stopAndError',
      1,
      { errorMessage: 'ADERICEL_MSP_ID is not set on this n8n instance.' },
      [660, 120],
    ),
  ];

  let connections = chain('Daily', 'Configuration', 'MSP configured?');
  connections = connect(connections, 'MSP configured?', 'Portfolio', 0);
  connections = connect(connections, 'MSP configured?', 'No MSP configured', 1);
  connections = connect(connections, 'Portfolio', 'Find evidence needing attention');
  connections = connect(connections, 'Find evidence needing attention', 'Anything to chase?');
  connections = connect(connections, 'Anything to chase?', 'Notify', 0);
  connections = connect(connections, 'Anything to chase?', 'Nothing to chase', 1);

  return workflow({
    id: WORKFLOW_IDS.evidenceExpiry,
    name: 'Adericel — 16 Evidence expiry chase',
    description:
      'Identifies customers whose evidence position is degrading and chases before controls go ' +
      'Unknown.',
    nodes,
    connections,
    tags: ['adericel', 'scheduled', 'evidence'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

export function reportingWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Portfolio reporting\n\n' +
        'A weekly portfolio summary for the MSP.\n\n' +
        'Deliberately contains **no score**. It reports counts with their ' +
        'denominators, and it reports unknowns separately from failures, because ' +
        "those need different responses: a failing control is the customer's " +
        'problem to fix, an unknown one is usually ours.',
      [-620, -200],
      [520, 300],
      4,
    ),
    scheduleTrigger(
      'Weekly',
      [0, 0],
      { field: 'days', interval: 7, atHour: 8 },
      'Monday morning, so it is read before the week is planned.',
    ),
    configurationNode([220, 0]),
    ifNode('MSP configured?', [440, 0], { left: '={{ $json.mspId }}', operator: 'notEmpty' }),
    adericelRequest('Portfolio', [660, -100], {
      url: '={{ $json.apiBaseUrl }}/v1/msps/{{ $json.mspId }}/portfolio',
    }),
    adericelRequest('Recurring failures', [880, -100], {
      url:
        "={{ $('Configuration').first().json.apiBaseUrl }}/v1/msps/" +
        "{{ $('Configuration').first().json.mspId }}/portfolio/recurring-failures?limit=10",
    }),
    adericelRequest('Deteriorating customers', [1100, -100], {
      url:
        "={{ $('Configuration').first().json.apiBaseUrl }}/v1/msps/" +
        "{{ $('Configuration').first().json.mspId }}/portfolio/deteriorating?days=7",
    }),
    codeNode(
      'Compose the report',
      [1320, -100],
      `/**
 * Write the weekly report in the product's own terms.
 *
 * The structure follows what an MSP actually needs to decide on a Monday:
 * what changed, what needs a person, and where one fix would help several
 * customers at once. No score, and unknowns never folded into failures.
 */
const portfolio = $('Portfolio').first().json.body || {};
const recurring = ($('Recurring failures').first().json.body || {}).controls || [];
const deteriorating = ($('Deteriorating customers').first().json.body || {}).organisations || [];
const totals = portfolio.totals || {};
const organisations = portfolio.organisations || [];

const sections = [];

sections.push(
  'ADERICEL WEEKLY PORTFOLIO REPORT\\n' +
    new Date().toISOString().slice(0, 10) + '\\n' +
    organisations.length + ' organisation(s) under management',
);

sections.push(
  'POSITION\\n' +
    '  Failing controls:  ' + (totals.failingControls || 0) + '\\n' +
    '  Unknown controls:  ' + (totals.unknownControls || 0) + '   (Adericel cannot currently speak to these)\\n' +
    '  Critical findings: ' + (totals.criticalFindings || 0) + '\\n' +
    '  Open findings:     ' + (totals.openFindings || 0) + '\\n' +
    '  Awaiting approval: ' + (totals.awaitingApproval || 0) + '\\n' +
    '  Unverified actions:' + (totals.unverifiedActions || 0),
);

if ((totals.failedIntegrations || 0) > 0 || (totals.staleEvidence || 0) > 0) {
  sections.push(
    'OUR PROBLEMS, NOT THE CUSTOMERS\\n' +
      '  Sources not collecting: ' + (totals.failedIntegrations || 0) + '\\n' +
      '  Evidence past freshness: ' + (totals.staleEvidence || 0) + '\\n' +
      '  These are why controls report Unknown. Restoring collection is the fix.',
  );
}

if (deteriorating.length > 0) {
  sections.push(
    'DETERIORATED THIS WEEK\\n' +
      deteriorating
        .map(
          (organisation) =>
            '  - ' + organisation.name + ': ' + organisation.deteriorations +
            ' control(s) moved from proven to failing or unknown' +
            (organisation.newlyUnknown ? ' (' + organisation.newlyUnknown + ' newly unknown)' : ''),
        )
        .join('\\n'),
  );
}

if (recurring.length > 0) {
  sections.push(
    'ONE FIX, SEVERAL CUSTOMERS\\n' +
      recurring
        .slice(0, 5)
        .map(
          (control) =>
            '  - ' + control.title + ': affecting ' + control.affectedOrganisations + ' of ' +
            control.totalOrganisations + ' customers' +
            (control.systemicRemediation ? ' — automatable' : ' — needs a person'),
        )
        .join('\\n'),
  );
}

sections.push(
  'BY CUSTOMER\\n' +
    organisations
      .map((organisation) => {
        const counts = organisation.counts || {};
        const inScope =
          (counts.SATISFIED || 0) + (counts.EXCEPTED || 0) + (counts.NOT_SATISFIED || 0) +
          (counts.PARTIALLY_SATISFIED || 0) + (counts.UNKNOWN || 0);
        return (
          '  - ' + organisation.name.padEnd(30) +
          (counts.SATISFIED || 0) + ' proven of ' + inScope + ' in scope' +
          ((counts.NOT_SATISFIED || 0) > 0 ? ', ' + counts.NOT_SATISFIED + ' failing' : '') +
          ((counts.UNKNOWN || 0) > 0 ? ', ' + counts.UNKNOWN + ' unknown' : '')
        );
      })
      .join('\\n'),
);

return [
  {
    json: {
      correlationId: $execution.id,
      severity: 'info',
      subject: 'Adericel weekly portfolio report',
      message: sections.join('\\n\\n'),
    },
  },
];`,
    ),
    executeSubWorkflow('Send report', [1560, -100], WORKFLOW_IDS.notifications),
    node(
      'No MSP configured',
      'n8n-nodes-base.stopAndError',
      1,
      { errorMessage: 'ADERICEL_MSP_ID is not set on this n8n instance.' },
      [660, 120],
    ),
  ];

  let connections = chain('Weekly', 'Configuration', 'MSP configured?');
  connections = connect(connections, 'MSP configured?', 'Portfolio', 0);
  connections = connect(connections, 'MSP configured?', 'No MSP configured', 1);
  connections = connect(connections, 'Portfolio', 'Recurring failures');
  connections = connect(connections, 'Recurring failures', 'Deteriorating customers');
  connections = connect(connections, 'Deteriorating customers', 'Compose the report');
  connections = connect(connections, 'Compose the report', 'Send report');

  return workflow({
    id: WORKFLOW_IDS.reporting,
    name: 'Adericel — 17 Portfolio reporting',
    description:
      'Weekly portfolio report reporting counts with denominators and keeping unknowns separate ' +
      'from failures.',
    nodes,
    connections,
    tags: ['adericel', 'reporting'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

export function healthMonitorWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Health monitor\n\n' +
        'Watches Adericel itself.\n\n' +
        'The distinction this workflow exists to preserve: **"the customer has an ' +
        'assurance problem" is not the same as "Adericel has an operational ' +
        'problem"**. A failed integration produces Unknown states that look ' +
        'identical to a customer with no controls in place, and only one of those ' +
        "is the customer's fault.",
      [-620, -220],
      [520, 320],
      3,
    ),
    scheduleTrigger(
      'Every 15 minutes',
      [0, 0],
      { field: 'minutes', interval: 15 },
      'Frequent enough to catch a stalled worker before a whole assessment cycle is missed.',
    ),
    configurationNode([220, 0]),
    adericelRequest('Read health', [440, 0], {
      url: '={{ $json.apiBaseUrl }}/v1/system/health',
      onError: 'continueRegularOutput',
    }),
    adericelRequest('Read outbox', [660, 0], {
      url: "={{ $('Configuration').first().json.apiBaseUrl }}/v1/system/outbox",
      onError: 'continueRegularOutput',
    }),
    codeNode(
      'Assess platform health',
      [880, 0],
      `/**
 * Decide whether Adericel itself needs attention.
 *
 * An unreachable API is treated as the most serious state: if Adericel cannot
 * be reached, nothing it previously reported can be trusted to still be current,
 * and no assurance is being maintained at all.
 */
const healthResponse = $('Read health').first().json;
const outboxResponse = $input.first().json;

if (!healthResponse.statusCode || healthResponse.statusCode >= 500) {
  return [
    {
      json: {
        degraded: true,
        severity: 'urgent',
        subject: 'Adericel is unreachable',
        message:
          'The Adericel API did not respond to a health check (status ' +
          (healthResponse.statusCode || 'no response') + ').\\n\\n' +
          'While it is unreachable no assurance is being maintained: no evidence is being ' +
          'collected, nothing is being reassessed, and no assurance state is being updated. ' +
          'The last known state is still visible but is not current.',
        correlationId: $execution.id,
      },
    },
  ];
}

const health = healthResponse.body || {};
const outbox = outboxResponse.body || {};
const problems = health.platformProblems || [];
const unhealthy = (health.components || []).filter((component) => component.status === 'UNHEALTHY');
const degraded = (health.components || []).filter((component) => component.status === 'DEGRADED');

if (health.status === 'HEALTHY' && problems.length === 0 && outbox.healthy !== false) {
  return [{ json: { degraded: false } }];
}

const lines = [];
for (const component of unhealthy) lines.push('  UNHEALTHY  ' + component.component + ': ' + component.detail);
for (const component of degraded) lines.push('  degraded   ' + component.component + ': ' + component.detail);
for (const problem of problems) lines.push('  - ' + problem);
if (outbox.deadLetter > 0) {
  lines.push('  - ' + outbox.deadLetter + ' event(s) in the dead-letter queue; downstream views may be stale.');
}

return [
  {
    json: {
      degraded: true,
      severity: unhealthy.length > 0 ? 'urgent' : 'attention',
      subject: 'Adericel platform health: ' + health.status,
      message:
        'Adericel itself needs attention. These are platform problems, not customer assurance ' +
        'problems — but they will show up as customer Unknowns if left.\\n\\n' + lines.join('\\n'),
      correlationId: $execution.id,
    },
  },
];`,
    ),
    ifNode('Degraded?', [1100, 0], {
      left: '={{ $json.degraded }}',
      operator: 'true',
      type: 'boolean',
    }),
    executeSubWorkflow('Alert', [1340, -80], WORKFLOW_IDS.notifications),
    node('Healthy', 'n8n-nodes-base.noOp', 1, {}, [1340, 80]),
  ];

  let connections = chain(
    'Every 15 minutes',
    'Configuration',
    'Read health',
    'Read outbox',
    'Assess platform health',
    'Degraded?',
  );
  connections = connect(connections, 'Degraded?', 'Alert', 0);
  connections = connect(connections, 'Degraded?', 'Healthy', 1);

  return workflow({
    id: WORKFLOW_IDS.healthMonitor,
    name: 'Adericel — 18 Health monitor',
    description:
      "Watches Adericel's own health and dead-letter queue, distinguishing platform problems from " +
      'customer assurance problems.',
    active: true,
    nodes,
    connections,
    tags: ['adericel', 'operations', 'health'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

export function errorHandlerWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Error handler\n\n' +
        'Every Adericel workflow names this as its error workflow.\n\n' +
        'A failed workflow must leave the system in a **known** state. This handler ' +
        'records what failed, where, and with which correlation id, so the failure ' +
        'can be traced through Adericel rather than being a gap in the record.\n\n' +
        'It never retries anything: a blind retry of an unknown failure is how one ' +
        'problem becomes two.',
      [-620, -220],
      [560, 320],
      2,
    ),
    node('When a workflow fails', 'n8n-nodes-base.errorTrigger', 1, {}, [0, 0]),
    configurationNode([220, 0]),
    codeNode(
      'Describe the failure',
      [440, 0],
      `/**
 * Turn an n8n execution error into something an operator can act on.
 *
 * The correlation id is recovered from the failing execution's data where
 * possible, so the failure can be joined to everything else that happened in
 * that operation through Adericel's trace endpoint.
 */
const error = $input.first().json;
const execution = error.execution || {};
const workflowInfo = error.workflow || {};

const lastNode = execution.lastNodeExecuted || 'unknown node';
const message = (execution.error && execution.error.message) || 'No error message was recorded.';

let correlationId = null;
try {
  const runData = (execution.data && execution.data.resultData && execution.data.resultData.runData) || {};
  for (const nodeRuns of Object.values(runData)) {
    for (const run of nodeRuns || []) {
      const items = (run.data && run.data.main && run.data.main[0]) || [];
      for (const item of items) {
        if (item && item.json && item.json.correlationId) {
          correlationId = item.json.correlationId;
          break;
        }
      }
    }
  }
} catch {
  // The failing execution may not have produced usable data. The failure is
  // still reported; it simply cannot be joined to an Adericel trace.
}

return [
  {
    json: {
      severity: 'urgent',
      correlationId,
      subject: 'Adericel workflow failed: ' + (workflowInfo.name || 'unknown workflow'),
      message:
        'Workflow: ' + (workflowInfo.name || 'unknown') + '\\n' +
        'Failed at: ' + lastNode + '\\n' +
        'Execution: ' + (execution.id || 'unknown') + '\\n' +
        (correlationId ? 'Correlation: ' + correlationId + '\\n' : '') +
        '\\n' + message +
        '\\n\\nNothing has been retried automatically. Adericel state is unchanged by this failure ' +
        'except where a step had already committed, which the correlation trace will show.',
      workflowName: workflowInfo.name,
      executionId: execution.id,
      failedNode: lastNode,
    },
  },
];`,
    ),
    executeSubWorkflow('Alert', [660, 0], WORKFLOW_IDS.notifications),
  ];

  const connections = chain(
    'When a workflow fails',
    'Configuration',
    'Describe the failure',
    'Alert',
  );

  return workflow({
    id: WORKFLOW_IDS.errorHandler,
    name: 'Adericel — 19 Error handler',
    description:
      'Central error workflow. Records what failed with its correlation id and alerts, without ' +
      'retrying anything.',
    active: true,
    nodes,
    connections,
    tags: ['adericel', 'operations'],
  });
}

export function deadLetterRecoveryWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Dead-letter recovery\n\n' +
        'Adericel never drops an event. One that exhausts its delivery attempts ' +
        'lands in a dead-letter queue and stays there.\n\n' +
        'That matters because a lost `AssuranceStateChanged` means a dashboard is ' +
        'quietly wrong — the worst failure mode for a system whose product is ' +
        'telling the truth.\n\n' +
        'This workflow surfaces the backlog for a person. It does **not** replay ' +
        'automatically: an event that failed eight times needs diagnosis, not a ' +
        'ninth attempt.',
      [-620, -240],
      [560, 340],
      2,
    ),
    scheduleTrigger(
      'Hourly',
      [0, 0],
      { field: 'hours', interval: 1 },
      'Frequent enough that a backlog is noticed within the hour.',
    ),
    configurationNode([220, 0]),
    adericelRequest('Read outbox', [440, 0], {
      url: '={{ $json.apiBaseUrl }}/v1/system/outbox',
    }),
    codeNode(
      'Assess the backlog',
      [660, 0],
      `/**
 * Report a dead-letter backlog, or a delivery lag, in operational terms.
 *
 * A growing pending queue is reported as well as dead letters: an event that
 * has not been delivered yet is not lost, but it does mean everything
 * downstream of it is behind reality.
 */
const outbox = $input.first().json.body || {};
const deadLetter = outbox.deadLetter || 0;
const oldestPending = outbox.oldestPendingAgeSeconds || 0;

if (deadLetter === 0 && oldestPending < 300) {
  return [{ json: { needsAttention: false } }];
}

const lines = [];
if (deadLetter > 0) {
  lines.push(
    deadLetter + ' event(s) have exhausted their delivery attempts. Anything downstream that ' +
      'depended on them — a dashboard, a notification, a workflow — is now out of step with ' +
      "Adericel's own record. Adericel itself remains correct; the consumers do not.",
  );
}
if (oldestPending >= 300) {
  lines.push(
    'The oldest undelivered event is ' + Math.round(oldestPending / 60) + ' minute(s) old. ' +
      'Event delivery is lagging; check that the Adericel worker is running.',
  );
}

return [
  {
    json: {
      needsAttention: true,
      severity: deadLetter > 0 ? 'urgent' : 'attention',
      correlationId: $execution.id,
      subject: 'Adericel: event delivery needs attention',
      message:
        lines.join('\\n\\n') +
        '\\n\\nNothing has been replayed automatically. An event that failed repeatedly needs ' +
        'diagnosis rather than another attempt. Replay from the Adericel operations runbook once ' +
        'the cause is understood.',
    },
  },
];`,
    ),
    ifNode('Needs attention?', [880, 0], {
      left: '={{ $json.needsAttention }}',
      operator: 'true',
      type: 'boolean',
    }),
    executeSubWorkflow('Alert', [1120, -80], WORKFLOW_IDS.notifications),
    node('Delivery healthy', 'n8n-nodes-base.noOp', 1, {}, [1120, 80]),
  ];

  let connections = chain(
    'Hourly',
    'Configuration',
    'Read outbox',
    'Assess the backlog',
    'Needs attention?',
  );
  connections = connect(connections, 'Needs attention?', 'Alert', 0);
  connections = connect(connections, 'Needs attention?', 'Delivery healthy', 1);

  return workflow({
    id: WORKFLOW_IDS.deadLetterRecovery,
    name: 'Adericel — 20 Dead-letter recovery',
    description:
      'Surfaces undelivered and dead-lettered events for diagnosis rather than replaying them ' +
      'automatically.',
    active: true,
    nodes,
    connections,
    tags: ['adericel', 'operations', 'recovery'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}
