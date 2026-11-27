import { transactWrite } from '../db/transactWrite';
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_ARTIFACTS } from '../db/tableNames';
import { eachDayOfInterval, formatBerlinDate } from '../calendar/ownerCalendarOverlay';
const allocatorKey = (date: string) => ({ PK: `GUESTINTAKEALLOCATOR#${date}`, SK: `GUESTINTAKEALLOCATOR#${date}` });
export const allocationDates = (startIso: string, endIso: string) => eachDayOfInterval(formatBerlinDate(startIso), formatBerlinDate(endIso));
/** Serialize only overlapping dates. An unrelated failed Card never owns the entire calendar. */
export async function claimGuestSlotAllocator(db: DynamoDBDocumentClient, id: string, dates: string[]): Promise<boolean> {
  const unique = [...new Set(dates)].sort();
  if (!unique.length || unique.length > 3 || unique.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new Error('A reservation lease needs one to three Berlin dates');
  const now = Date.now();
  try {
    await transactWrite(db, unique.map(date => ({ Update: {
      TableName: TABLE_ARTIFACTS, Key: allocatorKey(date),
      UpdateExpression: 'SET leaseUntil = :lease, ownerId = :id', ConditionExpression: 'attribute_not_exists(leaseUntil) OR leaseUntil < :now',
      ExpressionAttributeValues: { ':lease': now + 150000, ':now': now, ':id': id },
    } })));
    return true;
  } catch (error) {
    const e = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
    if (e.name === 'ConditionalCheckFailedException' || e.name === 'TransactionCanceledException' && e.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')) return false;
    throw error;
  }
}
export async function releaseAllocator(db: DynamoDBDocumentClient, id: string, dates: string[]) {
  for (const date of new Set(dates)) {
    try {
      await db.send(new UpdateCommand({ TableName: TABLE_ARTIFACTS, Key: allocatorKey(date), UpdateExpression: 'SET leaseUntil = :zero', ConditionExpression: 'ownerId = :id', ExpressionAttributeValues: { ':zero': 0, ':id': id } }));
    } catch (error) { if ((error as Error).name !== 'ConditionalCheckFailedException') throw error; }
  }
}
