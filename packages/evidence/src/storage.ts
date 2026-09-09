import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AdericelError, bytesHash, type AdericelConfig } from '@adericel/shared';

/**
 * Object storage for evidence artefacts.
 *
 * Large artefacts do not belong in the relational database: they bloat backups,
 * slow every query that touches the table, and cannot be lifecycle-managed
 * independently. The database holds the authoritative metadata and a reference;
 * the bytes live here.
 *
 * Keys are namespaced by organisation. That is a defence-in-depth measure, not
 * the isolation boundary — the boundary is that a caller can only ever obtain a
 * storage key through a tenant-scoped database read.
 */
export interface StoredObject {
  readonly key: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface ObjectStore {
  readonly driver: 'filesystem' | 's3';
  put(
    organisationId: string,
    body: Buffer,
    options: { contentType: string; filename?: string },
  ): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<{ sizeBytes: number } | null>;
  delete(key: string): Promise<void>;
  /** Verify stored bytes still hash to the recorded value. */
  verifyIntegrity(key: string, expectedHash: string): Promise<boolean>;
  ping(): Promise<number>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_RE = /^org\/[0-9a-f-]{36}\/[0-9a-f]{2}\/[0-9a-f-]{36}(\.[a-z0-9]{1,8})?$/i;

function assertSafeKey(key: string): void {
  // Path traversal in an object key would let one tenant's evidence overwrite
  // another's, so keys are validated against a strict shape rather than merely
  // sanitised.
  if (!KEY_RE.test(key) || key.includes('..')) {
    throw new AdericelError('VALIDATION_FAILED', 'Invalid storage key');
  }
}

function extensionFor(contentType: string, filename?: string): string {
  if (filename) {
    const ext = path.extname(filename).replace('.', '').toLowerCase();
    if (/^[a-z0-9]{1,8}$/.test(ext)) return `.${ext}`;
  }
  const map: Record<string, string> = {
    'application/pdf': '.pdf',
    'application/json': '.json',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'text/markdown': '.md',
    'image/png': '.png',
    'image/jpeg': '.jpg',
  };
  return map[contentType] ?? '.bin';
}

function buildKey(organisationId: string, contentType: string, filename?: string): string {
  if (!UUID_RE.test(organisationId)) {
    throw new AdericelError('VALIDATION_FAILED', 'Invalid organisation identifier');
  }
  const id = randomUUID();
  // The two-character shard keeps directory fan-out manageable on filesystem
  // deployments and spreads keys across S3 partitions.
  const shard = createHash('sha256').update(id).digest('hex').slice(0, 2);
  return `org/${organisationId}/${shard}/${id}${extensionFor(contentType, filename)}`;
}

/**
 * Filesystem-backed store.
 *
 * Intended for local development, tests and small single-node deployments. It
 * is a real implementation, not a stub — but it offers no replication and no
 * server-side encryption, so `assertProductionSafety` refuses to start a
 * production process configured to use it.
 */
export function createFilesystemStore(root: string): ObjectStore {
  const absoluteRoot = path.resolve(root);

  function resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(absoluteRoot, key);
    if (!full.startsWith(`${absoluteRoot}${path.sep}`)) {
      throw new AdericelError('VALIDATION_FAILED', 'Storage key escapes the storage root');
    }
    return full;
  }

  return {
    driver: 'filesystem',

    async put(organisationId, body, options): Promise<StoredObject> {
      const key = buildKey(organisationId, options.contentType, options.filename);
      const target = resolve(key);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body, { flag: 'wx' });
      return {
        key,
        contentHash: bytesHash(body),
        sizeBytes: body.byteLength,
        contentType: options.contentType,
      };
    },

    async get(key): Promise<Buffer> {
      try {
        return await readFile(resolve(key));
      } catch (error) {
        throw new AdericelError('NOT_FOUND', 'Stored object not found', {
          safeDetails: { key },
          cause: error,
        });
      }
    },

    async head(key): Promise<{ sizeBytes: number } | null> {
      try {
        const info = await stat(resolve(key));
        return { sizeBytes: info.size };
      } catch {
        return null;
      }
    },

    async delete(key): Promise<void> {
      await rm(resolve(key), { force: true });
    },

    async verifyIntegrity(key, expectedHash): Promise<boolean> {
      const target = resolve(key);
      return new Promise((resolvePromise) => {
        const hash = createHash('sha256');
        const stream = createReadStream(target);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', () => resolvePromise(false));
        stream.on('end', () => resolvePromise(`sha256:${hash.digest('hex')}` === expectedHash));
      });
    },

    async ping(): Promise<number> {
      const started = Date.now();
      await mkdir(absoluteRoot, { recursive: true });
      await stat(absoluteRoot);
      return Date.now() - started;
    },
  };
}

export interface S3StoreOptions {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle?: boolean;
  readonly fetchImpl?: typeof fetch;
}

/**
 * S3-compatible store implemented directly against the REST API with SigV4.
 *
 * Written without the AWS SDK deliberately: the SDK is a very large dependency
 * for six operations, and its transitive surface is the kind of thing that ends
 * up in a supply-chain advisory. Everything here is standard-library crypto.
 * Works against AWS S3, MinIO, Cloudflare R2 and other S3-compatible stores.
 */
export function createS3Store(options: S3StoreOptions): ObjectStore {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint || `https://s3.${options.region}.amazonaws.com`;
  const forcePathStyle = options.forcePathStyle ?? Boolean(options.endpoint);

  function urlFor(key: string): { url: URL; host: string; canonicalPath: string } {
    const base = new URL(endpoint);
    if (forcePathStyle) {
      base.pathname = `/${options.bucket}/${key}`;
    } else {
      base.hostname = `${options.bucket}.${base.hostname}`;
      base.pathname = `/${key}`;
    }
    return {
      url: base,
      host: base.host,
      canonicalPath: base.pathname
        .split('/')
        .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
        .join('/'),
    };
  }

  function hmac(key: Buffer | string, data: string): Buffer {
    return createHmac('sha256', key).update(data, 'utf8').digest();
  }

  async function signedRequest(
    method: string,
    key: string,
    body: Buffer | undefined,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const { url, host, canonicalPath } = urlFor(key);
    const now = new Date();
    const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256')
      .update(body ?? Buffer.alloc(0))
      .digest('hex');

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
    };
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((name) => `${name}:${String(headers[name]).trim()}\n`)
      .join('');

    const canonicalRequest = [
      method,
      canonicalPath,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${options.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');

    const kDate = hmac(`AWS4${options.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, options.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = hmac(kSigning, stringToSign).toString('hex');

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return doFetch(url.toString(), {
      method,
      headers: { ...headers, authorization },
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
  }

  return {
    driver: 's3',

    async put(organisationId, body, putOptions): Promise<StoredObject> {
      const key = buildKey(organisationId, putOptions.contentType, putOptions.filename);
      const response = await signedRequest('PUT', key, body, {
        'content-type': putOptions.contentType,
        'content-length': String(body.byteLength),
      });
      if (!response.ok) {
        throw new AdericelError('DEPENDENCY_UNAVAILABLE', 'Object storage write failed', {
          safeDetails: { status: response.status },
          retryable: response.status >= 500,
        });
      }
      return {
        key,
        contentHash: bytesHash(body),
        sizeBytes: body.byteLength,
        contentType: putOptions.contentType,
      };
    },

    async get(key): Promise<Buffer> {
      assertSafeKey(key);
      const response = await signedRequest('GET', key, undefined);
      if (response.status === 404) {
        throw new AdericelError('NOT_FOUND', 'Stored object not found', { safeDetails: { key } });
      }
      if (!response.ok) {
        throw new AdericelError('DEPENDENCY_UNAVAILABLE', 'Object storage read failed', {
          safeDetails: { status: response.status },
          retryable: response.status >= 500,
        });
      }
      return Buffer.from(await response.arrayBuffer());
    },

    async head(key): Promise<{ sizeBytes: number } | null> {
      assertSafeKey(key);
      const response = await signedRequest('HEAD', key, undefined);
      if (!response.ok) return null;
      return { sizeBytes: Number(response.headers.get('content-length') ?? 0) };
    },

    async delete(key): Promise<void> {
      assertSafeKey(key);
      const response = await signedRequest('DELETE', key, undefined);
      if (!response.ok && response.status !== 404) {
        throw new AdericelError('DEPENDENCY_UNAVAILABLE', 'Object storage delete failed', {
          safeDetails: { status: response.status },
        });
      }
    },

    async verifyIntegrity(key, expectedHash): Promise<boolean> {
      const bytes = await this.get(key);
      return bytesHash(bytes) === expectedHash;
    },

    async ping(): Promise<number> {
      const started = Date.now();
      const { url } = urlFor('');
      const response = await doFetch(url.toString(), { method: 'HEAD' });
      if (response.status >= 500) {
        throw new AdericelError('DEPENDENCY_UNAVAILABLE', 'Object storage is unavailable', {
          retryable: true,
        });
      }
      return Date.now() - started;
    },
  };
}

export function createObjectStore(config: AdericelConfig): ObjectStore {
  if (config.storage.driver === 's3') {
    return createS3Store({
      bucket: config.storage.s3.bucket,
      region: config.storage.s3.region,
      endpoint: config.storage.s3.endpoint || undefined,
      accessKeyId: config.storage.s3.accessKeyId,
      secretAccessKey: config.storage.s3.secretAccessKey,
      forcePathStyle: config.storage.s3.forcePathStyle,
    });
  }
  return createFilesystemStore(config.storage.filesystemRoot);
}
