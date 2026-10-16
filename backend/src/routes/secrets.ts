import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getUser } from '../db/users';
import {
  deleteSecret,
  getSecret,
  listSecretAccess,
  listSecrets,
  putSecret,
  recordSecretAccess,
} from '../db/secrets';
import { MAX_PAYLOAD_BYTES, resolveSecretCipher } from '../secrets/cipher';
import type { LambdaEvent, LambdaResponse } from '../types';
import { recordRequestError } from '../requestErrorLog';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

/** Names are stable, pipe-safe identifiers: lowercase, no spaces. */
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_FIELDS = 32;
const MAX_FIELD_VALUE_CHARS = 4096;
/** Leave headroom under the KMS 4 KiB plaintext cap for the JSON envelope. */
const MAX_PAYLOAD_JSON_BYTES = MAX_PAYLOAD_BYTES - 512;

/**
 * Handle all /api/secrets routes. Every route is admin-only and every
 * successful access is audited; values are returned only to GETs of a single
 * secret and never appear in list responses, audit records, or error bodies.
 */
export async function handleSecretRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (!path.startsWith('/api/secrets')) return null;

  const gate = await requireAdmin(client, event);
  if (!gate.ok) return gate.response;

  const suffix = path.slice('/api/secrets'.length);
  try {
    if (suffix === '' || suffix === '/') {
      if (method !== 'GET') return methodNotAllowed();
      const secrets = await listSecrets(client);
      await recordSecretAccess(client, { action: 'list', actorId: gate.actorId });
      return json(200, { secrets });
    }

    const auditMatch = suffix.match(/^\/([^/]+)\/audit\/?$/);
    if (auditMatch) {
      if (method !== 'GET') return methodNotAllowed();
      const name = decodeURIComponent(auditMatch[1]);
      if (!SECRET_NAME.test(name)) return invalidName();
      return json(200, { events: await listSecretAccess(client, name) });
    }

    const nameMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (!nameMatch) return json(404, { error: 'Not found' });
    const name = decodeURIComponent(nameMatch[1]);
    if (!SECRET_NAME.test(name)) return invalidName();

    if (method === 'GET') {
      const cipher = resolveSecretCipher();
      const secret = await getSecret(client, cipher, name, gate.actorId);
      if (!secret) return json(404, { error: `Secret '${name}' does not exist` });
      return json(200, { secret });
    }

    if (method === 'PUT') {
      const fields = parseFields(event.body ?? null);
      const cipher = resolveSecretCipher();
      const meta = await putSecret(client, cipher, { name, fields, actorId: gate.actorId });
      return json(200, { secret: meta });
    }

    if (method === 'DELETE') {
      const existed = await deleteSecret(client, name, gate.actorId);
      if (!existed) return json(404, { error: `Secret '${name}' does not exist` });
      return json(200, { deleted: true, name });
    }

    return methodNotAllowed();
  } catch (error: unknown) {
    if (error instanceof SecretInputError) return json(400, { error: error.message });
    recordRequestError(error);
    return json(500, { error: 'Internal server error' });
  }
}

/**
 * Only `admin` users touch the secrets store. This is the single gate for
 * every route here, including reads: a service login is team administration.
 */
async function requireAdmin(
  client: DynamoDBDocumentClient,
  event: LambdaEvent,
): Promise<{ ok: true; actorId: string } | { ok: false; response: LambdaResponse }> {
  const actorId = headerValue(event.headers, 'x-user-id');
  const user = actorId ? await getUser(client, actorId) : null;
  if (!user || user.role !== 'admin' || user.disabled) {
    return {
      ok: false,
      response: json(403, { error: 'Admin access required' }),
    };
  }
  return { ok: true, actorId: user.id };
}

function parseFields(rawBody: string | null): Record<string, string> {
  if (!rawBody) throw new SecretInputError('A JSON body with a fields object is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new SecretInputError('Body is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SecretInputError('Body must be a JSON object');
  }
  const body = parsed as Record<string, unknown>;
  const unknown = Object.keys(body).find((key) => key !== 'fields');
  if (unknown) throw new SecretInputError(`Unknown body field '${unknown}'; send { fields: { ... } }`);
  const fields = body.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new SecretInputError('fields must be an object of string values');
  }
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0) throw new SecretInputError('fields must contain at least one entry');
  if (entries.length > MAX_FIELDS) throw new SecretInputError(`A secret holds at most ${MAX_FIELDS} fields`);
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!FIELD_KEY.test(key)) {
      throw new SecretInputError(`Field name '${key.slice(0, 16)}' is invalid: use letters, digits, '_', '.', '-' starting with a letter`);
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new SecretInputError(`Field '${key}' must be a non-empty string`);
    }
    if (value.length > MAX_FIELD_VALUE_CHARS) {
      throw new SecretInputError(`Field '${key}' exceeds ${MAX_FIELD_VALUE_CHARS} characters`);
    }
    result[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_PAYLOAD_JSON_BYTES) {
    throw new SecretInputError('Secret payload is too large for encrypted storage');
  }
  return result;
}

class SecretInputError extends Error {}

function invalidName(): LambdaResponse {
  return json(400, { error: 'Secret names are 1-64 characters of lowercase letters, digits, ".", "_", "-"' });
}

function methodNotAllowed(): LambdaResponse {
  return json(405, { error: 'Method not allowed' });
}

function headerValue(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
}

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}
