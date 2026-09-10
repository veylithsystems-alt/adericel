import { z } from 'zod';
import { OBSERVATION_KINDS, type ObservationInput, type ObservationKind } from '@adericel/domain';
import type {
  ConnectionCheck,
  Connector,
  ConnectorContext,
  CollectionResult,
} from '../connector.js';
import { createHttpClient, type EgressPolicy } from '../http.js';
import {
  connectorManifestSchema,
  DOMAIN_BY_OBSERVATION_KIND,
  type ConnectorManifest,
} from '../manifest.js';
import { predicatesForPayloadKeys } from '../normalise.js';

/**
 * Generic HTTP/JSON connector.
 *
 * Most MSPs run at least one system Adericel will never ship a bespoke
 * connector for — an in-house asset register, a backup tool's reporting API, a
 * PSA export. Rather than forcing a code fork for each, this connector takes a
 * declarative mapping from the source's JSON to Adericel's canonical
 * observation payload.
 *
 * The mapping is configuration, so it is versioned with the integration,
 * reviewable, and cannot execute arbitrary code: field paths and a small set of
 * transforms only.
 */

const transformSchema = z.enum([
  'none',
  'boolean',
  'negate',
  'number',
  'string',
  'iso8601',
  'epochSecondsToIso',
  'presentAsTrue',
]);

const fieldMappingSchema = z.object({
  /** Dotted path into the source record, e.g. `attributes.encryption.state`. */
  from: z.string().min(1),
  /** Canonical payload key, e.g. `diskEncrypted`. */
  to: z.string().min(1),
  transform: transformSchema.default('none'),
  /** Value the source uses to mean "true" for the `boolean` transform. */
  trueValue: z.unknown().optional(),
});

const configSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST']).default('GET'),
  /** JSON body for POST requests. */
  requestBody: z.record(z.string(), z.unknown()).nullable().default(null),
  /** Dotted path to the array of records in the response. Empty = root array. */
  recordsPath: z.string().default(''),
  observationKind: z.enum(OBSERVATION_KINDS),
  sourceSystem: z.string().min(1).max(200),
  /** Field holding the source system's stable identifier for each record. */
  identifierField: z.string().min(1),
  /** Field holding the instant the record describes, if the source provides one. */
  observedAtField: z.string().nullable().default(null),
  mappings: z.array(fieldMappingSchema).min(1),
  /** Simple cursor-based pagination, where supported by the source. */
  pagination: z
    .object({
      nextCursorPath: z.string().min(1),
      cursorQueryParam: z.string().min(1),
      maxPages: z.number().int().min(1).max(100).default(20),
    })
    .nullable()
    .default(null),
  headers: z.record(z.string(), z.string()).default({}),
});

const credentialSchema = z.object({
  /** How the credential is presented. `none` suits an allowlisted internal API. */
  scheme: z.enum(['none', 'bearer', 'header', 'basic']).default('bearer'),
  token: z.string().default(''),
  headerName: z.string().default('authorization'),
  username: z.string().default(''),
  password: z.string().default(''),
});

type Config = z.infer<typeof configSchema>;
type Credentials = z.infer<typeof credentialSchema>;
type FieldMapping = z.infer<typeof fieldMappingSchema>;

export function pluckPath(source: unknown, path: string): unknown {
  if (path === '') return source;
  let current = source;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function applyTransform(value: unknown, mapping: FieldMapping): unknown {
  if (value === undefined || value === null) {
    // `presentAsTrue` is the one transform where absence is meaningful: it maps
    // "the source listed this record" to true, which suits endpoints that only
    // return non-conforming items.
    return mapping.transform === 'presentAsTrue' ? false : undefined;
  }
  switch (mapping.transform) {
    case 'none':
      return value;
    case 'boolean':
      if ('trueValue' in mapping && mapping.trueValue !== undefined) {
        return value === mapping.trueValue;
      }
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string')
        return ['true', 'yes', 'enabled', '1', 'on'].includes(value.toLowerCase());
      if (typeof value === 'number') return value !== 0;
      return undefined;
    case 'negate': {
      const asBoolean = applyTransform(value, { ...mapping, transform: 'boolean' });
      return typeof asBoolean === 'boolean' ? !asBoolean : undefined;
    }
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'string':
      return String(value);
    case 'iso8601': {
      const parsed = new Date(String(value));
      return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
    }
    case 'epochSecondsToIso': {
      const seconds = Number(value);
      if (!Number.isFinite(seconds)) return undefined;
      return new Date(seconds * 1000).toISOString();
    }
    case 'presentAsTrue':
      return true;
  }
}

export function createGenericHttpConnector(deps: {
  egressPolicy: EgressPolicy;
  fetchImpl?: typeof fetch;
}): Connector<Config, Credentials> {
  function authHeaders(credentials: Credentials): Record<string, string> {
    switch (credentials.scheme) {
      case 'bearer':
        return { authorization: `Bearer ${credentials.token}` };
      case 'header':
        return { [credentials.headerName]: credentials.token };
      case 'basic':
        return {
          authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
        };
      case 'none':
        return {};
    }
  }

  function http(context: ConnectorContext) {
    return createHttpClient({
      policy: deps.egressPolicy,
      logger: context.logger,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      userAgent: 'Adericel-Generic/1.0',
    });
  }

  return {
    key: 'generic-http-json',
    name: 'Generic HTTP (JSON)',
    vendor: 'Adericel',
    category: 'MANUAL',
    description:
      'Collects observations from any JSON HTTP endpoint using a declarative field mapping. Intended ' +
      'for in-house systems and vendors without a dedicated connector.',
    authKind: 'API_KEY',
    configSchema,
    credentialSchema,
    requiredPermissions: [
      'Read access to the configured endpoint, scoped to the data Adericel needs and no more.',
    ],
    defaultSchedule: '0 */6 * * *',
    manifest: genericHttpManifest,
    capabilities: [],

    async checkConnection(config, credentials, context): Promise<ConnectionCheck> {
      try {
        const response = await http(context).request({
          method: config.method,
          url: config.url,
          headers: { ...config.headers, ...authHeaders(credentials) },
          ...(config.requestBody ? { body: config.requestBody } : {}),
        });
        const records = pluckPath(response.body, config.recordsPath);
        if (!Array.isArray(records)) {
          return {
            connected: false,
            detail: `Expected an array at path "${config.recordsPath || '(root)'}" but found ${typeof records}.`,
          };
        }
        return {
          connected: true,
          detail: `Endpoint reachable; ${records.length} record(s) in the first page.`,
        };
      } catch (error) {
        return { connected: false, detail: (error as Error).message };
      }
    },

    async collect(config, credentials, context): Promise<CollectionResult> {
      const client = http(context);
      const warnings: string[] = [];
      const observations: ObservationInput[] = [];
      const headers = { ...config.headers, ...authHeaders(credentials) };

      let cursor: string | null = context.cursor;
      let pages = 0;
      const maxPages = config.pagination?.maxPages ?? 1;

      do {
        const response = await client.request({
          method: config.method,
          url: config.url,
          headers,
          ...(config.pagination && cursor
            ? { query: { [config.pagination.cursorQueryParam]: cursor } }
            : {}),
          ...(config.requestBody ? { body: config.requestBody } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });

        const records = pluckPath(response.body, config.recordsPath);
        if (!Array.isArray(records)) {
          warnings.push(`Expected an array at "${config.recordsPath || '(root)'}"; skipping page.`);
          break;
        }

        for (const record of records) {
          const identifier = pluckPath(record, config.identifierField);
          if (identifier === undefined || identifier === null || identifier === '') {
            warnings.push('Skipped a record with no identifier.');
            continue;
          }
          const payload: Record<string, unknown> = { externalId: String(identifier) };
          for (const mapping of config.mappings) {
            const transformed = applyTransform(pluckPath(record, mapping.from), mapping);
            if (transformed !== undefined) payload[mapping.to] = transformed;
          }
          const observedAtRaw = config.observedAtField
            ? pluckPath(record, config.observedAtField)
            : null;
          const observedAt =
            observedAtRaw === null || observedAtRaw === undefined
              ? context.nowIso
              : ((applyTransform(observedAtRaw, {
                  from: '',
                  to: '',
                  transform: 'iso8601',
                }) as string | undefined) ?? context.nowIso);

          observations.push({
            kind: config.observationKind as ObservationKind,
            sourceSystem: config.sourceSystem,
            subjectExternalId: String(identifier),
            observedAt,
            payload,
          });
        }

        cursor = config.pagination
          ? ((pluckPath(response.body, config.pagination.nextCursorPath) as string | null) ?? null)
          : null;
        pages += 1;
      } while (cursor && pages < maxPages);

      return { observations, warnings, partial: warnings.length > 0, cursor };
    },
  };
}

/**
 * Manifest.
 *
 * The predicates are supplied by configuration rather than fixed by code, so
 * the manifest a registry sees is the empty template and the effective one is
 * derived per integration from its field mappings. `genericHttpManifestFor`
 * below does that derivation, which is what lets a customer-specific API
 * participate in collection planning without a code change.
 */
export const genericHttpManifest: ConnectorManifest = connectorManifestSchema.parse({
  id: 'generic.http',
  version: '1.0.0',
  vendor: 'Adericel',
  products: ['Generic HTTP/JSON'],
  category: 'MANUAL',
  authentication: ['API_KEY', 'BEARER', 'BASIC', 'NONE'],
  collect: [],
  execute: [],
  verify: [],
  pagination: true,
  incrementalCollection: true,
  fidelity: 'LIVE',
});

/**
 * The manifest this integration actually has, given its configured mappings.
 *
 * A generic connector's capability is a property of its configuration, not of
 * its code. Deriving it here means a declaratively configured API is a
 * first-class participant in capability discovery and collection planning —
 * the point of the generic connector being genuinely useful rather than a
 * technical curiosity.
 */
export function genericHttpManifestFor(config: {
  readonly observationKind: ObservationKind;
  readonly mappings: readonly { readonly to: string }[];
}): ConnectorManifest {
  // The configuration names canonical *payload keys*; the manifest must declare
  // canonical *predicates*. Deriving one from the other through the same table
  // the normaliser uses is what keeps the claim honest: a manifest promising
  // `diskEncrypted` would resolve to no rule at all, and the control it was
  // meant to answer would go quietly unassessable.
  const predicates = predicatesForPayloadKeys(
    config.observationKind,
    config.mappings.map((mapping) => mapping.to),
  );
  return connectorManifestSchema.parse({
    ...genericHttpManifest,
    collect:
      predicates.length === 0
        ? []
        : [
            {
              key: 'collect.mapped_records',
              title: 'Records mapped by this integration configuration',
              domain: DOMAIN_BY_OBSERVATION_KIND[config.observationKind] ?? 'DOCUMENTATION',
              produces: [config.observationKind],
              predicates,
              requiredPermission: '',
              incremental: true,
            },
          ],
  });
}
