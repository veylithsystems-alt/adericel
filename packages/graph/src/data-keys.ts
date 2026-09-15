import type { DataKeyStore } from '@adericel/shared';
import type { Database } from './db.js';

/**
 * The data key store, over PostgreSQL.
 *
 * Reads run under platform scope rather than inside the caller's tenant
 * transaction, for a practical reason: unsealing happens in the middle of
 * operations that already hold a tenant transaction open, and nesting a second
 * one would deadlock against it on a busy pool.
 *
 * That does mean row level security is not the control here. The control is in
 * the cipher, which unwraps a key under the organisation the *row* names and
 * refuses when that does not match the organisation the caller asked for. The
 * policy on the table (migration 0010) is the backstop for any other code path
 * that reads it, which is the right way round: the component that must be
 * correct is the one that owns the invariant.
 */
export function createDataKeyStore(db: Database): DataKeyStore {
  return {
    async current(organisationId) {
      return db.withPlatform(async (ctx) => {
        const row = await ctx.one<{ id: string; wrapped_key: string }>(
          `SELECT id, wrapped_key FROM organisation_data_keys
            WHERE organisation_id = $1 AND retired_at IS NULL`,
          [organisationId],
        );
        return row ? { id: row.id, wrapped: row.wrapped_key } : null;
      });
    },

    async byId(dataKeyId) {
      return db.withPlatform(async (ctx) => {
        const row = await ctx.one<{
          id: string;
          wrapped_key: string;
          organisation_id: string;
        }>(`SELECT id, wrapped_key, organisation_id FROM organisation_data_keys WHERE id = $1`, [
          dataKeyId,
        ]);
        return row
          ? { id: row.id, wrapped: row.wrapped_key, organisationId: row.organisation_id }
          : null;
      });
    },

    async create(organisationId, wrapped, rootKeyId) {
      return db.withPlatform(async (ctx) => {
        // ON CONFLICT rather than check-then-insert: two concurrent first
        // credentials for the same organisation would otherwise both generate a
        // key, and the unique index would reject one of them after the caller
        // had already sealed with it.
        //
        // The no-op SET exists so that RETURNING yields the surviving row
        // whether it was inserted or already there. What comes back is the key
        // that is now current, which the cipher treats as authoritative.
        const row = await ctx.oneOrFail<{ id: string; wrapped_key: string }>(
          `INSERT INTO organisation_data_keys (organisation_id, wrapped_key, root_key_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (organisation_id) WHERE retired_at IS NULL DO UPDATE
             SET organisation_id = EXCLUDED.organisation_id
           RETURNING id, wrapped_key`,
          [organisationId, wrapped, rootKeyId],
          'DataKey',
        );
        return { id: row.id, wrapped: row.wrapped_key };
      });
    },
  };
}
