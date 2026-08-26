import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  QueryCommand,
  ScanCommand,
  type QueryCommandInput,
  type ScanCommandInput,
} from '@aws-sdk/lib-dynamodb';

import {
  CollectionCursorError,
  decodeCollectionCursor,
  parseCollectionLimit,
  validExclusiveStartKey,
  type CollectionInput,
  type CursorBinding,
  type ExclusiveStartKey,
} from './collectionPagination';

const PHYSICAL_PAGE_SIZE = 25;
const MAX_PHYSICAL_PAGES = 50;
const PAGE_DEADLINE_MS = 3000;

export interface LogicalPage<T> {
  items: T[];
  nextExclusiveStartKey?: ExclusiveStartKey;
}

export type CollectionKeyFor<T> = (item: T) => ExclusiveStartKey;

interface LogicalPageRequestBase<T> {
  client: DynamoDBDocumentClient;
  tableName: string;
  binding: CursorBinding;
  input: CollectionInput;
  cleanItem: (item: Record<string, unknown>) => T;
  keyFor: CollectionKeyFor<T>;
  matches?: (item: T) => boolean;
  physicalPageSize?: number;
  now?: () => number;
}

type LogicalPageRequest<T> =
  | (LogicalPageRequestBase<T> & {
    kind: 'query';
    command: Omit<QueryCommandInput, 'TableName' | 'ExclusiveStartKey' | 'Limit'>;
  })
  | (LogicalPageRequestBase<T> & {
    kind: 'scan';
    command: Omit<ScanCommandInput, 'TableName' | 'ExclusiveStartKey' | 'Limit'>;
  });

class CollectionPageStorageError extends Error {
  constructor() {
    super('Collection continuation failed');
    this.name = 'CollectionPageStorageError';
  }
}

function nextKey(value: unknown): ExclusiveStartKey | undefined {
  if (value === undefined) return undefined;
  if (!validExclusiveStartKey(value)) throw new CollectionPageStorageError();
  return value;
}

/**
 * Read one client-facing page while advancing DynamoDB in bounded physical
 * requests. Each physical request is capped by the remaining logical capacity,
 * so in-memory filtering cannot cause an over-return and an entirely filtered
 * page cannot masquerade as the end of the collection.
 */
export async function readCollectionPage<T>(
  request: LogicalPageRequest<T>,
): Promise<LogicalPage<T>> {
  let limit: number;
  let exclusiveStartKey: ExclusiveStartKey | undefined;
  try {
    limit = parseCollectionLimit(request.input.limit);
    exclusiveStartKey = request.input.cursor === undefined
      ? undefined
      : await decodeCollectionCursor(request.binding, request.input.cursor);
  } catch (error) {
    if (error instanceof CollectionCursorError) throw error;
    throw new CollectionPageStorageError();
  }

  const pageSize = Math.min(Math.max(request.physicalPageSize ?? PHYSICAL_PAGE_SIZE, 1), 200);
  const startedAt = (request.now || Date.now)();
  const accepted: T[] = [];
  const seenKeys = new Set<string>();

  for (let pageIndex = 0; pageIndex < MAX_PHYSICAL_PAGES; pageIndex += 1) {
    if ((request.now || Date.now)() - startedAt >= PAGE_DEADLINE_MS) break;
    const remaining = limit - accepted.length;
    const command = {
      ...request.command,
      TableName: request.tableName,
      Limit: Math.min(pageSize, remaining),
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    };
    let result: { Items?: unknown; LastEvaluatedKey?: unknown };
    try {
      result = await (request.kind === 'query'
        ? request.client.send(new QueryCommand(command))
        : request.client.send(new ScanCommand(command)));
    } catch {
      throw new CollectionPageStorageError();
    }
    if (!Array.isArray(result.Items)) throw new CollectionPageStorageError();

    for (const rawItem of result.Items) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        throw new CollectionPageStorageError();
      }
      let item: T;
      try {
        item = request.cleanItem(rawItem as Record<string, unknown>);
      } catch {
        throw new CollectionPageStorageError();
      }
      if (!request.matches || request.matches(item)) accepted.push(item);
    }

    const lastEvaluatedKey = nextKey(result.LastEvaluatedKey);
    if (!lastEvaluatedKey) return { items: accepted };
    if (accepted.length >= limit) {
      const boundary = accepted[limit - 1];
      return {
        items: accepted.slice(0, limit),
        nextExclusiveStartKey: request.keyFor(boundary),
      };
    }

    const fingerprint = JSON.stringify(lastEvaluatedKey);
    if (seenKeys.has(fingerprint)) throw new CollectionPageStorageError();
    seenKeys.add(fingerprint);
    exclusiveStartKey = lastEvaluatedKey;
  }

  // A traversal ceiling is a truthful partial page when DynamoDB still has a
  // continuation key; normal source exhaustion always returned above.
  if (!exclusiveStartKey) throw new CollectionPageStorageError();
  return { items: accepted, nextExclusiveStartKey: exclusiveStartKey };
}
