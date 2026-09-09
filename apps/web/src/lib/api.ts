/**
 * API client.
 *
 * The access token is held in memory only — it is never written to storage, so
 * it cannot be read back after the tab closes.
 *
 * The refresh token is held in sessionStorage. This is a deliberate trade-off
 * rather than an oversight:
 *
 *  - localStorage would persist across tabs and browser restarts, leaving a
 *    long-lived credential on disk for an application that shows other
 *    organisations' security posture. That is not acceptable.
 *  - Memory alone would sign the user out on every page refresh, which for an
 *    operator working through a portfolio all day is bad enough that they would
 *    reach for a workaround.
 *  - sessionStorage is scoped to the tab and cleared when it closes, and the
 *    token rotates on every use, so a copy taken from storage is spent the
 *    moment the legitimate session refreshes.
 *
 * None of this defends against script execution in the page; the defence there
 * is the API's restrictive CSP and not shipping an injection. What this choice
 * does control is credential lifetime and blast radius.
 */

export interface ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly correlationId?: string;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

const REFRESH_STORAGE_KEY = 'adericel.refresh';

let tokens: Tokens | null = null;
let refreshInFlight: Promise<void> | null = null;
const listeners = new Set<(signedIn: boolean) => void>();

function storeRefreshToken(token: string | null): void {
  try {
    if (token === null) sessionStorage.removeItem(REFRESH_STORAGE_KEY);
    else sessionStorage.setItem(REFRESH_STORAGE_KEY, token);
  } catch {
    // Storage can be unavailable (private mode, blocked site data). The session
    // still works; it simply will not survive a page refresh.
  }
}

function readStoredRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Re-establish a session from a stored refresh token after a page load.
 *
 * Resolves to whether a session was recovered. The refresh token rotates on
 * use, so a stale one simply fails and the user signs in again.
 */
export async function restoreSession(): Promise<boolean> {
  const stored = readStoredRefreshToken();
  if (!stored) return false;
  tokens = { accessToken: '', refreshToken: stored, expiresAtMs: 0 };
  try {
    await refresh();
    announce();
    return true;
  } catch {
    clearSession();
    return false;
  }
}

export function onAuthChange(listener: (signedIn: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(): void {
  for (const listener of listeners) listener(tokens !== null);
}

export function isSignedIn(): boolean {
  return tokens !== null;
}

export function clearSession(): void {
  tokens = null;
  storeRefreshToken(null);
  announce();
}

function makeError(status: number, body: unknown): ApiError {
  const parsed = body as { error?: { code?: string; message?: string; details?: Record<string, unknown>; correlationId?: string } };
  const error = new Error(parsed?.error?.message ?? `Request failed with status ${status}`) as {
    -readonly [K in keyof ApiError]: ApiError[K];
  };
  error.name = 'ApiError';
  error.status = status;
  error.code = parsed?.error?.code ?? 'UNKNOWN';
  if (parsed?.error?.details) error.details = parsed.error.details;
  if (parsed?.error?.correlationId) error.correlationId = parsed.error.correlationId;
  return error as ApiError;
}

async function refresh(): Promise<void> {
  if (!tokens) throw makeError(401, { error: { code: 'UNAUTHENTICATED', message: 'Not signed in' } });
  // Several concurrent 401s must not each attempt a refresh: the token rotates
  // on use, so the second attempt would present an already-spent token.
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens!.refreshToken }),
      });
      if (!response.ok) {
        clearSession();
        throw makeError(response.status, await response.json().catch(() => null));
      }
      const body = (await response.json()) as {
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
      };
      tokens = {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        expiresAtMs: Date.now() + body.expiresIn * 1000,
      };
      storeRefreshToken(body.refreshToken);
    } finally {
      refreshInFlight = null;
    }
  })();
  await refreshInFlight;
}

export interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (tokens) headers.authorization = `Bearer ${tokens.accessToken}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

    return fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  };

  // Refresh proactively when the token is close to expiry, so a long-running
  // page does not fail a request the user has just triggered.
  if (tokens && tokens.expiresAtMs - Date.now() < 60_000) {
    await refresh().catch(() => undefined);
  }

  let response = await send();
  if (response.status === 401 && tokens) {
    await refresh();
    response = await send();
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) throw makeError(response.status, body);
  return body as T;
}

export async function signIn(email: string, password: string): Promise<void> {
  const response = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw makeError(response.status, body);

  const parsed = body as { accessToken: string; refreshToken: string; expiresIn: number };
  tokens = {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAtMs: Date.now() + parsed.expiresIn * 1000,
  };
  storeRefreshToken(parsed.refreshToken);
  announce();
}

export async function signOut(): Promise<void> {
  try {
    await api('/v1/auth/logout', { method: 'POST' });
  } finally {
    clearSession();
  }
}
