import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent,LambdaResponse } from '../types';
import { dismissCalendarAlert,getCalendarOverlaySettings,isCalendarAlertDismissed,saveCalendarOverlaySettings } from '../db/calendar';
import { calendarAlerts } from '../calendar/alerts';
import { projectCalendarEntities } from '../calendar/entities';
import { builtInHolidayGeneration,holidayMetadata,holidaySnapshot } from '../calendar/holidays';
import { persistHolidayGeneration,readHolidayGeneration } from '../db/calendarHolidays';
import { projectCalendarOverlays } from '../calendar/overlays';
import { newsletterCalendarOverlay } from '../calendar/newsletterOverlay';
import { berlinToday, ownerCalendarOverlay, ownerCalendarRange, fetchDapierConnections, parseDurationMinutes, parseSlotWindow } from '../calendar/ownerCalendarOverlay';
import { calendarHoldOverlay, suppressHeldSlots } from '../calendar/holdOverlay';
import { listCalendarHolds } from '../db/calendarHolds';
const json=(statusCode:number,body:unknown):LambdaResponse=>({statusCode,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const realDate=(v:any)=>typeof v==='string'&&DATE.test(v)&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
const days=(a:string,b:string)=>(Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000;
const parse=(event:LambdaEvent)=>{try{return event.body?JSON.parse(String(event.body)):null}catch{return null}};
const actor=(event:LambdaEvent)=>Object.entries(event.headers||{}).find(([k])=>k.toLowerCase()==='x-user-id')?.[1]||'authenticated-operator';
function range(event:LambdaEvent){const q=event.queryStringParameters||{},from=q.from,to=q.to;if(!realDate(from)||!realDate(to)||from!>to||days(from!,to!)>366)return null;return {from:from!,to:to!};}
// The calendar is a read-only projection: event Cards, podcast episodes and
// (as an overlay) newsletter issues. It stores no activities of its own.
export async function handleCalendarRoutes(path:string,method:string,event:LambdaEvent,client:DynamoDBDocumentClient){
 if(path==='/api/calendar-items/holidays/sync'){if(method!=='POST')return json(405,{error:'Method not allowed'});try{const generation=await persistHolidayGeneration(client,builtInHolidayGeneration());return json(200,{generationId:generation.generationId,revision:generation.revision,freshAsOf:generation.freshAsOf,count:generation.occurrences.length})}catch{return json(503,{error:'Holiday refresh failed; last-known-good retained'})}}
 const dismissal=path.match(/^\/api\/calendar-items\/alerts\/([^/]+)\/dismiss$/);if(dismissal){if(method!=='POST')return json(405,{error:'Method not allowed'});const fingerprint=decodeURIComponent(dismissal[1]);if(!fingerprint||fingerprint.length>1000)return json(400,{error:'Invalid alert fingerprint'});await dismissCalendarAlert(client,fingerprint,actor(event));return json(200,{dismissed:true});}
 if(path==='/api/calendar-items/settings'){
  if(method==='GET'){const settings=await getCalendarOverlaySettings(client),discovery=await fetchDapierConnections();return json(200,{settings,...discovery});}
  if(method==='PUT'){const body=parse(event);if(!body||typeof body!=='object'||Array.isArray(body))return json(400,{error:'Request body is required'});const settings=await saveCalendarOverlaySettings(client,body,actor(event));return json(200,{settings});}
  return json(405,{error:'Method not allowed'});
 }
 const r=range(event);
 if(path==='/api/calendar-items/overlays'){if(method!=='GET')return json(405,{error:'Method not allowed'});if(!r)return json(400,{error:'Invalid or unbounded range'});const q=event.queryStringParameters||{},includeAll=q.all==='true'||q.includeAll==='true'||r.from===r.to;
 let durationMinutes: number; let slotWindow: 'midday'|'evening'|'any'; try{durationMinutes=parseDurationMinutes((q as any).duration);slotWindow=parseSlotWindow((q as any).window);}catch(e:any){return json(400,{error:String(e?.message||'Invalid duration or window')});}
 // Past days get no open slots, so the owner's calendar is read only for a range that reaches today.
 const providers=[newsletterCalendarOverlay(client)];if(ownerCalendarRange(r.from,r.to))providers.push(ownerCalendarOverlay({ client, includeAll, durationMinutes, window: slotWindow }));const holds=await listCalendarHolds(client,{from:r.from,to:r.to,activeOnly:true});providers.push(calendarHoldOverlay(holds));const projected=await projectCalendarOverlays(r.from,r.to,providers);const items=suppressHeldSlots(projected.items,holds);return json(200,{...projected,items,durationMinutes,window:slotWindow});}
 if(path!=='/api/calendar-items')return json(404,{error:'Not found'});
 if(method!=='GET')return json(405,{error:'Method not allowed'});
 if(!r)return json(400,{error:'Invalid or unbounded range'});
 const items=await projectCalendarEntities(client,r.from,r.to),generation=await readHolidayGeneration(client),holidays=(generation?.occurrences||holidaySnapshot(r.from,r.to)).filter(h=>h.startDate<=r.to&&h.endDate>=r.from),base=generation?{region:'DE-BE',freshAsOf:generation.freshAsOf,horizon:generation.horizon,stale:(Date.now()-Date.parse(`${generation.freshAsOf}T00:00:00Z`))>180*86400000,outOfHorizon:r.from<generation.horizon.from||r.to>generation.horizon.to,sources:generation.sourceUrls,lastKnownGood:true,generationId:generation.generationId,persistent:true}:holidayMetadata(r.from,r.to),computed=calendarAlerts(items,holidays,berlinToday()),dismissed=await Promise.all(computed.map(a=>isCalendarAlertDismissed(client,a.fingerprint)));
 return json(200,{items,holidays,holidayMetadata:base,alerts:computed.filter((_,i)=>!dismissed[i]),timeZone:'Europe/Berlin'});
}
