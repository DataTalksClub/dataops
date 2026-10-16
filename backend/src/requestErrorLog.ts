import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One structured log line per 5xx API response.
 *
 * The HTTP boundary (`withApiRequestTelemetry`) opens a request scope and
 * writes the line once the response is known. Routes that catch an exception
 * and turn it into their own 5xx call `recordRequestError` instead of logging
 * it themselves, so the cause rides on that single line rather than on a
 * second, uncorrelated one. Only fixed request metadata and error
 * name/message/cause are written: never bodies, headers, query strings or
 * response payloads.
 */

export const API_REQUEST_FAILED_EVENT = 'api_request_failed';

const MAX_MESSAGE_LENGTH = 500;
const MAX_PATH_LENGTH = 300;
const MAX_CAUSE_DEPTH = 3;
const MAX_STACK_FRAMES = 6;

interface RequestErrorScope {
  error?: unknown;
}

const scopeStorage = new AsyncLocalStorage<RequestErrorScope>();

export function runWithRequestErrorScope<T>(operation: () => Promise<T>): Promise<T> {
  return scopeStorage.run({}, operation);
}

/**
 * Attach a caught exception to the current API request so the boundary's
 * 5xx log line reports it. Outside an API request (tests that call the router
 * directly, local scripts) there is no boundary line, so log it here.
 */
export function recordRequestError(error: unknown): void {
  const scope = scopeStorage.getStore();
  if (scope) {
    scope.error = error;
    return;
  }
  console.error(JSON.stringify({
    event: API_REQUEST_FAILED_EVENT,
    level: 'ERROR',
    error: describeError(error),
  }));
}

export function currentRequestError(): unknown {
  return scopeStorage.getStore()?.error;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export interface LoggedError {
  name: string;
  message: string;
  code?: string;
  statusCode?: number;
  stack?: string[];
  cause?: LoggedError;
}

export function describeError(error: unknown, depth = 0): LoggedError {
  if (error instanceof Error) {
    const raw = error as Error & { code?: unknown; statusCode?: unknown; $metadata?: { httpStatusCode?: unknown } };
    const described: LoggedError = {
      name: truncate(String(error.name || 'Error'), 100),
      message: truncate(String(error.message ?? ''), MAX_MESSAGE_LENGTH),
    };
    if (typeof raw.code === 'string') described.code = truncate(raw.code, 100);
    const statusCode = typeof raw.statusCode === 'number' ? raw.statusCode : raw.$metadata?.httpStatusCode;
    if (typeof statusCode === 'number') described.statusCode = statusCode;
    if (depth === 0 && typeof error.stack === 'string') {
      described.stack = error.stack
        .split('\n')
        .slice(1, MAX_STACK_FRAMES + 1)
        .map((frame) => truncate(frame.trim(), 200));
    }
    if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
      described.cause = describeError(error.cause, depth + 1);
    }
    return described;
  }
  return {
    name: typeof error,
    message: truncate(typeof error === 'string' ? error : 'non-Error value thrown', MAX_MESSAGE_LENGTH),
  };
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isIdentifierSegment(segment: string): boolean {
  if (UUID_SEGMENT.test(segment) || /^\d+$/.test(segment)) return true;
  // Opaque generated IDs: long, URL-safe and containing a digit.
  return segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment) && /\d/.test(segment);
}

/**
 * The request path as logged: no query string (the event path never carries
 * one), any segment holding an email address redacted, and bounded length.
 */
export function loggablePath(path: unknown): string {
  const value = typeof path === 'string' && path.length > 0 ? path.split('?')[0] : '/';
  const redacted = value
    .split('/')
    .map((segment) => {
      let decoded = segment;
      try { decoded = decodeURIComponent(segment); } catch { /* keep raw */ }
      return decoded.includes('@') ? ':redacted' : segment;
    })
    .join('/');
  return truncate(redacted, MAX_PATH_LENGTH);
}

/** The path with identifier segments replaced, so failures group by route. */
export function routeTemplate(path: unknown): string {
  return loggablePath(path)
    .split('/')
    .map((segment) => (segment && isIdentifierSegment(segment) ? ':id' : segment))
    .join('/');
}

export interface ApiRequestFailureInput {
  method: string;
  path: unknown;
  routeFamily: string;
  statusCode: number;
  durationMs: number;
  requestId: string;
  coldStart: boolean;
  errorClass: string;
  error?: unknown;
  responseError?: unknown;
}

/** The response's own public error text, for 5xx routes that caught nothing. */
export function responseErrorText(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const error = parsed.error;
    if (typeof error === 'string') return truncate(error, 200);
    if (error && typeof error === 'object') {
      const { code, message } = error as { code?: unknown; message?: unknown };
      const parts = [code, message].filter((part): part is string => typeof part === 'string');
      if (parts.length) return truncate(parts.join(': '), 200);
    }
  } catch {
    // Not JSON: nothing safe to report.
  }
  return undefined;
}

export function logApiRequestFailure(input: ApiRequestFailureInput): void {
  try {
    const record: Record<string, unknown> = {
      event: API_REQUEST_FAILED_EVENT,
      level: 'ERROR',
      requestId: input.requestId,
      method: input.method,
      route: routeTemplate(input.path),
      path: loggablePath(input.path),
      routeFamily: input.routeFamily,
      status: input.statusCode,
      durationMs: Math.round(Math.max(0, Number.isFinite(input.durationMs) ? input.durationMs : 0)),
      coldStart: input.coldStart,
      errorClass: input.errorClass,
    };
    if (input.error !== undefined) record.error = describeError(input.error);
    const responseError = responseErrorText(input.responseError);
    if (responseError) record.responseError = responseError;
    console.error(JSON.stringify(record));
  } catch {
    // Logging must never replace the HTTP response.
  }
}
