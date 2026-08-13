import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_CONVERSATIONAL_STATE } from '../db/tableNames';

type HeartbeatComponent = 'execution_worker' | 'recovery' | 'result_dispatcher';

interface RolloutHeartbeat {
  component: HeartbeatComponent;
  updatedAt: string;
}

const HEARTBEAT_KEYS: Readonly<Record<HeartbeatComponent, Readonly<{ PK: string; SK: string }>>> =
  Object.freeze({
    execution_worker: Object.freeze({
      PK: 'ROLLOUT#HEARTBEAT',
      SK: 'COMPONENT#execution_worker',
    }),
    recovery: Object.freeze({
      PK: 'ROLLOUT#HEARTBEAT',
      SK: 'COMPONENT#recovery',
    }),
    result_dispatcher: Object.freeze({
      PK: 'ROLLOUT#HEARTBEAT',
      SK: 'COMPONENT#result_dispatcher',
    }),
  });

async function writeRolloutHeartbeat(
  client: DynamoDBDocumentClient,
  component: HeartbeatComponent,
  now = new Date()
): Promise<void> {
  const key = HEARTBEAT_KEYS[component];
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: {
      ...key,
      recordType: 'rollout_heartbeat',
      schemaVersion: 1,
      component,
      updatedAt: now.toISOString(),
    },
  }));
}

async function readRolloutHeartbeat(
  client: DynamoDBDocumentClient,
  component: HeartbeatComponent
): Promise<RolloutHeartbeat | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: HEARTBEAT_KEYS[component],
    ConsistentRead: true,
    ProjectionExpression: 'component, updatedAt',
  }));
  const componentValue = result.Item?.component;
  const updatedAt = result.Item?.updatedAt;
  if (componentValue !== component || typeof updatedAt !== 'string') return null;
  return { component, updatedAt };
}

async function oldestPendingResultAgeSeconds(
  client: DynamoDBDocumentClient,
  now = new Date()
): Promise<number | null> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :state',
    ExpressionAttributeValues: {
      ':state': 'RESULT_NOTIFICATION_STATE#pending',
    },
    ProjectionExpression: 'readyAt',
    ScanIndexForward: true,
    Limit: 1,
  }));
  const readyAt = result.Items?.[0]?.readyAt;
  if (typeof readyAt !== 'string') return null;
  const readyTime = Date.parse(readyAt);
  if (!Number.isFinite(readyTime)) return null;
  return Math.max(0, Math.floor((now.getTime() - readyTime) / 1_000));
}

async function oldestDueExecutionAgeSeconds(
  client: DynamoDBDocumentClient,
  now = new Date()
): Promise<number | null> {
  const ages = await Promise.all(['queued', 'executing'].map(async (status) => {
    const result = await client.send(new QueryCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :state',
      ExpressionAttributeValues: {
        ':state': `ATTEMPT_STATE#${status}`,
      },
      ProjectionExpression: 'readyAt',
      ScanIndexForward: true,
      Limit: 1,
    }));
    const readyAt = result.Items?.[0]?.readyAt;
    const readyTime = typeof readyAt === 'string' ? Date.parse(readyAt) : Number.NaN;
    return Number.isFinite(readyTime)
      ? Math.max(0, Math.floor((now.getTime() - readyTime) / 1_000))
      : null;
  }));
  const present = ages.filter((age): age is number => age !== null);
  return present.length ? Math.max(...present) : null;
}

export {
  HEARTBEAT_KEYS,
  oldestDueExecutionAgeSeconds,
  oldestPendingResultAgeSeconds,
  readRolloutHeartbeat,
  writeRolloutHeartbeat,
};
export type { HeartbeatComponent, RolloutHeartbeat };
