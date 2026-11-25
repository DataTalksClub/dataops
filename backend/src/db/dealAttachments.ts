import crypto from 'crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { cleanItem as cleanDbItem } from './cleanItem';
import { TABLE_SPONSOR_CRM } from './tableNames';

export interface DealAttachmentRecord {
  id: string;
  dealId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
  storageProvider: 's3' | 'local-dev';
  storagePath: string;
  storageUri: string;
  uploadedBy: string;
  createdAt: string;
  note?: string;
}

export interface PublicDealAttachment {
  id: string;
  dealId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
  uploadedBy: string;
  createdAt: string;
  note?: string;
}

export type DealAttachmentAuditAction = 'uploaded' | 'downloaded' | 'deleted';

export interface DealAttachmentAuditRecord {
  id: string;
  dealId: string;
  attachmentId: string;
  action: DealAttachmentAuditAction;
  actorId: string;
  filename: string;
  sizeBytes: number;
  checksum: string;
  at: string;
}

const cleanAttachment = cleanDbItem<DealAttachmentRecord>;
const cleanAudit = cleanDbItem<DealAttachmentAuditRecord>;

const attachmentPk = (dealId: string) => `DEAL_ATTACHMENT#${dealId}`;
const attachmentSk = (id: string) => `ATTACHMENT#${id}`;
const auditPk = (dealId: string) => `DEAL_ATTACHMENT_AUDIT#${dealId}`;

/**
 * Public projection of a deal attachment: never leaks internal storage paths,
 * bucket names, or any public URL.
 */
export function publicDealAttachment(record: DealAttachmentRecord): PublicDealAttachment {
  return {
    id: record.id,
    dealId: record.dealId,
    filename: record.filename,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    checksum: record.checksum,
    uploadedBy: record.uploadedBy,
    createdAt: record.createdAt,
    ...(record.note ? { note: record.note } : {}),
  };
}

export async function createDealAttachment(
  client: DynamoDBDocumentClient,
  data: Omit<DealAttachmentRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
): Promise<DealAttachmentRecord> {
  const id = data.id || crypto.randomUUID();
  const createdAt = data.createdAt || new Date().toISOString();
  const item: Record<string, unknown> = {
    PK: attachmentPk(data.dealId),
    SK: attachmentSk(id),
    recordType: 'deal-attachment',
    id,
    dealId: data.dealId,
    filename: data.filename,
    contentType: data.contentType,
    sizeBytes: data.sizeBytes,
    checksum: data.checksum,
    storageProvider: data.storageProvider,
    storagePath: data.storagePath,
    storageUri: data.storageUri,
    uploadedBy: data.uploadedBy,
    createdAt,
    ...(data.note ? { note: data.note } : {}),
  };
  await client.send(new PutCommand({
    TableName: TABLE_SPONSOR_CRM,
    Item: item,
    ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
  }));
  return cleanAttachment(item) as DealAttachmentRecord;
}

export async function getDealAttachment(
  client: DynamoDBDocumentClient,
  dealId: string,
  attachmentId: string,
): Promise<DealAttachmentRecord | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_SPONSOR_CRM,
    Key: { PK: attachmentPk(dealId), SK: attachmentSk(attachmentId) },
  }));
  return result.Item ? (cleanAttachment(result.Item as Record<string, unknown>) as DealAttachmentRecord) : null;
}

export async function listDealAttachments(
  client: DynamoDBDocumentClient,
  dealId: string,
): Promise<DealAttachmentRecord[]> {
  const items: DealAttachmentRecord[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new QueryCommand({
      TableName: TABLE_SPONSOR_CRM,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': attachmentPk(dealId) },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const row of result.Items || []) {
      const cleaned = cleanAttachment(row as Record<string, unknown>);
      if (cleaned) items.push(cleaned);
    }
    cursor = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);
  items.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  return items;
}

export async function deleteDealAttachment(
  client: DynamoDBDocumentClient,
  dealId: string,
  attachmentId: string,
): Promise<void> {
  await client.send(new DeleteCommand({
    TableName: TABLE_SPONSOR_CRM,
    Key: { PK: attachmentPk(dealId), SK: attachmentSk(attachmentId) },
  }));
}

export async function recordDealAttachmentAudit(
  client: DynamoDBDocumentClient,
  entry: Omit<DealAttachmentAuditRecord, 'id' | 'at'> & { at?: string },
): Promise<DealAttachmentAuditRecord> {
  const id = crypto.randomUUID();
  const at = entry.at || new Date().toISOString();
  const item: Record<string, unknown> = {
    PK: auditPk(entry.dealId),
    SK: `${at}#${id}`,
    recordType: 'deal-attachment-audit',
    id,
    dealId: entry.dealId,
    attachmentId: entry.attachmentId,
    action: entry.action,
    actorId: entry.actorId,
    filename: entry.filename,
    sizeBytes: entry.sizeBytes,
    checksum: entry.checksum,
    at,
  };
  await client.send(new PutCommand({
    TableName: TABLE_SPONSOR_CRM,
    Item: item,
    ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
  }));
  return cleanAudit(item) as DealAttachmentAuditRecord;
}

export async function listDealAttachmentAudit(
  client: DynamoDBDocumentClient,
  dealId: string,
): Promise<DealAttachmentAuditRecord[]> {
  const items: DealAttachmentAuditRecord[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new QueryCommand({
      TableName: TABLE_SPONSOR_CRM,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': auditPk(dealId) },
      ScanIndexForward: false,
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const row of result.Items || []) {
      const cleaned = cleanAudit(row as Record<string, unknown>);
      if (cleaned) items.push(cleaned);
    }
    cursor = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);
  return items;
}
