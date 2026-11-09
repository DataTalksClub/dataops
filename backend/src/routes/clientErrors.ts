import { headerValue } from '../httpHeaders';
import { NO_STORE_JSON_HEADERS, noStoreJson } from '../http';
import type { LambdaEvent, LambdaResponse } from '../types';

/**
 * Browser-reported failures: a page's access check or API call failed or timed
 * out and the visitor was shown an error. The page cannot be trusted to tell
 * anyone itself, so it posts here and the failure lands in the server log as
 * one structured ERROR line, where the same alerting as `api_request_failed`
 * can pick it up.
 *
 * Anonymous (sponsor and guest pages have no session), so the payload is
 * strictly bounded: fixed fields only, truncated, query strings stripped
 * (they can carry access codes), and a per-IP budget per Lambda instance.
 */

export const CLIENT_CHECK_FAILED_EVENT = 'client_check_failed';

const MAX_FIELD_LENGTH = 300;
const BUDGET_PER_WINDOW = 10;
const WINDOW_MS = 60_000;

const budgets = new Map<string, { windowStart: number; count: number }>();

export function isClientErrorReport(method: string, path: string): boolean {
  return method.toUpperCase() === 'POST' && /^\/api\/client-errors\/?$/.test(path);
}

function field(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : '';
}

function withinBudget(ip: string, now: number): boolean {
  const entry = budgets.get(ip);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    if (budgets.size > 1000) budgets.clear();
    budgets.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= BUDGET_PER_WINDOW;
}

export function handleClientErrorRoute(event: LambdaEvent): LambdaResponse {
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(event.body || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    return noStoreJson(400, { error: 'Invalid JSON body' });
  }
  const ip = headerValue(event.headers, 'x-forwarded-for').split(',')[0].trim() || 'unknown';
  if (!withinBudget(ip, Date.now())) return noStoreJson(429, { error: 'Too many reports' });
  const status = Number(body.status);
  console.error(JSON.stringify({
    event: CLIENT_CHECK_FAILED_EVENT,
    level: 'ERROR',
    surface: field(body.surface),
    check: field(body.check),
    status: Number.isInteger(status) ? status : null,
    message: field(body.message),
    page: field(body.page).split(/[?#]/)[0],
    userAgent: headerValue(event.headers, 'user-agent').slice(0, MAX_FIELD_LENGTH),
  }));
  // A 204 must have no body; a `{}` payload makes browsers abort the response.
  return { statusCode: 204, headers: NO_STORE_JSON_HEADERS, body: '' };
}
