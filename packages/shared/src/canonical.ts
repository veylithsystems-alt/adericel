import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialisation (RFC 8785-style canonicalisation, restricted
 * to the subset Adericel actually stores).
 *
 * Used for:
 *  - ruleset hashing, so an assessment can name exactly which rules ran;
 *  - evidence content identity and duplicate detection;
 *  - assessment input digests, which make replay verifiable.
 *
 * Object keys are sorted by code unit. `undefined` properties are dropped.
 * Non-finite numbers are rejected rather than silently becoming null, because a
 * NaN slipping into a hash would break reproducibility invisibly.
 */
export function canonicalJson(value: unknown): string {
  return serialise(value, new WeakSet());
}

function serialise(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number ${String(value)}`);
      }
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      return 'null';
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
    default:
      break;
  }

  const obj = value as object;
  if (seen.has(obj)) throw new TypeError('canonicalJson: circular reference');
  seen.add(obj);
  try {
    if (obj instanceof Date) return JSON.stringify(obj.toISOString());
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => serialise(item, seen)).join(',')}]`;
    }
    if (obj instanceof Map) {
      const entries = [...obj.entries()].map(([k, v]) => [String(k), v] as const);
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialise(v, seen)}`).join(',')}}`;
    }
    if (obj instanceof Set) {
      const items = [...obj].map((item) => serialise(item, seen)).sort();
      return `[${items.join(',')}]`;
    }

    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${serialise(record[key], seen)}`);
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/** SHA-256 of the canonical serialisation, prefixed with its algorithm. */
export function contentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

/** SHA-256 of raw bytes, prefixed with its algorithm. */
export function bytesHash(bytes: Uint8Array | Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Short, human-quotable prefix of a hash — for logs and UI, never for identity. */
export function shortHash(hash: string): string {
  const [, digest = hash] = hash.split(':');
  return digest.slice(0, 12);
}
