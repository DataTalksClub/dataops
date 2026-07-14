import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_ARTIFACTS } from './setup';
import type { MailingExportJob } from '../mailingExports/types';

const key = (id: string) => ({ PK: `MAILING_EXPORT#${id}`, SK: `MAILING_EXPORT#${id}` });

export async function getMailingExport(client: DynamoDBDocumentClient, id: string): Promise<MailingExportJob | null> {
  const result = await client.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: key(id) }));
  if (!result.Item) return null;
  const { PK, SK, ...job } = result.Item;
  return job as MailingExportJob;
}

export async function createMailingExport(
  client: DynamoDBDocumentClient,
  job: MailingExportJob,
): Promise<{ job: MailingExportJob; created: boolean }> {
  try {
    await client.send(new PutCommand({
      TableName: TABLE_ARTIFACTS,
      Item: { ...key(job.id), ...job },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return { job, created: true };
  } catch (error) {
    if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    const existing = await getMailingExport(client, job.id);
    if (!existing) throw error;
    return { job: existing, created: false };
  }
}

export async function acquireMailingExportLease(
  client: DynamoDBDocumentClient,
  id: string,
  owner: string,
  nowEpochMs: number,
  leaseMs = 120_000,
): Promise<MailingExportJob | null> {
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_ARTIFACTS,
      Key: key(id),
      UpdateExpression: 'SET leaseOwner = :owner, leaseExpiresAt = :expires',
      ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt < :now OR leaseOwner = :owner)',
      ExpressionAttributeValues: { ':owner': owner, ':expires': nowEpochMs + leaseMs, ':now': nowEpochMs },
      ReturnValues: 'ALL_NEW',
    }));
    if (!result.Attributes) return null;
    const { PK, SK, ...job } = result.Attributes;
    return job as MailingExportJob;
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

export async function putMailingExport(client: DynamoDBDocumentClient, job: MailingExportJob, owner?: string): Promise<void> {
  await client.send(new PutCommand({
    TableName: TABLE_ARTIFACTS,
    Item: { ...key(job.id), ...job },
    ...(owner ? { ConditionExpression: 'leaseOwner = :owner', ExpressionAttributeValues: { ':owner': owner } } : {}),
  }));
}

export async function listMailingExports(client: DynamoDBDocumentClient): Promise<MailingExportJob[]> {
  const result = await client.send(new ScanCommand({
    TableName: TABLE_ARTIFACTS,
    FilterExpression: 'begins_with(PK, :prefix)',
    ExpressionAttributeValues: { ':prefix': 'MAILING_EXPORT#' },
  }));
  return (result.Items || []).map(({ PK, SK, ...job }) => job as MailingExportJob)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}
