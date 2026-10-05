/**
 * Shared HTTP plumbing for the docs content API: default CORS headers,
 * JSON responses, and Lambda event accessors. Extracted from `contentApi.ts`
 * so the endpoint modules can share them without importing the dispatcher.
 */

import type { LambdaEvent, LambdaResponse } from '../types';

export const DEFAULT_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-user-email',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

export function jsonResponse(status: number, body: unknown): LambdaResponse {
  return { statusCode: status, headers: { ...DEFAULT_HEADERS }, body: JSON.stringify(body) };
}

export function method(event: LambdaEvent): string {
  return (event.httpMethod || 'GET').toUpperCase();
}

export function queryParam(event: LambdaEvent, name: string): string | null {
  const value = event.queryStringParameters?.[name];
  return value !== undefined && value !== null ? String(value) : null;
}
