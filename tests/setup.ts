/**
 * Global test setup.
 *
 * Unit tests must not require infrastructure, so this file only fixes the
 * environment into a deterministic shape. Suites that genuinely need
 * PostgreSQL opt in through `tests/helpers/database.ts`, which skips cleanly
 * when no test database is configured.
 */
process.env.NODE_ENV = 'test';
process.env.TZ = 'UTC';
process.env.LOG_LEVEL ??= 'fatal';
process.env.AUTH_JWT_SECRET ??= 'test-jwt-secret-value-that-is-long-enough-32';
process.env.AUTH_CREDENTIAL_ENCRYPTION_KEY ??= 'test-credential-encryption-key-32-bytes!!';
process.env.STORAGE_DRIVER ??= 'filesystem';
process.env.STORAGE_FILESYSTEM_ROOT ??= './var/test-storage';
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? 'postgres://adericel:adericel@localhost:5432/adericel_test';
