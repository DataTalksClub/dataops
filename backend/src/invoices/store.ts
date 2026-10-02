import { GetCommand, PutCommand, ScanCommand, UpdateCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_BOOKKEEPING } from '../db/tableNames';
import type { Invoice } from './model';
export const invoiceKey = (id: string) => ({ PK: `INVOICE#${id}`, SK: `INVOICE#${id}` });
export async function getInvoice(client: DynamoDBDocumentClient, id: string): Promise<Invoice | null> {
  const { Item } = await client.send(new GetCommand({ TableName: TABLE_BOOKKEEPING, Key: invoiceKey(id), ConsistentRead: true }));
  if (!Item) return null;
  const { PK: _pk, SK: _sk, ...record } = Item;
  return record as Invoice;
}
export async function listInvoices(client: DynamoDBDocumentClient): Promise<Invoice[]> {
  const items: Invoice[] = []; let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({ TableName: TABLE_BOOKKEEPING, FilterExpression: 'begins_with(PK, :prefix)', ExpressionAttributeValues: { ':prefix': 'INVOICE#' }, ExclusiveStartKey: cursor, ConsistentRead: true }));
    for (const { PK: _pk, SK: _sk, ...item } of result.Items || []) items.push(item as Invoice);
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return items.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function createInvoice(client: DynamoDBDocumentClient, record: Invoice): Promise<Invoice> {
  try { await client.send(new PutCommand({ TableName: TABLE_BOOKKEEPING, Item: { ...invoiceKey(record.id), ...record }, ConditionExpression: 'attribute_not_exists(PK)' })); return record; }
  catch(error) { if ((error as Error).name !== 'ConditionalCheckFailedException') throw error; return (await getInvoice(client,record.id))!; }
}
export async function saveInvoice(client: DynamoDBDocumentClient, record: Invoice, expected: Invoice, owner?: string): Promise<Invoice> {
  record.updatedAt = new Date().toISOString();
  await client.send(new PutCommand({ TableName: TABLE_BOOKKEEPING, Item: { ...invoiceKey(record.id), ...record }, ConditionExpression: '#revision = :revision AND updatedAt = :updated AND ' + (owner ? 'leaseOwner = :owner' : 'attribute_not_exists(leaseOwner)'), ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': expected.revision, ':updated': expected.updatedAt, ...(owner ? { ':owner': owner } : {}) } }));
  return record;
}
export async function claimInvoice(client: DynamoDBDocumentClient, record: Invoice, owner: string): Promise<Invoice> {
  const result = await client.send(new UpdateCommand({ TableName: TABLE_BOOKKEEPING, Key: invoiceKey(record.id), UpdateExpression: 'SET leaseOwner = :owner, leaseUntil = :until', ConditionExpression: '#status = :confirmed AND #revision = :revision AND (attribute_not_exists(leaseOwner) OR leaseUntil < :now)', ExpressionAttributeNames: { '#status': 'status', '#revision': 'revision' }, ExpressionAttributeValues: { ':owner': owner, ':until': Date.now()+240000, ':confirmed':'confirmed', ':revision':record.revision, ':now':Date.now() }, ReturnValues:'ALL_NEW' }));
  const { PK: _pk, SK: _sk, ...item } = result.Attributes!;
  return item as Invoice;
}
export async function reserveSheetRow(client: DynamoDBDocumentClient, destinationKey: string, firstFree: number): Promise<number> {
  const Key = { PK: `INVOICE_CURSOR#${destinationKey}`, SK: `INVOICE_CURSOR#${destinationKey}` };
  await client.send(new UpdateCommand({ TableName: TABLE_BOOKKEEPING, Key, UpdateExpression:'SET nextRow = :base', ConditionExpression:'attribute_not_exists(nextRow) OR nextRow < :base', ExpressionAttributeValues:{':base':firstFree-1} })).catch(error => { if ((error as Error).name !== 'ConditionalCheckFailedException') throw error; });
  const result = await client.send(new UpdateCommand({ TableName: TABLE_BOOKKEEPING, Key, UpdateExpression:'ADD nextRow :one', ExpressionAttributeValues:{':one':1}, ReturnValues:'UPDATED_NEW' }));
  return Number(result.Attributes!.nextRow);
}

export async function approveInvoice(client: DynamoDBDocumentClient, record: Invoice, expected: Invoice, identity: string): Promise<Invoice> {
  record.updatedAt = new Date().toISOString();
  const claim = { PK: `INVOICE_IDENTITY#${identity}`, SK: `INVOICE_IDENTITY#${identity}` };
  await client.send(new TransactWriteCommand({ TransactItems: [
    { Put: { TableName: TABLE_BOOKKEEPING, Item: { ...invoiceKey(record.id), ...record }, ConditionExpression: '#revision = :revision AND updatedAt = :updated AND #status = :pending AND attribute_not_exists(leaseOwner)', ExpressionAttributeNames: { '#revision':'revision', '#status':'status' }, ExpressionAttributeValues: { ':revision':expected.revision, ':updated':expected.updatedAt, ':pending':'pending' } } },
    { Put: { TableName: TABLE_BOOKKEEPING, Item: { ...claim, invoiceId:record.id, checksum:record.source.checksum }, ConditionExpression:'attribute_not_exists(PK)' } },
  ] }));
  return record;
}
