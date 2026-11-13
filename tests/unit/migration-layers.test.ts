import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLayerManifest, loadMigrations } from '../../scripts/migrate.js';

const MIGRATIONS = new URL('../../database/migrations/', import.meta.url).pathname;

/**
 * Which migrations are Veylith's, and which are the product's.
 *
 * Adericel is sold to MSPs who may self-host it. A customer's database holding
 * Veylith's autonomy gate, business ledger and commercial pipeline is not a
 * tidiness problem — it is the company's own commercial machinery installed on
 * somebody else's infrastructure, backed up by them, and visible to anyone with
 * their database credentials.
 *
 * The classification lives in `layers.json` rather than inside each file,
 * because the runner refuses a migration whose checksum changed after it was
 * applied and adding a marker line would change it. The usual cost of a
 * manifest is drift; these tests remove it by derivation.
 */
describe('the migration layer manifest', () => {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => name.replace(/\.sql$/, ''))
    .sort();

  const sqlOf = (id: string): string => readFileSync(join(MIGRATIONS, `${id}.sql`), 'utf8');

  /** Whether a migration actually touches the company schema. */
  const touchesCompanySchema = (id: string): boolean =>
    /\bveylith\.\w+|SCHEMA\s+veylith\b/i.test(sqlOf(id));

  it('lists every migration that touches the company schema', async () => {
    const manifest = await loadLayerManifest(MIGRATIONS);
    const listed = new Set(manifest.company);
    const unlisted = files.filter((id) => touchesCompanySchema(id) && !listed.has(id));
    expect(unlisted, 'company migrations not listed in layers.json').toEqual([]);
  });

  it('lists nothing that does not touch it', async () => {
    /**
     * The other direction, and the one that would quietly cost a Veylith
     * operator a working deployment: a product migration mis-listed as company
     * would be skipped on a product install, and the table it creates would be
     * missing from every customer database with no error until something read
     * it.
     */
    const manifest = await loadLayerManifest(MIGRATIONS);
    const overlisted = manifest.company.filter((id) => !touchesCompanySchema(id));
    expect(overlisted, 'migrations listed as company that are not').toEqual([]);
  });

  it('names only migrations that exist', async () => {
    const manifest = await loadLayerManifest(MIGRATIONS);
    const phantom = manifest.company.filter((id) => !files.includes(id));
    expect(phantom, 'layers.json names a migration with no file').toEqual([]);
  });
});

describe('a product install applies the product layer only', () => {
  it('skips every company migration', async () => {
    const manifest = await loadLayerManifest(MIGRATIONS);
    const product = await loadMigrations(MIGRATIONS, 'product');
    const ids = new Set(product.map((migration) => migration.id));

    /**
     * An empty company list is a legitimate state, and asserting otherwise was
     * wrong.
     *
     * In the extracted product tree there are no company migrations, so the
     * manifest names none — and this test demanded at least one, failing a tree
     * that was correct. What the test is actually for is that nothing in the
     * company list reaches a product install, so it asserts that; and that the
     * list is not empty *while company migrations exist*, which is the real
     * premise and is checked against the files rather than against a constant.
     */
    const companyFiles = (await loadMigrations(MIGRATIONS, 'all')).filter((migration) =>
      /veylith/i.test(migration.id),
    );
    expect(
      manifest.company.length,
      'company migrations exist and the manifest names none of them',
    ).toBe(companyFiles.length);

    for (const id of manifest.company) {
      expect(ids.has(id), `${id} must not be applied on a product install`).toBe(false);
    }
  });

  it('applies everything else, in order', async () => {
    const all = await loadMigrations(MIGRATIONS, 'all');
    const product = await loadMigrations(MIGRATIONS, 'product');
    const manifest = await loadLayerManifest(MIGRATIONS);

    expect(product.length).toBe(all.length - manifest.company.length);
    // Order is the contract. Skipping a migration must not reorder the rest:
    // a later one referencing an earlier one's table would fail.
    expect(product.map((m) => m.id)).toEqual([...product.map((m) => m.id)].sort());
  });

  it('carries the same checksum for a migration in either layer', async () => {
    // The layer decides whether a migration runs, never what it contains. If
    // the checksum differed by layer, a deployment that switched layers would
    // be told its applied migrations had been edited.
    const all = await loadMigrations(MIGRATIONS, 'all');
    const product = await loadMigrations(MIGRATIONS, 'product');
    const byId = new Map(all.map((migration) => [migration.id, migration.checksum]));
    for (const migration of product) {
      expect(byId.get(migration.id)).toBe(migration.checksum);
    }
  });

  it('refuses to guess when the manifest is missing', async () => {
    /**
     * Fail closed, and closed in the right direction. Without the manifest the
     * runner cannot tell a company migration from a product one, and the
     * default it would reach for — "treat everything as product" — installs
     * Veylith's commercial tables into a customer's database.
     */
    await expect(loadLayerManifest('/nonexistent/migrations')).rejects.toThrow(
      /cannot tell product migrations from company/i,
    );
  });
});
