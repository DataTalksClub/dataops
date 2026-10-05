import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_CONVERSATIONAL_STATE } from '../db/tableNames';
import {
  isExpired,
  validateConversationalRecord,
  type ConversationalPrivatePayload,
} from './types';
import { clean, putAbsent, storageItem } from './conversationStorage';
import { requireConversation, requireOwner } from './conversations';

interface StagedMediaControlLink {
  payloadId: string;
  expectedPayloadRevision: number;
  actionIds: string[];
}

async function putConversationalPrivatePayload(
  client: DynamoDBDocumentClient,
  payload: ConversationalPrivatePayload
): Promise<void> {
  validateConversationalRecord(payload);
  await requireConversation(client, payload.conversationId);
  await putAbsent(client, payload);
}

async function getConversationalPrivatePayload(
  client: DynamoDBDocumentClient,
  conversationId: string,
  payloadId: string,
  ownerUserId: string,
  now = new Date()
): Promise<ConversationalPrivatePayload | null> {
  await requireOwner(client, conversationId, ownerUserId, now);
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `PRIVATE_PAYLOAD#${payloadId}`, SK: 'META' },
  }));
  const payload = clean<ConversationalPrivatePayload>(result.Item as Record<string, unknown> | undefined);
  return !payload || payload.conversationId !== conversationId || isExpired(payload, now) ? null : payload;
}

async function replaceConversationalPrivatePayload(
  client: DynamoDBDocumentClient,
  payload: ConversationalPrivatePayload
): Promise<void> {
  validateConversationalRecord(payload);
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(payload),
    ConditionExpression: 'attribute_exists(PK) AND conversationId = :conversationId',
    ExpressionAttributeValues: { ':conversationId': payload.conversationId },
  }));
}

async function replaceConversationalPrivatePayloadConditionally(
  client: DynamoDBDocumentClient,
  payload: ConversationalPrivatePayload,
  expectedStatus: string,
  expectedRevision: number
): Promise<void> {
  validateConversationalRecord(payload);
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(payload),
    ConditionExpression: 'attribute_exists(PK) AND conversationId = :conversationId AND #content.#status = :status AND #content.revision = :revision',
    ExpressionAttributeNames: { '#content': 'content', '#status': 'status' },
    ExpressionAttributeValues: {
      ':conversationId': payload.conversationId,
      ':status': expectedStatus,
      ':revision': expectedRevision,
    },
  }));
}

export type { StagedMediaControlLink };
export {
  getConversationalPrivatePayload,
  putConversationalPrivatePayload,
  replaceConversationalPrivatePayload,
  replaceConversationalPrivatePayloadConditionally,
};
