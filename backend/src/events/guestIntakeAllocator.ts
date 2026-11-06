import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_ARTIFACTS } from '../db/tableNames';
const allocatorKey = { PK: 'GUESTINTAKEALLOCATOR', SK: 'GUESTINTAKEALLOCATOR' };
/** Shared allocator lease covers availability read through durable Calendar proposal. Lambda timeout is 120s, lease 150s. */
export async function claimGuestSlotAllocator(db: DynamoDBDocumentClient, id: string): Promise<boolean> {
  try {
    await db.send(new UpdateCommand({ TableName: TABLE_ARTIFACTS, Key: allocatorKey,
      UpdateExpression: 'SET leaseUntil = :lease, ownerId = :id', ConditionExpression: 'attribute_not_exists(leaseUntil) OR leaseUntil < :now',
      ExpressionAttributeValues: { ':lease': Date.now() + 150000, ':now': Date.now(), ':id': id } }));
    return true;
  } catch (error) { if ((error as Error).name === 'ConditionalCheckFailedException') return false; throw error; }
}
export async function releaseAllocator(db: DynamoDBDocumentClient, id: string) {
  await db.send(new UpdateCommand({ TableName: TABLE_ARTIFACTS, Key: allocatorKey, UpdateExpression: 'SET leaseUntil = :zero', ConditionExpression: 'ownerId = :id', ExpressionAttributeValues: { ':zero': 0, ':id': id } }));
}
