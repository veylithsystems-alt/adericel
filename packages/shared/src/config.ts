import { z } from 'zod';

/**
 * Configuration is read once, validated, and then frozen. Anything missing that
 * has security consequences (signing keys, encryption keys) is a hard startup
 * failure outside development — Adericel must never boot into an insecure
 * default in production.
 */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const port = z.coerce.number().int().min(1).max(65535);

export const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  serviceName: z.string().min(1).default('adericel-api'),
  releaseVersion: z.string().default('0.0.0-dev'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  api: z.object({
    host: z.string().default('0.0.0.0'),
    port: port.default(4000),
    publicUrl: z.string().url().default('http://localhost:4000'),
    corsOrigins: z.array(z.string()).default(['http://localhost:5173']),
    bodyLimitBytes: z.coerce
      .number()
      .int()
      .positive()
      .default(2 * 1024 * 1024),
    rateLimit: z.object({
      max: z.coerce.number().int().positive().default(600),
      windowMs: z.coerce.number().int().positive().default(60_000),
    }),
    trustProxy: booleanish.default(false),
  }),

  database: z.object({
    url: z.string().min(1),
    poolMax: z.coerce.number().int().positive().default(10),
    statementTimeoutMs: z.coerce.number().int().positive().default(15_000),
    /** Role used for tenant-scoped queries; RLS applies to it. */
    applicationRole: z.string().default('adericel_app'),
    ssl: booleanish.default(false),
  }),

  auth: z.object({
    /** HS256 signing secret for session tokens. Minimum 32 bytes of entropy. */
    jwtSecret: z.string().min(32),
    accessTokenTtlSeconds: z.coerce.number().int().positive().default(3600),
    refreshTokenTtlSeconds: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60 * 24 * 14),
    issuer: z.string().default('adericel'),
    audience: z.string().default('adericel-api'),
    /** Key used to encrypt integration credentials at rest (32 bytes, base64). */
    credentialEncryptionKey: z.string().min(32),
    passwordPepper: z.string().default(''),
  }),

  /**
   * Outbound notification. Onboarding depends on it: a verification link that
   * is never delivered is a customer who never arrives, and nothing in the
   * product would report it. Production start-up refuses a driver that cannot
   * reach a person.
   */
  notify: z.object({
    driver: z.enum(['log', 'http-email']).default('log'),
    fromAddress: z.string().default('no-reply@adericel.invalid'),
    fromName: z.string().default('Adericel'),
    http: z
      .object({
        endpoint: z.string().default(''),
        authHeader: z.string().default('Authorization'),
        authToken: z.string().default(''),
      })
      .default(() => ({ endpoint: '', authHeader: 'Authorization', authToken: '' })),
  }),

  storage: z.object({
    driver: z.enum(['filesystem', 's3']).default('filesystem'),
    filesystemRoot: z.string().default('./storage/local'),
    s3: z
      .object({
        bucket: z.string().default(''),
        region: z.string().default('eu-west-2'),
        endpoint: z.string().default(''),
        accessKeyId: z.string().default(''),
        secretAccessKey: z.string().default(''),
        forcePathStyle: booleanish.default(true),
      })
      .default(() => ({
        bucket: '',
        region: 'eu-west-2',
        endpoint: '',
        accessKeyId: '',
        secretAccessKey: '',
        forcePathStyle: true,
      })),
    maxUploadBytes: z.coerce
      .number()
      .int()
      .positive()
      .default(50 * 1024 * 1024),
  }),

  worker: z.object({
    pollIntervalMs: z.coerce.number().int().positive().default(1000),
    batchSize: z.coerce.number().int().positive().default(25),
    maxDeliveryAttempts: z.coerce.number().int().positive().default(8),
    visibilityTimeoutMs: z.coerce.number().int().positive().default(60_000),
    enabled: booleanish.default(true),
  }),

  n8n: z.object({
    baseUrl: z.string().default(''),
    /** Shared secret n8n presents on inbound webhooks (HMAC of the raw body). */
    webhookSigningSecret: z.string().default(''),
    /** Adericel API key n8n uses for outbound calls, provisioned per deployment. */
    enabled: booleanish.default(false),
  }),

  ai: z.object({
    enabled: booleanish.default(false),
    provider: z.enum(['none', 'anthropic']).default('none'),
    apiKey: z.string().default(''),
    model: z.string().default('claude-sonnet-5'),
    maxOutputTokens: z.coerce.number().int().positive().default(4096),
    requestTimeoutMs: z.coerce.number().int().positive().default(60_000),
  }),

  billing: z.object({
    /**
     * How payment is taken. `manual` is a real answer, not a placeholder: a
     * deployment that invoices by bank transfer needs no provider, and the
     * checkout routes refuse rather than pretending.
     */
    provider: z.enum(['manual', 'stripe']).default('manual'),
    /** Default wholesale price per organisation per month, in minor units. */
    defaultOrganisationPriceMinor: z.coerce.number().int().nonnegative().default(19_900),
    currency: z.string().length(3).default('GBP'),
    trialDays: z.coerce.number().int().nonnegative().default(30),
    stripe: z
      .object({
        secretKey: z.string().default(''),
        webhookSecret: z.string().default(''),
        apiBaseUrl: z.string().default('https://api.stripe.com'),
      })
      .default(() => ({ secretKey: '', webhookSecret: '', apiBaseUrl: 'https://api.stripe.com' })),
  }),

  security: z.object({
    /** Reject evidence uploads whose declared type is not in this set. */
    allowedEvidenceMimeTypes: z
      .array(z.string())
      .default([
        'application/pdf',
        'application/json',
        'text/plain',
        'text/csv',
        'text/markdown',
        'image/png',
        'image/jpeg',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ]),
    /** Hosts integrations are permitted to reach. Empty = allow all (dev only). */
    egressAllowlist: z.array(z.string()).default([]),
    /** Block requests to private/link-local ranges. Mitigates SSRF. */
    blockPrivateEgress: booleanish.default(true),
  }),
});

export type AdericelConfig = z.infer<typeof configSchema>;

function csv(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const DEV_JWT_SECRET = 'development-only-insecure-jwt-secret-000000';
const DEV_CREDENTIAL_KEY = 'development-only-insecure-credential-key-0';

/** Build the config object from an environment map (defaults to process.env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdericelConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as 'development' | 'test' | 'production';
  const isProduction = nodeEnv === 'production';

  const raw = {
    nodeEnv,
    serviceName: env.ADERICEL_SERVICE_NAME,
    releaseVersion: env.ADERICEL_RELEASE_VERSION,
    logLevel: env.LOG_LEVEL,
    api: {
      host: env.API_HOST,
      port: env.API_PORT,
      publicUrl: env.API_PUBLIC_URL,
      corsOrigins: csv(env.API_CORS_ORIGINS),
      bodyLimitBytes: env.API_BODY_LIMIT_BYTES,
      rateLimit: { max: env.API_RATE_LIMIT_MAX, windowMs: env.API_RATE_LIMIT_WINDOW_MS },
      trustProxy: env.API_TRUST_PROXY,
    },
    database: {
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
      applicationRole: env.DATABASE_APPLICATION_ROLE,
      ssl: env.DATABASE_SSL,
    },
    auth: {
      jwtSecret: env.AUTH_JWT_SECRET ?? (isProduction ? undefined : DEV_JWT_SECRET),
      accessTokenTtlSeconds: env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: env.AUTH_REFRESH_TOKEN_TTL_SECONDS,
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      credentialEncryptionKey:
        env.AUTH_CREDENTIAL_ENCRYPTION_KEY ?? (isProduction ? undefined : DEV_CREDENTIAL_KEY),
      passwordPepper: env.AUTH_PASSWORD_PEPPER,
    },
    notify: {
      driver: env.NOTIFY_DRIVER,
      fromAddress: env.NOTIFY_FROM_ADDRESS,
      fromName: env.NOTIFY_FROM_NAME,
      http: {
        endpoint: env.NOTIFY_HTTP_ENDPOINT,
        authHeader: env.NOTIFY_HTTP_AUTH_HEADER,
        authToken: env.NOTIFY_HTTP_AUTH_TOKEN,
      },
    },
    storage: {
      driver: env.STORAGE_DRIVER,
      filesystemRoot: env.STORAGE_FILESYSTEM_ROOT,
      s3: {
        bucket: env.STORAGE_S3_BUCKET,
        region: env.STORAGE_S3_REGION,
        endpoint: env.STORAGE_S3_ENDPOINT,
        accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID,
        secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY,
        forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
      },
      maxUploadBytes: env.STORAGE_MAX_UPLOAD_BYTES,
    },
    worker: {
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      batchSize: env.WORKER_BATCH_SIZE,
      maxDeliveryAttempts: env.WORKER_MAX_DELIVERY_ATTEMPTS,
      visibilityTimeoutMs: env.WORKER_VISIBILITY_TIMEOUT_MS,
      enabled: env.WORKER_ENABLED,
    },
    n8n: {
      baseUrl: env.N8N_BASE_URL,
      webhookSigningSecret: env.N8N_WEBHOOK_SIGNING_SECRET,
      enabled: env.N8N_ENABLED,
    },
    ai: {
      enabled: env.AI_ENABLED,
      provider: env.AI_PROVIDER,
      apiKey: env.AI_API_KEY,
      model: env.AI_MODEL,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      requestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
    },
    billing: {
      provider: env.BILLING_PROVIDER,
      stripe: {
        secretKey: env.BILLING_STRIPE_SECRET_KEY,
        webhookSecret: env.BILLING_STRIPE_WEBHOOK_SECRET,
        apiBaseUrl: env.BILLING_STRIPE_API_BASE_URL,
      },
      defaultOrganisationPriceMinor: env.BILLING_DEFAULT_ORG_PRICE_MINOR,
      currency: env.BILLING_CURRENCY,
      trialDays: env.BILLING_TRIAL_DAYS,
    },
    security: {
      allowedEvidenceMimeTypes: csv(env.SECURITY_ALLOWED_EVIDENCE_MIME_TYPES),
      egressAllowlist: csv(env.SECURITY_EGRESS_ALLOWLIST),
      blockPrivateEgress: env.SECURITY_BLOCK_PRIVATE_EGRESS,
    },
  };

  const parsed = configSchema.safeParse(prune(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid Adericel configuration:\n${issues}`);
  }

  const config = parsed.data;
  assertProductionSafety(config);
  return Object.freeze(config);
}

/** Remove undefined leaves so Zod defaults apply cleanly. */
function prune<T>(value: T): T {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    out[key] = prune(item);
  }
  return out as T;
}

/** Refuse to run in production with development placeholders in place. */
export function assertProductionSafety(config: AdericelConfig): void {
  if (config.nodeEnv !== 'production') return;
  const failures: string[] = [];
  if (config.auth.jwtSecret === DEV_JWT_SECRET)
    failures.push('AUTH_JWT_SECRET is a dev placeholder');
  if (config.auth.credentialEncryptionKey === DEV_CREDENTIAL_KEY) {
    failures.push('AUTH_CREDENTIAL_ENCRYPTION_KEY is a dev placeholder');
  }
  if (config.api.corsOrigins.includes('*')) failures.push('API_CORS_ORIGINS must not be "*"');
  if (config.storage.driver === 'filesystem') {
    failures.push('STORAGE_DRIVER=filesystem is not supported in production; use s3');
  }
  if (config.notify.driver === 'log') {
    // Accepting signups and writing their verification links to a log file is
    // not onboarding; it is collecting addresses and losing them.
    failures.push(
      'NOTIFY_DRIVER=log cannot deliver to a person, so signup verification and invitations ' +
        'would be silently lost; configure http-email',
    );
  }
  if (config.notify.driver === 'http-email') {
    if (config.notify.http.endpoint === '') failures.push('NOTIFY_HTTP_ENDPOINT is required');
    if (config.notify.http.authToken === '') failures.push('NOTIFY_HTTP_AUTH_TOKEN is required');
    if (config.notify.fromAddress.endsWith('.invalid')) {
      failures.push('NOTIFY_FROM_ADDRESS is still the development placeholder');
    }
  }
  if (config.n8n.enabled && config.n8n.webhookSigningSecret.length < 32) {
    failures.push('N8N_WEBHOOK_SIGNING_SECRET must be at least 32 characters when n8n is enabled');
  }
  if (!config.security.blockPrivateEgress) {
    failures.push('SECURITY_BLOCK_PRIVATE_EGRESS must remain enabled in production');
  }
  if (config.billing.provider === 'stripe') {
    // A Stripe deployment without a webhook secret accepts unsigned billing
    // events, which is a way for anyone who finds the endpoint to activate
    // their own subscription.
    if (config.billing.stripe.secretKey === '') {
      failures.push('BILLING_STRIPE_SECRET_KEY is required when BILLING_PROVIDER=stripe');
    }
    if (config.billing.stripe.webhookSecret.length < 16) {
      failures.push(
        'BILLING_STRIPE_WEBHOOK_SECRET is required when BILLING_PROVIDER=stripe; without it ' +
          'billing webhooks would be accepted unsigned',
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Refusing to start in production:\n${failures.map((f) => `  - ${f}`).join('\n')}`,
    );
  }
}
