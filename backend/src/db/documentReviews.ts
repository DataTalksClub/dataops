import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_DOCUMENT_REVIEWS } from './tableNames';
import type { DocumentReviewRecord } from '../types';

const CURRENT_SK = 'CURRENT';
const PARTITION_PREFIX = 'DOCUMENT_REVIEW#';

function partitionKey(documentId: string): string {
  return `${PARTITION_PREFIX}${documentId}`;
}

function cleanItem(item: Record<string, unknown> | undefined): DocumentReviewRecord | null {
  if (!item) return null;
  const { PK: _pk, SK: _sk, recordType: _recordType, ...record } = item;
  return record as unknown as DocumentReviewRecord;
}

function currentItem(record: DocumentReviewRecord): Record<string, unknown> {
  return {
    PK: partitionKey(record.documentId),
    SK: CURRENT_SK,
    recordType: 'current',
    ...record,
  };
}

function historyItem(record: DocumentReviewRecord): Record<string, unknown> {
  return {
    PK: partitionKey(record.documentId),
    SK: `REVIEW#${record.reviewedAt}#${record.id}`,
    recordType: 'history',
    ...record,
  };
}

export async function getDocumentReview(
  client: DynamoDBDocumentClient,
  documentId: string,
): Promise<DocumentReviewRecord | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_DOCUMENT_REVIEWS,
    Key: { PK: partitionKey(documentId), SK: CURRENT_SK },
  }));
  return cleanItem(result.Item as Record<string, unknown> | undefined);
}

export async function listDocumentReviews(
  client: DynamoDBDocumentClient,
): Promise<DocumentReviewRecord[]> {
  const records: DocumentReviewRecord[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_DOCUMENT_REVIEWS,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :current',
      ExpressionAttributeValues: {
        ':prefix': PARTITION_PREFIX,
        ':current': CURRENT_SK,
      },
      ExclusiveStartKey: cursor,
    }));
    for (const item of result.Items || []) {
      const record = cleanItem(item as Record<string, unknown>);
      if (record) records.push(record);
    }
    cursor = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);

  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listDocumentReviewHistory(
  client: DynamoDBDocumentClient,
  documentId: string,
): Promise<DocumentReviewRecord[]> {
  const records: DocumentReviewRecord[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new QueryCommand({
      TableName: TABLE_DOCUMENT_REVIEWS,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :historyPrefix)',
      ExpressionAttributeValues: {
        ':pk': partitionKey(documentId),
        ':historyPrefix': 'REVIEW#',
      },
      ScanIndexForward: false,
      ExclusiveStartKey: cursor,
    }));
    for (const item of result.Items || []) {
      const record = cleanItem(item as Record<string, unknown>);
      if (record) records.push(record);
    }
    cursor = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);

  return records;
}

export async function saveDocumentReview(
  client: DynamoDBDocumentClient,
  record: DocumentReviewRecord,
): Promise<void> {
  const current = currentItem(record);
  const history = historyItem(record);
  const transaction = [
    {
      Put: {
        TableName: TABLE_DOCUMENT_REVIEWS,
        Item: current,
      },
    },
    {
      Put: {
        TableName: TABLE_DOCUMENT_REVIEWS,
        Item: history,
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
  ];

  // Dynalite does not implement TransactWriteItems. Test runs are already
  // isolated to a local database, so the two writes remain deterministic there;
  // production and staging use the atomic transaction below.
  if (process.env.NODE_ENV === 'test') {
    await client.send(new PutCommand({ TableName: TABLE_DOCUMENT_REVIEWS, Item: current }));
    await client.send(new PutCommand({ TableName: TABLE_DOCUMENT_REVIEWS, Item: history }));
    return;
  }
  await client.send(new TransactWriteCommand({ TransactItems: transaction }));
}

