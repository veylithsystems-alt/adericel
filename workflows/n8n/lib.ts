/**
 * n8n workflow construction helpers.
 *
 * The export is generated rather than hand-written. A few thousand lines of
 * hand-maintained JSON is unreviewable and drifts from the API it calls; a
 * builder can be read, type-checked, and validated against the API surface it
 * targets.
 *
 * Everything here emits the real n8n workflow schema — the same shape
 * `n8n export:workflow --all` produces — so the result imports with
 * `n8n import:workflow --input=adericel.n8n.json` or through the editor.
 */

export interface N8nNode {
  parameters: Record<string, unknown>;
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  credentials?: Record<string, { id: string; name: string }>;
  notes?: string;
  notesInFlow?: boolean;
  alwaysOutputData?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  onError?: 'stopWorkflow' | 'continueRegularOutput' | 'continueErrorOutput';
  executeOnce?: boolean;
  disabled?: boolean;
  webhookId?: string;
}

export interface N8nConnectionTarget {
  node: string;
  type: 'main';
  index: number;
}

export type N8nConnections = Record<string, { main: (N8nConnectionTarget[] | null)[] }>;

export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  nodes: N8nNode[];
  connections: N8nConnections;
  settings: Record<string, unknown>;
  staticData: null;
  meta: Record<string, unknown>;
  pinData: Record<string, unknown>;
  versionId: string;
  tags: { id: string; name: string }[];
}

/**
 * Deterministic identifiers.
 *
 * n8n references sub-workflows by id, so the ids must be stable across
 * regenerations — otherwise every rebuild would break every Execute Workflow
 * node pointing at a sub-workflow.
 */
export function stableId(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i += 1) {
    h1 ^= seed.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ seed.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return `${hex(h1)}${hex(h2)}${hex(h1 ^ h2)}`.slice(0, 16);
}

export const CREDENTIAL = {
  apiKey: { id: 'adericel-api-key', name: 'Adericel API key' },
  webhookAuth: { id: 'adericel-webhook-secret', name: 'Adericel webhook signing secret' },
  smtp: { id: 'adericel-smtp', name: 'Adericel SMTP' },
} as const;

/** Workflow ids, referenced by Execute Workflow nodes. */
export const WORKFLOW_IDS = {
  eventIntake: stableId('adericel.event-intake'),
  router: stableId('adericel.event-router'),
  onboarding: stableId('adericel.organisation-onboarding'),
  evidenceIngestion: stableId('adericel.evidence-ingestion'),
  documentProcessing: stableId('adericel.document-processing'),
  observationNormalisation: stableId('adericel.observation-normalisation'),
  assessment: stableId('adericel.assessment'),
  assuranceChange: stableId('adericel.assurance-change'),
  findingTriage: stableId('adericel.finding-triage'),
  actionProposal: stableId('adericel.action-proposal'),
  approval: stableId('adericel.approval'),
  actionExecution: stableId('adericel.action-execution'),
  verification: stableId('adericel.verification'),
  notifications: stableId('adericel.notifications'),
  reporting: stableId('adericel.reporting'),
  scheduledCollection: stableId('adericel.scheduled-collection'),
  scheduledReassessment: stableId('adericel.scheduled-reassessment'),
  evidenceExpiry: stableId('adericel.evidence-expiry'),
  healthMonitor: stableId('adericel.health-monitor'),
  errorHandler: stableId('adericel.error-handler'),
  deadLetterRecovery: stableId('adericel.dead-letter-recovery'),
  offboarding: stableId('adericel.offboarding'),
  sourceConflict: stableId('adericel.source-conflict'),
  coverageWatch: stableId('adericel.coverage-watch'),
  retentionWatch: stableId('adericel.retention-watch'),
  proofOfValue: stableId('adericel.proof-of-value'),
} as const;

let nodeCounter = 0;

export function resetNodeCounter(): void {
  nodeCounter = 0;
}

function nextNodeId(name: string): string {
  nodeCounter += 1;
  return stableId(`${name}#${nodeCounter}`);
}

export interface NodeOptions {
  notes?: string;
  retry?: boolean;
  onError?: N8nNode['onError'];
  credentials?: Record<string, { id: string; name: string }>;
  executeOnce?: boolean;
  alwaysOutputData?: boolean;
  webhookId?: string;
}

export function node(
  name: string,
  type: string,
  typeVersion: number,
  parameters: Record<string, unknown>,
  position: [number, number],
  options: NodeOptions = {},
): N8nNode {
  const built: N8nNode = {
    parameters,
    id: nextNodeId(name),
    name,
    type,
    typeVersion,
    position,
  };
  if (options.notes) {
    built.notes = options.notes;
    built.notesInFlow = false;
  }
  if (options.credentials) built.credentials = options.credentials;
  if (options.retry) {
    // Transient upstream failures are retried in the node rather than failing
    // the whole workflow; anything still failing after this reaches the error
    // handler with its correlation id intact.
    built.retryOnFail = true;
    built.maxTries = 3;
    built.waitBetweenTries = 2000;
  }
  if (options.onError) built.onError = options.onError;
  if (options.executeOnce) built.executeOnce = true;
  if (options.alwaysOutputData) built.alwaysOutputData = true;
  if (options.webhookId) built.webhookId = options.webhookId;
  return built;
}

/**
 * Configuration node.
 *
 * Every workflow starts by resolving its configuration from the environment, so
 * that no URL, secret or tenant identifier is baked into the export. The
 * fallbacks are the docker-compose service names, which is what a fresh
 * self-hosted deployment will have.
 */
export function configurationNode(position: [number, number]): N8nNode {
  return node(
    'Configuration',
    'n8n-nodes-base.set',
    3.4,
    {
      assignments: {
        assignments: [
          {
            id: 'api-base-url',
            name: 'apiBaseUrl',
            value: "={{ $env.ADERICEL_API_BASE_URL || 'http://adericel-api:4000' }}",
            type: 'string',
          },
          {
            id: 'notify-email',
            name: 'notifyEmail',
            value: "={{ $env.ADERICEL_NOTIFY_EMAIL || '' }}",
            type: 'string',
          },
          {
            id: 'notify-webhook',
            name: 'notifyWebhookUrl',
            value: "={{ $env.ADERICEL_NOTIFY_WEBHOOK_URL || '' }}",
            type: 'string',
          },
          {
            id: 'msp-id',
            name: 'mspId',
            value: "={{ $env.ADERICEL_MSP_ID || '' }}",
            type: 'string',
          },
        ],
      },
      includeOtherFields: true,
      options: {},
    },
    position,
    {
      notes:
        'Resolves configuration from the n8n environment. Nothing in this export contains a URL, ' +
        'a secret or a tenant identifier. Set ADERICEL_API_BASE_URL, ADERICEL_MSP_ID and the ' +
        'notification variables on the n8n container.',
    },
  );
}

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  body?: string;
  notes?: string;
  onError?: N8nNode['onError'];
  retry?: boolean;
  idempotencyKey?: string;
  correlationId?: string;
}

/**
 * An authenticated call to the Adericel API.
 *
 * Every call carries a correlation id so an operation can be followed across
 * n8n, the API, the worker and the external system. Requests that change state
 * also carry an idempotency key, so an n8n retry — which is inevitable — cannot
 * cause the same change twice.
 */
export function adericelRequest(
  name: string,
  position: [number, number],
  options: HttpOptions,
): N8nNode {
  const headerParameters: { name: string; value: string }[] = [
    {
      name: 'X-Correlation-Id',
      value: options.correlationId ?? '={{ $json.correlationId || $execution.id }}',
    },
  ];
  if (options.idempotencyKey) {
    headerParameters.push({ name: 'Idempotency-Key', value: options.idempotencyKey });
  }

  const parameters: Record<string, unknown> = {
    method: options.method ?? 'GET',
    url: options.url,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: { parameters: headerParameters },
    options: {
      timeout: 30000,
      response: { response: { fullResponse: true, neverError: true } },
    },
  };

  if (options.body !== undefined) {
    parameters.sendBody = true;
    parameters.specifyBody = 'json';
    parameters.jsonBody = options.body;
  }

  return node(name, 'n8n-nodes-base.httpRequest', 4.2, parameters, position, {
    credentials: { httpHeaderAuth: CREDENTIAL.apiKey },
    retry: options.retry ?? true,
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.notes ? { notes: options.notes } : {}),
  });
}

export function codeNode(
  name: string,
  position: [number, number],
  code: string,
  notes?: string,
): N8nNode {
  return node(
    name,
    'n8n-nodes-base.code',
    2,
    { jsCode: code, mode: 'runOnceForAllItems' },
    position,
    notes ? { notes } : {},
  );
}

export function ifNode(
  name: string,
  position: [number, number],
  condition: { left: string; operator: string; right?: string; type?: string },
  notes?: string,
): N8nNode {
  return node(
    name,
    'n8n-nodes-base.if',
    2.2,
    {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: stableId(`${name}-cond`),
            leftValue: condition.left,
            rightValue: condition.right ?? '',
            operator: {
              type: condition.type ?? 'string',
              operation: condition.operator,
              ...(condition.right === undefined ? { singleValue: true } : {}),
            },
          },
        ],
        combinator: 'and',
      },
      looseTypeValidation: true,
      options: {},
    },
    position,
    notes ? { notes } : {},
  );
}

export function executeSubWorkflow(
  name: string,
  position: [number, number],
  workflowId: string,
  notes?: string,
): N8nNode {
  return node(
    name,
    'n8n-nodes-base.executeWorkflow',
    1.1,
    {
      source: 'database',
      workflowId,
      mode: 'once',
      options: { waitForSubWorkflow: true },
    },
    position,
    notes ? { notes } : {},
  );
}

export function subWorkflowTrigger(position: [number, number], notes: string): N8nNode {
  return node(
    'When called by another workflow',
    'n8n-nodes-base.executeWorkflowTrigger',
    1,
    { inputSource: 'passthrough' },
    position,
    { notes },
  );
}

export function noOp(name: string, position: [number, number], notes?: string): N8nNode {
  return node(name, 'n8n-nodes-base.noOp', 1, {}, position, notes ? { notes } : {});
}

export function stopAndError(name: string, position: [number, number], message: string): N8nNode {
  return node(name, 'n8n-nodes-base.stopAndError', 1, { errorMessage: message }, position, {
    notes:
      'Stops the execution with a described failure rather than continuing on partial data. ' +
      'The error handler workflow records it against the correlation id.',
  });
}

/**
 * A schedule.
 *
 * The cron form is a separate shape rather than another field on the interval
 * one, because n8n's schedule trigger reads `expression` and ignores
 * `hoursInterval` when the field is `cronExpression`. A caller that passed a
 * cron through the interval shape produced a trigger with a field and no
 * expression: importable, silent, and never firing. That is what
 * `coverageWatchWorkflow` was doing, and the type now makes it impossible.
 */
export type ScheduleRule =
  | { field: 'minutes' | 'hours'; interval: number }
  | { field: 'days'; interval: number; atHour?: number }
  | { field: 'cronExpression'; expression: string };

export function scheduleTrigger(
  name: string,
  position: [number, number],
  rule: ScheduleRule,
  notes: string,
): N8nNode {
  const intervalEntry: Record<string, unknown> = { field: rule.field };
  if (rule.field === 'cronExpression') intervalEntry.expression = rule.expression;
  if (rule.field === 'minutes') intervalEntry.minutesInterval = rule.interval;
  if (rule.field === 'hours') intervalEntry.hoursInterval = rule.interval;
  if (rule.field === 'days') {
    intervalEntry.daysInterval = rule.interval;
    intervalEntry.triggerAtHour = rule.atHour ?? 6;
  }
  return node(
    name,
    'n8n-nodes-base.scheduleTrigger',
    1.2,
    { rule: { interval: [intervalEntry] } },
    position,
    { notes },
  );
}

/** Connect a chain of nodes in order. */
export function chain(...names: string[]): N8nConnections {
  const connections: N8nConnections = {};
  for (let i = 0; i < names.length - 1; i += 1) {
    const from = names[i] as string;
    const to = names[i + 1] as string;
    connections[from] = { main: [[{ node: to, type: 'main', index: 0 }]] };
  }
  return connections;
}

export function connect(
  connections: N8nConnections,
  from: string,
  to: string | string[],
  outputIndex = 0,
): N8nConnections {
  const targets = (Array.isArray(to) ? to : [to]).map((name) => ({
    node: name,
    type: 'main' as const,
    index: 0,
  }));
  const existing = connections[from]?.main ?? [];
  const main = [...existing];
  while (main.length <= outputIndex) main.push(null);
  main[outputIndex] = [...(main[outputIndex] ?? []), ...targets];
  connections[from] = { main };
  return connections;
}

export interface WorkflowSpec {
  id: string;
  name: string;
  description: string;
  active?: boolean;
  nodes: N8nNode[];
  connections: N8nConnections;
  tags: string[];
  errorWorkflowId?: string;
}

export function workflow(spec: WorkflowSpec): N8nWorkflow {
  return {
    id: spec.id,
    name: spec.name,
    active: spec.active ?? false,
    nodes: spec.nodes,
    connections: spec.connections,
    settings: {
      executionOrder: 'v1',
      saveManualExecutions: true,
      // Failures are kept; successes are not, so that an operator looking at
      // the execution list sees problems rather than noise.
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'none',
      saveExecutionProgress: true,
      executionTimeout: 3600,
      timezone: 'Europe/London',
      ...(spec.errorWorkflowId ? { errorWorkflow: spec.errorWorkflowId } : {}),
    },
    staticData: null,
    meta: { description: spec.description, templateCredsSetupCompleted: false },
    pinData: {},
    versionId: stableId(`${spec.id}-version`),
    tags: spec.tags.map((name) => ({ id: stableId(`tag-${name}`), name })),
  };
}

/** A sticky note explaining a workflow, visible when it is opened in the editor. */
export function stickyNote(
  content: string,
  position: [number, number],
  size: [number, number] = [520, 260],
  colour = 7,
): N8nNode {
  return node(
    `Note ${stableId(content).slice(0, 6)}`,
    'n8n-nodes-base.stickyNote',
    1,
    { content, height: size[1], width: size[0], color: colour },
    position,
  );
}
