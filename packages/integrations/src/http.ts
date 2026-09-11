import { lookup as dnsLookupCallback } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  AdericelError,
  withRetry,
  withTimeout,
  type Logger,
  type RetryPolicy,
} from '@adericel/shared';

/**
 * Outbound HTTP for connectors.
 *
 * Connectors take URLs from tenant configuration, which makes them a natural
 * server-side request forgery vector: a customer administrator could point an
 * integration at the metadata service or at an internal address and have
 * Adericel fetch it with Adericel's network position. This client refuses
 * private, loopback, link-local and carrier-grade NAT destinations, and
 * enforces an optional allowlist on top.
 *
 * The check happens in two places, and the second one is the one that matters.
 * `assertEgressAllowed` runs first because it fails fast with a message naming
 * the rule that was broken. But a check that resolves a hostname and then hands
 * the *name* to fetch leaves a window: the resolver is consulted again when the
 * socket opens, and a record with a one-second time to live can answer
 * differently the second time. That is DNS rebinding, and it defeats
 * resolve-then-fetch entirely.
 *
 * So the authoritative check is installed inside the connection, as the lookup
 * the socket itself uses. There is one resolution, its result is checked, and
 * the address handed to the socket is the address that was checked. There is no
 * window because there is no second lookup.
 */

export interface EgressPolicy {
  /** Hostnames (or `.suffix` patterns) connectors may reach. Empty = any public host. */
  readonly allowlist: readonly string[];
  readonly blockPrivate: boolean;
}

export const PERMISSIVE_EGRESS: EgressPolicy = { allowlist: [], blockPrivate: false };

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^198\.1[89]\./,
  /^224\./,
  /^240\./,
];

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_V4.some((pattern) => pattern.test(address));
  if (family === 6) {
    const normalised = address.toLowerCase();
    if (normalised === '::1' || normalised === '::') return true;
    if (
      normalised.startsWith('fe80') ||
      normalised.startsWith('fc') ||
      normalised.startsWith('fd')
    ) {
      return true;
    }
    // IPv4-mapped addresses would otherwise bypass the v4 checks entirely.
    const mapped = normalised.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const lower = host.toLowerCase();
  return allowlist.some((entry) => {
    const pattern = entry.toLowerCase();
    return pattern.startsWith('.') ? lower.endsWith(pattern) : lower === pattern;
  });
}

export async function assertEgressAllowed(
  url: string,
  policy: EgressPolicy,
  resolver: (host: string) => Promise<string[]> = defaultResolver,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AdericelError('VALIDATION_FAILED', 'Invalid integration URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AdericelError('VALIDATION_FAILED', `Unsupported URL scheme ${parsed.protocol}`);
  }
  if (!hostAllowed(parsed.hostname, policy.allowlist)) {
    throw new AdericelError('FORBIDDEN', 'Destination host is not on the egress allowlist', {
      safeDetails: { host: parsed.hostname },
    });
  }
  if (!policy.blockPrivate) return;

  if (parsed.protocol !== 'https:') {
    throw new AdericelError('FORBIDDEN', 'Plaintext HTTP egress is not permitted');
  }

  const addresses = isIP(parsed.hostname)
    ? [parsed.hostname]
    : await resolver(parsed.hostname).catch(() => {
        throw new AdericelError('DEPENDENCY_UNAVAILABLE', 'Could not resolve destination host', {
          safeDetails: { host: parsed.hostname },
          retryable: true,
        });
      });

  if (addresses.length === 0) {
    throw new AdericelError('DEPENDENCY_UNAVAILABLE', 'Destination host resolved to no addresses');
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new AdericelError('FORBIDDEN', 'Destination resolves to a non-public address', {
        safeDetails: { host: parsed.hostname },
      });
    }
  }
}

async function defaultResolver(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true });
  return results.map((r) => r.address);
}

export interface HttpClientOptions {
  readonly policy: EgressPolicy;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly fetchImpl?: typeof fetch;
  readonly resolver?: (host: string) => Promise<string[]>;
  readonly userAgent?: string;
}

export interface HttpRequest {
  readonly method?: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Maximum response size accepted, guarding against memory exhaustion. */
  readonly maxBytes?: number;
}

export interface HttpResponse<T = unknown> {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: T;
  readonly durationMs: number;
}

export interface HttpClient {
  request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>>;
  json<T = unknown>(request: HttpRequest): Promise<T>;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * A DNS lookup that refuses to return a non-public address.
 *
 * This is the SSRF control. It runs at connect time, on the result the socket
 * will actually use, so a record that changed between validation and connection
 * is rejected rather than followed.
 */
export function createGuardedLookup(): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    dnsLookupCallback(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '');
        return;
      }

      const resolved = addresses as { address: string; family: number }[];
      const permitted = resolved.filter((entry) => !isPrivateAddress(entry.address));

      // Every address is checked, not just the first. A host that resolves to
      // one public and one private address is a rebinding attempt with extra
      // steps: the socket may pick either, so neither is acceptable.
      if (permitted.length !== resolved.length || permitted.length === 0) {
        const blocked = Object.assign(
          new Error(
            `Refusing to connect to ${hostname}: resolves to a non-public address`,
          ) as NodeJS.ErrnoException,
          { code: 'EADERICELBLOCKED' },
        );
        callback(blocked, '');
        return;
      }

      if (lookupOptions.all) {
        callback(null, permitted);
      } else {
        const first = permitted[0]!;
        callback(null, first.address, first.family);
      }
    });
  };
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const timeoutMs = options.timeoutMs ?? 30_000;

  // When the policy permits private egress — development, and the test harness
  // — there is nothing to pin and the platform's own fetch is used unchanged.
  const agent = options.policy.blockPrivate
    ? new Agent({ connect: { lookup: createGuardedLookup() } })
    : null;

  const doFetch: typeof fetch = options.fetchImpl
    ? options.fetchImpl
    : agent
      ? (input, init) =>
          undiciFetch(input as string, {
            ...(init as Record<string, unknown>),
            dispatcher: agent,
          }) as unknown as Promise<Response>
      : fetch;

  async function once<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    const url = new URL(request.url);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    await assertEgressAllowed(url.toString(), options.policy, options.resolver);

    const started = Date.now();
    const response = await withTimeout(
      async (timeoutSignal) => {
        const signal = request.signal
          ? AbortSignal.any([request.signal, timeoutSignal])
          : timeoutSignal;
        return doFetch(url.toString(), {
          method: request.method ?? 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': options.userAgent ?? 'Adericel/1.0',
            ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...request.headers,
          },
          ...(request.body === undefined
            ? {}
            : {
                body:
                  typeof request.body === 'string' ? request.body : JSON.stringify(request.body),
              }),
          signal,
          // Redirects are refused outright rather than re-validated. A redirect
          // is a second destination chosen by the upstream rather than by
          // configuration, and no integration Adericel supports needs one.
          redirect: 'error',
        });
      },
      request.timeoutMs ?? timeoutMs,
      `HTTP ${request.method ?? 'GET'} ${url.host}`,
    );

    const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > maxBytes) {
      throw new AdericelError('INTEGRATION_ERROR', 'Response exceeds the permitted size', {
        safeDetails: { declaredLength, maxBytes },
      });
    }

    const text = await response.text();
    if (text.length > maxBytes) {
      throw new AdericelError('INTEGRATION_ERROR', 'Response exceeds the permitted size', {
        safeDetails: { maxBytes },
      });
    }

    const contentType = response.headers.get('content-type') ?? '';
    let body: unknown = text;
    if (contentType.includes('json') && text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new AdericelError('INTEGRATION_ERROR', 'Response was not valid JSON', {
          safeDetails: { status: response.status },
        });
      }
    }

    if (response.status === 429 || response.status >= 500) {
      throw new AdericelError('INTEGRATION_ERROR', `Upstream returned ${response.status}`, {
        safeDetails: { status: response.status, host: url.host },
        retryable: true,
      });
    }
    if (response.status >= 400) {
      throw new AdericelError('INTEGRATION_ERROR', `Upstream returned ${response.status}`, {
        safeDetails: { status: response.status, host: url.host },
        retryable: false,
      });
    }

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: body as T,
      durationMs: Date.now() - started,
    };
  }

  return {
    async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
      return withRetry(() => once<T>(request), {
        ...(options.retryPolicy ? { policy: options.retryPolicy } : {}),
        onRetry: ({ attempt, delayMs }) => {
          options.logger.warn(
            { attempt, delayMs, url: safeUrl(request.url), method: request.method ?? 'GET' },
            'retrying upstream request',
          );
        },
      });
    },
    async json<T>(request: HttpRequest): Promise<T> {
      const response = await this.request<T>(request);
      return response.body;
    },
  };
}

/** URL with query string removed — query strings routinely carry tokens. */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}
