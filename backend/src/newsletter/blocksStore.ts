/**
 * Storage for newsletter issue drafts (see ./blocks.ts).
 *
 * One item per issue holds the whole draft (a weekly issue has ~10 small
 * blocks), written with an optimistic `version` condition so two writers never
 * silently overwrite each other. Every change appends one revision item
 * (before/after of one block, or an approval / delivery event), the audit
 * history `dataops newsletter revisions` reads. An approved payload is frozen
 * in its own item, keyed by its hash, so delivery sends exactly those bytes.
 *
 * Drafts first built by the retired Relay import keep their archived Relay
 * attributes (`relay`, `relayIssue`, `base`, `deleted`, ...) untouched in the
 * stored item; nothing reads them except the one-time subject/preview default
 * below, and writes spread the stored item so they are preserved.
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_ARTIFACTS } from '../db/tableNames';
import type { BlockData, IssueBlockSet } from './blocks';

export type BlockRevisionOrigin =
  | 'create'
  | 'edit'
  | 'add'
  | 'move'
  | 'delete'
  | 'details'
  | 'sponsor-doc'
  | 'approve'
  | 'approval-withdrawn'
  | 'test-send'
  | 'schedule'
  | 'cancel'
  // Archived origins written by the retired Relay import/sync; shown in history only.
  | 'import'
  | 'relay-pull'
  | 'relay-remove';

export interface BlockRevision {
  issueId: string;
  revision: number;
  blockId: string;
  /** Archived revisions of drafts built by the retired Relay import carry the Relay block id. */
  relayBlockId?: number | null;
  blockType: string;
  origin: BlockRevisionOrigin;
  createdAt: string;
  actorUserId: string;
  actorName: string | null;
  /** Who changed it in Relay, for pulled revisions (Relay's `updated_by`). */
  relayActor?: string;
  /** Human-readable note, e.g. "moved from position 3 to 5". */
  detail?: string;
  before: BlockData | null;
  after: BlockData | null;
}

export class BlockSetVersionConflict extends Error {
  constructor(issueId: string) {
    super(`The blocks of issue ${issueId} changed while saving; reload and retry.`);
  }
}

const setKey = (issueId: string) => ({ PK: `NL_BLOCKS#${issueId}`, SK: 'SET' });
const revisionPk = (issueId: string) => `NL_BLOCK_REV#${issueId}`;
const revisionKey = (issueId: string, revision: number) => ({
  PK: revisionPk(issueId),
  SK: `REV#${String(revision).padStart(8, '0')}`,
});

function strip<T>(item: Record<string, unknown> | undefined): T | null {
  if (!item) return null;
  const { PK: _pk, SK: _sk, ...rest } = item;
  return rest as T;
}

/**
 * A draft built by the retired Relay import has no subject/preview of its own:
 * it starts from the archived Relay snapshot (`relayIssue`) until it is saved.
 */
function normalizeSet(raw: Record<string, unknown>): IssueBlockSet {
  const archived = (raw.relayIssue || {}) as { subject?: string; previewText?: string };
  return {
    ...(raw as unknown as IssueBlockSet),
    subject: typeof raw.subject === 'string' ? raw.subject : archived.subject || '',
    previewText: typeof raw.previewText === 'string' ? raw.previewText : archived.previewText || '',
    webViewToken: typeof raw.webViewToken === 'string' ? raw.webViewToken : '',
  };
}

export async function getBlockSet(client: DynamoDBDocumentClient, issueId: string): Promise<IssueBlockSet | null> {
  const res = await client.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: setKey(issueId), ConsistentRead: true }));
  const item = strip<Record<string, unknown>>(res.Item as Record<string, unknown> | undefined);
  return item ? normalizeSet(item) : null;
}

/**
 * Write `next` if the stored set is still at `expectedVersion` (0 = must not
 * exist yet). `next.version` must be `expectedVersion + 1`.
 */
export async function putBlockSet(
  client: DynamoDBDocumentClient,
  next: IssueBlockSet,
  expectedVersion: number,
): Promise<void> {
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_ARTIFACTS,
        Item: { ...setKey(next.issueId), ...next },
        ...(expectedVersion === 0
          ? { ConditionExpression: 'attribute_not_exists(PK)' }
          : {
              ConditionExpression: '#version = :expected',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':expected': expectedVersion },
            }),
      }),
    );
  } catch (error) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      throw new BlockSetVersionConflict(next.issueId);
    }
    throw error;
  }
}

export async function deleteBlockSet(client: DynamoDBDocumentClient, issueId: string): Promise<void> {
  await client.send(new DeleteCommand({ TableName: TABLE_ARTIFACTS, Key: setKey(issueId) }));
  for (const revision of await listBlockRevisions(client, issueId)) {
    await client.send(new DeleteCommand({ TableName: TABLE_ARTIFACTS, Key: revisionKey(issueId, revision.revision) }));
  }
  for (const payload of await listFrozenPayloadKeys(client, issueId)) {
    await client.send(new DeleteCommand({ TableName: TABLE_ARTIFACTS, Key: payload }));
  }
}

// ---------------------------------------------------------------- frozen payloads

/** The exact email an approval covers; delivery sends these bytes and nothing else. */
export interface FrozenPayload {
  issueId: string;
  payloadHash: string;
  draftVersion: number;
  subject: string;
  previewText: string;
  html: string;
  text: string;
  /** The public web-view token the HTML links to. */
  webViewToken: string;
  createdAt: string;
  createdBy: string;
}

const payloadPk = (issueId: string) => `NL_PAYLOAD#${issueId}`;
const payloadKey = (issueId: string, hash: string) => ({ PK: payloadPk(issueId), SK: `HASH#${hash}` });

/** Store a frozen payload; an identical payload already stored is kept as is. */
export async function putFrozenPayload(client: DynamoDBDocumentClient, payload: FrozenPayload): Promise<void> {
  try {
    await client.send(new PutCommand({
      TableName: TABLE_ARTIFACTS,
      Item: { ...payloadKey(payload.issueId, payload.payloadHash), ...payload },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (error) {
    if ((error as { name?: string })?.name !== 'ConditionalCheckFailedException') throw error;
  }
}

export async function getFrozenPayload(client: DynamoDBDocumentClient, issueId: string, hash: string): Promise<FrozenPayload | null> {
  const res = await client.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: payloadKey(issueId, hash), ConsistentRead: true }));
  return strip<FrozenPayload>(res.Item as Record<string, unknown> | undefined);
}

async function listFrozenPayloadKeys(client: DynamoDBDocumentClient, issueId: string): Promise<{ PK: string; SK: string }[]> {
  const keys: { PK: string; SK: string }[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new QueryCommand({
      TableName: TABLE_ARTIFACTS,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': payloadPk(issueId) },
      ProjectionExpression: 'PK, SK',
      ExclusiveStartKey: start,
    }));
    for (const item of page.Items || []) keys.push({ PK: String(item.PK), SK: String(item.SK) });
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  return keys;
}

// ---------------------------------------------------------------- public web view

const webViewKey = (token: string) => ({ PK: `NL_WEBVIEW#${token}`, SK: 'VIEW' });

/** Point a public web-view token at the payload Relay was asked to send. */
export async function putWebView(client: DynamoDBDocumentClient, token: string, issueId: string, payloadHash: string): Promise<void> {
  await client.send(new PutCommand({
    TableName: TABLE_ARTIFACTS,
    Item: { ...webViewKey(token), issueId, payloadHash, updatedAt: new Date().toISOString() },
  }));
}

export async function getWebView(client: DynamoDBDocumentClient, token: string): Promise<{ issueId: string; payloadHash: string } | null> {
  const res = await client.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: webViewKey(token) }));
  const item = res.Item as Record<string, unknown> | undefined;
  return item ? { issueId: String(item.issueId), payloadHash: String(item.payloadHash) } : null;
}

export async function deleteWebView(client: DynamoDBDocumentClient, token: string): Promise<void> {
  await client.send(new DeleteCommand({ TableName: TABLE_ARTIFACTS, Key: webViewKey(token) }));
}

async function latestRevisionNumber(client: DynamoDBDocumentClient, issueId: string): Promise<number> {
  const res = await client.send(
    new QueryCommand({
      TableName: TABLE_ARTIFACTS,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': revisionPk(issueId) },
      ScanIndexForward: false,
      Limit: 1,
      ConsistentRead: true,
    }),
  );
  const latest = strip<BlockRevision>((res.Items || [])[0] as Record<string, unknown> | undefined);
  return latest?.revision || 0;
}

/** Append revisions in order; numbers continue from the latest stored one. */
export async function appendBlockRevisions(
  client: DynamoDBDocumentClient,
  issueId: string,
  revisions: Omit<BlockRevision, 'issueId' | 'revision'>[],
): Promise<BlockRevision[]> {
  const written: BlockRevision[] = [];
  let next = revisions.length ? await latestRevisionNumber(client, issueId) : 0;
  for (const revision of revisions) {
    for (let attempt = 0; ; attempt += 1) {
      next += 1;
      const item: BlockRevision = { ...revision, issueId, revision: next };
      try {
        await client.send(
          new PutCommand({
            TableName: TABLE_ARTIFACTS,
            Item: { ...revisionKey(issueId, next), ...item },
            ConditionExpression: 'attribute_not_exists(PK)',
          }),
        );
        written.push(item);
        break;
      } catch (error) {
        if ((error as { name?: string })?.name !== 'ConditionalCheckFailedException' || attempt >= 4) throw error;
        // A concurrent writer took the number; continue after the latest one.
        next = await latestRevisionNumber(client, issueId);
      }
    }
  }
  return written;
}

export async function listBlockRevisions(client: DynamoDBDocumentClient, issueId: string): Promise<BlockRevision[]> {
  const revisions: BlockRevision[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: TABLE_ARTIFACTS,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': revisionPk(issueId) },
        ScanIndexForward: true,
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }),
    );
    for (const item of page.Items || []) {
      const revision = strip<BlockRevision>(item as Record<string, unknown>);
      if (revision) revisions.push(revision);
    }
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  return revisions;
}
