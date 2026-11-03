import { createHash, timingSafeEqual } from 'crypto';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_AUDIT_EVENTS } from '../db/tableNames';
import { headerValue } from '../httpHeaders';
import { readRuntimeSecret } from '../secrets/reader';
import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SECRET_CACHE_MS = 60_000;

export interface IntakeCredential {
  value: string;
  id: string;
}

let readSecret = readRuntimeSecret;
let cachedCredential: (IntakeCredential & { expiresAt: number }) | null = null;

export function intakeResponse(statusCode: number, body: unknown, headers: Record<string, string> = {}): LambdaResponse {
  return { statusCode, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) };
}

export function intakeHeader(event: LambdaEvent, name: string): string {
  return headerValue(event.headers, name);
}

export function safeError(statusCode: number, status: string, code: string, message: string): LambdaResponse {
  return intakeResponse(statusCode, { status, error: { code, message } });
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseCredential(raw: string): IntakeCredential {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.credential === 'string' && parsed.credential.length > 0) {
      const configuredId = typeof parsed.id === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(parsed.id) ? parsed.id : '';
      return { value: parsed.credential, id: configuredId || digest(parsed.credential).slice(0, 12) };
    }
  } catch {
    // Plain secret strings remain supported for pre-created credentials.
  }
  return { value: raw, id: digest(raw).slice(0, 12) };
}

async function loadCredential(force = false): Promise<IntakeCredential | null> {
  // Email-document and potential-lead intake share the same forwarder secret
  // and one in-process credential cache.
  const inline = process.env.EMAIL_DOCUMENT_INTAKE_SECRET;
  if (inline) return parseCredential(inline);
  if (!force && cachedCredential && cachedCredential.expiresAt > Date.now()) return cachedCredential;
  const name = process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME;
  if (!name) return null;
  const raw = await readSecret(name);
  if (!raw) return null;
  const parsed = parseCredential(raw);
  cachedCredential = { ...parsed, expiresAt: Date.now() + SECRET_CACHE_MS };
  return parsed;
}

function equalSecret(actual: string, expected: string): boolean {
  const left = createHash('sha256').update(actual).digest();
  const right = createHash('sha256').update(expected).digest();
  const matches = timingSafeEqual(left, right);
  return matches && actual.length > 0 && expected.length > 0;
}

export async function authenticateIntake(event: LambdaEvent): Promise<IntakeCredential | null> {
  const actual = intakeHeader(event, 'x-dataops-intake-secret');
  let expected = await loadCredential(false);
  if (!expected) return null;
  if (equalSecret(actual, expected.value)) return expected;
  // A mismatch bypasses the cache once so a newly rotated value works immediately.
  expected = await loadCredential(true);
  return expected && equalSecret(actual, expected.value) ? expected : null;
}

export async function rateLimitIntake(
  client: DynamoDBDocumentClient,
  credentialId: string,
  envVar: string,
  keyPrefix: string,
): Promise<number | null> {
  const configured = Number(process.env[envVar] || '60');
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 60;
  const now = Date.now();
  const windowStart = Math.floor(now / 60_000) * 60_000;
  try {
    await client.send(new UpdateCommand({
      TableName: TABLE_AUDIT_EVENTS,
      Key: {
        PK: `RATE#${keyPrefix}#${digest(credentialId).slice(0, 32)}`,
        SK: `WINDOW#${windowStart}`,
      },
      UpdateExpression: 'SET expiresAt = :expiresAt ADD requestCount :one',
      ConditionExpression: 'attribute_not_exists(requestCount) OR requestCount < :limit',
      ExpressionAttributeValues: {
        ':expiresAt': Math.floor((windowStart + 2 * 60_000) / 1000),
        ':one': 1,
        ':limit': limit,
      },
    }));
    return null;
  } catch (error) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      return Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000));
    }
    throw error;
  }
}

export function resetIntakeAuthForTests(): void {
  cachedCredential = null;
  readSecret = readRuntimeSecret;
}

export function setIntakeSecretReaderForTests(reader: typeof readRuntimeSecret): void {
  readSecret = reader;
}
