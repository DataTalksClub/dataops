import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_CONVERSATIONAL_STATE } from '../db/tableNames';
import {
  validateConversationalRecord,
  type ConversationalRecord,
  type ExecutionAttempt,
} from './types';

type Key = Record<string, unknown>;
interface Page<T> { items: T[]; cursor?: Key }

const EVENT_WIDTH = 16;
const VERSION_WIDTH = 12;

function eventSk(sequence: number, eventId: string): string {
  return `EVENT#${String(sequence).padStart(EVENT_WIDTH, '0')}#${eventId}`;
}

function versionSk(version: number): string {
  return `VERSION#${String(version).padStart(VERSION_WIDTH, '0')}`;
}

function recoverySortKey(attempt: ExecutionAttempt): string {
  return `READY#${attempt.readyAt}#LEASE#${attempt.leaseExpiresAt || '-'}#${attempt.id}`;
}

function storageItem(record: ConversationalRecord): Record<string, unknown> {
  validateConversationalRecord(record);
  switch (record.recordType) {
    case 'identity_binding':
      return {
        ...record,
        PK: `IDENTITY#${record.channel}#${record.channelUserId}`,
        SK: 'META',
        GSI1PK: `USER#${record.userId}`,
        GSI1SK: `IDENTITY#${record.channel}#${record.channelUserId}`,
        GSI2PK: `IDENTITY_CHANNEL#${record.channel}`,
        GSI2SK: record.channelUserId,
      };
    case 'identity_binding_audit':
      return {
        ...record,
        PK: `IDENTITY_AUDIT#${record.channel}#${record.channelUserId}`,
        SK: `${record.createdAt}#${record.id}`,
        GSI1PK: `USER#${record.userId}`,
        GSI1SK: `IDENTITY_AUDIT#${record.createdAt}#${record.id}`,
      };
    case 'conversation':
      return {
        ...record,
        PK: `CONVERSATION#${record.id}`,
        SK: 'META',
        GSI1PK: `USER#${record.ownerUserId}`,
        GSI1SK: `CONVERSATION#${record.updatedAt}#${record.id}`,
      };
    case 'channel_binding':
      return {
        ...record,
        PK: `CHANNEL#${record.channel}#${record.channelConversationKey}`,
        SK: 'BINDING',
        GSI1PK: `CONVERSATION#${record.conversationId}`,
        GSI1SK: `CHANNEL_BINDING#${record.channel}#${record.channelConversationKey}`,
      };
    case 'conversation_event':
      return related(record, `CONVERSATION#${record.conversationId}`, eventSk(record.sequence, record.id), `EVENT#${String(record.sequence).padStart(EVENT_WIDTH, '0')}#${record.id}`);
    case 'summary_checkpoint':
      return related(record, `CONVERSATION#${record.conversationId}`, 'SUMMARY#CURRENT', 'SUMMARY#CURRENT');
    case 'plugin_draft':
      return related(record, `CONVERSATION#${record.conversationId}`, `DRAFT#${record.id}`, `DRAFT#${record.id}`);
    case 'proposal_version':
      return {
        ...record,
        PK: `PROPOSAL#${record.proposalId}`,
        SK: versionSk(record.version),
        GSI1PK: `CONVERSATION#${record.conversationId}`,
        GSI1SK: `PROPOSAL#${record.proposalId}#${versionSk(record.version)}`,
      };
    case 'proposal_presentation':
      return {
        ...record,
        PK: `PRESENTATION#${record.actionTokenHash}`,
        SK: 'META',
        GSI1PK: `PROPOSAL#${record.proposalId}#${record.proposalVersion}`,
        GSI1SK: `PRESENTATION#${record.createdAt}#${record.id}`,
        conversationRelationshipPK: `CONVERSATION#${record.conversationId}`,
      };
    case 'execution_attempt':
      return {
        ...record,
        PK: `ATTEMPT#${record.id}`,
        SK: 'META',
        GSI1PK: `PROPOSAL#${record.proposalId}#${record.proposalVersion}`,
        GSI1SK: `ATTEMPT#${String(record.attemptNumber).padStart(8, '0')}#${record.id}`,
        GSI2PK: `ATTEMPT_STATE#${record.status}`,
        GSI2SK: recoverySortKey(record),
        conversationRelationshipPK: `CONVERSATION#${record.conversationId}`,
      };
    case 'conversation_audit_event':
      return {
        ...record,
        PK: `AUDIT#${record.subjectType}#${record.subjectId}`,
        SK: `${record.createdAt}#${record.id}`,
        GSI1PK: `CONVERSATION#${record.conversationId}`,
        GSI1SK: `AUDIT#${record.createdAt}#${record.id}`,
      };
    case 'result_notification':
      return {
        ...record,
        PK: `RESULT_NOTIFICATION#${record.id}`,
        SK: 'META',
        GSI1PK: `CONVERSATION#${record.conversationId}`,
        GSI1SK: `RESULT_NOTIFICATION#${record.createdAt}#${record.id}`,
        GSI2PK: `RESULT_NOTIFICATION_STATE#${record.status}`,
        GSI2SK: `READY#${record.readyAt}#${record.id}`,
      };
    case 'conversational_private_payload':
      return {
        ...record,
        PK: `PRIVATE_PAYLOAD#${record.id}`,
        SK: 'META',
        GSI1PK: `CONVERSATION#${record.conversationId}`,
        GSI1SK: `PRIVATE_PAYLOAD#${record.id}`,
      };
    case 'skill_load_receipt':
      return related(record, `CONVERSATION#${record.conversationId}`, `SKILL_LOAD#${record.loadNonceHash}`, `SKILL_LOAD#${record.createdAt}#${record.id}`);
    case 'context_receipt':
      return related(record, `CONVERSATION#${record.conversationId}`, `CONTEXT#${record.id}`, `CONTEXT#${record.createdAt}#${record.id}`);
  }
}

function related(record: ConversationalRecord, PK: string, SK: string, GSI1SK: string): Record<string, unknown> {
  const conversationId = (record as { conversationId: string }).conversationId;
  return { ...record, PK, SK, GSI1PK: `CONVERSATION#${conversationId}`, GSI1SK };
}

function clean<T>(item: Record<string, unknown> | undefined): T | null {
  if (!item) return null;
  const {
    PK: _pk, SK: _sk, GSI1PK: _gsi1pk, GSI1SK: _gsi1sk,
    GSI2PK: _gsi2pk, GSI2SK: _gsi2sk, conversationRelationshipPK: _relationship,
    ...record
  } = item;
  return record as T;
}

function conditionalFailure(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'ConditionalCheckFailedException'
    || error.name === 'TransactionCanceledException'
  );
}

async function putAbsent(client: DynamoDBDocumentClient, record: ConversationalRecord): Promise<void> {
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(record),
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
}

function relationshipLink(
  conversationId: string,
  id: string,
  target: Record<string, unknown>,
  expiresAt?: string,
  ttl?: number
): Record<string, unknown> {
  return {
    PK: `CONVERSATION#${conversationId}`,
    SK: `RELATIONSHIP#${target.recordType}#${id}`,
    GSI1PK: `CONVERSATION#${conversationId}`,
    GSI1SK: `RELATIONSHIP#${target.recordType}#${id}`,
    recordType: 'conversation_relationship_link',
    conversationId,
    targetPK: target.PK,
    targetSK: target.SK,
    expiresAt,
    ttl,
  };
}

async function putTargetAndLinkForLocalTest(
  client: DynamoDBDocumentClient,
  target: Record<string, unknown>,
  link: Record<string, unknown>
): Promise<void> {
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: target,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
  try {
    await client.send(new PutCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Item: link,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (error) {
    await client.send(new DeleteCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: target.PK, SK: target.SK },
    }));
    throw error;
  }
}

function namedError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

async function queryPage<T>(
  client: DynamoDBDocumentClient,
  query: Omit<ConstructorParameters<typeof QueryCommand>[0], 'TableName' | 'ExclusiveStartKey' | 'Limit'>,
  cursor?: Key,
  limit = 50
): Promise<Page<T>> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    ...query,
    ExclusiveStartKey: cursor,
    Limit: Math.min(Math.max(limit, 1), 100),
  }));
  return {
    items: ((result.Items || []) as Record<string, unknown>[]).map((item) => clean<T>(item)!),
    ...(result.LastEvaluatedKey ? { cursor: result.LastEvaluatedKey as Key } : {}),
  };
}

async function updateState<T extends { status: string; revision: number }>(
  client: DynamoDBDocumentClient,
  Key: Key,
  expectedStatus: string,
  status: string,
  expectedRevision: number | undefined,
  updatedAt: string
): Promise<T> {
  const condition = expectedRevision === undefined
    ? '#status = :expectedStatus'
    : '#status = :expectedStatus AND revision = :expectedRevision';
  const result = await client.send(new UpdateCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key,
    UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, revision = revision + :one',
    ConditionExpression: condition,
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': status,
      ':expectedStatus': expectedStatus,
      ':updatedAt': updatedAt,
      ':one': 1,
      ...(expectedRevision === undefined ? {} : { ':expectedRevision': expectedRevision }),
    },
    ReturnValues: 'ALL_NEW',
  }));
  return clean<T>(result.Attributes as Record<string, unknown>)!;
}

export type { Key, Page };
export {
  clean,
  conditionalFailure,
  namedError,
  putAbsent,
  putTargetAndLinkForLocalTest,
  queryPage,
  relationshipLink,
  storageItem,
  updateState,
  versionSk,
};
