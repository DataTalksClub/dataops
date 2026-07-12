import { createHash, randomUUID } from 'crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_CALENDAR } from './setup';

export type CalendarItem = Record<string, unknown> & { id:string; version:number; startKey:string; endKey:string; createdAt:string; updatedAt:string };
const pk=(id:string)=>`ITEM#${id}`;
const clean=(raw:any):CalendarItem|null=>{ if(!raw)return null; const {PK,SK,rangeMonth,rangeStart,...item}=raw; return item as CalendarItem; };
export const calendarId=(sourceKey:string)=>createHash('sha256').update(`calendar:${sourceKey}`).digest('hex');
const months=(from:string,to:string)=>{ const out:string[]=[]; let y=+from.slice(0,4),m=+from.slice(5,7); const ey=+to.slice(0,4),em=+to.slice(5,7); while(y<ey||(y===ey&&m<=em)){out.push(`${y}-${String(m).padStart(2,'0')}`); if(++m===13){m=1;y++;}} return out; };
const stored=(item:CalendarItem)=>({PK:pk(item.id),SK:'META',...item});
const projections=(item:CalendarItem)=>months(item.startKey.slice(0,7)+'-01',item.endKey.slice(0,7)+'-01').map(month=>({PK:pk(item.id),SK:`RANGE#${month}`,rangeMonth:month,rangeStart:`${item.startKey}#${item.id}`,...item}));

export async function getCalendarItem(client:DynamoDBDocumentClient,id:string){ return clean((await client.send(new GetCommand({TableName:TABLE_CALENDAR,Key:{PK:pk(id),SK:'META'}}))).Item); }
export async function listCalendarItems(client:DynamoDBDocumentClient,from:string,to:string){
  const found=new Map<string,CalendarItem>();
  for(const month of months(from,to)){
    let cursor:Record<string,unknown>|undefined;do{const result=await client.send(new QueryCommand({TableName:TABLE_CALENDAR,IndexName:'GSI-Range',KeyConditionExpression:'rangeMonth=:m AND rangeStart <= :to',ExpressionAttributeValues:{':m':month,':to':`${to}~`},ExclusiveStartKey:cursor}));
    for(const raw of result.Items||[]){const item=clean(raw)!; if(item.endKey>=from) found.set(item.id,item);}cursor=result.LastEvaluatedKey;}while(cursor);
  }
  return [...found.values()].sort((a,b)=>a.startKey.localeCompare(b.startKey)||a.id.localeCompare(b.id));
}
async function replace(client:DynamoDBDocumentClient,item:CalendarItem,old?:CalendarItem){
  if(process.env.NODE_ENV!=='test'){
    const nextKeys=new Set(projections(item).map(p=>p.SK)),deletes=old?projections(old).filter(p=>!nextKeys.has(p.SK)).map(p=>({Delete:{TableName:TABLE_CALENDAR,Key:{PK:p.PK,SK:p.SK}}})):[];
    const puts=[stored(item),...projections(item)].map(p=>({Put:{TableName:TABLE_CALENDAR,Item:p,...(p.SK==='META'?(old?{ConditionExpression:'#v=:v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':old.version}}:{ConditionExpression:'attribute_not_exists(PK)'}):{})}}));
    await client.send(new TransactWriteCommand({TransactItems:[...deletes,...puts]}));return;
  }
  await client.send(new PutCommand({TableName:TABLE_CALENDAR,Item:stored(item),...(old?{ConditionExpression:'#v=:v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':old.version}}:{ConditionExpression:'attribute_not_exists(PK)'})}));
  if(old)for(const p of projections(old))await client.send(new DeleteCommand({TableName:TABLE_CALENDAR,Key:{PK:p.PK,SK:p.SK}}));
  for(const p of projections(item))await client.send(new PutCommand({TableName:TABLE_CALENDAR,Item:p}));
}
export async function createCalendarItem(client:DynamoDBDocumentClient,input:Record<string,unknown>,actor:string){
  const sourceKey=String(input.sourceKey||''), id=sourceKey?calendarId(sourceKey):randomUUID(), now=new Date().toISOString();
  const item={...input,id,version:1,createdBy:actor,updatedBy:actor,createdAt:now,updatedAt:now} as unknown as CalendarItem;
  try{await replace(client,item); return {item,duplicate:false};}catch(error){
    if(!['TransactionCanceledException','ConditionalCheckFailedException'].includes((error as Error).name)||!sourceKey) throw error;
    const existing=await getCalendarItem(client,id); const comparable={...existing}; for(const k of ['id','version','createdBy','updatedBy','createdAt','updatedAt','startKey','endKey']) delete comparable[k];
    if(existing&&Object.keys(input).every(k=>JSON.stringify(existing[k])===JSON.stringify(input[k]))) return {item:existing,duplicate:true};
    throw Object.assign(new Error('Source key already used'),{statusCode:409});
  }
}
export async function updateCalendarItem(client:DynamoDBDocumentClient,old:CalendarItem,input:Record<string,unknown>,actor:string){ const item={...old,...input,id:old.id,version:old.version+1,createdAt:old.createdAt,createdBy:old.createdBy,updatedAt:new Date().toISOString(),updatedBy:actor} as CalendarItem; await replace(client,item,old); return item; }
export async function deleteCalendarItem(client:DynamoDBDocumentClient,old:CalendarItem){if(process.env.NODE_ENV!=='test'){await client.send(new TransactWriteCommand({TransactItems:[{Delete:{TableName:TABLE_CALENDAR,Key:{PK:pk(old.id),SK:'META'},ConditionExpression:'#v=:v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':old.version}}},...projections(old).map(p=>({Delete:{TableName:TABLE_CALENDAR,Key:{PK:p.PK,SK:p.SK}}}))]}));return;} await client.send(new DeleteCommand({TableName:TABLE_CALENDAR,Key:{PK:pk(old.id),SK:'META'},ConditionExpression:'#v=:v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':old.version}}));for(const p of projections(old))await client.send(new DeleteCommand({TableName:TABLE_CALENDAR,Key:{PK:p.PK,SK:p.SK}})); }
export async function dismissCalendarAlert(client:DynamoDBDocumentClient,fingerprint:string,actor:string){const key=`ALERT#${createHash('sha256').update(fingerprint).digest('hex')}`;await client.send(new PutCommand({TableName:TABLE_CALENDAR,Item:{PK:key,SK:key,fingerprint,dismissedBy:actor,dismissedAt:new Date().toISOString()}}));}
export async function isCalendarAlertDismissed(client:DynamoDBDocumentClient,fingerprint:string){const key=`ALERT#${createHash('sha256').update(fingerprint).digest('hex')}`;return !!(await client.send(new GetCommand({TableName:TABLE_CALENDAR,Key:{PK:key,SK:key}}))).Item;}
