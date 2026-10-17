import { createHash } from 'crypto';

/**
 * Bound paging cursors. A cursor binds the sha of the canonical filter+sort
 * form it was issued for, so reusing a cursor after changing filters or sort
 * is rejected instead of silently returning a wrong page. Sorts always end in
 * an `id` tiebreak, so paging is stable.
 */
const HASH_BYTES = 16;

export function cursorBinding(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, HASH_BYTES);
}

export function encodeCursor(binding: string, offset: number): string {
  return Buffer.from(JSON.stringify({ h: binding, o: offset }), 'utf8').toString('base64url');
}

export function decodeCursor(
  binding: string,
  cursor: string,
): { offset: number } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return { error: 'Invalid cursor' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'Invalid cursor' };
  const { h, o } = parsed as Record<string, unknown>;
  if (h !== binding) return { error: 'Cursor does not match these filters' };
  if (!Number.isInteger(o) || (o as number) < 0) return { error: 'Invalid cursor' };
  return { offset: o as number };
}

export function pageLimit(raw: unknown, fallback = 30): { limit: number } | { error: string } {
  if (raw === undefined) return { limit: fallback };
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { error: 'limit must be 1..100' };
  return { limit };
}
