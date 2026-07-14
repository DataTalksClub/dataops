import { createHash, timingSafeEqual } from 'crypto';
import { CopyObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { createArtifactIfAbsent, deleteArtifact, getArtifact, updateArtifact } from '../db/artifacts';
import { createIntakeItemIfAbsent, getIntakeItem, updateIntakeItem } from '../db/intake';
import { TABLE_AUDIT_EVENTS } from '../db/setup';
import type { ArtifactRecord, ArtifactRef, IntakeItem, LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CONTRACT_VERSION = '2026-07-01';
const MAX_DOCUMENTS = 25;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const SECRET_CACHE_MS = 60_000;
const TOP_LEVEL_FIELDS = new Set(['version', 'messageId', 'recipientRoute', 'from', 'subject', 'receivedAt', 'documents']);
const DOCUMENT_FIELDS = new Set(['kind', 'storageUri', 'filename', 'contentType', 'sizeBytes', 'checksum']);
const SENSITIVE_KEY = /^(secret|token|password|credential|authorization|signed[_-]?url|base64|body|data|bytes|fileContent|attachmentContent|rawEmail)$/i;
const SIGNED_URL = /(x-amz-signature|x-amz-credential|x-amz-security-token|[?&](token|signature|sig)=)/i;

let secretsClient: SecretsManagerClient | null = null;
let s3Client: S3Client | null = null;
let cachedCredential: { value: string; id: string; expiresAt: number } | null = null;

interface EmailDocument {
  kind: 'attachment' | 'rendered-email-pdf';
  storageUri: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
  source: { bucket: string; key: string };
}

interface Credential { value: string; id: string }
interface SourceRule { bucket: string; prefix: string }

function response(statusCode: number, body: unknown, headers: Record<string, string> = {}): LambdaResponse {
  return { statusCode, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) };
}

function header(event: LambdaEvent, name: string): string {
  const entry = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry ? String(entry[1]) : '';
}

function safeError(statusCode: number, status: string, code: string, message: string): LambdaResponse {
  return response(statusCode, { status, error: { code, message } });
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${digest(value).slice(0, 32)}`;
}

function parseCredential(raw: string): Credential {
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

async function loadCredential(force = false): Promise<Credential | null> {
  const inline = process.env.EMAIL_DOCUMENT_INTAKE_SECRET;
  if (inline) return parseCredential(inline);
  if (!force && cachedCredential && cachedCredential.expiresAt > Date.now()) return cachedCredential;
  const name = process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME;
  if (!name) return null;
  secretsClient ||= new SecretsManagerClient({});
  const value = await secretsClient.send(new GetSecretValueCommand({ SecretId: name }));
  const raw = value.SecretString || (value.SecretBinary ? Buffer.from(value.SecretBinary).toString('utf8') : '');
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

async function authenticate(event: LambdaEvent): Promise<Credential | null> {
  const actual = header(event, 'x-dataops-intake-secret');
  let expected = await loadCredential(false);
  if (!expected) return null;
  if (equalSecret(actual, expected.value)) return expected;
  // A mismatch bypasses the cache once so a newly rotated value works immediately.
  expected = await loadCredential(true);
  return expected && equalSecret(actual, expected.value) ? expected : null;
}

async function rateLimit(client: DynamoDBDocumentClient, credentialId: string): Promise<number | null> {
  const configured = Number(process.env.EMAIL_DOCUMENT_RATE_LIMIT || '60');
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 60;
  const now = Date.now();
  const windowStart = Math.floor(now / 60_000) * 60_000;
  try {
    await client.send(new UpdateCommand({
      TableName: TABLE_AUDIT_EVENTS,
      Key: {
        PK: `RATE#EMAIL_DOCUMENT#${digest(credentialId).slice(0, 32)}`,
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

function text(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  const result = value.trim();
  if (result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${field} is invalid or exceeds ${max} characters`);
  return result;
}

function onlyFields(value: Record<string, unknown>, fields: Set<string>, path: string): void {
  const unknown = Object.keys(value).find((key) => !fields.has(key));
  if (unknown) throw new Error(`${path} contains unknown fields`);
}

function parseS3Uri(value: unknown, field: string): { uri: string; bucket: string; key: string } {
  const uri = text(value, field, 1024);
  if (SIGNED_URL.test(uri)) throw new Error(`${field} must not contain credentials or a signed URL`);
  const match = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/(.+)$/i.exec(uri);
  if (!match || match[2].includes('?') || /\s/.test(match[2])) throw new Error(`${field} must be a stable s3:// bucket/key reference`);
  return { uri, bucket: match[1].toLowerCase(), key: match[2] };
}

function parseChecksum(value: unknown, field: string): string {
  const result = text(value, field, 71);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) throw new Error(`${field} must use sha256:<64 lowercase hex characters>`);
  return result;
}

function utcTimestamp(value: unknown): string {
  const result = text(value, 'receivedAt', 40);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(result);
  if (!match) throw new Error('receivedAt must be a valid UTC ISO timestamp');
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] || '').padEnd(3, '0')}Z`;
  const parsed = new Date(result);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) throw new Error('receivedAt must be a real UTC calendar timestamp');
  if (parsed.getTime() > Date.now() + 5 * 60_000) throw new Error('receivedAt must not be in the future');
  return result;
}

function validateNoPayloadData(value: unknown, path = 'request'): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`${path} contains prohibited content`);
    if (typeof child === 'string' && SIGNED_URL.test(child)) throw new Error(`${path} contains a signed URL or token`);
    validateNoPayloadData(child, `${path}.${key}`);
  }
}

function parseDocuments(value: unknown): EmailDocument[] {
  if (!Array.isArray(value) || value.length > MAX_DOCUMENTS) throw new Error(`documents must be an array with at most ${MAX_DOCUMENTS} items`);
  const documents = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`documents[${index}] must be an object`);
    const document = item as Record<string, unknown>;
    onlyFields(document, DOCUMENT_FIELDS, `documents[${index}]`);
    const kind = text(document.kind, `documents[${index}].kind`, 40);
    if (kind !== 'attachment' && kind !== 'rendered-email-pdf') throw new Error(`documents[${index}].kind is unsupported`);
    if (!Number.isSafeInteger(document.sizeBytes) || Number(document.sizeBytes) <= 0 || Number(document.sizeBytes) > MAX_DOCUMENT_BYTES) {
      throw new Error(`documents[${index}].sizeBytes must be between 1 and ${MAX_DOCUMENT_BYTES}`);
    }
    const contentType = text(document.contentType, `documents[${index}].contentType`, 160).toLowerCase();
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(contentType)) throw new Error(`documents[${index}].contentType is invalid`);
    if (kind === 'rendered-email-pdf' && contentType !== 'application/pdf') throw new Error(`documents[${index}] rendered-email-pdf must use application/pdf`);
    const filename = text(document.filename, `documents[${index}].filename`, 255);
    if (filename === '.' || filename === '..' || filename.includes('/') || filename.includes('\\')) throw new Error(`documents[${index}].filename must be sanitized`);
    const source = parseS3Uri(document.storageUri, `documents[${index}].storageUri`);
    return { kind, storageUri: source.uri, filename, contentType, sizeBytes: Number(document.sizeBytes), checksum: parseChecksum(document.checksum, `documents[${index}].checksum`), source } as EmailDocument;
  });
  const seen = new Set<string>();
  for (const document of documents) {
    const key = JSON.stringify(document);
    if (seen.has(key)) throw new Error('duplicate document descriptors are not allowed');
    seen.add(key);
  }
  return documents;
}

function sourceRules(): SourceRule[] {
  const bucket = process.env.EMAIL_DOCUMENTS_BUCKET || '';
  const prefix = process.env.EMAIL_DOCUMENT_SOURCE_PREFIX || 'transfer/';
  const externalBucket = process.env.EMAIL_DOCUMENT_EXTERNAL_SOURCE_BUCKET || '';
  const externalPrefix = process.env.EMAIL_DOCUMENT_EXTERNAL_SOURCE_PREFIX || 'transfer/';
  return [
    ...(bucket ? [{ bucket, prefix }] : []),
    ...(externalBucket ? [{ bucket: externalBucket, prefix: externalPrefix }] : []),
  ];
}

function sourceAllowed(document: EmailDocument, rules: SourceRule[]): boolean {
  return rules.some((rule) => document.source.bucket === rule.bucket.toLowerCase() && document.source.key.startsWith(rule.prefix));
}

function artifactRef(artifact: ArtifactRecord): ArtifactRef {
  return { artifactId: artifact.id, type: artifact.type, title: artifact.title, storageUri: artifact.storageUri, status: artifact.status };
}

function publicArtifacts(refs: ArtifactRef[]): Array<{ artifactId: string; status?: string }> {
  return refs.map((ref) => ({ artifactId: ref.artifactId, status: ref.status }));
}

function canonicalRequest(envelope: Record<string, unknown>, documents: EmailDocument[]): string {
  return JSON.stringify({ ...envelope, documents: documents.map(({ source: _source, ...document }) => document) });
}

function documentId(intakeId: string, document: EmailDocument): string {
  const tieBreaker = digest(`${document.storageUri}\n${document.filename}`).slice(0, 16);
  return stableId('email-document', `${intakeId}\n${document.kind}\n${document.checksum}\n${tieBreaker}`);
}

function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function actualChecksum(head: { Metadata?: Record<string, string>; ChecksumSHA256?: string }): string {
  const metadata = head.Metadata?.sha256 || head.Metadata?.checksum || '';
  if (/^(sha256:)?[a-f0-9]{64}$/i.test(metadata)) return `sha256:${metadata.replace(/^sha256:/i, '').toLowerCase()}`;
  if (head.ChecksumSHA256) return `sha256:${Buffer.from(head.ChecksumSHA256, 'base64').toString('hex')}`;
  return '';
}

async function verifyDocumentSource(document: EmailDocument, rules: SourceRule[]): Promise<void> {
  if (!sourceAllowed(document, rules)) throw new Error('source-not-allowed');
  s3Client ||= new S3Client({});
  let head;
  try { head = await s3Client.send(new HeadObjectCommand({ Bucket: document.source.bucket, Key: document.source.key, ChecksumMode: 'ENABLED' })); }
  catch { throw new Error('source-unavailable'); }
  if (head.ContentLength !== document.sizeBytes) throw new Error('size-mismatch');
  if ((head.ContentType || '').toLowerCase() !== document.contentType) throw new Error('media-type-mismatch');
  if (actualChecksum(head) !== document.checksum) throw new Error('checksum-mismatch');
}

function audit(outcome: string, credential: Credential | null, correlation: string, documentCount: number, failureCount = 0): void {
  console.info(JSON.stringify({ event: 'email-document-intake', outcome, credentialId: credential?.id || 'unknown', contractVersion: CONTRACT_VERSION, correlation, documentCount, failureCount }));
}

export function resetEmailDocumentIntakeStateForTests(): void {
  cachedCredential = null;
  secretsClient = null;
  s3Client = null;
}

export function setEmailDocumentIntakeClientsForTests(clients: { secrets?: SecretsManagerClient; s3?: S3Client }): void {
  if (clients.secrets) secretsClient = clients.secrets;
  if (clients.s3) s3Client = clients.s3;
}

export async function handleEmailDocumentIntake(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  if (!process.env.EMAIL_DOCUMENT_INTAKE_SECRET && !process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME) {
    return safeError(503, 'configuration-error', 'authentication-not-configured', 'Email document authentication is not configured');
  }
  let credential: Credential | null;
  try { credential = await authenticate(event); }
  catch { return safeError(503, 'configuration-error', 'authentication-unavailable', 'Email document authentication is unavailable'); }
  if (!credential) {
    audit('unauthorized', null, 'unavailable', 0);
    return safeError(401, 'unauthorized', 'unauthorized', 'Unauthorized');
  }
  let retryAfter: number | null;
  try { retryAfter = await rateLimit(client, credential.id); }
  catch { return safeError(503, 'configuration-error', 'rate-limit-unavailable', 'Request limiting is unavailable'); }
  if (retryAfter !== null) {
    audit('rate-limited', credential, 'unavailable', 0);
    return response(429, { status: 'rate-limited', error: { code: 'rate-limited', message: 'Request limit exceeded' } }, { 'Retry-After': String(retryAfter) });
  }

  const rawBody = typeof event.body === 'string' ? event.body : JSON.stringify(event.body || {});
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) return safeError(413, 'payload-too-large', 'payload-too-large', `Request body exceeds ${MAX_BODY_BYTES} bytes`);

  let body: Record<string, unknown>;
  try {
    const decoded = event.isBase64Encoded ? Buffer.from(rawBody, 'base64').toString('utf8') : rawBody;
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request must be a JSON object');
    body = parsed as Record<string, unknown>;
    onlyFields(body, TOP_LEVEL_FIELDS, 'request');
    validateNoPayloadData(body);
  } catch (error) {
    return safeError(400, 'validation-error', 'invalid-request', error instanceof Error ? error.message : 'Invalid JSON body');
  }

  let messageId: string;
  let recipientRoute: string;
  let sender: string;
  let subject: string;
  let receivedAt: string;
  let documents: EmailDocument[];
  try {
    if (body.version !== CONTRACT_VERSION) throw new Error(`version must be ${CONTRACT_VERSION}`);
    messageId = text(body.messageId, 'messageId', 500);
    recipientRoute = text(body.recipientRoute, 'recipientRoute', 80).toLowerCase();
    const configuredRoutes = (process.env.EMAIL_DOCUMENT_RECIPIENT_ROUTES || 'invoice,receipts,invoice-attachment,invoice-pdf,todo').split(',').map((route) => route.trim().toLowerCase()).filter(Boolean);
    if (!configuredRoutes.includes(recipientRoute)) throw new Error('recipientRoute is not configured');
    sender = text(body.from, 'from', 320);
    subject = text(body.subject, 'subject', 500);
    receivedAt = utcTimestamp(body.receivedAt);
    documents = parseDocuments(body.documents);
  } catch (error) {
    return safeError(400, 'validation-error', 'invalid-request', error instanceof Error ? error.message : 'Invalid request');
  }

  const identity = `${recipientRoute}\n${messageId.trim()}`;
  const intakeId = stableId('email', identity);
  const envelope = { version: CONTRACT_VERSION, messageId, recipientRoute, from: sender, subject, receivedAt };
  const manifestHash = digest(canonicalRequest(envelope, documents));
  const correlation = digest(identity).slice(0, 16);
  let existing: IntakeItem | null;
  try { existing = await getIntakeItem(client, intakeId); }
  catch { return safeError(503, 'configuration-error', 'persistence-unavailable', 'Intake storage is unavailable'); }
  if (existing?.metadata?.emailDocumentManifestHash !== undefined && existing.metadata.emailDocumentManifestHash !== manifestHash) {
    audit('idempotency-conflict', credential, correlation, documents.length);
    return safeError(409, 'idempotency-conflict', 'idempotency-conflict', 'Message identity was already used with different immutable content');
  }
  if (existing?.status === 'new' && (existing.artifactRefs || []).length === documents.length) {
    audit('duplicate', credential, correlation, documents.length);
    return response(200, { status: 'duplicate', intakeItemId: existing.id, artifacts: publicArtifacts(existing.artifactRefs || []) });
  }

  const completedUnlinkedArtifacts = new Map<string, ArtifactRecord>();
  const pendingDocuments: EmailDocument[] = [];
  try {
    for (const document of documents) {
      const id = documentId(intakeId, document);
      if ((existing?.artifactRefs || []).some((ref) => ref.artifactId === id)) continue;
      const artifact = await getArtifact(client, id);
      if (artifact?.metadata?.importState === 'complete') completedUnlinkedArtifacts.set(id, artifact);
      else pendingDocuments.push(document);
    }
  } catch {
    return safeError(503, 'configuration-error', 'persistence-unavailable', 'Artifact storage is unavailable');
  }
  const rules = sourceRules();
  if (pendingDocuments.length && (!rules.length || !process.env.EMAIL_DOCUMENTS_BUCKET)) {
    return safeError(503, 'configuration-error', 'storage-not-configured', 'Email document storage is not configured');
  }
  for (const document of pendingDocuments) {
    const index = documents.indexOf(document);
    try { await verifyDocumentSource(document, rules); }
    catch (error) {
      const code = error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : 'source-verification-failed';
      audit('validation-error', credential, 'unavailable', documents.length, 1);
      return response(400, {
        status: 'validation-error',
        error: { code: 'invalid-document-source', message: 'Document source verification failed' },
        failures: [{ index, code }],
      });
    }
  }

  let reservation;
  try {
    reservation = await createIntakeItemIfAbsent(client, {
      id: intakeId,
      source: 'email',
      sourceMessageId: `${recipientRoute}#${messageId}`,
      sourceReceivedAt: new Date(receivedAt).toISOString(),
      status: documents.length ? 'blocked' : 'new',
      blockedReason: documents.length ? 'Email documents are being imported' : undefined,
      title: subject,
      summary: subject,
      sourceActor: { email: sender },
      receivedChannels: [`email:${recipientRoute}`],
      dataClass: 'sensitive',
      tags: ['email-document'],
      metadata: { recipientRoute, documentCount: documents.length, emailDocumentManifestHash: manifestHash },
      history: [{ id: crypto.randomUUID(), action: 'email-document-accepted', createdAt: new Date().toISOString() }],
    });
  } catch {
    audit('persistence-failed', credential, correlation, documents.length, documents.length);
    return safeError(503, 'configuration-error', 'persistence-unavailable', 'Intake storage is unavailable');
  }
  let item = reservation.item;
  if (item.metadata?.emailDocumentManifestHash !== manifestHash) {
    audit('idempotency-conflict', credential, correlation, documents.length);
    return safeError(409, 'idempotency-conflict', 'idempotency-conflict', 'Message identity was already used with different immutable content');
  }
  if (!reservation.created && item.status === 'new' && (item.artifactRefs || []).length === documents.length) {
    audit('duplicate', credential, correlation, documents.length);
    return response(200, { status: 'duplicate', intakeItemId: item.id, artifacts: publicArtifacts(item.artifactRefs || []) });
  }

  const refs = [...(item.artifactRefs || [])];
  const failures: Array<{ index: number; code: string }> = [];
  for (const [index, document] of documents.entries()) {
    const id = documentId(item.id, document);
    const existingRef = refs.find((ref) => ref.artifactId === id);
    if (existingRef) continue;
    try {
      const artifact = completedUnlinkedArtifacts.get(id) || await importDocumentWithClient(item, document, index, rules, client);
      refs.push(artifactRef(artifact));
    } catch (error) {
      const code = error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : 'document-import-failed';
      failures.push({ index, code });
    }
  }

  try {
    item = await updateIntakeItem(client, item.id, {
      artifactRefs: refs,
      status: failures.length ? 'blocked' : 'new',
      blockedReason: failures.length ? 'One or more email documents require an exact retry' : null,
      history: [...(item.history || []), {
        id: crypto.randomUUID(),
        action: failures.length ? 'email-document-partial-failure' : 'email-document-completed',
        metadata: { artifactCount: refs.length, failureCount: failures.length, failureCodes: failures.map(({ index, code }) => ({ index, code })) },
        createdAt: new Date().toISOString(),
      }],
    }) as IntakeItem;
  } catch {
    failures.push({ index: -1, code: 'link-persistence-failed' });
  }

  if (failures.length) {
    audit('partial-failure', credential, correlation, documents.length, failures.length);
    return response(207, { status: 'partial-failure', intakeItemId: item.id, artifacts: publicArtifacts(refs), failures });
  }
  audit(reservation.created ? 'accepted' : 'resumed', credential, correlation, documents.length);
  return response(reservation.created ? 202 : 200, { status: reservation.created ? 'accepted' : 'duplicate', intakeItemId: item.id, artifacts: publicArtifacts(refs) });
}

async function importDocumentWithClient(item: IntakeItem, document: EmailDocument, index: number, rules: SourceRule[], client: DynamoDBDocumentClient): Promise<ArtifactRecord> {
  const id = documentId(item.id, document);
  const existing = await getArtifact(client, id);
  if (existing?.metadata?.importState === 'complete') return existing;
  await verifyDocumentSource(document, rules);
  const bucket = process.env.EMAIL_DOCUMENTS_BUCKET as string;
  const prefix = (process.env.EMAIL_DOCUMENT_DESTINATION_PREFIX || 'artifacts/').replace(/^\/+|\/+$/g, '');
  const safeFilename = document.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${prefix}/${item.id}/${id}/${index}-${safeFilename}`;
  const metadata = { intakeItemId: item.id, documentKind: document.kind, manifestIndex: index, importState: 'copying' };
  const reservation = await createArtifactIfAbsent(client, { id, type: document.kind === 'rendered-email-pdf' ? 'invoice' : 'other', title: document.filename, status: 'draft', storageProvider: 's3', storageUri: `s3://${bucket}/${key}`, filename: document.filename, contentType: document.contentType, checksum: document.checksum, sizeBytes: document.sizeBytes, visibility: 'sensitive', dataClass: 'sensitive', sourceType: 'system', tags: ['email-document', document.kind], metadata });
  if (!reservation.created) {
    if (reservation.artifact.metadata?.importState === 'complete') return reservation.artifact;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const completed = await getArtifact(client, id);
      if (completed?.metadata?.importState === 'complete') return completed;
      if (!completed) throw new Error('import-reservation-lost');
    }
    throw new Error('import-in-progress');
  }
  try {
    await s3Client!.send(new CopyObjectCommand({ Bucket: bucket, Key: key, CopySource: copySource(document.source.bucket, document.source.key), ContentType: document.contentType, MetadataDirective: 'REPLACE', Metadata: { sha256: document.checksum.slice(7), intake: digest(item.id).slice(0, 16) }, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: process.env.EMAIL_DOCUMENTS_KMS_KEY }));
    return await updateArtifact(client, id, { status: 'needs-review', metadata: { ...metadata, importState: 'complete' } }) as ArtifactRecord;
  } catch {
    await deleteArtifact(client, id).catch(() => undefined);
    throw new Error('copy-failed');
  }
}
