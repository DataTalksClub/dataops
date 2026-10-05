import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_CONVERSATIONAL_STATE } from '../db/tableNames';
import { isExpired, type ResultNotification } from './types';
import { clean } from './conversationStorage';

async function getResultNotification(
  client: DynamoDBDocumentClient,
  id: string,
  now = new Date()
): Promise<ResultNotification | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `RESULT_NOTIFICATION#${id}`, SK: 'META' },
    ConsistentRead: true,
  }));
  const notification = clean<ResultNotification>(result.Item as Record<string, unknown> | undefined);
  return !notification || isExpired(notification, now) ? null : notification;
}

async function listResultNotifications(
  client: DynamoDBDocumentClient,
  status: 'pending' | 'dispatching',
  through: string,
  limit = 50
): Promise<ResultNotification[]> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :state AND GSI2SK <= :through',
    ExpressionAttributeValues: {
      ':state': `RESULT_NOTIFICATION_STATE#${status}`,
      ':through': `READY#${through}#\uffff`,
    },
    Limit: Math.min(Math.max(limit, 1), 100),
  }));
  return ((result.Items || []) as Record<string, unknown>[])
    .map((item) => clean<ResultNotification>(item)!)
    .filter(Boolean);
}

async function claimResultNotification(
  client: DynamoDBDocumentClient,
  notification: ResultNotification,
  now: string,
  leaseExpiresAt: string
): Promise<ResultNotification | null> {
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `RESULT_NOTIFICATION#${notification.id}`, SK: 'META' },
      UpdateExpression: 'SET #status = :dispatching, leaseExpiresAt = :lease, updatedAt = :now, revision = revision + :one, GSI2PK = :state, GSI2SK = :sort',
      ConditionExpression: '#status = :pending AND revision = :revision AND readyAt <= :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':pending': 'pending', ':dispatching': 'dispatching',
        ':revision': notification.revision, ':lease': leaseExpiresAt,
        ':now': now, ':one': 1, ':state': 'RESULT_NOTIFICATION_STATE#dispatching',
        ':sort': `READY#${leaseExpiresAt}#${notification.id}`,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ResultNotification>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function finishResultNotification(
  client: DynamoDBDocumentClient,
  notification: ResultNotification,
  status: 'delivered' | 'outcome_unknown',
  now: string
): Promise<ResultNotification | null> {
  try {
    const deliveredSet = status === 'delivered' ? ', deliveredAt = :now' : '';
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `RESULT_NOTIFICATION#${notification.id}`, SK: 'META' },
      UpdateExpression: `SET #status = :status, updatedAt = :now${deliveredSet}, revision = revision + :one, GSI2PK = :state, GSI2SK = :sort REMOVE leaseExpiresAt`,
      ConditionExpression: '#status = :dispatching AND revision = :revision AND leaseExpiresAt > :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':dispatching': 'dispatching', ':status': status,
        ':revision': notification.revision, ':now': now, ':one': 1,
        ':state': `RESULT_NOTIFICATION_STATE#${status}`,
        ':sort': `READY#${now}#${notification.id}`,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ResultNotification>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function expireDispatchingResultNotification(
  client: DynamoDBDocumentClient,
  notification: ResultNotification,
  now: string
): Promise<ResultNotification | null> {
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `RESULT_NOTIFICATION#${notification.id}`, SK: 'META' },
      UpdateExpression: 'SET #status = :unknown, updatedAt = :now, revision = revision + :one, GSI2PK = :state, GSI2SK = :sort REMOVE leaseExpiresAt',
      ConditionExpression: '#status = :dispatching AND revision = :revision AND leaseExpiresAt <= :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':dispatching': 'dispatching', ':unknown': 'outcome_unknown',
        ':revision': notification.revision, ':now': now, ':one': 1,
        ':state': 'RESULT_NOTIFICATION_STATE#outcome_unknown',
        ':sort': `READY#${now}#${notification.id}`,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ResultNotification>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

export {
  claimResultNotification,
  expireDispatchingResultNotification,
  finishResultNotification,
  getResultNotification,
  listResultNotifications,
};
