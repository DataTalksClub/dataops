import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_ARTIFACTS, TABLE_SESSIONS } from './tableNames';
import {
  defaultContentForTemplate,
  SponsorDocValidationError,
  getSponsorDocTemplate,
  sanitizeTemplateContent,
  validateSubmittedContent,
  type SponsorDocTemplateKey,
} from '../sponsorDocs/templates';
import type { SponsorDocEmailDelivery } from '../sponsorDocs/emailDelivery';

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_CHAR_COUNT = 16; // 16 * 5 bits = 80 bits of entropy
export const SPONSOR_DOC_RATE_WINDOW_SECONDS = 900; // 15 minutes
export const SPONSOR_DOC_MAX_FAILED_ATTEMPTS = 5;

export type SponsorDocActorKind = 'sponsor' | 'staff';
export type SponsorDocStatus = 'draft' | 'submitted';

export interface SponsorDocSummary {
  id: string;
  cardId: string;
  template: SponsorDocTemplateKey;
  title: string;
  sponsorName: string | null;
  publicationDate: string | null;
  linkType: string;
  status: SponsorDocStatus;
  submittedAt: string | null;
  lastEditedAt: string;
  lastEditedBy: SponsorDocActorKind;
  lastEditedByName: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  emailDelivery?: SponsorDocEmailDelivery | null;
}

export interface SponsorDoc extends SponsorDocSummary {
  submittedBy: SponsorDocActorKind | null;
  lastEditedByUserId: string | null;
  createdBy: string;
  content: Record<string, string>;
}

interface StoredSponsorDoc extends SponsorDoc {
  PK: string;
  SK: string;
  accessCodeHash: string;
  accessCodeCiphertext: string;
}

export function sponsorDocKey(id: string): { PK: string; SK: string } {
  return { PK: `SPONSOR_DOC#${id}`, SK: `SPONSOR_DOC#${id}` };
}

export function cardSponsorDocIndexKey(cardId: string, id: string): { PK: string; SK: string } {
  return { PK: `CARD_SPONSOR_DOCS#${cardId}`, SK: `SPONSOR_DOC#${id}` };
}

export function normalizeSponsorDocCode(raw: string): string {
  return String(raw || '').toUpperCase().replace(/[\s-]+/g, '');
}

function hashAccessCode(normalizedCode: string): Buffer {
  return createHash('sha256').update(`sponsor-doc-code-v1:${normalizedCode}`).digest();
}

export function generateSponsorDocAccessCode(): {
  code: string;
  normalized: string;
  hashHex: string;
} {
  const bytes = randomBytes(CODE_CHAR_COUNT);
  let chars = '';
  for (let i = 0; i < CODE_CHAR_COUNT; i += 1) {
    chars += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  const formatted = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
  return {
    code: formatted,
    normalized: chars,
    hashHex: hashAccessCode(chars).toString('hex'),
  };
}

function encryptionKeyForDoc(docId: string): Buffer {
  const secret = process.env.WORK_ENGINE_PORTAL_SECRET
    || process.env.PORTAL_SESSION_SECRET
    || 'dataops-sponsor-doc-local-key';
  return createHash('sha256').update(`sponsor-doc-cipher-v1:${secret}:${docId}`).digest();
}

export function encryptSponsorDocAccessCode(docId: string, formattedCode: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKeyForDoc(docId), iv);
  const encrypted = Buffer.concat([cipher.update(formattedCode, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

const encryptAccessCode = encryptSponsorDocAccessCode;

export function decryptSponsorDocAccessCode(docId: string, ciphertext: string | undefined): string | null {
  if (!ciphertext || typeof ciphertext !== 'string') return null;
  const parts = ciphertext.split(':');
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const data = Buffer.from(parts[2], 'hex');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKeyForDoc(docId), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * Constant-time comparison of a candidate access code against the stored SHA-256 digest.
 */
export function verifySponsorDocCodeConstantTime(candidateRaw: string, expectedHashHex: string): boolean {
  const normalized = normalizeSponsorDocCode(candidateRaw);
  const candidateDigest = hashAccessCode(normalized);
  const expectedDigest = Buffer.from(String(expectedHashHex || ''), 'hex');
  if (expectedDigest.length !== candidateDigest.length) {
    timingSafeEqual(candidateDigest, candidateDigest);
    return false;
  }
  const matches = timingSafeEqual(candidateDigest, expectedDigest);
  const validFormat = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8,32}$/.test(normalized);
  return matches && validFormat;
}

function toSummary(doc: SponsorDoc): SponsorDocSummary {
  return {
    id: doc.id,
    cardId: doc.cardId,
    template: doc.template,
    title: doc.title,
    sponsorName: doc.sponsorName,
    publicationDate: doc.publicationDate,
    linkType: doc.linkType,
    status: doc.status,
    submittedAt: doc.submittedAt,
    lastEditedAt: doc.lastEditedAt,
    lastEditedBy: doc.lastEditedBy,
    lastEditedByName: doc.lastEditedByName,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    version: doc.version,
    ...(doc.emailDelivery ? { emailDelivery: doc.emailDelivery } : {}),
  };
}

function cleanSponsorDoc(item: Record<string, unknown> | undefined): {
  doc: SponsorDoc;
  accessCodeHash: string;
  accessCodeCiphertext: string;
} | null {
  if (!item) return null;
  const {
    PK,
    SK,
    accessCodeHash,
    accessCodeCiphertext,
    ...rest
  } = item as unknown as StoredSponsorDoc;
  return {
    doc: rest,
    accessCodeHash: String(accessCodeHash || ''),
    accessCodeCiphertext: String(accessCodeCiphertext || ''),
  };
}

export interface CreateSponsorDocInput {
  cardId: string;
  template: SponsorDocTemplateKey;
  title: string;
  sponsorName?: string | null;
  publicationDate?: string | null;
  linkType?: string;
  content?: Record<string, unknown>;
  createdBy: string;
  createdByName?: string | null;
}

export async function createSponsorDoc(
  client: DynamoDBDocumentClient,
  input: CreateSponsorDocInput,
): Promise<{ doc: SponsorDoc; accessCode: string }> {
  const id = `sdoc-${randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();
  const generated = generateSponsorDocAccessCode();
  const ciphertext = encryptAccessCode(id, generated.code);
  const content = input.content
    ? sanitizeTemplateContent(input.template, input.content)
    : defaultContentForTemplate(input.template);
  const defaultLinkType = getSponsorDocTemplate(input.template).defaultLinkType;

  const doc: SponsorDoc = {
    id,
    cardId: input.cardId,
    template: input.template,
    title: input.title.trim(),
    sponsorName: input.sponsorName?.trim() || null,
    publicationDate: input.publicationDate?.trim() || null,
    linkType: (input.linkType || defaultLinkType).trim(),
    status: 'draft',
    submittedAt: null,
    submittedBy: null,
    content,
    lastEditedAt: now,
    lastEditedBy: 'staff',
    lastEditedByUserId: input.createdBy,
    lastEditedByName: input.createdByName || null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };

  const primaryItem: StoredSponsorDoc = {
    ...sponsorDocKey(id),
    ...doc,
    accessCodeHash: generated.hashHex,
    accessCodeCiphertext: ciphertext,
  };
  const indexItem = {
    ...cardSponsorDocIndexKey(doc.cardId, id),
    ...toSummary(doc),
  };

  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: primaryItem }));
  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: indexItem }));

  return { doc, accessCode: generated.code };
}

export async function getSponsorDocWithAuthMaterial(
  client: DynamoDBDocumentClient,
  id: string,
): Promise<{
  doc: SponsorDoc;
  accessCodeHash: string;
  accessCodeCiphertext: string;
} | null> {
  const res = await client.send(
    new GetCommand({
      TableName: TABLE_ARTIFACTS,
      Key: sponsorDocKey(id),
      ConsistentRead: true,
    }),
  );
  return cleanSponsorDoc(res.Item as Record<string, unknown> | undefined);
}

export async function getSponsorDoc(
  client: DynamoDBDocumentClient,
  id: string,
): Promise<SponsorDoc | null> {
  const loaded = await getSponsorDocWithAuthMaterial(client, id);
  return loaded ? loaded.doc : null;
}

export interface UpdateSponsorDocInput {
  title?: string;
  sponsorName?: string | null;
  publicationDate?: string | null;
  content?: Record<string, unknown>;
  /** Staff only: switch the document type, carrying over shared fields. */
  template?: SponsorDocTemplateKey;
  status?: SponsorDocStatus;
  actorKind: SponsorDocActorKind;
  actorUserId?: string | null;
  actorName?: string | null;
}

export async function updateSponsorDoc(
  client: DynamoDBDocumentClient,
  id: string,
  input: UpdateSponsorDocInput,
): Promise<SponsorDoc | null> {
  const loaded = await getSponsorDocWithAuthMaterial(client, id);
  if (!loaded) return null;
  const { doc, accessCodeHash, accessCodeCiphertext } = loaded;
  const now = new Date().toISOString();

  const nextStatus: SponsorDocStatus = input.status !== undefined ? input.status : doc.status;
  let submittedAt = doc.submittedAt;
  let submittedBy = doc.submittedBy;
  if (nextStatus === 'submitted' && doc.status !== 'submitted') {
    submittedAt = now;
    submittedBy = input.actorKind;
  } else if (nextStatus === 'draft') {
    submittedAt = null;
    submittedBy = null;
  }

  const nextTemplate = input.actorKind === 'staff' && input.template ? input.template : doc.template;
  let nextContent: Record<string, string>;
  if (nextTemplate !== doc.template) {
    const carried: Record<string, unknown> = { ...doc.content, ...(input.content || {}) };
    nextContent = sanitizeTemplateContent(nextTemplate, carried, defaultContentForTemplate(nextTemplate));
    const dropped = Object.entries(carried)
      .filter(([key, value]) => !Object.hasOwn(nextContent, key) && String(value ?? '').trim());
    if (dropped.length) {
      throw new SponsorDocValidationError(Object.fromEntries(dropped.map(([key]) => [
        key, `${key} has no place in the ${getSponsorDocTemplate(nextTemplate).shortLabel} form; clear it before switching.`,
      ])));
    }
  } else {
    nextContent = input.content
      ? sanitizeTemplateContent(doc.template, input.content, doc.content, { includeInternal: input.actorKind === 'staff' })
      : doc.content;
  }

  if (nextStatus === 'submitted') validateSubmittedContent(nextTemplate, nextContent);
  const linkType = nextTemplate !== doc.template && doc.linkType === getSponsorDocTemplate(doc.template).defaultLinkType
    ? getSponsorDocTemplate(nextTemplate).defaultLinkType
    : doc.linkType;

  const updated: SponsorDoc = {
    ...doc,
    template: nextTemplate,
    linkType,
    title: input.title !== undefined && input.title.trim() ? input.title.trim() : doc.title,
    sponsorName: input.sponsorName !== undefined ? (input.sponsorName?.trim() || null) : doc.sponsorName,
    publicationDate: input.publicationDate !== undefined ? (input.publicationDate?.trim() || null) : doc.publicationDate,
    status: nextStatus,
    submittedAt,
    submittedBy,
    content: nextContent,
    lastEditedAt: now,
    lastEditedBy: input.actorKind,
    lastEditedByUserId: input.actorKind === 'staff' ? (input.actorUserId || null) : null,
    lastEditedByName: input.actorKind === 'staff' ? (input.actorName || null) : 'Sponsor',
    updatedAt: now,
    version: (doc.version || 1) + 1,
  };

  const primaryItem: StoredSponsorDoc = {
    ...sponsorDocKey(id),
    ...updated,
    accessCodeHash,
    accessCodeCiphertext,
  };
  const indexItem = {
    ...cardSponsorDocIndexKey(updated.cardId, id),
    ...toSummary(updated),
  };

  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: primaryItem }));
  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: indexItem }));

  return updated;
}

export async function setSponsorDocEmailDelivery(
  client: DynamoDBDocumentClient,
  id: string,
  emailDelivery: SponsorDocEmailDelivery,
): Promise<SponsorDoc | null> {
  const loaded = await getSponsorDocWithAuthMaterial(client, id);
  if (!loaded) return null;
  const { doc, accessCodeHash, accessCodeCiphertext } = loaded;
  const updated: SponsorDoc = {
    ...doc,
    emailDelivery,
  };
  const primaryItem: StoredSponsorDoc = {
    ...sponsorDocKey(id),
    ...updated,
    accessCodeHash,
    accessCodeCiphertext,
  };
  const indexItem = {
    ...cardSponsorDocIndexKey(updated.cardId, id),
    ...toSummary(updated),
  };
  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: primaryItem }));
  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: indexItem }));
  return updated;
}

export async function rotateSponsorDocAccessCode(
  client: DynamoDBDocumentClient,
  id: string,
): Promise<{ doc: SponsorDoc; accessCode: string } | null> {
  const loaded = await getSponsorDocWithAuthMaterial(client, id);
  if (!loaded) return null;
  const { doc } = loaded;
  const generated = generateSponsorDocAccessCode();
  const ciphertext = encryptAccessCode(id, generated.code);
  const now = new Date().toISOString();
  const updated: SponsorDoc = {
    ...doc,
    updatedAt: now,
    version: (doc.version || 1) + 1,
  };

  const primaryItem: StoredSponsorDoc = {
    ...sponsorDocKey(id),
    ...updated,
    accessCodeHash: generated.hashHex,
    accessCodeCiphertext: ciphertext,
  };
  const indexItem = {
    ...cardSponsorDocIndexKey(updated.cardId, id),
    ...toSummary(updated),
  };

  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: primaryItem }));
  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: indexItem }));

  return { doc: updated, accessCode: generated.code };
}

export async function deleteSponsorDoc(
  client: DynamoDBDocumentClient,
  id: string,
): Promise<SponsorDoc | null> {
  const loaded = await getSponsorDocWithAuthMaterial(client, id);
  if (!loaded) return null;
  const { doc } = loaded;
  await client.send(new DeleteCommand({ TableName: TABLE_ARTIFACTS, Key: sponsorDocKey(id) }));
  await client.send(
    new DeleteCommand({ TableName: TABLE_ARTIFACTS, Key: cardSponsorDocIndexKey(doc.cardId, id) }),
  );
  return doc;
}

export async function listSponsorDocSummariesByCardId(
  client: DynamoDBDocumentClient,
  cardId: string,
): Promise<SponsorDocSummary[]> {
  if (!cardId) return [];
  const res = await client.send(
    new QueryCommand({
      TableName: TABLE_ARTIFACTS,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `CARD_SPONSOR_DOCS#${cardId}`,
      },
    }),
  );
  const items = (res.Items || []) as Array<Record<string, unknown>>;
  return items
    .map((item) => {
      const { PK, SK, ...summary } = item;
      return summary as unknown as SponsorDocSummary;
    })
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

export async function listAllSponsorDocSummaries(
  client: DynamoDBDocumentClient,
): Promise<SponsorDocSummary[]> {
  const summaries: SponsorDocSummary[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: TABLE_ARTIFACTS,
        FilterExpression: 'begins_with(PK, :prefix)',
        ExpressionAttributeValues: { ':prefix': 'CARD_SPONSOR_DOCS#' },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of page.Items || []) {
      const { PK, SK, ...summary } = item as Record<string, unknown>;
      summaries.push(summary as unknown as SponsorDocSummary);
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return summaries.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

// ── Access Code Rate Limiting (stored in TABLE_SESSIONS with TTL) ─────────────

function rateLimitKey(docId: string, requestIp: string): { PK: string; SK: string } {
  const ipHash = createHash('sha256')
    .update(`sponsor-doc-rate:${requestIp || 'unknown'}`)
    .digest('hex')
    .slice(0, 24);
  const key = `SPONSORDOC_RATE#${docId}#${ipHash}`;
  return { PK: key, SK: key };
}

export interface SponsorDocRateLimitStatus {
  allowed: boolean;
  attempts: number;
  retryAfterSeconds: number;
}

export async function checkSponsorDocRateLimit(
  client: DynamoDBDocumentClient,
  docId: string,
  requestIp: string,
  now = new Date(),
): Promise<SponsorDocRateLimitStatus> {
  const key = rateLimitKey(docId, requestIp);
  const res = await client.send(
    new GetCommand({
      TableName: TABLE_SESSIONS,
      Key: key,
      ConsistentRead: true,
    }),
  );
  const item = res.Item as Record<string, unknown> | undefined;
  if (!item) {
    return { allowed: true, attempts: 0, retryAfterSeconds: 0 };
  }
  const expiresMs = Date.parse(String(item.windowExpiresAt || ''));
  const attempts = Number(item.attempts || 0);
  if (Number.isNaN(expiresMs) || expiresMs <= now.getTime()) {
    return { allowed: true, attempts: 0, retryAfterSeconds: 0 };
  }
  if (attempts >= SPONSOR_DOC_MAX_FAILED_ATTEMPTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((expiresMs - now.getTime()) / 1000));
    return { allowed: false, attempts, retryAfterSeconds };
  }
  return { allowed: true, attempts, retryAfterSeconds: 0 };
}

export async function recordSponsorDocFailedAttempt(
  client: DynamoDBDocumentClient,
  docId: string,
  requestIp: string,
  now = new Date(),
): Promise<SponsorDocRateLimitStatus> {
  const key = rateLimitKey(docId, requestIp);
  const current = await checkSponsorDocRateLimit(client, docId, requestIp, now);
  const nextAttempts = current.attempts + 1;
  const windowExpiresAt = new Date(now.getTime() + SPONSOR_DOC_RATE_WINDOW_SECONDS * 1000).toISOString();
  const ttl = Math.floor((now.getTime() + SPONSOR_DOC_RATE_WINDOW_SECONDS * 1000) / 1000);

  await client.send(
    new PutCommand({
      TableName: TABLE_SESSIONS,
      Item: {
        ...key,
        docId,
        attempts: nextAttempts,
        windowExpiresAt,
        ttl,
        updatedAt: now.toISOString(),
      },
    }),
  );

  const allowed = nextAttempts < SPONSOR_DOC_MAX_FAILED_ATTEMPTS;
  return {
    allowed,
    attempts: nextAttempts,
    retryAfterSeconds: allowed ? 0 : SPONSOR_DOC_RATE_WINDOW_SECONDS,
  };
}

export async function clearSponsorDocRateLimit(
  client: DynamoDBDocumentClient,
  docId: string,
  requestIp: string,
): Promise<void> {
  const key = rateLimitKey(docId, requestIp);
  await client.send(new DeleteCommand({ TableName: TABLE_SESSIONS, Key: key }));
}
