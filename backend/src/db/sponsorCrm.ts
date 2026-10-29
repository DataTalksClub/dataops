import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'crypto';
import { DeleteCommand, GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_SPONSOR_CRM } from './tableNames';
import { usesLocalTransactionEmulation } from './client';
import {
  collectBoundedPages,
  type StoragePaginationLimits,
} from './boundedPagination';

export type CrmRecord = Record<string, unknown> & { id: string; version: number; createdAt: string; updatedAt: string };
const key = (kind: string, id: string) => `${kind.toUpperCase()}#${id}`;
const compact = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
const clean = (item?: Record<string, unknown>): CrmRecord | null => {
  if (!item) return null;
  const { PK, SK, ...record } = item;
  return record as CrmRecord;
};
// DynamoDB does not preserve map key order, so a record read back can list a
// nested object's keys differently from the value that was written. Replay
// checks compare a canonical form with object keys sorted.
const canonical = (value: unknown) => JSON.stringify(value, (_name, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]]))
    : item);
const sameStored = (existing: Record<string, unknown>, value: Record<string, unknown>) =>
  Object.keys(value).every(name => canonical(existing[name]) === canonical(value[name]));
const replayConflict = () => Object.assign(new Error('Idempotency key already used with different data'), { statusCode: 409 });
export const deterministicCrmId = (kind: string, sourceKey: string) => createHash('sha256').update(`${kind}:${sourceKey}`).digest('hex');
const stored = (kind: string, record: Record<string, unknown>) => ({ PK: key(kind, String(record.id)), SK: key(kind, String(record.id)), ...compact(record) });
const historyPut = (bookingId: string, event: Record<string, unknown>) => { const createdAt=new Date().toISOString(),id=`${createdAt}#${randomUUID()}`;return { Put:{TableName:TABLE_SPONSOR_CRM,Item:compact({PK:key('history',bookingId),SK:id,...event,id,bookingId,createdAt}),ConditionExpression:'attribute_not_exists(PK) AND attribute_not_exists(SK)'} }; };
async function transact(client:DynamoDBDocumentClient,items:any[]){
  if(process.env.NODE_ENV!=='test'||!usesLocalTransactionEmulation()) return client.send(new TransactWriteCommand({TransactItems:items,ClientRequestToken:randomUUID()}));
  // Dynalite used by this repository lacks TransactWriteItems. Production always
  // uses the command above; tests preserve conditional-write semantics locally.
  const before=[] as Array<{key:any;item?:Record<string,unknown>}>;
  for(const operation of items){const input=operation.Put||operation.Delete||operation.Update,keyValue=input.Key||{PK:input.Item.PK,SK:input.Item.SK};before.push({key:keyValue,item:(await client.send(new GetCommand({TableName:TABLE_SPONSOR_CRM,Key:keyValue}))).Item as Record<string,unknown>|undefined});}
  let applied=0;
  try{for(const item of items){if(item.Put)await client.send(new PutCommand(item.Put));else if(item.Delete)await client.send(new DeleteCommand(item.Delete));else if(item.Update)await client.send(new UpdateCommand(item.Update));applied++;if(Number(process.env.SPONSOR_CRM_TEST_FAIL_AFTER||0)===applied)throw new Error('Injected sponsor CRM transaction failure');}}
  catch(error){for(const snapshot of before.slice(0,applied).reverse()){if(snapshot.item)await client.send(new PutCommand({TableName:TABLE_SPONSOR_CRM,Item:snapshot.item}));else await client.send(new DeleteCommand({TableName:TABLE_SPONSOR_CRM,Key:snapshot.key}));}throw error;}
}

type CrmDependency = { kind: string; id: string };
function dependencies(kind: string, value: Record<string, unknown>): CrmDependency[] {
  const refs: CrmDependency[] = [];
  if (['contact', 'deal', 'deliverable', 'message'].includes(kind) && value.organizationId) {
    refs.push({ kind: 'organization', id: String(value.organizationId) });
  }
  if (['deal', 'deliverable', 'message'].includes(kind)) {
    for (const id of [value.primaryContactId, value.contactId, ...(Array.isArray(value.contactIds) ? value.contactIds : [])]) {
      if (id) refs.push({ kind: 'contact', id: String(id) });
    }
  }
  return refs;
}
function addedDependencies(kind: string, before: Record<string, unknown>, after: Record<string, unknown>) {
  const previous = new Set(dependencies(kind, before).map(ref => key(ref.kind, ref.id)));
  return dependencies(kind, after).filter(ref => !previous.has(key(ref.kind, ref.id)));
}

/** A dependency and its parent's version change commit together. Deletion
 * captures that version before its guard scan, so either the dependency wins
 * and invalidates deletion, or deletion wins and this existence check fails. */
export async function transactCrmDependencies(client: DynamoDBDocumentClient, items: any[], refs: CrmDependency[]) {
  const unique = new Map(refs.map(ref => [key(ref.kind, ref.id), ref]));
  const bumps = [...unique.keys()].map(pk => ({ Update: {
    TableName: TABLE_SPONSOR_CRM, Key: { PK: pk, SK: pk },
    UpdateExpression: 'ADD #version :one', ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':one': 1 },
  } }));
  if (items.length + bumps.length > 100) throw Object.assign(new Error('Too many CRM dependencies for one transaction'), { statusCode: 409 });
  try {
    return await transact(client, [...items, ...bumps]);
  } catch (error) {
    if (['ConditionalCheckFailedException', 'TransactionCanceledException'].includes((error as Error).name)) {
      Object.assign(error as Error, { statusCode: 409 });
    }
    throw error;
  }
}

export async function getCrmRecord(client: DynamoDBDocumentClient, kind: string, id: string) {
  const k = key(kind, id);
  return clean((await client.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: { PK: k, SK: k }, ConsistentRead: true }))).Item as Record<string, unknown>);
}

// Every list read of this table is a full Scan (the key is KIND#id, so a kind
// has no partition of its own). One page load fans out into several list
// routes, and each used to scan once per kind it needed, so a burst of
// parallel loads multiplied into dozens of consistent full-table scans on one
// partition and DynamoDB throttled them. A read-only request now scans the
// table once and serves each kind from that snapshot.
const SNAPSHOT_PREFIXES = [
  'ORGANIZATION#', 'CONTACT#', 'DEAL#', 'DELIVERABLE#', 'LEAD#', 'NEWSLETTER#',
  'NEWSLETTER-ISSUE#', 'SPONSOR_FINANCE',
] as const;

type CrmReadSnapshot = { items?: Promise<Record<string, unknown>[]> };
const readSnapshot = new AsyncLocalStorage<CrmReadSnapshot>();

/**
 * Serve sponsor CRM list reads inside `operation` from one table scan. Only
 * for requests that do not write: a write inside the scope would not be seen
 * by later list reads in the same request.
 */
export function withCrmReadSnapshot<T>(operation: () => Promise<T>): Promise<T> {
  return readSnapshot.run({}, operation);
}

function scanCrmTable(client: DynamoDBDocumentClient, prefixes: readonly string[], limits?: StoragePaginationLimits) {
  const values = Object.fromEntries(prefixes.map((prefix, index) => [`:p${index}`, prefix]));
  return collectBoundedPages<Record<string, unknown>>({
    limits,
    loadPage: async (ExclusiveStartKey, abortSignal) => client.send(
      new ScanCommand({
        TableName: TABLE_SPONSOR_CRM,
        ConsistentRead: true,
        FilterExpression: Object.keys(values).map((name) => `begins_with(PK, ${name})`).join(' OR '),
        ExpressionAttributeValues: values,
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
      { abortSignal },
    ),
  });
}

/** Raw items whose PK starts with `prefix`. */
export async function scanCrmPrefix(
  client: DynamoDBDocumentClient,
  prefix: string,
  limits?: StoragePaginationLimits,
): Promise<Record<string, unknown>[]> {
  const snapshot = readSnapshot.getStore();
  if (!snapshot || limits || !SNAPSHOT_PREFIXES.some((covered) => prefix.startsWith(covered))) {
    return scanCrmTable(client, [prefix], limits);
  }
  snapshot.items ??= scanCrmTable(client, SNAPSHOT_PREFIXES);
  return (await snapshot.items).filter((item) => String(item.PK).startsWith(prefix));
}

export async function listCrmRecords(
  client: DynamoDBDocumentClient,
  kind: string,
  limits?: StoragePaginationLimits,
) {
  const items = await scanCrmPrefix(client, `${kind.toUpperCase()}#`, limits);
  return items.map(item => clean(item)!).sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)) ||
    a.id.localeCompare(b.id));
}

function messageTargetWrites(message: Record<string, unknown>) {
  const messageId = String(message.id);
  const sentAt = String(message.sentAt || message.createdAt || new Date().toISOString());
  const sk = `${sentAt}#${messageId}`;
  const targets: Array<{ type: 'organization' | 'contact' | 'deal'; id: string }> = [];

  if (message.organizationId) {
    targets.push({ type: 'organization', id: String(message.organizationId) });
  }
  if (message.contactId) {
    targets.push({ type: 'contact', id: String(message.contactId) });
  }
  if (message.dealId) {
    targets.push({ type: 'deal', id: String(message.dealId) });
  }

  return targets.map(target => {
    const targetItem = compact({
      PK: `MESSAGE_TARGET#${target.type}:${target.id}`,
      SK: sk,
      GSI1PK: `MESSAGE#${target.type}:${target.id}`,
      GSI1SK: sk,
      ...(target.type === 'contact' ? { GSI4PK: `MESSAGE#contact:${target.id}`, GSI4SK: sk } : {}),
      ...(target.type === 'deal' ? { GSI2PK: `MESSAGE#deal:${target.id}`, GSI2SK: sk } : {}),
      id: messageId,
      messageId,
      targetType: target.type,
      targetId: target.id,
      organizationId: message.organizationId,
      contactId: message.contactId,
      dealId: message.dealId,
      personEmail: message.personEmail,
      threadId: message.threadId,
      direction: message.direction,
      channel: message.channel,
      snippet: message.snippet,
      sentAt,
      sourceType: message.sourceType,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      version: message.version,
    });
    return { Put: { TableName: TABLE_SPONSOR_CRM, Item: targetItem } };
  });
}

export async function createCrmRecord(client: DynamoDBDocumentClient, kind: string, value: Record<string, unknown>) {
  const sourceKey = typeof value.sourceKey === 'string' ? value.sourceKey : '';
  const id = sourceKey ? deterministicCrmId(kind, sourceKey) : randomUUID();
  const now = new Date().toISOString();
  const item = compact({ PK: key(kind, id), SK: key(kind, id), ...value, id, version: 1, createdAt: now, updatedAt: now });
  try {
    await transactCrmDependencies(client, [
      { Put: { TableName: TABLE_SPONSOR_CRM, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
      ...(kind === 'message' ? messageTargetWrites(item) : []),
    ], dependencies(kind, item));
    return { item: clean(item)!, duplicate: false };
  } catch (error) {
    if (!['ConditionalCheckFailedException', 'TransactionCanceledException'].includes((error as Error).name) || !sourceKey) throw error;
    const existing = await getCrmRecord(client, kind, id);
    if (!existing) throw error;
    if (!sameStored(existing, value)) throw replayConflict();
    // Message and target indexes were committed together; replay must never
    // recreate an index for a target that has since been hard-deleted.
    return { item: existing!, duplicate: true };
  }
}

export async function updateCrmRecord(client: DynamoDBDocumentClient, kind: string, existing: CrmRecord, value: Record<string, unknown>): Promise<CrmRecord> {
  const now = new Date().toISOString(), next = compact({ ...existing, ...value, id: existing.id, createdAt: existing.createdAt, updatedAt: now, version: existing.version + 1 }) as CrmRecord;
  await transactCrmDependencies(client, [{ Put: { TableName: TABLE_SPONSOR_CRM, Item: stored(kind, next), ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': existing.version } } }], addedDependencies(kind, existing, next));
  return next;
}

const deleteConflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });

/** Delete only an unreferenced directory record and its own audit/index rows. */
export async function hardDeleteCrmRecord(
  client: DynamoDBDocumentClient,
  kind: 'organization' | 'contact',
  id: string,
  expectedVersion?: number,
) {
  const pk = key(kind, id);
  const existing = (await client.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: { PK: pk, SK: pk }, ConsistentRead: true }))).Item;
  if (!existing) throw Object.assign(new Error('Not found'), { statusCode: 404 });
  if (expectedVersion !== undefined && expectedVersion !== existing.version) {
    throw deleteConflict('Record was changed; reload and retry');
  }
  // Include archived rows: archiving never removes a relationship. Fully
  // paginate consistent reads and fail closed if a storage bound is exceeded.
  const rows = await scanCrmTable(client, [
    'ORGANIZATION#', 'CONTACT#', 'DEAL#', 'DELIVERABLE#',
    'HISTORY#', 'NOTE#', 'MESSAGE#', 'MESSAGE_TARGET#', 'DOMAIN#', 'PRIMARY#',
  ]);
  const isKind = (row: Record<string, unknown>, prefix: string) => String(row.PK).startsWith(`${prefix}#`);
  if (kind === 'organization') {
    if (rows.some(row => isKind(row, 'DEAL') && row.organizationId === id)) {
      throw deleteConflict('Organization has deals, including archived deals');
    }
    if (rows.some(row => isKind(row, 'CONTACT') && row.organizationId === id)) {
      throw deleteConflict('Organization has linked contacts; hard-delete them first (archived contacts still count)');
    }
  } else if (rows.some(row => (isKind(row, 'DEAL') || isKind(row, 'DELIVERABLE')) &&
    (row.primaryContactId === id || row.contactId === id || (Array.isArray(row.contactIds) && row.contactIds.includes(id))))) {
    throw deleteConflict('Contact is primary or linked on a deal or deliverable, including archived records');
  }
  const historyPk = key('history', `${kind}:${id}`);
  const notePk = key('note', `${kind}:${id}`);
  const history = rows.filter(row => row.PK === historyPk);
  // Inline/imported notes have no reliable author provenance. Protect all
  // nonempty notes rather than guessing whether they were human-authored.
  if (String(existing.notes || '').trim() || rows.some(row => row.PK === notePk) ||
    history.some(row => String(row.note || row.body || '').trim())) {
    throw deleteConflict('Record has notes; hard delete is refused');
  }
  const emails = Array.isArray(existing.emails) ? existing.emails : [];
  const messageTargetPk = `MESSAGE_TARGET#${kind}:${id}`;
  if (history.some(row => row.action === 'touch') || rows.some(row => (isKind(row, 'MESSAGE') || row.PK === messageTargetPk) && row.sourceType === 'touch' &&
    (kind === 'organization' ? row.organizationId === id : row.contactId === id ||
      (row.organizationId === existing.organizationId && emails.includes(row.personEmail))))) {
    throw deleteConflict('Record has human-authored touches; hard delete is refused');
  }
  const indexes = rows.filter(row => row.PK === messageTargetPk || (kind === 'organization'
    ? (isKind(row, 'DOMAIN') && row.organizationId === id) || row.PK === key('primary', id)
    : isKind(row, 'PRIMARY') && row.contactId === id));
  const owned = [existing, ...history, ...indexes];
  // Keep cleanup atomic; never leave a half-deleted record when history is
  // too large for DynamoDB's transaction limit.
  if (owned.length > 100) throw deleteConflict('Record history exceeds the atomic hard-delete limit');
  await transact(client, owned.map(row => ({ Delete: {
    TableName: TABLE_SPONSOR_CRM,
    Key: { PK: row.PK, SK: row.SK },
    ...(row === existing ? {
      ConditionExpression: '#version = :version',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':version': existing.version },
    } : indexes.includes(row) ? {
      ConditionExpression: row.PK === messageTargetPk ? 'targetId = :owner' : isKind(row, 'DOMAIN') ? 'organizationId = :owner' : 'contactId = :owner',
      ExpressionAttributeValues: { ':owner': row.PK === messageTargetPk || isKind(row, 'DOMAIN') ? id : row.contactId },
    } : {}),
  } })));
  return { id, deleted: true };
}

function domainLock(domain: string, organizationId: string) {
  return { Put: { TableName: TABLE_SPONSOR_CRM, Item: { PK: key('domain', domain), SK: key('domain', domain), organizationId }, ConditionExpression: 'attribute_not_exists(PK) OR organizationId = :organizationId', ExpressionAttributeValues: { ':organizationId': organizationId } } };
}

export async function createOrganizationAtomic(client:DynamoDBDocumentClient,value:Record<string,unknown>,actorId:string){
  const sourceKey=typeof value.sourceKey==='string'?value.sourceKey:'',id=sourceKey?deterministicCrmId('organization',sourceKey):randomUUID(),now=new Date().toISOString(),item={...value,id,version:1,createdAt:now,updatedAt:now} as CrmRecord;
  const items:any[]=[{Put:{TableName:TABLE_SPONSOR_CRM,Item:stored('organization',item),ConditionExpression:'attribute_not_exists(PK)'}},historyPut(`organization:${id}`,{actorId,entityKind:'organization',entityId:id,action:'created'})];
  if (item.domain) items.push(domainLock(String(item.domain), id));
  try{await transact(client,items);return{item,duplicate:false};}
  catch(error){if(sourceKey){const existing=await getCrmRecord(client,'organization',id);if(existing){if(sameStored(existing,value))return{item:existing,duplicate:true};throw replayConflict();}}throw error;}
}

export async function updateOrganizationAtomic(client:DynamoDBDocumentClient,existing:CrmRecord,value:Record<string,unknown>,actorId:string,action='updated'){
  const next={...existing,...value,id:existing.id,createdAt:existing.createdAt,updatedAt:new Date().toISOString(),version:existing.version+1} as CrmRecord;
  if(value.archivedAt === null || (value.archivedAt === undefined && 'archivedAt' in value)) delete next.archivedAt;
  const items:any[]=[{Put:{TableName:TABLE_SPONSOR_CRM,Item:stored('organization',next),ConditionExpression:'#version=:version',ExpressionAttributeNames:{'#version':'version'},ExpressionAttributeValues:{':version':existing.version}}},historyPut(`organization:${existing.id}`,{actorId,entityKind:'organization',entityId:existing.id,action})];
  const previous=String(existing.domain||''),target=String(next.domain||'');
  if(target&&target!==previous)items.push(domainLock(target, existing.id));
  if(previous&&previous!==target)items.push({Delete:{TableName:TABLE_SPONSOR_CRM,Key:{PK:key('domain',previous),SK:key('domain',previous)},ConditionExpression:'organizationId=:organizationId',ExpressionAttributeValues:{':organizationId':existing.id}}});
  await transact(client,items);return next;
}

export async function createDealAtomic(client:DynamoDBDocumentClient,value:Record<string,unknown>,actorId:string){
  const {historyNote,...recordValue}=value,sourceKey=typeof recordValue.sourceKey==='string'?recordValue.sourceKey:'',id=sourceKey?deterministicCrmId('deal',sourceKey):randomUUID(),now=new Date().toISOString();
  const item={...recordValue,id,version:1,createdAt:now,updatedAt:now,active:recordValue.active!==false} as CrmRecord;
  try{await transactCrmDependencies(client,[{Put:{TableName:TABLE_SPONSOR_CRM,Item:stored('deal',item),ConditionExpression:'attribute_not_exists(PK)'}},historyPut(id,{actorId,oldStatus:null,newStatus:item.status,note:typeof historyNote==='string'?historyNote.slice(0,500):'Deal created'})], dependencies('deal', item));return{item,duplicate:false};}
  catch(error){if(sourceKey){const existing=await getCrmRecord(client,'deal',id);if(existing){if(sameStored(existing,recordValue))return{item:existing,duplicate:true};throw replayConflict();}}throw error;}
}

export async function updateDealAtomic(client:DynamoDBDocumentClient,existing:CrmRecord,value:Record<string,unknown>,actorId:string){
  const {historyNote,...changes}=value,now=new Date().toISOString(),next={...existing,...changes,id:existing.id,createdAt:existing.createdAt,updatedAt:now,version:existing.version+1} as CrmRecord;
  if(changes.archivedAt === null || (changes.archivedAt === undefined && 'archivedAt' in changes)) delete next.archivedAt;
  const items:any[]=[{Put:{TableName:TABLE_SPONSOR_CRM,Item:stored('deal',next),ConditionExpression:'#version = :version',ExpressionAttributeNames:{'#version':'version'},ExpressionAttributeValues:{':version':existing.version}}}];
  if(next.status!==existing.status)items.push(historyPut(existing.id,{actorId,oldStatus:existing.status,newStatus:next.status,note:typeof historyNote==='string'?String(historyNote).slice(0,500):undefined}));
  else if(next.archivedAt&&!existing.archivedAt)items.push(historyPut(existing.id,{actorId,entityKind:'deal',entityId:existing.id,action:'archived'}));
  else if(!next.archivedAt&&existing.archivedAt)items.push(historyPut(existing.id,{actorId,entityKind:'deal',entityId:existing.id,action:'unarchived'}));
  await transactCrmDependencies(client,items,addedDependencies('deal', existing, next));return next;
}

export async function createDeliverableAtomic(client:DynamoDBDocumentClient,value:Record<string,unknown>,actorId:string){
  const sourceKey=typeof value.sourceKey==='string'?value.sourceKey:'',id=sourceKey?deterministicCrmId('deliverable',sourceKey):randomUUID(),now=new Date().toISOString();
  const item={...value,id,version:1,createdAt:now,updatedAt:now,active:value.active!==false} as CrmRecord;
  const items:any[]=[{Put:{TableName:TABLE_SPONSOR_CRM,Item:stored('deliverable',item),ConditionExpression:'attribute_not_exists(PK)'}},historyPut(`deliverable:${id}`,{actorId,entityKind:'deliverable',entityId:id,action:'created'})];
  if(item.scheduleEntryId)items.push({Put:{TableName:TABLE_SPONSOR_CRM,Item:{PK:key('schedule',String(item.scheduleEntryId)),SK:key('schedule',String(item.scheduleEntryId)),deliverableId:id},ConditionExpression:'attribute_not_exists(PK)'}});
  try{await transactCrmDependencies(client,items,dependencies('deliverable', item));return{item,duplicate:false};}catch(error){if(sourceKey){const existing=await getCrmRecord(client,'deliverable',id);if(existing){if(sameStored(existing,value))return{item:existing,duplicate:true};throw replayConflict();}}throw error;}
}

export async function updateDeliverableAtomic(client:DynamoDBDocumentClient,existing:CrmRecord,value:Record<string,unknown>,actorId:string){
  const now=new Date().toISOString(),next={...existing,...value,id:existing.id,createdAt:existing.createdAt,updatedAt:now,version:existing.version+1} as CrmRecord,previous=String(existing.scheduleEntryId||''),target=String(next.scheduleEntryId||'');
  // A null link clears it.
  for(const name of ['cardId','newsletterIssueId'])if(next[name]===null)delete next[name];
  const items:any[]=[{Put:{TableName:TABLE_SPONSOR_CRM,Item:stored('deliverable',next),ConditionExpression:'#version = :version',ExpressionAttributeNames:{'#version':'version'},ExpressionAttributeValues:{':version':existing.version}}},historyPut(`deliverable:${existing.id}`,{actorId,entityKind:'deliverable',entityId:existing.id,action:'updated'})];
  if(target&&target!==previous)items.push({Put:{TableName:TABLE_SPONSOR_CRM,Item:{PK:key('schedule',target),SK:key('schedule',target),deliverableId:existing.id},ConditionExpression:'attribute_not_exists(PK)'}});
  if(previous&&previous!==target)items.push({Delete:{TableName:TABLE_SPONSOR_CRM,Key:{PK:key('schedule',previous),SK:key('schedule',previous)},ConditionExpression:'deliverableId = :deliverableId',ExpressionAttributeValues:{':deliverableId':existing.id}}});
  await transactCrmDependencies(client,items,addedDependencies('deliverable', existing, next));return next;
}

export async function createContactAtomic(client:DynamoDBDocumentClient,value:Record<string,unknown>,actorId:string){
  const sourceKey=typeof value.sourceKey==='string'?value.sourceKey:'',id=sourceKey?deterministicCrmId('contact',sourceKey):randomUUID(),now=new Date().toISOString(),item={...value,id,version:1,createdAt:now,updatedAt:now} as CrmRecord;
  const items:any[]=[];
  if(value.primary)items.push({Put:{TableName:TABLE_SPONSOR_CRM,Item:{PK:key('primary',String(value.organizationId)),SK:key('primary',String(value.organizationId)),contactId:id},ConditionExpression:'attribute_not_exists(PK)'}});
  items.push({Put:{TableName:TABLE_SPONSOR_CRM,Item:stored('contact',item),ConditionExpression:'attribute_not_exists(PK)'}},historyPut(`contact:${id}`,{actorId,entityKind:'contact',entityId:id,action:'created'}));
  try{await transactCrmDependencies(client,items,dependencies('contact', item));return{item,duplicate:false};}catch(error){if(sourceKey){const existing=await getCrmRecord(client,'contact',id);if(existing){if(sameStored(existing,value))return{item:existing,duplicate:true};throw replayConflict();}}throw error;}
}

export async function updateContactAtomic(client:DynamoDBDocumentClient,existing:CrmRecord,value:Record<string,unknown>,actorId:string,action='updated'){
  const next={...existing,...value,id:existing.id,createdAt:existing.createdAt,updatedAt:new Date().toISOString(),version:existing.version+1} as CrmRecord,oldPrimary=!!existing.primary,newPrimary=!!next.primary,oldOrg=String(existing.organizationId),newOrg=String(next.organizationId);
  if(value.archivedAt === null || (value.archivedAt === undefined && 'archivedAt' in value)) delete next.archivedAt;
  const items:any[]=[{Put:{TableName:TABLE_SPONSOR_CRM,Item:stored('contact',next),ConditionExpression:'#version=:version',ExpressionAttributeNames:{'#version':'version'},ExpressionAttributeValues:{':version':existing.version}}},historyPut(`contact:${existing.id}`,{actorId,entityKind:'contact',entityId:existing.id,action})];
  if(newPrimary&&(!oldPrimary||oldOrg!==newOrg))items.push({Put:{TableName:TABLE_SPONSOR_CRM,Item:{PK:key('primary',newOrg),SK:key('primary',newOrg),contactId:existing.id},ConditionExpression:'attribute_not_exists(PK)'}});
  if(oldPrimary&&(!newPrimary||oldOrg!==newOrg))items.push({Delete:{TableName:TABLE_SPONSOR_CRM,Key:{PK:key('primary',oldOrg),SK:key('primary',oldOrg)},ConditionExpression:'contactId=:contactId',ExpressionAttributeValues:{':contactId':existing.id}}});
  await transactCrmDependencies(client,items,addedDependencies('contact', existing, next));return next;
}

export async function appendBookingHistory(client: DynamoDBDocumentClient, bookingId: string, event: Record<string, unknown>) {
  const id = `${new Date().toISOString()}#${randomUUID()}`;
  const match = /^(organization|contact):(.+)$/.exec(bookingId);
  await transactCrmDependencies(client, [{ Put: { TableName: TABLE_SPONSOR_CRM, Item: { PK: key('history', bookingId), SK: id, ...event, id, bookingId, createdAt: new Date().toISOString() }, ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)' } }], match ? [{ kind: match[1], id: match[2] }] : []);
}
export const appendCrmAudit = (client: DynamoDBDocumentClient, kind: string, id: string, actorId: string, action: string) => appendBookingHistory(client, `${kind}:${id}`, { actorId, entityKind: kind, entityId: id, action });
export async function listBookingHistory(client: DynamoDBDocumentClient, bookingId: string) {
  const result = await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM, FilterExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': key('history', bookingId) } }));
  return (result.Items || []).map(item => clean(item as Record<string, unknown>) || item).map(({ PK, SK, ...item }: any) => item).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
