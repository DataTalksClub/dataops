import { isRecord } from './records';
import type { LambdaEvent, LambdaResponse } from './types';

export const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };
export const NO_STORE_JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

/** Standard JSON response (`Content-Type: application/json`, `JSON.stringify(body)`). */
export function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/**
 * JSON response that passes an already-serialized string body through unchanged
 * (`typeof body === 'string' ? body : JSON.stringify(body)`).
 */
export function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/** JSON response with `Cache-Control: no-store`. */
export function noStoreJson(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: NO_STORE_JSON_HEADERS, body: JSON.stringify(body) };
}

/**
 * Behaviour group A: parse a JSON request body that must be a non-empty plain
 * object (`null` on missing/empty body, invalid JSON, arrays, or primitives).
 */
export function parseJsonObjectBody<T = Record<string, any>>(rawBody: unknown): T | null {
  if (!rawBody) return null;
  if (typeof rawBody === 'object') return isRecord(rawBody) ? (rawBody as unknown as T) : null;
  if (typeof rawBody !== 'string') return null;
  try {
    const parsed = JSON.parse(rawBody);
    return isRecord(parsed) ? (parsed as unknown as T) : null;
  } catch {
    return null;
  }
}

export function parseJsonObjectEvent<T = Record<string, any>>(event: LambdaEvent): T | null {
  return parseJsonObjectBody<T>(event.body);
}

/**
 * Behaviour group B: parse a JSON request body that defaults to `{}` when
 * missing/empty and requires a plain object (`null` on invalid JSON, arrays,
 * or primitives).
 */
export function parseJsonObjectBodyOrEmpty<T = Record<string, any>>(rawBody: unknown): T | null {
  if (!rawBody) return {} as unknown as T;
  if (typeof rawBody === 'object') return isRecord(rawBody) ? (rawBody as unknown as T) : null;
  if (typeof rawBody !== 'string') return null;
  try {
    const parsed = JSON.parse(rawBody);
    return isRecord(parsed) ? (parsed as unknown as T) : null;
  } catch {
    return null;
  }
}

export function parseJsonObjectEventOrEmpty<T = Record<string, any>>(event: LambdaEvent): T | null {
  return parseJsonObjectBodyOrEmpty<T>(event.body);
}

/**
 * Behaviour group C: parse a JSON request body when present, returning `null`
 * on missing/empty body or invalid JSON without filtering non-object values.
 */
export function parseJsonBody<T = Record<string, any>>(rawBody: unknown): T | null {
  if (!rawBody) return null;
  if (typeof rawBody === 'object') return rawBody as T;
  if (typeof rawBody !== 'string') return null;
  try {
    return JSON.parse(rawBody) as T;
  } catch {
    return null;
  }
}

export function parseJsonEvent<T = Record<string, any>>(event: LambdaEvent): T | null {
  return parseJsonBody<T>(event.body);
}
