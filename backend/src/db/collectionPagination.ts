import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

import { portalRuntimeSecret } from '../runtimeSecret';

export const DEFAULT_COLLECTION_LIMIT = 100;
export const MAX_COLLECTION_LIMIT = 200;
const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 4096;
const CURSOR_INFO = 'dataops:collection-cursor:v1';
const CURSOR_SALT = 'dataops:collection-cursor:salt:v1';

export class CollectionCursorError extends Error {
  constructor(readonly code: string) {
    super('Invalid pagination input');
    this.name = 'CollectionCursorError';
  }
}

export interface CursorBinding {
  /** Stable public discriminator; this is deliberately not a table name. */
  collection: string;
  /** Canonical, non-secret representation of the effective query filters. */
  filters: unknown;
  /** Server-resolved viewer identity, never supplied directly by the client. */
  principal: string;
}

export interface ExclusiveStartKey {
  [attribute: string]: string | number;
}

export interface CollectionInput {
  limit?: unknown;
  cursor?: unknown;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

export function validExclusiveStartKey(value: unknown): value is ExclusiveStartKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length >= 1 && entries.length <= 16 && entries.every(([key, item]) => (
    /^[A-Za-z0-9_.:-]{1,128}$/.test(key)
    && ((typeof item === 'string'
      && item.length >= 1
      && item.length <= 2048)
      || (typeof item === 'number'
        && Number.isSafeInteger(item)))
  ));
}

async function cursorKey(): Promise<Buffer> {
  const secret = await portalRuntimeSecret();
  if (!secret) throw new Error('Portal pagination key material is unavailable');
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf-8'),
    Buffer.from(CURSOR_SALT, 'utf-8'),
    Buffer.from(CURSOR_INFO, 'utf-8'),
    32,
  ));
}

export async function encodeCollectionCursor(
  binding: CursorBinding,
  exclusiveStartKey: ExclusiveStartKey,
): Promise<string> {
  if (!validExclusiveStartKey(exclusiveStartKey)) {
    throw new Error('Invalid collection continuation');
  }
  const payload = Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    c: binding.collection,
    f: canonical(binding.filters),
    p: binding.principal,
    k: exclusiveStartKey,
  }), 'utf-8');
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await cursorKey(), initializationVector);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([
    initializationVector,
    cipher.getAuthTag(),
    encrypted,
  ]).toString('base64url');
}

function decryptPayload(token: string, key: Buffer): Record<string, unknown> {
  if (token.length > MAX_CURSOR_LENGTH) throw new CollectionCursorError('cursor-too-large');
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new CollectionCursorError('cursor-malformed');

  let sealed: Buffer;
  try {
    sealed = Buffer.from(token, 'base64url');
  } catch {
    throw new CollectionCursorError('cursor-malformed');
  }
  // IV (12) + authentication tag (16), with room for a JSON object.
  if (sealed.length <= 30) throw new CollectionCursorError('cursor-truncated');

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    decipher.setAuthTag(sealed.subarray(12, 28));
    const decrypted = Buffer.concat([
      decipher.update(sealed.subarray(28)),
      decipher.final(),
    ]);
    const parsed: unknown = JSON.parse(decrypted.toString('utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CollectionCursorError('cursor-malformed');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CollectionCursorError) throw error;
    throw new CollectionCursorError('cursor-tampered-or-malformed');
  }
}

/** Decode once per request; every field is re-bound by the calling collection. */
export async function decodeCollectionCursor(
  binding: CursorBinding,
  token: unknown,
): Promise<ExclusiveStartKey> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new CollectionCursorError('cursor-malformed');
  }
  const payload = decryptPayload(token, await cursorKey());
  if (payload.v !== CURSOR_VERSION) throw new CollectionCursorError('cursor-version-unsupported');
  if (
    typeof payload.c !== 'string'
    || typeof payload.f !== 'string'
    || typeof payload.p !== 'string'
    || payload.c.length > 64
    || payload.f.length > 2048
    || payload.p.length > 256
  ) {
    throw new CollectionCursorError('cursor-malformed');
  }
  if (
    !timingSafeStringEqual(payload.c, binding.collection)
    || !timingSafeStringEqual(payload.f, canonical(binding.filters))
    || !timingSafeStringEqual(payload.p, binding.principal)
    || !validExclusiveStartKey(payload.k)
  ) {
    throw new CollectionCursorError('cursor-binding-mismatch');
  }
  return payload.k;
}

/**
 * Accept only decimal integers. Lambda query values are strings, and values
 * such as `1e2`, `100.0`, or `-0` must not silently become another page size.
 */
export function parseCollectionLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_COLLECTION_LIMIT;
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) {
    throw new CollectionCursorError('invalid-limit');
  }
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_COLLECTION_LIMIT) {
    throw new CollectionCursorError('limit-out-of-range');
  }
  return limit;
}
