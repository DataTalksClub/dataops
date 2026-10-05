import { QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_SPONSOR_CRM } from '../db/tableNames';
import { payloadDeleteAt } from './core';
import { clean, itemKey, nowIso } from './repository';
import type { CommunicationDraftVersion, CommunicationPresentation } from './types';

export async function reconcileAbandonedSponsorPayloads(
  client: DynamoDBDocumentClient,
  now = nowIso(),
  limit = 10,
): Promise<{ drafts: number; presentations: number }> {
  const bounded = Math.min(Math.max(limit, 1), 25);
  const [drafts, presentations] = await Promise.all([
    client.send(new QueryCommand({
      TableName: TABLE_SPONSOR_CRM,
      IndexName: 'GSI-SponsorSendDue',
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK <= :now',
      ExpressionAttributeValues: { ':pk': 'SPONSOR_DRAFT_ABANDONMENT', ':now': `${now}#\uffff` },
      Limit: bounded,
    })),
    client.send(new QueryCommand({
      TableName: TABLE_SPONSOR_CRM,
      IndexName: 'GSI-SponsorSendDue',
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK <= :now',
      ExpressionAttributeValues: { ':pk': 'SPONSOR_PRESENTATION_EXPIRY', ':now': `${now}#\uffff` },
      Limit: bounded,
    })),
  ]);
  let anchoredDrafts = 0;
  let anchoredPresentations = 0;
  for (const raw of drafts.Items || []) {
    const draft = clean<CommunicationDraftVersion>(raw as Record<string, unknown>);
    const dueKey = raw.GSI2SK;
    if (!draft || typeof dueKey !== 'string') continue;
    try {
      await client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_SPONSOR_CRM,
              Key: itemKey('COMMUNICATION_DRAFT', `${draft.communicationId}#${draft.version}`),
              UpdateExpression: 'SET abandonedAt = :now, revision = if_not_exists(revision, :zero) + :one REMOVE GSI2PK, GSI2SK',
              ConditionExpression: 'attribute_not_exists(claimedAttemptId) AND attribute_not_exists(abandonedAt) AND GSI2SK = :due',
              ExpressionAttributeValues: { ':now': now, ':zero': 0, ':one': 1, ':due': dueKey },
            },
          },
          {
            Update: {
              TableName: TABLE_SPONSOR_CRM,
              Key: itemKey('COMMUNICATION_PAYLOAD', draft.payloadRef),
              UpdateExpression: 'SET retentionAnchoredAt = if_not_exists(retentionAnchoredAt, :now), #ttl = if_not_exists(#ttl, :ttl)',
              ExpressionAttributeNames: { '#ttl': 'ttl' },
              ExpressionAttributeValues: { ':now': now, ':ttl': payloadDeleteAt(now) },
            },
          },
          {
            Put: {
              TableName: TABLE_SPONSOR_CRM,
              Item: {
                ...itemKey('SPONSOR_COMM_AUDIT', `draft-abandoned#${draft.id}`),
                recordType: 'sponsor-communication-audit',
                action: 'draft-abandoned',
                communicationId: draft.communicationId,
                bookingId: draft.bookingId,
                draftVersion: draft.version,
                at: now,
                ttl: Math.floor(Date.parse(now) / 1000) + 365 * 24 * 60 * 60,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }));
      anchoredDrafts++;
    } catch (error) {
      if (!(error as Error).name.includes('Transaction') && !(error as Error).name.includes('Conditional')) throw error;
    }
  }
  for (const raw of presentations.Items || []) {
    const presentation = clean<CommunicationPresentation>(raw as Record<string, unknown>);
    const dueKey = raw.GSI2SK;
    if (!presentation || typeof dueKey !== 'string') continue;
    try {
      await client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_SPONSOR_CRM,
              Key: itemKey('COMMUNICATION_PRESENTATION', presentation.id),
              UpdateExpression: 'SET #state = :expired, expiredAt = :now, revision = revision + :one REMOVE tokenHash, GSI2PK, GSI2SK',
              ConditionExpression: '#state = :active AND expiresAt <= :now AND GSI2SK = :due',
              ExpressionAttributeNames: { '#state': 'state' },
              ExpressionAttributeValues: { ':expired': 'expired', ':active': 'active', ':now': now, ':one': 1, ':due': dueKey },
            },
          },
          {
            Update: {
              TableName: TABLE_SPONSOR_CRM,
              Key: itemKey('COMMUNICATION_PAYLOAD', presentation.payloadRef),
              UpdateExpression: 'SET retentionAnchoredAt = if_not_exists(retentionAnchoredAt, :now), #ttl = if_not_exists(#ttl, :ttl)',
              ExpressionAttributeNames: { '#ttl': 'ttl' },
              ExpressionAttributeValues: { ':now': now, ':ttl': payloadDeleteAt(now) },
            },
          },
          {
            Put: {
              TableName: TABLE_SPONSOR_CRM,
              Item: {
                ...itemKey('SPONSOR_COMM_AUDIT', `presentation-expired#${presentation.id}`),
                recordType: 'sponsor-communication-audit',
                action: 'presentation-expired',
                communicationId: presentation.communicationId,
                bookingId: presentation.bookingId,
                presentationId: presentation.id,
                at: now,
                ttl: Math.floor(Date.parse(now) / 1000) + 365 * 24 * 60 * 60,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }));
      anchoredPresentations++;
    } catch (error) {
      if (!(error as Error).name.includes('Transaction') && !(error as Error).name.includes('Conditional')) throw error;
    }
  }
  return { drafts: anchoredDrafts, presentations: anchoredPresentations };
}
