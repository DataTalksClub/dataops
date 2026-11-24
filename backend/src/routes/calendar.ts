import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent,LambdaResponse } from '../types';
import { dismissCalendarAlert,getCalendarOverlaySettings,isCalendarAlertDismissed,saveCalendarOverlaySettings } from '../db/calendar';
import { calendarAlerts } from '../calendar/alerts';
import { projectCalendarEntities } from '../calendar/entities';
import { builtInHolidayGeneration,holidayMetadata,holidaySnapshot } from '../calendar/holidays';
import { persistHolidayGeneration,readHolidayGeneration } from '../db/calendarHolidays';
import { projectCalendarOverlays } from '../calendar/overlays';
import { newsletterCalendarOverlay } from '../calendar/newsletterOverlay';
import { berlinToday, eachDayOfInterval, ownerCalendarOverlay, ownerCalendarRange, fetchDapierConnections, parseDurationMinutes, parseSlotWindow, preferStartFor, DEFAULT_CALL_DURATION_MINUTES, WORKSHOP_DURATION_MINUTES, type SlotWindow } from '../calendar/ownerCalendarOverlay';
import { calendarHoldOverlay, markDuplicateCalendarHolds, suppressHeldSlots, suppressPublicEventSlots } from '../calendar/holdOverlay';
import { listCalendarHolds } from '../db/calendarHolds';
import { listAllCards } from '../db/cards';
import { addDays } from '../podcast/recordingSlots';
import { cardEventInterval } from '../calendar/cardEventTime';
import { json, parseJsonEvent as parse } from '../http';
import { realDate } from '../sponsorCrm/model';
const days=(a:string,b:string)=>(Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000;
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
 if(path==='/api/calendar-items/next-free-day'){
  if(method!=='GET')return json(405,{error:'Method not allowed'});
  const q=event.queryStringParameters||{};
  const type=typeof q.type==='string'&&q.type.trim()?q.type.trim().toLowerCase():undefined;
  const today=berlinToday();
  const rawFrom=q.from&&realDate(q.from)?q.from:today;
  const from=rawFrom<today?today:rawFrom;
  const to=q.to&&realDate(q.to)?q.to:addDays(from,59);
  if(from>to||days(from,to)>366)return json(400,{error:'Invalid or unbounded range'});
  let durationMinutes: number; let slotWindow: SlotWindow;
  try{
   slotWindow=parseSlotWindow(q.window);
   if(slotWindow==='call')return json(400,{error:"next-free-day supports window 'midday', 'evening', or 'any'"});
   const defaultDuration=type==='workshop'?WORKSHOP_DURATION_MINUTES:undefined;
   durationMinutes=parseDurationMinutes(q.duration,defaultDuration);
  }catch(e:any){return json(400,{error:String(e?.message||'Invalid duration or window')});}
  const overlay=await ownerCalendarOverlay({client,durationMinutes,window:slotWindow}).project(from,to);
  if(overlay.connection.state!=='connected')return json(503,{error:overlay.connection.reason||'The authoritative owner calendar is unavailable'});
  const [holds,entities,cards]=await Promise.all([
   listCalendarHolds(client,{from,to,activeOnly:true}),
   projectCalendarEntities(client,from,to),
   listAllCards(client),
  ]);
  const withHolds=suppressHeldSlots(overlay.items,holds);
  const freeItems=suppressPublicEventSlots(withHolds,entities.map(item=>item.date));
  const overlaps=(a:number,b:number,c:number,d:number)=>a<d&&b>c;
  const activeCards=cards.filter(c=>c.status!=='archived'&&c.eventTime);
  const windowOrder:('midday'|'evening')[]=slotWindow==='any'?['midday','evening']:[slotWindow];
  const isSlotFreeOnDay=(day:string,w:'midday'|'evening')=>{
   if(!freeItems.some(i=>i.provider==='owner-calendar'&&i.isAvailableSlot&&i.startDate===day&&i.slot===w))return false;
   const interval=cardEventInterval(`${day} ${preferStartFor(w,durationMinutes)}`,durationMinutes,'Europe/Berlin');
   const start=Date.parse(interval.startIso),end=Date.parse(interval.endIso);
   if(start<=Date.now())return false;
   return !activeCards.some(c=>overlaps(start,end,Date.parse(c.eventTime!.startIso),Date.parse(c.eventTime!.endIso)));
  };
  const middayTime=preferStartFor('midday',durationMinutes),eveningTime=preferStartFor('evening',durationMinutes);
  for(const day of eachDayOfInterval(from,to)){
   const availableWindows=windowOrder.filter(w=>isSlotFreeOnDay(day,w));
   if(!availableWindows.length)continue;
   const chosen=availableWindows[0];
   return json(200,{
    found:true,date:day,window:chosen,time:preferStartFor(chosen,durationMinutes),durationMinutes,
    ...(type?{type}:{}),from,to,availableWindows,
    slots:{midday:{available:availableWindows.includes('midday'),time:middayTime},evening:{available:availableWindows.includes('evening'),time:eveningTime}},
   });
  }
  return json(200,{
   found:false,date:null,window:slotWindow,time:null,durationMinutes,
   ...(type?{type}:{}),from,to,availableWindows:[],
   slots:{midday:{available:false,time:middayTime},evening:{available:false,time:eveningTime}},
  });
 }
 const r=range(event);
 if(path==='/api/calendar-items/overlays'){if(method!=='GET')return json(405,{error:'Method not allowed'});if(!r)return json(400,{error:'Invalid or unbounded range'});const q=event.queryStringParameters||{},includeAll=q.all==='true'||q.includeAll==='true'||(q.all!=='false'&&q.includeAll!=='false'&&r.from===r.to);
 let durationMinutes: number; let slotWindow: SlotWindow; try{slotWindow=parseSlotWindow((q as any).window);durationMinutes=parseDurationMinutes((q as any).duration,slotWindow==='call'?DEFAULT_CALL_DURATION_MINUTES:undefined);}catch(e:any){return json(400,{error:String(e?.message||'Invalid duration or window')});}
 // Past days get no open slots, so the owner's calendar is read only for a range that reaches today.
 const providers=[newsletterCalendarOverlay(client)];if(ownerCalendarRange(r.from,r.to))providers.push(ownerCalendarOverlay({ client, includeAll, durationMinutes, window: slotWindow }));const holds=await listCalendarHolds(client,{from:r.from,to:r.to,activeOnly:true});providers.push(calendarHoldOverlay(holds));const projected=await projectCalendarOverlays(r.from,r.to,providers);if(projected.sources['owner-calendar'] && projected.sources['owner-calendar'].state!=='connected')return json(503,{error:projected.sources['owner-calendar'].reason||'Owner freebusy is unavailable',sources:projected.sources});const entities=await projectCalendarEntities(client,r.from,r.to);const withHolds=suppressHeldSlots(projected.items,holds);const withPublicEvents=suppressPublicEventSlots(withHolds,entities.map(item=>item.date));const items=markDuplicateCalendarHolds(withPublicEvents,holds,entities);return json(200,{...projected,items,durationMinutes,window:slotWindow});}
 if(path!=='/api/calendar-items')return json(404,{error:'Not found'});
 if(method!=='GET')return json(405,{error:'Method not allowed'});
 if(!r)return json(400,{error:'Invalid or unbounded range'});
 const items=await projectCalendarEntities(client,r.from,r.to),generation=await readHolidayGeneration(client),holidays=(generation?.occurrences||holidaySnapshot(r.from,r.to)).filter(h=>h.startDate<=r.to&&h.endDate>=r.from),base=generation?{region:'DE-BE',freshAsOf:generation.freshAsOf,horizon:generation.horizon,stale:(Date.now()-Date.parse(`${generation.freshAsOf}T00:00:00Z`))>180*86400000,outOfHorizon:r.from<generation.horizon.from||r.to>generation.horizon.to,sources:generation.sourceUrls,lastKnownGood:true,generationId:generation.generationId,persistent:true}:holidayMetadata(r.from,r.to),computed=calendarAlerts(items.filter(item=>!item.displayDuplicateOf),holidays,berlinToday()),dismissed=await Promise.all(computed.map(a=>isCalendarAlertDismissed(client,a.fingerprint)));
 return json(200,{items,holidays,holidayMetadata:base,alerts:computed.filter((_,i)=>!dismissed[i]),timeZone:'Europe/Berlin'});
}
