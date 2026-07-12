import { createHash, randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_CALENDAR } from './setup';
import type { HolidayOccurrence } from '../calendar/holidays';
import { holidaySnapshot } from '../calendar/holidays';

const POINTER={PK:'HOLIDAYS',SK:'CURRENT'};
let testFailAfter:number|null=null;
export function setHolidaySyncFailureForTests(value:number|null){testFailAfter=value;}
export type HolidayGeneration={generationId:string;revision:string;freshAsOf:string;horizon:{from:string;to:string};sourceUrls:string[];occurrences:HolidayOccurrence[]};
function validate(g:HolidayGeneration){
 const expectedRevision='Berlin school holiday order 2024/25–2029/30, 30 August 2024; FeiertG BE current snapshot 13 July 2026';
 if(g.revision!==expectedRevision)throw new Error('Holiday generation revision is not approved');
 if(!g.revision||!/^\d{4}-\d{2}-\d{2}$/.test(g.freshAsOf)||!/^\d{4}-\d{2}-\d{2}$/.test(g.horizon.from)||!/^\d{4}-\d{2}-\d{2}$/.test(g.horizon.to)||g.horizon.from>g.horizon.to)throw new Error('Invalid holiday generation metadata');
 if(!g.sourceUrls.length||g.sourceUrls.some(url=>!url.startsWith('https://www.berlin.de/')&&!url.startsWith('https://gesetze.berlin.de/')))throw new Error('Holiday source is not allowlisted');
 if(!g.occurrences.length||g.occurrences.some(h=>h.region!=='DE-BE'||h.startDate>h.endDate||(h.kind!=='berlin-public-holiday'&&(h.startDate<g.horizon.from||h.endDate>g.horizon.to))||!g.sourceUrls.includes(h.officialSourceUrl)))throw new Error('Invalid or incomplete holiday occurrences');
 if(g.horizon.from!=='2025-10-20'||g.horizon.to!=='2030-08-17')throw new Error('Holiday horizon is incomplete');
 const identity=(h:HolidayOccurrence)=>`${h.kind}|${h.name}|${h.startDate}|${h.endDate}|${h.officialSourceUrl}|${h.sourceRevision}|${h.schoolYear||''}`,expected=holidaySnapshot('2025-01-01','2030-12-31').map(identity).sort(),actual=g.occurrences.map(identity).sort();if(expected.length!==actual.length||expected.some((value,index)=>value!==actual[index]))throw new Error('Holiday generation is incomplete');
 for(let year=2025;year<=2030;year++){const count=g.occurrences.filter(h=>h.kind==='berlin-public-holiday'&&h.startDate.startsWith(`${year}-`)).length;if(count!==(year===2028?11:10))throw new Error('Statutory public holiday set is incomplete');}
 const schoolHolidays=g.occurrences.filter(h=>h.kind==='berlin-school-holiday'),schoolFree=g.occurrences.filter(h=>h.kind==='school-free-day');if(schoolHolidays.length!==30||schoolFree.length!==7)throw new Error('School holiday category set is incomplete');for(const schoolYear of ['2025/26','2026/27','2027/28','2028/29','2029/30'])for(const name of ['Autumn holidays','Christmas holidays','Winter holidays','Easter holidays','Pentecost holidays','Summer holidays'])if(!schoolHolidays.some(h=>h.schoolYear===schoolYear&&h.name===name))throw new Error('School holiday year is incomplete');
 if(!actual.some(value=>value.includes('berlin-public-holiday|75th anniversary of the uprising of 17 June 1953|2028-06-17|2028-06-17')))throw new Error('Exceptional 17 June 2028 holiday is missing');
}
export async function persistHolidayGeneration(client:DynamoDBDocumentClient,input:Omit<HolidayGeneration,'generationId'>){
 const generationId=createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0,24),g={...input,generationId};validate(g);const pk=`HOLIDAYS#${generationId}`,records=g.occurrences.map((occurrence,index)=>({PK:pk,SK:`OCC#${String(index).padStart(3,'0')}`,occurrence})),pointer={...POINTER,generationId,revision:g.revision,freshAsOf:g.freshAsOf,horizon:g.horizon,sourceUrls:g.sourceUrls,updatedAt:new Date().toISOString()};
 if(process.env.NODE_ENV==='test'){for(let i=0;i<records.length;i++){if(testFailAfter===i)throw new Error('Injected holiday sync failure');await client.send(new PutCommand({TableName:TABLE_CALENDAR,Item:records[i]}));}if(testFailAfter===records.length)throw new Error('Injected holiday sync failure');await client.send(new PutCommand({TableName:TABLE_CALENDAR,Item:pointer}));}
 else {for(const record of records)await client.send(new PutCommand({TableName:TABLE_CALENDAR,Item:record}));await client.send(new PutCommand({TableName:TABLE_CALENDAR,Item:pointer}));}
 return g;
}
export async function readHolidayGeneration(client:DynamoDBDocumentClient):Promise<HolidayGeneration|null>{const pointer=(await client.send(new GetCommand({TableName:TABLE_CALENDAR,Key:POINTER}))).Item;if(!pointer)return null;const occurrences:HolidayOccurrence[]=[];let cursor:Record<string,unknown>|undefined;do{const result=await client.send(new QueryCommand({TableName:TABLE_CALENDAR,KeyConditionExpression:'PK=:pk AND begins_with(SK,:prefix)',ExpressionAttributeValues:{':pk':`HOLIDAYS#${pointer.generationId}`,':prefix':'OCC#'},ExclusiveStartKey:cursor}));for(const item of result.Items||[])occurrences.push(item.occurrence as HolidayOccurrence);cursor=result.LastEvaluatedKey;}while(cursor);if(!occurrences.length)return null;return {generationId:String(pointer.generationId),revision:String(pointer.revision),freshAsOf:String(pointer.freshAsOf),horizon:pointer.horizon as any,sourceUrls:pointer.sourceUrls as string[],occurrences};}
