/**
 * Log redaction.
 *
 * Adericel handles other organisations' security posture. A log line that
 * accidentally contains a bearer token, an API key, or the body of a piece of
 * evidence is a security incident, so redaction is applied centrally rather
 * than left to each call site.
 */
const SENSITIVE_KEY_PATTERN =
  /^(password|passwd|secret|token|api[-_]?key|apikey|authorization|auth|credential|credentials|private[-_]?key|client[-_]?secret|refresh[-_]?token|access[-_]?token|session|cookie|set-cookie|signature|otp|mfa[-_]?code|ssn|pan|card[-_]?number)$/i;

const SENSITIVE_SUBSTRING_PATTERN = /(secret|password|credential|private_key|privatekey)/i;

export const REDACTED = '[redacted]';

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || SENSITIVE_SUBSTRING_PATTERN.test(key);
}

export interface RedactOptions {
  /** Maximum depth to walk before replacing with a marker. */
  readonly maxDepth?: number;
  /** Maximum string length retained; longer strings are truncated. */
  readonly maxStringLength?: number;
  /** Additional keys to redact for a particular call site. */
  readonly extraKeys?: readonly string[];
}

export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 8;
  const maxStringLength = options.maxStringLength ?? 2048;
  const extra = new Set((options.extraKeys ?? []).map((k) => k.toLowerCase()));
  return walk(value, 0, maxDepth, maxStringLength, extra, new WeakSet());
}

function walk(
  value: unknown,
  depth: number,
  maxDepth: number,
  maxStringLength: number,
  extra: Set<string>,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}…[truncated ${value.length - maxStringLength}]`
      : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= maxDepth) return '[depth-limited]';

  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);
  try {
    if (obj instanceof Date) return obj.toISOString();
    if (obj instanceof Error) {
      return { name: obj.name, message: obj.message };
    }
    if (Buffer.isBuffer(obj)) return `[buffer ${obj.byteLength}B]`;
    if (Array.isArray(obj)) {
      return obj
        .slice(0, 100)
        .map((item) => walk(item, depth + 1, maxDepth, maxStringLength, extra, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj as Record<string, unknown>)) {
      out[key] =
        isSensitiveKey(key) || extra.has(key.toLowerCase())
          ? REDACTED
          : walk(item, depth + 1, maxDepth, maxStringLength, extra, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** Mask a token so it can be correlated in logs without being usable. */
export function maskToken(token: string): string {
  if (token.length <= 8) return REDACTED;
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
