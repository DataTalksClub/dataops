import type { CalendarItem } from '../db/calendar';
import type { HolidayOccurrence } from './holidays';
export function calendarAlerts(items:CalendarItem[],holidays:HolidayOccurrence[]){
 const active=items.filter(i=>i.status!=='cancelled'), out:any[]=[];
 const add=(reasonCode:string,severity:string,ids:string[],basis:string)=>out.push({reasonCode,severity,affectedIds:ids,fingerprint:`${reasonCode}#${[...ids].sort().join(',')}#${basis}`});
 for(let i=0;i<active.length;i++) for(let j=i+1;j<active.length;j++){const timed=!active[i].allDay&&!active[j].allDay,overlap=timed?String(active[i].startsAt)<String(active[j].endsAt)&&String(active[j].startsAt)<String(active[i].endsAt):active[i].startKey<=active[j].endKey&&active[j].startKey<=active[i].endKey;if(overlap)add('activity-overlap','warning',[active[i].id,active[j].id],`${active[i].version}:${active[j].version}:${active[i].startKey}:${active[j].startKey}`);}
 for(const item of active){
  if(!item.bundleId&&!item.templateId) add('missing-workflow-context','info',[item.id],String(item.updatedAt));
  if(['confirmed','announced','published'].includes(String(item.status))) for(const h of holidays) if(item.startKey.slice(0,10)<=h.endDate&&item.endKey.slice(0,10)>=h.startDate) add(h.kind==='berlin-public-holiday'?'public-holiday-overlap':'school-holiday-overlap','warning',[item.id],`${h.kind}:${h.startDate}:${h.endDate}`);
 }
 return out;
}
