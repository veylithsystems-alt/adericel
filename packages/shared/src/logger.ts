import { redact } from './redaction.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_VALUE: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  readonly level: LogLevel;
  child(bindings: LogFields): Logger;
  trace(fields: LogFields | string, message?: string): void;
  debug(fields: LogFields | string, message?: string): void;
  info(fields: LogFields | string, message?: string): void;
  warn(fields: LogFields | string, message?: string): void;
  error(fields: LogFields | string, message?: string): void;
  fatal(fields: LogFields | string, message?: string): void;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly bindings?: LogFields;
  readonly pretty?: boolean;
  readonly sink?: (line: string) => void;
  readonly nowIso?: () => string;
}

/**
 * Structured JSON logger.
 *
 * Deliberately dependency-free: the log record shape is part of Adericel's
 * operational contract (see docs/operations/observability.md) and is asserted by
 * tests, so it should not drift with a third-party library's defaults.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const threshold = LEVEL_VALUE[level];
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const bindings = options.bindings ?? {};
  const pretty = options.pretty ?? false;

  function emit(recordLevel: LogLevel, fieldsOrMessage: LogFields | string, maybeMessage?: string) {
    if (LEVEL_VALUE[recordLevel] < threshold) return;
    const fields = typeof fieldsOrMessage === 'string' ? {} : fieldsOrMessage;
    const message = typeof fieldsOrMessage === 'string' ? fieldsOrMessage : (maybeMessage ?? '');

    const base: Record<string, unknown> = {
      time: nowIso(),
      level: recordLevel,
      msg: message,
      ...(redact(bindings) as Record<string, unknown>),
      ...(redact(fields) as Record<string, unknown>),
    };

    if (pretty) {
      const { time, level: lvl, msg, ...rest } = base;
      const extras = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
      sink(`${String(time)} ${String(lvl).toUpperCase().padEnd(5)} ${String(msg)}${extras}`);
      return;
    }
    sink(JSON.stringify(base));
  }

  const logger: Logger = {
    level,
    child(extra: LogFields) {
      return createLogger({ ...options, level, bindings: { ...bindings, ...extra } });
    },
    trace: (f, m) => emit('trace', f, m),
    debug: (f, m) => emit('debug', f, m),
    info: (f, m) => emit('info', f, m),
    warn: (f, m) => emit('warn', f, m),
    error: (f, m) => emit('error', f, m),
    fatal: (f, m) => emit('fatal', f, m),
  };
  return logger;
}

/** Logger that discards everything. Used by unit tests and pure libraries. */
export const nullLogger: Logger = createLogger({ level: 'fatal', sink: () => {} });

export function isLogLevel(value: string): value is LogLevel {
  return value in LEVEL_VALUE;
}

/** Turn an unknown thrown value into structured, log-safe fields. */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      err: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...('code' in error ? { code: (error as { code: unknown }).code } : {}),
      },
    };
  }
  return { err: { name: 'NonError', message: String(error) } };
}
