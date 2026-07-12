export type HolidayOccurrence={kind:'berlin-public-holiday'|'berlin-school-holiday'|'school-free-day';name:string;startDate:string;endDate:string;region:'DE-BE';officialSourceUrl:string;sourceRevision:string;freshAsOf:string;schoolYear?:string};
export const PUBLIC_SOURCE='https://gesetze.berlin.de/bsbe/document/jlr-FeiertGBErahmen';
export const SCHOOL_SOURCE='https://www.berlin.de/sen/bjf/service/kalender/ferien/termine/';
const day=(d:Date)=>d.toISOString().slice(0,10), add=(d:Date,n:number)=>new Date(d.getTime()+n*86400000);
function easter(year:number){const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);return new Date(Date.UTC(year,Math.floor((h+l-7*m+114)/31)-1,(h+l-7*m+114)%31+1));}
const fixed:[string,string][]=[['01-01','New Year’s Day'],['03-08','International Women’s Day'],['05-01','Labour Day'],['10-03','German Unity Day'],['12-25','Christmas Day'],['12-26','Second Day of Christmas']];
const school:[string,string,string][]=[
 ['2025-10-20','2025-11-01','Autumn holidays'],['2025-12-22','2026-01-02','Christmas holidays'],['2026-02-02','2026-02-07','Winter holidays'],['2026-03-30','2026-04-10','Easter holidays'],['2026-05-15','2026-05-15','School-free day'],['2026-05-26','2026-05-26','Pentecost holidays'],['2026-07-09','2026-08-22','Summer holidays'],
 ['2026-10-19','2026-10-31','Autumn holidays'],['2026-12-23','2027-01-02','Christmas holidays'],['2027-02-01','2027-02-06','Winter holidays'],['2027-03-22','2027-04-02','Easter holidays'],['2027-05-07','2027-05-07','School-free day'],['2027-05-18','2027-05-19','Pentecost holidays'],['2027-07-01','2027-08-14','Summer holidays'],
 ['2027-10-11','2027-10-23','Autumn holidays'],['2027-12-22','2027-12-31','Christmas holidays'],['2028-01-31','2028-02-05','Winter holidays'],['2028-04-10','2028-04-22','Easter holidays'],['2028-05-26','2028-05-26','School-free day'],['2028-06-01','2028-06-02','Pentecost holidays'],['2028-07-01','2028-08-12','Summer holidays'],
 ['2028-10-02','2028-10-14','Autumn holidays'],['2028-12-22','2029-01-02','Christmas holidays'],['2029-01-29','2029-02-03','Winter holidays'],['2029-03-26','2029-04-06','Easter holidays'],['2029-03-09','2029-03-09','School-free day'],['2029-04-30','2029-04-30','School-free day'],['2029-05-11','2029-05-11','School-free day'],['2029-05-22','2029-05-25','Pentecost holidays'],['2029-07-01','2029-08-11','Summer holidays'],
 ['2029-10-01','2029-10-12','Autumn holidays'],['2029-12-21','2030-01-04','Christmas holidays'],['2030-02-04','2030-02-09','Winter holidays'],['2030-04-15','2030-04-26','Easter holidays'],['2030-05-31','2030-05-31','School-free day'],['2030-06-07','2030-06-07','Pentecost holidays'],['2030-07-04','2030-08-17','Summer holidays']
];
const occurrence=(kind:HolidayOccurrence['kind'],name:string,startDate:string,endDate=startDate,source=PUBLIC_SOURCE,revision='FeiertG BE §1, version effective 2025-05-09'):HolidayOccurrence=>{const year=+startDate.slice(0,4),month=+startDate.slice(5,7),schoolYear=kind==='berlin-public-holiday'?undefined:`${month>=8?year:year-1}/${String((month>=8?year+1:year)%100).padStart(2,'0')}`;return {kind,name,startDate,endDate,region:'DE-BE',officialSourceUrl:source,sourceRevision:revision,freshAsOf:'2026-07-13',...(schoolYear?{schoolYear}:{})}};
export function holidaySnapshot(from:string,to:string){
 const out:HolidayOccurrence[]=[];
 for(let year=+from.slice(0,4);year<=+to.slice(0,4);year++){
  for(const [md,name] of fixed) out.push(occurrence('berlin-public-holiday',name,`${year}-${md}`));
  const e=easter(year); for(const [offset,name] of [[-2,'Good Friday'],[1,'Easter Monday'],[39,'Ascension Day'],[50,'Whit Monday']] as [number,string][]) out.push(occurrence('berlin-public-holiday',name,day(add(e,offset))));
  if(year===2028) out.push(occurrence('berlin-public-holiday','75th anniversary of the uprising of 17 June 1953','2028-06-17'));
 }
 for(const [start,end,name] of school) out.push(occurrence(name==='School-free day'?'school-free-day':'berlin-school-holiday',name,start,end,SCHOOL_SOURCE,'Berlin school holiday order 2024/25–2029/30, 30 August 2024'));
 return out.filter(h=>h.startDate<=to&&h.endDate>=from).sort((a,b)=>a.startDate.localeCompare(b.startDate));
}
export function holidayMetadata(from:string,to:string){return {region:'DE-BE',freshAsOf:'2026-07-13',horizon:{from:'2025-10-20',to:'2030-08-17'},stale:false,outOfHorizon:from<'2025-10-20'||to>'2030-08-17',sources:[PUBLIC_SOURCE,SCHOOL_SOURCE],lastKnownGood:true};}
export function builtInHolidayGeneration(){const horizon={from:'2025-10-20',to:'2030-08-17'},occurrences=holidaySnapshot('2025-01-01','2030-12-31');return {revision:'Berlin school holiday order 2024/25–2029/30, 30 August 2024; FeiertG BE current snapshot 13 July 2026',freshAsOf:'2026-07-13',horizon,sourceUrls:[PUBLIC_SOURCE,SCHOOL_SOURCE],occurrences};}
