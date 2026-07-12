import { createHash, randomUUID } from 'crypto';
import { DeleteCommand, GetCommand, PutCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_SPONSOR_CRM } from './setup';

export type CrmRecord = Record<string, unknown> & { id: string; version: number; createdAt: string; updatedAt: string };
const key = (kind: string, id: string) => `${kind.toUpperCase()}#${id}`;
const clean = (item?: Record<string, unknown>): CrmRecord | null => {
  if (!item) return null;
  const { PK, SK, ...record } = item;
  return record as CrmRecord;
};
export const deterministicCrmId = (kind: string, sourceKey: string) => createHash('sha256').update(`${kind}:${sourceKey}`).digest('hex');
const stored = (kind: string, record: Record<string, unknown>) => ({ PK: key(kind, String(record.id)), SK: key(kind, String(record.id)), ...record });
const historyPut = (bookingId: string, event: Record<string, unknown>) => { const createdAt=new Date().toISOString(),id=`${createdAt}#${randomUUID()}`;return { Put:{TableName:TABLE_SPONSOR_CRM,Item:{PK:key('history',bookingId),SK:id,...event,id,bookingId,createdAt},ConditionExpression:'attribute_not_exists(PK) AND attribute_not_exists(SK)'} }; };
async function transact(client:DynamoDBDocumentClient,items:any[]){
  if(process.env.NODE_ENV!=='test') return client.send(new TransactWriteCommand({TransactItems:items,ClientRequestToken:randomUUID()}));
  // Dynalite used by this repository lacks TransactWriteItems. Production always
  // uses the command above; tests preserve conditional-write semantics locally.
  const before=[] as Array<{key:any;item?:Record<string,unknown>}>;
  for(const operation of items){const input=operation.Put||operation.Delete,keyValue=input.Key||{PK:input.Item.PK,SK:input.Item.SK};before.push({key:keyValue,item:(await client.send(new GetCommand({TableName:TABLE_SPONSOR_CRM,Key:keyValue}))).Item as Record<string,unknown>|undefined});}
  let applied=0;
  try{for(const item of items){if(item.Put)await client.send(new PutCommand(item.Put));else if(item.Delete)await client.send(new DeleteCommand(item.Delete));applied++;if(Number(process.env.SPONSOR_CRM_TEST_FAIL_AFTER||0)===applied)throw new Error('Injected sponsor CRM transaction failure');}}
  catch(error){for(const snapshot of before.slice(0,applied).reverse()){if(snapshot.item)await client.send(new PutCommand({TableName:TABLE_SPONSOR_CRM,Item:snapshot.item}));else await client.send(new DeleteCommand({TableName:TABLE_SPONSOR_CRM,Key:snapshot.key}));}throw error;}
}

export async function getCrmRecord(client: DynamoDBDocumentClient, kind: string, id: string) {
  const k = key(kind, id);
  return clean((await client.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: { PK: k, SK: k } }))).Item as Record<string, unknown>);
}

export async function listCrmRecords(client: DynamoDBDocumentClient, kind: string) {
  const result = await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM, FilterExpression: 'begins_with(PK, :prefix)', ExpressionAttributeValues: { ':prefix': `${kind.toUpperCase()}#` } }));
  return (result.Items || []).map(item => clean(item as Record<string, unknown>)!).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function createCrmRecord(client: DynamoDBDocumentClient, kind: string, value: Record<string, unknown>) {
  const sourceKey = typeof value.sourceKey === 'string' ? value.sourceKey : '';
  const id = sourceKey ? deterministicCrmId(kind, sourceKey) : randomUUID();
  const now = new Date().toISOString();
  const item = { PK: key(kind, id), SK: key(kind, id), ...value, id, version: 1, createdAt: now, updatedAt: now };
  try {
    await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
    return { item: clean(item)!, duplicate: false };
  } catch (error) {
    if ((error as Error).name !== 'ConditionalCheckFailedException' || !sourceKey) throw error;
    const existing = await getCrmRecord(client, kind, id);
    const same = existing && JSON.stringify(value) === JSON.stringify(Object.fromEntries(Object.keys(value).map(name => [name, existing[name]])));
    if (!same) throw Object.assign(new Error('Idempotency key already used with different data'), { statusCode: 409 });
    return { item: existing!, duplicate: true };
  }
}

export async function updateCrmRecord(client: DynamoDBDocumentClient, kind: string, existing: CrmRecord, value: Record<string, unknown>) {
  const now = new Date().toISOString(), next = { ...existing, ...value, id: existing.id, createdAt: existing.createdAt, updatedAt: now, version: existing.version + 1 };
  await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: { PK: key(kind, existing.id), SK: key(kind, existing.id), ...next }, ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': existing.version } }));
  return next;
}

export async function putBookingWithScheduleLock(client: DynamoDBDocumentClient, booking: CrmRecord, previousScheduleEntryId?: string) {
  const bookingKey = key('booking', booking.id), nextSchedule = booking.status === 'cancelled' ? '' : String(booking.scheduleEntryId || ''), claimedNew = !!nextSchedule && nextSchedule !== previousScheduleEntryId;
  if (nextSchedule) await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: { PK: key('schedule', nextSchedule), SK: key('schedule', nextSchedule), bookingId: booking.id }, ConditionExpression: 'attribute_not_exists(PK) OR bookingId = :bookingId', ExpressionAttributeValues: { ':bookingId': booking.id } }));
  try {
    await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: { PK: bookingKey, SK: bookingKey, ...booking }, ConditionExpression: '#version = :previous', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':previous': booking.version === 1 ? 1 : booking.version - 1 } }));
  } catch (error) {
    if (claimedNew) await client.send(new DeleteCommand({ TableName: TABLE_SPONSOR_CRM, Key: { PK: key('schedule', nextSchedule), SK: key('schedule', nextSchedule) }, ConditionExpression: 'bookingId = :bookingId', ExpressionAttributeValues: { ':bookingId': booking.id } }));
    throw error;
  }
  if (previousScheduleEntryId && previousScheduleEntryId !== nextSchedule) await client.send(new DeleteCommand({ TableName: TABLE_SPONSOR_CRM, Key: { PK: key('schedule', previousScheduleEntryId), SK: key('schedule', previousScheduleEntryId) }, ConditionExpression: 'bookingId = :bookingId', ExpressionAttributeValues: { ':bookingId': booking.id } }));
}

export async function createBookingAtomic(client:DynamoDBDocumentClient,value:Record<string,unknown>,actorId:string){
  const {historyNote,...recordValue}=value,sourceKey=typeof recordValue.sourceKey==='string'?recordValue.sourceKey:'',id=sourceKey?deterministicCrmId('booking',sourceKey):randomUUID(),now=new Date().toISOString();
  const item={...recordValue,id,version:1,createdAt:now,updatedAt:now} as CrmRecord,items:any[]=[{Put:{TableName:TABLE_SPONSOR_CRM,Item:stored('booking',item),ConditionExpression:'attribute_not_exists(PK)'}}];
  if(item.scheduleEntryId&&item.status!=='cancelled')items.push({Put:{TableName:TABLE_SPONSOR_CRM,Item:{PK:key('schedule',String(item.scheduleEntryId)),SK:key('schedule',String(item.scheduleEntryId)),bookingId:id},ConditionExpression:'attribute_not_exists(PK)'}});
  items.push(historyPut(id,{actorId,oldStatus:null,newStatus:item.status,note:typeof historyNote==='string'?historyNote.slice(0,500):'Booking created'}));
  try{await transact(client,items);return{item,duplicate:false};}catch(error){if(sourceKey){const existing=await getCrmRecord(client,'booking',id);const same=existing&&Object.keys(recordValue).every(name=>JSON.stringify(existing[name])===JSON.stringify(recordValue[name]));if(same)return{item:existing!,duplicate:true};}throw error;}
}

export async function updateBookingAtomic(client:DynamoDBDocumentClient,existing:CrmRecord,value:Record<string,unknown>,actorId:string){
  const {historyNote,...changes}=value,now=new Date().toISOString(),next={...existing,...changes,id:existing.id,createdAt:existing.createdAt,updatedAt:now,version:existing.version+1} as CrmRecord,previous=String(existing.scheduleEntryId||''),target=next.status==='cancelled'?'':String(next.scheduleEntryId||'');
  const items:any[]=[{Put:{TableName:TABLE_SPONSOR_CRM,Item:stored('booking',next),ConditionExpression:'#version = :version',ExpressionAttributeNames:{'#version':'version'},ExpressionAttributeValues:{':version':existing.version}}}];
  if(target&&target!==previous)items.push({Put:{TableName:TABLE_SPONSOR_CRM,Item:{PK:key('schedule',target),SK:key('schedule',target),bookingId:existing.id},ConditionExpression:'attribute_not_exists(PK)'}});
  if(previous&&previous!==target)items.push({Delete:{TableName:TABLE_SPONSOR_CRM,Key:{PK:key('schedule',previous),SK:key('schedule',previous)},ConditionExpression:'bookingId = :bookingId',ExpressionAttributeValues:{':bookingId':existing.id}}});
  if(next.status!==existing.status)items.push(historyPut(existing.id,{actorId,oldStatus:existing.status,newStatus:next.status,note:typeof historyNote==='string'?String(historyNote).slice(0,500):undefined}));
  await transact(client,items);return next;
}

export async function createOrganizationAtomic(client:DynamoDBDocumentClient,value:Record<string,unknown>,actorId:string){
  const sourceKey=typeof value.sourceKey==='string'?value.sourceKey:'',id=sourceKey?deterministicCrmId('organization',sourceKey):randomUUID(),now=new Date().toISOString(),item={...value,id,version:1,createdAt:now,updatedAt:now} as CrmRecord;
  try{await transact(client,[{Put:{TableName:TABLE_SPONSOR_CRM,Item:stored('organization',item),ConditionExpression:'attribute_not_exists(PK)'}},historyPut(`organization:${id}`,{actorId,entityKind:'organization',entityId:id,action:'created'})]);return{item,duplicate:false};}
  catch(error){if(sourceKey){const existing=await getCrmRecord(client,'organization',id);if(existing&&Object.keys(value).every(name=>JSON.stringify(existing[name])===JSON.stringify(value[name])))return{item:existing,duplicate:true};}throw error;}
}

export async function updateOrganizationAtomic(client:DynamoDBDocumentClient,existing:CrmRecord,value:Record<string,unknown>,actorId:string,action='updated'){
  const next={...existing,...value,id:existing.id,createdAt:existing.createdAt,updatedAt:new Date().toISOString(),version:existing.version+1} as CrmRecord;
  await transact(client,[{Put:{TableName:TABLE_SPONSOR_CRM,Item:stored('organization',next),ConditionExpression:'#version=:version',ExpressionAttributeNames:{'#version':'version'},ExpressionAttributeValues:{':version':existing.version}}},historyPut(`organization:${existing.id}`,{actorId,entityKind:'organization',entityId:existing.id,action})]);return next;
}

export async function createContactAtomic(client:DynamoDBDocumentClient,value:Record<string,unknown>,actorId:string){
  const sourceKey=typeof value.sourceKey==='string'?value.sourceKey:'',id=sourceKey?deterministicCrmId('contact',sourceKey):randomUUID(),now=new Date().toISOString(),item={...value,id,version:1,createdAt:now,updatedAt:now} as CrmRecord;
  const items:any[]=[];
  if(value.primary)items.push({Put:{TableName:TABLE_SPONSOR_CRM,Item:{PK:key('primary',String(value.organizationId)),SK:key('primary',String(value.organizationId)),contactId:id},ConditionExpression:'attribute_not_exists(PK)'}});
  items.push({Put:{TableName:TABLE_SPONSOR_CRM,Item:stored('contact',item),ConditionExpression:'attribute_not_exists(PK)'}},historyPut(`contact:${id}`,{actorId,entityKind:'contact',entityId:id,action:'created'}));
  try{await transact(client,items);return{item,duplicate:false};}catch(error){if(sourceKey){const existing=await getCrmRecord(client,'contact',id);if(existing&&Object.keys(value).every(name=>JSON.stringify(existing[name])===JSON.stringify(value[name])))return{item:existing,duplicate:true};}throw error;}
}

export async function updateContactAtomic(client:DynamoDBDocumentClient,existing:CrmRecord,value:Record<string,unknown>,actorId:string){
  const next={...existing,...value,id:existing.id,createdAt:existing.createdAt,updatedAt:new Date().toISOString(),version:existing.version+1} as CrmRecord,oldPrimary=!!existing.primary,newPrimary=!!next.primary,oldOrg=String(existing.organizationId),newOrg=String(next.organizationId),items:any[]=[{Put:{TableName:TABLE_SPONSOR_CRM,Item:stored('contact',next),ConditionExpression:'#version=:version',ExpressionAttributeNames:{'#version':'version'},ExpressionAttributeValues:{':version':existing.version}}},historyPut(`contact:${existing.id}`,{actorId,entityKind:'contact',entityId:existing.id,action:'updated'})];
  if(newPrimary&&(!oldPrimary||oldOrg!==newOrg))items.push({Put:{TableName:TABLE_SPONSOR_CRM,Item:{PK:key('primary',newOrg),SK:key('primary',newOrg),contactId:existing.id},ConditionExpression:'attribute_not_exists(PK)'}});
  if(oldPrimary&&(!newPrimary||oldOrg!==newOrg))items.push({Delete:{TableName:TABLE_SPONSOR_CRM,Key:{PK:key('primary',oldOrg),SK:key('primary',oldOrg)},ConditionExpression:'contactId=:contactId',ExpressionAttributeValues:{':contactId':existing.id}}});
  await transact(client,items);return next;
}

export async function appendBookingHistory(client: DynamoDBDocumentClient, bookingId: string, event: Record<string, unknown>) {
  const id = `${new Date().toISOString()}#${randomUUID()}`;
  await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: { PK: key('history', bookingId), SK: id, ...event, id, bookingId, createdAt: new Date().toISOString() }, ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)' }));
}
export const appendCrmAudit = (client: DynamoDBDocumentClient, kind: string, id: string, actorId: string, action: string) => appendBookingHistory(client, `${kind}:${id}`, { actorId, entityKind: kind, entityId: id, action });
export async function listBookingHistory(client: DynamoDBDocumentClient, bookingId: string) {
  const result = await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM, FilterExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': key('history', bookingId) } }));
  return (result.Items || []).map(item => clean(item as Record<string, unknown>) || item).map(({ PK, SK, ...item }: any) => item).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
