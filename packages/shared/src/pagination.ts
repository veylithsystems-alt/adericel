import { z } from 'zod';
import { validationFailed } from './errors.js';

/**
 * Keyset (cursor) pagination. Offset pagination is deliberately avoided for
 * large tenant-scoped collections: it degrades badly and can skip or duplicate
 * rows when the underlying data is changing, which is unacceptable for audit
 * and evidence listings.
 */
export interface PageRequest {
  readonly limit: number;
  readonly cursor?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export const pageRequestSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().min(1).optional(),
});

export interface CursorPayload {
  /** Sort key value — normally an ISO timestamp. */
  readonly k: string;
  /** Tie-breaker id, guaranteeing a total ordering. */
  readonly i: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as CursorPayload).k !== 'string' ||
      typeof (parsed as CursorPayload).i !== 'string'
    ) {
      throw new Error('shape');
    }
    return parsed as CursorPayload;
  } catch {
    throw validationFailed('Invalid pagination cursor');
  }
}

/**
 * Build a page from `limit + 1` rows: the extra row proves whether more data
 * exists without a second count query.
 */
export function buildPage<T>(
  rows: readonly T[],
  limit: number,
  toCursor: (row: T) => CursorPayload,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeCursor(toCursor(last)) : null,
  };
}
