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
  noOp,
  stickyNote,
  subWorkflowTrigger,
  workflow,
  type N8nWorkflow,
} from '../lib.js';

/**
 * Intake and routing.
 *
 * Adericel's worker posts every domain event to one signed webhook. This
 * workflow verifies the signature, rejects replays, and dispatches to the
 * sub-workflow that handles that event type.
 *
 * Verification happens before the payload is trusted for anything, routing
 * included: the webhook is a public endpoint, so the HMAC is the authentication.
 */

function switchRule(eventType: string, outputKey: string): Record<string, unknown> {
  return {
    conditions: {
      options: { caseSensitive: true, typeValidation: 'loose', version: 2 },
      conditions: [
        {
          leftValue: '={{ $json.type }}',
          rightValue: eventType,
          operator: { type: 'string', operation: 'equals' },
        },
      ],
      combinator: 'and',
    },
    renameOutput: true,
    outputKey,
  };
}

export function eventIntakeWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Adericel — Event intake\n\n' +
        'Every Adericel domain event arrives here.\n\n' +
        '**Security:** the payload is authenticated by an HMAC over ' +
        '`{timestamp}.{rawBody}` using `ADERICEL_WEBHOOK_SECRET`. Deliveries older ' +
        'than five minutes are rejected, so a captured request cannot be replayed.\n\n' +
        '**Delivery is at-least-once.** Handlers must tolerate duplicates; the ' +
        'event id makes that straightforward.',
      [-620, -200],
      [560, 320],
      4,
    ),
    node(
      'Adericel event',
      'n8n-nodes-base.webhook',
      2,
      {
        httpMethod: 'POST',
        path: 'adericel-events',
        responseMode: 'responseNode',
        options: { rawBody: true },
      },
      [0, 0],
      {
        webhookId: 'adericel-events',
        notes:
          'Point the Adericel worker at this instance with N8N_BASE_URL and N8N_ENABLED=true. ' +
          'It posts to /webhook/adericel-events.',
      },
    ),
    configurationNode([220, 0]),
    codeNode(
      'Verify signature',
      [440, 0],
      `/**
 * Verify the delivery is genuinely from this Adericel deployment.
 *
 * The signature covers "{timestamp}.{rawBody}". The digest is compared in
 * constant time so response timing reveals nothing, and the timestamp window
 * makes a captured delivery useless after five minutes.
 */
const crypto = require('crypto');

const secret = $env.ADERICEL_WEBHOOK_SECRET;
if (!secret) {
  throw new Error(
    'ADERICEL_WEBHOOK_SECRET is not set on this n8n instance. Refusing to accept unauthenticated events.',
  );
}

const item = $input.first();
const headers = item.json.headers ?? {};
const signature = headers['x-adericel-signature'];
const timestamp = headers['x-adericel-timestamp'];
const rawBody = item.binary && item.binary.data
  ? Buffer.from(item.binary.data.data, 'base64').toString('utf8')
  : JSON.stringify(item.json.body ?? {});

if (!signature || !timestamp) {
  throw new Error('Delivery is missing its signature or timestamp headers.');
}

const ageMs = Math.abs(Date.now() - Number(timestamp));
if (!Number.isFinite(ageMs) || ageMs > 300000) {
  throw new Error('Delivery timestamp is outside the five minute window; treating it as a replay.');
}

const expected = crypto
  .createHmac('sha256', secret)
  .update(timestamp + '.' + rawBody)
  .digest('hex');

const provided = Buffer.from(String(signature), 'utf8');
const computed = Buffer.from(expected, 'utf8');
const valid = provided.length === computed.length && crypto.timingSafeEqual(provided, computed);

if (!valid) {
  throw new Error('Signature verification failed. This delivery is not from the configured Adericel deployment.');
}

const event = item.json.body ?? {};
const config = $('Configuration').first().json;

return [
  {
    json: {
      ...event,
      apiBaseUrl: config.apiBaseUrl,
      notifyEmail: config.notifyEmail,
      notifyWebhookUrl: config.notifyWebhookUrl,
      mspId: config.mspId,
      verifiedAt: new Date().toISOString(),
    },
  },
];`,
      'The webhook is public, so the HMAC is the authentication. Nothing downstream runs until this passes.',
    ),
    node(
      'Route by event type',
      'n8n-nodes-base.switch',
      3.2,
      {
        rules: {
          values: [
            switchRule('AssuranceStateChanged', 'assurance-changed'),
            switchRule('FindingCreated', 'finding-created'),
            switchRule('ActionApprovalRequested', 'approval-requested'),
            switchRule('ActionApproved', 'action-approved'),
            switchRule('VerificationRequested', 'verification-requested'),
            switchRule('OrganisationCreated', 'organisation-created'),
            switchRule('EvidenceExpired', 'evidence-expired'),
          ],
        },
        options: { fallbackOutput: 'extra', renameFallbackOutput: 'other' },
      },
      [660, 0],
      {
        notes:
          'Event types with no handler fall through to "other" and are acknowledged. That is a ' +
          'normal state — the event remains durably recorded in Adericel regardless.',
      },
    ),
    executeSubWorkflow('Handle assurance change', [920, -360], WORKFLOW_IDS.assuranceChange),
    executeSubWorkflow('Triage finding', [920, -220], WORKFLOW_IDS.findingTriage),
    executeSubWorkflow('Notify approvers', [920, -80], WORKFLOW_IDS.approval),
    executeSubWorkflow('Execute approved action', [920, 60], WORKFLOW_IDS.actionExecution),
    executeSubWorkflow('Verify action', [920, 200], WORKFLOW_IDS.verification),
    executeSubWorkflow('Complete onboarding', [920, 340], WORKFLOW_IDS.onboarding),
    executeSubWorkflow('Reassess after expiry', [920, 480], WORKFLOW_IDS.assessment),
    noOp('Acknowledge', [920, 620], 'No handler for this event type; acknowledged as received.'),
    node(
      'Respond 202',
      'n8n-nodes-base.respondToWebhook',
      1.1,
      {
        respondWith: 'json',
        responseCode: 202,
        responseBody:
          "={{ JSON.stringify({ accepted: true, eventId: $('Verify signature').first().json.id, correlationId: $('Verify signature').first().json.correlationId }) }}",
      },
      [1220, 130],
      {
        notes:
          'Acknowledged once the event is accepted and dispatched. Adericel treats a 2xx as ' +
          'delivered and will not retry it.',
      },
    ),
  ];

  let connections = chain(
    'Adericel event',
    'Configuration',
    'Verify signature',
    'Route by event type',
  );
  const handlers = [
    'Handle assurance change',
    'Triage finding',
    'Notify approvers',
    'Execute approved action',
    'Verify action',
    'Complete onboarding',
    'Reassess after expiry',
    'Acknowledge',
  ];
  handlers.forEach((handler, index) => {
    connections = connect(connections, 'Route by event type', handler, index);
    connections = connect(connections, handler, 'Respond 202');
  });

  return workflow({
    id: WORKFLOW_IDS.eventIntake,
    name: 'Adericel — 01 Event intake',
    description:
      'Signed webhook receiving every Adericel domain event, verifying its authenticity and ' +
      'dispatching it to the appropriate handler.',
    active: true,
    nodes,
    connections,
    tags: ['adericel', 'intake'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

/**
 * Organisation onboarding.
 *
 * Confirms provisioning committed, triggers a first collection from every
 * configured source, runs a first assessment, and reports what the organisation
 * looks like on day one — including how much of it is still unknown.
 */
export function onboardingWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Organisation onboarding\n\n' +
        'Called on `OrganisationCreated`. Establishes the first assurance picture ' +
        'and reports honestly how much of it is unknown.\n\n' +
        'A new customer with no sources connected is **not** compliant — it is ' +
        'unknown, and the summary says so in those words.',
      [-620, -180],
      [520, 260],
      4,
    ),
    subWorkflowTrigger([0, 0], 'Invoked by the event intake workflow on OrganisationCreated.'),
    configurationNode([220, 0]),
    adericelRequest('Read organisation', [440, 0], {
      url: '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}',
      notes: 'Confirms provisioning committed before any work is done against the organisation.',
    }),
    ifNode(
      'Provisioned?',
      [660, 0],
      { left: '={{ $json.statusCode }}', operator: 'equals', right: '200', type: 'number' },
      'A partially provisioned organisation would produce assurance states that mean nothing.',
    ),
    adericelRequest('List sources', [920, -120], {
      url:
        "={{ $('Configuration').first().json.apiBaseUrl }}/v1/organisations/" +
        "{{ $('When called by another workflow').first().json.organisationId }}/integrations",
    }),
    codeNode(
      'Plan first collection',
      [1140, -120],
      `/**
 * Decide what to collect on day one.
 *
 * An organisation with no sources is a legitimate state: every control needing
 * collected evidence will be UNKNOWN until one is connected. That is reported
 * rather than hidden, because it is the single most useful thing an MSP can
 * learn on the first day.
 */
const response = $input.first().json;
const integrations = (response.body && response.body.integrations) || [];
const trigger = $('When called by another workflow').first().json;
const apiBaseUrl = $('Configuration').first().json.apiBaseUrl;

const base = {
  organisationId: trigger.organisationId,
  correlationId: trigger.correlationId,
  apiBaseUrl,
};

const usable = integrations.filter((integration) => integration.status !== 'DISABLED');

if (usable.length === 0) {
  return [
    {
      json: {
        ...base,
        note:
          'No sources are connected. Every control requiring collected evidence will report ' +
          'UNKNOWN until at least one integration is configured.',
      },
    },
  ];
}

return usable.map((integration) => ({
  json: {
    ...base,
    integrationId: integration.id,
    connectorKey: integration.connectorKey,
    name: integration.name,
  },
}));`,
    ),
    ifNode(
      'Any sources?',
      [1360, -120],
      { left: '={{ $json.integrationId }}', operator: 'exists' },
      'Branches on whether there is anything to collect at all.',
    ),
    adericelRequest('Collect from source', [1600, -240], {
      method: 'POST',
      url:
        '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/integrations/' +
        '{{ $json.integrationId }}/collect',
      onError: 'continueRegularOutput',
      notes:
        'One failing source must not abandon onboarding. The failure is recorded against that ' +
        'integration and its controls report UNKNOWN.',
    }),
    executeSubWorkflow('Run first assessment', [1840, -120], WORKFLOW_IDS.assessment),
    adericelRequest('Read assurance', [2080, -120], {
      url:
        "={{ $('Configuration').first().json.apiBaseUrl }}/v1/organisations/" +
        "{{ $('When called by another workflow').first().json.organisationId }}/assurance",
    }),
    codeNode(
      'Summarise onboarding',
      [2300, -120],
      `/**
 * Report the day-one picture in terms an MSP can act on.
 *
 * Coverage is stated as a count with its denominator. There is deliberately no
 * score: a customer at full satisfaction over eight per cent coverage is not in
 * good shape, and a single number would say otherwise.
 */
const assurance = $input.first().json.body || {};
const counts = assurance.counts || {};
const inScope = assurance.inScope || 0;
const unknown = counts.UNKNOWN || 0;
const failing = counts.NOT_SATISFIED || 0;
const determinate = inScope - unknown;

const message =
  'Adericel can currently speak to ' + determinate + ' of ' + inScope + ' in-scope controls. ' +
  unknown + ' are UNKNOWN — not passing and not failing — because there is not yet sufficient ' +
  'trustworthy evidence. ' +
  (failing > 0 ? failing + ' control(s) are failing outright. ' : '') +
  'Connecting the remaining sources is what reduces the unknown count.';

return [
  {
    json: {
      organisationId: assurance.organisationId,
      correlationId: $('When called by another workflow').first().json.correlationId,
      subject: 'Adericel onboarding complete',
      severity: unknown > determinate ? 'attention' : 'info',
      message,
      counts,
      inScope,
    },
  },
];`,
    ),
    executeSubWorkflow('Notify', [2540, -120], WORKFLOW_IDS.notifications),
    node(
      'Not provisioned',
      'n8n-nodes-base.stopAndError',
      1,
      {
        errorMessage:
          '=Organisation could not be read (HTTP {{ $json.statusCode }}). Onboarding stopped rather than continuing on partial state.',
      },
      [920, 140],
    ),
  ];

  let connections = chain(
    'When called by another workflow',
    'Configuration',
    'Read organisation',
    'Provisioned?',
  );
  connections = connect(connections, 'Provisioned?', 'List sources', 0);
  connections = connect(connections, 'Provisioned?', 'Not provisioned', 1);
  connections = connect(connections, 'List sources', 'Plan first collection');
  connections = connect(connections, 'Plan first collection', 'Any sources?');
  connections = connect(connections, 'Any sources?', 'Collect from source', 0);
  connections = connect(connections, 'Any sources?', 'Run first assessment', 1);
  connections = connect(connections, 'Collect from source', 'Run first assessment');
  connections = connect(connections, 'Run first assessment', 'Read assurance');
  connections = connect(connections, 'Read assurance', 'Summarise onboarding');
  connections = connect(connections, 'Summarise onboarding', 'Notify');

  return workflow({
    id: WORKFLOW_IDS.onboarding,
    name: 'Adericel — 02 Organisation onboarding',
    description:
      'Establishes the first assurance picture for a newly created organisation and reports how ' +
      'much of it remains unknown.',
    nodes,
    connections,
    tags: ['adericel', 'onboarding'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}
