import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_BOOKKEEPING } from '../db/tableNames';
import type { ScheduleEntry } from './upcoming';

// The tax and insurance debit schedule: one TAX_SCHEDULE#<id> item per
// recurring prepayment or one-off assessment, replaced when a new Bescheid or
// USt-VA arrives. Versioned so two editors cannot silently overwrite.
const key = (id: string) => ({ PK: `TAX_SCHEDULE#${id}`, SK: `TAX_SCHEDULE#${id}` });

export class ScheduleVersionConflict extends Error {
  constructor() { super('Schedule entry changed since it was read'); this.name = 'ScheduleVersionConflict'; }
}

export async function listTaxSchedule(client: DynamoDBDocumentClient): Promise<ScheduleEntry[]> {
  const out: ScheduleEntry[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_BOOKKEEPING,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'TAX_SCHEDULE#' },
      ExclusiveStartKey,
    }));
    for (const { PK: _pk, SK: _sk, ...item } of result.Items || []) out.push(item as ScheduleEntry);
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Create or replace one entry. expectedVersion 0 (or absent on a new entry)
 * creates; otherwise the stored version must match.
 */
export async function putTaxScheduleEntry(client: DynamoDBDocumentClient, entry: ScheduleEntry, expectedVersion?: number, actor = 'unknown'): Promise<ScheduleEntry> {
  const version = (expectedVersion || 0) + 1;
  const item = { ...entry, version, updatedAt: new Date().toISOString(), updatedBy: actor };
  try {
    await client.send(new PutCommand({
      TableName: TABLE_BOOKKEEPING,
      Item: { ...key(entry.id), ...item },
      ConditionExpression: expectedVersion ? '#v = :v' : 'attribute_not_exists(PK)',
      ...(expectedVersion ? { ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': expectedVersion } } : {}),
    }));
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') throw new ScheduleVersionConflict();
    throw error;
  }
  return item;
}
