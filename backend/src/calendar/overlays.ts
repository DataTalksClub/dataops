export type CalendarOverlayItem={provider:string;id:string;startDate:string;endDate:string;label:string;status?:string;href?:string};
export type CalendarOverlayProvider={name:string;project(from:string,to:string):Promise<CalendarOverlayItem[]>};
const providers:CalendarOverlayProvider[]=[];
export function registerCalendarOverlayProvider(provider:CalendarOverlayProvider){if(!providers.some(p=>p.name===provider.name))providers.push(provider);}
export async function projectCalendarOverlays(from:string,to:string){return (await Promise.all(providers.map(p=>p.project(from,to)))).flat();}
