import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_CONVERSATIONAL_STATE } from '../db/tableNames';
import {
  expiryFrom,
  isExpired,
  validateConversationalRecord,
  type ExecutionAttempt,
} from './types';
import {
  clean,
  putTargetAndLinkForLocalTest,
  queryPage,
  relationshipLink,
  storageItem,
  type Key,
  type Page,
} from './conversationStorage';
import { filterLiveOwners, getConversation, requireConversation } from './conversations';

async function createExecutionAttempt(client: DynamoDBDocumentClient, attempt: ExecutionAttempt): Promise<void> {
  validateConversationalRecord(attempt);
  await requireConversation(client, attempt.conversationId);
  const item = storageItem(attempt);
  const link = relationshipLink(attempt.conversationId, attempt.id, item, attempt.expiresAt, attempt.ttl);
  if (process.env.NODE_ENV === 'test') {
    await putTargetAndLinkForLocalTest(client, item, link);
    return;
  }
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: TABLE_CONVERSATIONAL_STATE,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      {
        Put: {
          TableName: TABLE_CONVERSATIONAL_STATE,
          Item: link,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ],
  }));
}

async function getExecutionAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  now = new Date()
): Promise<ExecutionAttempt | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
  }));
  const attempt = clean<ExecutionAttempt>(result.Item as Record<string, unknown> | undefined);
  if (!attempt || isExpired(attempt, now)) return null;
  return (await getConversation(client, attempt.conversationId, now)) ? attempt : null;
}

async function compareAndSetExecutionAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  expectedStatus: ExecutionAttempt['status'],
  status: ExecutionAttempt['status'],
  expectedRevision: number,
  updatedAt: string
): Promise<ExecutionAttempt> {
  const existing = await getExecutionAttempt(client, attemptId);
  if (!existing) throw new Error('execution attempt unavailable');
  const next = {
    ...existing,
    status,
    revision: expectedRevision + 1,
    updatedAt,
    ...expiryFrom(updatedAt, 365),
  };
  validateConversationalRecord(next);
  const item = storageItem(next);
  const result = await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: item,
    ConditionExpression: '#status = :expectedStatus AND revision = :expectedRevision',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':expectedStatus': expectedStatus, ':expectedRevision': expectedRevision },
    ReturnValues: 'ALL_OLD',
  }));
  if (!result.Attributes) throw new Error('execution attempt unavailable');
  return next;
}

async function listRecoveryCandidates(
  client: DynamoDBDocumentClient,
  status: ExecutionAttempt['status'],
  readyThrough: string,
  cursor?: Key,
  limit = 50,
  now = new Date()
): Promise<Page<ExecutionAttempt>> {
  const page = await queryPage<ExecutionAttempt>(client, {
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK <= :through',
    ExpressionAttributeValues: {
      ':pk': `ATTEMPT_STATE#${status}`,
      ':through': `READY#${readyThrough}#\uffff`,
    },
  }, cursor, limit);
  page.items = (await filterLiveOwners(client, page.items, now)).filter((item) => (
    !item.recoveryBlocked
    && (item.status !== 'executing' || !item.leaseExpiresAt || item.leaseExpiresAt <= readyThrough)
  ));
  return page;
}

export type { Key, Page };
export {
  compareAndSetExecutionAttempt,
  createExecutionAttempt,
  getExecutionAttempt,
  listRecoveryCandidates,
};
