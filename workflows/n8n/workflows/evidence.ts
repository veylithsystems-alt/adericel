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
 * Evidence ingestion, document processing and normalisation.
 *
 * These workflows feed Adericel; they never decide anything. Normalisation and
 * assessment happen inside Adericel, so that what n8n contributes is transport
 * and orchestration rather than a second, divergent implementation of the
 * truth model.
 */

export function evidenceIngestionWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Evidence ingestion\n\n' +
        'Accepts observations from anywhere — a customer script, an MSP platform, ' +
        'another workflow — and pushes them into Adericel.\n\n' +
        '**n8n does not normalise or assess.** It posts observations to the API, ' +
        'which normalises them deterministically and records provenance. Doing that ' +
        'work here would create a second implementation of the truth model that ' +
        'nobody tests.',
      [-620, -220],
      [560, 300],
      4,
    ),
    node(
      'Observations in',
      'n8n-nodes-base.webhook',
      2,
      {
        httpMethod: 'POST',
        path: 'adericel-observations',
        responseMode: 'responseNode',
        authentication: 'headerAuth',
        options: {},
      },
      [0, 0],
      {
        webhookId: 'adericel-observations',
        notes:
          'Protected by a header credential. Callers present the shared ingestion token; the ' +
          'organisation is taken from the payload and authorised by the Adericel API, never ' +
          'trusted from the caller alone.',
      },
    ),
    configurationNode([220, 0]),
    codeNode(
      'Validate batch',
      [440, 0],
      `/**
 * Structural validation before anything is forwarded.
 *
 * Adericel validates again on receipt — this is not a substitute for that. It
 * exists so a malformed batch fails here with a clear message rather than
 * producing a partial ingest that is harder to reason about afterwards.
 */
const body = $input.first().json.body || {};
const observations = body.observations;

if (!body.organisationId || !/^[0-9a-f-]{36}$/i.test(String(body.organisationId))) {
  throw new Error('organisationId is missing or is not a UUID.');
}
if (!Array.isArray(observations) || observations.length === 0) {
  throw new Error('observations must be a non-empty array.');
}
if (observations.length > 1000) {
  throw new Error('Batches are limited to 1000 observations. Split the batch and retry.');
}

for (const [index, observation] of observations.entries()) {
  if (!observation.kind) throw new Error('Observation ' + index + ' has no kind.');
  if (!observation.sourceSystem) throw new Error('Observation ' + index + ' has no sourceSystem.');
  if (!observation.payload || typeof observation.payload !== 'object') {
    throw new Error('Observation ' + index + ' has no payload object.');
  }
}

return [
  {
    json: {
      organisationId: body.organisationId,
      integrationId: body.integrationId || null,
      observations,
      count: observations.length,
      apiBaseUrl: $('Configuration').first().json.apiBaseUrl,
      correlationId: body.correlationId || $execution.id,
    },
  },
];`,
    ),
    adericelRequest('Post observations', [660, 0], {
      method: 'POST',
      url: '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/observations',
      body:
        '={{ JSON.stringify({ integrationId: $json.integrationId, observations: $json.observations }) }}',
      // The idempotency key is derived from the batch content, so an n8n retry
      // of the same batch is recognised rather than ingested twice.
      idempotencyKey:
        "={{ 'obs-' + $json.organisationId + '-' + require('crypto').createHash('sha256').update(JSON.stringify($json.observations)).digest('hex').slice(0, 32) }}",
      notes:
        'Adericel deduplicates observations on content as well, so a repeated batch converges ' +
        'rather than inflating the evidence base.',
    }),
    ifNode(
      'Accepted?',
      [880, 0],
      { left: '={{ $json.statusCode }}', operator: 'lt', right: '300', type: 'number' },
    ),
    node(
      'Respond accepted',
      'n8n-nodes-base.respondToWebhook',
      1.1,
      {
        respondWith: 'json',
        responseCode: 202,
        responseBody: '={{ JSON.stringify($json.body) }}',
      },
      [1120, -100],
    ),
    node(
      'Respond rejected',
      'n8n-nodes-base.respondToWebhook',
      1.1,
      {
        respondWith: 'json',
        responseCode: 502,
        responseBody:
          "={{ JSON.stringify({ accepted: false, status: $json.statusCode, detail: $json.body }) }}",
      },
      [1120, 100],
      {
        notes:
          'The caller is told the ingest failed and with what status, so it can retry rather than ' +
          'silently losing the batch.',
      },
    ),
  ];

  let connections = chain('Observations in', 'Configuration', 'Validate batch', 'Post observations');
  connections = connect(connections, 'Post observations', 'Accepted?');
  connections = connect(connections, 'Accepted?', 'Respond accepted', 0);
  connections = connect(connections, 'Accepted?', 'Respond rejected', 1);

  return workflow({
    id: WORKFLOW_IDS.evidenceIngestion,
    name: 'Adericel — 03 Evidence ingestion',
    description:
      'Accepts observation batches over an authenticated webhook and forwards them to the ' +
      'Adericel API for normalisation and provenance.',
    active: true,
    nodes,
    connections,
    tags: ['adericel', 'evidence'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

/**
 * Document processing.
 *
 * A document arrives — a penetration test report, a supplier certificate, a
 * policy. It is stored as evidence immediately, because the artefact itself is
 * the proof. Any AI extraction from it is recorded separately as CANDIDATE
 * claims that the Truth Engine will refuse to use until a person confirms them.
 */
export function documentProcessingWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Document processing\n\n' +
        'The **AI/truth boundary** is enforced here.\n\n' +
        '1. The document is stored as evidence. That is the proof, and it is ' +
        'hash-verified on upload.\n' +
        '2. If AI extraction is enabled, whatever it produces enters as ' +
        '`AI_SUGGESTED` / `CANDIDATE` claims.\n' +
        '3. The Truth Engine **refuses** to consume an unconfirmed AI claim. A ' +
        'person must confirm it, and only a signed-in user can.\n\n' +
        'An extraction confidence is recorded against the claim. It describes the ' +
        'extraction, never the organisation, and it is never presented as a ' +
        'probability that the organisation is secure.',
      [-620, -240],
      [560, 360],
      3,
    ),
    subWorkflowTrigger(
      [0, 0],
      'Called with { organisationId, documentUrl or binary, title, sourceSystem, correlationId }.',
    ),
    configurationNode([220, 0]),
    adericelRequest('Record document as evidence', [440, 0], {
      method: 'POST',
      url: '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/evidence',
      body: `={{ JSON.stringify({
  sourceType: 'DOCUMENT_UPLOAD',
  collectionMethod: 'AUTOMATED_PUSH',
  sourceSystem: $json.sourceSystem || 'workflow-document-intake',
  sourceReference: $json.documentUrl || null,
  title: $json.title,
  contentType: 'application/json',
  payload: { documentUrl: $json.documentUrl, receivedVia: 'n8n', notes: $json.notes || null },
  integrityLevel: 'UNVERIFIED',
  subjectNodeIds: $json.subjectNodeIds || [],
  metadata: { workflow: 'document-processing', executionId: $execution.id }
}) }}`,
      idempotencyKey: "={{ 'doc-' + $json.organisationId + '-' + ($json.documentUrl || $json.title) }}",
      notes:
        'Integrity is recorded as UNVERIFIED: Adericel received this document from a workflow and ' +
        'can attest to what it stored, not to the document being genuine.',
    }),
    ifNode(
      'AI extraction enabled?',
      [660, 0],
      { left: "={{ $env.ADERICEL_AI_EXTRACTION_ENABLED === 'true' }}", operator: 'true', type: 'boolean' },
      'Extraction is off by default. Adericel works completely without it; AI only ever proposes.',
    ),
    codeNode(
      'Prepare candidate claims',
      [900, -120],
      `/**
 * Shape whatever the extraction step produced into candidate claims.
 *
 * Three properties are enforced here regardless of what the model returned:
 *
 *  - origin is AI_SUGGESTED and status is CANDIDATE, so the Truth Engine will
 *    not consume them;
 *  - extractionConfidence describes the extraction only. It is never an
 *    assurance probability, and Adericel has no path that turns it into one;
 *  - every claim cites the evidence it came from, so a human confirming it can
 *    see the document.
 */
const evidenceResponse = $('Record document as evidence').first().json;
const evidenceId = evidenceResponse.body && evidenceResponse.body.id;
if (!evidenceId) {
  throw new Error('The document was not recorded as evidence; refusing to derive claims from nothing.');
}

const extracted = $input.first().json.extractedClaims || [];

return extracted
  .filter((claim) => claim && claim.predicate)
  .map((claim) => ({
    json: {
      predicate: claim.predicate,
      subjectNodeId: claim.subjectNodeId || null,
      value: claim.value,
      origin: 'AI_SUGGESTED',
      status: 'CANDIDATE',
      extractionConfidence:
        typeof claim.confidence === 'number' ? Math.min(1, Math.max(0, claim.confidence)) : null,
      evidenceIds: [evidenceId],
      metadata: {
        extractedBy: 'n8n-document-processing',
        model: $env.ADERICEL_AI_MODEL || 'unspecified',
        requiresHumanConfirmation: true,
      },
    },
  }));`,
    ),
    adericelRequest('Record candidate claim', [1140, -120], {
      method: 'POST',
      url:
        "={{ $('Configuration').first().json.apiBaseUrl }}/v1/organisations/" +
        "{{ $('When called by another workflow').first().json.organisationId }}/claims",
      body: '={{ JSON.stringify($json) }}',
      onError: 'continueRegularOutput',
      notes:
        'The API refuses an AI_SUGGESTED claim created as CONFIRMED. Promotion is a separate, ' +
        'audited decision that only a signed-in person can make.',
    }),
    codeNode(
      'Summarise for review',
      [1380, -120],
      `/**
 * Tell a human there is something to confirm.
 *
 * The message deliberately says what the claims are NOT: they are candidates,
 * they are not influencing any assurance state, and they will not until someone
 * reviews them.
 */
const items = $input.all();
const trigger = $('When called by another workflow').first().json;
const accepted = items.filter((item) => item.json.statusCode && item.json.statusCode < 300).length;

return [
  {
    json: {
      organisationId: trigger.organisationId,
      correlationId: trigger.correlationId,
      subject: 'Document processed — ' + accepted + ' claim(s) awaiting human confirmation',
      severity: 'info',
      message:
        'The document was stored as evidence. ' + accepted + ' claim(s) were extracted by AI and ' +
        'recorded as candidates. They are NOT influencing any assurance state and will not until ' +
        'a person confirms them. Review them in the organisation claims view.',
    },
  },
];`,
    ),
    executeSubWorkflow('Notify reviewer', [1620, -120], WORKFLOW_IDS.notifications),
    node(
      'Stored without extraction',
      'n8n-nodes-base.noOp',
      1,
      {},
      [900, 140],
      {
        notes:
          'The document is evidence in its own right. Extraction is an optional convenience, not ' +
          'a requirement for the document to count.',
      },
    ),
  ];

  let connections = chain(
    'When called by another workflow',
    'Configuration',
    'Record document as evidence',
    'AI extraction enabled?',
  );
  connections = connect(connections, 'AI extraction enabled?', 'Prepare candidate claims', 0);
  connections = connect(connections, 'AI extraction enabled?', 'Stored without extraction', 1);
  connections = connect(connections, 'Prepare candidate claims', 'Record candidate claim');
  connections = connect(connections, 'Record candidate claim', 'Summarise for review');
  connections = connect(connections, 'Summarise for review', 'Notify reviewer');

  return workflow({
    id: WORKFLOW_IDS.documentProcessing,
    name: 'Adericel — 04 Document processing',
    description:
      'Stores a document as evidence and, where enabled, records AI-extracted claims as candidates ' +
      'that cannot influence assurance until a person confirms them.',
    nodes,
    connections,
    tags: ['adericel', 'evidence', 'ai-boundary'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}

/**
 * Observation normalisation.
 *
 * A thin adapter for sources that push a vendor-shaped payload rather than
 * Adericel's canonical vocabulary. It maps field names only — it makes no
 * judgements — and everything it produces goes through the same ingestion path
 * as any other observation.
 */
export function observationNormalisationWorkflow(): N8nWorkflow {
  const nodes = [
    stickyNote(
      '## Observation normalisation\n\n' +
        'For sources that push a vendor-shaped payload. This maps **field names ' +
        'only**.\n\n' +
        'It deliberately does not decide anything: an absent field stays absent so ' +
        'the control becomes UNKNOWN, rather than being defaulted to a value that ' +
        'would manufacture certainty.',
      [-620, -200],
      [520, 280],
      4,
    ),
    subWorkflowTrigger([0, 0], 'Called with { organisationId, sourceSystem, mapping, records }.'),
    configurationNode([220, 0]),
    codeNode(
      'Map to canonical observations',
      [440, 0],
      `/**
 * Map vendor field names onto Adericel's canonical observation payload.
 *
 * The single most important rule: an absent source field produces an absent
 * canonical field. It is never defaulted. A missing fact must reach the Truth
 * Engine as missing so the control reports UNKNOWN — defaulting it here would
 * turn "we do not know" into "it is fine", which is the exact failure mode
 * Adericel exists to prevent.
 */
const input = $input.first().json;
const records = input.records || [];
const mapping = input.mapping || {};
const kind = input.kind || 'CONFIGURATION_SETTING';

function pluck(source, path) {
  return String(path)
    .split('.')
    .reduce((current, segment) => (current == null ? undefined : current[segment]), source);
}

const observations = records.map((record) => {
  const payload = {};
  for (const [canonicalField, sourcePath] of Object.entries(mapping)) {
    const value = pluck(record, sourcePath);
    if (value !== undefined && value !== null) {
      payload[canonicalField] = value;
    }
  }
  return {
    kind,
    sourceSystem: input.sourceSystem,
    subjectExternalId: payload.externalId ? String(payload.externalId) : null,
    observedAt: input.observedAt || new Date().toISOString(),
    payload,
  };
});

return [
  {
    json: {
      organisationId: input.organisationId,
      integrationId: input.integrationId || null,
      correlationId: input.correlationId || $execution.id,
      observations,
      apiBaseUrl: $('Configuration').first().json.apiBaseUrl,
    },
  },
];`,
    ),
    adericelRequest('Post observations', [660, 0], {
      method: 'POST',
      url: '={{ $json.apiBaseUrl }}/v1/organisations/{{ $json.organisationId }}/observations',
      body:
        '={{ JSON.stringify({ integrationId: $json.integrationId, observations: $json.observations }) }}',
      idempotencyKey:
        "={{ 'norm-' + $json.organisationId + '-' + require('crypto').createHash('sha256').update(JSON.stringify($json.observations)).digest('hex').slice(0, 32) }}",
    }),
  ];

  const connections = chain(
    'When called by another workflow',
    'Configuration',
    'Map to canonical observations',
    'Post observations',
  );

  return workflow({
    id: WORKFLOW_IDS.observationNormalisation,
    name: 'Adericel — 05 Observation normalisation',
    description:
      'Maps vendor-shaped payloads onto Adericel canonical observations without defaulting absent ' +
      'fields, then submits them through the standard ingestion path.',
    nodes,
    connections,
    tags: ['adericel', 'evidence'],
    errorWorkflowId: WORKFLOW_IDS.errorHandler,
  });
}
