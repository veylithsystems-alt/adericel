import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AdericelError, withRetry, withTimeout, type Logger, type RetryPolicy } from '@adericel/shared';

/**
 * Outbound HTTP for connectors.
 *
 * Connectors take URLs from tenant configuration, which makes them a natural
 * server-side request forgery vector: a customer administrator could point an
 * integration at the metadata service or at an internal address and have
 * Adericel fetch it with Adericel's network position. This client therefore
 * resolves the hostname and refuses private, loopback, link-local and
 * carrier-grade NAT destinations before connecting, and enforces an optional
 * allowlist on top.
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
    if (normalised.startsWith('fe80') || normalised.startsWith('fc') || normalised.startsWith('fd')) {
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

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

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
            : { body: typeof request.body === 'string' ? request.body : JSON.stringify(request.body) }),
          signal,
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
