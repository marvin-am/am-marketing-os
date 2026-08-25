import { redact, type Provider } from '@am/domain';

/* -------------------------------------------------------------------------- */
/* Structured logging                                                          */
/* -------------------------------------------------------------------------- */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentMinLevel(): LogLevel {
  const raw = (typeof process !== 'undefined' ? process.env.LOG_LEVEL : undefined) ?? '';
  return (['debug', 'info', 'warn', 'error'] as const).includes(raw as LogLevel)
    ? (raw as LogLevel)
    : 'info';
}

/**
 * Every log line passes through `redact()`. There is no unredacted path on
 * purpose — an accidental `logger.info('submission', submission)` must not leak
 * a lead's e-mail into the platform log drain (spec §28).
 */
function emit(level: LogLevel, message: string, bindings: LogFields, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentMinLevel()]) return;

  const payload = {
    level,
    msg: message,
    time: new Date().toISOString(),
    ...redact(bindings),
    ...redact(fields ?? {}),
  };

  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.warn(line);
}

export function createLogger(bindings: LogFields = {}): Logger {
  return {
    debug: (message, fields) => emit('debug', message, bindings, fields),
    info: (message, fields) => emit('info', message, bindings, fields),
    warn: (message, fields) => emit('warn', message, bindings, fields),
    error: (message, fields) => emit('error', message, bindings, fields),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

export const logger = createLogger({ app: 'am-marketing-os' });

/* -------------------------------------------------------------------------- */
/* Provider call instrumentation                                               */
/* -------------------------------------------------------------------------- */

export interface ProviderCallRecord {
  provider: Provider;
  operation: string;
  durationMs: number;
  ok: boolean;
  statusCode: number | null;
  errorCode: string | null;
  /** Never the response body — only its redacted shape or a hash. */
  responseSummary: unknown;
}

const recentCalls: ProviderCallRecord[] = [];
const MAX_RECENT_CALLS = 200;

export function recordProviderCall(record: ProviderCallRecord): void {
  recentCalls.push(record);
  if (recentCalls.length > MAX_RECENT_CALLS) recentCalls.shift();
  logger.info('provider_call', {
    provider: record.provider,
    operation: record.operation,
    duration_ms: record.durationMs,
    ok: record.ok,
    status: record.statusCode,
    error_code: record.errorCode,
  });
}

export function getRecentProviderCalls(provider?: Provider): ProviderCallRecord[] {
  return provider ? recentCalls.filter((c) => c.provider === provider) : [...recentCalls];
}

/** Test seam. */
export function clearProviderCalls(): void {
  recentCalls.length = 0;
}

/**
 * Wraps a provider call so that latency, outcome and errors are recorded
 * uniformly. Errors are re-thrown — this is instrumentation, not a catch-all.
 */
export async function instrumented<T>(
  provider: Provider,
  operation: string,
  fn: () => Promise<T>,
  summarize: (value: T) => unknown = () => null,
): Promise<T> {
  const started = Date.now();
  try {
    const value = await fn();
    recordProviderCall({
      provider,
      operation,
      durationMs: Date.now() - started,
      ok: true,
      statusCode: null,
      errorCode: null,
      responseSummary: redact(summarize(value)),
    });
    return value;
  } catch (error) {
    const statusCode =
      typeof error === 'object' && error !== null && 'status' in error
        ? Number((error as { status?: unknown }).status) || null
        : null;
    recordProviderCall({
      provider,
      operation,
      durationMs: Date.now() - started,
      ok: false,
      statusCode,
      errorCode: error instanceof Error ? error.name : 'UNKNOWN',
      responseSummary: null,
    });
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Timing                                                                      */
/* -------------------------------------------------------------------------- */

export function startTimer(): () => number {
  const started = Date.now();
  return () => Date.now() - started;
}

/**
 * Deterministic sleep helper used by retry loops. Kept here so that tests can
 * stub a single module rather than every call site.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { redact };
