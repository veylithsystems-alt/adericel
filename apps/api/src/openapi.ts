import { z } from 'zod';
import {
  ACTION_STATES,
  ASSURANCE_STATES,
  EVENT_TYPES,
  PERMISSIONS,
  ROLES,
  SEVERITIES,
  UNKNOWN_REASONS,
} from '@adericel/domain';
import type { AppContext } from './context.js';

/**
 * OpenAPI document.
 *
 * Generated from the same Zod schemas the routes validate against, so the
 * documentation cannot drift from the implementation the way a hand-maintained
 * spec always eventually does.
 */

const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    correlationId: z.string().optional(),
  }),
});

function json(schema: z.ZodType): Record<string, unknown> {
  return {
    'application/json': {
      schema: z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }),
    },
  };
}

interface OperationSpec {
  summary: string;
  description: string;
  tags: string[];
  security?: Record<string, string[]>[];
  parameters?: Record<string, unknown>[];
  requestBody?: z.ZodType;
  responses: Record<string, { description: string; schema?: z.ZodType }>;
}

const ORG_PARAM = {
  name: 'organisationId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
  description:
    'The organisation this request operates on. Access is decided from the caller grants, never from this value alone.',
};

const ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const MSP_PARAM = {
  name: 'mspId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

function operation(spec: OperationSpec): Record<string, unknown> {
  return {
    summary: spec.summary,
    description: spec.description,
    tags: spec.tags,
    security: spec.security ?? [{ bearerAuth: [] }, { apiKeyAuth: [] }],
    ...(spec.parameters ? { parameters: spec.parameters } : {}),
    ...(spec.requestBody
      ? { requestBody: { required: true, content: json(spec.requestBody) } }
      : {}),
    responses: {
      ...Object.fromEntries(
        Object.entries(spec.responses).map(([status, response]) => [
          status,
          {
            description: response.description,
            ...(response.schema ? { content: json(response.schema) } : {}),
          },
        ]),
      ),
      '400': { description: 'Request validation failed', content: json(errorSchema) },
      '401': { description: 'Authentication required or invalid', content: json(errorSchema) },
      '403': {
        description: 'The caller holds no grant conveying this permission',
        content: json(errorSchema),
      },
      '429': { description: 'Rate limited', content: json(errorSchema) },
      '500': { description: 'Unexpected error', content: json(errorSchema) },
    },
  };
}

export function buildOpenApiDocument(app: AppContext): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Adericel API',
      version: app.config.releaseVersion,
      summary: 'Autonomous organisational security assurance infrastructure',
      description: [
        'Adericel maintains the assurance state of an organisation and can explain, prove and',
        'reproduce every conclusion it reaches.',
        '',
        '## Concepts',
        '',
        '- **Assurance state** — one of SATISFIED, PARTIALLY_SATISFIED, NOT_SATISFIED, EXCEPTED,',
        '  NOT_APPLICABLE or UNKNOWN. UNKNOWN is a first-class value meaning Adericel does not hold',
        '  sufficient trustworthy evidence to make a stronger statement. It is never equivalent to',
        '  secure, insecure, compliant or non-compliant, and it survives every aggregation.',
        '- **Evidence** — an artefact with provenance, integrity and a validity period. Evidence is',
        '  never updated in place: it is superseded or revoked.',
        '- **Claim** — a structured proposition derived from evidence. AI-derived claims enter as',
        '  candidates and cannot influence an assessment until a human confirms them.',
        '- **Assessment** — a reproducible determination by the Truth Engine, recording the engine',
        '  version, ruleset version, ruleset hash and a digest of the exact inputs used.',
        '- **Action** — a controlled change to an external system. Nothing executes without a',
        '  recorded policy decision, and an executed action is not a successful one until',
        '  verification re-observes the desired state.',
        '',
        '## Authentication',
        '',
        'Present either a bearer access token (`Authorization: Bearer <jwt>`) or an API key',
        '(`X-API-Key: adk_...`). Tokens carry identity only; authority is resolved from grants on',
        'every request, so revoking a grant takes effect immediately.',
        '',
        '## Idempotency',
        '',
        'Send an `Idempotency-Key` header on any POST that causes a change. A repeat with the same',
        'key returns the stored response; a repeat with the same key but a different body is',
        'rejected rather than silently returning a stale result.',
        '',
        '## Correlation',
        '',
        'Send `X-Correlation-Id` to continue an existing trace, or read it from the response. The',
        'same id links the request, its events, its assessments and any action it caused, across the',
        'API, the worker, n8n and external systems.',
      ].join('\n'),
      contact: { name: 'Adericel' },
    },
    servers: [{ url: app.config.api.publicUrl, description: 'This deployment' }],
    tags: [
      { name: 'Authentication', description: 'Sessions, tokens and effective authority' },
      { name: 'MSP', description: 'MSP control plane: organisations, baselines, entitlement' },
      { name: 'Portfolio', description: 'Cross-customer intelligence for MSP operators' },
      { name: 'Organisations', description: 'Organisation configuration and export' },
      { name: 'Assurance', description: 'Assurance state, assessment, explanation and replay' },
      { name: 'Evidence', description: 'Evidence, observations and claims' },
      { name: 'Graph', description: 'The Organisational Assurance Graph' },
      { name: 'Findings', description: 'Findings, risks and exceptions' },
      { name: 'Actions', description: 'Proposal, approval, execution and verification' },
      { name: 'Integrations', description: 'Connectors, credentials and collection' },
      { name: 'Observability', description: 'Audit, events, traces and health' },
      { name: 'Webhooks', description: 'Signed inbound ingestion' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
      schemas: {
        AssuranceState: {
          type: 'string',
          enum: ASSURANCE_STATES,
          description:
            'UNKNOWN means Adericel does not hold sufficient trustworthy evidence to make a stronger statement.',
        },
        UnknownReason: { type: 'string', enum: UNKNOWN_REASONS },
        ActionState: { type: 'string', enum: ACTION_STATES },
        Severity: { type: 'string', enum: SEVERITIES },
        EventType: { type: 'string', enum: EVENT_TYPES },
        Role: { type: 'string', enum: ROLES },
        Permission: { type: 'string', enum: PERMISSIONS },
        Error: z.toJSONSchema(errorSchema, { io: 'output' }),
      },
      parameters: { OrganisationId: ORG_PARAM, MspId: MSP_PARAM, ResourceId: ID_PARAM },
    },
    paths: buildPaths(),
  };
}

function buildPaths(): Record<string, unknown> {
  return {
    '/v1/auth/login': {
      post: operation({
        summary: 'Sign in',
        description:
          'Exchange credentials for an access token and a refresh token. Every failure mode — ' +
          'unknown email, wrong password, locked account — returns the same response after the ' +
          'same work, so this endpoint cannot be used to enumerate accounts.',
        tags: ['Authentication'],
        security: [],
        requestBody: z.object({ email: z.string().email(), password: z.string() }),
        responses: {
          '200': {
            description: 'Authenticated',
            schema: z.object({
              accessToken: z.string(),
              refreshToken: z.string(),
              expiresIn: z.number(),
              tokenType: z.string(),
            }),
          },
        },
      }),
    },
    '/v1/auth/refresh': {
      post: operation({
        summary: 'Refresh an access token',
        description:
          'Refresh tokens rotate on use, so a replayed token no longer matches any live session.',
        tags: ['Authentication'],
        security: [],
        requestBody: z.object({ refreshToken: z.string() }),
        responses: { '200': { description: 'Refreshed' } },
      }),
    },
    '/v1/auth/logout': {
      post: operation({
        summary: 'Sign out',
        description: 'Revokes the current session immediately.',
        tags: ['Authentication'],
        responses: { '204': { description: 'Signed out' } },
      }),
    },
    '/v1/auth/me': {
      get: operation({
        summary: 'The caller identity and effective authority',
        description:
          'Returns grants, resolved permissions and reachable scopes. The UI uses this to decide ' +
          'what to render; the API enforces every permission independently on each request.',
        tags: ['Authentication'],
        responses: { '200': { description: 'Principal detail' } },
      }),
    },
    '/v1/msps/{mspId}': {
      get: operation({
        summary: 'MSP detail',
        description: 'Organisation counts and subscription state for one MSP.',
        tags: ['MSP'],
        parameters: [MSP_PARAM],
        responses: { '200': { description: 'MSP detail' } },
      }),
    },
    '/v1/msps/{mspId}/organisations': {
      get: operation({
        summary: 'List organisations',
        description: 'Organisations operated by this MSP.',
        tags: ['MSP'],
        parameters: [MSP_PARAM],
        responses: { '200': { description: 'Organisations' } },
      }),
      post: operation({
        summary: 'Create and onboard an organisation',
        description:
          'Checks plan entitlement, then provisions the organisation in one transaction: graph ' +
          'root, adopted frameworks, controls from the MSP baseline, and requirement mapping. ' +
          'The organisation becomes ACTIVE only once provisioning has committed.',
        tags: ['MSP'],
        parameters: [MSP_PARAM],
        responses: {
          '201': { description: 'Organisation provisioned' },
          '412': { description: 'Plan entitlement does not permit another organisation' },
        },
      }),
    },
    '/v1/msps/{mspId}/portfolio': {
      get: operation({
        summary: 'Portfolio overview',
        description:
          'One row per customer, ordered so the customer needing attention first appears first. ' +
          'Unknown counts are reported separately from failures, because a customer Adericel ' +
          'cannot see is a different problem from one that is visibly failing.',
        tags: ['Portfolio'],
        parameters: [MSP_PARAM],
        responses: { '200': { description: 'Portfolio' } },
      }),
    },
    '/v1/msps/{mspId}/portfolio/recurring-failures': {
      get: operation({
        summary: 'Controls failing across the portfolio',
        description:
          'Where MSP leverage comes from: identifies controls failing across many customers and ' +
          'whether one systemic remediation could address all of them.',
        tags: ['Portfolio'],
        parameters: [MSP_PARAM],
        responses: { '200': { description: 'Recurring failures' } },
      }),
    },
    '/v1/msps/{mspId}/portfolio/deteriorating': {
      get: operation({
        summary: 'Customers whose assurance is deteriorating',
        description: 'Organisations with controls that moved from satisfied to failing or unknown.',
        tags: ['Portfolio'],
        parameters: [MSP_PARAM],
        responses: { '200': { description: 'Deteriorating customers' } },
      }),
    },
    '/v1/msps/{mspId}/portfolio/unknowns': {
      get: operation({
        summary: 'Critical unknowns across the portfolio',
        description:
          'Grouped by reason, with the remedy for each. Most unknowns are Adericel collection ' +
          'problems rather than customer posture problems, and this endpoint says which.',
        tags: ['Portfolio'],
        parameters: [MSP_PARAM],
        responses: { '200': { description: 'Unknowns' } },
      }),
    },
    '/v1/msps/{mspId}/portfolio/approvals': {
      get: operation({
        summary: 'Everything awaiting a human decision',
        description: 'Actions across the whole portfolio that are waiting on approval.',
        tags: ['Portfolio'],
        parameters: [MSP_PARAM],
        responses: { '200': { description: 'Pending approvals' } },
      }),
    },
    '/v1/organisations/{organisationId}': {
      get: operation({
        summary: 'Organisation detail',
        description: 'Configuration and settings for one organisation.',
        tags: ['Organisations'],
        parameters: [ORG_PARAM],
        responses: { '200': { description: 'Organisation' } },
      }),
      patch: operation({
        summary: 'Update organisation configuration',
        description:
          'Settings merge rather than replace, so a partial update cannot silently reset an ' +
          'autonomy level or a retention period.',
        tags: ['Organisations'],
        parameters: [ORG_PARAM],
        responses: { '200': { description: 'Updated' } },
      }),
    },
    '/v1/organisations/{organisationId}/export': {
      get: operation({
        summary: 'Export everything',
        description:
          'The complete assurance record: model, states, assessments, evidence metadata with ' +
          'content hashes, claims, findings, actions, verifications, events and audit. The bundle ' +
          'carries its own content hash so it can be proved authentic.',
        tags: ['Organisations'],
        parameters: [ORG_PARAM],
        responses: { '200': { description: 'Export bundle' } },
      }),
    },
    '/v1/organisations/{organisationId}/assurance': {
      get: operation({
        summary: 'Assurance summary',
        description:
          'Satisfaction and coverage are reported as separate dimensions and are never combined ' +
          'into a single score: 100% satisfaction over 10% coverage and 10% over 100% are not the ' +
          'same organisation, and one number would render them identical.',
        tags: ['Assurance'],
        parameters: [ORG_PARAM],
        responses: {
          '200': {
            description: 'Assurance summary',
            schema: z.object({
              organisationId: z.string(),
              state: z.enum(ASSURANCE_STATES),
              coverage: z.number(),
              satisfactionOfKnown: z.number().nullable(),
            }),
          },
        },
      }),
    },
    '/v1/organisations/{organisationId}/controls/{id}/explanation': {
      get: operation({
        summary: 'Why a control is in its current state',
        description:
          'The complete chain: state, rationale, evaluated reasoning steps, the rule that ran, ' +
          'the ruleset version and hash, the input digest, every supporting claim, and every piece ' +
          'of evidence behind them.',
        tags: ['Assurance'],
        parameters: [ORG_PARAM, ID_PARAM],
        responses: { '200': { description: 'Explanation' } },
      }),
    },
    '/v1/organisations/{organisationId}/assessments': {
      get: operation({
        summary: 'Assessment history',
        description: 'Historical determinations, optionally filtered to state changes only.',
        tags: ['Assurance'],
        parameters: [ORG_PARAM],
        responses: { '200': { description: 'Assessments' } },
      }),
      post: operation({
        summary: 'Run an assessment',
        description:
          'Assess a control, requirement, framework or the organisation. Pass `asOf` to assess as ' +
          'at a historical instant.',
        tags: ['Assurance'],
        parameters: [ORG_PARAM],
        responses: { '201': { description: 'Assessment recorded' } },
      }),
    },
    '/v1/organisations/{organisationId}/assessments/{id}/replay': {
      post: operation({
        summary: 'Replay a historical assessment',
        description:
          'Re-runs the recorded determination against the recorded ruleset version and compares ' +
          'input digests. Reports honestly when inputs have since changed rather than implying a ' +
          'reproduction it cannot perform.',
        tags: ['Assurance'],
        parameters: [ORG_PARAM, ID_PARAM],
        responses: { '200': { description: 'Replay result' } },
      }),
    },
    '/v1/organisations/{organisationId}/evidence': {
      get: operation({
        summary: 'List evidence',
        description:
          'Returns usability alongside status, because usability — freshness, integrity, ' +
          'revocation — is what a rule actually consults.',
        tags: ['Evidence'],
        parameters: [ORG_PARAM],
        responses: { '200': { description: 'Evidence' } },
      }),
      post: operation({
        summary: 'Record evidence',
        description:
          'Content-hash deduplicated: submitting an identical artefact refreshes its collection ' +
          'time rather than creating a duplicate.',
        tags: ['Evidence'],
        parameters: [ORG_PARAM],
        responses: {
          '201': { description: 'Evidence recorded' },
          '200': { description: 'Identical evidence already held; freshness refreshed' },
        },
      }),
    },
    '/v1/organisations/{organisationId}/evidence/upload': {
      post: operation({
        summary: 'Upload a file as evidence',
        description:
          'Multipart upload. The artefact is stored, hashed and linked in one operation.',
        tags: ['Evidence'],
        parameters: [ORG_PARAM],
        responses: { '201': { description: 'Uploaded' } },
      }),
    },
    '/v1/organisations/{organisationId}/evidence/{id}/content': {
      get: operation({
        summary: 'Download the stored artefact',
        description:
          'The artefact is re-hashed before it is served. A mismatch is refused and recorded as ' +
          'an integrity failure rather than returned.',
        tags: ['Evidence'],
        parameters: [ORG_PARAM, ID_PARAM],
        responses: {
          '200': { description: 'Artefact' },
          '422': { description: 'Stored artefact failed its integrity check' },
        },
      }),
    },
    '/v1/organisations/{organisationId}/evidence/{id}/revoke': {
      post: operation({
        summary: 'Revoke evidence',
        description:
          'Controls that relied on this evidence become UNKNOWN, not failing — losing proof is ' +
          'not the same as disproving.',
        tags: ['Evidence'],
        parameters: [ORG_PARAM, ID_PARAM],
        responses: { '200': { description: 'Revoked' } },
      }),
    },
    '/v1/organisations/{organisationId}/observations': {
      post: operation({
        summary: 'Push observations',
        description:
          'For n8n workflows, customer scripts and MSP platforms. Pushed observations travel the ' +
          'same normalisation and provenance pipeline as connector output.',
        tags: ['Evidence'],
        parameters: [ORG_PARAM],
        responses: { '201': { description: 'Processed' } },
      }),
    },
    '/v1/organisations/{organisationId}/claims': {
      get: operation({
        summary: 'List claims',
        description: 'Structured propositions and their evidential basis.',
        tags: ['Evidence'],
        parameters: [ORG_PARAM],
        responses: { '200': { description: 'Claims' } },
      }),
      post: operation({
        summary: 'Assert a claim',
        description:
          'An AI-suggested claim cannot be created as CONFIRMED. It enters as a candidate and the ' +
          'Truth Engine will not consume it until a person confirms it.',
        tags: ['Evidence'],
        parameters: [ORG_PARAM],
        responses: { '201': { description: 'Asserted' } },
      }),
    },
    '/v1/organisations/{organisationId}/claims/{id}/confirm': {
      post: operation({
        summary: 'Confirm a candidate claim',
        description:
          'The AI/truth boundary. Only a signed-in user may confirm; an API key or workflow cannot ' +
          'promote its own output into evidence-backed truth.',
        tags: ['Evidence'],
        parameters: [ORG_PARAM, ID_PARAM],
        responses: { '200': { description: 'Confirmed' } },
      }),
    },
    '/v1/organisations/{organisationId}/nodes': {
      get: operation({
        summary: 'List graph nodes',
        description:
          'People, identities, devices, applications, cloud resources, suppliers and more.',
        tags: ['Graph'],
        parameters: [ORG_PARAM],
        responses: { '200': { description: 'Nodes' } },
      }),
      post: operation({
        summary: 'Upsert a node',
        description: 'Keyed on (kind, externalId), so repeated collection converges on one node.',
        tags: ['Graph'],
        parameters: [ORG_PARAM],
        responses: { '201': { description: 'Upserted' } },
      }),
    },
    '/v1/organisations/{organisationId}/nodes/{id}/neighbourhood': {
      get: operation({
        summary: 'Traverse the graph around a node',
        description: 'Depth-bounded breadth-first traversal, cycle-safe.',
        tags: ['Graph'],
        parameters: [ORG_PARAM, ID_PARAM],
        responses: { '200': { description: 'Neighbourhood' } },
      }),
    },
    '/v1/organisations/{organisationId}/graph/path': {
      get: operation({
        summary: 'Shortest path between two nodes',
        description:
          'The explainability walk — how a finding connects to a requirement. A missing path ' +
          'within the depth bound is a real answer, not an error.',
        tags: ['Graph'],
        parameters: [ORG_PARAM],
        responses: { '200': { description: 'Path or null' } },
      }),
    },
    '/v1/organisations/{organisationId}/findings': {
      get: operation({
        summary: 'List findings',
        description:
          'Findings are fingerprinted, so a persistent problem keeps one record and its age is ' +
          'measured from first detection rather than reset at each reassessment.',
        tags: ['Findings'],
        parameters: [ORG_PARAM],
        responses: { '200': { description: 'Findings' } },
      }),
    },
    '/v1/organisations/{organisationId}/exceptions': {
      get: operation({
        summary: 'List exceptions',
        description: 'Authorised, time-bounded deviations. Every exception has an expiry.',
        tags: ['Findings'],
        parameters: [ORG_PARAM],
        responses: { '200': { description: 'Exceptions' } },
      }),
      post: operation({
        summary: 'Request an exception',
        description:
          'Requires a justification and an expiry date. Open-ended exceptions are refused.',
        tags: ['Findings'],
        parameters: [ORG_PARAM],
        responses: { '201': { description: 'Requested' } },
      }),
    },
    '/v1/organisations/{organisationId}/exceptions/{id}/approve': {
      post: operation({
        summary: 'Approve an exception',
        description:
          'The requester may not approve their own exception; the database enforces this ' +
          'independently of the application.',
        tags: ['Findings'],
        parameters: [ORG_PARAM, ID_PARAM],
        responses: { '200': { description: 'Approved' } },
      }),
    },
    '/v1/organisations/{organisationId}/actions': {
      get: operation({
        summary: 'List actions',
        description: 'Proposed, awaiting approval, executing, verifying and completed actions.',
        tags: ['Actions'],
        parameters: [ORG_PARAM],
        responses: { '200': { description: 'Actions' } },
      }),
      post: operation({
        summary: 'Propose an action',
        description:
          'Evaluates policy immediately and returns the full decision, including which rule ' +
          'matched, the effective autonomy level and how many approvals are required. Nothing is ' +
          'dispatched by this call.',
        tags: ['Actions'],
        parameters: [ORG_PARAM],
        responses: { '201': { description: 'Proposed and evaluated' } },
      }),
    },
    '/v1/organisations/{organisationId}/actions/{id}/decision': {
      post: operation({
        summary: 'Approve or reject an action',
        description:
          'Only a signed-in user may decide. The proposer may not approve their own action, and ' +
          'one person cannot satisfy a two-approver requirement.',
        tags: ['Actions'],
        parameters: [ORG_PARAM, ID_PARAM],
        responses: { '200': { description: 'Decision recorded' } },
      }),
    },
    '/v1/organisations/{organisationId}/actions/{id}/execute': {
      post: operation({
        summary: 'Execute an authorised action',
        description:
          'Exactly-once. The attempt is recorded before dispatch, so a crash between dispatch and ' +
          'response leaves a record a retry finds rather than repeating the side effect. An ' +
          'execution with an unknown outcome blocks retry until it is reconciled.',
        tags: ['Actions'],
        parameters: [ORG_PARAM, ID_PARAM],
        responses: {
          '200': { description: 'Dispatched; verification still required' },
          '409': {
            description: 'A previous attempt had an unknown outcome and needs reconciliation',
          },
        },
      }),
    },
    '/v1/organisations/{organisationId}/actions/{id}/verify': {
      post: operation({
        summary: 'Verify an executed action',
        description:
          'Re-observes the external system through the integration rather than accepting the ' +
          'executor own report. CONFIRMED, REFUTED or INCONCLUSIVE — and INCONCLUSIVE leaves the ' +
          'action UNVERIFIED, never successful.',
        tags: ['Actions'],
        parameters: [ORG_PARAM, ID_PARAM],
        responses: { '200': { description: 'Verification outcome' } },
      }),
    },
    '/v1/connectors': {
      get: operation({
        summary: 'Available connectors',
        description:
          'Each connector documents the permissions it needs in the external system, so an MSP ' +
          'can raise the access request before starting a connection.',
        tags: ['Integrations'],
        responses: { '200': { description: 'Connectors' } },
      }),
    },
    '/v1/organisations/{organisationId}/integrations': {
      get: operation({
        summary: 'List integrations',
        description: 'Credentials are never returned; only whether they are configured.',
        tags: ['Integrations'],
        parameters: [ORG_PARAM],
        responses: { '200': { description: 'Integrations' } },
      }),
      post: operation({
        summary: 'Connect an integration',
        description:
          'Configuration and credentials are validated against the connector schema before ' +
          'storage, and credentials are sealed with the integration id as additional authenticated ' +
          'data so a blob cannot be moved between integrations.',
        tags: ['Integrations'],
        parameters: [ORG_PARAM],
        responses: { '201': { description: 'Connected' } },
      }),
    },
    '/v1/organisations/{organisationId}/integrations/{id}/check': {
      post: operation({
        summary: 'Check the connection',
        description:
          'Reports which permissions the credentials actually hold. Missing permissions are ' +
          'surfaced because they determine which controls will report UNKNOWN.',
        tags: ['Integrations'],
        parameters: [ORG_PARAM, ID_PARAM],
        responses: { '200': { description: 'Connection status' } },
      }),
    },
    '/v1/organisations/{organisationId}/integrations/{id}/collect': {
      post: operation({
        summary: 'Run a collection now',
        description: 'Collects, normalises, records evidence and asserts claims in one pass.',
        tags: ['Integrations'],
        parameters: [ORG_PARAM, ID_PARAM],
        responses: {
          '200': { description: 'Collection completed' },
          '502': { description: 'Collection failed; the integration is marked degraded or failed' },
        },
      }),
    },
    '/v1/organisations/{organisationId}/audit': {
      get: operation({
        summary: 'Audit trail',
        description:
          'Includes denials. A refused request is often the most interesting entry in the table.',
        tags: ['Observability'],
        parameters: [ORG_PARAM],
        responses: { '200': { description: 'Audit entries' } },
      }),
    },
    '/v1/organisations/{organisationId}/events': {
      get: operation({
        summary: 'Domain events',
        description: 'The durable event log for this organisation.',
        tags: ['Observability'],
        parameters: [ORG_PARAM],
        responses: { '200': { description: 'Events' } },
      }),
    },
    '/v1/organisations/{organisationId}/trace/{correlationId}': {
      get: operation({
        summary: 'Follow one operation end to end',
        description:
          'Assembles the events, audit entries, assessments and actions sharing a correlation id ' +
          'into a single ordered timeline across API, worker, n8n and external systems.',
        tags: ['Observability'],
        parameters: [
          ORG_PARAM,
          {
            name: 'correlationId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: { '200': { description: 'Trace' } },
      }),
    },
    '/v1/system/health': {
      get: operation({
        summary: 'System health',
        description:
          'Distinguishes an Adericel operational problem from a customer assurance problem — a ' +
          'failed integration produces UNKNOWN states that would otherwise look like a customer ' +
          'with no controls.',
        tags: ['Observability'],
        responses: { '200': { description: 'Health', schema: z.object({ status: z.string() }) } },
      }),
    },
    '/health/live': {
      get: operation({
        summary: 'Liveness probe',
        description: 'Dependency-free. Answers only whether the process is running.',
        tags: ['Observability'],
        security: [],
        responses: { '200': { description: 'Alive' } },
      }),
    },
    '/health/ready': {
      get: operation({
        summary: 'Readiness probe',
        description:
          'Checks dependencies. Returns 503 when this instance should not receive traffic.',
        tags: ['Observability'],
        security: [],
        responses: {
          '200': { description: 'Ready' },
          '503': { description: 'Not ready' },
        },
      }),
    },
    '/v1/webhooks/observations': {
      post: operation({
        summary: 'Ingest observations by signed webhook',
        description:
          'The signature is the authentication. An HMAC over `{timestamp}.{rawBody}` is verified ' +
          'against `X-Adericel-Signature` before the body is parsed, and deliveries older than ' +
          'five minutes are rejected to prevent replay. The organisation comes from the signed ' +
          'payload, never from the URL.',
        tags: ['Webhooks'],
        security: [],
        parameters: [
          {
            name: 'X-Adericel-Signature',
            in: 'header',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'X-Adericel-Timestamp',
            in: 'header',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: { '202': { description: 'Accepted and processed' } },
      }),
    },
  };
}
