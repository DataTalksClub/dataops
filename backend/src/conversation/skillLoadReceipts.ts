import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_CONVERSATIONAL_STATE } from '../db/tableNames';
import {
  validateConversationalRecord,
  type SkillLoadReceipt,
  type StoredContextReceipt,
} from './types';
import { clean, conditionalFailure, putAbsent } from './conversationStorage';

async function createSkillLoadReceipt(
  client: DynamoDBDocumentClient,
  receipt: SkillLoadReceipt
): Promise<void> {
  await putAbsent(client, receipt);
}

async function getSkillLoadReceipt(
  client: DynamoDBDocumentClient,
  conversationId: string,
  loadNonceHash: string
): Promise<SkillLoadReceipt | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${conversationId}`, SK: `SKILL_LOAD#${loadNonceHash}` },
  }));
  return clean<SkillLoadReceipt>(result.Item as Record<string, unknown> | undefined);
}

async function consumeSkillLoadReceipt(
  client: DynamoDBDocumentClient,
  conversationId: string,
  loadNonceHash: string,
  expectedRevision: number,
  consumedAt: string
): Promise<{ claimed: boolean; result?: unknown }> {
  const Key = { PK: `CONVERSATION#${conversationId}`, SK: `SKILL_LOAD#${loadNonceHash}` };
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: { PK: `CONVERSATION#${conversationId}`, SK: 'META' },
            ConditionExpression: 'revision = :revision AND #status <> :deleted AND expiresAt > :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':revision': expectedRevision,
              ':deleted': 'deleted',
              ':now': consumedAt,
            },
          },
        },
        {
          Update: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key,
            UpdateExpression: 'SET #status = :consumed, updatedAt = :now',
            ConditionExpression: '#status = :active AND conversationRevision = :revision AND expiresAt > :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':consumed': 'consumed',
              ':active': 'active',
              ':revision': expectedRevision,
              ':now': consumedAt,
            },
          },
        },
      ],
    }));
    return { claimed: true };
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    const existing = await getSkillLoadReceipt(client, conversationId, loadNonceHash);
    if (
      existing?.status === 'consumed'
      && existing.conversationRevision === expectedRevision
      && existing.consumedResult !== undefined
    ) return { claimed: false, result: existing.consumedResult };
    return { claimed: false };
  }
}

async function storeSkillLoadResult(
  client: DynamoDBDocumentClient,
  conversationId: string,
  loadNonceHash: string,
  result: unknown,
  updatedAt: string
): Promise<void> {
  const receipt = await getSkillLoadReceipt(client, conversationId, loadNonceHash);
  if (!receipt) throw new Error('skill load receipt is unavailable');
  const updated: SkillLoadReceipt = {
    ...receipt,
    consumedResult: result as SkillLoadReceipt['consumedResult'],
    updatedAt,
  };
  validateConversationalRecord(updated);
  await client.send(new UpdateCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${conversationId}`, SK: `SKILL_LOAD#${loadNonceHash}` },
    UpdateExpression: 'SET consumedResult = :result, updatedAt = :now',
    ConditionExpression: '#status = :consumed AND attribute_not_exists(consumedResult)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':result': result, ':now': updatedAt, ':consumed': 'consumed' },
  }));
}

async function saveContextReceipt(
  client: DynamoDBDocumentClient,
  receipt: StoredContextReceipt
): Promise<void> {
  await putAbsent(client, receipt);
}

export {
  consumeSkillLoadReceipt,
  createSkillLoadReceipt,
  getSkillLoadReceipt,
  saveContextReceipt,
  storeSkillLoadResult,
};
