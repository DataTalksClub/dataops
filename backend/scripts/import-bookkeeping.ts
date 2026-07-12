import { createHash } from 'crypto';
import ExcelJS from 'exceljs';

export type ImportRow = Record<string, string | number | undefined> & { transactionDate: string; counterparty: string; description: string; amount: string; currency: string; sourceType: string; sourceKey: string };
export type Rejection = { sheet: string; row: number; reason: string };
const headers: Record<string,string> = {
  date:'transactionDate', sent:'transactionDate', 'sent date':'transactionDate', paid:'paidDate', 'paid date':'paidDate',
  provider:'counterparty', payee:'counterparty', name:'counterparty', description:'description', amount:'amount', currency:'currency',
  eur:'amountEur', 'amount eur':'amountEur', statement:'statementRef', reference:'statementRef', count:'quantity', quantity:'quantity',
  comment:'comment', type:'entryType', subtype:'subtype', period:'period', category:'category', tax:'description',
};
const cellValue=(v:unknown):unknown=>{if(v&&typeof v==='object'&&'result' in v)return(v as {result:unknown}).result;if(v&&typeof v==='object'&&'richText' in v)return(v as {richText:{text:string}[]}).richText.map(x=>x.text).join('');return v;};
const isoDate=(raw:unknown):string=>{ const v=cellValue(raw);if(v instanceof Date)return v.toISOString().slice(0,10); if(typeof v==='number'){const d=new Date(Date.UTC(1899,11,30)+v*86400000);return Number.isNaN(d.valueOf())?'':d.toISOString().slice(0,10);} const s=String(v||'').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:''; };
const decimal=(v:unknown):string=>{if(typeof v==='number'&&Number.isFinite(v))return Math.abs(v).toFixed(4).replace(/\.?0+$/,'');let s=String(v||'').trim().replace(/\s/g,'').replace(/\.(?=\d{3}(?:\D|$))/g,'').replace(',','.').replace(/[^0-9.()\-]/g,'');if(/^\(.*\)$/.test(s))s=s.slice(1,-1);s=s.replace(/^-/, '');return /^(0|[1-9]\d*)(\.\d{1,4})?$/.test(s)?s:'';};
const currencyFrom=(values:unknown[])=>{const text=values.map(v=>String(v||'')).join(' ').toUpperCase();const code=text.match(/(?:^|[^A-Z])(EUR|USD|GBP|CHF|PLN|UAH)(?:[^A-Z]|$)/)?.[1];return code||(text.includes('$')?'USD':text.includes('£')?'GBP':'EUR');};
export async function parseWorkbook(file: string): Promise<{ rows: ImportRow[]; rejected: Rejection[]; counts: Record<string,{accepted:number;rejected:number}> }> {
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(file); const rows:ImportRow[]=[];const rejected:Rejection[]=[];const counts:Record<string,{accepted:number;rejected:number}>={};
  for(const worksheet of workbook.worksheets){const sheet=worksheet.name;counts[sheet]={accepted:0,rejected:0};const matrix:unknown[][]=[];worksheet.eachRow({includeEmpty:true},row=>matrix.push(Array.from({length:Math.max(row.cellCount,worksheet.columnCount)},(_,i)=>cellValue(row.getCell(i+1).value))));if(!matrix.length)continue;
    let headerIndex=matrix.findIndex(r=>Array.isArray(r)&&r.some(v=>headers[String(v||'').trim().toLowerCase()]));if(headerIndex<0&&!/tax/i.test(sheet)){rejected.push({sheet,row:1,reason:'HEADER_UNMAPPED'});counts[sheet].rejected++;continue;}
    const headerlessTaxes=headerIndex<0;const width=headerlessTaxes?Math.max(...matrix.map(r=>r.length)):(matrix[headerIndex] as unknown[]).length;const map=headerlessTaxes?[]:(matrix[headerIndex] as unknown[]).map(v=>headers[String(v||'').trim().toLowerCase()]);
    // Historical sheets have stable positional layouts but drifting labels.
    const fallback=headerlessTaxes?['transactionDate','description','counterparty','amount','amountEur']:width>=10?['transactionDate','paidDate','counterparty','description','amountEur','amount','statementRef','quantity','comment','subtype','entryType','period','category']:['transactionDate','paidDate','counterparty','description','amountEur','amount','statementRef'];
    fallback.forEach((field,index)=>{if(!map[index]&&index<width)map[index]=field});
    for(let i=headerIndex+1;i<matrix.length;i++){const raw=matrix[i] as unknown[];if(!raw||!raw.slice(0,width).some(v=>v!==undefined&&v!==null&&String(v).trim()))continue;const value:Record<string,unknown>={};map.forEach((k,j)=>{if(k)value[k]=raw[j]});
      if(!isoDate(value.transactionDate||value.paidDate)&&!decimal(value.amount||value.amountEur)&&!String(value.counterparty||value.description||'').trim())continue;
      const transactionDate=isoDate(value.transactionDate||value.paidDate);const amount=decimal(value.amount||value.amountEur);const counterparty=String(value.counterparty||'').trim();const description=String(value.description||counterparty).trim();const currency=String(value.currency||currencyFrom([value.amount,value.amountEur])).trim().toUpperCase();
      const reason=!transactionDate?'INVALID_DATE':!amount?'INVALID_AMOUNT':!counterparty&&!/tax/i.test(sheet)?'MISSING_COUNTERPARTY':!description?'MISSING_DESCRIPTION':!/^[A-Z]{3}$/.test(currency)?'INVALID_CURRENCY':'';
      if(reason){rejected.push({sheet,row:i+1,reason});counts[sheet].rejected++;continue;}
      const sourceKey=createHash('sha256').update(`${sheet}\0${i+1}\0${transactionDate}\0${amount}\0${currency}`).digest('hex');
      const record:any={transactionDate,counterparty:counterparty||'Tax authority',description,amount,currency,sourceType:'xlsx-import',sourceKey};
      for(const k of ['paidDate','amountEur','statementRef','comment','entryType','subtype','period','category'])if(value[k]!=null&&String(value[k]).trim())record[k]=k==='paidDate'?isoDate(value[k]):k==='amountEur'?decimal(value[k]):String(value[k]).trim();
      if(value.quantity!=null&&Number.isSafeInteger(Number(value.quantity)))record.quantity=Number(value.quantity);rows.push(record);counts[sheet].accepted++;
    }
  } return {rows,rejected,counts};
}
export async function writeRows(rows: ImportRow[], options:{api:string;secret:string;concurrency?:number;fetcher?:typeof fetch}) {
  const fetcher=options.fetcher||fetch, queue=[...rows];let created=0,duplicates=0;
  async function worker(){for(;;){const row=queue.shift();if(!row)return;let response:Response|undefined;for(let attempt=0;attempt<4;attempt++){response=await fetcher(`${options.api.replace(/\/$/,'')}/api/bookkeeping/ingest`,{method:'POST',headers:{'content-type':'application/json','x-bookkeeping-ingestion-key':options.secret,'idempotency-key':row.sourceKey},body:JSON.stringify(row)});if(![429,500,502,503,504].includes(response.status))break;await new Promise(r=>setTimeout(r,25*2**attempt));}if(!response?.ok)throw new Error(`Import stopped: HTTP ${response?.status||0}`);const result=await response.json() as {duplicate:boolean};result.duplicate?duplicates++:created++;}}
  await Promise.all(Array.from({length:Math.max(1,Math.min(options.concurrency||4,8))},worker));return {accepted:rows.length,created,duplicates};
}
async function main(){const args=process.argv.slice(2);const file=args.find(a=>!a.startsWith('--'))||'.tmp/bookkeeping.xlsx';const parsed=await parseWorkbook(file);console.log(JSON.stringify({mode:args.includes('--write')?'write':'dry-run',counts:parsed.counts,rejected:parsed.rejected}));if(!args.includes('--write'))return;
  const api=process.env.BOOKKEEPING_API_URL, secret=process.env.BOOKKEEPING_INGESTION_KEY, env=process.env.BOOKKEEPING_TARGET_ENV, confirm=args.find(a=>a.startsWith('--confirm='))?.slice(10);if(!api||!secret||!env||confirm!==env)throw new Error('Write requires API URL, ingestion key, target environment, and matching --confirm');
  const verified=await writeRows(parsed.rows,{api,secret});
  const session=process.env.BOOKKEEPING_SESSION_TOKEN;if(!session)throw new Error('Write verification requires BOOKKEEPING_SESSION_TOKEN');const response=await fetch(`${api.replace(/\/$/,'')}/api/bookkeeping/transactions`,{headers:{authorization:`Bearer ${session}`}});if(!response.ok)throw new Error(`Verification stopped: HTTP ${response.status}`);const listed=await response.json() as {items:ImportRow[]};const imported=new Set(listed.items.filter(i=>i.sourceType==='xlsx-import').map(i=>i.sourceKey));if(parsed.rows.some(r=>!imported.has(r.sourceKey)))throw new Error('Verification failed: imported source keys missing');console.log(JSON.stringify({verified}));}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(e=>{console.error((e as Error).message);process.exitCode=1});
