/**
 * Storage for newsletter issue blocks (see ./blocks.ts).
 *
 * One item per issue holds the whole block set (a weekly issue has ~10 small
 * blocks), written with an optimistic `version` condition so two writers never
 * silently overwrite each other. Every content change appends one revision
 * item (before/after of one block), the history `dataops newsletter revisions`
 * reads.
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_ARTIFACTS } from '../db/tableNames';
import type { BlockData, IssueBlockSet } from './blocks';

export type BlockRevisionOrigin =
  | 'import'
  | 'edit'
  | 'add'
  | 'move'
  | 'delete'
  | 'sponsor-doc'
  | 'relay-pull'
  | 'relay-remove';

export interface BlockRevision {
  issueId: string;
  revision: number;
  blockId: string;
  relayBlockId: number | null;
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

export async function getBlockSet(client: DynamoDBDocumentClient, issueId: string): Promise<IssueBlockSet | null> {
  const res = await client.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: setKey(issueId), ConsistentRead: true }));
  return strip<IssueBlockSet>(res.Item as Record<string, unknown> | undefined);
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
