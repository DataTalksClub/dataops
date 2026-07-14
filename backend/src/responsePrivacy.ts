import type { LambdaResponse } from './types';

/**
 * Stable S3 identities are server-side implementation details. API callers use
 * artifact IDs and authenticated controlled-download routes instead.
 */
export function sanitizeInternalStorage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeInternalStorage);
  if (!value || typeof value !== 'object') return value;
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'storageUri' && typeof child === 'string' && child.startsWith('s3://')) continue;
    safe[key] = sanitizeInternalStorage(child);
  }
  return safe;
}

export function sanitizeJsonResponse(response: LambdaResponse): LambdaResponse {
  const contentType = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
  if (!String(contentType).toLowerCase().includes('application/json') || typeof response.body !== 'string') return response;
  try {
    return { ...response, body: JSON.stringify(sanitizeInternalStorage(JSON.parse(response.body))) };
  } catch {
    return response;
  }
}
